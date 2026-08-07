import { describe, expect, it } from "vitest";
import {
  assertTaxCeiling,
  DEFAULT_ELIGIBILITY,
  type EligibilityConfig,
  MAX_PAD_TAX_PCT,
  isEligible,
  type TokenSnapshot,
} from "./eligible.js";
import { HOOK_PRIMARY, HOOK_SECONDARY } from "./hook.js";
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
    // 25 realised swaps: inside `age.ts`'s [20, 50] entry window, so the age gate is not what any
    // of these tests are measuring. The window itself is tested in `age.test.ts`.
    swapCount: 25,
    tickSpacing: 200,
    hook: HOOK_PRIMARY,
    ...overrides,
  };
}

describe("TAX IS A COST TERM, NOT AN EXCLUSION", () => {
  /*
   * ══ WHAT THIS BLOCK REPLACED, AND WHY ══
   *
   * This file used to assert "a stray may hunt taxPct === 1 and nothing else". That rule is gone.
   * A 5%-tax token that moves 30% is far more profitable than a 1%-tax token that moves 2%, so
   * tax is now priced in `score.ts` and each tier is required to clear its OWN bar:
   *
   *    1% -> 231bps round trip -> bar +4.63%      5% -> 1008bps -> bar +20.2%
   *    3% -> 624bps            -> bar +12.5%     10% -> 1938bps -> bar +38.8%
   *
   * A 10%-tax token is refused by the ARITHMETIC when it cannot clear +38.8%, not by a rule that
   * never let it be seen. `score.test.ts` proves the arithmetic actually binds.
   */
  it("ADMITS every tier the pad issues — 1, 3, 5 and 10", () => {
    // Measured across the newest 100 launches: 1% = 29, 3% = 10, 5% = 18, 10% = 43. All are
    // evaluable; the cost bar decides, not this filter.
    for (const taxPct of [1, 3, 5, 10]) {
      const verdict = isEligible(huntable({ taxPct }), DEFAULT_ELIGIBILITY);
      expect(verdict.ok, `taxPct ${String(taxPct)} must be evaluable`).toBe(true);
    }
  });

  it("REFUSES a taxPct above the ceiling — a failed read, not an expensive token", () => {
    const verdict = isEligible(huntable({ taxPct: 900 }), DEFAULT_ELIGIBILITY);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/exceeds the 10% ceiling/);
    // The reason must say that an EXPENSIVE token would be priced rather than filtered, so the
    // log distinguishes "malformed" from "too costly". Those are different findings.
    expect(verdict.reason).toMatch(/priced by score\.ts/);
  });

  it("REFUSES taxPct 0 — a failed API read, not a free lunch", () => {
    // Every pool routes through the hook that charges the tax, so 0 cannot be real.
    const verdict = isEligible(huntable({ taxPct: 0 }), DEFAULT_ELIGIBILITY);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/coerced to a number/);
  });

  it("REFUSES a negative taxPct", () => {
    expect(isEligible(huntable({ taxPct: -1 }), DEFAULT_ELIGIBILITY).ok).toBe(false);
  });

  it("REFUSES a fractional taxPct — the pad reports integers", () => {
    const verdict = isEligible(huntable({ taxPct: 1.5 }), DEFAULT_ELIGIBILITY);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/not an integer percent/);
  });

  it("REFUSES a NaN taxPct", () => {
    expect(isEligible(huntable({ taxPct: Number.NaN }), DEFAULT_ELIGIBILITY).ok).toBe(false);
  });

  it("a config whose ceiling is outside what the pad issues is REFUSED", () => {
    // RESEARCH §7g: a setting whose value contradicts what the system may do. A ceiling above 10
    // would let a malformed taxPct reach the cost model and produce a plausible cost for a tier
    // that does not exist.
    const tooHigh: EligibilityConfig = { ...DEFAULT_ELIGIBILITY, maxTaxPct: 50 };
    expect(() => isEligible(huntable(), tooHigh)).toThrow(/sanity bound, not a trading rule/);
    expect(() => assertTaxCeiling(tooHigh)).toThrow(/1\.\.10/);

    const tooLow: EligibilityConfig = { ...DEFAULT_ELIGIBILITY, maxTaxPct: 0 };
    expect(() => assertTaxCeiling(tooLow)).toThrow();
  });

  it("MAX_PAD_TAX_PCT is 10 and the shipped config agrees with it", () => {
    expect(MAX_PAD_TAX_PCT).toBe(10);
    expect(DEFAULT_ELIGIBILITY.maxTaxPct).toBe(MAX_PAD_TAX_PCT);
  });

  it("the tax ceiling is enforced on EVERY call, not only when a caller remembers", () => {
    // `assertTaxCeiling` is called from inside `isEligible`, so there is no path that skips it.
    // Without this the guard would be advisory, which RESEARCH §7g is exactly about.
    const bad: EligibilityConfig = { ...DEFAULT_ELIGIBILITY, maxTaxPct: 11 };
    expect(() => isEligible(huntable({ taxPct: 1 }), bad)).toThrow();
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
    // The reason must name the MEASURED seed, not the old price-impact rationale — the floor now
    // exists because 1.356 ETH is the untraded default and 84/100 tokens sit on it.
    expect(verdict.reason).toMatch(/SEED market cap is 1\.356 ETH/);
    expect(verdict.reason).toMatch(/15\/15/);
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
    // The holders floor is now explicitly a LIVENESS proxy, and the reason must say so — the
    // rug-protection job moved to screen.ts and the log must not imply otherwise.
    expect(verdict.reason).toMatch(/counts the POOL CONTRACT/);
    expect(verdict.reason).toMatch(/LIVENESS proxy only/);
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
      // NOT `{ taxPct: 10 }` — 10% is a valid tier now and is refused by the cost bar, not here.
      { taxPct: 900 },
      { taxPct: 0 },
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

describe("THE HOOK — there are two, and v1 could only reach one (RESEARCH §7d)", () => {
  /*
   * ══ THE MEASURED FAILURE THIS GATE PREVENTS ══
   *
   * RESEARCH §7d reconstructed every token's poolId against both candidate hooks and matched the
   * result against the pad's own `pool` field: 67 tokens on 0x75A54357…, 44 on 0xEfe66981…, 3
   * unmatched. The v1 vault hardcoded the first as an immutable, so for 44 of 111 tokens it built
   * a PoolKey addressing a pool that does not exist — including LEVCAT, INTERN and Seriouscat,
   * three of the four highest-volume names on the pad.
   *
   * The failure hid because the revert was an empty inner revert wrapped in
   * `UnexpectedRevertBytes`, which reads exactly like a transient RPC problem.
   */
  it("ADMITS a token on the primary hook", () => {
    expect(isEligible(huntable({ hook: HOOK_PRIMARY }), DEFAULT_ELIGIBILITY).ok).toBe(true);
  });

  it("ADMITS a token on the SECOND hook — the 44 tokens v1 could not trade at all", () => {
    // Both directions matter. A suite that only proved the refusal would pass just as happily
    // against the old single-hook rule, which is the thing being replaced.
    expect(isEligible(huntable({ hook: HOOK_SECONDARY }), DEFAULT_ELIGIBILITY).ok).toBe(true);
  });

  it("REFUSES an arbitrary hook, and says why in a sentence", () => {
    const verdict = isEligible(
      huntable({ hook: "0x000000000000000000000000000000000000dEaD" }),
      DEFAULT_ELIGIBILITY,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/not one of the two known letscash hooks/);
    // Both allowlisted addresses are named, so an operator reading /logs can see what was expected.
    expect(verdict.reason).toContain(HOOK_PRIMARY);
    expect(verdict.reason).toContain(HOOK_SECONDARY);
  });

  it("REFUSES a missing or malformed hook rather than defaulting to the primary", () => {
    // Defaulting is precisely the v1 bug. A token whose hook we failed to read is a token whose
    // pool we cannot address, and guessing produces a revert with empty bytes.
    for (const bad of ["", "0x", undefined as unknown as string]) {
      expect(isEligible(huntable({ hook: bad }), DEFAULT_ELIGIBILITY).ok).toBe(false);
    }
  });

  it("is CASE-INSENSITIVE — a lowercase read of the same hook is the same hook", () => {
    // The pad's API and the RPC disagree about EIP-55 casing. An allowlist that a lowercase
    // address fails refuses every legitimate trade from one data source while passing tests
    // written against the other.
    for (const spelling of [
      HOOK_SECONDARY.toLowerCase(),
      HOOK_PRIMARY.toLowerCase(),
      // `toUpperCase()` also uppercases the `0X` prefix, which is still the same address value.
      HOOK_PRIMARY.toUpperCase(),
      ` ${HOOK_PRIMARY} `,
    ]) {
      expect(isEligible(huntable({ hook: spelling }), DEFAULT_ELIGIBILITY).ok, spelling).toBe(true);
    }
  });
});
