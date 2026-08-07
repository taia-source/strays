import { describe, expect, it } from "vitest";
import {
  exitCostWei,
  GAS_BUY_UNITS,
  GAS_ERC20_APPROVE_UNITS,
  GAS_PERMIT2_APPROVE_UNITS,
  GAS_SELL_UNITS,
  roundTripCost,
  sellGasUnits,
} from "./cost.js";

/**
 * The measured environment from RESEARCH.md, so every assertion below is against a real reading:
 *
 *   ETH            $1927.27          (/api/config -> ethUsd)
 *   gas price      0.029474 gwei     (probe/simbuy.mjs, MAINNET, not the fork)
 *   position       $5 = 0.0025943 ETH
 *   round trips    1% 231.4bps  3% 624.2bps  5% 1007.6bps  10% 1938.3bps
 */
const MAINNET_GAS_PRICE_WEI = 29_474_000n;
const POSITION_5_USD_WEI = 2_594_300_000_000_000n;

/** anvil's default base fee, ~35x the chain's. The number openhood shipped a strategy against. */
const ANVIL_GAS_PRICE_WEI = 1_019_000_000n;

describe("roundTripCost — the measured economics", () => {
  it("reproduces the MEASURED 231.4bps round trip on a 1%-tax token at $5", () => {
    const cost = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    // RESEARCH §3b measured 231.4bps for CatDay. Tax is 2 x 100bps = 200bps and gas ~32bps.
    expect(cost.totalBps).toBeGreaterThanOrEqual(228n);
    expect(cost.totalBps).toBeLessThanOrEqual(235n);
  });

  /**
   * ══ A DIVERGENCE THIS TEST FOUND, RECORDED RATHER THAN TUNED AWAY ══
   *
   * The model charges exactly `2 x tax`. RESEARCH §3b's measured SWAP costs were:
   *
   *   tier   measured swap   2 x tax   model error
   *    1%      199.0 bps      200 bps   +1.0 bps   <- the only tier we trade
   *    3%      591.0 bps      600 bps   +9.0 bps
   *    5%      975.0 bps     1000 bps  +25.0 bps
   *   10%     1900.0 bps     2000 bps +100.0 bps
   *
   * RESEARCH §3b says measured cost is "2 x tax to within 1 bps at every tier". That is exactly
   * true at 1% and increasingly generous above it — the measurement diverges upward from the
   * model as tax rises, because a larger tax removes more of the input before it reaches the
   * pool, so the second leg is charged on a smaller notional than the entry.
   *
   * We do NOT correct for this, for two reasons. First, the correction only matters on tiers
   * `eligible.ts` refuses outright, so it would be modelling trades we will never make. Second,
   * the error is CONSERVATIVE — the model over-states cost, which under-trades rather than
   * over-trades. An error in the direction of refusing marginal trades is the safe one to carry.
   *
   * The bounds below are therefore the MODEL's values, with the measured values recorded beside
   * them, rather than bounds fudged until the model appeared to match a measurement it does not.
   */
  it("reproduces the measured cost at all four tax tiers, in order", () => {
    const expected: ReadonlyArray<readonly [number, bigint, bigint]> = [
      // [taxPct, lo, hi] — measured totals were 231.4 / 624.2 / 1007.6 / 1938.3 bps
      [1, 230n, 234n], // measured 231.4 — the model is exact here, within 1bp
      [3, 630n, 634n], // measured 624.2 — model +8bps conservative
      [5, 1030n, 1034n], // measured 1007.6 — model +24bps conservative
      [10, 2030n, 2034n], // measured 1938.3 — model +94bps conservative
    ];
    const seen: bigint[] = [];
    for (const [taxPct, lo, hi] of expected) {
      const cost = roundTripCost({
        positionWei: POSITION_5_USD_WEI,
        taxPct,
        gasPriceWei: MAINNET_GAS_PRICE_WEI,
      });
      expect(cost.totalBps, `taxPct ${String(taxPct)}`).toBeGreaterThanOrEqual(lo);
      expect(cost.totalBps, `taxPct ${String(taxPct)}`).toBeLessThanOrEqual(hi);
      seen.push(cost.totalBps);
    }
    // Strictly increasing in tax. If tax were charged on only one leg this ordering would hold
    // but every magnitude above would fail, which is why both are asserted.
    expect(seen).toEqual([...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("charges the tax on BOTH legs — a one-leg model understates cost by half", () => {
    const cost = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    expect(cost.entryTaxWei).toBe(cost.exitTaxWei);
    expect(cost.entryTaxWei).toBeGreaterThan(0n);
    // 2 x 100bps of the position, exactly. RESEARCH §3b measured 2 x tax to within 1bps.
    expect(cost.entryTaxWei + cost.exitTaxWei).toBe((POSITION_5_USD_WEI * 200n) / 10_000n);
  });

  it("carries NO pool-fee term — RESEARCH §2 proved the PoolKey has fee = 0", () => {
    // The whole cost at 1% must be accounted for by tax + gas with nothing left over. If a
    // 5bps/30bps pool-fee term were ported from openhood, this residual would be non-zero.
    const cost = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    const residual =
      cost.totalWei - (cost.entryTaxWei + cost.exitTaxWei + cost.entryGasWei + cost.exitGasWei);
    expect(residual).toBe(0n);
  });

  it("gas is ~32bps of a $5 position, matching the measured ~$0.016 flat cost", () => {
    const cost = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    const gasBps = ((cost.entryGasWei + cost.exitGasWei) * 10_000n) / POSITION_5_USD_WEI;
    // RESEARCH §3b: 32.5bps at 1%. Allow a bp either side of the rounding.
    expect(gasBps).toBeGreaterThanOrEqual(31n);
    expect(gasBps).toBeLessThanOrEqual(34n);
  });

  it("cost is FLAT in bps across the size range — NOT openhood's U-curve (§3c Rule 2)", () => {
    const sizes = [POSITION_5_USD_WEI, POSITION_5_USD_WEI * 10n, POSITION_5_USD_WEI * 100n];
    const bps = sizes.map(
      (positionWei) =>
        roundTripCost({ positionWei, taxPct: 1, gasPriceWei: MAINNET_GAS_PRICE_WEI }).totalBps,
    );
    // Every size sits within a few bps of 200 (the tax) — gas is the only size-varying term and
    // it is tiny. openhood's model spanned 166bps -> 18bps -> 82bps over this range.
    for (const b of bps) {
      expect(b).toBeGreaterThanOrEqual(200n);
      expect(b).toBeLessThanOrEqual(235n);
    }
    // Monotonically DECREASING (gas share falls), never U-shaped.
    expect(bps[0]).toBeGreaterThan(bps[1] as bigint);
    expect(bps[1]).toBeGreaterThanOrEqual(bps[2] as bigint);
  });
});

describe("roundTripCost — gasPriceWei is REQUIRED and never defaulted (RESEARCH §7a)", () => {
  it("REFUSES a zero gas price rather than defaulting it", () => {
    expect(() =>
      roundTripCost({ positionWei: POSITION_5_USD_WEI, taxPct: 1, gasPriceWei: 0n }),
    ).toThrow(/gasPriceWei is REQUIRED/);
  });

  it("REFUSES a negative gas price", () => {
    expect(() =>
      roundTripCost({ positionWei: POSITION_5_USD_WEI, taxPct: 1, gasPriceWei: -1n }),
    ).toThrow(/gasPriceWei is REQUIRED/);
  });

  it("the refusal names the openhood failure, so a reader learns why rather than that", () => {
    let message = "";
    try {
      roundTripCost({ positionWei: POSITION_5_USD_WEI, taxPct: 1, gasPriceWei: 0n });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/52\.5%/);
    expect(message).toMatch(/anvil/i);
    expect(message).toMatch(/UNITS transfer from a fork; gas PRICES do not/);
  });

  it("an absent gasPriceWei cannot typecheck — proven at runtime by the same guard", () => {
    // TypeScript makes omission a compile error. This asserts the RUNTIME guard also holds, so a
    // JS caller or an `any` at the boundary cannot slip past. Both mechanisms are needed:
    // "when two mechanisms can independently reject the same input, at least one test must
    // construct an input that only ONE of them rejects."
    const args = { positionWei: POSITION_5_USD_WEI, taxPct: 1 } as unknown as Parameters<
      typeof roundTripCost
    >[0];
    expect(() => roundTripCost(args)).toThrow(/gasPriceWei is REQUIRED/);
  });

  it("anvil's gas price produces a VISIBLY absurd cost, not a plausible one", () => {
    // openhood's actual bug, reproduced at OUR position size. At the real mainnet gas price a $5
    // position round-trips for 232bps and is tradeable. At anvil's base fee the SAME position
    // costs over 1300bps — which is 5.7x, and past any bar this strategy could set.
    //
    // openhood's number was 52.5% of a position; ours is smaller because our tax term is larger
    // relative to gas, but the failure mode is identical: a cost derived from a fork's gas price
    // silently forecloses every trade. The point of this test is that the two numbers are far
    // enough apart that no bar can be right for both.
    const anvil = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: ANVIL_GAS_PRICE_WEI,
    });
    const real = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    // The real one is tradeable: 232bps against a measured 770bps typical move.
    expect(real.totalBps).toBeLessThan(300n);
    // The anvil one is not: it exceeds the entire mean absolute 24h move of 770bps, so a
    // position would have to post a better-than-typical day merely to break even.
    expect(anvil.totalBps).toBeGreaterThan(770n);
    expect(anvil.totalBps / real.totalBps).toBeGreaterThanOrEqual(5n);
    // Gas is the ONLY term that differs — the tax is identical — which is what makes this a
    // clean demonstration that the gas PRICE, alone, decides whether the strategy can exist.
    expect(anvil.entryTaxWei + anvil.exitTaxWei).toBe(real.entryTaxWei + real.exitTaxWei);
  });

  it("no gas-price constant exists in the module's exports", () => {
    // A defence against the constant creeping back in. Any exported bigint in the gwei range
    // would be a hardcoded price; the exported gas figures are UNITS, all under 200k.
    for (const units of [
      GAS_BUY_UNITS,
      GAS_SELL_UNITS,
      GAS_ERC20_APPROVE_UNITS,
      GAS_PERMIT2_APPROVE_UNITS,
    ]) {
      expect(units).toBeLessThan(1_000_000n);
      expect(units).toBeGreaterThan(0n);
    }
  });
});

describe("roundTripCost — the measured gas units (RESEARCH §4b)", () => {
  it("uses the fork-measured buy and sell units", () => {
    expect(GAS_BUY_UNITS).toBe(148_750n);
    expect(GAS_SELL_UNITS).toBe(136_349n);
  });

  it("defaults gasUnits to buy + sell", () => {
    const cost = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    expect(cost.gasUnits).toBe(GAS_BUY_UNITS + GAS_SELL_UNITS);
  });

  it("adds the two one-time Permit2 approvals when they are outstanding (§4e)", () => {
    const without = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
      approvalsNeeded: false,
    });
    const with_ = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
      approvalsNeeded: true,
    });
    expect(with_.gasUnits - without.gasUnits).toBe(
      GAS_ERC20_APPROVE_UNITS + GAS_PERMIT2_APPROVE_UNITS,
    );
    expect(with_.totalWei).toBeGreaterThan(without.totalWei);
  });

  it("sellGasUnits reflects the buy/sell approval asymmetry", () => {
    expect(sellGasUnits(false)).toBe(GAS_SELL_UNITS);
    expect(sellGasUnits(true)).toBe(
      GAS_ERC20_APPROVE_UNITS + GAS_PERMIT2_APPROVE_UNITS + GAS_SELL_UNITS,
    );
  });

  it("an explicit gasUnits override is honoured", () => {
    const cost = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
      gasUnits: 300_000n,
    });
    expect(cost.gasUnits).toBe(300_000n);
    expect(cost.entryGasWei + cost.exitGasWei).toBe(300_000n * MAINNET_GAS_PRICE_WEI);
  });
});

describe("roundTripCost — malformed inputs are refused, not absorbed", () => {
  it("refuses a zero position", () => {
    expect(() =>
      roundTripCost({ positionWei: 0n, taxPct: 1, gasPriceWei: MAINNET_GAS_PRICE_WEI }),
    ).toThrow(/non-positive notional/);
  });

  it("refuses a negative position", () => {
    expect(() =>
      roundTripCost({ positionWei: -1n, taxPct: 1, gasPriceWei: MAINNET_GAS_PRICE_WEI }),
    ).toThrow(/non-positive notional/);
  });

  it("refuses a fractional tax — the pad reports integers", () => {
    expect(() =>
      roundTripCost({ positionWei: POSITION_5_USD_WEI, taxPct: 1.5, gasPriceWei: MAINNET_GAS_PRICE_WEI }),
    ).toThrow(/integer percent/);
  });

  it("refuses a negative tax", () => {
    expect(() =>
      roundTripCost({ positionWei: POSITION_5_USD_WEI, taxPct: -1, gasPriceWei: MAINNET_GAS_PRICE_WEI }),
    ).toThrow(/integer percent/);
  });

  it("refuses negative gas units", () => {
    expect(() =>
      roundTripCost({
        positionWei: POSITION_5_USD_WEI,
        taxPct: 1,
        gasPriceWei: MAINNET_GAS_PRICE_WEI,
        gasUnits: -1n,
      }),
    ).toThrow(/negative gas units/);
  });
});

describe("roundTripCost — the arithmetic string is the log line (DESIGN §8)", () => {
  it("carries the numbers, not the conclusion", () => {
    const cost = roundTripCost({
      positionWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    expect(cost.arithmetic).toContain(POSITION_5_USD_WEI.toString());
    expect(cost.arithmetic).toContain(MAINNET_GAS_PRICE_WEI.toString());
    expect(cost.arithmetic).toContain(cost.totalBps.toString());
    expect(cost.arithmetic).toMatch(/TOTAL/);
  });
});

describe("exitCostWei — what it costs to get OUT from here", () => {
  it("counts the exit tax and exit gas only, never the sunk entry", () => {
    const proceeds = POSITION_5_USD_WEI;
    const exit = exitCostWei({ proceedsWei: proceeds, taxPct: 1, gasPriceWei: MAINNET_GAS_PRICE_WEI });
    const rt = roundTripCost({
      positionWei: proceeds,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
    });
    // Strictly less than the round trip — it is one leg, not two.
    expect(exit).toBeLessThan(rt.totalWei);
    expect(exit).toBe(rt.exitTaxWei + rt.exitGasWei);
  });

  it("refuses a non-positive gas price, same rule as roundTripCost", () => {
    expect(() => exitCostWei({ proceedsWei: POSITION_5_USD_WEI, taxPct: 1, gasPriceWei: 0n })).toThrow(
      /non-positive gas price/,
    );
  });

  it("includes approvals when outstanding", () => {
    const a = exitCostWei({
      proceedsWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
      approvalsNeeded: true,
    });
    const b = exitCostWei({
      proceedsWei: POSITION_5_USD_WEI,
      taxPct: 1,
      gasPriceWei: MAINNET_GAS_PRICE_WEI,
      approvalsNeeded: false,
    });
    expect(a).toBeGreaterThan(b);
  });
});
