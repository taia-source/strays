/**
 * THE NULL HYPOTHESIS — the test the whole exercise exists to run.
 *
 * The recorded gap was: *"whether its entry signal predicts forward return is ARGUED, not
 * measured."* A backtest showing the strategy loses money does not, on its own, settle that. The
 * strategy could have a real edge that its cost bar eats, or no edge at all. Those are different
 * findings with different remedies, and only this comparison separates them:
 *
 *   - **Signal entries**: forward return after `evaluateEntry` says "breakout".
 *   - **Random entries**: forward return from a bar chosen uniformly at random on the SAME tokens,
 *     over the SAME holding period, with the SAME cost.
 *
 * If the two distributions are indistinguishable, the signal carries no information and no amount
 * of stop/lookback tuning can rescue it. If signal entries beat random GROSS but lose NET, the
 * signal is real and the tax is the binding constraint — a completely different conclusion.
 *
 * The random baseline is seeded and deterministic, so this is reproducible rather than a number
 * that changes every run.
 */

import type { Bar, TokenBars } from "./series.js";

/** Deterministic PRNG (mulberry32). Seeded so the null baseline is reproducible run to run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const BPS = 10_000n;

/**
 * Forward return in bps from entering at `entryIdx` and exiting after `holdBars` bars, or at the
 * first bar where the move breaches ±`stopBps` / `takeBps` — the same exit logic the real replay
 * applies, so the two are comparable.
 */
export function forwardBps(
  bars: readonly Bar[],
  entryIdx: number,
  holdBars: number,
  stopBps: bigint,
  takeBps: bigint,
): bigint | undefined {
  const entry = bars[entryIdx];
  if (entry === undefined) return undefined;
  const last = Math.min(entryIdx + holdBars, bars.length - 1);
  if (last <= entryIdx) return undefined;
  for (let j = entryIdx + 1; j <= last; j++) {
    const b = bars[j];
    if (b === undefined) continue;
    const move = ((b.priceWei - entry.priceWei) * BPS) / entry.priceWei;
    if (move <= -stopBps || move >= takeBps) return move;
  }
  const end = bars[last];
  if (end === undefined) return undefined;
  return ((end.priceWei - entry.priceWei) * BPS) / entry.priceWei;
}

/**
 * Draw `perToken` random entry bars from each token and return their forward returns.
 *
 * Entries are drawn only from bars that have at least `holdBars` of future data, so the random arm
 * is not penalised by truncation the signal arm does not suffer.
 */
export function randomEntries(
  tokens: readonly TokenBars[],
  opts: {
    readonly perToken: number;
    readonly holdBars: number;
    readonly stopBps: bigint;
    readonly takeBps: bigint;
    readonly seed: number;
  },
): { readonly netBps: number; readonly taxPct: number }[] {
  const rng = mulberry32(opts.seed);
  const out: { netBps: number; taxPct: number }[] = [];
  for (const token of tokens) {
    const usable = token.bars.length - opts.holdBars - 1;
    if (usable <= 1) continue;
    for (let k = 0; k < opts.perToken; k++) {
      const idx = 1 + Math.floor(rng() * usable);
      const fwd = forwardBps(token.bars, idx, opts.holdBars, opts.stopBps, opts.takeBps);
      if (fwd === undefined) continue;
      out.push({ netBps: Number(fwd), taxPct: token.taxPct });
    }
  }
  return out;
}

/**
 * Welch's t-test — two samples, unequal variances. Returns the t statistic and degrees of freedom.
 *
 * Welch rather than Student because the signal and random arms have neither equal variance nor
 * equal size, and pooling their variances under those conditions inflates the statistic in the
 * direction that flatters whichever arm is smaller.
 */
export function welchT(
  a: readonly number[],
  b: readonly number[],
): { readonly t: number; readonly df: number } {
  const mean = (x: readonly number[]): number => x.reduce((s, v) => s + v, 0) / x.length;
  const varc = (x: readonly number[], m: number): number =>
    x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1);
  if (a.length < 2 || b.length < 2) return { t: Number.NaN, df: Number.NaN };
  const ma = mean(a);
  const mb = mean(b);
  const va = varc(a, ma);
  const vb = varc(b, mb);
  const sa = va / a.length;
  const sb = vb / b.length;
  const t = (ma - mb) / Math.sqrt(sa + sb);
  const df = (sa + sb) ** 2 / (sa ** 2 / (a.length - 1) + sb ** 2 / (b.length - 1));
  return { t, df };
}
