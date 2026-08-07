/**
 * STATS — the distribution, not just the mean.
 *
 * A mean return on a fat-tailed sample is the single most misleading number a backtest can print.
 * These pools produce returns spanning +5,000bps and −9,000bps, so the mean is dominated by
 * whichever tail happened to be sampled. Everything here reports the median and the quantiles
 * alongside it, and `sharpe()` is computed per-trade rather than annualised — see its own note.
 */

import type { Trade } from "./replay.js";

export type Distribution = {
  readonly n: number;
  readonly mean: number;
  readonly median: number;
  readonly stdDev: number;
  readonly min: number;
  readonly p10: number;
  readonly p25: number;
  readonly p75: number;
  readonly p90: number;
  readonly max: number;
};

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo];
  const b = sorted[hi];
  if (a === undefined || b === undefined) return Number.NaN;
  return a + (b - a) * (idx - lo);
}

export function describe(values: readonly number[]): Distribution {
  const n = values.length;
  if (n === 0) {
    return {
      n: 0,
      mean: Number.NaN,
      median: Number.NaN,
      stdDev: Number.NaN,
      min: Number.NaN,
      p10: Number.NaN,
      p25: Number.NaN,
      p75: Number.NaN,
      p90: Number.NaN,
      max: Number.NaN,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / n;
  // Sample standard deviation (n-1). With n=1 the variance is undefined, not zero — reporting
  // zero would make a single trade look infinitely precise, which is exactly the error MinBTL
  // exists to catch downstream.
  const stdDev =
    n < 2 ? Number.NaN : Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  return {
    n,
    mean,
    median: quantile(sorted, 0.5),
    stdDev,
    min: sorted[0] ?? Number.NaN,
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    max: sorted[n - 1] ?? Number.NaN,
  };
}

/**
 * Per-trade Sharpe: mean / stdDev of net returns.
 *
 * NOT annualised. Annualising requires a trade frequency assumption, and multiplying by
 * sqrt(trades per year) is precisely how a 19-day sample gets presented as a yearly figure. The
 * value fed to `assessOverfitting` is this raw per-trade ratio scaled by sqrt(n) to give the
 * sample's t-like statistic over the OBSERVED period — and `yearsAvailable` is the real observed
 * span in years, which for this sample is a small fraction of one. Both halves of the MinBTL
 * comparison therefore describe the same, short, real window.
 */
export function sharpePerTrade(netBps: readonly number[]): number {
  const d = describe(netBps);
  if (!Number.isFinite(d.stdDev) || d.stdDev === 0) return 0;
  return d.mean / d.stdDev;
}

export type Summary = {
  readonly trades: number;
  readonly wins: number;
  readonly winRate: number;
  readonly gross: Distribution;
  readonly net: Distribution;
  /** Compounded return of sequentially staking the same fraction, in bps. */
  readonly totalReturnBps: number;
  /** Worst peak-to-trough of the compounded equity curve, in bps. */
  readonly maxDrawdownBps: number;
  readonly sharpePerTrade: number;
  readonly byTax: readonly { readonly taxPct: number; readonly n: number; readonly meanNet: number }[];
  readonly byExit: readonly { readonly reason: string; readonly n: number; readonly meanNet: number }[];
};

export function summarise(trades: readonly Trade[]): Summary {
  const net = trades.map((t) => Number(t.netBps));
  const gross = trades.map((t) => Number(t.grossBps));
  const wins = net.filter((v) => v > 0).length;

  // Equity curve: each trade compounds on the last. This is the sequential-staking interpretation,
  // and it is the one that makes max drawdown meaningful.
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const bps of net) {
    equity *= 1 + bps / 10_000;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const taxes = [...new Set(trades.map((t) => t.taxPct))].sort((a, b) => a - b);
  const reasons = [...new Set(trades.map((t) => t.exitReason))];

  return {
    trades: trades.length,
    wins,
    winRate: trades.length === 0 ? Number.NaN : wins / trades.length,
    gross: describe(gross),
    net: describe(net),
    totalReturnBps: (equity - 1) * 10_000,
    maxDrawdownBps: maxDd * 10_000,
    sharpePerTrade: sharpePerTrade(net),
    byTax: taxes.map((taxPct) => {
      const sub = trades.filter((t) => t.taxPct === taxPct).map((t) => Number(t.netBps));
      return { taxPct, n: sub.length, meanNet: describe(sub).mean };
    }),
    byExit: reasons.map((reason) => {
      const sub = trades.filter((t) => t.exitReason === reason).map((t) => Number(t.netBps));
      return { reason, n: sub.length, meanNet: describe(sub).mean };
    }),
  };
}
