import { describe, expect, it } from "vitest";
import { EDGE_MULTIPLE, requiredGainBps } from "./bar.js";
import { roundTripCost } from "./cost.js";
import {
  BREAKOUT_SIGMA,
  evaluateEntry,
  isqrt,
  levelsFor,
  LOOKBACK_MINUTES,
  moveBpsBetween,
  type PricePoint,
  SIGMA_1H_BPS,
  STOP_LOSS_BPS,
  TAKE_PROFIT_BPS,
} from "./signal.js";

const MAINNET_GAS_PRICE_WEI = 29_474_000n;
const POSITION_5_USD_WEI = 2_594_300_000_000_000n;
const BASE_PRICE = 1_000_000_000_000_000_000n;

/** A history spanning `spanSeconds` that moves `moveBps` from first to last. */
function history(moveBps: bigint, spanSeconds: number, samples = 13): PricePoint[] {
  const points: PricePoint[] = [];
  for (let i = 0; i < samples; i++) {
    const frac = BigInt(i) / BigInt(samples - 1);
    void frac;
    // Linear in bps across the window, so the endpoints give exactly `moveBps`.
    const bpsHere = (moveBps * BigInt(i)) / BigInt(samples - 1);
    points.push({
      ethPerTokenWei: BASE_PRICE + (BASE_PRICE * bpsHere) / 10_000n,
      atSeconds: 1_700_000_000 + Math.round((i * spanSeconds) / (samples - 1)),
    });
  }
  return points;
}

describe("the horizon is 60 minutes, NOT openhood's 1440", () => {
  it("LOOKBACK_MINUTES is 60", () => {
    expect(LOOKBACK_MINUTES).toBe(60n);
  });

  it("is not openhood's 1440 — the constant it would have been if copied", () => {
    expect(LOOKBACK_MINUTES).not.toBe(1440n);
  });

  /*
   * ══ THE DERIVATION, RE-RUN AS AN ASSERTION ══
   *
   * openhood's method: time for a 1-sigma drift to cover the required gain = (required/sigma_1h)^2
   * hours. On ITS numbers (438bps required, 53bps sigma) that is 68 hours -> 1440min was defensible.
   * On OURS it must land in the minutes-to-hours band DESIGN §6 Rule 6 requires, and the chosen
   * 60 minutes must sit inside it.
   */
  it("openhood's own method, run on OUR measured numbers, gives ~9 hours not 68", () => {
    const cost = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    const requiredBps = requiredGainBps({
      costWei: cost.totalWei,
      positionWei: POSITION_5_USD_WEI,
      multiple: EDGE_MULTIPLE,
    });
    // (required / sigma_1h)^2 hours
    const hours = (requiredBps * requiredBps) / (SIGMA_1H_BPS * SIGMA_1H_BPS);
    expect(hours).toBeGreaterThanOrEqual(7n);
    expect(hours).toBeLessThanOrEqual(11n);
    // openhood's answer was 68 hours. Ours is nowhere near it.
    expect(hours).toBeLessThan(20n);

    // 60 minutes sits UNDER that ceiling and OVER meridian's 15-minute measured failure floor.
    expect(LOOKBACK_MINUTES).toBeLessThanOrEqual(hours * 60n);
    expect(LOOKBACK_MINUTES).toBeGreaterThan(15n);
  });

  it("sigma_1h is derived from the measured 7.7% mean absolute 24h move", () => {
    // 770bps / sqrt(24) = 157.2bps. Asserted so a future edit cannot quietly retune it.
    const derived = (770n * 1000n) / isqrt(24n * 1_000_000n);
    expect(derived).toBeGreaterThanOrEqual(SIGMA_1H_BPS - 2n);
    expect(derived).toBeLessThanOrEqual(SIGMA_1H_BPS + 2n);
  });

  it("our sigma is ~3x openhood's 53bps — the memecoin/RWA difference, made numeric", () => {
    const openhoodSigma1h = 53n;
    expect(SIGMA_1H_BPS / openhoodSigma1h).toBe(2n); // 157/53 = 2.96 -> floor 2
    expect(SIGMA_1H_BPS).toBeGreaterThan(openhoodSigma1h * 2n);
  });
});

describe("the levels, and the 2:1 asymmetry", () => {
  it("take-profit is +3 sigma and the stop is -1.5 sigma", () => {
    expect(TAKE_PROFIT_BPS).toBe(3n * SIGMA_1H_BPS);
    expect(TAKE_PROFIT_BPS).toBe(471n);
    expect(STOP_LOSS_BPS).toBe(235n);
  });

  it("the asymmetry is exactly 2:1 — wins must be bigger than losses to pay the cost term", () => {
    expect(TAKE_PROFIT_BPS / STOP_LOSS_BPS).toBe(2n);
  });

  it("the take-profit is floored against cost so a target that cannot pay is inexpressible", () => {
    const cost = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    const levels = levelsFor({
      positionWei: POSITION_5_USD_WEI,
      roundTripCostWei: cost.totalWei,
      edgeMultiple: EDGE_MULTIPLE,
    });
    // At 1% tax the vol-derived 471bps just wins over the ~464bps cost floor.
    expect(levels.takeProfitBps).toBeGreaterThanOrEqual(
      requiredGainBps({ costWei: cost.totalWei, positionWei: POSITION_5_USD_WEI }),
    );
  });

  it("at a punitive cost the FLOOR dominates and the absurdity is VISIBLE in the number", () => {
    // A 10%-tax token, which eligibility refuses — but if it ever reached here, the target would
    // be ~4000bps rather than a plausible-looking 471bps. Visible wrongness beats silent.
    const dear = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 10,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    const levels = levelsFor({
      positionWei: POSITION_5_USD_WEI,
      roundTripCostWei: dear.totalWei,
      edgeMultiple: EDGE_MULTIPLE,
    });
    expect(levels.takeProfitBps).toBeGreaterThan(TAKE_PROFIT_BPS);
    expect(levels.takeProfitBps).toBeGreaterThan(3000n);
  });

  it("the STOP is never floored by cost — a stop pushed out is a stop that fires later", () => {
    const dear = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 10,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    const levels = levelsFor({
      positionWei: POSITION_5_USD_WEI,
      roundTripCostWei: dear.totalWei,
      edgeMultiple: EDGE_MULTIPLE,
    });
    // Unchanged, however expensive the exit is. DESIGN §6 Rule 5: the cost of leaving is not a
    // reason to stay.
    expect(levels.stopLossBps).toBe(STOP_LOSS_BPS);
  });

  it("refuses a non-positive position", () => {
    expect(() =>
      levelsFor({ positionWei: 0n, roundTripCostWei: 1n, edgeMultiple: 2n }),
    ).toThrow(/non-positive position/);
  });
});

describe("the breakout threshold", () => {
  it("is 2 sigma over the window", () => {
    expect(BREAKOUT_SIGMA).toBe(2n);
  });

  it("at a 60-minute window the threshold is ~314bps", () => {
    const signal = evaluateEntry({
      history: history(0n, 3600),
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(signal.thresholdBps).toBeGreaterThanOrEqual(310n);
    expect(signal.thresholdBps).toBeLessThanOrEqual(318n);
  });

  /*
   * ══ THE ORDERING THAT KEEPS THE BAR BINDING ══
   *
   * The signal threshold (314bps) must sit BELOW the cost bar (~463bps). If it sat above, the bar
   * would never be the thing that refused a trade and would be decoration.
   */
  it("the signal threshold sits BELOW the cost bar, so the BAR is the binding constraint", () => {
    const cost = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    const barBps = requiredGainBps({ costWei: cost.totalWei, positionWei: POSITION_5_USD_WEI });
    const signal = evaluateEntry({
      history: history(0n, 3600),
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(signal.thresholdBps).toBeLessThan(barBps);
  });

  it("fires on a move at or above the threshold", () => {
    const signal = evaluateEntry({
      history: history(400n, 3600),
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(signal.direction).toBe("long");
    expect(signal.moveBps).toBeGreaterThanOrEqual(signal.thresholdBps);
    expect(signal.expectedGainWei).toBeGreaterThan(0n);
  });

  it("does NOT fire on a move below the threshold", () => {
    const signal = evaluateEntry({
      history: history(200n, 3600),
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(signal.direction).toBe("none");
    expect(signal.expectedGainWei).toBe(0n);
    expect(signal.reasoning).toMatch(/no breakout/);
  });

  it("is LONG ONLY — a large DOWNWARD move is refused and says why", () => {
    // This venue has no borrow. A fall is information the strategy structurally cannot act on,
    // and saying so beats silently reporting "no signal" as though nothing happened.
    const signal = evaluateEntry({
      history: history(-900n, 3600),
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(signal.direction).toBe("none");
    expect(signal.moveBps).toBeLessThan(0n);
    expect(signal.reasoning).toMatch(/DOWNWARD/);
    expect(signal.reasoning).toMatch(/no borrow/);
  });
});

describe("the window is measured from the CLOCK, never counted from the samples", () => {
  /*
   * ══ THE OPENHOOD UNITS BUG, MADE IMPOSSIBLE ══
   *
   * Its 12-point window spanning 55 minutes was called "11h" and scaled by sqrt(11) instead of
   * sqrt(0.917) — a 3.5x overstatement that compounded as the series filled, so every hour of
   * operation made a trade LESS likely. Zero trades in a full day.
   *
   * These two histories have the SAME sample count and DIFFERENT spans. If the window were
   * counted from `history.length`, their thresholds would be identical.
   */
  it("two histories with the same SAMPLE COUNT but different SPANS get different thresholds", () => {
    const short = evaluateEntry({
      history: history(0n, 600, 13), // 13 samples over 10 minutes
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    const long = evaluateEntry({
      history: history(0n, 14_400, 13), // 13 samples over 4 hours
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(short.thresholdBps).not.toBe(long.thresholdBps);
    // And the longer window has the HIGHER threshold, because volatility scales with sqrt(t).
    expect(long.thresholdBps).toBeGreaterThan(short.thresholdBps);
  });

  it("two histories with the same SPAN but different SAMPLE COUNTS get the SAME threshold", () => {
    // The converse, and the property that makes the signal survive a change of tick interval.
    const sparse = evaluateEntry({
      history: history(0n, 3600, 3),
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    const dense = evaluateEntry({
      history: history(0n, 3600, 61),
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(sparse.thresholdBps).toBe(dense.thresholdBps);
  });

  it("the threshold scales as sqrt(t): 4x the window is ~2x the threshold", () => {
    const oneHour = evaluateEntry({
      history: history(0n, 3600),
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    const fourHours = evaluateEntry({
      history: history(0n, 14_400),
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    const ratio = (fourHours.thresholdBps * 100n) / oneHour.thresholdBps;
    expect(ratio).toBeGreaterThanOrEqual(195n);
    expect(ratio).toBeLessThanOrEqual(205n);
  });

  it("reports the window in MINUTES alongside the sample count, so a gap is visible", () => {
    const signal = evaluateEntry({
      history: history(0n, 3600, 13),
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(signal.windowMinutes).toBe(60n);
    expect(signal.reasoning).toContain("60min (13 samples)");
  });

  it("refuses a window with no elapsed time rather than inventing a volatility", () => {
    const flat: PricePoint[] = [
      { ethPerTokenWei: BASE_PRICE, atSeconds: 1_700_000_000 },
      { ethPerTokenWei: BASE_PRICE * 2n, atSeconds: 1_700_000_000 },
    ];
    const signal = evaluateEntry({
      history: flat,
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(signal.direction).toBe("none");
    expect(signal.reasoning).toMatch(/units bug this check exists to make impossible/);
  });

  it("refuses a window that runs backwards", () => {
    const reversed: PricePoint[] = [
      { ethPerTokenWei: BASE_PRICE, atSeconds: 1_700_003_600 },
      { ethPerTokenWei: BASE_PRICE * 2n, atSeconds: 1_700_000_000 },
    ];
    expect(
      evaluateEntry({
        history: reversed,
        positionWei: POSITION_5_USD_WEI,
        takeProfitBps: TAKE_PROFIT_BPS,
      }).direction,
    ).toBe("none");
  });
});

describe("degenerate histories produce no signal rather than a guess", () => {
  it("an empty history", () => {
    const s = evaluateEntry({
      history: [],
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(s.direction).toBe("none");
    expect(s.reasoning).toMatch(/not enough to measure a move/);
  });

  it("a single point is a price, not a signal", () => {
    const s = evaluateEntry({
      history: [{ ethPerTokenWei: BASE_PRICE, atSeconds: 1_700_000_000 }],
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(s.direction).toBe("none");
    expect(s.reasoning).toMatch(/a guess with a timestamp/);
  });

  it("a sparse array from a partially-failed API read", () => {
    const sparse = [
      undefined,
      { ethPerTokenWei: BASE_PRICE, atSeconds: 1_700_000_000 },
    ] as unknown as PricePoint[];
    const s = evaluateEntry({
      history: sparse,
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(s.direction).toBe("none");
    expect(s.reasoning).toMatch(/undefined point/);
  });

  it("refuses a move computed from a non-positive price", () => {
    expect(() => moveBpsBetween(0n, BASE_PRICE)).toThrow(/non-positive price/);
    expect(() => moveBpsBetween(-1n, BASE_PRICE)).toThrow(/non-positive price/);
  });

  it("an unreadable first price throws rather than inventing a move", () => {
    const broken: PricePoint[] = [
      { ethPerTokenWei: 0n, atSeconds: 1_700_000_000 },
      { ethPerTokenWei: BASE_PRICE, atSeconds: 1_700_003_600 },
    ];
    expect(() =>
      evaluateEntry({
        history: broken,
        positionWei: POSITION_5_USD_WEI,
        takeProfitBps: TAKE_PROFIT_BPS,
      }),
    ).toThrow(/non-positive price/);
  });
});

describe("integer arithmetic — no floats reach a threshold comparison (RESEARCH §7d)", () => {
  it("moveBpsBetween is exact and signed", () => {
    expect(moveBpsBetween(1000n, 1100n)).toBe(1000n);
    expect(moveBpsBetween(1000n, 900n)).toBe(-1000n);
    expect(moveBpsBetween(1000n, 1000n)).toBe(0n);
  });

  it("survives a full-precision 18-decimal price without losing digits", () => {
    /*
     * 19 significant digits, beyond float64's 15–17. RESEARCH §7d: round-tripping a real
     * 18-decimal balance through `number` reconstructs a wei amount that reverts with
     * TRANSFER_FROM_FAILED (meridian `uniswapV4.ts:283-291`).
     *
     * The float check is the load-bearing part: under float64, `from` and `from + 1n` are the
     * SAME double, so a float implementation cannot distinguish them and returns 0 for a move
     * that integer arithmetic reports exactly. That is asserted below.
     */
    const from = 1_234_567_890_123_456_789n;

    // An exact +10%: constructed by multiplication so the relationship is exact, not typed out.
    const exactly10pc = (from * 11_000n) / 10_000n;
    // Note this lands on 999bps, not 1000: the integer division that BUILT the price truncated,
    // and the function reports what the prices actually are rather than what they were meant to
    // be. That is the correct behaviour — the pool holds the truncated number, not the intent.
    expect(moveBpsBetween(from, exactly10pc)).toBe(999n);

    // A price genuinely 1000bps above, chosen so the division is exact.
    const clean = 1_000_000_000_000_000_000n;
    expect(moveBpsBetween(clean, (clean * 11_000n) / 10_000n)).toBe(1000n);

    /*
     * ══ THE PROOF THAT INTEGER MATH IS DOING WORK ══
     *
     * These two wei amounts are DIFFERENT integers but the SAME float64 double — 19 significant
     * digits does not fit in a double's 53-bit mantissa. Any implementation that passed prices
     * through `number` would be unable to tell them apart at all.
     */
    expect(from).not.toBe(from + 1n);
    expect(Number(from)).toBe(Number(from + 1n));

    // And integer arithmetic resolves a 1bp move on a price of this magnitude exactly, where the
    // float path above has already lost the information needed to see it.
    const oneBpUp = clean + clean / 10_000n;
    expect(moveBpsBetween(clean, oneBpUp)).toBe(1n);
  });

  it("isqrt is exact on perfect squares and floors otherwise", () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(4n)).toBe(2n);
    expect(isqrt(1_000_000n)).toBe(1000n);
    expect(isqrt(8n)).toBe(2n);
    expect(isqrt(10n ** 36n)).toBe(10n ** 18n);
  });

  it("isqrt refuses a negative", () => {
    expect(() => isqrt(-1n)).toThrow(/negative/);
  });
});

describe("purity", () => {
  it("reads no clock — the same history always gives the same signal", () => {
    const h = history(400n, 3600);
    const a = evaluateEntry({
      history: h,
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    const b = evaluateEntry({
      history: h,
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(a).toEqual(b);
  });

  it("expected gain is the take-profit applied to the position, and is labelled an ESTIMATE", () => {
    const s = evaluateEntry({
      history: history(400n, 3600),
      positionWei: POSITION_5_USD_WEI,
      takeProfitBps: TAKE_PROFIT_BPS,
    });
    expect(s.expectedGainWei).toBe((POSITION_5_USD_WEI * TAKE_PROFIT_BPS) / 10_000n);
    expect(s.reasoning).toMatch(/AN ESTIMATE/);
  });
});
