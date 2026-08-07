/**
 * Tests for the survivorship comparison's own machinery.
 *
 * The kill test's whole claim rests on one structural property: **the survivor-biased corpus and
 * the complete corpus differ in WHICH TOKENS ARE IN THEM and in nothing else.** If the two arms
 * differed in cost model, control construction, or filter order, the measured "bias" would be a
 * mixture of survivorship and whatever else drifted, and the comparison would prove nothing.
 *
 * These tests pin the pieces that could break that property silently.
 */

import { describe as suite, expect, it } from "vitest";
import { withMinSwaps } from "./hold.js";
import { atSwap, describeBasket, simulate } from "./positions.js";
import type { Bar, TokenBars } from "./series.js";
import {
  ARM_HEADER,
  armRow,
  measureAgainstRandom,
  median,
  medianSpanDays,
} from "./survivorship.js";

const SCALE = 10n ** 24n;

function bar(ts: number, price: bigint, isBuy = true): Bar {
  return { ts, priceWei: price * SCALE, ethVolumeWei: 10n ** 16n, isBuy, block: ts };
}

/** A token whose price follows `prices`, one bar per minute. */
function token(prices: readonly bigint[], address: string, taxPct = 1): TokenBars {
  return {
    address,
    symbol: address,
    taxPct,
    launchedAt: 1000,
    bars: prices.map((p, i) => bar(1000 + i * 60, p, i % 2 === 0)),
  };
}

/** A rising-then-falling token long enough to clear a swap-N entry and fire a trailing stop. */
function runner(address: string, peak: bigint, taxPct = 1): TokenBars {
  const prices: bigint[] = [];
  for (let i = 0; i < 60; i++) prices.push(100n + (peak - 100n) * BigInt(i) / 60n);
  for (let i = 0; i < 60; i++) prices.push(peak - (peak - 50n) * BigInt(i) / 60n);
  return token(prices, address, taxPct);
}

suite("median", () => {
  it("returns NaN on an empty sample rather than 0", () => {
    // Returning 0 would silently report "no effect" for "no data", which is the difference
    // between a measured null and an absent measurement.
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it("does not mutate its input", () => {
    // `median` sorts internally. Sorting the caller's array in place would reorder a positions
    // list that the caller still needs in CHRONOLOGICAL order — which is exactly what the
    // multi-slot portfolio depends on.
    const xs = [5, 1, 3];
    median(xs);
    expect(xs).toEqual([5, 1, 3]);
  });

  it("takes the upper of the two middles on an even sample, consistently", () => {
    expect(median([1, 2, 3, 4])).toBe(3);
  });
});

suite("the two corpora differ ONLY in membership", () => {
  const survivors = [runner("0xa", 400n), runner("0xb", 300n)];
  const dead = [runner("0xc", 120n), runner("0xd", 110n)];

  it("charges the identical cost model in both universes", () => {
    // If the complete universe were costed differently, the measured bias would be part cost
    // change and the comparison would be meaningless.
    const a = simulate(survivors, atSwap(5), { label: "x", trailingStopBps: 5_000 });
    const b = simulate([...survivors, ...dead], atSwap(5), { label: "x", trailingStopBps: 5_000 });
    const costA = new Set(a.map((p) => p.costBps));
    const costB = new Set(b.map((p) => p.costBps));
    expect([...costA]).toEqual([...costB]);
  });

  it("gives every survivor the SAME position in both universes", () => {
    // The complete universe is a superset. A survivor's own position must be byte-identical in
    // both, or the corpora differ in something beyond membership.
    const a = simulate(survivors, atSwap(5), { label: "x", trailingStopBps: 5_000 });
    const b = simulate([...survivors, ...dead], atSwap(5), { label: "x", trailingStopBps: 5_000 });
    for (const pa of a) {
      const pb = b.find((p) => p.token === pa.token);
      expect(pb).toBeDefined();
      expect(pb?.netBps).toBe(pa.netBps);
      expect(pb?.entryIdx).toBe(pa.entryIdx);
      expect(pb?.exitReason).toBe(pa.exitReason);
    }
  });

  it("adding weak tokens lowers the measured median — the bias, in the expected direction", () => {
    // This is the kill test in miniature: dead tokens must drag the level DOWN. If adding
    // losers raised the median, the comparison would be wired backwards.
    const withDead = describeBasket(
      simulate([...survivors, ...dead], atSwap(5), { label: "x", trailingStopBps: 5_000 }),
    );
    const survivorsOnly = describeBasket(
      simulate(survivors, atSwap(5), { label: "x", trailingStopBps: 5_000 }),
    );
    expect(withDead.median).toBeLessThan(survivorsOnly.median);
  });
});

suite("measureAgainstRandom", () => {
  const universe = [
    runner("0xa", 500n),
    runner("0xb", 400n),
    runner("0xc", 300n),
    runner("0xd", 250n),
    runner("0xe", 200n),
  ];

  it("reports the t range across seeds, not a single seed's t", () => {
    // A single-seed control IS itself a coin flip. Reporting one t would let the seed choose the
    // headline, which is why §10.4 moved to 20 seeds.
    const arm = measureAgainstRandom("x", universe, 5, { label: "x", trailingStopBps: 5_000 });
    expect(arm.tMin).toBeLessThanOrEqual(arm.tMed);
    expect(arm.tMed).toBeLessThanOrEqual(arm.tMax);
    expect(arm.tOver2).toBeGreaterThanOrEqual(0);
    expect(arm.tOver2).toBeLessThanOrEqual(20);
  });

  it("is deterministic — the same universe gives the same t twice", () => {
    // The control is seeded. A non-deterministic control would make every reported number
    // unreproducible, and reproducibility is the whole claim of §10.8.
    const a = measureAgainstRandom("x", universe, 5, { label: "x", trailingStopBps: 5_000 });
    const b = measureAgainstRandom("x", universe, 5, { label: "x", trailingStopBps: 5_000 });
    expect(b.tMed).toBe(a.tMed);
    expect(b.medianBps).toBe(a.medianBps);
    expect(b.n).toBe(a.n);
  });

  it("counts unresolved positions rather than dropping them", () => {
    // §9.5's artifact was made of positions that never closed. The arm must surface them.
    const rising = [token(Array.from({ length: 40 }, (_, i) => 100n + BigInt(i) * 10n), "0xup")];
    const arm = measureAgainstRandom("up", rising, 5, { label: "x", trailingStopBps: 5_000 });
    expect(arm.unresolvedPct).toBe(100);
  });
});

suite("withMinSwaps is applied BEFORE the fold split", () => {
  it("filters on the token's own bar count, so both folds get the same effective filter", () => {
    const short = token([100n, 110n], "0xshort");
    const long = runner("0xlong", 300n);
    const kept = withMinSwaps([short, long], 100);
    expect(kept.map((t) => t.address)).toEqual(["0xlong"]);
  });
});

suite("armRow — the report line", () => {
  const universe = [
    runner("0xa", 500n),
    runner("0xb", 400n),
    runner("0xc", 300n),
    runner("0xd", 250n),
  ];

  it("prints every field the reader needs to judge the arm", () => {
    // The t RANGE and the unresolved fraction are on this line by design: a row showing only a
    // mean is exactly how §9.5's censoring artifact and §8.3's single-ticket mean got reported as
    // results in earlier rounds.
    const arm = measureAgainstRandom("entry@5", universe, 5, { label: "x", trailingStopBps: 5_000 });
    const row = armRow(arm);
    expect(row).toContain("entry@5");
    expect(row).toContain(String(arm.n));
    expect(row).toContain("/20");
    expect(row.endsWith("%\n")).toBe(true);
  });

  it("has a header whose columns match the row it labels", () => {
    const arm = measureAgainstRandom("entry@5", universe, 5, { label: "x", trailingStopBps: 5_000 });
    for (const col of ["arm", "mean", "median", "win%", "random", "WelchT", "t>2", "unres"]) {
      expect(ARM_HEADER).toContain(col);
    }
    // One line in, one line out — a row that wrapped would misalign the whole table.
    expect(armRow(arm).split("\n").filter((s) => s.length > 0)).toHaveLength(1);
  });
});

suite("medianSpanDays", () => {
  it("measures the observed span, which is the censoring diagnostic", () => {
    // A fold whose tokens are observed for hours cannot resolve a trailing stop, and reporting a
    // mean without this number is how a mark-to-market snapshot gets read as a completed trade.
    const oneDay = token([100n, 200n], "0xa");
    const bars: Bar[] = [bar(0, 100n), bar(86_400, 200n)];
    expect(medianSpanDays([{ ...oneDay, bars }])).toBeCloseTo(1, 6);
  });
});
