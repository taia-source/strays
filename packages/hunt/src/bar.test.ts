import { describe, expect, it } from "vitest";
import { clearsBar, EDGE_MULTIPLE, requiredGainBps } from "./bar.js";
import { roundTripCost } from "./cost.js";

const MAINNET_GAS_PRICE_WEI = 29_474_000n;
const POSITION_5_USD_WEI = 2_594_300_000_000_000n;

/** The real, measured cost of a $5 round trip on a 1%-tax token. Everything below uses it. */
const REAL_COST = roundTripCost({
  positionWei: POSITION_5_USD_WEI,
  taxPct: 1,
  gasPriceWei: MAINNET_GAS_PRICE_WEI,
});

/** A move of `bps` on the $5 position, in wei. */
const gainOf = (bps: bigint) => (POSITION_5_USD_WEI * bps) / 10_000n;

describe("EDGE_MULTIPLE — derived, and it sits where the derivation says", () => {
  it("is 2", () => {
    expect(EDGE_MULTIPLE).toBe(2n);
  });

  /*
   * ══ THE PROPERTY THE BRIEF NAMES ══
   *
   * "A bar nothing can clear is indistinguishable from a broken strategy; a bar everything clears
   * is not a bar." Both halves are asserted, because a suite that only proved refusal would pass
   * just as happily against openhood's broken anvil-gas bar, which refused EVERYTHING.
   */
  it("refuses the MEDIAN move and admits the LARGE one — measured against RESEARCH §3d", () => {
    const required = requiredGainBps({
      costWei: REAL_COST.totalWei,
      positionWei: POSITION_5_USD_WEI,
    });

    // RESEARCH §3d: mean absolute 24h move = 7.7% = 770bps. The bar is ~463bps.
    expect(required).toBeGreaterThan(400n);
    expect(required).toBeLessThan(520n);

    // It sits BELOW the typical move — otherwise nothing would ever trade.
    expect(required).toBeLessThan(770n);
    // And ABOVE the round trip it exists to clear — otherwise it is not a bar.
    expect(required).toBeGreaterThan(REAL_COST.totalBps);
  });

  it("the derivation table in the header holds: 1x is noise, 4x is the whole distribution", () => {
    const at = (m: bigint) =>
      requiredGainBps({ costWei: REAL_COST.totalWei, positionWei: POSITION_5_USD_WEI, multiple: m });

    // 1x: cleared by a third of a typical 770bps move. Not a bar.
    expect(at(1n)).toBeLessThan(770n / 2n);
    // 2x: refuses the typical move, admits the large one. ~0.6x the mean absolute move.
    expect(at(2n)).toBeGreaterThan(770n / 2n);
    expect(at(2n)).toBeLessThan(770n);
    // 4x: needs to beat the mean absolute move outright.
    expect(at(4n)).toBeGreaterThan(770n);
    // 8x: past the measured range bar the +38.8% tail.
    expect(at(8n)).toBeGreaterThan(1700n);
  });
});

describe("the bar refuses a move smaller than cost and admits one larger", () => {
  it("REFUSES an expected gain below the round-trip cost", () => {
    // 100bps of gain against a 232bps cost. Not even one round trip, let alone two.
    const verdict = clearsBar({ expectedGainWei: gainOf(100n), costWei: REAL_COST.totalWei });
    expect(verdict.clears).toBe(false);
  });

  it("REFUSES an expected gain that equals cost but not the multiple", () => {
    // Exactly the cost. Breaks even before the multiple, and the multiple is the whole point:
    // the cost term is KNOWN and the gain term is an ESTIMATE.
    const verdict = clearsBar({ expectedGainWei: REAL_COST.totalWei, costWei: REAL_COST.totalWei });
    expect(verdict.clears).toBe(false);
    expect(verdict.achievedRatioBps).toBe(10_000n); // 1.0x cost
  });

  it("REFUSES one wei below the requirement — the boundary is exact", () => {
    const required = REAL_COST.totalWei * EDGE_MULTIPLE;
    expect(clearsBar({ expectedGainWei: required - 1n, costWei: REAL_COST.totalWei }).clears).toBe(
      false,
    );
  });

  it("ADMITS an expected gain exactly at the requirement", () => {
    const required = REAL_COST.totalWei * EDGE_MULTIPLE;
    expect(clearsBar({ expectedGainWei: required, costWei: REAL_COST.totalWei }).clears).toBe(true);
  });

  it("ADMITS a large move — a 770bps mean-absolute day clears comfortably", () => {
    const verdict = clearsBar({ expectedGainWei: gainOf(770n), costWei: REAL_COST.totalWei });
    expect(verdict.clears).toBe(true);
    // ~3.3x cost, which is the signal-to-cost ratio RESEARCH §3d says makes this product possible.
    expect(verdict.achievedRatioBps).toBeGreaterThan(30_000n);
  });

  it("ADMITS a 471bps take-profit — the level signal.ts actually sets", () => {
    // If this failed, the shipped take-profit could never clear the shipped bar and the strategy
    // would be structurally incapable of trading — openhood's exact failure state.
    expect(clearsBar({ expectedGainWei: gainOf(471n), costWei: REAL_COST.totalWei }).clears).toBe(
      true,
    );
  });

  it("the SAME move fails at 10% tax and passes at 1% — the bar tracks the real cost", () => {
    // Not a fixed threshold: the bar is a multiple of a MEASURED cost, so a token whose tax makes
    // it expensive is refused by the bar even if eligibility somehow let it through.
    const gain = gainOf(600n);
    const cheap = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    const dear = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 10,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    expect(clearsBar({ expectedGainWei: gain, costWei: cheap.totalWei }).clears).toBe(true);
    expect(clearsBar({ expectedGainWei: gain, costWei: dear.totalWei }).clears).toBe(false);
  });
});

describe("degenerate inputs cannot fire a trade", () => {
  it("a zero expected gain never clears, even at zero cost", () => {
    // The `0 >= 0` trap. A naive comparison passes here and fires a trade with no expected gain.
    expect(clearsBar({ expectedGainWei: 0n, costWei: 0n }).clears).toBe(false);
  });

  it("a negative expected gain never clears", () => {
    expect(clearsBar({ expectedGainWei: -1n, costWei: 0n }).clears).toBe(false);
    expect(clearsBar({ expectedGainWei: -gainOf(1000n), costWei: REAL_COST.totalWei }).clears).toBe(
      false,
    );
  });

  it("a positive gain at zero cost DOES clear — free trades are allowed to be taken", () => {
    // The zero-gain guard must not be so broad it refuses a genuinely costless winner.
    expect(clearsBar({ expectedGainWei: 1n, costWei: 0n }).clears).toBe(true);
  });

  it("refuses a multiple below 1 — a bar under its own cost is not a bar", () => {
    expect(() =>
      clearsBar({ expectedGainWei: gainOf(500n), costWei: REAL_COST.totalWei, multiple: 0n }),
    ).toThrow(/not a bar at all/);
  });

  it("refuses a negative cost", () => {
    expect(() => clearsBar({ expectedGainWei: 1n, costWei: -1n })).toThrow(/negative round-trip/);
  });

  it("requiredGainBps refuses a non-positive position", () => {
    expect(() => requiredGainBps({ costWei: 1n, positionWei: 0n })).toThrow(/non-positive position/);
  });
});

describe("the arithmetic string — logged on declines as well as fires (DESIGN §8)", () => {
  it("a DECLINE carries the numbers that produced it", () => {
    const verdict = clearsBar({ expectedGainWei: gainOf(100n), costWei: REAL_COST.totalWei });
    expect(verdict.clears).toBe(false);
    expect(verdict.arithmetic).toContain("<");
    expect(verdict.arithmetic).toContain(verdict.requiredWei.toString());
    expect(verdict.arithmetic).toContain(REAL_COST.totalWei.toString());
    expect(verdict.arithmetic).toMatch(/achieved \d+bps of cost, needed 20000bps/);
  });

  it("a FIRE carries them too, with the comparator flipped", () => {
    const verdict = clearsBar({ expectedGainWei: gainOf(770n), costWei: REAL_COST.totalWei });
    expect(verdict.clears).toBe(true);
    expect(verdict.arithmetic).toContain(">=");
  });

  it("achievedRatioBps is 0 at zero cost rather than dividing by zero", () => {
    expect(clearsBar({ expectedGainWei: 5n, costWei: 0n }).achievedRatioBps).toBe(0n);
  });
});
