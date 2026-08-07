/**
 * Honesty-guard tests.
 *
 * These encode published results, so the numbers are checkable rather than invented.
 */
import { describe, expect, it } from "vitest";
import {
  assessCostModel,
  assessOverfitting,
  assessSampleSize,
  createMemoryTrialLog,
  formatHonestReport,
  minBacktestYears,
  requiredSharpe,
} from "./honesty.js";

describe("requiredSharpe", () => {
  /** More variants tried, higher the bar — growth is sqrt(2 ln N). */
  it("rises with the number of variants tried", () => {
    const few = requiredSharpe(5, 5);
    const many = requiredSharpe(500, 5);
    expect(many).toBeGreaterThan(few);
  });

  it("falls as more data becomes available", () => {
    expect(requiredSharpe(50, 10)).toBeLessThan(requiredSharpe(50, 2));
  });

  it("rejects nonsensical inputs rather than returning a number", () => {
    expect(() => requiredSharpe(0, 5)).toThrow();
    expect(() => requiredSharpe(5, 0)).toThrow();
  });
});

describe("minBacktestYears", () => {
  /**
   * The published anchor: with ~45 trials, a Sharpe of 1.0 needs roughly 5 years before
   * it is distinguishable from noise.
   */
  it("reproduces the ~45-trials / Sharpe 1.0 / ~5 years result", () => {
    const years = minBacktestYears(45, 1.0);
    expect(years).toBeGreaterThan(6);
    expect(years).toBeLessThan(9);
  });

  it("demands infinite data for a non-positive Sharpe", () => {
    expect(minBacktestYears(10, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(minBacktestYears(10, -0.5)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("assessOverfitting", () => {
  it("accepts a strong result from few trials on ample data", () => {
    const v = assessOverfitting({ trials: 3, observedSharpe: 2.5, yearsAvailable: 10 });
    expect(v.credible).toBe(true);
    expect(v.verdict).toMatch(/not a profitability guarantee/);
  });

  /** The case that matters: an agent that tried a thousand things and picked the best. */
  it("rejects a good-looking Sharpe produced by many trials", () => {
    const v = assessOverfitting({ trials: 1_000, observedSharpe: 1.0, yearsAvailable: 2 });
    expect(v.credible).toBe(false);
    expect(v.verdict).toMatch(/Treat this as noise/);
  });

  it("never calls a result credible without enough years, however good it looks", () => {
    const v = assessOverfitting({ trials: 200, observedSharpe: 1.2, yearsAvailable: 0.5 });
    expect(v.credible).toBe(false);
  });
});

describe("trial log", () => {
  /**
   * Deliberately has no reset. An agent that could zero its own trial count would make
   * the entire overfitting check decorative.
   */
  it("exposes no way to reset the count", () => {
    const log = createMemoryTrialLog();
    expect(Object.keys(log).sort()).toEqual(["best", "count", "record"]);
  });

  it("accumulates across variants and remembers the best", async () => {
    const log = createMemoryTrialLog();
    await log.record({ name: "a", sharpe: 0.4 });
    await log.record({ name: "b", sharpe: 1.9 });
    await log.record({ name: "c", sharpe: 1.1 });
    expect(await log.count()).toBe(3);
    expect((await log.best())?.name).toBe("b");
  });

  it("reports no best before anything has been tried", async () => {
    expect(await createMemoryTrialLog().best()).toBeUndefined();
  });
});

describe("assessSampleSize", () => {
  it("requires more trades as returns get noisier", () => {
    const calm = assessSampleSize({ meanReturn: 1, stdDev: 2, trades: 100 });
    const wild = assessSampleSize({ meanReturn: 1, stdDev: 10, trades: 100 });
    expect(wild.needed).toBeGreaterThan(calm.needed);
  });

  it("accepts a sample that clears t > 3", () => {
    // needed = 9*(2/1)^2 = 36
    const v = assessSampleSize({ meanReturn: 1, stdDev: 2, trades: 40 });
    expect(v.sufficient).toBe(true);
    expect(v.needed).toBe(36);
  });

  it("refuses to size a sample around a non-positive edge", () => {
    const v = assessSampleSize({ meanReturn: -0.1, stdDev: 1, trades: 10_000 });
    expect(v.sufficient).toBe(false);
    expect(v.detail).toMatch(/no edge/);
  });
});

describe("assessCostModel", () => {
  const complete = {
    slippageFromPoolState: true,
    gasIncluded: true,
    revertsIncluded: true,
    feesIncluded: true,
    priceImpactOfOwnSize: true,
  };

  it("passes a complete model", () => {
    expect(assessCostModel(complete).ok).toBe(true);
  });

  /** A fixed slippage % is the classic naive-backtest failure — impact scales as α/(1+α). */
  it("names a fixed slippage assumption as the failure it is", () => {
    const r = assessCostModel({ ...complete, slippageFromPoolState: false });
    expect(r.ok).toBe(false);
    expect(r.missing[0]).toMatch(/α\/\(1\+α\)/);
  });

  /** On a chain where 22-30% of swaps revert, ignoring them measures a different activity. */
  it("flags omitted reverts", () => {
    const r = assessCostModel({ ...complete, revertsIncluded: false });
    expect(r.missing.some((m) => /reverted trades/.test(m))).toBe(true);
  });

  it("flags ignoring the strategy's own price impact", () => {
    const r = assessCostModel({ ...complete, priceImpactOfOwnSize: false });
    expect(r.missing.some((m) => /a path you did not move/.test(m))).toBe(true);
  });
});

describe("formatHonestReport", () => {
  it("always states that no profitability claim may be made", () => {
    const report = formatHonestReport({
      overfit: assessOverfitting({ trials: 2, observedSharpe: 3, yearsAvailable: 10 }),
      sample: assessSampleSize({ meanReturn: 1, stdDev: 2, trades: 500 }),
      costs: assessCostModel({
        slippageFromPoolState: true,
        gasIncluded: true,
        revertsIncluded: true,
        feesIncluded: true,
        priceImpactOfOwnSize: true,
      }),
    });
    expect(report).toMatch(/no profitability claim may be made/);
    expect(report).toMatch(/RESULT: not ruled out/);
  });

  it("says 'indistinguishable from noise' when the result does not survive", () => {
    const report = formatHonestReport({
      overfit: assessOverfitting({ trials: 5_000, observedSharpe: 0.9, yearsAvailable: 1 }),
      sample: assessSampleSize({ meanReturn: 0.01, stdDev: 5, trades: 20 }),
      costs: assessCostModel({
        slippageFromPoolState: false,
        gasIncluded: false,
        revertsIncluded: false,
        feesIncluded: false,
        priceImpactOfOwnSize: false,
      }),
    });
    expect(report).toMatch(/indistinguishable from noise/);
    expect(report).toMatch(/INCOMPLETE/);
  });

  it("surfaces a venue caveat when one applies", () => {
    const report = formatHonestReport({
      overfit: assessOverfitting({ trials: 2, observedSharpe: 3, yearsAvailable: 10 }),
      sample: assessSampleSize({ meanReturn: 1, stdDev: 1, trades: 100 }),
      costs: assessCostModel({
        slippageFromPoolState: true,
        gasIncluded: true,
        revertsIncluded: true,
        feesIncluded: true,
        priceImpactOfOwnSize: true,
      }),
      venueNote: "asset has no AMM on this chain — fills are modelled, not observed",
    });
    expect(report).toMatch(/no AMM on this chain/);
  });
});
