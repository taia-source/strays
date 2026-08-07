/**
 * ROUND 3, THE CONFIRMATION — the only file that reports a number on HELD-OUT data.
 *
 * `liquid.ts` searched on TRAIN. This file takes what that search found, measures it on TEST, and
 * subjects it to the test that decides whether it is an edge or an artifact: **does it beat RANDOM
 * ENTRIES ON THE SAME RESTRICTED UNIVERSE with the SAME exit rule?**
 *
 * ══ WHY THAT CONTROL IS THE WHOLE REPORT, NOT A FOOTNOTE ══
 *
 * Restricting the universe to "tokens that are big and liquid TODAY" is itself a survivorship
 * filter. The tokens with 38,867 swaps are on today's mcap and trending lists *because they went
 * up*; the ones that launched and died are not in the sample at all. §D of the search measured
 * what that does: buy-and-hold rises from +28,397bps on the full TRAIN universe to +304,069bps on
 * the ≥5000-swap band, and the fraction of tokens ending UP rises from 58% to 100%.
 *
 * **A restricted universe therefore MUST look better on absolute return, with or without a
 * strategy.** Every arm below is printed next to a coin flip on its own universe, and the Welch t
 * of that difference is the only column that can distinguish skill from selection.
 */

import {
  assessCostModel,
  assessOverfitting,
  assessSampleSize,
  formatHonestReport,
} from "@taia/backtest";
import { cutTimestamp, loadTokens, splitAt } from "./load.js";
import {
  BANDS,
  type LiquidityBand,
  activityOf,
  buyAndHold,
  byToken,
  cohort,
  matchedRandom,
  resolveCohort,
  restrictTo,
} from "./liquidity.js";
import { DEFAULT_PARAMS, type ReplayParams, replay } from "./replay.js";
import type { TokenBars } from "./series.js";
import { summarise } from "./stats.js";

const DAY = 86_400;

/**
 * EVERY TRIAL RUN ACROSS ALL THREE ROUNDS, counted for MinBTL.
 *
 * Round 2 declared 76. `liquid.ts` adds 45 (5 decision-time gates, 10 universe bands, 28
 * hold/take-profit pairs, 2 stop modes), and the arms measured in this file add 12 more. The count
 * is cumulative because the SEARCH is cumulative: the same data has now been interrogated 133
 * times, and MinBTL's bar depends on how many times you looked, not on how many times you looked
 * during the current sitting. Resetting the counter each round is the most common way a multi-
 * round search launders an overfit into a result.
 */
const TRIALS_RUN = 133;

/** The arms carried from TRAIN. Each is (label, params). */
type Arm = { readonly label: string; readonly params: ReplayParams; readonly takeBps: bigint };

async function main(): Promise<void> {
  const tokens = loadTokens();
  const lo = Math.min(...tokens.map((t) => t.bars[0]?.ts ?? Number.POSITIVE_INFINITY));
  const hi = Math.max(...tokens.map((t) => t.bars[t.bars.length - 1]?.ts ?? 0));
  const cut = cutTimestamp(tokens, 0.7);
  const test = splitAt(tokens, cut, "test");
  const testYears = (hi - cut) / DAY / 365;

  process.stdout.write(
    `ROUND 3 CONFIRMATION — HELD-OUT FOLD ONLY.\n` +
      `${String(test.length)} tokens, ${((hi - cut) / DAY).toFixed(1)} days (${testYears.toFixed(3)}y).\n` +
      "Every threshold below was chosen on TRAIN. Nothing here was fitted on this data.\n\n",
  );

  /* ════════════════════════════════════════════════════════════════════════════════════════
     1. THE LIQUIDITY LADDER, EACH BAND AGAINST ITS OWN COIN FLIP.
     ════════════════════════════════════════════════════════════════════════════════════════ */
  process.stdout.write(
    "══ 1. DOES THE EDGE SURVIVE AS LIQUIDITY RISES? Each band vs RANDOM on that same band ══\n\n",
  );
  process.stdout.write(
    "  band                  tokens      n   signal    random     diff  Welch t      B&H mean  up%\n",
  );
  for (const band of BANDS) {
    const universe = restrictTo(test, band);
    if (universe.length === 0) continue;
    const r = await replay(universe, DEFAULT_PARAMS);
    if (r.trades.length < 2) continue;
    const s = summarise(r.trades);
    const ctrl = matchedRandom(universe, r.trades, {
      stopBps: DEFAULT_PARAMS.stopLossBps,
      takeBps: 471n,
      perToken: 8,
      seed: 77,
    });
    const bh = buyAndHold(universe);
    process.stdout.write(
      `  ${band.label.padEnd(20)}${String(universe.length).padStart(6)}` +
        `${String(s.trades).padStart(7)}${s.net.mean.toFixed(0).padStart(9)}` +
        `${ctrl.mean.toFixed(0).padStart(10)}${(s.net.mean - ctrl.mean).toFixed(0).padStart(9)}` +
        `${ctrl.t.toFixed(2).padStart(9)}${bh.mean.toFixed(0).padStart(14)}` +
        `${(bh.upFraction * 100).toFixed(0).padStart(5)}\n`,
    );
  }

  /* ════════════════════════════════════════════════════════════════════════════════════════
     2. LONG HOLDS ON THE LIQUID UNIVERSE, EACH AGAINST ITS OWN COIN FLIP.
     ════════════════════════════════════════════════════════════════════════════════════════ */
  const liquidBand: LiquidityBand = { label: ">=2000 swaps", minSwaps: 2000, minSwapsPerHour: 0 };
  const liquidTest = restrictTo(test, liquidBand);

  process.stdout.write(
    `\n══ 2. LONG HOLDS on the liquid held-out universe ` +
      `(${String(liquidTest.length)} tokens, ` +
      `${String(liquidTest.reduce((n, t) => n + t.bars.length, 0))} bars) ══\n` +
      "A 218bps toll is the same whether the hold is 20 minutes or 30 days. If a long hold\n" +
      "amortises it, the DIFF column grows. If the long hold is simply more exposure to a universe\n" +
      "that drifted up, the random arm grows with it and the DIFF does not.\n\n",
  );
  process.stdout.write("  arm                       n   signal    random     diff  Welch t   median\n");

  const arms: Arm[] = [];
  for (const [hours, tp] of [
    [1, 471n],
    [6, 2000n],
    [24, 2000n],
    [72, 5000n],
    [168, 5000n],
    [336, 20_000n],
    [720, 20_000n],
  ] as const) {
    arms.push({
      label: `hold=${String(hours)}h tp=${tp.toString()}`,
      params: { ...DEFAULT_PARAMS, maxHoldSeconds: hours * 3600, takeProfitBps: tp },
      takeBps: tp,
    });
  }

  const measured: { arm: Arm; mean: number; t: number; n: number }[] = [];
  for (const arm of arms) {
    const r = await replay(liquidTest, arm.params);
    const s = summarise(r.trades);
    const ctrl = matchedRandom(liquidTest, r.trades, {
      stopBps: DEFAULT_PARAMS.stopLossBps,
      takeBps: arm.takeBps,
      perToken: 8,
      seed: 77,
    });
    measured.push({ arm, mean: s.net.mean, t: ctrl.t, n: s.trades });
    process.stdout.write(
      `  ${arm.label.padEnd(22)}${String(s.trades).padStart(5)}` +
        `${s.net.mean.toFixed(0).padStart(9)}${ctrl.mean.toFixed(0).padStart(10)}` +
        `${(s.net.mean - ctrl.mean).toFixed(0).padStart(9)}${ctrl.t.toFixed(2).padStart(9)}` +
        `${s.net.median.toFixed(0).padStart(9)}\n`,
    );
  }

  /* ════════════════════════════════════════════════════════════════════════════════════════
     3. THE NAMED COHORT, PER TOKEN. Ibrahim recognises these names.
     ════════════════════════════════════════════════════════════════════════════════════════ */
  const addresses = resolveCohort(tokens);
  const cohortTest = cohort(test, addresses);
  process.stdout.write(
    `\n══ 3. THE NAMED COHORT on held-out data (${String(cohortTest.length)} of ` +
      `${String(addresses.size)} names present in TEST) ══\n` +
      "Per token, because a pooled mean over 8 tokens can be carried entirely by one of them.\n\n",
  );

  const cohortRun = await replay(cohortTest, DEFAULT_PARAMS);
  const cohortSummary = summarise(cohortRun.trades);
  const cohortCtrl = matchedRandom(cohortTest, cohortRun.trades, {
    stopBps: DEFAULT_PARAMS.stopLossBps,
    takeBps: 471n,
    perToken: 16,
    seed: 77,
  });

  process.stdout.write(
    "  token            n   meanNet   medNet    win%      sumBps   swaps/hr   B&H\n",
  );
  const results = byToken(cohortRun.trades);
  for (const tr of results) {
    const tok = cohortTest.find((t) => t.address === tr.address);
    const act = tok === undefined ? undefined : activityOf(tok);
    const bh = tok === undefined ? undefined : buyAndHold([tok]);
    process.stdout.write(
      `  ${tr.symbol.padEnd(12)}${String(tr.trades).padStart(5)}` +
        `${tr.meanNet.toFixed(0).padStart(10)}${tr.medianNet.toFixed(0).padStart(9)}` +
        `${(tr.winRate * 100).toFixed(0).padStart(8)}${tr.sumBps.toFixed(0).padStart(12)}` +
        `${(act?.swapsPerHour ?? 0).toFixed(0).padStart(11)}` +
        `${(bh?.mean ?? Number.NaN).toFixed(0).padStart(10)}\n`,
    );
  }
  // Names that produced NO trades are reported too — a token the strategy never touched is a
  // result about the strategy, and omitting it would overstate coverage of the cohort.
  const traded = new Set(results.map((r) => r.address.toLowerCase()));
  for (const [name, addr] of addresses) {
    if (traded.has(addr.toLowerCase())) continue;
    const inTest = cohortTest.some((t) => t.address.toLowerCase() === addr.toLowerCase());
    process.stdout.write(
      `  ${name.padEnd(12)}    0         —        —       —           —          —   ` +
        `${inTest ? "(in TEST, no entry fired)" : "(not in TEST fold)"}\n`,
    );
  }
  process.stdout.write(
    `\n  COHORT POOLED: n=${String(cohortSummary.trades)}  ` +
      `mean ${cohortSummary.net.mean.toFixed(0)}bps  median ${cohortSummary.net.median.toFixed(0)}bps  ` +
      `win ${(cohortSummary.winRate * 100).toFixed(1)}%\n` +
      `  RANDOM on the same 8 names, same exit: mean ${cohortCtrl.mean.toFixed(0)}bps  ` +
      `n=${String(cohortCtrl.n)}\n` +
      `  Welch t: ${cohortCtrl.t.toFixed(2)}\n`,
  );

  /* ════════════════════════════════════════════════════════════════════════════════════════
     4. THE HONESTY CHECK on the best held-out arm.
     ════════════════════════════════════════════════════════════════════════════════════════ */
  const best = measured.reduce((a, b) => (b.mean > a.mean ? b : a));
  const bestRun = await replay(liquidTest, best.arm.params);
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
    `\n══ 4. HONESTY CHECK — best held-out arm (${best.arm.label}), ${String(TRIALS_RUN)} cumulative trials ══\n`,
  );
  process.stdout.write(
    `${formatHonestReport({
      overfit,
      sample,
      costs,
      venueNote:
        "letscash.fun / Uniswap v4 on Robinhood chain 4663. Universe restricted to tokens with " +
        ">=2000 realised swaps in the held-out fold. Held-out data only.",
    })}\n`,
  );
  process.stdout.write(`\nCREDIBLE: ${String(overfit.credible)}\n`);
  process.stdout.write(
    `mean ${bestSummary.net.mean.toFixed(0)}bps  MEDIAN ${bestSummary.net.median.toFixed(0)}bps  ` +
      `n=${String(bestSummary.trades)}  win ${(bestSummary.winRate * 100).toFixed(1)}%\n` +
      `Welch t vs random entry on the SAME liquid universe: ${best.t.toFixed(2)}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${String(e)}\n`);
  process.exitCode = 1;
});
