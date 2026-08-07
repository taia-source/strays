/**
 * RUN — the backtest, and the honesty checks that decide whether its numbers mean anything.
 *
 * Reports the DISTRIBUTION, not the mean alone, and runs `assessOverfitting` (MinBTL) and
 * `assessSampleSize` from `@taia/backtest` on the result. The trial counter is real: every
 * parameter variant evaluated in the sweep is recorded, so the MinBTL bar rises with the number of
 * things tried — which is the entire point of the check.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessCostModel,
  assessOverfitting,
  assessSampleSize,
  createMemoryTrialLog,
  formatHonestReport,
} from "@taia/backtest";
import { DEFAULT_PARAMS, type ReplayParams, type Trade, replay } from "./replay.js";
import { type RawSeries, type TokenBars, toBars } from "./series.js";
import { type Summary, summarise } from "./stats.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadTokens(): readonly TokenBars[] {
  const raw = JSON.parse(
    readFileSync(join(HERE, "..", "data", "series.json"), "utf8"),
  ) as RawSeries[];
  return raw.map(toBars);
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function line(label: string, s: Summary): string {
  return (
    `${label.padEnd(28)} n=${String(s.trades).padStart(5)}  ` +
    `win ${pct(s.winRate).padStart(6)}  ` +
    `meanNet ${s.net.mean.toFixed(0).padStart(7)}bps  ` +
    `medNet ${s.net.median.toFixed(0).padStart(6)}bps  ` +
    `total ${s.totalReturnBps.toFixed(0).padStart(9)}bps  ` +
    `maxDD ${s.maxDrawdownBps.toFixed(0).padStart(6)}bps  ` +
    `SR/trade ${s.sharpePerTrade.toFixed(3)}`
  );
}

async function main(): Promise<void> {
  const tokens = loadTokens();
  const spanDays =
    (Math.max(...tokens.map((t) => t.bars[t.bars.length - 1]?.ts ?? 0)) -
      Math.min(...tokens.map((t) => t.bars[0]?.ts ?? Number.POSITIVE_INFINITY))) /
    86_400;
  const yearsAvailable = spanDays / 365;

  process.stdout.write(
    `DATA: ${String(tokens.length)} tokens, ` +
      `${String(tokens.reduce((n, t) => n + t.bars.length, 0))} swaps, ` +
      `${spanDays.toFixed(1)} days (${yearsAvailable.toFixed(3)}y)\n\n`,
  );

  /* ══ 1. THE BASELINE — the shipped constants, exactly as they stand ══ */
  const base = await replay(tokens, DEFAULT_PARAMS);
  const baseSummary = summarise(base.trades);

  process.stdout.write("══ BASELINE (shipped constants) ══\n");
  process.stdout.write(`${line("lookback=60 edge=2 stop=235", baseSummary)}\n\n`);

  process.stdout.write("net return distribution (bps):\n");
  const d = baseSummary.net;
  process.stdout.write(
    `  min ${d.min.toFixed(0)}  p10 ${d.p10.toFixed(0)}  p25 ${d.p25.toFixed(0)}  ` +
      `MEDIAN ${d.median.toFixed(0)}  p75 ${d.p75.toFixed(0)}  p90 ${d.p90.toFixed(0)}  ` +
      `max ${d.max.toFixed(0)}\n`,
  );
  process.stdout.write(`  mean ${d.mean.toFixed(0)}  sd ${d.stdDev.toFixed(0)}\n\n`);
  process.stdout.write(`gross (before cost): mean ${baseSummary.gross.mean.toFixed(0)}bps  median ${baseSummary.gross.median.toFixed(0)}bps\n`);
  process.stdout.write(`by tax tier: ${baseSummary.byTax.map((t) => `${String(t.taxPct)}%: n=${String(t.n)} mean=${t.meanNet.toFixed(0)}bps`).join("  ")}\n`);
  process.stdout.write(`by exit:     ${baseSummary.byExit.map((t) => `${t.reason}: n=${String(t.n)} mean=${t.meanNet.toFixed(0)}bps`).join("  ")}\n\n`);

  /* ══ 2. THE PARAMETER SWEEP — every variant counted against MinBTL ══ */
  const trialLog = createMemoryTrialLog();
  await trialLog.record({ name: "baseline", sharpe: baseSummary.sharpePerTrade });

  const variants: { name: string; params: ReplayParams }[] = [];
  for (const lookbackMinutes of [15, 30, 60, 120, 240]) {
    variants.push({ name: `lookback=${String(lookbackMinutes)}`, params: { ...DEFAULT_PARAMS, lookbackMinutes } });
  }
  for (const edgeMultiple of [1n, 2n, 3n, 4n]) {
    variants.push({ name: `edge=${edgeMultiple.toString()}`, params: { ...DEFAULT_PARAMS, edgeMultiple } });
  }
  for (const stopLossBps of [100n, 235n, 400n, 800n, 1600n]) {
    variants.push({ name: `stop=${stopLossBps.toString()}`, params: { ...DEFAULT_PARAMS, stopLossBps } });
  }
  for (const maxDrawdownBps of [1000n, 2000n, 4000n, 100_000n]) {
    variants.push({ name: `dd=${maxDrawdownBps.toString()}`, params: { ...DEFAULT_PARAMS, maxDrawdownBps } });
  }

  process.stdout.write("══ PARAMETER SWEEP — each row is a TRIAL, and trials raise the MinBTL bar ══\n");
  const results: { name: string; summary: Summary }[] = [];
  for (const v of variants) {
    const r = await replay(tokens, v.params);
    const s = summarise(r.trades);
    results.push({ name: v.name, summary: s });
    await trialLog.record({ name: v.name, sharpe: s.sharpePerTrade });
    process.stdout.write(`${line(v.name, s)}\n`);
  }

  /* ══ 3. THE HONESTY CHECK ══ */
  const trials = await trialLog.count();
  const best = await trialLog.best();
  process.stdout.write(`\n══ HONESTY (@taia/backtest) ══\ntrials recorded: ${String(trials)}\n`);

  // MinBTL is applied to the BEST variant, which is the number a tuner would want to report.
  // Applying it to the baseline only would let the sweep escape the count it exists to constrain.
  const bestName = best?.name ?? "baseline";
  const bestSummary =
    results.find((r) => r.name === bestName)?.summary ?? baseSummary;

  for (const [label, s, n] of [
    ["BASELINE", baseSummary, 1],
    [`BEST-OF-SWEEP (${bestName})`, bestSummary, trials],
  ] as const) {
    // Sharpe over the OBSERVED period: per-trade ratio scaled by sqrt(n trades). Not annualised.
    const observedSharpe = s.sharpePerTrade * Math.sqrt(Math.max(s.trades, 1));
    const overfit = assessOverfitting({ trials: n, observedSharpe, yearsAvailable });
    const sample = assessSampleSize({
      meanReturn: s.net.mean,
      stdDev: s.net.stdDev,
      trades: s.trades,
    });
    const costs = assessCostModel({
      slippageFromPoolState: false,
      gasIncluded: true,
      revertsIncluded: false,
      feesIncluded: true,
      priceImpactOfOwnSize: false,
    });
    process.stdout.write(`\n── ${label} ──\n`);
    process.stdout.write(
      `${formatHonestReport({
        overfit,
        sample,
        costs,
        venueNote:
          "letscash.fun / Uniswap v4 on Robinhood chain 4663. Prices reconstructed from " +
          "PoolManager Swap events; cost = 2x tax + measured gas.",
      })}\n`,
    );
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${String(e)}\n`);
  process.exitCode = 1;
});
