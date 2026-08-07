import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { es256Verifier, fromBase64Url, keyIdFrom, selectKey, verifyEs256 } from "./es256.js";
import { verifyAccessToken } from "./privy.js";

/**
 * ══ Real keys, real signatures ══
 *
 * Every token below is signed by a key generated in the test. A fixture would prove the
 * decoder works and say nothing about whether the CRYPTO does, which is the half an agent
 * assumed needed a dependency.
 *
 * Measured while writing this: Node's WebCrypto verifies ES256 with zero packages.
 */

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const encodeJson = (value: unknown): string =>
  toBase64Url(new TextEncoder().encode(JSON.stringify(value)));

/** A P-256 pair, plus its public JWK with a chosen `kid`. */
async function makeKey(kid: string) {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = (await webcrypto.subtle.exportKey("jwk", pair.publicKey)) as {
    x?: string;
    y?: string;
  };
  // `?? ""` because `exportKey` types x/y as optional while a P-256 key always has both —
  // and `exactOptionalPropertyTypes` will not let `string | undefined` reach a `string`.
  return {
    pair,
    jwk: { kty: "EC", crv: "P-256", alg: "ES256", kid, x: jwk.x ?? "", y: jwk.y ?? "" },
  };
}

/** Sign a real JWT with a real key. */
async function signToken(input: {
  // Inferred, not annotated: `CryptoKey` is a DOM lib type and this package targets Node.
  readonly privateKey: Awaited<ReturnType<typeof webcrypto.subtle.generateKey>> extends infer K
    ? K extends { privateKey: infer P }
      ? P
      : never
    : never;
  readonly kid?: string | undefined;
  readonly claims: Record<string, unknown>;
  readonly alg?: string;
}): Promise<string> {
  const header = encodeJson(
    input.kid === undefined
      ? { alg: input.alg ?? "ES256", typ: "JWT" }
      : { alg: input.alg ?? "ES256", typ: "JWT", kid: input.kid },
  );
  const payload = encodeJson(input.claims);
  const signature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    input.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

describe("verifying a real signature", () => {
  it("accepts a token this key actually signed", async () => {
    const { pair, jwk } = await makeKey("k1");
    const token = await signToken({
      privateKey: pair.privateKey,
      kid: "k1",
      claims: { sub: "u1" },
    });

    const result = await verifyEs256({ token, key: jwk });
    expect(result.ok, result.detail).toBe(true);
  });

  /** The whole point: a signature from a different key must not pass. */
  it("rejects a token signed by a different key", async () => {
    const signer = await makeKey("k1");
    const other = await makeKey("k2");
    const token = await signToken({
      privateKey: signer.pair.privateKey,
      kid: "k1",
      claims: { sub: "u1" },
    });

    const result = await verifyEs256({ token, key: other.jwk });
    expect(result.ok, "a forged token verified").toBe(false);
  });

  /** A single flipped payload byte must invalidate the signature. */
  it("rejects a token whose payload was altered", async () => {
    const { pair, jwk } = await makeKey("k1");
    const token = await signToken({
      privateKey: pair.privateKey,
      kid: "k1",
      claims: { sub: "user" },
    });

    const [header, , signature] = token.split(".");
    const tampered = `${header}.${encodeJson({ sub: "attacker" })}.${signature}`;

    expect((await verifyEs256({ token: tampered, key: jwk })).ok, "tampering passed").toBe(false);
  });

  it.each([
    ["not.a.jwt.at.all", "too many parts"],
    ["onlyonepart", "one part"],
    ["two.parts", "two parts"],
  ])("rejects %s (%s)", async (token) => {
    const { jwk } = await makeKey("k1");
    expect((await verifyEs256({ token, key: jwk })).ok).toBe(false);
  });

  /** An RSA key cannot verify ES256, and must be refused rather than attempted. */
  it("refuses a key of the wrong type", async () => {
    const { pair } = await makeKey("k1");
    const token = await signToken({ privateKey: pair.privateKey, kid: "k1", claims: {} });

    const result = await verifyEs256({ token, key: { kty: "RSA", kid: "k1" } });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("EC P-256");
  });

  it("refuses a malformed key rather than throwing", async () => {
    const { pair } = await makeKey("k1");
    const token = await signToken({ privateKey: pair.privateKey, kid: "k1", claims: {} });

    const result = await verifyEs256({
      token,
      key: { kty: "EC", crv: "P-256", kid: "k1", x: "not-base64url!!", y: "also-not" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("choosing the key a token names", () => {
  /**
   * ══ The rotation failure ══
   *
   * Privy's key set holds TWO keys, because rotation is the normal steady state. A verifier
   * taking the first key verifies tokens signed by that one and rejects tokens signed by the
   * other — intermittently, with no error except a login that "sometimes" fails.
   */
  it("picks the second key when the token names it", async () => {
    const first = await makeKey("Ka3nmajMmSqK");
    const second = await makeKey("wG7HrxZ1GGRZ");

    const token = await signToken({
      privateKey: second.pair.privateKey,
      kid: "wG7HrxZ1GGRZ",
      claims: { sub: "u1" },
    });

    const selected = selectKey({ keys: [first.jwk, second.jwk], kid: keyIdFrom(token) });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    expect(selected.key.kid, "the wrong key was chosen during rotation").toBe("wG7HrxZ1GGRZ");
    expect((await verifyEs256({ token, key: selected.key })).ok).toBe(true);
  });

  /** A set of one today is a set of two tomorrow, so a missing kid is refused. */
  it("refuses a token that names no kid", async () => {
    const { pair, jwk } = await makeKey("k1");
    const token = await signToken({ privateKey: pair.privateKey, claims: { sub: "u1" } });

    const selected = selectKey({ keys: [jwk], kid: keyIdFrom(token) });
    expect(selected.ok, "a kid-less token was matched against 'the key'").toBe(false);
  });

  /**
   * The kid-less branch is REDUNDANT for safety and kept for the message. Sabotage showed
   * removing it still refuses — `find` matches nothing when kid is undefined — so this
   * pins the diagnostic rather than pretending the branch is load-bearing.
   */
  it("says WHY a kid-less token failed, rather than blaming the key set", () => {
    const selected = selectKey({ keys: [{ kid: "k1" }], kid: undefined });
    expect(selected.ok).toBe(false);
    expect(
      selected.ok || selected.detail,
      "the message sends the reader hunting through a key set that is fine",
    ).toContain("names no kid");
  });

  it("refuses a kid the set does not contain", () => {
    const selected = selectKey({ keys: [{ kid: "k1" }], kid: "k-unknown" });
    expect(selected.ok).toBe(false);
    expect(selected.ok || selected.detail).toContain("Refetch");
  });

  it("reads no kid from a malformed header", () => {
    expect(keyIdFrom("!!!.payload.sig")).toBeUndefined();
    expect(keyIdFrom("")).toBeUndefined();
  });
});

describe("the verifier handed to verifyAccessToken", () => {
  /**
   * ══ Returns undefined, never throws ══
   *
   * `verifyAccessToken` treats undefined as "not verified" and produces a typed reason.
   * Throwing would replace that with a stack trace — and a route catching broadly could
   * turn a rejection into a pass.
   */
  it("returns undefined for an unverifiable token rather than throwing", async () => {
    const { jwk } = await makeKey("k1");
    const verifier = es256Verifier({ keys: [jwk] });

    await expect(verifier("garbage.token.here")).resolves.toBeUndefined();
    await expect(verifier("")).resolves.toBeUndefined();
  });

  /**
   * ══ The auth bypass my own tests missed ══
   *
   * Sabotage: deleting the signature check from `es256Verifier` entirely — so ANY
   * well-formed token returns claims — passed all 22 tests. Every case exercised
   * `verifyEs256` directly or fed the verifier garbage that failed on parsing, so nothing
   * asked whether the VERIFIER checked the signature.
   *
   * This forges a token signed by the wrong key and requires the verifier to refuse it.
   */
  it("refuses a well-formed token signed by a key it does not hold", async () => {
    const trusted = await makeKey("k1");
    const attacker = await makeKey("k1");

    // Same kid, real structure, valid claims — and the wrong private key.
    const forged = await signToken({
      privateKey: attacker.pair.privateKey,
      kid: "k1",
      claims: { sub: "did:privy:victim", iss: "privy.io" },
    });

    const claims = await es256Verifier({ keys: [trusted.jwk] })(forged);
    expect(
      claims,
      "a forged token returned claims — the signature was never checked",
    ).toBeUndefined();
  });

  /**
   * A kid-less token is refused by `selectKey`, and the verifier must honour that rather
   * than falling through to "the key". Sabotage found this one too.
   */
  it("refuses a token with no kid even when only one key exists", async () => {
    const { pair, jwk } = await makeKey("k1");
    const token = await signToken({ privateKey: pair.privateKey, claims: { sub: "u1" } });

    const claims = await es256Verifier({ keys: [jwk] })(token);
    expect(claims, "a kid-less token was verified against 'the key'").toBeUndefined();
  });

  it("returns the claims of a token it verified", async () => {
    const { pair, jwk } = await makeKey("k1");
    const token = await signToken({
      privateKey: pair.privateKey,
      kid: "k1",
      claims: { sub: "did:privy:abc", iss: "privy.io" },
    });

    const claims = await es256Verifier<{ sub?: string }>({ keys: [jwk] })(token);
    expect(claims?.sub).toBe("did:privy:abc");
  });

  /**
   * ══ End to end, through the real check order ══
   *
   * This is the seam an agent could not close: a real Privy-shaped token, a real key set,
   * and the package's own algorithm-then-signature-then-claims order — with no dependency.
   */
  it("verifies a Privy-shaped token end to end", async () => {
    const { pair, jwk } = await makeKey("Ka3nmajMmSqK");
    // `iat`/`exp` are SECONDS, as JWTs define them; `verifyAccessToken`'s `now` is
    // MILLISECONDS, because it divides internally. Passing seconds to both made a
    // freshly-minted token look 56 years early — caught on the first run.
    const seconds = Math.floor(Date.now() / 1000);
    const now = Date.now();

    const token = await signToken({
      privateKey: pair.privateKey,
      kid: "Ka3nmajMmSqK",
      claims: {
        iss: "privy.io",
        aud: "app-123",
        sub: "did:privy:user",
        sid: "session-1",
        iat: seconds - 10,
        exp: seconds + 3600,
      },
    });

    const result = await verifyAccessToken({
      authorizationHeader: `Bearer ${token}`,
      expectedAppId: "app-123",
      verify: es256Verifier({ keys: [jwk] }),
      now,
    });

    expect(result.ok, result.ok ? "" : `${result.reason}: ${result.detail}`).toBe(true);
  });

  /** And the same token must fail against a different app id. */
  it("refuses a token minted for another app", async () => {
    const { pair, jwk } = await makeKey("k1");
    const seconds = Math.floor(Date.now() / 1000);
    const now = Date.now();

    const token = await signToken({
      privateKey: pair.privateKey,
      kid: "k1",
      claims: { iss: "privy.io", aud: "someone-else", sub: "u", iat: seconds, exp: seconds + 60 },
    });

    const result = await verifyAccessToken({
      authorizationHeader: `Bearer ${token}`,
      expectedAppId: "app-123",
      verify: es256Verifier({ keys: [jwk] }),
      now,
    });

    expect(result.ok, "a token for another app was accepted").toBe(false);
  });
});

describe("base64url decoding", () => {
  /** JWTs use base64url, and `atob` rejects it — a decoder that forgets this fails on ~50%. */
  it("decodes the url-safe alphabet", () => {
    const bytes = new Uint8Array([251, 255, 190]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });

  it.each([1, 2, 3, 4, 5])("round-trips a %i-byte value, whatever the padding", (length) => {
    const bytes = Uint8Array.from({ length }, (_, index) => index * 40);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });
});
