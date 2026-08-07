/**
 * ES256 signature verification, with no dependency.
 *
 * ══ Why this exists ══
 *
 * `verifyAccessToken` takes a `SignatureVerifier` as a parameter, which is the right shape:
 * the package owns the ORDER of checks (algorithm, then signature, then claims) and leaves
 * the cryptography to the caller.
 *
 * But nothing supplied one. An agent building a real product hit exactly that, concluded
 * "ES256/JWKS verification needs a dependency", and shipped a verifier that deliberately
 * throws rather than return a forged pass. Refusing was the right call — the belief behind
 * it was wrong.
 *
 * Measured: Node's WebCrypto verifies ES256 with zero packages.
 *
 *     generateKey ECDSA P-256 -> exportKey jwk -> importKey -> sign -> verify  ->  true
 *
 * So the gap was never a missing library. It was a missing forty lines, and every generated
 * project would have had to rediscover that.
 *
 * ══ Why `kid` handling is the load-bearing part ══
 *
 * Privy's JWKS for this app answers with **two** ES256/P-256 keys, which means rotation is
 * in progress — and rotation is the normal steady state, not an event. A verifier that
 * grabs "the key" rather than *the key the token's header names* works right up until the
 * day it silently does not.
 */

import { webcrypto } from "node:crypto";

/** A JSON Web Key, narrowed to what an ES256 verifier needs. */
export type Jwk = {
  readonly kty?: string;
  readonly crv?: string;
  readonly alg?: string;
  readonly kid?: string;
  readonly x?: string;
  readonly y?: string;
};

/** Decode base64url — JWTs use it, and `atob` does not accept it directly. */
export function fromBase64Url(input: string): Uint8Array {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * The `kid` a token's header names.
 *
 * Returned rather than resolved here: which key that names is a question for the key set,
 * and a verifier that silently picks a different key is the failure this guards against.
 */
export function keyIdFrom(token: string): string | undefined {
  const header = token.split(".")[0];
  if (header === undefined || header === "") return undefined;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(header))) as {
      kid?: unknown;
    };
    return typeof parsed.kid === "string" && parsed.kid !== "" ? parsed.kid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pick the key a token names, and refuse rather than guess.
 *
 * ══ The failure this prevents ══
 *
 * With rotation in progress a key set holds two keys. Taking the first one verifies every
 * token signed by that key and rejects every token signed by the other — intermittently,
 * for as long as rotation lasts, with no error anywhere except a login that "sometimes"
 * fails.
 *
 * A token with no `kid` is refused for the same reason: a set of one today is a set of two
 * tomorrow, and a verifier that quietly worked will quietly stop.
 */
export function selectKey(input: {
  readonly keys: readonly Jwk[];
  readonly kid: string | undefined;
}): { readonly ok: true; readonly key: Jwk } | { readonly ok: false; readonly detail: string } {
  /**
   * Belt and braces, and honestly so: with `kid` undefined the `find` below returns
   * undefined anyway, because no real key has an undefined `kid`. Sabotage confirmed it —
   * removing this branch changes the MESSAGE, not the outcome.
   *
   * It stays because the message is the point. "No kid in the header" tells a caller what
   * to fix; "no key matches kid undefined" sends them hunting through a key set that is
   * fine.
   */
  if (input.kid === undefined) {
    return {
      ok: false,
      detail:
        "the token header names no kid. Privy's key set holds TWO keys during rotation — " +
        "which is the normal steady state — so a verifier that picks 'the key' works until " +
        "it silently does not",
    };
  }

  const key = input.keys.find((candidate) => candidate.kid === input.kid);
  if (key === undefined) {
    return {
      ok: false,
      detail:
        `no key in the set matches kid "${input.kid}". Refetch the key set: a rotation may ` +
        "have introduced a key this process has not seen",
    };
  }

  return { ok: true, key };
}

/**
 * Verify an ES256 JWT signature against a JWK.
 *
 * ══ Why the signature is r‖s and not DER ══
 *
 * JWS uses the raw concatenated form, which is what WebCrypto's `ECDSA` verify expects.
 * `node:crypto`'s `createVerify` expects DER, so a verifier written against that API
 * rejects every valid token. Using WebCrypto avoids the conversion entirely.
 */
export async function verifyEs256(input: {
  readonly token: string;
  readonly key: Jwk;
}): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const parts = input.token.split(".");
  const [header, payload, signature] = parts;

  if (
    parts.length !== 3 ||
    header === undefined ||
    payload === undefined ||
    signature === undefined
  ) {
    return { ok: false, detail: "a JWT has exactly three dot-separated parts" };
  }

  if (input.key.kty !== "EC" || input.key.crv !== "P-256") {
    return {
      ok: false,
      detail: `ES256 requires an EC P-256 key, not ${input.key.kty ?? "?"}/${input.key.crv ?? "?"}`,
    };
  }

  // Inferred rather than annotated: `CryptoKey` is a DOM lib type, and this package targets
  // Node — naming it would force `lib: ["dom"]` on a package that has no browser half.
  let imported: Awaited<ReturnType<typeof webcrypto.subtle.importKey>>;
  try {
    imported = await webcrypto.subtle.importKey(
      "jwk",
      // `key_ops` is set explicitly: WebCrypto refuses a key whose declared usages do not
      // include the one being asked for, and a JWKS entry may omit the field entirely.
      {
        kty: "EC",
        crv: "P-256",
        x: input.key.x ?? "",
        y: input.key.y ?? "",
        key_ops: ["verify"],
        ext: true,
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch (error) {
    return { ok: false, detail: `the key could not be imported: ${String(error).slice(0, 120)}` };
  }

  const verified = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    imported,
    fromBase64Url(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );

  return verified
    ? { ok: true, detail: "signature verified" }
    : { ok: false, detail: "the signature does not match this key" };
}

/**
 * Build a `SignatureVerifier` from a key set.
 *
 * ══ Returns undefined rather than throwing ══
 *
 * `verifyAccessToken` treats `undefined` as "not verified" and continues to its own
 * refusal path, which produces a typed reason a caller can act on. Throwing here would
 * replace that with a stack trace, and a route that catches broadly could turn it into a
 * pass.
 */
export function es256Verifier<Claims>(input: {
  /** Fetched from the issuer's JWKS endpoint, and refetched when a kid is unknown. */
  readonly keys: readonly Jwk[];
}): (token: string) => Promise<Claims | undefined> {
  return async (token: string) => {
    const selected = selectKey({ keys: input.keys, kid: keyIdFrom(token) });
    if (!selected.ok) return undefined;

    const verified = await verifyEs256({ token, key: selected.key });
    if (!verified.ok) return undefined;

    const payload = token.split(".")[1];
    if (payload === undefined) return undefined;

    try {
      return JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Claims;
    } catch {
      return undefined;
    }
  };
}
