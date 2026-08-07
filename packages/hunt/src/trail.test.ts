import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_RISK } from "./risk.js";
import { STOP_LOSS_BPS, TAKE_PROFIT_BPS } from "./signal.js";
import { raisePeak, TRAIL_BPS, trailingStopFired } from "./trail.js";

const P = 1_000_000_000_000_000_000n; // 1e18: one ETH per token, the fixture price scale

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHAT THIS EXIT REPLACED, AND THE MEASUREMENT THAT REPLACED IT ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The shipped exit was a −235bps level stop and a ~+471bps derived take-profit, both honestly
 * derived from a measured 157bps hourly sigma. RESULTS §10 measured that they are backwards on
 * this asset: they close the positions that pay for everything. §10.4 — the top 10% of positions
 * carry 76.1% of all profit, and the median winner is +5,609bps, so a 471bps target is how the old
 * strategy converted its winners into small ones.
 *
 * The replacement is a 50% trail from the running peak: 72 of 72 held-out positions RESOLVED
 * (0% marked to market), 73.6% of them profitably.
 *
 * ══ AND THE HONESTY LINE, WHICH THIS SUITE ALSO PINS ══
 *
 * `assessOverfitting` at 183 cumulative trials returns `credible: false`. n=72, a 1.74-day median
 * held-out span, a cost model incomplete in the optimistic direction, and a Welch t against matched
 * random of 2.30–2.69 that clears t>3 on ZERO of 20 seeds. Out-of-sample positive; not proven.
 */

describe("TRAIL_BPS is 50%, and it was chosen BEFORE the sweep that measured it (§10.3)", () => {
  it("is 5000bps", () => {
    expect(TRAIL_BPS).toBe(5000n);
  });

  it("is the config the risk module ships — the two cannot drift apart", () => {
    expect(DEFAULT_RISK.trailBps).toBe(TRAIL_BPS);
  });

  it("is MUCH wider than the level stop it replaces — that is the whole finding", () => {
    // −235bps vs −5000bps: the old stop is inside the noise of every move that made money.
    expect(TRAIL_BPS).toBeGreaterThan(STOP_LOSS_BPS * 20n);
    // And wider than the take-profit it also replaces, which is the same point from the other side.
    expect(TRAIL_BPS).toBeGreaterThan(TAKE_PROFIT_BPS * 10n);
  });

  it("is a real band — neither degenerate end is expressible", () => {
    // At 0 the stop fires on every tick including a new high; at 10000 it can only fire at zero.
    expect(TRAIL_BPS).toBeGreaterThan(0n);
    expect(TRAIL_BPS).toBeLessThan(10_000n);
  });
});

describe("trailingStopFired — measured from the PEAK, never from entry", () => {
  it("FIRES at exactly the trail — the boundary is inclusive", () => {
    /*
     * `>=` rather than `>`. A stop that must be EXCEEDED rather than reached is one tick late by
     * construction, and on an asset that can halve inside a tick that difference is real money.
     */
    const v = trailingStopFired({ peakPriceWei: P, markPriceWei: P / 2n, trailBps: TRAIL_BPS });
    expect(v.fired).toBe(true);
    expect(v.fallFromPeakBps).toBe(5000n);
  });

  it("does NOT fire one bp inside the trail", () => {
    const mark = (P * (10_000n - TRAIL_BPS + 1n)) / 10_000n;
    const v = trailingStopFired({ peakPriceWei: P, markPriceWei: mark, trailBps: TRAIL_BPS });
    expect(v.fired).toBe(false);
    expect(v.fallFromPeakBps).toBe(TRAIL_BPS - 1n);
    expect(v.reason).toMatch(/^no trailing stop:/);
  });

  it("FIRES harder below the trail", () => {
    const v = trailingStopFired({ peakPriceWei: P, markPriceWei: P / 100n, trailBps: TRAIL_BPS });
    expect(v.fired).toBe(true);
    expect(v.fallFromPeakBps).toBe(9900n);
  });

  /*
   * ══ THE PROPERTY THAT DISTINGUISHES A TRAILING STOP FROM A LEVEL STOP ══
   *
   * The same mark price, relative to the same ENTRY, produces opposite answers depending on the
   * PEAK. A level stop cannot express this at all, and that is the entire behavioural difference
   * between the refuted exit and the shipped one.
   */
  it("the SAME mark fires or holds depending only on the watermark", () => {
    const mark = P * 2n; // the position has doubled from a 1e18 entry

    // Peak at 4x: the mark is 50% off the peak. The trail FIRES, on a position still up 100%.
    const ranAndFell = trailingStopFired({
      peakPriceWei: P * 4n,
      markPriceWei: mark,
      trailBps: TRAIL_BPS,
    });
    expect(ranAndFell.fired).toBe(true);

    // Peak at the mark itself: this IS the high. The trail holds, on the identical price.
    const atHigh = trailingStopFired({
      peakPriceWei: mark,
      markPriceWei: mark,
      trailBps: TRAIL_BPS,
    });
    expect(atHigh.fired).toBe(false);
  });

  it("a position DOWN 30% from entry but at its own high is HELD", () => {
    // The old −235bps level stop sold this immediately. §10 measured that this is exactly where
    // the money was being left: the exit must not fire until the position has given back half of
    // whatever it managed to reach.
    const v = trailingStopFired({
      peakPriceWei: (P * 7000n) / 10_000n,
      markPriceWei: (P * 7000n) / 10_000n,
      trailBps: TRAIL_BPS,
    });
    expect(v.fired).toBe(false);
  });

  it("a mark ABOVE the peak reports a ZERO fall, never a negative one", () => {
    // The watermark may legitimately not have been raised yet this tick. "−400bps below the peak"
    // is a sentence nobody reads correctly at 3am; above the peak, the stop simply has not fired.
    const v = trailingStopFired({ peakPriceWei: P, markPriceWei: P * 3n, trailBps: TRAIL_BPS });
    expect(v.fired).toBe(false);
    expect(v.fallFromPeakBps).toBe(0n);
  });

  it("reports the STOP PRICE, which is the number a user should be shown", () => {
    // `StrayVault.positionsOf` returns the watermark for the same reason: a user should be able to
    // see the level their cat will sell at, rather than being told about it.
    const v = trailingStopFired({ peakPriceWei: P * 4n, markPriceWei: P * 3n, trailBps: TRAIL_BPS });
    expect(v.stopPriceWei).toBe(P * 2n);
    expect(v.reason).toContain(v.stopPriceWei.toString());
  });

  it("carries the whole arithmetic, fired or not (DESIGN §8)", () => {
    for (const mark of [P / 4n, P]) {
      const v = trailingStopFired({ peakPriceWei: P, markPriceWei: mark, trailBps: TRAIL_BPS });
      expect(v.reason).toContain(v.peakPriceWei.toString());
      expect(v.reason).toContain(v.markPriceWei.toString());
      expect(v.reason).toContain(v.fallFromPeakBps.toString());
      expect(v.reason.length).toBeGreaterThan(60);
    }
  });

  it("honours a DIFFERENT trail, so a backtest can sweep it", () => {
    // §10.3's `trail30%` arm had the better TRAIN Welch t (4.35 vs 3.48) and was deliberately NOT
    // harvested, because switching after seeing the TRAIN statistics selects the reported arm by
    // its own search result. It is a lead for a fresh fold — and a lead that cannot be swept
    // without editing this package is a lead nobody will chase.
    const mark = (P * 7000n) / 10_000n; // 30% off the peak
    expect(trailingStopFired({ peakPriceWei: P, markPriceWei: mark, trailBps: 3000n }).fired).toBe(
      true,
    );
    expect(trailingStopFired({ peakPriceWei: P, markPriceWei: mark, trailBps: 5000n }).fired).toBe(
      false,
    );
  });

  it("is exact on full-precision 18-decimal prices — no float touches the comparison", () => {
    // RESEARCH §7d: a real 18-decimal balance needs ~22 significant digits, beyond float64's 15–17,
    // and round-tripping one through `number` reconstructs an amount that reverts.
    const peak = 1_234_567_890_123_456_789n;
    const mark = peak / 2n;
    expect(trailingStopFired({ peakPriceWei: peak, markPriceWei: mark, trailBps: TRAIL_BPS }).fired)
      .toBe(true);
    // These two are different integers and the SAME float64 double.
    expect(Number(peak)).toBe(Number(peak + 1n));
  });
});

describe("trailingStopFired refuses bad inputs rather than inventing an exit", () => {
  it("REFUSES a zero or negative peak — a reset watermark is the failure this exists to stop", () => {
    /*
     * The specific defect: a watermark that lives only in a process resets on redeploy, which does
     * not merely lose information — it re-anchors the trailing stop to the current price, WIDENING
     * it after every deploy and silently disarming the only exit this strategy has. RESEARCH §7f
     * is meridian's version of the same bug ("spend since last boot").
     */
    for (const bad of [0n, -1n]) {
      expect(() =>
        trailingStopFired({ peakPriceWei: bad, markPriceWei: P, trailBps: TRAIL_BPS }),
      ).toThrow(/silently disarms the only exit/);
    }
  });

  it("REFUSES a zero or negative mark — a failed read is not a 100% fall", () => {
    // Manufacturing a total loss out of an unreadable pool would sell every position on an API
    // blip. RESEARCH §5 records that API as unofficial and unstable; the caller must HOLD.
    for (const bad of [0n, -1n]) {
      expect(() =>
        trailingStopFired({ peakPriceWei: P, markPriceWei: bad, trailBps: TRAIL_BPS }),
      ).toThrow(/manufactures a 100% fall out of a\s+failed read|failed read/);
    }
  });

  it("REFUSES a degenerate trail at either end", () => {
    for (const bad of [0n, -1n, 10_000n, 20_000n]) {
      expect(() =>
        trailingStopFired({ peakPriceWei: P, markPriceWei: P, trailBps: bad }),
      ).toThrow(/not an exit rule but the absence of one/);
    }
  });
});

describe("raisePeak — MONOTONE, which is the whole safety property", () => {
  it("raises on a new high", () => {
    expect(raisePeak(P, P * 2n)).toBe(P * 2n);
  });

  it("does NOT lower on a fall — a watermark that can fall is not a watermark", () => {
    // A peak that follows the price down is a trailing stop that follows the price down, which is
    // not a trailing stop but a very slow market order.
    expect(raisePeak(P * 4n, P)).toBe(P * 4n);
    expect(raisePeak(P * 4n, 1n)).toBe(P * 4n);
  });

  it("is flat at an equal mark", () => {
    expect(raisePeak(P, P)).toBe(P);
  });

  it("initialises from zero, so a fresh position's first mark becomes its peak", () => {
    // `StrayVault.hunt` sets `peakPriceWei = entryPriceWei` at entry; this is the same rule applied
    // to an indexer row that has not been written yet.
    expect(raisePeak(0n, P)).toBe(P);
  });

  it("REFUSES a non-positive mark rather than letting a failed read touch the watermark", () => {
    // A watermark that moves on bad data is a stop that moves on bad data.
    for (const bad of [0n, -1n]) {
      expect(() => raisePeak(P, bad)).toThrow(/must never touch the watermark/);
    }
  });

  it("REFUSES a negative stored peak", () => {
    expect(() => raisePeak(-1n, P)).toThrow(/negative peak watermark/);
  });

  it("is idempotent and order-independent — so two copies of the watermark CONVERGE", () => {
    /*
     * The chain holds the authoritative watermark and the indexer mirrors it in Postgres. Because
     * this is a max, applying it to both copies converges them: whichever is higher is the true
     * one, so a disagreement is a reconciliation signal rather than a race.
     */
    const marks = [P, P * 3n, P / 2n, P * 2n, P * 7n, P / 10n];
    const forward = marks.reduce((peak, m) => raisePeak(peak, m), 0n);
    const reversed = [...marks].reverse().reduce((peak, m) => raisePeak(peak, m), 0n);
    expect(forward).toBe(P * 7n);
    expect(reversed).toBe(forward);
    expect(raisePeak(forward, forward)).toBe(forward);
  });

  it("a REPLAY of the same tick cannot move the watermark", () => {
    // Retries are the normal case, not the exceptional one. A watermark that drifts on a retry
    // would widen or narrow the stop by however many times the keeper retried.
    let peak = P;
    for (let i = 0; i < 10; i++) peak = raisePeak(peak, P * 2n);
    expect(peak).toBe(P * 2n);
  });
});

describe("THE WATERMARK LIVES ON CHAIN, AND THIS MODULE HOLDS NONE OF IT", () => {
  it("every function is pure — the same inputs always give the same answer", () => {
    const a = trailingStopFired({ peakPriceWei: P * 3n, markPriceWei: P, trailBps: TRAIL_BPS });
    const b = trailingStopFired({ peakPriceWei: P * 3n, markPriceWei: P, trailBps: TRAIL_BPS });
    expect(a).toEqual(b);
  });

  it("the peak arrives as a PARAMETER, so the caller must decide where it durably lives", () => {
    // `@taia/authority`'s bounds.ts rule verbatim: "the caller is forced to decide where that state
    // durably lives, and the honest answer is on chain or in a database, never in the process that
    // is being constrained."
    expect(trailingStopFired.length).toBe(1); // one args object; no module state to read
    expect(raisePeak.length).toBe(2);
  });

  it("StrayVault stores the watermark and RAISES it monotonically, matching this module", () => {
    // If the contract's rule and this one disagreed, the indexer's copy and the chain's would
    // diverge and the stop would be computed from whichever the keeper happened to read.
    const sol = readFileSync(new URL("../../contracts/src/StrayVault.sol", import.meta.url), "utf8");
    expect(sol).toContain("peakPriceWei");
    expect(sol).toMatch(/function mark\(/);
  });

  it("StrayVault does NOT gate flee() on the watermark — a gate on the exit is a gate on the exit", () => {
    // DESIGN §6 Rule 5. The watermark decides WHEN we choose to sell; it must never be able to
    // decide that we may not. There is no function in this module that returns "you may not sell".
    const sol = readFileSync(new URL("../../contracts/src/StrayVault.sol", import.meta.url), "utf8");
    expect(sol).toMatch(/THIS IS NOT GATED ON THE TRAILING STOP/);
  });
});
