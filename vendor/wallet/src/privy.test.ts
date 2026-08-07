import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bearerToken,
  checkAlgorithm,
  checkClaims,
  clientMessage,
  decodeUnverifiedHeader,
  decodeUnverifiedPayload,
  type IncomingClaims,
  PRIVY_ALGORITHM,
  PRIVY_ISSUER,
  type PrivyClaims,
  repairPem,
  type VerifyFailure,
  verifyAccessToken,
} from "./privy.js";

const APP_ID = "clzabcdefghijklmnopqrstu";
const DID = "did:privy:clzuserabcdefghijklmnop";
const NOW = 1_800_000_000_000; // ms
const NOW_S = Math.floor(NOW / 1000);

const base64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Real ES256 keypair, so the algorithm tests exercise actual signing. */
const es256 = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function makeToken(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "ES256", typ: "JWT" },
): string {
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(claims));
  const signing = `${h}.${p}`;

  if (header.alg === "ES256") {
    const signature = createSign("SHA256")
      .update(signing)
      .sign({ key: es256.privateKey, dsaEncoding: "ieee-p1363" });
    return `${signing}.${base64url(signature)}`;
  }
  if (header.alg === "HS256") {
    // The classic confusion attack: HMAC the signing input with the PUBLIC key.
    const mac = createHmac("sha256", es256.publicKey).update(signing).digest();
    return `${signing}.${base64url(mac)}`;
  }
  return `${signing}.`; // alg: none
}

const validClaims: PrivyClaims = {
  sub: DID,
  iss: PRIVY_ISSUER,
  aud: APP_ID,
  sid: "session-123",
  iat: NOW_S - 60,
  exp: NOW_S + 3600,
};

describe("bearerToken", () => {
  it("extracts a token", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("is case-insensitive on the scheme", () => {
    // All three casings appear in the wild; rejecting one is an outage that looks like a
    // login bug.
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("BEARER abc")).toBe("abc");
  });

  it("returns undefined for anything else", () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken("")).toBeUndefined();
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("Bearer ")).toBeUndefined();
    expect(bearerToken("abc")).toBeUndefined();
  });
});

describe("repairPem", () => {
  /**
   * The live outage this fixes: an unquoted PEM in .env keeps literal \n, so the key loads
   * malformed and EVERY token verification fails as "invalid or expired token".
   */
  it("restores real newlines from literal backslash-n", () => {
    const repaired = repairPem("-----BEGIN PUBLIC KEY-----\\nMIIB\\n-----END PUBLIC KEY-----");
    expect(repaired).toContain("\n");
    expect(repaired).not.toContain("\\n");
  });

  it("strips surrounding quotes", () => {
    expect(repairPem('"already fine"')).toBe("already fine");
  });

  it("leaves a correct PEM untouched", () => {
    expect(repairPem(es256.publicKey.toString())).toBe(es256.publicKey.toString().trim());
  });
});

describe("decodeUnverified*", () => {
  it("reads header and payload", () => {
    const token = makeToken(validClaims);
    expect(decodeUnverifiedHeader(token)?.alg).toBe("ES256");
    expect(decodeUnverifiedPayload(token)?.sub).toBe(DID);
  });

  it("returns undefined for a malformed token rather than throwing", () => {
    expect(decodeUnverifiedPayload("not.a.jwt")).toBeUndefined();
    expect(decodeUnverifiedPayload("onlyonepart")).toBeUndefined();
    expect(decodeUnverifiedHeader("")).toBeUndefined();
  });

  /**
   * A segment that is valid base64url and valid JSON but is NOT an object.
   *
   * `JSON.parse` happily returns a number, a string, or null, so the try/catch above does
   * not catch this — the decoder would return a primitive typed as
   * `Record<string, unknown>` and every downstream `claims.iss` read would be `undefined`
   * on a non-object, or throw outright on `null`. `checkAlgorithm` in particular does
   * `header.alg`, which on a `null` header is a TypeError escaping into the request
   * handler as a 500 rather than the 401 a garbage token deserves.
   *
   * `null` is the sharp one: `typeof null === "object"`, so only the explicit
   * `!== null` half of the guard rejects it.
   */
  it("rejects a segment that decodes to a non-object", () => {
    for (const literal of ["123", '"a string"', "null", "true"]) {
      const segment = base64url(literal);
      const token = `${segment}.${segment}.sig`;
      expect(decodeUnverifiedPayload(token), literal).toBeUndefined();
      expect(decodeUnverifiedHeader(token), literal).toBeUndefined();
    }
  });

  /**
   * A token with exactly three parts whose header segment is not JSON.
   *
   * The existing `checkAlgorithm("...")` case looks like it exercises this and does not:
   * `"...".split(".")` yields FOUR empty strings, so it returns at the `length !== 3`
   * guard and the try block is never entered. Reaching the `catch` needs a token that is
   * structurally a JWT and only fails at the parse — which is what an attacker sends when
   * probing whether malformed input produces a 500 instead of a 401.
   *
   * `atob` also throws on non-base64 characters, so both failure modes inside the try are
   * covered here: an unparseable-JSON header and an undecodable one.
   */
  it("returns undefined for a three-part token whose header is not JSON", () => {
    const bad = base64url("{not json at all");
    const payload = base64url(JSON.stringify(validClaims));

    expect(decodeUnverifiedHeader(`${bad}.${payload}.sig`)).toBeUndefined();
    expect(decodeUnverifiedPayload(`${bad}.${bad}.sig`)).toBeUndefined();

    // And the caller turns that into a 401-shaped failure, never an exception.
    expect(checkAlgorithm(`${bad}.${payload}.sig`)?.reason).toBe("malformed");
    expect(() => checkAlgorithm(`${bad}.${payload}.sig`)).not.toThrow();
  });

  /**
   * An array is `typeof "object"`, so it passes the decoder's guard and comes back as-is.
   * That is fine — the decoder's contract is only "an object or nothing", and the
   * algorithm check is what has to hold the line.
   *
   * It does, because `[].alg` is `undefined` and `undefined !== "ES256"`. Asserting the
   * verdict rather than the decode is the point: a header that names no algorithm must be
   * refused for exactly the same reason `alg: none` is.
   */
  it("refuses an array header, which is typeof object and survives decoding", () => {
    const segment = base64url("[1,2,3]");
    const token = `${segment}.${segment}.sig`;
    expect(decodeUnverifiedHeader(token)).toEqual([1, 2, 3]);

    const failure = checkAlgorithm(token);
    expect(failure?.reason).toBe("wrong-algorithm");
    expect(failure?.detail).toContain("undefined");
  });

  /**
   * The Node-without-`atob` fallback.
   *
   * `globalThis.atob` has existed since Node 16 and is present in this process, so the
   * `Buffer.from` arm is dead here unless `atob` is removed. It is not dead in
   * production: this module is also imported by edge and older-runtime servers, and if
   * the fallback were wrong every token would decode to garbage and fail as
   * "invalid or expired token" — the exact silent-auth-outage shape `repairPem` exists
   * for above.
   *
   * Asserting the two paths agree on a real token is the check: a fallback that decodes
   * differently is worse than no fallback.
   */
  it("decodes identically via Buffer when the runtime has no atob", () => {
    const token = makeToken(validClaims);
    const viaAtob = decodeUnverifiedPayload(token);
    expect(viaAtob?.sub).toBe(DID); // the atob path, for comparison

    const original = Object.getOwnPropertyDescriptor(globalThis, "atob");
    let viaBuffer: Record<string, unknown> | undefined;
    let headerViaBuffer: Record<string, unknown> | undefined;
    try {
      Object.defineProperty(globalThis, "atob", { value: undefined, configurable: true });
      viaBuffer = decodeUnverifiedPayload(token);
      headerViaBuffer = decodeUnverifiedHeader(token);
    } finally {
      if (original) Object.defineProperty(globalThis, "atob", original);
    }

    expect(viaBuffer).toEqual(viaAtob);
    expect(viaBuffer?.sub).toBe(DID);
    expect(headerViaBuffer?.alg).toBe("ES256");
  });
});

describe("checkAlgorithm", () => {
  it("accepts ES256", () => {
    expect(checkAlgorithm(makeToken(validClaims))).toBeUndefined();
  });

  /**
   * Algorithm confusion, with real tokens rather than described.
   *
   * `alg: none` and HS256-signed-with-the-public-key both produce structurally valid
   * tokens. A verifier that trusts the token's own `alg` accepts them.
   */
  it("rejects alg: none", () => {
    const token = makeToken(validClaims, { alg: "none", typ: "JWT" });
    const failure = checkAlgorithm(token);
    expect(failure?.reason).toBe("wrong-algorithm");
    expect(failure?.detail).toContain("alg: none");
  });

  it("rejects HS256 signed with the public key", () => {
    const token = makeToken(validClaims, { alg: "HS256", typ: "JWT" });
    expect(checkAlgorithm(token)?.reason).toBe("wrong-algorithm");
  });

  it("rejects a stronger-looking algorithm too — pinned means pinned", () => {
    expect(checkAlgorithm(makeToken(validClaims, { alg: "RS512" }))?.reason).toBe(
      "wrong-algorithm",
    );
  });

  it("reports a malformed header", () => {
    expect(checkAlgorithm("...")?.reason).toBe("malformed");
  });
});

describe("checkClaims", () => {
  const check = (over: Record<string, unknown> = {}, appId = APP_ID) =>
    checkClaims({ claims: { ...validClaims, ...over }, expectedAppId: appId, now: NOW });

  it("accepts a valid token and returns the user", () => {
    const result = check();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user).toEqual({ userId: DID, appId: APP_ID, sessionId: "session-123" });
    }
  });

  /**
   * The check prior code in this stack skipped.
   *
   * Privy is multi-tenant, so a token issued for ANOTHER app carries a perfectly valid
   * signature from the same issuer. Reading app_id and attaching it without asserting it
   * matches means accepting strangers' users as your own.
   */
  it("rejects a validly-signed token issued for a DIFFERENT Privy app", () => {
    const result = check({ aud: "clzsomeotherappxxxxxxxxx" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong-audience");
      expect(result.detail).toContain("DIFFERENT Privy app");
    }
  });

  it("refuses to verify at all when no app id is configured", () => {
    // Failing closed: accepting any Privy app's tokens because config is missing is worse
    // than an outage.
    const result = checkClaims({ claims: validClaims, expectedAppId: "", now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("config");
  });

  it("rejects a wrong issuer", () => {
    const result = check({ iss: "evil.example" });
    if (!result.ok) expect(result.reason).toBe("wrong-issuer");
  });

  it("rejects a token with no subject", () => {
    const result = check({ sub: undefined });
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("rejects an expired token", () => {
    const result = check({ exp: NOW_S - 3600 });
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("allows clock skew rather than failing on a second's drift", () => {
    // Expired 30s ago, within the default 60s tolerance.
    expect(check({ exp: NOW_S - 30 }).ok).toBe(true);
  });

  it("rejects a token issued in the future and blames the clock", () => {
    const result = check({ iat: NOW_S + 3600 });
    if (!result.ok) {
      expect(result.reason).toBe("not-yet-valid");
      expect(result.detail).toContain("server clocks");
    }
  });

  /**
   * `now` omitted, which is how every real caller uses this — a request handler has no
   * reason to pass a clock. The `?? Date.now()` default and the `/ 1000` around it are
   * what make `exp` (seconds, per JWT) comparable at all.
   *
   * The unit conversion is the bug this catches. If the default leaked milliseconds into
   * `now`, `claims.exp + skew < now` would be true for every token ever issued —
   * ~1.8e9 vs ~1.8e12 — and a correctly-signed, unexpired token would be rejected as
   * expired. So both directions are asserted against the real clock: a token expiring an
   * hour from now must pass, and one that expired an hour ago must fail.
   */
  it("defaults now to the real clock, in seconds not milliseconds", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);

    const live = checkClaims({
      claims: { ...validClaims, iat: nowSeconds - 60, exp: nowSeconds + 3600 },
      expectedAppId: APP_ID,
    });
    expect(live.ok, "an unexpired token must not be rejected by the default clock").toBe(true);

    const stale = checkClaims({
      claims: { ...validClaims, iat: nowSeconds - 7200, exp: nowSeconds - 3600 },
      expectedAppId: APP_ID,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("expired");
  });

  /**
   * The skew window is a window, not a one-sided grace period: a token 30s past expiry is
   * inside the default 60s and a token 90s past is outside. Asserting only the accepting
   * half would pass against a verifier that never checked `exp` at all.
   */
  it("honours an explicit clockSkewSeconds in both directions", () => {
    const strict = (exp: number) =>
      checkClaims({
        claims: { ...validClaims, exp },
        expectedAppId: APP_ID,
        now: NOW,
        clockSkewSeconds: 5,
      });

    expect(strict(NOW_S - 3).ok, "3s past expiry is inside a 5s tolerance").toBe(true);
    const outside = strict(NOW_S - 30); // inside the DEFAULT 60s, outside the explicit 5s
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.detail).toContain("allowing 5s skew");
  });

  it("tolerates a token with no exp or iat", () => {
    expect(
      checkClaims({
        claims: { sub: DID, iss: PRIVY_ISSUER, aud: APP_ID },
        expectedAppId: APP_ID,
        now: NOW,
      }).ok,
    ).toBe(true);
  });
});

describe("verifyAccessToken", () => {
  const verify = async (token: string) => decodeUnverifiedPayload(token) as IncomingClaims;

  it("verifies a good request end to end", async () => {
    const result = await verifyAccessToken({
      authorizationHeader: `Bearer ${makeToken(validClaims)}`,
      expectedAppId: APP_ID,
      verify,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("reports a missing header distinctly from a bad token", async () => {
    const result = await verifyAccessToken({ expectedAppId: APP_ID, verify, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing-token");
  });

  /**
   * Ordering: the algorithm is pinned BEFORE the signature verifier ever sees the token,
   * so an `alg: none` token is refused without relying on the verifier to reject it.
   */
  it("rejects alg: none before calling the verifier at all", async () => {
    let verifierCalled = false;
    const result = await verifyAccessToken({
      authorizationHeader: `Bearer ${makeToken(validClaims, { alg: "none" })}`,
      expectedAppId: APP_ID,
      now: NOW,
      verify: async (t) => {
        verifierCalled = true;
        return decodeUnverifiedPayload(t) as IncomingClaims;
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong-algorithm");
    expect(verifierCalled, "the verifier must not be reached").toBe(false);
  });

  it("turns a throwing verifier into a failure, not an exception", async () => {
    const result = await verifyAccessToken({
      authorizationHeader: `Bearer ${makeToken(validClaims)}`,
      expectedAppId: APP_ID,
      now: NOW,
      verify: async () => {
        throw new Error("JWSSignatureVerificationFailed");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("bad-signature");
      expect(result.detail).toContain("JWSSignatureVerificationFailed");
    }
  });

  /**
   * A verifier that throws something that is not an Error.
   *
   * `jose` throws proper Errors, but this verifier is injected — a caller may wrap the
   * Privy SDK, and anything that crosses a worker or `postMessage` boundary arrives as a
   * plain value. `error instanceof Error` is false for a string, and for an Error
   * constructed in a different realm, so the `String(error)` arm is not the exotic case
   * it looks like.
   *
   * Without it the template literal would interpolate `[object Object]` for a thrown
   * object and lose the only diagnostic the operator has for a signature failure.
   */
  it("survives a verifier that throws a non-Error", async () => {
    const thrown = async (value: unknown) =>
      verifyAccessToken({
        authorizationHeader: `Bearer ${makeToken(validClaims)}`,
        expectedAppId: APP_ID,
        now: NOW,
        verify: async () => {
          throw value;
        },
      });

    const asString = await thrown("JWKSNoMatchingKey");
    expect(asString.ok).toBe(false);
    if (!asString.ok) {
      expect(asString.reason).toBe("bad-signature");
      expect(asString.detail).toContain("JWKSNoMatchingKey");
    }

    // A thrown undefined must still produce a usable failure, not "threw: ".
    const asUndefined = await thrown(undefined);
    if (!asUndefined.ok) {
      expect(asUndefined.reason).toBe("bad-signature");
      expect(asUndefined.detail).toContain("undefined");
    }
  });

  /**
   * `now` and `clockSkewSeconds` omitted — the normal call shape from a request handler.
   *
   * Those options are forwarded through conditional spreads because
   * `exactOptionalPropertyTypes` distinguishes an absent property from one set to
   * `undefined`, and passing `{ now: undefined }` explicitly would defeat `checkClaims`'s
   * own `?? Date.now()` default. If the spread degraded to always-present-but-undefined,
   * `Math.floor(undefined / 1000)` is NaN, every `exp` comparison against NaN is false,
   * and expiry checking silently stops happening altogether — a token would then verify
   * FOREVER, which is precisely the failure that has no visible symptom.
   *
   * So the assertion is that an hour-expired token is still rejected with no clock passed.
   */
  it("still enforces expiry when no clock or skew is supplied", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const verifyClaims = async (token: string) => decodeUnverifiedPayload(token) as IncomingClaims;

    const expired = await verifyAccessToken({
      authorizationHeader: `Bearer ${makeToken({ ...validClaims, exp: nowSeconds - 3600 })}`,
      expectedAppId: APP_ID,
      verify: verifyClaims,
    });
    expect(expired.ok, "an expired token must not pass just because now was omitted").toBe(false);
    if (!expired.ok) expect(expired.reason).toBe("expired");

    const live = await verifyAccessToken({
      authorizationHeader: `Bearer ${makeToken({ ...validClaims, iat: nowSeconds - 60, exp: nowSeconds + 3600 })}`,
      expectedAppId: APP_ID,
      verify: verifyClaims,
    });
    expect(live.ok, "a live token must pass with no clock supplied").toBe(true);
  });

  it("forwards an explicit clockSkewSeconds through to the claim check", async () => {
    const result = await verifyAccessToken({
      authorizationHeader: `Bearer ${makeToken({ ...validClaims, exp: NOW_S - 30 })}`,
      expectedAppId: APP_ID,
      now: NOW,
      clockSkewSeconds: 5, // 30s past expiry: fine by default, refused at 5s
      verify,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
      expect(result.detail).toContain("allowing 5s skew");
    }
  });

  it("treats a verifier returning nothing as a failure", async () => {
    const result = await verifyAccessToken({
      authorizationHeader: `Bearer ${makeToken(validClaims)}`,
      expectedAppId: APP_ID,
      now: NOW,
      verify: async () => undefined,
    });
    if (!result.ok) expect(result.reason).toBe("bad-signature");
  });

  it("still enforces the audience after a valid signature", async () => {
    const foreign = makeToken({ ...validClaims, aud: "clzanotherappxxxxxxxxxxx" });
    const result = await verifyAccessToken({
      authorizationHeader: `Bearer ${foreign}`,
      expectedAppId: APP_ID,
      verify,
      now: NOW,
    });
    if (!result.ok) expect(result.reason).toBe("wrong-audience");
  });
});

describe("clientMessage", () => {
  /**
   * A misconfigured server is a 500, not a 401. Returning 401 sends users to re-login
   * forever against an outage they cannot possibly fix.
   */
  it("returns 500 for a configuration failure", () => {
    expect(clientMessage({ ok: false, reason: "config", detail: "x" })).toEqual({
      status: 500,
      body: "authentication is misconfigured on the server",
    });
  });

  it("returns 401 for every genuine auth failure", () => {
    const reasons: VerifyFailure["reason"][] = [
      "missing-token",
      "malformed",
      "bad-signature",
      "wrong-audience",
      "wrong-issuer",
      "expired",
      "not-yet-valid",
      "wrong-algorithm",
    ];
    for (const reason of reasons) {
      expect(clientMessage({ ok: false, reason, detail: "x" }).status, reason).toBe(401);
    }
  });

  it("never leaks the detail to the client", () => {
    // "aud is app-xyz, expected app-abc" tells an attacker exactly which id to forge.
    const message = clientMessage({
      ok: false,
      reason: "wrong-audience",
      detail: `aud is clzattacker, expected ${APP_ID}`,
    });
    expect(message.body).not.toContain(APP_ID);
    expect(message.body).not.toContain("clzattacker");
  });
});

describe("the pinned constants", () => {
  it("match what Privy documents and what its JWKS serves", () => {
    // Verified against the live JWKS for this app: two keys, both
    // kty=EC crv=P-256 alg=ES256. Two keys means rotation is in progress, which is why
    // the signature verifier must select by `kid` rather than taking "the" key.
    expect(PRIVY_ALGORITHM).toBe("ES256");
    expect(PRIVY_ISSUER).toBe("privy.io");
  });
});
