/**
 * ROUND 5, PART 1 — THE SURVIVORSHIP KILL TEST.
 *
 * ══ THE ONE CAVEAT THAT COULD INVALIDATE ROUNDS 1-4 ══
 *
 * RESULTS.md §10.7 listed three things "NOT established" and named this as the one that routes
 * every remaining doubt: **every number in four rounds was computed on tokens drawn from TODAY's
 * `sort=mcap` and `sort=trending` lists.** A token only reaches those lists by surviving. Tokens
 * that launched, dumped and died never appear, so the corpus is conditioned on an outcome that
 * happens strictly AFTER the entry decision the strategy is being credited for.
 *
 * That is textbook survivorship bias and its direction is known: it inflates every absolute
 * return. What was NOT known is its MAGNITUDE, and whether the edge — which is a DIFFERENCE
 * between a signal arm and a matched-random arm on the same tokens — survives it. A difference is
 * far more robust to a shared bias than a level is, which is exactly why the matched-random
 * control was built. This file measures whether that defence holds.
 *
 * ══ THE MEASUREMENT, AND WHY IT IS CLEAN ══
 *
 * `forward.ts` collects the universe from the factory's `TokenLaunched` event, which fires at
 * launch, before any outcome exists. Every token that ever launched is in it. Because that corpus
 * carries a `listedToday` flag, the two universes are **nested**, and the comparison is exact:
 *
 *   SURVIVOR corpus  = forward corpus filtered to `listedToday === true`
 *   COMPLETE corpus  = the forward corpus, unfiltered
 *
 * Same collector, same decoder, same cost model, same split procedure, same control. **The ONLY
 * difference between the two arms is which tokens are in them**, so any difference in the result
 * is attributable to survivorship and to nothing else. Re-deriving the survivor arm from the
 * forward corpus rather than reusing `series.json` is deliberate: it removes collector version as
 * a confound.
 *
 * ══ WHAT WOULD KILL THE STRATEGY ══
 *
 * Stated before the numbers were seen, so the bar cannot move afterwards:
 *
 *  1. If the signal's median goes NEGATIVE on the complete universe, the strategy is dead.
 *  2. If the Welch t against matched random falls below 2 on the complete universe, the edge is
 *     not distinguishable from entering at random and the strategy is dead.
 *  3. If the dose-response (early entry beats late entry) inverts or flattens, the mechanism
 *     claimed in §10.4 was an artifact of the survivor filter and the strategy is dead.
 *
 * Any of those three is a kill. All three are reported whichever way they come out.
 */

import { readFileSync } from "node:fs";
import { welchT } from "./null.js";
import { type ExitRule, atSwap, describeBasket, randomBasket, simulate } from "./positions.js";
import { FORWARD_PATH, type ForwardSeries } from "./forward.js";
import { type RawSeries, type TokenBars, toBars } from "./series.js";

const DAY = 86_400;

/** A forward-collected token, with the survivorship flag it was collected with. */
export type ForwardToken = TokenBars & {
  readonly listedToday: boolean;
  readonly hook: string;
  /**
   * False if the pad's API would not describe this token and its `taxPct` is the 1% DEFAULT.
   *
   * Carried through to the analysis rather than discarded at load, because 1% is the pad's LOW
   * tier: every fallback is charged too little, which biases returns optimistic. §1c of
   * `survive-confirm.ts` bounds that bias by re-costing all of them at the top tier.
   */
  readonly taxFromApi: boolean;
};

/**
 * Load the forward corpus. Every token that emitted `TokenLaunched`, dead ones included.
 *
 * Tokens with fewer than 2 bars cannot produce a position at all — there is no forward bar to exit
 * at — so they are dropped HERE, at the loader, and their count is reported by the caller. They are
 * not a survivorship filter: a token that never traded has no price series for ANY strategy to act
 * on, and including it would add a row of `undefined` rather than a row of zero. The honest place
 * to account for them is the launch-to-tradeable funnel, which `report()` prints.
 */
export function loadForward(): readonly ForwardToken[] {
  const raw = JSON.parse(readFileSync(FORWARD_PATH, "utf8")) as ForwardSeries[];
  const out: ForwardToken[] = [];
  for (const r of raw) {
    if (r.swaps.length < 2) continue;
    const bars = toBars(r as RawSeries);
    out.push({
      ...bars,
      listedToday: r.listedToday,
      hook: r.hook,
      // Older corpora predate the flag; treat an absent flag as "not from the API", which is the
      // conservative reading — it routes the token into the worst-case tax check rather than
      // quietly exempting it.
      taxFromApi: r.taxFromApi === true,
    });
  }
  return out;
}

/** Median of a numeric array. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
}

/**
 * One arm measured against its OWN matched-random control across `seeds` seeds.
 *
 * The control is re-run per universe rather than shared, which is the whole point: a random entry
 * on the complete universe lands on dead tokens at their real frequency, so it absorbs exactly the
 * same survivorship bias the signal arm does. **The DIFFERENCE between the two is what survives
 * the bias**, and that difference is the only thing this package has ever claimed as an edge.
 */
export type SurvArm = {
  readonly label: string;
  readonly n: number;
  readonly mean: number;
  readonly medianBps: number;
  readonly winRate: number;
  readonly ruinRate: number;
  readonly randomMean: number;
  readonly randomMedian: number;
  readonly tMin: number;
  readonly tMed: number;
  readonly tMax: number;
  readonly tOver2: number;
  readonly unresolvedPct: number;
};

export function measureAgainstRandom(
  label: string,
  tokens: readonly TokenBars[],
  entryIdx: number,
  exit: ExitRule,
  seeds = 20,
): SurvArm {
  const sig = simulate(tokens, atSwap(entryIdx), exit);
  const b = describeBasket(sig);
  const netSig = sig.map((p) => p.netBps);
  const ts: number[] = [];
  const rMeans: number[] = [];
  const rMedians: number[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const rnd = randomBasket(tokens, exit, { perToken: 1, seed });
    const rb = describeBasket(rnd);
    ts.push(welchT(netSig, rnd.map((p) => p.netBps)).t);
    rMeans.push(rb.mean);
    rMedians.push(rb.median);
  }
  ts.sort((a, b2) => a - b2);
  const unresolved = sig.filter((p) => p.exitReason === "end-of-data").length;
  return {
    label,
    n: b.n,
    mean: b.mean,
    medianBps: b.median,
    winRate: b.winRate,
    ruinRate: b.ruinRate,
    randomMean: median(rMeans),
    randomMedian: median(rMedians),
    tMin: ts[0] ?? Number.NaN,
    tMed: median(ts),
    tMax: ts[ts.length - 1] ?? Number.NaN,
    tOver2: ts.filter((t) => t > 2).length,
    unresolvedPct: b.n === 0 ? Number.NaN : (unresolved / b.n) * 100,
  };
}

export function armRow(a: SurvArm): string {
  return (
    `  ${a.label.padEnd(22)}${String(a.n).padStart(5)}` +
    `${a.mean.toFixed(0).padStart(10)}${a.medianBps.toFixed(0).padStart(9)}` +
    `${(a.winRate * 100).toFixed(0).padStart(5)}%` +
    `${a.randomMedian.toFixed(0).padStart(10)}` +
    `${a.tMed.toFixed(2).padStart(8)}` +
    `${`${a.tMin.toFixed(2)}..${a.tMax.toFixed(2)}`.padStart(15)}` +
    `${`${String(a.tOver2)}/20`.padStart(7)}` +
    `${a.unresolvedPct.toFixed(0).padStart(7)}%\n`
  );
}

export const ARM_HEADER =
  "  arm                       n      mean   median  win%    random  WelchT        t range  t>2  unres\n";

/** Median observed span of a token set, in days. */
export function medianSpanDays(tokens: readonly TokenBars[]): number {
  return median(
    tokens.map((t) => ((t.bars[t.bars.length - 1]?.ts ?? 0) - (t.bars[0]?.ts ?? 0)) / DAY),
  );
}
