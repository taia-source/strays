/**
 * TESTS FOR THE HARNESS ITSELF.
 *
 * A backtest engine with a lookahead bug reports fiction, and it reports it in a form that looks
 * exactly like a good result. These tests exist to prove this one does not have one. The two that
 * matter most are:
 *
 *   1. `historyBefore` is EXCLUSIVE of the decision bar — a golden-value test.
 *   2. THE MUTATION TEST: corrupting every bar at or after the decision index to an absurd value
 *      leaves every decision byte-for-byte identical. If any future price leaked into a decision,
 *      this fails. It is the sabotage check applied to the harness, not to the strategy.
 */

import { describe as group, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  buyRatioBpsBefore,
  replayToken,
  sellableBefore,
  volumeBefore,
} from "./replay.js";
import { type Bar, type RawSeries, historyBefore, toBars, toPriceWei } from "./series.js";
import { decodeSwapLog, ethPerTokenFromSqrtX96, readSigned } from "./collect.js";
import { describe as stat, quantile, summarise } from "./stats.js";
import { forwardBps, mulberry32, welchT } from "./null.js";

const MIN = 60;

function bar(tsMinutes: number, price: number, isBuy = true, ethVol = 10n ** 16n): Bar {
  return {
    ts: tsMinutes * MIN,
    priceWei: toPriceWei(String(price)),
    ethVolumeWei: ethVol,
    isBuy,
    block: tsMinutes * 10,
  };
}

group("historyBefore — the no-lookahead rule", () => {
  const bars = [bar(0, 1e-13), bar(10, 1.1e-13), bar(20, 1.2e-13), bar(30, 1.3e-13)];

  it("EXCLUDES the decision bar itself", () => {
    const h = historyBefore(bars, 2, 3600);
    expect(h.map((b) => b.ts)).toEqual([0 * MIN, 10 * MIN]);
    // The decisive assertion: bar 2's own price is nowhere in what bar 2 can see.
    expect(h.some((b) => b.priceWei === bars[2]?.priceWei)).toBe(false);
  });

  it("EXCLUDES every future bar", () => {
    const h = historyBefore(bars, 1, 3600);
    expect(h.map((b) => b.ts)).toEqual([0]);
    expect(h.some((b) => b.ts >= bars[1]!.ts)).toBe(false);
  });

  it("returns nothing at index 0 — there is no history before the first bar", () => {
    expect(historyBefore(bars, 0, 3600)).toEqual([]);
    expect(historyBefore(bars, -1, 3600)).toEqual([]);
  });

  it("honours the window in CLOCK seconds, not in sample count", () => {
    const sparse = [bar(0, 1e-13), bar(200, 1.1e-13), bar(205, 1.2e-13), bar(210, 1.3e-13)];
    // At bar 3 (ts 210min) with a 60-min window, bar 0 (ts 0) is 210 minutes stale and must drop.
    const h = historyBefore(sparse, 3, 3600);
    expect(h.map((b) => b.ts)).toEqual([200 * MIN, 205 * MIN]);
  });

  it("returns bars in chronological order", () => {
    const h = historyBefore(bars, 3, 36_000);
    const ts = h.map((b) => b.ts);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });
});

group("volumeBefore / buyRatioBpsBefore / sellableBefore exclude the decision bar", () => {
  const bars = [
    bar(0, 1e-13, true, 100n),
    bar(10, 1e-13, false, 200n),
    bar(20, 1e-13, true, 10n ** 30n), // an absurd future bar
  ];

  it("volumeBefore sums strictly before i", () => {
    expect(volumeBefore(bars, 2)).toBe(300n);
    expect(volumeBefore(bars, 0)).toBe(0n);
  });

  it("buyRatioBpsBefore cannot see bar i", () => {
    // Bars 0 (buy) and 1 (sell) -> 5000bps. Bar 2 being a buy must not pull it up.
    expect(buyRatioBpsBefore(bars, 2, 36_000)).toBe(5_000n);
  });

  it("the O(1) accumulators in replayToken agree with the O(n) references at every bar", () => {
    // `replayToken` replaces `volumeBefore`/`sellableBefore` with running sums for speed. A prefix
    // sum is easy to get wrong by exactly one bar, and one bar is the size of a lookahead bug —
    // so the two forms are pinned equal here rather than assumed equal.
    const series = [
      bar(0, 1e-13, true, 100n),
      bar(5, 1e-13, false, 900n),
      bar(10, 1e-13, true, 30n),
      bar(15, 1e-13, false, 50n),
    ];
    let cum = 0n;
    let largestSell = 0n;
    for (let i = 0; i < series.length; i++) {
      expect(cum).toBe(volumeBefore(series, i));
      // `largestSellSeenWei >= size` is the accumulator form of `sellableBefore(bars, i, size)`.
      for (const size of [1n, 60n, 100n, 1000n]) {
        expect(largestSell >= size).toBe(sellableBefore(series, i, size));
      }
      const b = series[i]!;
      cum += b.ethVolumeWei;
      if (!b.isBuy && b.ethVolumeWei > largestSell) largestSell = b.ethVolumeWei;
    }
  });

  it("sellableBefore cannot see a sell at or after bar i", () => {
    const onlyFutureSell = [bar(0, 1e-13, true, 1n), bar(10, 1e-13, false, 10n ** 18n)];
    // At bar 1 the only qualifying sell IS bar 1, which is not visible.
    expect(sellableBefore(onlyFutureSell, 1, 10n ** 17n)).toBe(false);
    expect(sellableBefore(onlyFutureSell, 2, 10n ** 17n)).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE MUTATION TEST — the one that actually proves it
   ══════════════════════════════════════════════════════════════════════════════════════════ */

group("MUTATION: futures cannot influence the past", () => {
  /** A series with a real breakout, so the strategy actually fires and there is something to alter. */
  function rampSeries(): RawSeries {
    const swaps = [];
    let price = 1e-13;
    for (let i = 0; i < 40; i++) {
      // A steady climb steep enough to clear the 2-sigma breakout threshold.
      price *= 1.02;
      swaps.push({
        block: 1000 + i * 100,
        ts: 1_780_000_000 + i * 300,
        logIndex: 0,
        priceEth: price.toExponential(12),
        // Alternate buys and sells so `sellableBefore` is satisfied early.
        amount0: (i % 2 === 0 ? 1n : -1n) * 10n ** 16n,
        amount1: (i % 2 === 0 ? -1n : 1n) * 10n ** 24n,
      });
    }
    return {
      address: "0xtest",
      symbol: "RAMP",
      poolId: "0xpool",
      taxPct: 1,
      // 2 hours before the first bar: past the 60-min minimum age, well inside the 7-day maximum.
      launchedAt: (1_780_000_000 - 7_200) * 1000,
      marketCapEth: 5,
      swaps: swaps.map((s) => ({ ...s, amount0: s.amount0.toString(), amount1: s.amount1.toString() })),
    };
  }

  it("produces trades on the ramp — otherwise the mutation test proves nothing", async () => {
    const trades = await replayToken(toBars(rampSeries()), DEFAULT_PARAMS);
    expect(trades.length).toBeGreaterThan(0);
  });

  it("truncating the series does not change the trades that opened before the cut", async () => {
    // If a decision at bar i could see bar j > i, then deleting everything after the cut would
    // change decisions made before it. It must not.
    const full = toBars(rampSeries());
    const CUT = 30;
    const truncated = { ...full, bars: full.bars.slice(0, CUT) };

    const fullTrades = await replayToken(full, DEFAULT_PARAMS);
    const cutTrades = await replayToken(truncated, DEFAULT_PARAMS);

    // Compare only entries decided strictly before the cut, and only their ENTRY facts — an exit
    // after the cut legitimately differs because the data really does end there.
    const entryOf = (ts: readonly { entryTs: number; entryPriceWei: bigint }[], cutTs: number) =>
      ts
        .filter((t) => t.entryTs < cutTs)
        .map((t) => `${String(t.entryTs)}@${t.entryPriceWei.toString()}`);
    const cutTs = full.bars[CUT]!.ts;
    expect(entryOf(cutTrades, cutTs)).toEqual(entryOf(fullTrades, cutTs));
  });

  it("CORRUPTING all future bars to an absurd price leaves prior entries identical", async () => {
    const full = toBars(rampSeries());
    const FROM = 25;
    // Every bar from FROM onward becomes a 1000x spike. A strategy peeking forward would see a
    // gigantic move and enter far earlier or far more often.
    const corrupted = {
      ...full,
      bars: full.bars.map((b, i) =>
        i >= FROM ? { ...b, priceWei: b.priceWei * 1000n, ethVolumeWei: b.ethVolumeWei * 1000n } : b,
      ),
    };

    const clean = await replayToken(full, DEFAULT_PARAMS);
    const dirty = await replayToken(corrupted, DEFAULT_PARAMS);

    const beforeCorruption = full.bars[FROM]!.ts;
    const sig = (ts: readonly { entryTs: number; entryPriceWei: bigint; sizeWei: bigint }[]) =>
      ts
        .filter((t) => t.entryTs < beforeCorruption)
        .map((t) => `${String(t.entryTs)}|${t.entryPriceWei.toString()}|${t.sizeWei.toString()}`);

    expect(sig(dirty)).toEqual(sig(clean));
    expect(sig(clean).length).toBeGreaterThan(0); // the test must have something to compare
  });

  it("an entry NEVER fills at the price of the bar that triggered it", async () => {
    const series = toBars(rampSeries());
    const trades = await replayToken(series, DEFAULT_PARAMS);
    for (const t of trades) {
      const fillIdx = series.bars.findIndex((b) => b.ts === t.entryTs);
      expect(fillIdx).toBeGreaterThan(0);
      // The bar the decision was taken on is fillIdx-1. The history that decision saw ended at
      // fillIdx-2. So the fill price must not appear in the deciding bar's visible history.
      const seen = historyBefore(series.bars, fillIdx - 1, DEFAULT_PARAMS.lookbackMinutes * 60);
      expect(seen.some((b) => b.ts === t.entryTs)).toBe(false);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   DECODER — verified against an independently-sourced value
   ══════════════════════════════════════════════════════════════════════════════════════════ */

group("Swap decoding", () => {
  /**
   * A REAL log from mainnet 4663, tx
   * 0x78ba2b11e1c2a498822f26f3b4135f21d29f37964940c5bdfa3171784022ff8b, block 29733602, FLORK.
   *
   * The API's own `/trades` endpoint reports `priceEth: 5.872078413120653e-7` for this exact
   * transaction. That is an INDEPENDENT source — the pad decoded the same event with its own
   * code — so agreement here is a genuine cross-check on the decoder, not a tautology.
   */
  const REAL_LOG = {
    data:
      "0x" +
      "00000000000000000000000000000000000000000000000000016df671ec42c2" + // amount0: +402380217402050 wei ETH into pool
      "ffffffffffffffffffffffffffffffffffffffffffffffdada799aa1e254e70e" + // amount1: -685233490808435054834 tokens out
      "0000000000000000000000000000000000000518fb0cd0664fb50d94d559d60b" + // sqrtPriceX96
      "0000000000000000000000000000000000000000000007cbf9d9985f0629c56e" + // liquidity
      "000000000000000000000000000000000000000000000000000000000002307e" + // tick
      "0000000000000000000000000000000000000000000000000000000000000000", // fee
    blockNumber: "0x1c5b2e2",
    blockTimestamp: "0x6a751489",
    logIndex: "0x4",
  };

  it("recovers the exact signed amounts the pad reports for this trade", () => {
    // The pad's /trades row: ethWei "402380217402050", tokenWei "685233490808435054834", side sell.
    const d = decodeSwapLog(REAL_LOG);
    expect(d.amount0).toBe("402380217402050");
    expect(d.amount1).toBe("-685233490808435054834");
  });

  it("recovers block, timestamp and logIndex from the log", () => {
    const d = decodeSwapLog(REAL_LOG);
    expect(d.block).toBe(29_733_602);
    expect(d.ts).toBe(1_786_057_865);
    expect(d.logIndex).toBe(4);
  });

  it("recovers a price matching the pad's own independently-decoded value", () => {
    const d = decodeSwapLog(REAL_LOG);
    // The pad says 5.872078413120653e-7.
    expect(Number(d.priceEth)).toBeCloseTo(5.872078413120653e-7, 18);
  });

  it("refuses a short data field rather than misaligning every field after it", () => {
    expect(() => decodeSwapLog({ ...REAL_LOG, data: "0x00" })).toThrow(/expected 192/);
  });

  it("refuses a non-positive sqrtPriceX96", () => {
    expect(() => ethPerTokenFromSqrtX96(0n)).toThrow(/non-positive/);
  });

  it("readSigned sign-extends a two's-complement word", () => {
    expect(readSigned(1n)).toBe(1n);
    expect(readSigned((1n << 256n) - 1n)).toBe(-1n);
    expect(readSigned(1n << 255n)).toBe(-(1n << 255n));
  });
});

group("series construction", () => {
  it("refuses a non-monotone timestamp", () => {
    const raw: RawSeries = {
      address: "0x",
      symbol: "X",
      poolId: "0x",
      taxPct: 1,
      launchedAt: 0,
      marketCapEth: 1,
      swaps: [
        { block: 1, ts: 100, logIndex: 0, priceEth: "1e-13", amount0: "1", amount1: "-1" },
        { block: 2, ts: 50, logIndex: 0, priceEth: "1e-13", amount0: "1", amount1: "-1" },
      ],
    };
    expect(() => toBars(raw)).toThrow(/non-monotone/);
  });

  it("marks ETH-into-pool as a buy and preserves magnitude", () => {
    const raw: RawSeries = {
      address: "0x",
      symbol: "X",
      poolId: "0x",
      taxPct: 1,
      launchedAt: 0,
      marketCapEth: 1,
      swaps: [
        { block: 1, ts: 100, logIndex: 0, priceEth: "1e-13", amount0: "500", amount1: "-1" },
        { block: 2, ts: 200, logIndex: 0, priceEth: "1e-13", amount0: "-700", amount1: "1" },
      ],
    };
    const b = toBars(raw).bars;
    expect(b[0]?.isBuy).toBe(true);
    expect(b[0]?.ethVolumeWei).toBe(500n);
    expect(b[1]?.isBuy).toBe(false);
    expect(b[1]?.ethVolumeWei).toBe(700n);
  });

  it("preserves 1bps resolution at the ~1e-13 prices these pools trade at", () => {
    // The precision claim in series.ts, asserted rather than trusted.
    const a = toPriceWei("1.000000e-13");
    const b = toPriceWei("1.000100e-13"); // exactly +1bps
    expect(a).toBeGreaterThan(0n);
    const moveBps = ((b - a) * 10_000n) / a;
    expect(moveBps).toBe(1n);
  });

  it("refuses a non-positive or unparseable price", () => {
    expect(() => toPriceWei("0")).toThrow(/non-positive/);
    expect(() => toPriceWei("-1e-13")).toThrow(/non-positive/);
    expect(() => toPriceWei("banana")).toThrow(/non-positive/);
  });
});

group("null hypothesis machinery", () => {
  it("mulberry32 is deterministic — the baseline must be reproducible", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(new Set(seqA).size).toBe(3); // and not a constant
    for (const v of seqA) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1);
  });

  it("forwardBps exits at the stop when the move breaches it", () => {
    const bars = [bar(0, 1e-13), bar(1, 0.9e-13), bar(2, 2e-13)];
    // -1000bps at bar 1 breaches a 235bps stop, so the +10000bps at bar 2 must NOT be reported.
    const fwd = forwardBps(bars, 0, 10, 235n, 471n);
    expect(fwd).toBeLessThan(0n);
  });

  it("forwardBps exits at the take-profit when that comes first", () => {
    const bars = [bar(0, 1e-13), bar(1, 1.1e-13), bar(2, 0.5e-13)];
    const fwd = forwardBps(bars, 0, 10, 235n, 471n);
    expect(fwd).toBeGreaterThan(0n);
  });

  it("forwardBps never reads beyond holdBars", () => {
    const bars = [bar(0, 1e-13), bar(1, 1.0001e-13), bar(2, 100e-13)];
    // hold=1 means it may see bar 1 only. Bar 2's 100x must be invisible.
    const fwd = forwardBps(bars, 0, 1, 100_000n, 100_000n);
    expect(fwd).toBe(1n);
  });

  it("welchT is zero for identical samples and large for well-separated ones", () => {
    expect(welchT([1, 2, 3, 4], [1, 2, 3, 4]).t).toBeCloseTo(0, 10);
    expect(Math.abs(welchT([100, 101, 99, 100], [0, 1, -1, 0]).t)).toBeGreaterThan(10);
    expect(welchT([1], [2]).t).toBeNaN();
  });
});

group("stats", () => {
  it("reports stdDev as NaN for a single observation, never zero", () => {
    // Reporting 0 would make one trade look infinitely precise — the exact error MinBTL catches.
    expect(stat([5]).stdDev).toBeNaN();
    expect(stat([]).n).toBe(0);
  });

  it("quantiles interpolate", () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([0, 10, 20], 0.5)).toBe(10);
  });

  it("max drawdown is measured on the compounded curve", () => {
    const t = (netBps: number): { netBps: bigint } => ({ netBps: BigInt(netBps) });
    const s = summarise([
      { ...t(1000), grossBps: 0n, taxPct: 1, exitReason: "take-profit" },
      { ...t(-2000), grossBps: 0n, taxPct: 1, exitReason: "stop" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    // 1.10 then 0.88 -> peak 1.10, trough 0.88 -> dd = 20%
    expect(s.maxDrawdownBps).toBeCloseTo(2000, 0);
    expect(s.winRate).toBe(0.5);
  });
});
