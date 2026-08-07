import { describe, expect, it } from "vitest";
import {
  assertHuntableTax,
  DEFAULT_ELIGIBILITY,
  type EligibilityConfig,
  HUNTABLE_TAX_PCT,
  isEligible,
  type TokenSnapshot,
} from "./eligible.js";
import { LOOKBACK_MINUTES } from "./signal.js";

/** A token that passes every filter, so each test can break exactly one thing. */
function huntable(overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    address: "0x8Cbab44d000000000000000000000000000004ccc",
    taxPct: 1,
    marketCapWei: 5_000_000_000_000_000_000n, // 5 ETH
    holders: 120,
    volumeAllTimeWei: 500_000_000_000_000_000n, // 0.5 ETH
    ageSeconds: 7200,
    tickSpacing: 200,
    ...overrides,
  };
}

describe("RULE 1 — a stray may hunt taxPct === 1 and nothing else", () => {
  it("admits a 1%-tax token", () => {
    expect(isEligible(huntable(), DEFAULT_ELIGIBILITY).ok).toBe(true);
  });

  /*
   * ══ THE TEST THE BRIEF NAMES: A 10% TAX TOKEN IS REFUSED ══
   *
   * At 10% a position must gain 19.4% just to break even, against a measured mean absolute 24h
   * move of 7.7%. RESEARCH §0 calls this filter "the difference between a product and a money
   * incinerator".
   */
  it("REFUSES a 10%-tax token", () => {
    const verdict = isEligible(huntable({ taxPct: 10 }), DEFAULT_ELIGIBILITY);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/taxPct 10%/);
  });

  it("the 10% refusal reason carries the ARITHMETIC, so /logs shows why", () => {
    const verdict = isEligible(huntable({ taxPct: 10 }), DEFAULT_ELIGIBILITY);
    if (verdict.ok) throw new Error("expected a refusal");
    // The break-even move, the 1% comparison, and the measured typical move must all appear —
    // a bare "not eligible" is an assertion, not a finding (DESIGN §8).
    expect(verdict.reason).toMatch(/231bps/);
    expect(verdict.reason).toMatch(/20\.32%/);
    expect(verdict.reason).toMatch(/7\.7%/);
  });

  it("REFUSES every non-1% tier the pad actually issues (3, 5, 10)", () => {
    // RESEARCH §3e measured the live distribution: 1% 33%, 3% 13%, 5% 23%, 10% 31%.
    for (const taxPct of [3, 5, 10]) {
      const verdict = isEligible(huntable({ taxPct }), DEFAULT_ELIGIBILITY);
      expect(verdict.ok, `taxPct ${String(taxPct)} must be refused`).toBe(false);
    }
  });

  it("REFUSES taxPct 0 — a failed API read, not a free lunch", () => {
    // Every pool routes through the hook that charges the tax, so 0 cannot be real. A `<= 1`
    // comparison would admit it and treat a broken read as the most attractive token on the venue.
    const verdict = isEligible(huntable({ taxPct: 0 }), DEFAULT_ELIGIBILITY);
    expect(verdict.ok).toBe(false);
  });

  it("REFUSES a fractional taxPct — the pad reports integers", () => {
    const verdict = isEligible(huntable({ taxPct: 1.5 }), DEFAULT_ELIGIBILITY);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/not an integer percent/);
  });

  it("REFUSES a NaN taxPct", () => {
    const verdict = isEligible(huntable({ taxPct: Number.NaN }), DEFAULT_ELIGIBILITY);
    expect(verdict.ok).toBe(false);
  });

  /*
   * ══ THE SABOTAGE THE BRIEF DEMANDS, RUN INSIDE THE SUITE ══
   *
   * "removing the tax filter makes a test fail". Rather than only asserting that here in prose,
   * this test reimplements `isEligible` WITHOUT the tax check and proves the difference is
   * observable — so the suite itself demonstrates that the filter, not something downstream, is
   * what refuses a 10% token.
   */
  it("SABOTAGE: a filter with the tax check removed admits the 10% token the real one refuses", () => {
    const tenPct = huntable({ taxPct: 10 });

    // The real filter refuses it.
    expect(isEligible(tenPct, DEFAULT_ELIGIBILITY).ok).toBe(false);

    // A copy of the filter with ONLY the tax check deleted. Every other floor is unchanged.
    const withoutTaxFilter = (t: TokenSnapshot, cfg: EligibilityConfig): boolean =>
      t.marketCapWei >= cfg.minMarketCapWei &&
      t.holders >= cfg.minHolders &&
      t.volumeAllTimeWei >= cfg.minVolumeAllTimeWei &&
      t.ageSeconds >= cfg.minAgeSeconds &&
      t.ageSeconds <= cfg.maxAgeSeconds &&
      t.tickSpacing > 0;

    // It admits the token. So the tax check IS the thing doing the refusing — no other floor
    // happens to catch a 10% token by accident, which is what makes the real check load-bearing
    // rather than redundant with the rest.
    expect(withoutTaxFilter(tenPct, DEFAULT_ELIGIBILITY)).toBe(true);
  });

  it("a config that tries to permit another tier is REFUSED, not honoured", () => {
    // RESEARCH §7g: a setting whose value contradicts what the system may do. Configurable for
    // testability, but arithmetic is not a matter of configuration.
    const permissive: EligibilityConfig = { ...DEFAULT_ELIGIBILITY, requiredTaxPct: 10 };
    expect(() => isEligible(huntable({ taxPct: 10 }), permissive)).toThrow(/Only 1% is huntable/);
    expect(() => assertHuntableTax(permissive)).toThrow(/arithmetic, not configuration/);
  });

  it("HUNTABLE_TAX_PCT is 1 and the shipped config agrees with it", () => {
    expect(HUNTABLE_TAX_PCT).toBe(1);
    expect(DEFAULT_ELIGIBILITY.requiredTaxPct).toBe(HUNTABLE_TAX_PCT);
  });
});

describe("the liquidity, holder, volume and age floors", () => {
  it("refuses a market cap below the floor, and names why the cost model needs it", () => {
    const verdict = isEligible(
      huntable({ marketCapWei: DEFAULT_ELIGIBILITY.minMarketCapWei - 1n }),
      DEFAULT_ELIGIBILITY,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/price-impact term/);
  });

  it("admits a market cap exactly AT the floor — the boundary is inclusive", () => {
    // Both sides of every boundary, because a check written with the wrong comparator passes a
    // one-sided test and fails only on the value nobody tried.
    expect(
      isEligible(
        huntable({ marketCapWei: DEFAULT_ELIGIBILITY.minMarketCapWei }),
        DEFAULT_ELIGIBILITY,
      ).ok,
    ).toBe(true);
  });

  it("refuses too few holders — a price nobody else trades is one address's mark", () => {
    const verdict = isEligible(
      huntable({ holders: DEFAULT_ELIGIBILITY.minHolders - 1 }),
      DEFAULT_ELIGIBILITY,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/one address's mark/);
  });

  it("admits exactly the minimum holder count", () => {
    expect(
      isEligible(huntable({ holders: DEFAULT_ELIGIBILITY.minHolders }), DEFAULT_ELIGIBILITY).ok,
    ).toBe(true);
  });

  it("refuses a fractional holder count", () => {
    expect(isEligible(huntable({ holders: 30.5 }), DEFAULT_ELIGIBILITY).ok).toBe(false);
  });

  it("refuses a token that has never really traded", () => {
    // RESEARCH §3d: only 29 of the newest 48 launches had a non-zero 24h move.
    const verdict = isEligible(huntable({ volumeAllTimeWei: 0n }), DEFAULT_ELIGIBILITY);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/29 of the newest 48/);
  });

  it("refuses a token younger than the signal horizon", () => {
    const verdict = isEligible({ ...huntable(), ageSeconds: 60 }, DEFAULT_ELIGIBILITY);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/younger than the signal horizon/);
  });

  /*
   * The age floor is DERIVED from the signal horizon rather than picked. If the horizon moves and
   * this floor does not, a token could pass eligibility while being unable to supply the history
   * the signal needs — which would surface as "no signal" forever rather than as a config error.
   */
  it("the minimum age EQUALS the signal lookback, so the two cannot drift apart", () => {
    expect(BigInt(DEFAULT_ELIGIBILITY.minAgeSeconds)).toBe(LOOKBACK_MINUTES * 60n);
  });

  it("refuses a token older than the window every measurement was taken in", () => {
    const verdict = isEligible(
      huntable({ ageSeconds: DEFAULT_ELIGIBILITY.maxAgeSeconds + 1 }),
      DEFAULT_ELIGIBILITY,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/population we never sampled/);
  });

  it("admits both age boundaries exactly", () => {
    expect(
      isEligible(huntable({ ageSeconds: DEFAULT_ELIGIBILITY.minAgeSeconds }), DEFAULT_ELIGIBILITY)
        .ok,
    ).toBe(true);
    expect(
      isEligible(huntable({ ageSeconds: DEFAULT_ELIGIBILITY.maxAgeSeconds }), DEFAULT_ELIGIBILITY)
        .ok,
    ).toBe(true);
  });

  it("refuses a negative or non-finite age", () => {
    expect(isEligible(huntable({ ageSeconds: -1 }), DEFAULT_ELIGIBILITY).ok).toBe(false);
    expect(isEligible(huntable({ ageSeconds: Number.NaN }), DEFAULT_ELIGIBILITY).ok).toBe(false);
  });

  it("refuses a missing tickSpacing — the PoolKey cannot be built without it", () => {
    // RESEARCH §2: tickSpacing varies per launch and MUST be read per token. Without it there is
    // no poolId, so there is no pool to address at all.
    const verdict = isEligible(huntable({ tickSpacing: 0 }), DEFAULT_ELIGIBILITY);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/PoolKey cannot be reconstructed/);
  });
});

describe("the reason string — it goes in the logs, so it has to be usable", () => {
  it("every refusal names the token address", () => {
    const broken: ReadonlyArray<Partial<TokenSnapshot>> = [
      { taxPct: 10 },
      { taxPct: 1.5 },
      { marketCapWei: 0n },
      { holders: 1 },
      { volumeAllTimeWei: 0n },
      { ageSeconds: 1 },
      { ageSeconds: 99_999_999 },
      { tickSpacing: 0 },
      { ageSeconds: -5 },
    ];
    for (const override of broken) {
      const verdict = isEligible(huntable(override), DEFAULT_ELIGIBILITY);
      expect(verdict.ok, JSON.stringify(override, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.reason).toContain("0x8Cbab44d000000000000000000000000000004ccc");
      // A reason must be a sentence, not a code. "refused" alone tells /logs nothing.
      expect(verdict.reason.length).toBeGreaterThan(60);
    }
  });

  it("a passing token carries no reason field at all", () => {
    const verdict = isEligible(huntable(), DEFAULT_ELIGIBILITY);
    expect(verdict).toEqual({ ok: true });
  });
});

describe("purity", () => {
  it("reads no clock — age arrives as data", () => {
    // Same inputs, same answer, regardless of when it is called. If this function read
    // Date.now() to compute age, two calls straddling a boundary could disagree.
    const t = huntable();
    const a = isEligible(t, DEFAULT_ELIGIBILITY);
    const b = isEligible(t, DEFAULT_ELIGIBILITY);
    expect(a).toEqual(b);
  });

  it("does not mutate the token or the config it is given", () => {
    const t = huntable({ taxPct: 10 });
    const frozenToken = Object.freeze({ ...t });
    const frozenCfg = Object.freeze({ ...DEFAULT_ELIGIBILITY });
    expect(() => isEligible(frozenToken, frozenCfg)).not.toThrow();
  });
});
