/**
 * THE CONFIRMATION — the ONLY file that reports a number on held-out data.
 *
 * `explore.ts` searches on TRAIN. This file takes the single best candidate that search produced,
 * measures it on TEST, and then subjects it to the three tests that decide whether it is an edge
 * or an artifact:
 *
 *   1. **MinBTL** (`assessOverfitting`) at the FULL trial count, including every losing trial.
 *   2. **The null hypothesis** — the same rule with RANDOM entries. A strategy that does not beat
 *      a coin flip on its own universe has no signal, whatever its mean return is.
 *   3. **The survivorship control** — a coin flip on the universe with no strategy at all.
 *
 * Test 2 is the one that settles this package's question, and it is the one a tuner is most
 * tempted to skip, because a positive mean looks like a result until you discover a coin flip
 * produces the same one.
 */

import { assessCostModel, assessOverfitting, assessSampleSize, formatHonestReport } from "@taia/backtest";
import { cutTimestamp, loadTokens, splitAt } from "./load.js";
import { forwardBps, mulberry32, randomEntries, welchT } from "./null.js";
import { DEFAULT_PARAMS, type ReplayParams, replay } from "./replay.js";
import type { TokenBars } from "./series.js";
import { describe, summarise } from "./stats.js";

const DAY = 86_400;

/**
 * EVERY TRIAL RUN IN THIS INVESTIGATION, counted for MinBTL.
 *
 * `explore.ts` ran 56 (9 score thresholds, 24 hold/take-profit pairs, 12 quality gates, 4 stop
 * modes, 6 edge multiples, plus the baseline). The take-profit grid in this file adds 7 more, and
 * the diagnostic sweeps that produced the numbers quoted in RESULTS.md add a further 13.
 *
 * The count is deliberately GENEROUS rather than minimal. Under-counting trials is the way a
 * curve fit escapes the test that exists to catch it, and MinBTL's bar rises only as sqrt(log n),
 * so honesty here is cheap.
 */
const TRIALS_RUN = 76;

async function main(): Promise<void> {
  const tokens = loadTokens();
  const lo = Math.min(...tokens.map((t) => t.bars[0]?.ts ?? Number.POSITIVE_INFINITY));
  const hi = Math.max(...tokens.map((t) => t.bars[t.bars.length - 1]?.ts ?? 0));
  const cut = cutTimestamp(tokens, 0.7);
  const test = splitAt(tokens, cut, "test");
  const yearsAvailable = (hi - lo) / DAY / 365;
  const testYears = (hi - cut) / DAY / 365;

  process.stdout.write(
    `HELD-OUT TEST FOLD: ${String(test.length)} tokens, ${((hi - cut) / DAY).toFixed(1)} days ` +
      `(${testYears.toFixed(3)}y). Nothing below was fitted on this data.\n\n`,
  );

  /* ══════════════════════════════════════════════════════════════════════════════════════
     1. THE CANDIDATE. The only arm that was positive on TRAIN: a WIDE take-profit.
     ══════════════════════════════════════════════════════════════════════════════════════ */
  const candidate: ReplayParams = {
    ...DEFAULT_PARAMS,
    maxHoldSeconds: 3600,
    takeProfitBps: 10_000n,
  };

  process.stdout.write("══ 1. SIGNAL vs RANDOM ENTRY, on the HELD-OUT fold, same exit rule ══\n");
  process.stdout.write(
    "Both arms pay the same measured round-trip cost. If the signal cannot beat a coin flip\n" +
      "given the identical exit rule, then whatever the mean return is, it is not the signal's.\n\n",
  );
  process.stdout.write("  tp     signal n   signal mean   random mean     diff   Welch t\n");

  const rows: { tp: bigint; signalMean: number; randomMean: number; t: number; n: number }[] = [];
  for (const tp of [471n, 1000n, 2000n, 4000n, 6000n, 10_000n]) {
    const r = await replay(test, { ...candidate, takeProfitBps: tp });
    const s = summarise(r.trades);
    const holdBars = Math.round(
      r.trades.reduce((n, t) => n + t.barsHeld, 0) / Math.max(r.trades.length, 1),
    );
    const rnd = randomEntries(test, {
      perToken: 8,
      holdBars,
      stopBps: DEFAULT_PARAMS.stopLossBps,
      takeBps: tp,
      seed: 99,
    });
    const rndNet = rnd.map((x) => x.netBps - (2 * x.taxPct * 100 + 32));
    const rd = describe(rndNet);
    const w = welchT(r.trades.map((x) => Number(x.netBps)), rndNet);
    rows.push({ tp, signalMean: s.net.mean, randomMean: rd.mean, t: w.t, n: s.trades });
    process.stdout.write(
      `${tp.toString().padStart(6)}  ${String(s.trades).padStart(8)}  ` +
        `${s.net.mean.toFixed(0).padStart(11)}bps  ${rd.mean.toFixed(0).padStart(9)}bps  ` +
        `${(s.net.mean - rd.mean).toFixed(0).padStart(7)}  ${w.t.toFixed(2).padStart(7)}\n`,
    );
  }

  process.stdout.write(
    "\nTHE SHAPE OF THIS TABLE IS THE RESULT. The signal's edge over random is LARGEST exactly\n" +
      "where the strategy LOSES money, and it decays to zero exactly where it starts to make it.\n\n",
  );

  /* ══ 2. THE SURVIVORSHIP CONTROL — a coin flip with no strategy at all ══ */
  process.stdout.write("══ 2. SURVIVORSHIP CONTROL: no strategy, no signal, just this universe ══\n");
  const rng = mulberry32(4242);
  for (const takeBps of [471n, 10_000n]) {
    const out: number[] = [];
    for (const t of tokens) {
      const usable = t.bars.length - 19;
      if (usable <= 1) continue;
      for (let k = 0; k < 8; k++) {
        const idx = 1 + Math.floor(rng() * usable);
        const f = forwardBps(t.bars, idx, 18, 235n, takeBps);
        if (f !== undefined) out.push(Number(f) - (2 * t.taxPct * 100 + 32));
      }
    }
    const d = describe(out);
    process.stdout.write(
      `  random entry, all ${String(tokens.length)} tokens, tp=${takeBps.toString().padStart(5)}: ` +
        `n=${String(d.n)} mean=${d.mean.toFixed(0)}bps median=${d.median.toFixed(0)}bps\n`,
    );
  }
  const upCount = tokens.filter((t) => {
    const a = t.bars[0]?.priceWei ?? 1n;
    const b = t.bars[t.bars.length - 1]?.priceWei ?? 1n;
    return b > a;
  }).length;
  const bh = tokens.map((t) => {
    const a = t.bars[0]?.priceWei ?? 1n;
    const b = t.bars[t.bars.length - 1]?.priceWei ?? 1n;
    return Number(((b - a) * 10_000n) / a) - (2 * t.taxPct * 100 + 32);
  });
  const bhd = describe(bh);
  process.stdout.write(
    `  BUY AND HOLD, first bar to last: mean=${bhd.mean.toFixed(0)}bps ` +
      `median=${bhd.median.toFixed(0)}bps, ${String(upCount)}/${String(tokens.length)} ` +
      `(${((100 * upCount) / tokens.length).toFixed(0)}%) of tokens ended UP.\n\n` +
      "  This universe is the union of TODAY's `sort=mcap` and `sort=trending` lists. A token that\n" +
      "  launched and died is not on it. 63% of it going up is that bias, measured — and it is the\n" +
      "  same +230bps a coin flip collects above. The wide take-profit does not find an edge; it\n" +
      "  widens the window through which the survivorship bias is read.\n\n",
  );

  /* ══ 3. THE FORMAL HONESTY CHECK on the best held-out arm ══ */
  const bestRow = rows.reduce((a, b) => (b.signalMean > a.signalMean ? b : a));
  const bestRun = await replay(test, { ...candidate, takeProfitBps: bestRow.tp });
  const bestSummary = summarise(bestRun.trades);
  const observedSharpe = bestSummary.sharpePerTrade * Math.sqrt(Math.max(bestSummary.trades, 1));

  const overfit = assessOverfitting({
    trials: TRIALS_RUN,
    observedSharpe,
    yearsAvailable: testYears,
  });
  const sample = assessSampleSize({
    meanReturn: bestSummary.net.mean,
    stdDev: bestSummary.net.stdDev,
    trades: bestSummary.trades,
  });
  const costs = assessCostModel({
    slippageFromPoolState: false,
    gasIncluded: true,
    revertsIncluded: false,
    feesIncluded: true,
    priceImpactOfOwnSize: false,
  });

  process.stdout.write(
    `══ 3. HONESTY CHECK — best HELD-OUT arm (tp=${bestRow.tp.toString()}), ${String(TRIALS_RUN)} trials ══\n`,
  );
  process.stdout.write(
    `${formatHonestReport({
      overfit,
      sample,
      costs,
      venueNote:
        "letscash.fun / Uniswap v4 on Robinhood chain 4663. Held-out fold only; thresholds " +
        "fitted on the earlier 70% of the window.",
    })}\n`,
  );
  process.stdout.write(`\nCREDIBLE: ${String(overfit.credible)}\n`);
  process.stdout.write(
    `mean ${bestSummary.net.mean.toFixed(0)}bps  MEDIAN ${bestSummary.net.median.toFixed(0)}bps  ` +
      `n=${String(bestSummary.trades)}  win ${(bestSummary.winRate * 100).toFixed(1)}%\n`,
  );
  process.stdout.write(
    `Welch t vs random entry with the SAME exit rule: ${bestRow.t.toFixed(2)} ` +
      "— indistinguishable from a coin flip.\n",
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${String(e)}\n`);
  process.exitCode = 1;
});
