/**
 * ROUND 3, THE SEARCH — "are MATURE, LIQUID letscash tokens profitable where the whole pad is not?"
 *
 * Ibrahim's direction: stay on letscash, do not move venue, and test whether the mature-and-liquid
 * subset carries an edge that the pad-wide average washed out. The specific challenge is that
 * RESULTS.md §8.2 reported quality gates getting monotonically WORSE as they tightened, which
 * contradicts the live evidence that the genuinely active tokens run 500-1200 holders and 100-400Ξ
 * of daily volume.
 *
 * THIS FILE SEARCHES ON TRAIN AND NEVER REPORTS A HELD-OUT NUMBER. `liquid-confirm.ts` is the only
 * file that touches TEST, exactly as `explore.ts`/`confirm.ts` split those roles in round 2.
 *
 * ══ THE DIAGNOSIS OF §8.2, WHICH IS THE FIRST THING THIS FILE PRINTS ══
 *
 * The round-2 participation floor was `minBarsBefore`, a DECISION-TIME CUMULATIVE COUNTER: it
 * refuses entry until `n` swaps have been seen on that token. It never selected liquid tokens — it
 * delayed entry on whatever token was already there. Section A below runs both filters on the same
 * fold so the difference is measured rather than asserted.
 */

import { createMemoryTrialLog } from "@taia/backtest";
import { cutTimestamp, loadTokens, splitAt } from "./load.js";
import {
  BANDS,
  type LiquidityBand,
  activityOf,
  buyAndHold,
  cohort,
  matchedRandom,
  resolveCohort,
  restrictTo,
} from "./liquidity.js";
import { DEFAULT_PARAMS, type ReplayParams, replay } from "./replay.js";
import type { TokenBars } from "./series.js";
import { type Summary, summarise } from "./stats.js";

const DAY = 86_400;

function row(label: string, s: Summary, extra = ""): string {
  return (
    `${label.padEnd(26)} n=${String(s.trades).padStart(5)}  ` +
    `win ${(s.winRate * 100).toFixed(1).padStart(5)}%  ` +
    `net ${s.net.mean.toFixed(0).padStart(7)}bps  ` +
    `med ${s.net.median.toFixed(0).padStart(7)}bps  ` +
    `gross ${s.gross.mean.toFixed(0).padStart(7)}bps${extra}\n`
  );
}

async function measure(tokens: readonly TokenBars[], p: ReplayParams): Promise<Summary> {
  return summarise((await replay(tokens, p)).trades);
}

async function main(): Promise<void> {
  const tokens = loadTokens();
  const lo = Math.min(...tokens.map((t) => t.bars[0]?.ts ?? Number.POSITIVE_INFINITY));
  const hi = Math.max(...tokens.map((t) => t.bars[t.bars.length - 1]?.ts ?? 0));
  const cut = cutTimestamp(tokens, 0.7);
  const train = splitAt(tokens, cut, "train");

  process.stdout.write(
    `ROUND 3 SEARCH — TRAIN ONLY. ${String(train.length)} tokens, ` +
      `${((cut - lo) / DAY).toFixed(1)} days. Nothing here is a held-out number.\n` +
      `Full sample: ${String(tokens.length)} tokens, ${((hi - lo) / DAY).toFixed(1)} days.\n\n`,
  );

  const trialLog = createMemoryTrialLog();
  const record = async (name: string, s: Summary): Promise<void> => {
    await trialLog.record({ name, sharpe: s.sharpePerTrade });
  };

  /* ════════════════════════════════════════════════════════════════════════════════════════
     A. THE DIAGNOSIS — why §8.2's participation floor got worse, and what it actually measured.
     ════════════════════════════════════════════════════════════════════════════════════════ */
  process.stdout.write(
    "══ A. DECISION-TIME GATE vs TOKEN-LEVEL UNIVERSE FILTER ══\n" +
      "Both are 'require N swaps'. They are not the same filter and they do not agree.\n\n",
  );

  process.stdout.write("A1. minBarsBefore — the round-2 gate. Delays entry on a token already in the universe.\n");
  for (const nb of [0, 50, 200, 1000, 5000]) {
    const s = await measure(train, { ...DEFAULT_PARAMS, minBarsBefore: nb });
    await record(`gate/minBarsBefore=${String(nb)}`, s);
    process.stdout.write(row(`  minBarsBefore>=${String(nb)}`, s));
  }

  process.stdout.write("\nA2. Token-level universe restriction. Selects WHICH TOKENS are tradeable at all.\n");
  for (const band of BANDS) {
    const universe = restrictTo(train, band);
    if (universe.length === 0) continue;
    const s = await measure(universe, DEFAULT_PARAMS);
    await record(`universe/${band.label}`, s);
    process.stdout.write(row(`  ${band.label}`, s, `  tokens=${String(universe.length)}`));
  }

  /* ════════════════════════════════════════════════════════════════════════════════════════
     B. LONG HOLDS ON LIQUID TOKENS — amortising the toll.
     ════════════════════════════════════════════════════════════════════════════════════════ */
  process.stdout.write(
    "\n══ B. HOLD HORIZON on the liquid universe (>=2000 swaps) ══\n" +
      "A 218bps toll is the same whether the hold is 20 minutes or 3 days. Round 2 stopped at\n" +
      "168h with a take-profit that fired long before the horizon; these go further and pair each\n" +
      "horizon with take-profits wide enough that the HORIZON is what binds.\n\n",
  );
  const liquidBand: LiquidityBand = { label: ">=2000 swaps", minSwaps: 2000, minSwapsPerHour: 0 };
  const liquidTrain = restrictTo(train, liquidBand);
  process.stdout.write(
    `Liquid TRAIN universe: ${String(liquidTrain.length)} tokens, ` +
      `${String(liquidTrain.reduce((n, t) => n + t.bars.length, 0))} bars\n\n`,
  );

  for (const hours of [1, 6, 24, 72, 168, 336, 720]) {
    for (const tp of [471n, 2000n, 5000n, 20_000n]) {
      const s = await measure(liquidTrain, {
        ...DEFAULT_PARAMS,
        maxHoldSeconds: hours * 3600,
        takeProfitBps: tp,
      });
      await record(`liquid/hold=${String(hours)}h/tp=${tp.toString()}`, s);
      process.stdout.write(row(`  hold=${String(hours)}h tp=${tp.toString()}`, s));
    }
  }

  /* ════════════════════════════════════════════════════════════════════════════════════════
     C. STOP REMOVAL on the liquid universe — a liquid token gaps less, so the stop may behave
        differently here than it did pad-wide.
     ════════════════════════════════════════════════════════════════════════════════════════ */
  process.stdout.write(
    "\n══ C. STOP MODE on the liquid universe — and the CENSORING that makes it look good ══\n",
  );
  for (const stopMode of ["level", "none"] as const) {
    const r = await replay(liquidTrain, { ...DEFAULT_PARAMS, stopMode });
    const s = summarise(r.trades);
    await record(`liquid/stop=${stopMode}`, s);
    process.stdout.write(row(`  stop=${stopMode}`, s));
    // `stop=none` posts an 88% win rate, which is not an improvement — it is SURVIVAL BIAS INSIDE
    // THE TRADE LIST. Without a stop, a losing position is never closed; it stays open until the
    // data runs out and is booked as `end-of-data`. The winners resolve and are counted; many
    // losers never resolve at all, so the trade COUNT falls from 342 to 188. Printing the exit mix
    // is what makes that visible rather than letting the headline win rate stand.
    for (const e of s.byExit) {
      process.stdout.write(
        `      exit=${e.reason.padEnd(12)} n=${String(e.n).padStart(4)}  ` +
          `meanNet ${e.meanNet.toFixed(0).padStart(7)}bps\n`,
      );
    }
  }

  /* ════════════════════════════════════════════════════════════════════════════════════════
     D. THE SURVIVORSHIP YARDSTICK, PER BAND. This is the number that decides whether any of the
        above means anything, and it is printed next to the strategy rather than in a footnote.
     ════════════════════════════════════════════════════════════════════════════════════════ */
  process.stdout.write(
    "\n══ D. BUY-AND-HOLD PER BAND — the survivorship yardstick ══\n" +
      "Restricting to tokens that are big TODAY selects the tokens that WENT UP. If this column\n" +
      "rises with liquidity, then so will any strategy that holds these tokens, for no skill.\n\n",
  );
  for (const band of BANDS) {
    const universe = restrictTo(train, band);
    if (universe.length === 0) continue;
    const bh = buyAndHold(universe);
    process.stdout.write(
      `  ${band.label.padEnd(22)} tokens=${String(universe.length).padStart(4)}  ` +
        `B&H mean=${bh.mean.toFixed(0).padStart(8)}bps  median=${bh.median.toFixed(0).padStart(7)}bps  ` +
        `up=${(bh.upFraction * 100).toFixed(0)}%\n`,
    );
  }

  /* ════════════════════════════════════════════════════════════════════════════════════════
     E. THE MATCHED CONTROL, ON TRAIN. Run here too so the search itself is never misled by an
        absolute number — an arm that does not beat random on TRAIN is not carried to TEST.
     ════════════════════════════════════════════════════════════════════════════════════════ */
  process.stdout.write("\n══ E. SIGNAL vs RANDOM on the liquid TRAIN universe ══\n");
  process.stdout.write("  arm                          signal      random      diff   Welch t\n");
  for (const [hours, tp] of [
    [1, 471n],
    [24, 2000n],
    [168, 5000n],
    [720, 20_000n],
  ] as const) {
    const r = await replay(liquidTrain, {
      ...DEFAULT_PARAMS,
      maxHoldSeconds: hours * 3600,
      takeProfitBps: tp,
    });
    const s = summarise(r.trades);
    const ctrl = matchedRandom(liquidTrain, r.trades, {
      stopBps: DEFAULT_PARAMS.stopLossBps,
      takeBps: tp,
      perToken: 8,
      seed: 31,
    });
    process.stdout.write(
      `  hold=${String(hours)}h tp=${tp.toString()}`.padEnd(30) +
        `${s.net.mean.toFixed(0).padStart(8)}bps${ctrl.mean.toFixed(0).padStart(9)}bps` +
        `${(s.net.mean - ctrl.mean).toFixed(0).padStart(10)}${ctrl.t.toFixed(2).padStart(10)}\n`,
    );
  }

  /* ════════════════════════════════════════════════════════════════════════════════════════
     F. THE NAMED COHORT, on TRAIN. Reported per token in `liquid-confirm.ts`; here only to
        confirm the names resolve and to size the sample.
     ════════════════════════════════════════════════════════════════════════════════════════ */
  process.stdout.write(
    "\n══ F. NAMED COHORT presence on TRAIN (addresses pinned on the FULL sample) ══\n" +
      "Symbols on this pad are NOT unique — `CryingCat` alone has 3 addresses (38867, 483 and 10\n" +
      "swaps). Each name resolves to its highest-activity contract, so a copycat cannot be pooled\n" +
      "into a recognisable name's result.\n\n",
  );
  const addresses = resolveCohort(tokens);
  for (const t of cohort(train, addresses)) {
    const a = activityOf(t);
    process.stdout.write(
      `  ${a.symbol.padEnd(12)} ${String(a.swaps).padStart(6)} swaps  ` +
        `${a.swapsPerHour.toFixed(1).padStart(6)}/hr  tax=${String(a.taxPct)}%  ${a.address}\n`,
    );
  }

  const trials = await trialLog.count();
  const best = await trialLog.best();
  process.stdout.write(
    `\nROUND 3 TRIALS: ${String(trials)}   best-by-SR: ${best?.name ?? "none"} ` +
      `(${best?.sharpe.toFixed(3) ?? "-"})\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${String(e)}\n`);
  process.exitCode = 1;
});
