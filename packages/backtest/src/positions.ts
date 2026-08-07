/**
 * POSITIONS — a generic entry/exit simulator for the strategy FAMILIES that `replay.ts` cannot
 * express.
 *
 * ══ WHY THIS MODULE EXISTS AND WHY IT IS NOT `replay.ts` ══
 *
 * `replay.ts` drives the real `decide()` from `@strays/hunt`. That is the right harness for
 * measuring the SHIPPED strategy, and it is what rounds 1-3 used. But `decide()` is one strategy:
 * short-horizon momentum breakout with a level stop and a derived take-profit. Rounds 1-3 swept
 * eleven variants of it and concluded "trading is unwinnable on this venue". That conclusion does
 * not follow from the evidence, and RESULTS.md §9.4 contains the refutation in its own table:
 * LEVCAT returned +2,780,347bps buy-and-hold while the strategy lost −421bps per trade on it.
 * A 225bps round trip is 2.25% — it is fatal only to a strategy that round-trips constantly with
 * a tight stop, which is exactly the only strategy that was ever tested.
 *
 * The families that were never tested share one property: they DO NOT ROUND TRIP. They enter once
 * and hold, and their exit is a trailing stop or a clock, not a fixed target. `decide()` cannot
 * express any of them — it has no trailing stop, no moving average, no notion of "enter at swap
 * N of the token's life". So this module builds the minimum machinery that can, while keeping
 * every guarantee `replay.ts` earned:
 *
 *  1. **NO LOOKAHEAD.** An entry rule at bar `i` may read bars strictly before `i` only, and the
 *     fill is at bar `i+1`. Identical to `replay.ts`'s rule, enforced by the same shape: entry
 *     rules receive `(bars, i)` and every one of them indexes strictly below `i`.
 *  2. **NO CENSORING.** RESULTS.md §9.5 recorded that `stopMode:"none"` posted a +213bps mean at
 *     an 88.3% win rate purely because losers never closed. A hold-forever family is *made* of
 *     that failure mode, so every position opened here is closed: if no exit rule fires, the
 *     position is MARKED TO MARKET at the token's last observed bar and booked as `end-of-data`.
 *     `simulate` cannot return fewer closed positions than it opened — a test pins it.
 *  3. **REAL COSTS.** `2 × taxPct` plus gas, per the token's OWN tax tier, charged on every
 *     position including the ones that are marked to market. Same formula as `roundTripCost` at
 *     the replay's position size, which `positions.test.ts` pins against it.
 *
 * ══ WHY POSITIONS ARE NOT TRADES ══
 *
 * A `Position` is deliberately a different type from `replay.ts`'s `Trade`, because the two mean
 * different things. A `Trade` is one round trip of a strategy that holds one position at a time.
 * A `Position` is one lottery ticket in a basket of many held simultaneously, and the honest
 * summary of a basket is its DISTRIBUTION — median, top-decile contribution, the fraction that
 * went to zero — not its mean. `describeBasket` reports all of that, because a mean alone on a
 * lottery-shaped payoff is the most misleading number available.
 */

import type { Bar, TokenBars } from "./series.js";
import { describe, quantile } from "./stats.js";

const BPS = 10_000n;

/**
 * Gas charged per round trip, in bps of the position, at the replay's 0.01 ETH position size.
 *
 * **MEASURED FROM `roundTripCost`, NOT ESTIMATED.** An earlier draft of this module used 32bps,
 * carried over from the `2 × tax + ~30bps` shorthand used in rounds 1-3's prose. The real figure
 * at `DEFAULT_PARAMS.startWei` and the measured 0.030024 gwei gas price is **8bps** — the prose
 * constant was roughly 4x too high. `positions.test.ts` pins this against `roundTripCost` at every
 * tax tier by exact equality rather than by tolerance, so the two cannot drift apart again.
 *
 * The error was conservative (it overcharged every position by 24bps and so understated every
 * return), but "conservative" is not "correct" and the authority is the function the live path
 * uses.
 */
export const GAS_BPS = 8;

/**
 * The measured round-trip cost for a token, in bps. `2 × tax` plus gas.
 *
 * This is the same number `roundTripCost` from `@strays/hunt` produces at `DEFAULT_PARAMS.startWei`
 * and `GAS_PRICE_WEI`, and `positions.test.ts` asserts the equality rather than trusting it. It is
 * duplicated as arithmetic here only so that a position can be costed without constructing a
 * `Candidate`; the authority remains `roundTripCost`.
 */
export function roundTripBps(taxPct: number): number {
  return 2 * taxPct * 100 + GAS_BPS;
}

export type ExitReason =
  | "trailing-stop"
  | "hard-stop"
  | "take-profit"
  | "time-exit"
  | "signal-exit"
  /** The position never resolved. Marked to market at the last observed bar. NEVER dropped. */
  | "end-of-data";

export type Position = {
  readonly token: string;
  readonly symbol: string;
  readonly taxPct: number;
  readonly entryIdx: number;
  readonly exitIdx: number;
  readonly entryTs: number;
  readonly exitTs: number;
  readonly entryPriceWei: bigint;
  readonly exitPriceWei: bigint;
  /** Price move entry fill to exit fill, in bps. Before cost. */
  readonly grossBps: number;
  /** `2 × tax + gas`, in bps. */
  readonly costBps: number;
  readonly netBps: number;
  readonly exitReason: ExitReason;
  readonly barsHeld: number;
  readonly heldSeconds: number;
  /** Peak price seen while the position was open, in bps above entry. The trailing-stop anchor. */
  readonly peakBps: number;
};

/**
 * AN ENTRY RULE. Given the token's bars and an index `i`, may this bar open a position?
 *
 * ══ THE NO-LOOKAHEAD CONTRACT, WHICH EVERY IMPLEMENTATION MUST HONOUR ══
 *
 * A rule receives the FULL bar array for indexing convenience — slicing it on every bar would be
 * O(n²) on a 38,867-bar token — and is contractually forbidden from reading index `i` or above.
 * That is a contract a type cannot enforce, so it is enforced by test instead: `positions.test.ts`
 * runs the MUTATION TEST from `replay.test.ts` against every rule exported here, corrupting all
 * bars from a cut index forward to a 1000× spike and asserting that every position opened before
 * the cut is byte-for-byte identical. A rule that peeked forward would see the spike and enter
 * differently, and the test would fail loudly.
 */
export type EntryRule = {
  readonly label: string;
  readonly admits: (bars: readonly Bar[], i: number) => boolean;
};

/**
 * AN EXIT RULE, evaluated on every bar after the fill.
 *
 * Exit rules are allowed to read the CURRENT bar, and that asymmetry with entry rules is correct
 * rather than a leak: an exit decision is a reaction to a price that has already printed, and it
 * fills at that same bar. This is the conservative direction for a trailing stop — the stop fires
 * at the first observed price beyond the level, which on this venue can be 10% past it, and that
 * gap is charged to the position rather than assumed away.
 */
export type ExitRule = {
  readonly label: string;
  /** Trailing stop distance from the running peak, in bps. `undefined` disables it. */
  readonly trailingStopBps?: number;
  /** Hard stop below ENTRY, in bps. `undefined` disables it. */
  readonly hardStopBps?: number;
  /** Fixed take-profit above entry, in bps. `undefined` disables it. */
  readonly takeProfitBps?: number;
  /** Maximum hold in seconds. `undefined` disables it. */
  readonly maxHoldSeconds?: number;
  /** Maximum hold in bars. `undefined` disables it. */
  readonly maxHoldBars?: number;
};

/** Price move from `from` to `to`, in bps. */
function moveBps(from: bigint, to: bigint): number {
  if (from <= 0n) return 0;
  return Number(((to - from) * BPS) / from);
}

/**
 * Open one position at `entryIdx` and run `exit` forward until something closes it.
 *
 * **Always returns a closed position.** If no rule fires the position is marked to market at the
 * last bar with reason `end-of-data`. This is the anti-censoring guarantee: a hold-forever family
 * that silently dropped its unresolved losers would post the §9.5 artifact (+213bps at an 88.3%
 * win rate) and it would be fiction.
 */
export function openAt(
  token: TokenBars,
  entryIdx: number,
  exit: ExitRule,
): Position | undefined {
  const bars = token.bars;
  const entry = bars[entryIdx];
  if (entry === undefined) return undefined;
  // A fill on the final bar has no forward bar to exit at, so there is no position to measure.
  if (entryIdx >= bars.length - 1) return undefined;

  let peakWei = entry.priceWei;
  let exitIdx = bars.length - 1;
  let reason: ExitReason = "end-of-data";

  for (let j = entryIdx + 1; j < bars.length; j++) {
    const b = bars[j];
    if (b === undefined) continue;
    if (b.priceWei > peakWei) peakWei = b.priceWei;

    const fromEntry = moveBps(entry.priceWei, b.priceWei);
    const fromPeak = moveBps(peakWei, b.priceWei);
    const heldSeconds = b.ts - entry.ts;

    // Order matters and is chosen to be PESSIMISTIC: a bar that breaches both a stop and a target
    // is booked as the stop. On an event-time series we cannot know which the price touched first
    // inside the swap, and assuming the favourable one is how a backtest manufactures returns.
    if (exit.hardStopBps !== undefined && fromEntry <= -exit.hardStopBps) {
      exitIdx = j;
      reason = "hard-stop";
      break;
    }
    if (exit.trailingStopBps !== undefined && fromPeak <= -exit.trailingStopBps) {
      exitIdx = j;
      reason = "trailing-stop";
      break;
    }
    if (exit.takeProfitBps !== undefined && fromEntry >= exit.takeProfitBps) {
      exitIdx = j;
      reason = "take-profit";
      break;
    }
    if (exit.maxHoldSeconds !== undefined && heldSeconds >= exit.maxHoldSeconds) {
      exitIdx = j;
      reason = "time-exit";
      break;
    }
    if (exit.maxHoldBars !== undefined && j - entryIdx >= exit.maxHoldBars) {
      exitIdx = j;
      reason = "time-exit";
      break;
    }
  }

  const exitBar = bars[exitIdx];
  if (exitBar === undefined) return undefined;
  const grossBps = moveBps(entry.priceWei, exitBar.priceWei);
  const costBps = roundTripBps(token.taxPct);
  return {
    token: token.address,
    symbol: token.symbol,
    taxPct: token.taxPct,
    entryIdx,
    exitIdx,
    entryTs: entry.ts,
    exitTs: exitBar.ts,
    entryPriceWei: entry.priceWei,
    exitPriceWei: exitBar.priceWei,
    grossBps,
    costBps,
    netBps: grossBps - costBps,
    exitReason: reason,
    barsHeld: exitIdx - entryIdx,
    heldSeconds: exitBar.ts - entry.ts,
    peakBps: moveBps(entry.priceWei, peakWei),
  };
}

export type SimulateOptions = {
  /**
   * Maximum positions per token. A basket strategy takes ONE ticket per token by default: taking
   * many re-entries on the same token converts a hold into a round-trip strategy, which is the
   * thing that already failed, and it correlates the "independent" tickets in the basket.
   */
  readonly maxPerToken?: number;
  /**
   * If true, a new position may not open while another is open on the same token. Prevents one
   * signal firing on twenty consecutive bars and booking twenty near-identical tickets.
   */
  readonly noOverlap?: boolean;
};

/**
 * Run `entry` and `exit` over every token. The fill is at bar `i+1` for a decision at bar `i`,
 * which is `replay.ts`'s rule verbatim.
 */
export function simulate(
  tokens: readonly TokenBars[],
  entry: EntryRule,
  exit: ExitRule,
  opts: SimulateOptions = {},
): readonly Position[] {
  const maxPerToken = opts.maxPerToken ?? 1;
  const noOverlap = opts.noOverlap ?? true;
  const out: Position[] = [];
  for (const token of tokens) {
    let taken = 0;
    let openUntil = -1;
    for (let i = 0; i < token.bars.length - 1; i++) {
      if (taken >= maxPerToken) break;
      if (noOverlap && i <= openUntil) continue;
      if (!entry.admits(token.bars, i)) continue;
      // THE FILL RULE: decided at `i`, filled at `i+1`.
      const p = openAt(token, i + 1, exit);
      if (p === undefined) continue;
      out.push(p);
      taken += 1;
      openUntil = p.exitIdx;
    }
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE ENTRY RULES. Each is a family RESULTS.md never tested.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/** Enter on the first eligible bar of the token's observed history. Pure buy-and-hold. */
export const firstBar: EntryRule = {
  label: "first-bar",
  admits: (_bars, i) => i === 0,
};

/**
 * EARLY ENTRY — enter at swap `n` of the token's observed life.
 *
 * The hypothesis is that the first swaps of a token carry information a later entry does not: the
 * pool is fresh, the tax has not yet compounded across a hundred round trips, and if the token is
 * going to run it has not yet run. This has never been tested and the data supports testing it —
 * the collector reads every pool from its launch block, so swap #1 is genuinely swap #1.
 */
export function atSwap(n: number): EntryRule {
  return { label: `swap-${String(n)}`, admits: (_bars, i) => i === n };
}

/**
 * DONCHIAN BREAKOUT — enter when the previous bar's price is the highest of the last `lookback`
 * bars, all strictly before the decision bar.
 *
 * Classic slow trend following. Distinct from the shipped momentum signal in the axis that
 * matters: it reacts to a NEW HIGH over a long window, not to a percentage move over 60 minutes,
 * and it is paired here with a trailing exit rather than a fixed target.
 */
export function donchian(lookback: number): EntryRule {
  return {
    label: `donchian-${String(lookback)}`,
    admits: (bars, i) => {
      if (i < lookback + 1) return false;
      const latest = bars[i - 1];
      if (latest === undefined) return false;
      for (let j = i - lookback - 1; j < i - 1; j++) {
        const b = bars[j];
        if (b !== undefined && b.priceWei >= latest.priceWei) return false;
      }
      return true;
    },
  };
}

/** Mean of `bars[from..to)` prices, as a bigint at the price scale. */
function meanPrice(bars: readonly Bar[], from: number, to: number): bigint | undefined {
  if (from < 0 || to <= from) return undefined;
  let sum = 0n;
  let n = 0n;
  for (let j = from; j < to; j++) {
    const b = bars[j];
    if (b === undefined) continue;
    sum += b.priceWei;
    n += 1n;
  }
  return n === 0n ? undefined : sum / n;
}

/**
 * MOVING-AVERAGE CROSSOVER — the fast mean crosses above the slow mean, both computed strictly
 * before the decision bar.
 *
 * Both means end at `i-1` inclusive, so the decision bar's own price is invisible to it. The cross
 * is detected as "fast above slow now, fast at or below slow one bar earlier", which requires the
 * state at `i-2` as well — also strictly in the past.
 */
export function maCross(fast: number, slow: number): EntryRule {
  return {
    label: `ma-${String(fast)}/${String(slow)}`,
    admits: (bars, i) => {
      if (i < slow + 2) return false;
      const fNow = meanPrice(bars, i - fast, i);
      const sNow = meanPrice(bars, i - slow, i);
      const fPrev = meanPrice(bars, i - fast - 1, i - 1);
      const sPrev = meanPrice(bars, i - slow - 1, i - 1);
      if (fNow === undefined || sNow === undefined || fPrev === undefined || sPrev === undefined) {
        return false;
      }
      return fNow > sNow && fPrev <= sPrev;
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE BASKET SUMMARY — the distribution, because a mean on a lottery payoff is a lie.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

export type Basket = {
  readonly n: number;
  readonly mean: number;
  readonly median: number;
  readonly stdDev: number;
  readonly p10: number;
  readonly p90: number;
  readonly max: number;
  readonly winRate: number;
  /** Fraction of positions that lost more than 90% — the "died" rate. */
  readonly ruinRate: number;
  /**
   * Share of the basket's TOTAL profit contributed by its top decile.
   *
   * On a lottery payoff this number is near 1 and that is the honest way to say "the mean is one
   * ticket". §8.3 measured 49% of profit in the top 1% of trades and only found it by looking;
   * here it is reported by construction so it cannot be omitted.
   */
  readonly topDecileShare: number;
  /** Mean with the top decile removed. If this is deeply negative the mean is a single ticket. */
  readonly meanExTopDecile: number;
  readonly byExit: readonly { readonly reason: ExitReason; readonly n: number; readonly mean: number }[];
};

export function describeBasket(positions: readonly Position[]): Basket {
  const net = positions.map((p) => p.netBps);
  const d = describe(net);
  const sorted = [...net].sort((a, b) => a - b);
  const cutIdx = Math.max(0, sorted.length - Math.max(1, Math.round(sorted.length * 0.1)));
  const top = sorted.slice(cutIdx);
  const rest = sorted.slice(0, cutIdx);
  const totalGain = sorted.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const topGain = top.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const reasons = [...new Set(positions.map((p) => p.exitReason))];
  return {
    n: d.n,
    mean: d.mean,
    median: d.median,
    stdDev: d.stdDev,
    p10: d.p10,
    p90: d.p90,
    max: d.max,
    winRate: net.length === 0 ? Number.NaN : net.filter((v) => v > 0).length / net.length,
    ruinRate: net.length === 0 ? Number.NaN : net.filter((v) => v <= -9_000).length / net.length,
    topDecileShare: totalGain === 0 ? Number.NaN : topGain / totalGain,
    meanExTopDecile: rest.length === 0 ? Number.NaN : rest.reduce((s, v) => s + v, 0) / rest.length,
    byExit: reasons.map((reason) => {
      const sub = positions.filter((p) => p.exitReason === reason).map((p) => p.netBps);
      return { reason, n: sub.length, mean: describe(sub).mean };
    }),
  };
}

/**
 * THE CONTROL. Random entries on the SAME tokens with the SAME exit rule and the SAME cost.
 *
 * ══ WHY THIS IS THE ONLY BASELINE THAT MEANS ANYTHING HERE ══
 *
 * 61% of this universe ended UP and buy-and-hold returns a mean of +31,681bps (§8.4). **Any
 * long-only rule on this universe therefore looks profitable**, and reporting one without this
 * control reports the survivorship bias measured in §8.4 as though it were a strategy. The
 * control differs from the signal arm in exactly one respect — WHERE it enters — so the
 * difference between them is the only thing attributable to the entry rule.
 *
 * `entriesPerToken` is drawn uniformly from the token's eligible bars, matching how many tickets
 * the signal arm bought on that token would over-weight tokens the signal happened to like; the
 * control is deliberately given a FLAT one-per-token draw repeated `entriesPerToken` times, which
 * is the same shape `matchedRandom` uses in `liquidity.ts`.
 */
export function randomBasket(
  tokens: readonly TokenBars[],
  exit: ExitRule,
  opts: { readonly perToken: number; readonly seed: number },
): readonly Position[] {
  // mulberry32, inlined rather than imported so the control's determinism does not depend on a
  // module whose seeding regime may change for the momentum arms.
  let a = opts.seed >>> 0;
  const rng = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const out: Position[] = [];
  for (const token of tokens) {
    const usable = token.bars.length - 1;
    if (usable < 1) continue;
    for (let k = 0; k < opts.perToken; k++) {
      const idx = Math.floor(rng() * usable);
      const p = openAt(token, idx, exit);
      if (p !== undefined) out.push(p);
    }
  }
  return out;
}

/**
 * The share of total basket profit in the top `frac` of positions, and the mean without them.
 * Exported for the report; `describeBasket` uses the decile.
 */
export function tailContribution(
  positions: readonly Position[],
  frac: number,
): { readonly share: number; readonly meanWithout: number } {
  const sorted = positions.map((p) => p.netBps).sort((a, b) => a - b);
  const k = Math.max(1, Math.round(sorted.length * frac));
  const top = sorted.slice(sorted.length - k);
  const rest = sorted.slice(0, sorted.length - k);
  const totalGain = sorted.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const topGain = top.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  return {
    share: totalGain === 0 ? Number.NaN : topGain / totalGain,
    meanWithout: rest.length === 0 ? Number.NaN : rest.reduce((s, v) => s + v, 0) / rest.length,
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE ONE-POSITION CONSTRAINT — the real product, and the test a basket result must survive.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A stray holds ~$5 with a 0.001 ETH floor. **It can hold ONE position.** Every basket number
 * above is therefore a per-ticket edge, not an achievable P&L — RESULTS.md §5 caveat 1 made
 * exactly this point about rounds 1-3 and it applies with far more force here, because a hold
 * family occupies the single slot for DAYS rather than minutes.
 *
 * ══ WHY THIS IS THE DECIDING TEST AND NOT A FOOTNOTE ══
 *
 * A basket of 106 tickets can afford a 30% loss rate because the winners are held simultaneously.
 * A single slot cannot: it must CHOOSE, in real time, without knowing which token will run, and
 * every day spent in a token that goes nowhere is a day not spent in the one that went 278x. The
 * basket mean is an upper bound that assumes infinite capital and perfect parallelism. This
 * function measures what one wallet actually earns.
 *
 * The selection rule is deliberately the only one available to a live agent: **take the first
 * eligible entry in chronological order, and refuse every other token until that position
 * closes.** No ranking, no foresight — a ranking rule would need to know which token was about to
 * run, which is the whole problem.
 */
export type PortfolioResult = {
  /** Positions actually taken by the single slot, in chronological order. */
  readonly taken: readonly Position[];
  /** Entries the signal fired that the slot was too busy to take. */
  readonly skipped: number;
  /** Compounded return of the sequence, in bps. This IS achievable P&L. */
  readonly compoundedBps: number;
  /** Fraction of the observed window the slot was actually holding something. */
  readonly utilisation: number;
};

/**
 * Run `positions` through a single-slot portfolio in chronological order.
 *
 * `positions` should be the full basket the signal produced; this picks the subset a one-slot
 * wallet could actually have held. Because a position's entry and exit timestamps are known, the
 * rule is exact: walk entries by time, take one if the slot is free, otherwise skip it.
 */
export function oneAtATime(positions: readonly Position[]): PortfolioResult {
  const byTime = [...positions].sort((a, b) => a.entryTs - b.entryTs);
  const taken: Position[] = [];
  let freeAt = Number.NEGATIVE_INFINITY;
  let skipped = 0;
  let held = 0;
  for (const p of byTime) {
    if (p.entryTs < freeAt) {
      skipped += 1;
      continue;
    }
    taken.push(p);
    freeAt = p.exitTs;
    held += p.exitTs - p.entryTs;
  }
  let equity = 1;
  for (const p of taken) {
    // A position cannot lose more than the stake. −10000bps is total loss and is the floor.
    equity *= 1 + Math.max(p.netBps, -10_000) / 10_000;
  }
  const first = byTime[0];
  const last = byTime[byTime.length - 1];
  const window =
    first === undefined || last === undefined ? 0 : Math.max(last.exitTs - first.entryTs, 1);
  return {
    taken,
    skipped,
    compoundedBps: (equity - 1) * 10_000,
    utilisation: window === 0 ? 0 : held / window,
  };
}
