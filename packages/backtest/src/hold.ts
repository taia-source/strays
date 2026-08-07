/**
 * ROUND 4, THE SEARCH — strategy FAMILIES rounds 1-3 never tested. **TRAIN ONLY.**
 *
 * This file searches and never reports a held-out number. `hold-confirm.ts` is the only file that
 * does. That separation is the one rounds 2 and 3 used and it is kept deliberately.
 *
 * ══ WHY A NEW SPLIT, AND WHY IT IS BY TOKEN LAUNCH TIME ══
 *
 * `load.ts`'s `splitAt` cuts by CALENDAR TIME and truncates each token's bars at the cut. That is
 * the right split for a strategy that round-trips inside a token's life: it asks "does a rule
 * fitted on the first 19.7 days survive the next 8.5?".
 *
 * It is the WRONG split for a buy-and-hold family, and the reason is structural rather than a
 * preference. A hold strategy opens one position near a token's birth and closes it days later.
 * Under a calendar cut, a token that launched on day 5 has its position truncated at day 19.7 in
 * the train fold and its *middle* handed to the test fold with no entry — so the train fold
 * systematically measures amputated holds and the test fold measures positions that were never
 * opened. The unit of observation for this family is the TOKEN, not the bar, so the split must be
 * by token: tokens that launched early are TRAIN, tokens that launched later are TEST, and each
 * token's full observed history goes with it.
 *
 * Both splits are honest; they answer different questions. This one is used here and `splitAt` is
 * used by rounds 1-3, and the difference is stated so the two rounds' numbers are not compared as
 * though they came from the same partition.
 *
 * ══ THE CONSTRAINT THIS SPLIT IMPOSES, WHICH IS SEVERE AND IS REPORTED ══
 *
 * The universe is the union of TODAY's `sort=mcap` and `sort=trending` lists, so token births are
 * violently non-uniform: 20% of tokens first trade before 2026-07-28 and the rest cluster into the
 * last ten days, with a huge spike on 2026-08-06. A 60/40 split by launch rank therefore puts the
 * TEST tokens in the final days of a 28-day window, where a hold has only hours of forward data.
 * `§B` measures exactly that — the forward span available per fold — because a "held-out" result
 * measured on positions that could not resolve is not a held-out result, it is a mark-to-market
 * snapshot of an unfinished trade.
 */

import {
  type EntryRule,
  type ExitRule,
  type Position,
  atSwap,
  describeBasket,
  donchian,
  firstBar,
  maCross,
  randomBasket,
  simulate,
  tailContribution,
} from "./positions.js";
import { loadTokens } from "./load.js";
import { welchT } from "./null.js";
import type { TokenBars } from "./series.js";

const DAY = 86_400;

/**
 * THE TOKEN-LEVEL SPLIT. Tokens ranked by the timestamp of their FIRST observed swap; the earliest
 * `frac` are TRAIN.
 *
 * Ranked rather than cut at a timestamp because the launch distribution is so lumpy that a
 * timestamp cut lands either 20 tokens or 400 on one side depending on which hour it falls in.
 * A rank cut fixes the fold sizes and makes the imbalance visible in the SPAN report instead of
 * hiding it in the token count.
 */
export function splitByLaunch(
  tokens: readonly TokenBars[],
  frac: number,
): { readonly train: readonly TokenBars[]; readonly test: readonly TokenBars[] } {
  const sorted = [...tokens].sort(
    (a, b) => (a.bars[0]?.ts ?? 0) - (b.bars[0]?.ts ?? 0),
  );
  const cut = Math.floor(sorted.length * frac);
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

/** Tokens with at least `n` realised swaps. The one universe filter this round uses. */
export function withMinSwaps(tokens: readonly TokenBars[], n: number): readonly TokenBars[] {
  return tokens.filter((t) => t.bars.length >= n);
}

/** Signal-vs-random on one arm. The ONLY form in which an arm is allowed to be reported. */
export type Arm = {
  readonly label: string;
  readonly n: number;
  readonly mean: number;
  readonly median: number;
  readonly winRate: number;
  readonly randomMean: number;
  readonly randomMedian: number;
  readonly t: number;
  readonly unresolvedPct: number;
  readonly topDecileShare: number;
  readonly meanExTopDecile: number;
};

export function measureArm(
  label: string,
  tokens: readonly TokenBars[],
  entry: EntryRule,
  exit: ExitRule,
  seed = 20260807,
): Arm {
  const sig = simulate(tokens, entry, exit);
  // The control gets ONE draw per token, matching the signal arm's one-ticket-per-token shape, and
  // the SAME exit rule. It differs from the signal arm in exactly one respect: where it enters.
  const rnd = randomBasket(tokens, exit, { perToken: 1, seed });
  const b = describeBasket(sig);
  const r = describeBasket(rnd);
  const w = welchT(
    sig.map((p) => p.netBps),
    rnd.map((p) => p.netBps),
  );
  const unresolved = sig.filter((p) => p.exitReason === "end-of-data").length;
  return {
    label,
    n: b.n,
    mean: b.mean,
    median: b.median,
    winRate: b.winRate,
    randomMean: r.mean,
    randomMedian: r.median,
    t: w.t,
    unresolvedPct: b.n === 0 ? Number.NaN : (unresolved / b.n) * 100,
    topDecileShare: b.topDecileShare,
    meanExTopDecile: b.meanExTopDecile,
  };
}

function row(a: Arm): string {
  return (
    `  ${a.label.padEnd(26)}${String(a.n).padStart(5)}` +
    `${a.mean.toFixed(0).padStart(10)}${a.median.toFixed(0).padStart(9)}` +
    `${(a.winRate * 100).toFixed(0).padStart(6)}%` +
    `${a.randomMean.toFixed(0).padStart(10)}${a.t.toFixed(2).padStart(8)}` +
    `${a.unresolvedPct.toFixed(0).padStart(7)}%` +
    `${(a.topDecileShare * 100).toFixed(0).padStart(7)}%` +
    `${a.meanExTopDecile.toFixed(0).padStart(10)}\n`
  );
}

const HEADER =
  "  arm                           n      mean   median   win%    random   WelchT  unres%  top10%  meanEx10\n";

/**
 * FORWARD SPAN available to a hold, per fold. The diagnostic that decides whether a held-out
 * number on this family means anything at all.
 */
function spanReport(label: string, tokens: readonly TokenBars[]): string {
  const spans = tokens
    .map((t) => {
      const a = t.bars[0]?.ts ?? 0;
      const b = t.bars[t.bars.length - 1]?.ts ?? 0;
      return (b - a) / DAY;
    })
    .sort((x, y) => x - y);
  const med = spans[Math.floor(spans.length / 2)] ?? Number.NaN;
  const mean = spans.reduce((s, v) => s + v, 0) / (spans.length || 1);
  return (
    `  ${label.padEnd(8)} tokens=${String(tokens.length).padStart(4)}  ` +
    `observed span days: median ${med.toFixed(2)}  mean ${mean.toFixed(2)}  ` +
    `max ${(spans[spans.length - 1] ?? 0).toFixed(1)}\n`
  );
}

async function main(): Promise<void> {
  const all = loadTokens();
  const { train, test } = splitByLaunch(all, 0.6);
  const trainL = withMinSwaps(train, 100);
  const testL = withMinSwaps(test, 100);

  process.stdout.write(
    "ROUND 4 SEARCH — NEW STRATEGY FAMILIES. TRAIN FOLD ONLY.\n" +
      "Nothing in this file is a held-out result. `hold-confirm.ts` reports on TEST.\n\n",
  );

  /* ══ B. THE SPAN DIAGNOSTIC — can a hold even resolve in each fold? ══ */
  process.stdout.write("══ B. FORWARD SPAN PER FOLD (a hold needs days; does it have them?) ══\n\n");
  process.stdout.write(spanReport("TRAIN", trainL));
  process.stdout.write(spanReport("TEST", testL));
  process.stdout.write(
    "\n  Read this before any mean below. If TEST tokens have hours rather than days of\n" +
      "  observed history, a 50% trailing stop cannot fire and the 'result' is an unclosed\n" +
      "  position marked to market, not a completed trade.\n\n",
  );

  /* ══ A. FAMILY 1 + 4: EARLY ENTRY, WIDE TRAILING STOP. The lead. ══ */
  process.stdout.write("══ A. EARLY ENTRY x TRAILING STOP — the lead, swept on TRAIN ══\n\n");
  process.stdout.write(HEADER);
  const entryIdxs = [5, 10, 20, 50, 100];
  const trails = [3_000, 5_000, 7_000, 9_000];
  for (const idx of entryIdxs) {
    for (const trail of trails) {
      process.stdout.write(
        row(
          measureArm(
            `entry@${String(idx)} trail${String(trail / 100)}%`,
            trainL,
            atSwap(idx),
            { label: "trail", trailingStopBps: trail },
          ),
        ),
      );
    }
  }

  /* ══ C. FAMILY 1: BUY AND HOLD WITH EXIT DISCIPLINE ══ */
  process.stdout.write("\n══ C. BUY AND HOLD — no stop, time limits, and trailing variants ══\n\n");
  process.stdout.write(HEADER);
  const holdArms: readonly { readonly label: string; readonly exit: ExitRule }[] = [
    { label: "hold-to-end", exit: { label: "none" } },
    { label: "hold 24h", exit: { label: "t", maxHoldSeconds: DAY } },
    { label: "hold 72h", exit: { label: "t", maxHoldSeconds: 3 * DAY } },
    { label: "hold 7d", exit: { label: "t", maxHoldSeconds: 7 * DAY } },
    { label: "trail30", exit: { label: "t", trailingStopBps: 3_000 } },
    { label: "trail50", exit: { label: "t", trailingStopBps: 5_000 } },
    { label: "trail50+hard80", exit: { label: "t", trailingStopBps: 5_000, hardStopBps: 8_000 } },
  ];
  for (const a of holdArms) {
    process.stdout.write(row(measureArm(`first-bar ${a.label}`, trainL, firstBar, a.exit)));
  }

  /* ══ D. FAMILY 3: TREND FOLLOWING AT A LONG HORIZON ══ */
  process.stdout.write("\n══ D. TREND FOLLOWING — Donchian and MA crossover, trailing exit ══\n\n");
  process.stdout.write(HEADER);
  const trendEntries: readonly EntryRule[] = [
    donchian(50),
    donchian(200),
    maCross(20, 100),
    maCross(50, 200),
  ];
  for (const e of trendEntries) {
    for (const trail of [3_000, 5_000]) {
      process.stdout.write(
        row(
          measureArm(`${e.label} trail${String(trail / 100)}%`, trainL, e, {
            label: "trail",
            trailingStopBps: trail,
          }),
        ),
      );
    }
  }

  /* ══ E. THE DISTRIBUTION OF THE LEAD ARM — a mean on a lottery payoff is a lie ══ */
  process.stdout.write("\n══ E. RETURN DISTRIBUTION of entry@20 trail50% on TRAIN ══\n\n");
  const lead = simulate(trainL, atSwap(20), { label: "trail", trailingStopBps: 5_000 });
  const b = describeBasket(lead);
  const t1 = tailContribution(lead, 0.01);
  const t10 = tailContribution(lead, 0.1);
  process.stdout.write(
    `  n=${String(b.n)}  mean ${b.mean.toFixed(0)}  median ${b.median.toFixed(0)}  ` +
      `sd ${b.stdDev.toFixed(0)}\n` +
      `  p10 ${b.p10.toFixed(0)}  p90 ${b.p90.toFixed(0)}  max ${b.max.toFixed(0)}\n` +
      `  win ${(b.winRate * 100).toFixed(1)}%  ruin(<=-90%) ${(b.ruinRate * 100).toFixed(1)}%\n` +
      `  top 1%  of positions = ${(t1.share * 100).toFixed(0)}% of all profit; mean without them ` +
      `${t1.meanWithout.toFixed(0)}\n` +
      `  top 10% of positions = ${(t10.share * 100).toFixed(0)}% of all profit; mean without them ` +
      `${t10.meanWithout.toFixed(0)}\n`,
  );
  process.stdout.write("\n  exit reason mix (the censoring check):\n");
  for (const e of b.byExit) {
    process.stdout.write(
      `    ${e.reason.padEnd(14)} n=${String(e.n).padStart(4)}  mean ${e.mean.toFixed(0).padStart(9)}\n`,
    );
  }

  /* ══ F. THE ONE-POSITION CONSTRAINT — the real product ══ */
  process.stdout.write(
    "\n══ F. ONE POSITION AT A TIME — see `oneAtATime` in positions-portfolio; reported in confirm ══\n",
  );
}

if (process.env["HOLD_SEARCH"] === "1") {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`);
    process.exitCode = 1;
  });
}

export type { Position };
