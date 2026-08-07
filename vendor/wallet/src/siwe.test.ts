import { describe, expect, it } from "vitest";
import { checkSiwe, createMemoryNonceStore, generateNonce, sessionKey } from "./siwe.js";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NOW = Date.parse("2026-07-28T12:00:00Z");

function fields(over: Record<string, unknown> = {}) {
  return {
    domain: "app.example.com",
    address: ADDRESS,
    uri: "https://app.example.com",
    version: "1",
    chainId: 4663,
    nonce: "a1b2c3d4e5f6a7b8",
    issuedAt: "2026-07-28T11:59:00Z",
    ...over,
  };
}

describe("generateNonce", () => {
  it("meets the EIP-4361 minimum of 8 alphanumeric characters", () => {
    const nonce = generateNonce();
    expect(nonce.length).toBeGreaterThanOrEqual(8);
    expect(nonce).toMatch(/^[a-z0-9]+$/);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateNonce()));
    expect(seen.size).toBe(200);
  });

  /**
   * A predictable nonce is the same vulnerability as no nonce: an attacker can obtain a
   * signature for a value you are about to issue. Failing loudly beats falling back to
   * Math.random.
   */
  it("refuses to run without a CSPRNG rather than weakening silently", () => {
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
      expect(() => generateNonce()).toThrow(/predictable source/);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});

describe("createMemoryNonceStore", () => {
  it("consumes a nonce exactly once", async () => {
    const store = createMemoryNonceStore(() => NOW);
    await store.issue("abc12345", NOW + 60_000);

    expect(await store.consume("abc12345")).toBe(true);
    expect(await store.consume("abc12345")).toBe(false); // the replay defence
  });

  it("rejects a nonce it never issued", async () => {
    const store = createMemoryNonceStore(() => NOW);
    expect(await store.consume("never-issued")).toBe(false);
  });

  it("rejects an expired nonce and does not leave it consumable", async () => {
    const store = createMemoryNonceStore(() => NOW);
    await store.issue("abc12345", NOW - 1);
    expect(await store.consume("abc12345")).toBe(false);
    expect(await store.consume("abc12345")).toBe(false);
  });

  it("does not grow unboundedly as nonces are used", async () => {
    const store = createMemoryNonceStore(() => NOW);
    for (let i = 0; i < 50; i++) {
      const nonce = `nonce${i}`;
      await store.issue(nonce, NOW + 60_000);
      await store.consume(nonce);
    }
    expect(store.size()).toBe(0);
  });
});

describe("checkSiwe", () => {
  async function withNonce(over: Record<string, unknown> = {}, expectedDomain = "app.example.com") {
    const store = createMemoryNonceStore(() => NOW);
    const f = fields(over);
    if (typeof f.nonce === "string") await store.issue(f.nonce, NOW + 300_000);
    return checkSiwe({ fields: f, expectedDomain, store, now: NOW, expectedChainId: 4663 });
  }

  it("accepts a well-formed message", async () => {
    const result = await withNonce();
    expect(result.ok, result.problems.join("; ")).toBe(true);
  });

  /**
   * The failure that makes SIWE worthless: viem's verifySiweMessage only checks the nonce
   * MATCHES what you pass in — it does not store, track, or invalidate. Without consuming,
   * every captured signature is a permanent credential.
   */
  it("rejects a replayed message", async () => {
    const store = createMemoryNonceStore(() => NOW);
    const f = fields();
    await store.issue(f.nonce, NOW + 300_000);

    const first = await checkSiwe({
      fields: f,
      expectedDomain: "app.example.com",
      store,
      now: NOW,
    });
    expect(first.ok).toBe(true);

    const replay = await checkSiwe({
      fields: f,
      expectedDomain: "app.example.com",
      store,
      now: NOW,
    });
    expect(replay.ok).toBe(false);
    expect(replay.problems.join()).toContain("already been used");
  });

  it("rejects a nonce this server never issued", async () => {
    const store = createMemoryNonceStore(() => NOW);
    const result = await checkSiwe({
      fields: fields({ nonce: "attackerchosen1" }),
      expectedDomain: "app.example.com",
      store,
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });

  /**
   * Domain binding. Without it a phishing site collects a signature for its OWN origin and
   * replays it against your backend — the signature is perfectly valid, it was just never
   * meant for you.
   */
  it("rejects a message signed for a different origin", async () => {
    const result = await withNonce({ domain: "phishing.example" });
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("phishing site can replay");
  });

  it("requires version 1 exactly", async () => {
    expect((await withNonce({ version: "2" })).ok).toBe(false);
    expect((await withNonce({ version: undefined })).ok).toBe(false);
  });

  it("rejects a malformed address", async () => {
    expect((await withNonce({ address: "not-an-address" })).ok).toBe(false);
  });

  it("rejects a chainId mismatch", async () => {
    const result = await withNonce({ chainId: 1 });
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("expected 4663");
  });

  it("enforces the 8-alphanumeric nonce floor", async () => {
    expect((await withNonce({ nonce: "short" })).ok).toBe(false);
    expect((await withNonce({ nonce: "has-a-dash-in-it" })).ok).toBe(false);
  });

  it("honours expiration-time server-side", async () => {
    const result = await withNonce({ expirationTime: "2026-07-28T11:00:00Z" });
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("expired");
  });

  it("honours not-before server-side", async () => {
    const result = await withNonce({ notBefore: "2026-07-29T00:00:00Z" });
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("not valid yet");
  });

  /**
   * A timestamp that is present but not a date.
   *
   * `Date.parse` returns NaN rather than throwing, and every comparison against NaN is
   * false — so `expires <= now` is false for garbage, and without the explicit
   * `Number.isNaN` guard an `expirationTime` of "soon" or "" or a stray unix-seconds
   * integer would sail through as "not expired". That is a message with an expiry field
   * the server is silently not enforcing, which is strictly worse than one with no expiry
   * at all because it looks protected.
   *
   * `notBefore` fails the same way in the opposite direction: NaN > now is false, so
   * garbage reads as "already valid".
   */
  it("rejects an unparseable expirationTime instead of reading it as not-expired", async () => {
    for (const bad of ["soon", "2026-13-45T99:99:99Z", "tomorrow"]) {
      const result = await withNonce({ expirationTime: bad });
      expect(result.ok, bad).toBe(false);
      expect(result.problems.join(), bad).toContain(`expirationTime is unparseable: ${bad}`);
    }
  });

  it("rejects an unparseable notBefore instead of reading it as already-valid", async () => {
    const result = await withNonce({ notBefore: "whenever" });
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("notBefore is unparseable: whenever");
    // Specifically NOT the "not valid yet" message — that would mean it parsed.
    expect(result.problems.join()).not.toContain("not valid yet");
  });

  it("accepts a message inside its validity window", async () => {
    const result = await withNonce({
      notBefore: "2026-07-28T11:00:00Z",
      expirationTime: "2026-07-28T13:00:00Z",
    });
    expect(result.ok, result.problems.join("; ")).toBe(true);
  });

  it("requires issuedAt", async () => {
    expect((await withNonce({ issuedAt: undefined })).ok).toBe(false);
    expect((await withNonce({ issuedAt: "not a date" })).ok).toBe(false);
  });

  /**
   * `now` omitted, which is how a request handler actually calls this — it has no clock
   * to pass. The `?? Date.now()` default is what makes the expiry and not-before checks
   * run at all against a real request.
   *
   * If the default were missing, `now` would be undefined and every `expires <= undefined`
   * / `notBefore > undefined` comparison would be false, so expiry enforcement would
   * silently stop: a message that expired a year ago would be accepted, making every
   * captured signature permanent — the exact failure this whole module exists to prevent.
   *
   * Both directions are asserted against the real clock so the test cannot pass by the
   * checks simply never firing.
   */
  it("defaults now to the real clock when no timestamp is supplied", async () => {
    const run = async (over: Record<string, unknown>) => {
      const store = createMemoryNonceStore();
      const f = fields(over);
      await store.issue(f.nonce, Date.now() + 300_000);
      return checkSiwe({ fields: f, expectedDomain: "app.example.com", store });
    };

    const live = await run({
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expirationTime: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(live.ok, live.problems.join("; ")).toBe(true);

    const stale = await run({
      issuedAt: new Date(Date.now() - 7_200_000).toISOString(),
      expirationTime: new Date(Date.now() - 600_000).toISOString(),
    });
    expect(stale.ok, "an expired message must be caught with no clock supplied").toBe(false);
    expect(stale.problems.join()).toContain("expired");

    const early = await run({
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      notBefore: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(early.ok).toBe(false);
    expect(early.problems.join()).toContain("not valid yet");
  });

  it("reports every problem at once, not just the first", async () => {
    const result = await withNonce({ version: "2", address: "bad", chainId: 1 });
    expect(result.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("sessionKey", () => {
  /**
   * The spec: a session "MUST be bound to the address and not to further resolved
   * resources that may change". An ENS name can be sold; a session keyed on one
   * transfers with it.
   */
  it("normalises an address so casing cannot fork a session", () => {
    expect(sessionKey(ADDRESS)).toBe(ADDRESS.toLowerCase());
    expect(sessionKey(ADDRESS.toLowerCase())).toBe(
      sessionKey(ADDRESS.toUpperCase().replace("0X", "0x")),
    );
  });

  it("refuses to key a session on anything that is not an address", () => {
    expect(() => sessionKey("vitalik.eth")).toThrow(/not an address/);
  });
});
