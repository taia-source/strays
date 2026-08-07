/**
 * Privy access-token verification — the server half of wallet auth.
 *
 * ══ Why this exists as its own module ══
 *
 * `@taia/wallet`'s other modules handle browser-extension wallets via EIP-6963. Privy is
 * the *other* path: embedded and social-login wallets. It hands the browser an EIP-1193
 * provider, so `connection.ts` and `errors.ts` apply unchanged downstream — what Privy
 * adds, and what nothing else here covers, is **proving on the server that a request
 * really comes from an authenticated user.**
 *
 * ══ Verified against the live app, not assumed ══
 *
 * Privy's JWKS endpoint for this app answers with **two ES256 / P-256 keys**:
 *
 *   kty=EC crv=P-256 alg=ES256 kid=Ka3nmajMmSqK
 *   kty=EC crv=P-256 alg=ES256 kid=wG7HrxZ1GGRZ
 *
 * Two keys means **rotation is in progress**, which is the normal steady state and the
 * reason `kid` handling matters: a verifier that grabs "the key" rather than *the key
 * named by the token's header* works until the day it silently does not.
 *
 * Documented claim structure (from Privy's own docs): tokens are JWTs signed with
 * **ES256**; `iss` is always `privy.io`; `aud` is **your app ID**; `sub` is the user's
 * Privy DID; plus `sid`, `iat`, `exp`.
 *
 * ══ The three checks that are commonly skipped ══
 *
 * A signature check alone proves a token was issued by Privy — **not that it was issued
 * for you**. Privy is multi-tenant, so a valid token from *another Privy app* carries a
 * perfectly good signature from the same issuer family. Without an `aud` check you accept
 * strangers' users as your own.
 *
 * Prior code in this stack read `claims.app_id` and attached it to the request **without
 * asserting it matched**. That is the gap this closes.
 *
 * Algorithm confusion is the other one: a verifier that accepts whatever `alg` the token
 * header names can be handed `alg: none`, or an HS256 token signed with the public key as
 * the HMAC secret. The allowed algorithm is pinned to ES256 here and is not negotiable
 * from the token.
 *
 * ══ Deprecation, recorded because a migration hides a runtime failure ══
 *
 * `@privy-io/server-auth` is **deprecated** (last published 2025-09-17); the current
 * package is `@privy-io/node`. The method name changed with it —
 * **`verifyAccessToken`, not the old `verifyAuthToken`** — so a copy-paste migration
 * compiles and then fails at runtime. `@taia/gate`'s config check flags this.
 */

/** Claims Privy documents on an access token. */
export type PrivyClaims = {
  /** The user's Privy DID — the stable identity to key a session on. */
  readonly sub: string;
  /** Always `privy.io`. */
  readonly iss: string;
  /** Your Privy app ID. */
  readonly aud: string;
  /** Session id. */
  readonly sid?: string;
  readonly iat?: number;
  readonly exp?: number;
};

export type VerifiedUser = {
  readonly userId: string;
  readonly appId: string;
  readonly sessionId: string | undefined;
};

export type VerifyFailure = {
  readonly ok: false;
  /** Machine-readable, so a caller can distinguish "log in again" from "misconfigured". */
  readonly reason:
    | "missing-token"
    | "malformed"
    | "bad-signature"
    | "wrong-audience"
    | "wrong-issuer"
    | "expired"
    | "not-yet-valid"
    | "wrong-algorithm"
    | "config";
  /** For logs. Never returned to the client verbatim — see `clientMessage`. */
  readonly detail: string;
};

export type VerifyResult = { readonly ok: true; readonly user: VerifiedUser } | VerifyFailure;

export const PRIVY_ISSUER = "privy.io";
/** Privy signs with ES256. Pinned, never read from the token header. */
export const PRIVY_ALGORITHM = "ES256";

/**
 * Extract a bearer token from an Authorization header.
 *
 * Case-insensitive on the scheme: `Bearer`, `bearer` and `BEARER` all appear in the wild,
 * and rejecting a valid token over casing is an outage that looks like a login bug.
 */
export function bearerToken(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

/**
 * Repair a PEM whose newlines survived a `.env` round-trip as literal `\n`.
 *
 * This is the fix for the outage recorded in `@taia/gate`'s `config.ts`: dotenv only
 * converts `\n` inside double quotes, so an unquoted PEM loads malformed and **every**
 * token verification fails with "invalid or expired token" — blaming the user for a
 * config bug. Measured: `createPublicKey` fails with `DECODER routines::unsupported`
 * before repair and succeeds after.
 *
 * Applied defensively here because the cost of an unnecessary repair is zero and the cost
 * of missing it is total.
 */
export function repairPem(value: string): string {
  const unquoted = value.trim().replace(/^["']|["']$/g, "");
  return unquoted.includes("\\n") ? unquoted.replace(/\\n/g, "\n") : unquoted;
}

/**
 * Decode a JWT's payload **without verifying**.
 *
 * Deliberately named to be unusable by accident. Reading claims from an unverified token
 * and acting on them is the single most common JWT vulnerability; this exists only so the
 * checks below can report *which* claim was wrong.
 */
export function decodeUnverifiedPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    // The `?? ""` is unreachable and only satisfies noUncheckedIndexedAccess: the guard
    // above returns unless there are exactly 3 parts, and String.split never yields holes,
    // so parts[1] is always a string here. No test can cover the fallback.
    const payload = parts[1] ?? "";
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = globalThis.atob
      ? globalThis.atob(padded)
      : Buffer.from(padded, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The header, for algorithm pinning. Same warning as above: unverified. */
export function decodeUnverifiedHeader(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    // Unreachable `?? ""`, same invariant as decodeUnverifiedPayload above: parts.length
    // is exactly 3 past the guard, so parts[0] is always a string.
    const header = parts[0] ?? "";
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = globalThis.atob
      ? globalThis.atob(padded)
      : Buffer.from(padded, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Everything that must hold **besides** a valid signature.
 *
 * The signature check itself belongs to `jose` or the Privy SDK; duplicating crypto here
 * would be worse than useless. This covers what those leave to the caller — and what
 * prior code in this stack skipped.
 */
/**
 * Claims as they arrive from a decoder: every field may be explicitly `undefined`, not
 * merely absent. `exactOptionalPropertyTypes` distinguishes the two, and a malformed token
 * genuinely produces the former.
 */
export type IncomingClaims = { readonly [K in keyof PrivyClaims]?: PrivyClaims[K] | undefined };

export function checkClaims(options: {
  readonly claims: IncomingClaims;
  /** Your app ID. Held by the server, never read from the token. */
  readonly expectedAppId: string;
  readonly now?: number;
  /** Tolerance for clock skew between your server and Privy. Default 60s. */
  readonly clockSkewSeconds?: number;
}): VerifyResult {
  const { claims, expectedAppId } = options;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const skew = options.clockSkewSeconds ?? 60;

  if (!expectedAppId) {
    return {
      ok: false,
      reason: "config",
      detail:
        "no expected app id was supplied, so the audience cannot be checked. Refusing to verify rather than accepting any Privy app's tokens",
    };
  }

  if (claims.iss !== PRIVY_ISSUER) {
    return {
      ok: false,
      reason: "wrong-issuer",
      detail: `iss is ${JSON.stringify(claims.iss)}, expected "${PRIVY_ISSUER}"`,
    };
  }

  // The check prior code omitted. Privy is multi-tenant: a token from ANOTHER app has a
  // perfectly valid signature. Without this you accept a stranger's users as your own.
  if (claims.aud !== expectedAppId) {
    return {
      ok: false,
      reason: "wrong-audience",
      detail:
        `aud is ${JSON.stringify(claims.aud)}, expected ${JSON.stringify(expectedAppId)}. ` +
        "A validly-signed token from a DIFFERENT Privy app looks identical without this check",
    };
  }

  if (!claims.sub || typeof claims.sub !== "string") {
    return { ok: false, reason: "malformed", detail: "sub (the Privy DID) is missing" };
  }

  if (typeof claims.exp === "number" && claims.exp + skew < now) {
    return {
      ok: false,
      reason: "expired",
      detail: `token expired at ${claims.exp}, now ${now} (allowing ${skew}s skew)`,
    };
  }

  if (typeof claims.iat === "number" && claims.iat - skew > now) {
    return {
      ok: false,
      reason: "not-yet-valid",
      detail: `token is issued in the future (iat ${claims.iat}, now ${now}) — check server clocks`,
    };
  }

  return {
    ok: true,
    user: { userId: claims.sub, appId: claims.aud, sessionId: claims.sid },
  };
}

/**
 * Reject a token whose header names anything but ES256.
 *
 * Algorithm confusion is the classic JWT break: `alg: none`, or an HS256 token signed
 * with the public key as an HMAC secret. The allowed algorithm must be pinned by the
 * server and never negotiated by the token.
 */
export function checkAlgorithm(token: string): VerifyFailure | undefined {
  const header = decodeUnverifiedHeader(token);
  if (!header) return { ok: false, reason: "malformed", detail: "token header is not valid JSON" };

  const alg = header.alg;
  if (alg !== PRIVY_ALGORITHM) {
    return {
      ok: false,
      reason: "wrong-algorithm",
      detail:
        `token header names alg ${JSON.stringify(alg)}, but Privy signs with ${PRIVY_ALGORITHM}. ` +
        "Accepting the token's own choice of algorithm is how 'alg: none' and HS256-with-the-public-key attacks work",
    };
  }
  return undefined;
}

/** The signature verifier, injected so this module needs no crypto dependency. */
export type SignatureVerifier = (token: string) => Promise<IncomingClaims | undefined>;

/**
 * The whole server-side check, in order.
 *
 * Algorithm before signature before claims: each step is cheaper than the next and
 * refuses input the next step would otherwise have to trust.
 */
export async function verifyAccessToken(options: {
  readonly authorizationHeader?: string | undefined;
  readonly expectedAppId: string;
  readonly verify: SignatureVerifier;
  readonly now?: number;
  readonly clockSkewSeconds?: number;
}): Promise<VerifyResult> {
  const token = bearerToken(options.authorizationHeader);
  if (!token) {
    return {
      ok: false,
      reason: "missing-token",
      detail: "no bearer token in the Authorization header",
    };
  }

  const algorithmProblem = checkAlgorithm(token);
  if (algorithmProblem) return algorithmProblem;

  let claims: IncomingClaims | undefined;
  try {
    claims = await options.verify(token);
  } catch (error) {
    return {
      ok: false,
      reason: "bad-signature",
      detail: `signature verification threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!claims) {
    return {
      ok: false,
      reason: "bad-signature",
      detail: "signature verification returned nothing",
    };
  }

  return checkClaims({
    claims,
    expectedAppId: options.expectedAppId,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.clockSkewSeconds !== undefined
      ? { clockSkewSeconds: options.clockSkewSeconds }
      : {}),
  });
}

/**
 * What to tell the client.
 *
 * Never the detail: "aud is app-xyz, expected app-abc" tells an attacker exactly which
 * app id to forge. `config` is deliberately a 500 — the request was not unauthorised, the
 * server is broken, and returning 401 sends users to re-login forever against an outage
 * they cannot fix.
 */
export function clientMessage(failure: VerifyFailure): {
  readonly status: 401 | 500;
  readonly body: string;
} {
  if (failure.reason === "config") {
    return { status: 500, body: "authentication is misconfigured on the server" };
  }
  return { status: 401, body: "invalid or expired token" };
}
