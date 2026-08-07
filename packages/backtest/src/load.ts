/**
 * LOADING THE COLLECTED SERIES, factored out of `run.ts`.
 *
 * `run.ts` executes its `main()` at module scope — importing it to reach `loadTokens` would run
 * the entire baseline report as a side effect. Every entrypoint that needs the data therefore
 * imports it from here instead, and `run.ts` does too.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type RawSeries, type TokenBars, toBars } from "./series.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadTokens(): readonly TokenBars[] {
  const raw = JSON.parse(
    readFileSync(join(HERE, "..", "data", "series.json"), "utf8"),
  ) as RawSeries[];
  return raw.map(toBars);
}

/**
 * ══ THE TRAIN/TEST SPLIT, AND WHY IT IS A SPLIT IN TIME RATHER THAN IN TOKENS ══
 *
 * A filter found on one sample and reported on the same sample is a curve fit, and MinBTL exists
 * to catch exactly that. Every threshold in this package is therefore chosen on TRAIN and reported
 * on TEST, which is data the search never saw.
 *
 * The split is by CALENDAR TIME, not by token, and the difference matters. Splitting by token
 * would let the fitted threshold benefit from knowing how the whole 28-day window behaved — the
 * market regime is shared across tokens, so a token-wise split leaks the regime. A time split
 * gives the honest question: does a rule fitted on the first N days survive the days after it?
 *
 * A token is assigned to a fold by TRADE TIME, not by token identity: bars before the cut are
 * TRAIN, bars at or after it are TEST. A token that spans the boundary contributes to both, with
 * its own history truncated at the cut in the train fold so no train decision can see past it.
 */
export type Fold = "train" | "test";

export function splitAt(
  tokens: readonly TokenBars[],
  cutTs: number,
  fold: Fold,
): readonly TokenBars[] {
  const out: TokenBars[] = [];
  for (const t of tokens) {
    // TRAIN truncates the series AT the cut. This is what makes the split honest: a train-fold
    // replay physically cannot read a bar from the test period, so a threshold fitted on train
    // has not seen the data it will be judged on.
    const bars = fold === "train" ? t.bars.filter((b) => b.ts < cutTs) : t.bars.filter((b) => b.ts >= cutTs);
    if (bars.length >= 2) out.push({ ...t, bars });
  }
  return out;
}

/** The timestamp at `frac` of the way through the observed range. */
export function cutTimestamp(tokens: readonly TokenBars[], frac: number): number {
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (const t of tokens) {
    for (const b of t.bars) {
      if (b.ts < lo) lo = b.ts;
      if (b.ts > hi) hi = b.ts;
    }
  }
  if (!Number.isFinite(lo)) throw new Error("no bars to split");
  return Math.round(lo + (hi - lo) * frac);
}
