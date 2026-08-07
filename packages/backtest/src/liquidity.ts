/**
 * LIQUIDITY — restricting the universe to genuinely traded tokens, and the controls that keep
 * that restriction from becoming a survivorship machine.
 *
 * ══ WHY THIS MODULE EXISTS: A TOKEN-LEVEL FILTER IS NOT A DECISION-TIME GATE ══
 *
 * RESULTS.md §8.2 reported that the participation floor (`minBarsBefore`) got monotonically WORSE
 * as it tightened, and that finding is real but it does NOT answer the question "are liquid tokens
 * profitable". The two are different filters and conflating them is the error this module fixes:
 *
 *  - `minBarsBefore` (in `replay.ts`) is a **decision-time cumulative counter**. It refuses entry
 *    until `n` swaps have already been observed *on that token*. On CryingCat (38,867 swaps) a
 *    floor of 5,000 does not select the token — the token was always in the universe — it merely
 *    DELAYS the first entry until swap 5,000, discarding the token's early history. It is a
 *    "trade the token late" filter, not a "trade liquid tokens" filter.
 *  - `LiquidityBand` here is a **token-level universe filter**, applied before the replay runs. It
 *    answers Ibrahim's actual question: restricted to tokens that genuinely trade, does the edge
 *    survive?
 *
 * Those can point in opposite directions, and measuring one while claiming the other is why §8's
 * result was surprising. Both are now reported side by side in `src/liquid.ts`.
 *
 * ══ THE SURVIVORSHIP TRAP, WHICH THIS MODULE IS BUILT AROUND ══
 *
 * Selecting "tokens that are big and liquid TODAY" is itself a survivorship filter — those are
 * precisely the tokens that went up, and §8.4 measured this universe's buy-and-hold mean at
 * +31,251bps with 63% of tokens ending up. A restricted universe will therefore look BETTER on
 * absolute return for reasons that have nothing to do with the strategy.
 *
 * The only defence is that every restricted universe must be scored against RANDOM ENTRIES ON THE
 * SAME RESTRICTED UNIVERSE with the SAME exit rule. `matchedRandom` exists so that control can
 * never be accidentally omitted or run against a different universe than the signal arm — it takes
 * the same token set and the same exit parameters the signal arm was given.
 */

import { randomEntries, welchT } from "./null.js";
import type { Trade } from "./replay.js";
import type { TokenBars } from "./series.js";
import { describe } from "./stats.js";

/**
 * A token-level liquidity criterion, evaluated on the REALISED SERIES rather than on any API
 * field.
 *
 * `minSwaps` counts bars actually present in the fold being measured, and `minSwapsPerHour` is
 * that count divided by the token's observed span. Both are computed from the same bars the replay
 * will trade, so a token cannot pass the filter on the strength of activity that the fold does not
 * contain. Neither reads a "today" value from the collector — `marketCapEth` is deliberately NOT
 * used, because it is a snapshot taken at collection time and applying it to a bar three weeks
 * earlier is lookahead of exactly the kind §8 was built to exclude.
 */
export type LiquidityBand = {
  readonly label: string;
  /** Minimum realised swap count within the fold. */
  readonly minSwaps: number;
  /** Minimum sustained swap frequency, swaps per hour, over the token's observed span. */
  readonly minSwapsPerHour: number;
};

/** Realised activity statistics for one token, computed from its bars alone. */
export type TokenActivity = {
  readonly symbol: string;
  readonly address: string;
  readonly swaps: number;
  readonly spanHours: number;
  readonly swapsPerHour: number;
  readonly taxPct: number;
};

export function activityOf(token: TokenBars): TokenActivity {
  const first = token.bars[0];
  const last = token.bars[token.bars.length - 1];
  const spanSeconds = first === undefined || last === undefined ? 0 : last.ts - first.ts;
  const spanHours = spanSeconds / 3600;
  return {
    symbol: token.symbol,
    address: token.address,
    swaps: token.bars.length,
    spanHours,
    // A token whose bars all land in one second has no meaningful rate. Reporting Infinity would
    // let it pass every frequency floor on the strength of a single block, so it scores 0 instead.
    swapsPerHour: spanHours <= 0 ? 0 : token.bars.length / spanHours,
    taxPct: token.taxPct,
  };
}

/** The tokens in `tokens` that meet `band`, measured on their bars in this fold. */
export function restrictTo(
  tokens: readonly TokenBars[],
  band: LiquidityBand,
): readonly TokenBars[] {
  return tokens.filter((t) => {
    const a = activityOf(t);
    return a.swaps >= band.minSwaps && a.swapsPerHour >= band.minSwapsPerHour;
  });
}

/**
 * THE BANDS. Chosen to bracket the live measurement Ibrahim reported (500-1200 holders, 100-400Ξ
 * of 24h volume on the genuinely active tokens) and to span from "everything" to "only the handful
 * of names a human would recognise", so the trend across bands is readable rather than a single
 * cherry-picked cut.
 */
export const BANDS: readonly LiquidityBand[] = [
  { label: "all", minSwaps: 0, minSwapsPerHour: 0 },
  { label: ">=100 swaps", minSwaps: 100, minSwapsPerHour: 0 },
  { label: ">=500 swaps", minSwaps: 500, minSwapsPerHour: 0 },
  { label: ">=1000 swaps", minSwaps: 1000, minSwapsPerHour: 0 },
  { label: ">=2000 swaps", minSwaps: 2000, minSwapsPerHour: 0 },
  { label: ">=5000 swaps", minSwaps: 5000, minSwapsPerHour: 0 },
  { label: ">=10000 swaps", minSwaps: 10000, minSwapsPerHour: 0 },
  { label: ">=20/hr sustained", minSwaps: 500, minSwapsPerHour: 20 },
  { label: ">=60/hr sustained", minSwaps: 500, minSwapsPerHour: 60 },
  { label: ">=100/hr sustained", minSwaps: 500, minSwapsPerHour: 100 },
];

/**
 * The tokens Ibrahim named, as a cohort.
 *
 * ══ WHY THIS RESOLVES BY ADDRESS AND NOT BY SYMBOL ══
 *
 * SYMBOLS ON THIS PAD ARE NOT UNIQUE, and matching on one silently pools a real token with its
 * copycats. Measured on this sample: `usdg` has 7 distinct addresses, `cashdog` and `cashcat` 6
 * each, `seriouscat` 5, and `CryingCat` 3 — one with 38,867 swaps and two with 483 and 10. A
 * symbol match on "CryingCat" would report the 38,867-swap token averaged together with two
 * near-dead impostors and call the result "CryingCat".
 *
 * The cohort is therefore pinned to the exact contract address of the token Ibrahim means, which
 * is resolved once as the highest-activity address carrying that symbol across the FULL sample
 * (not per fold — a fold-local resolution could pick a different contract in train than in test
 * and quietly compare two different tokens).
 */
export const NAMED_COHORT: readonly string[] = [
  "CryingCat",
  "INTERN",
  "WINK",
  "LEVCAT",
  "VIBECAT",
  "CHUDCAT",
  "Seriouscat",
  "CASHBIRD",
];

/**
 * Resolve each name to the single address with the most realised swaps in `universe`.
 *
 * `universe` should be the FULL token list, so the mapping is stable across folds.
 */
export function resolveCohort(
  universe: readonly TokenBars[],
  names: readonly string[] = NAMED_COHORT,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    let best: TokenBars | undefined;
    for (const t of universe) {
      if (t.symbol.toLowerCase() !== lower) continue;
      if (best === undefined || t.bars.length > best.bars.length) best = t;
    }
    if (best !== undefined) out.set(name, best.address);
  }
  return out;
}

/** The cohort tokens present in `tokens`, selected by the addresses `resolveCohort` pinned. */
export function cohort(
  tokens: readonly TokenBars[],
  addresses: ReadonlyMap<string, string>,
): readonly TokenBars[] {
  const want = new Set([...addresses.values()].map((a) => a.toLowerCase()));
  return tokens.filter((t) => want.has(t.address.toLowerCase()));
}

/**
 * THE CONTROL. Random entries on the SAME token set with the SAME exit rule, charged the SAME
 * measured cost, compared by Welch's t.
 *
 * `holdBars` is taken from what the signal arm ACTUALLY held (its mean `barsHeld`) rather than
 * from the configured horizon, because a time-exit arm whose take-profit fires early holds far
 * fewer bars than its horizon allows, and handing the random arm the nominal horizon would give it
 * a systematically longer exposure than the arm it is controlling for. On this universe longer
 * exposure is worth money (§8.4), so that mismatch would flatter the SIGNAL by understating the
 * control — the conservative direction is to match realised holds, which is what this does.
 *
 * The cost charged to the random arm, `2 × taxPct × 100 + 32`, is the same round-trip formula
 * `roundTripCost` produces at the replay's position size (verified against it in
 * `liquidity.test.ts`), so neither arm is advantaged on cost.
 */
export type RandomControl = {
  readonly n: number;
  readonly mean: number;
  readonly median: number;
  /** Welch t of signal minus random. Positive means the signal beat the coin flip. */
  readonly t: number;
  readonly df: number;
  readonly holdBars: number;
};

export function matchedRandom(
  tokens: readonly TokenBars[],
  signalTrades: readonly Trade[],
  opts: {
    readonly stopBps: bigint;
    readonly takeBps: bigint;
    readonly perToken: number;
    readonly seed: number;
  },
): RandomControl {
  const holdBars =
    signalTrades.length === 0
      ? 0
      : Math.max(
          1,
          Math.round(signalTrades.reduce((n, t) => n + t.barsHeld, 0) / signalTrades.length),
        );
  const raw = randomEntries(tokens, {
    perToken: opts.perToken,
    holdBars,
    stopBps: opts.stopBps,
    takeBps: opts.takeBps,
    seed: opts.seed,
  });
  const net = raw.map((x) => x.netBps - (2 * x.taxPct * 100 + 32));
  const d = describe(net);
  const w = welchT(
    signalTrades.map((t) => Number(t.netBps)),
    net,
  );
  return { n: d.n, mean: d.mean, median: d.median, t: w.t, df: w.df, holdBars };
}

/**
 * Per-token breakdown of a trade list. Ibrahim recognises these names, so the cohort result is
 * reported per token rather than only as a pooled mean — a pooled mean over 8 tokens can be
 * carried entirely by one of them, and this makes that visible instead of hiding it.
 */
export type TokenResult = {
  readonly symbol: string;
  readonly address: string;
  readonly trades: number;
  readonly meanNet: number;
  readonly medianNet: number;
  readonly winRate: number;
  readonly sumBps: number;
};

/**
 * Grouped by ADDRESS, not by symbol — see `resolveCohort` for why. Two tokens sharing a symbol are
 * two different assets and pooling them would report a blend under one recognisable name.
 */
export function byToken(trades: readonly Trade[]): readonly TokenResult[] {
  const byAddress = new Map<string, Trade[]>();
  for (const t of trades) {
    const list = byAddress.get(t.token) ?? [];
    list.push(t);
    byAddress.set(t.token, list);
  }
  const out: TokenResult[] = [];
  for (const [address, list] of byAddress) {
    const symbol = list[0]?.symbol ?? "?";
    const net = list.map((t) => Number(t.netBps));
    const d = describe(net);
    out.push({
      symbol,
      address,
      trades: list.length,
      meanNet: d.mean,
      medianNet: d.median,
      winRate: net.filter((v) => v > 0).length / net.length,
      sumBps: net.reduce((s, v) => s + v, 0),
    });
  }
  return out.sort((a, b) => b.trades - a.trades);
}

/**
 * BUY AND HOLD on a token set — the survivorship yardstick, reported alongside every restricted
 * universe.
 *
 * If a restricted universe's strategy return is below its own buy-and-hold, the "strategy" is a
 * worse way of holding the same tokens, and saying so requires having the number.
 */
export function buyAndHold(tokens: readonly TokenBars[]): {
  readonly n: number;
  readonly mean: number;
  readonly median: number;
  readonly upFraction: number;
} {
  const out: number[] = [];
  let up = 0;
  for (const t of tokens) {
    const a = t.bars[0]?.priceWei;
    const b = t.bars[t.bars.length - 1]?.priceWei;
    if (a === undefined || b === undefined || a <= 0n) continue;
    if (b > a) up++;
    out.push(Number(((b - a) * 10_000n) / a) - (2 * t.taxPct * 100 + 32));
  }
  const d = describe(out);
  return {
    n: d.n,
    mean: d.mean,
    median: d.median,
    upFraction: out.length === 0 ? Number.NaN : up / out.length,
  };
}
