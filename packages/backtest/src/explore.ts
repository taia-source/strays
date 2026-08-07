/**
 * THE SELECTIVITY EXPERIMENT — the one direction RESULTS.md §6 left untested.
 *
 * This file is the search. It is deliberately separate from `run.ts`, which reports the shipped
 * strategy, because a search and a report are different claims and mixing them is how an in-sample
 * number ends up presented as a result.
 *
 * THE RULE THIS FILE OBEYS: every threshold is chosen on TRAIN and reported on TEST. Trials are
 * counted — all of them, including the ones that lost — and the count is what MinBTL is fed.
 */

import { assessOverfitting, assessSampleSize, createMemoryTrialLog } from "@taia/backtest";
import { cutTimestamp, loadTokens, splitAt } from "./load.js";
import { DEFAULT_PARAMS, type ReplayParams, replay } from "./replay.js";
import type { TokenBars } from "./series.js";
import { type Summary, summarise } from "./stats.js";

const DAY = 86_400;

function fmt(name: string, s: Summary): string {
  return (
    `${name.padEnd(34)} n=${String(s.trades).padStart(5)}  ` +
    `win ${(s.winRate * 100).toFixed(1).padStart(5)}%  ` +
    `meanNet ${s.net.mean.toFixed(0).padStart(7)}bps  ` +
    `medNet ${s.net.median.toFixed(0).padStart(6)}bps  ` +
    `gross ${s.gross.mean.toFixed(0).padStart(6)}bps  ` +
    `SR/t ${s.sharpePerTrade.toFixed(3).padStart(7)}`
  );
}

async function measure(tokens: readonly TokenBars[], p: ReplayParams): Promise<Summary> {
  return summarise((await replay(tokens, p)).trades);
}

async function main(): Promise<void> {
  const tokens = loadTokens();
  const lo = Math.min(...tokens.map((t) => t.bars[0]?.ts ?? Number.POSITIVE_INFINITY));
  const hi = Math.max(...tokens.map((t) => t.bars[t.bars.length - 1]?.ts ?? 0));
  const spanDays = (hi - lo) / DAY;

  // ══ WHY THE CUT IS AT 0.7 AND NOT AT THE MIDPOINT ══
  //
  // The universe is NOT uniformly distributed in time, and this is a property of how it was
  // collected: it is the union of TODAY's `sort=mcap` and `sort=trending` lists, so it is
  // dominated by tokens that launched recently enough to still be on them. 183 of 461 tokens
  // first trade on day 18, and 216 in the last four days.
  //
  // A midpoint cut therefore puts 19 tokens in TRAIN and 459 in TEST — a "split" whose train fold
  // is 4% of the sample. 0.7 (day 19.7) is the earliest cut that puts a usable universe on both
  // sides: 205 tokens / 165k bars train, 450 tokens / 230k bars test. The cut is chosen for
  // BALANCE, from the bar-count histogram alone, before any return was measured on either fold.
  const cut = cutTimestamp(tokens, 0.7);
  const train = splitAt(tokens, cut, "train");
  const test = splitAt(tokens, cut, "test");

  const trainDays = (cut - lo) / DAY;
  const testDays = (hi - cut) / DAY;

  process.stdout.write(
    `DATA  ${String(tokens.length)} tokens, ${spanDays.toFixed(1)} days\n` +
      `TRAIN ${String(train.length)} tokens, ${trainDays.toFixed(1)} days (< ${String(cut)})\n` +
      `TEST  ${String(test.length)} tokens, ${testDays.toFixed(1)} days (>= ${String(cut)})\n\n`,
  );

  const trialLog = createMemoryTrialLog();
  const record = async (name: string, s: Summary): Promise<void> => {
    await trialLog.record({ name, sharpe: s.sharpePerTrade });
  };

  /* ══ 0. THE BASELINE, ON EACH FOLD ══ */
  process.stdout.write("══ 0. BASELINE (shipped constants) on each fold ══\n");
  for (const [label, set] of [
    ["ALL", tokens],
    ["TRAIN", train],
    ["TEST", test],
  ] as const) {
    const s = await measure(set, DEFAULT_PARAMS);
    process.stdout.write(`${fmt(`baseline/${label}`, s)}\n`);
    if (label === "ALL") await record("baseline", s);
  }
  process.stdout.write("\n");

  /* ══ 1. SELECTIVITY — the score threshold, fitted on TRAIN ══ */
  process.stdout.write("══ 1. SELECTIVITY: minScoreBps, fitted on TRAIN ══\n");
  const scoreGrid = [0n, 1n, 10n, 50n, 100n, 250n, 500n, 1000n, 2000n];
  for (const minScoreBps of scoreGrid) {
    const s = await measure(train, { ...DEFAULT_PARAMS, minScoreBps });
    await record(`score>=${minScoreBps.toString()}`, s);
    process.stdout.write(`${fmt(`TRAIN score>=${minScoreBps.toString()}`, s)}\n`);
  }
  process.stdout.write("\n");

  /* ══ 2. HOLD HORIZON — amortising a fixed toll ══ */
  process.stdout.write("══ 2. HOLD HORIZON: maxHoldSeconds + matching take-profit, on TRAIN ══\n");
  for (const hours of [1, 4, 12, 24, 72, 168]) {
    for (const tp of [471n, 1000n, 2000n, 4000n]) {
      const s = await measure(train, {
        ...DEFAULT_PARAMS,
        maxHoldSeconds: hours * 3600,
        takeProfitBps: tp,
      });
      await record(`hold=${String(hours)}h/tp=${tp.toString()}`, s);
      process.stdout.write(`${fmt(`TRAIN hold=${String(hours)}h tp=${tp.toString()}`, s)}\n`);
    }
  }
  process.stdout.write("\n");

  /* ══ 3. QUALITY GATES — volume and participation floors ══ */
  process.stdout.write("══ 3. QUALITY GATES on TRAIN ══\n");
  for (const volEth of [0, 1, 5, 20, 50, 100, 200]) {
    const s = await measure(train, {
      ...DEFAULT_PARAMS,
      minVolumeWei: BigInt(volEth) * 10n ** 18n,
    });
    await record(`vol>=${String(volEth)}ETH`, s);
    process.stdout.write(`${fmt(`TRAIN vol>=${String(volEth)}ETH`, s)}\n`);
  }
  for (const nb of [0, 50, 200, 1000, 5000]) {
    const s = await measure(train, { ...DEFAULT_PARAMS, minBarsBefore: nb });
    await record(`swaps>=${String(nb)}`, s);
    process.stdout.write(`${fmt(`TRAIN swaps>=${String(nb)}`, s)}\n`);
  }
  process.stdout.write("\n");

  /* ══ 4. THE STOP — is it subtracting value? ══ */
  process.stdout.write("══ 4. STOP MODE on TRAIN ══\n");
  for (const stopMode of ["level", "none"] as const) {
    for (const stopLossBps of [235n, 1000n, 3000n]) {
      if (stopMode === "none" && stopLossBps !== 235n) continue;
      const s = await measure(train, { ...DEFAULT_PARAMS, stopMode, stopLossBps });
      await record(`stop=${stopMode}/${stopLossBps.toString()}`, s);
      process.stdout.write(`${fmt(`TRAIN stop=${stopMode} ${stopLossBps.toString()}`, s)}\n`);
    }
  }
  process.stdout.write("\n");

  /* ══ 5. EDGE MULTIPLE — sweepable at last ══ */
  process.stdout.write("══ 5. EDGE MULTIPLE on TRAIN (now threaded through DecideConfig) ══\n");
  for (const edgeMultiple of [1n, 2n, 3n, 4n, 6n, 8n]) {
    const s = await measure(train, { ...DEFAULT_PARAMS, edgeMultiple });
    await record(`edge=${edgeMultiple.toString()}`, s);
    process.stdout.write(`${fmt(`TRAIN edge=${edgeMultiple.toString()}`, s)}\n`);
  }
  process.stdout.write("\n");

  const trials = await trialLog.count();
  const best = await trialLog.best();
  process.stdout.write(
    `TRIALS SO FAR: ${String(trials)}   best-by-SR: ${best?.name ?? "none"} (${best?.sharpe.toFixed(3) ?? "-"})\n`,
  );

  // Overfitting assessment is deferred to `confirm.ts`, which is the only place a number is
  // reported on TEST. This file's job is the search, and a search does not get to report.
  void assessOverfitting;
  void assessSampleSize;
}

main().catch((e: unknown) => {
  process.stderr.write(`${String(e)}\n`);
  process.exitCode = 1;
});
