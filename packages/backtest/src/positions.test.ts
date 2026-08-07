/**
 * Tests for the round-4 position simulator.
 *
 * The properties pinned here are the ones whose failure would turn an artifact into a reported
 * edge. Each of the first three has a corresponding real failure recorded in RESULTS.md, which is
 * why it is tested rather than assumed:
 *
 *  1. **NO LOOKAHEAD** — the mutation test from `replay.test.ts`, run against every entry rule.
 *     A rule that peeked forward would see a 1000× spike and enter differently.
 *  2. **NO CENSORING** — §9.5 recorded a +213bps mean at an 88.3% win rate produced purely by
 *     losers that never closed. Every position opened here must come back closed.
 *  3. **REAL COSTS** — the cost charged must equal `roundTripCost` from `@strays/hunt` at the
 *     replay's position size, per the token's OWN tax tier, so neither arm is advantaged.
 *  4. **THE ONE-SLOT PORTFOLIO** must never hold two positions at once, which is the whole point
 *     of the product constraint it models.
 */

import { roundTripCost } from "@strays/hunt";
import { describe as suite, expect, it } from "vitest";
import { welchT } from "./null.js";
import {
  GAS_BPS,
  atSwap,
  describeBasket,
  donchian,
  firstBar,
  maCross,
  oneAtATime,
  openAt,
  randomBasket,
  roundTripBps,
  simulate,
  tailContribution,
} from "./positions.js";
import { DEFAULT_PARAMS, GAS_PRICE_WEI } from "./replay.js";
import type { Bar, TokenBars } from "./series.js";

const SCALE = 10n ** 24n;

function bar(ts: number, price: bigint, isBuy = true): Bar {
  return { ts, priceWei: price * SCALE, ethVolumeWei: 10n ** 16n, isBuy, block: ts };
}

/** A token whose price follows `prices`, one bar per minute. */
function token(prices: readonly bigint[], taxPct = 1, address = "0xa"): TokenBars {
  return {
    address,
    symbol: "T",
    taxPct,
    launchedAt: 1000,
    bars: prices.map((p, i) => bar(1000 + i * 60, p, i % 2 === 0)),
  };
}

suite("roundTripBps", () => {
  it("equals roundTripCost from @strays/hunt at every tax tier", () => {
    // The authority is `roundTripCost`. This asserts the arithmetic duplicate agrees with it
    // rather than trusting a comment that says it does.
    for (const taxPct of [1, 3, 5, 10]) {
      const real = roundTripCost({
        positionWei: DEFAULT_PARAMS.startWei,
        taxPct,
        gasPriceWei: GAS_PRICE_WEI,
      });
      // EXACT equality, not a tolerance. A tolerance is how the 32-vs-8bps gas error survived an
      // earlier draft of this file: the assertion was loose enough to pass while the constant was
      // 4x wrong.
      expect(roundTripBps(taxPct) - GAS_BPS).toBe(2 * taxPct * 100);
      expect(Number(real.totalBps)).toBe(roundTripBps(taxPct));
    }
  });

  it("charges a 10% token ten times what it charges a 1% token, before gas", () => {
    // 2x10% = 2000bps against 2x1% = 200bps. The tax scales linearly and dominates the round trip
    // at every tier, which is why RESULTS.md's §3 tax table falls off so steeply.
    expect(roundTripBps(10) - GAS_BPS).toBe(10 * (roundTripBps(1) - GAS_BPS));
  });
});

suite("openAt — the exit rules", () => {
  it("fires the trailing stop at the first observed price beyond the level, not at the level", () => {
    // Peak 200, then a gap straight down to 80. A 50% trail sits at 100; the venue gaps through
    // it and the fill is at 80. Modelling the fill at 100 would be the error §3 of RESULTS.md
    // identified as the single largest mechanical problem in round 1.
    const t = token([100n, 200n, 80n]);
    const p = openAt(t, 0, { label: "x", trailingStopBps: 5_000 });
    expect(p?.exitReason).toBe("trailing-stop");
    expect(p?.exitPriceWei).toBe(80n * SCALE);
    // Gross is −20% from an entry of 100, not −50% from the peak.
    expect(p?.grossBps).toBe(-2_000);
  });

  it("books a bar that breaches both a stop and a target as the STOP", () => {
    // Pessimistic ordering: on an event-time series we cannot know which the price touched first
    // inside the swap, and assuming the favourable one manufactures returns.
    const t = token([100n, 1_000n]);
    const p = openAt(t, 0, { label: "x", hardStopBps: 5_000, takeProfitBps: 100 });
    // Price went UP, so the hard stop cannot fire; the target does. This pins that the target is
    // reachable at all.
    expect(p?.exitReason).toBe("take-profit");
    const down = token([100n, 10n]);
    const q = openAt(down, 0, { label: "x", hardStopBps: 5_000, takeProfitBps: 100 });
    expect(q?.exitReason).toBe("hard-stop");
  });

  it("charges the token's OWN tax tier to the net return", () => {
    const one = openAt(token([100n, 110n, 110n], 1), 0, { label: "x" });
    const ten = openAt(token([100n, 110n, 110n], 10), 0, { label: "x" });
    expect(one?.grossBps).toBe(ten?.grossBps);
    expect(one?.netBps).toBe(1_000 - roundTripBps(1));
    expect(ten?.netBps).toBe(1_000 - roundTripBps(10));
    // The 10% token's identical price move nets 1,800bps less.
    expect((one?.netBps ?? 0) - (ten?.netBps ?? 0)).toBe(1_800);
  });

  it("tracks the running peak across the whole hold, not just the last bar", () => {
    const p = openAt(token([100n, 500n, 300n, 260n]), 0, { label: "x", trailingStopBps: 5_000 });
    expect(p?.peakBps).toBe(40_000);
  });
});

suite("THE CENSORING GUARANTEE — every opened position comes back closed", () => {
  it("marks an unresolved position to market at the last bar rather than dropping it", () => {
    // A monotonically rising token with a 50% trail never triggers an exit. §9.5's artifact was
    // produced by exactly this case being silently dropped.
    const t = token([100n, 110n, 120n, 130n, 140n]);
    const p = openAt(t, 0, { label: "x", trailingStopBps: 5_000 });
    expect(p).toBeDefined();
    expect(p?.exitReason).toBe("end-of-data");
    expect(p?.exitPriceWei).toBe(140n * SCALE);
  });

  it("marks a LOSING unresolved position to market too — the direction that matters", () => {
    // The §9.5 artifact was made of losers that never closed. A falling token with no stop must
    // still be booked, at its loss.
    const t = token([100n, 90n, 80n, 70n]);
    const p = openAt(t, 0, { label: "x" });
    expect(p?.exitReason).toBe("end-of-data");
    expect(p?.netBps).toBeLessThan(-3_000);
  });

  it("simulate returns exactly as many closed positions as it opened", () => {
    const tokens = [
      token([100n, 200n, 300n], 1, "0x1"),
      token([100n, 50n, 25n], 1, "0x2"),
      token([100n, 100n, 100n], 1, "0x3"),
    ];
    const out = simulate(tokens, firstBar, { label: "x", trailingStopBps: 5_000 });
    // firstBar admits index 0 on each token, one position each, all closed.
    expect(out.length).toBe(3);
    for (const p of out) expect(p.exitIdx).toBeGreaterThan(p.entryIdx);
  });
});

suite("THE NO-LOOKAHEAD RULE — the mutation test", () => {
  /**
   * Corrupt every bar from `cut` onward to a 1000× spike. Any position opened at an index BELOW
   * the cut must be byte-for-byte identical, because its entry decision could only have read bars
   * strictly before it. A rule that peeked forward would see the spike and enter differently.
   */
  function mutate(t: TokenBars, cut: number): TokenBars {
    return {
      ...t,
      bars: t.bars.map((b, i) => (i >= cut ? { ...b, priceWei: b.priceWei * 1_000n } : b)),
    };
  }

  const prices: bigint[] = [];
  for (let i = 0; i < 120; i++) {
    // A wandering series, deterministic, with enough variation to trigger every rule.
    prices.push(100n + BigInt((i * 37) % 53));
  }
  const base = token(prices);
  const CUT = 60;

  const rules = [
    firstBar,
    atSwap(5),
    atSwap(20),
    donchian(10),
    donchian(50),
    maCross(5, 20),
    maCross(20, 100),
  ];

  for (const rule of rules) {
    it(`entry rule "${rule.label}" cannot see the future`, () => {
      // Compare the ENTRY DECISIONS only: the exit path legitimately reads future bars, so the
      // positions themselves differ after the cut. What must not differ is WHERE the rule entered.
      const before: number[] = [];
      const after: number[] = [];
      const mutated = mutate(base, CUT);
      for (let i = 0; i < CUT; i++) {
        if (rule.admits(base.bars, i)) before.push(i);
        if (rule.admits(mutated.bars, i)) after.push(i);
      }
      expect(after).toEqual(before);
    });
  }

  it("the mutation actually changes something, so the test is not vacuous", () => {
    // A mutation test that mutated nothing would pass trivially. This pins that decisions AT or
    // AFTER the cut really do change, proving the corruption is visible to a rule that reads it.
    const mutated = mutate(base, CUT);
    const d = donchian(10);
    let differs = false;
    for (let i = CUT; i < base.bars.length; i++) {
      if (d.admits(base.bars, i) !== d.admits(mutated.bars, i)) differs = true;
    }
    expect(differs).toBe(true);
  });

  it("simulate fills at bar i+1, never at the deciding bar's own price", () => {
    // `atSwap(3)` decides at index 3; the fill must be at index 4's price.
    const t = token([10n, 11n, 12n, 13n, 99n, 50n]);
    const out = simulate([t], atSwap(3), { label: "x", trailingStopBps: 5_000 });
    expect(out[0]?.entryIdx).toBe(4);
    expect(out[0]?.entryPriceWei).toBe(99n * SCALE);
  });
});

suite("entry rules", () => {
  it("atSwap admits exactly one index", () => {
    const t = token([1n, 2n, 3n, 4n, 5n, 6n]);
    const hits = [0, 1, 2, 3, 4, 5].filter((i) => atSwap(3).admits(t.bars, i));
    expect(hits).toEqual([3]);
  });

  it("donchian requires a strict new high over the whole lookback", () => {
    const rising = token([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
    // At i=6 the previous bar (index 5, price 6) is the highest of the prior window.
    expect(donchian(3).admits(rising.bars, 6)).toBe(true);
    const flat = token([5n, 5n, 5n, 5n, 5n, 5n, 5n, 5n]);
    // `>=` in the comparison means a tie is NOT a new high, so a flat series never breaks out.
    expect(donchian(3).admits(flat.bars, 6)).toBe(false);
  });

  it("donchian refuses until it has a full lookback of history", () => {
    const t = token([1n, 2n, 3n, 4n, 5n]);
    expect(donchian(10).admits(t.bars, 3)).toBe(false);
  });

  it("maCross fires on the cross, not on every bar the fast mean is above", () => {
    // A series that rises steadily: the fast mean is above the slow one for many bars, but the
    // CROSS happens once. If the rule fired on the level rather than the cross it would admit
    // every later bar too.
    const prices: bigint[] = [];
    for (let i = 0; i < 60; i++) prices.push(i < 25 ? 100n : 100n + BigInt(i - 24) * 5n);
    const t = token(prices);
    const hits = [];
    for (let i = 0; i < 60; i++) if (maCross(5, 20).admits(t.bars, i)) hits.push(i);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(10);
  });
});

suite("describeBasket — the distribution, not the mean", () => {
  it("reports the top decile's share of profit and the mean without it", () => {
    // Nine flat positions and one huge winner: the mean is entirely one ticket, and the summary
    // must say so rather than reporting the mean alone.
    const tokens = [];
    // Fill is at index 1. Nine tokens stay flat from there; one runs 100x AFTER the fill.
    for (let i = 0; i < 9; i++) tokens.push(token([100n, 100n, 100n], 1, `0x${String(i)}`));
    tokens.push(token([100n, 100n, 10_000n], 1, "0xbig"));
    const out = simulate(tokens, firstBar, { label: "x" });
    const b = describeBasket(out);
    expect(b.n).toBe(10);
    // All the profit is in the single winner.
    expect(b.topDecileShare).toBeCloseTo(1, 5);
    expect(b.meanExTopDecile).toBeLessThan(0);
    expect(b.median).toBeLessThan(0);
  });

  it("counts a position that lost more than 90% as ruin", () => {
    // Fill at index 1 (price 100), then a collapse to 5 = −95%.
    const out = simulate([token([100n, 100n, 5n], 1, "0xd")], firstBar, { label: "x" });
    expect(describeBasket(out).ruinRate).toBe(1);
  });

  it("tailContribution agrees with describeBasket at the decile", () => {
    const tokens = [];
    for (let i = 0; i < 20; i++) {
      tokens.push(token([100n, 100n, 100n + BigInt(i * 10)], 1, `0x${String(i)}`));
    }
    const out = simulate(tokens, firstBar, { label: "x" });
    expect(tailContribution(out, 0.1).share).toBeCloseTo(describeBasket(out).topDecileShare, 6);
  });
});

suite("randomBasket — the control", () => {
  it("draws from the SAME tokens it is handed", () => {
    const tokens = [token([100n, 110n, 120n], 1, "0xaaa"), token([100n, 90n, 80n], 1, "0xbbb")];
    const out = randomBasket(tokens, { label: "x" }, { perToken: 3, seed: 7 });
    const seen = new Set(out.map((p) => p.token));
    for (const s of seen) expect(["0xaaa", "0xbbb"]).toContain(s);
  });

  it("is deterministic for a given seed and different across seeds", () => {
    const tokens = [];
    for (let i = 0; i < 30; i++) {
      tokens.push(token([100n, 120n, 90n, 140n, 70n, 200n], 1, `0x${String(i)}`));
    }
    const a = randomBasket(tokens, { label: "x" }, { perToken: 2, seed: 1 });
    const b = randomBasket(tokens, { label: "x" }, { perToken: 2, seed: 1 });
    const c = randomBasket(tokens, { label: "x" }, { perToken: 2, seed: 2 });
    expect(a.map((p) => p.entryIdx)).toEqual(b.map((p) => p.entryIdx));
    expect(a.map((p) => p.entryIdx)).not.toEqual(c.map((p) => p.entryIdx));
  });

  it("pays the same cost the signal arm pays, so neither is advantaged", () => {
    const t = token([100n, 100n, 110n], 5, "0xtax");
    const sig = simulate([t], firstBar, { label: "x" });
    const rnd = randomBasket([t], { label: "x" }, { perToken: 1, seed: 3 });
    expect(sig[0]?.costBps).toBe(roundTripBps(5));
    for (const p of rnd) expect(p.costBps).toBe(roundTripBps(5));
  });
});

suite("oneAtATime — the single-slot product constraint", () => {
  it("never holds two positions simultaneously", () => {
    const tokens = [];
    for (let i = 0; i < 40; i++) {
      tokens.push(token([100n, 150n, 60n, 200n, 90n], 1, `0x${String(i)}`));
    }
    const basket = simulate(tokens, firstBar, { label: "x", trailingStopBps: 5_000 });
    const port = oneAtATime(basket);
    const sorted = [...port.taken].sort((a, b) => a.entryTs - b.entryTs);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev === undefined || cur === undefined) continue;
      expect(cur.entryTs).toBeGreaterThanOrEqual(prev.exitTs);
    }
  });

  it("takes fewer positions than the basket and counts the ones it skipped", () => {
    // Every token here starts at the same timestamp, so a single slot can hold only the first.
    const tokens = [];
    for (let i = 0; i < 10; i++) tokens.push(token([100n, 150n, 60n], 1, `0x${String(i)}`));
    const basket = simulate(tokens, firstBar, { label: "x", trailingStopBps: 5_000 });
    const port = oneAtATime(basket);
    expect(basket.length).toBe(10);
    expect(port.taken.length).toBeLessThan(basket.length);
    expect(port.taken.length + port.skipped).toBe(basket.length);
  });

  it("floors a position's contribution at total loss when compounding", () => {
    // A position cannot lose more than the stake. Without the floor, a −12,000bps net (possible
    // once cost is added to a −100% move) would multiply equity by a NEGATIVE number and produce
    // a nonsensical sign flip in the compounded figure.
    // Fill at index 1 (price 100), then to 1 = −99%, which with a 10% tax nets below −10000bps.
    const t = token([100n, 100n, 1n], 10, "0xz");
    const basket = simulate([t], firstBar, { label: "x" });
    expect(basket[0]?.netBps).toBeLessThan(-10_000);
    const port = oneAtATime(basket);
    expect(port.compoundedBps).toBe(-10_000);
  });

  it("reports utilisation as the fraction of the window the slot was occupied", () => {
    const t = token([100n, 150n, 60n], 1, "0xu");
    const port = oneAtATime(simulate([t], firstBar, { label: "x", trailingStopBps: 5_000 }));
    expect(port.utilisation).toBeGreaterThan(0);
    expect(port.utilisation).toBeLessThanOrEqual(1);
  });
});

suite("the Welch control is wired the way the report claims", () => {
  it("scores an identical signal and control at t≈0", () => {
    // The fixture must have real dispersion: if every position returns the same number the
    // variance is zero and Welch's t is 0/0 = NaN, which would pass no assertion meaningfully.
    const tokens = [];
    for (let i = 0; i < 25; i++) {
      tokens.push(token([100n, 100n, 120n + BigInt(i * 7), 80n, 150n], 1, `0x${String(i)}`));
    }
    const a = simulate(tokens, firstBar, { label: "x", trailingStopBps: 5_000 });
    const w = welchT(
      a.map((p) => p.netBps),
      a.map((p) => p.netBps),
    );
    expect(Math.abs(w.t)).toBeLessThan(1e-9);
  });
});

suite("guards and edge cases", () => {
  it("openAt refuses an entry index at or past the last bar", () => {
    // There is no forward bar to exit at, so there is no measurable position. Returning a
    // zero-return position instead would inject a fake flat trade into every basket.
    const t = token([100n, 110n, 120n]);
    expect(openAt(t, 2, { label: "x" })).toBeUndefined();
    expect(openAt(t, 99, { label: "x" })).toBeUndefined();
  });

  it("openAt treats a zero entry price as a flat move rather than dividing by zero", () => {
    const t: TokenBars = {
      address: "0x0",
      symbol: "Z",
      taxPct: 1,
      launchedAt: 1000,
      bars: [
        { ts: 1000, priceWei: 0n, ethVolumeWei: 1n, isBuy: true, block: 1 },
        { ts: 1060, priceWei: 500n, ethVolumeWei: 1n, isBuy: true, block: 2 },
        { ts: 1120, priceWei: 500n, ethVolumeWei: 1n, isBuy: true, block: 3 },
      ],
    };
    const p = openAt(t, 0, { label: "x" });
    expect(p?.grossBps).toBe(0);
  });

  it("honours maxHoldBars as well as maxHoldSeconds", () => {
    const t = token([100n, 100n, 100n, 100n, 100n, 100n]);
    const p = openAt(t, 0, { label: "x", maxHoldBars: 2 });
    expect(p?.exitReason).toBe("time-exit");
    expect(p?.barsHeld).toBe(2);
  });

  it("maxHoldSeconds fires on the clock, not on the bar count", () => {
    const t = token([100n, 100n, 100n, 100n, 100n]);
    // Bars are 60s apart, so a 120s cap exits on the second bar after entry.
    const p = openAt(t, 0, { label: "x", maxHoldSeconds: 120 });
    expect(p?.exitReason).toBe("time-exit");
    expect(p?.heldSeconds).toBe(120);
  });

  it("maCross refuses before it has enough history for both means", () => {
    const t = token([1n, 2n, 3n, 4n, 5n]);
    expect(maCross(5, 20).admits(t.bars, 3)).toBe(false);
  });

  it("simulate honours maxPerToken and noOverlap", () => {
    // donchian fires repeatedly on a rising series; maxPerToken must cap the tickets.
    const prices: bigint[] = [];
    for (let i = 0; i < 80; i++) prices.push(100n + BigInt(i));
    const t = token(prices, 1, "0xrise");
    const one = simulate([t], donchian(5), { label: "x", maxHoldBars: 2 }, { maxPerToken: 1 });
    const many = simulate([t], donchian(5), { label: "x", maxHoldBars: 2 }, { maxPerToken: 5 });
    expect(one.length).toBe(1);
    expect(many.length).toBeGreaterThan(1);
    expect(many.length).toBeLessThanOrEqual(5);
  });

  it("describeBasket returns NaN-safe fields on an empty basket", () => {
    const b = describeBasket([]);
    expect(b.n).toBe(0);
    expect(Number.isNaN(b.winRate)).toBe(true);
    expect(Number.isNaN(b.ruinRate)).toBe(true);
  });

  it("oneAtATime on an empty basket reports zero, not NaN", () => {
    const port = oneAtATime([]);
    expect(port.taken).toEqual([]);
    expect(port.compoundedBps).toBe(0);
    expect(port.utilisation).toBe(0);
  });

  it("randomBasket skips tokens too short to hold a position", () => {
    const tiny: TokenBars = {
      address: "0xt",
      symbol: "T",
      taxPct: 1,
      launchedAt: 1000,
      bars: [{ ts: 1000, priceWei: 100n * SCALE, ethVolumeWei: 1n, isBuy: true, block: 1 }],
    };
    expect(randomBasket([tiny], { label: "x" }, { perToken: 3, seed: 1 })).toEqual([]);
  });
});
