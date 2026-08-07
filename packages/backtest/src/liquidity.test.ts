/**
 * Tests for the round-3 liquidity module.
 *
 * The properties pinned here are the ones whose failure would silently turn a survivorship
 * artifact into a reported edge:
 *
 *  1. `restrictTo` reads the REALISED bars, never a collector field.
 *  2. `resolveCohort` resolves by ADDRESS, so a copycat sharing a symbol cannot be pooled into a
 *     recognisable name's result.
 *  3. `matchedRandom` controls against the SAME token set it is handed.
 *  4. The random arm's cost formula matches `roundTripCost`, so neither arm is advantaged.
 */

import { roundTripCost } from "@strays/hunt";
import { describe as suite, expect, it } from "vitest";
import {
  BANDS,
  NAMED_COHORT,
  activityOf,
  buyAndHold,
  byToken,
  cohort,
  matchedRandom,
  resolveCohort,
  restrictTo,
} from "./liquidity.js";
import { GAS_PRICE_WEI, type Trade } from "./replay.js";
import type { Bar, TokenBars } from "./series.js";

function bar(ts: number, price: bigint, isBuy = true): Bar {
  return { ts, priceWei: price * 10n ** 24n, ethVolumeWei: 10n ** 16n, isBuy, block: ts };
}

function token(
  symbol: string,
  address: string,
  n: number,
  spacingSeconds: number,
  taxPct = 1,
): TokenBars {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) bars.push(bar(1000 + i * spacingSeconds, 100n + BigInt(i)));
  return { address, symbol, taxPct, launchedAt: 1000, bars };
}

suite("activityOf", () => {
  it("computes swaps-per-hour from the realised span, not from any declared field", () => {
    // 121 bars, 30s apart => span 3600s = 1h => 121 swaps/hour.
    const a = activityOf(token("X", "0x1", 121, 30));
    expect(a.swaps).toBe(121);
    expect(a.spanHours).toBeCloseTo(1, 6);
    expect(a.swapsPerHour).toBeCloseTo(121, 6);
  });

  it("scores a zero-span token as 0/hr rather than Infinity", () => {
    // Every bar in the same second. Infinity would pass EVERY frequency floor on the strength of
    // a single block, which is exactly the false positive the floor exists to exclude.
    const t: TokenBars = {
      address: "0x2",
      symbol: "Z",
      taxPct: 1,
      launchedAt: 0,
      bars: [bar(5, 100n), bar(5, 101n), bar(5, 102n)],
    };
    const a = activityOf(t);
    expect(a.spanHours).toBe(0);
    expect(a.swapsPerHour).toBe(0);
    expect(Number.isFinite(a.swapsPerHour)).toBe(true);
  });
});

suite("restrictTo", () => {
  const universe = [
    token("BIG", "0xbig", 3000, 10),
    token("MID", "0xmid", 800, 10),
    token("SMALL", "0xsmall", 20, 10),
  ];

  it("selects on realised swap count", () => {
    expect(restrictTo(universe, { label: "", minSwaps: 1000, minSwapsPerHour: 0 }).map((t) => t.symbol)).toEqual([
      "BIG",
    ]);
    expect(restrictTo(universe, { label: "", minSwaps: 100, minSwapsPerHour: 0 }).map((t) => t.symbol)).toEqual([
      "BIG",
      "MID",
    ]);
  });

  it("selects on sustained frequency independently of count", () => {
    // Both have 600 bars; one is 10s apart (360/hr), the other 3600s apart (1/hr).
    const fast = token("FAST", "0xf", 600, 10);
    const slow = token("SLOW", "0xs", 600, 3600);
    const out = restrictTo([fast, slow], { label: "", minSwaps: 0, minSwapsPerHour: 60 });
    expect(out.map((t) => t.symbol)).toEqual(["FAST"]);
  });

  it("is monotone: a tighter band never admits a token a looser one refused", () => {
    for (let i = 1; i < BANDS.length; i++) {
      const loose = BANDS[0];
      const tight = BANDS[i];
      if (loose === undefined || tight === undefined) continue;
      const tightSet = new Set(restrictTo(universe, tight).map((t) => t.address));
      const looseSet = new Set(restrictTo(universe, loose).map((t) => t.address));
      for (const a of tightSet) expect(looseSet.has(a)).toBe(true);
    }
  });

  it("restricts the FOLD's bars — a token is judged on the data it will be traded on", () => {
    // A token with 3000 bars overall but only 50 in this fold must NOT pass a >=1000 band when
    // the fold is what is passed in. This is what makes the filter free of cross-fold lookahead.
    const foldView = { ...token("BIG", "0xbig", 50, 10) };
    expect(restrictTo([foldView], { label: "", minSwaps: 1000, minSwapsPerHour: 0 })).toHaveLength(0);
  });
});

suite("resolveCohort — the copycat defence", () => {
  it("resolves a symbol to its highest-activity ADDRESS", () => {
    // Three tokens all called CryingCat, as on the real pad.
    const real = token("CryingCat", "0xreal", 5000, 10);
    const fake1 = token("CryingCat", "0xfake1", 400, 10);
    const fake2 = token("cryingcat", "0xfake2", 10, 10);
    const map = resolveCohort([fake1, real, fake2], ["CryingCat"]);
    expect(map.get("CryingCat")).toBe("0xreal");
  });

  it("cohort() then selects ONLY that address, excluding same-symbol impostors", () => {
    const real = token("CryingCat", "0xreal", 5000, 10);
    const fake = token("CryingCat", "0xfake", 400, 10);
    const map = resolveCohort([real, fake], ["CryingCat"]);
    const picked = cohort([real, fake], map);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.address).toBe("0xreal");
  });

  it("omits a name that is absent rather than inventing an entry", () => {
    const map = resolveCohort([token("WINK", "0xw", 10, 10)], ["WINK", "NOTHERE"]);
    expect(map.has("WINK")).toBe(true);
    expect(map.has("NOTHERE")).toBe(false);
  });

  it("the shipped cohort list is the eight names Ibrahim gave", () => {
    expect(NAMED_COHORT).toHaveLength(8);
    expect(NAMED_COHORT).toContain("CryingCat");
    expect(NAMED_COHORT).toContain("CASHBIRD");
  });
});

suite("byToken", () => {
  function trade(address: string, symbol: string, netBps: bigint): Trade {
    return {
      token: address,
      symbol,
      taxPct: 1,
      entryTs: 0,
      exitTs: 1,
      entryPriceWei: 1n,
      exitPriceWei: 1n,
      sizeWei: 1n,
      grossBps: netBps + 218n,
      costBps: 218n,
      netBps,
      exitReason: "take-profit",
      barsHeld: 1,
      scoreBps: 0n,
      volumeBeforeWei: 0n,
      barsBefore: 0,
      heldSeconds: 1,
    };
  }

  it("groups by ADDRESS so two tokens sharing a symbol stay separate", () => {
    const out = byToken([
      trade("0xa", "CryingCat", 100n),
      trade("0xb", "CryingCat", -900n),
      trade("0xa", "CryingCat", 300n),
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((r) => r.address === "0xa");
    const b = out.find((r) => r.address === "0xb");
    expect(a?.trades).toBe(2);
    expect(a?.meanNet).toBe(200);
    expect(b?.trades).toBe(1);
    expect(b?.meanNet).toBe(-900);
  });

  it("reports win rate and additive sum", () => {
    const out = byToken([trade("0xa", "T", 100n), trade("0xa", "T", -300n)]);
    expect(out[0]?.winRate).toBe(0.5);
    expect(out[0]?.sumBps).toBe(-200);
  });
});

suite("matchedRandom", () => {
  const universe = [token("A", "0xa", 400, 60), token("B", "0xb", 400, 60)];

  function signal(n: number, netBps: bigint, barsHeld: number): readonly Trade[] {
    return Array.from({ length: n }, () => ({
      token: "0xa",
      symbol: "A",
      taxPct: 1,
      entryTs: 0,
      exitTs: 1,
      entryPriceWei: 1n,
      exitPriceWei: 1n,
      sizeWei: 1n,
      grossBps: netBps + 218n,
      costBps: 218n,
      netBps,
      exitReason: "take-profit" as const,
      barsHeld,
      scoreBps: 0n,
      volumeBeforeWei: 0n,
      barsBefore: 0,
      heldSeconds: 60,
    }));
  }

  it("matches the random arm's hold to the signal's REALISED mean barsHeld", () => {
    const ctrl = matchedRandom(universe, signal(10, 100n, 7), {
      stopBps: 235n,
      takeBps: 471n,
      perToken: 4,
      seed: 1,
    });
    expect(ctrl.holdBars).toBe(7);
  });

  it("is deterministic for a fixed seed", () => {
    const opts = { stopBps: 235n, takeBps: 471n, perToken: 4, seed: 5 } as const;
    const a = matchedRandom(universe, signal(5, 0n, 3), opts);
    const b = matchedRandom(universe, signal(5, 0n, 3), opts);
    expect(a.mean).toBe(b.mean);
    expect(a.t).toBe(b.t);
  });

  it("draws from the universe it is handed, not a wider one", () => {
    const one = matchedRandom([universe[0] as TokenBars], signal(5, 0n, 3), {
      stopBps: 235n,
      takeBps: 471n,
      perToken: 4,
      seed: 5,
    });
    const two = matchedRandom(universe, signal(5, 0n, 3), {
      stopBps: 235n,
      takeBps: 471n,
      perToken: 4,
      seed: 5,
    });
    // Two tokens must yield more draws than one; if the control silently used a global universe
    // these would match and the comparison would be against the wrong population.
    expect(two.n).toBeGreaterThan(one.n);
  });

  it("returns NaN t rather than a fabricated statistic when the signal arm is empty", () => {
    const ctrl = matchedRandom(universe, [], {
      stopBps: 235n,
      takeBps: 471n,
      perToken: 4,
      seed: 5,
    });
    expect(Number.isNaN(ctrl.t)).toBe(true);
    expect(ctrl.holdBars).toBe(0);
  });

  it("charges the random arm the same round trip the replay charges the signal arm", () => {
    // The control subtracts `2 * taxPct * 100 + 32`. At the replay's position size that must
    // equal `roundTripCost`, or one arm is being handicapped and the Welch t is meaningless.
    const positionWei = 2_000_000_000_000_000n;
    for (const taxPct of [1, 3, 5]) {
      const actual = roundTripCost({
        positionWei,
        taxPct,
        gasPriceWei: GAS_PRICE_WEI,
        approvalsNeeded: false,
      });
      const formula = 2 * taxPct * 100 + 32;
      // Within 10bps of the real gas component — the formula's 32 is the measured gas leg.
      expect(Math.abs(Number(actual.totalBps) - formula)).toBeLessThanOrEqual(10);
    }
  });
});

suite("buyAndHold — the survivorship yardstick", () => {
  it("measures first bar to last, net of the round trip", () => {
    const t: TokenBars = {
      address: "0x1",
      symbol: "T",
      taxPct: 1,
      launchedAt: 0,
      bars: [bar(0, 100n), bar(10, 200n)],
    };
    // 100 -> 200 is +10000bps, less 232bps of round trip.
    const bh = buyAndHold([t]);
    expect(bh.mean).toBeCloseTo(10_000 - 232, 0);
    expect(bh.upFraction).toBe(1);
  });

  it("reports the fraction that ended UP, which is the bias being measured", () => {
    const up: TokenBars = {
      address: "0x1",
      symbol: "U",
      taxPct: 1,
      launchedAt: 0,
      bars: [bar(0, 100n), bar(10, 200n)],
    };
    const down: TokenBars = {
      address: "0x2",
      symbol: "D",
      taxPct: 1,
      launchedAt: 0,
      bars: [bar(0, 200n), bar(10, 100n)],
    };
    expect(buyAndHold([up, down]).upFraction).toBe(0.5);
  });
});
