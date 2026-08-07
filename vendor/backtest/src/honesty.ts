/**
 * Guards against a backtest that lies.
 *
 * A trading agent can pass every type check, test and coverage threshold and still lose
 * money on every trade. Worse: it can produce a *backtest* that says it won't. This module
 * exists to make the second failure loud.
 *
 * The goal is NOT to prove profitability — that claim is usually unsupportable, and it is
 * never made to users. The goal is to attempt it honestly and report what the numbers can
 * and cannot support.
 *
 * ══ Why an autonomous agent is the dangerous case ══
 *
 * Backtest overfitting is well studied. The result that matters here is **MinBTL**
 * (Bailey, Borwein, López de Prado, Zhu): the minimum backtest length before a Sharpe
 * ratio means anything grows with the number of variants you tried.
 *
 *   MinBTL < 2·ln(N) / E[max SR]²
 *
 * With 5 years of data, **more than ~45 independent strategy variants almost guarantees an
 * in-sample Sharpe of 1.0 whose true out-of-sample Sharpe is zero.** The authors' own
 * verdict: *"there is no SR threshold or haircut that can be considered safe."*
 *
 * **An agent generating variants is a trial-count generator.** Required Sharpe grows as
 * √(2·ln N) while the data does not grow at all. So the trial counter must be persistent
 * and must NOT be resettable by the thing being counted — that constraint matters more
 * than any statistic computed afterwards.
 */

/** Sharpe needed for a result to be credible after N variants were tried. */
export function requiredSharpe(trials: number, yearsOfData: number): number {
  if (trials < 1) throw new Error("trials must be at least 1");
  if (yearsOfData <= 0) throw new Error("yearsOfData must be positive");
  // Expected max Sharpe under the null, from the Bailey et al. bound.
  return Math.sqrt(2 * Math.log(Math.max(trials, 2))) / Math.sqrt(yearsOfData);
}

/**
 * Minimum years of data before an observed Sharpe survives the trial count.
 *
 * Rearranged from the same bound. Answers the question people actually ask: "we tried N
 * things and the best had Sharpe S — is that worth anything?"
 */
export function minBacktestYears(trials: number, observedSharpe: number): number {
  if (observedSharpe <= 0) return Number.POSITIVE_INFINITY;
  return (2 * Math.log(Math.max(trials, 2))) / observedSharpe ** 2;
}

export type OverfitVerdict = {
  /** Does the result survive the number of variants tried? */
  readonly credible: boolean;
  readonly requiredSharpe: number;
  readonly observedSharpe: number;
  readonly minYearsNeeded: number;
  readonly yearsAvailable: number;
  /** Plain-language verdict, written to be pasted into a report unedited. */
  readonly verdict: string;
};

export function assessOverfitting(options: {
  readonly trials: number;
  readonly observedSharpe: number;
  readonly yearsAvailable: number;
}): OverfitVerdict {
  const { trials, observedSharpe, yearsAvailable } = options;
  const required = requiredSharpe(trials, yearsAvailable);
  const minYears = minBacktestYears(trials, observedSharpe);
  const credible = observedSharpe > required && yearsAvailable >= minYears;

  const verdict = credible
    ? `Sharpe ${observedSharpe.toFixed(2)} over ${yearsAvailable.toFixed(1)}y survives ${trials} trials ` +
      `(needed > ${required.toFixed(2)}). This is not a profitability guarantee — it is a result that ` +
      "has not been ruled out."
    : `Sharpe ${observedSharpe.toFixed(2)} does NOT survive ${trials} trials: needed > ${required.toFixed(2)} ` +
      `and ${minYears === Number.POSITIVE_INFINITY ? "infinite" : minYears.toFixed(1)} years of data, ` +
      `have ${yearsAvailable.toFixed(1)}. Treat this as noise.`;

  return {
    credible,
    requiredSharpe: required,
    observedSharpe,
    minYearsNeeded: minYears,
    yearsAvailable,
    verdict,
  };
}

/**
 * Persistent trial counter.
 *
 * Deliberately append-only with no reset method. The agent that generates variants must
 * not be able to zero the count that constrains it — if it can, the MinBTL check becomes
 * decorative. Persistence is injected so the real implementation writes to Postgres.
 */
export type TrialLog = {
  /** Record a variant that was evaluated. Returns the new total. */
  record(variant: { readonly name: string; readonly sharpe: number }): Promise<number>;
  count(): Promise<number>;
  best(): Promise<{ readonly name: string; readonly sharpe: number } | undefined>;
};

/** In-memory implementation, for tests. Production writes to durable storage. */
export function createMemoryTrialLog(): TrialLog {
  const trials: Array<{ name: string; sharpe: number }> = [];
  return {
    async record(variant) {
      trials.push({ ...variant });
      return trials.length;
    },
    async count() {
      return trials.length;
    },
    async best() {
      return trials.reduce<{ name: string; sharpe: number } | undefined>(
        (top, t) => (top === undefined || t.sharpe > top.sharpe ? t : top),
        undefined,
      );
    },
  };
}

export type SampleVerdict = {
  readonly sufficient: boolean;
  readonly needed: number;
  readonly have: number;
  readonly detail: string;
};

/**
 * Do we have enough trades for the mean return to mean anything?
 *
 * n ≥ 9·(σ/μ)² is the sample size for a t-statistic of 3 — the bar Harvey, Liu and Zhu
 * argue for in finance, precisely because the conventional t > 2 admits far too many
 * false discoveries once you account for how many things get tried.
 */
export function assessSampleSize(options: {
  readonly meanReturn: number;
  readonly stdDev: number;
  readonly trades: number;
}): SampleVerdict {
  const { meanReturn, stdDev, trades } = options;

  if (meanReturn <= 0) {
    return {
      sufficient: false,
      needed: Number.POSITIVE_INFINITY,
      have: trades,
      detail: "mean return is not positive — there is no edge to size a sample around",
    };
  }

  const needed = Math.ceil(9 * (stdDev / meanReturn) ** 2);
  const sufficient = trades >= needed;

  return {
    sufficient,
    needed,
    have: trades,
    detail: sufficient
      ? `${trades} trades clears the ${needed} needed for t > 3`
      : `${trades} trades is short of the ${needed} needed for t > 3 — the mean is not yet distinguishable from noise`,
  };
}

/**
 * Costs a naive backtest omits, each of which has flipped a real strategy's sign.
 *
 * Modelled as a checklist rather than a number because the failure is *forgetting* one,
 * not mis-estimating it. A backtest that ignores reverts on a chain where 22–30% of swaps
 * revert is not slightly optimistic — it is measuring a different activity.
 */
export type CostModel = {
  /** Measured from real pool state at the trade block, never a fixed percentage. */
  readonly slippageFromPoolState: boolean;
  readonly gasIncluded: boolean;
  /** Failed transactions still cost gas and change nothing. */
  readonly revertsIncluded: boolean;
  /** Protocol/LP fees on each swap. */
  readonly feesIncluded: boolean;
  /** Did the strategy's own size move the price it then traded against? */
  readonly priceImpactOfOwnSize: boolean;
};

export function assessCostModel(model: CostModel): {
  readonly ok: boolean;
  readonly missing: readonly string[];
} {
  const missing: string[] = [];
  if (!model.slippageFromPoolState)
    missing.push(
      "slippage is not measured from real pool state (a fixed % understates impact, which scales as α/(1+α))",
    );
  if (!model.gasIncluded) missing.push("gas is not included");
  if (!model.revertsIncluded)
    missing.push("reverted trades are not counted — they cost gas and achieve nothing");
  if (!model.feesIncluded) missing.push("swap fees are not included");
  if (!model.priceImpactOfOwnSize)
    missing.push(
      "the strategy's own price impact is ignored — replay only shows a path you did not move",
    );
  return { ok: missing.length === 0, missing };
}

/**
 * The report a human reads before any real money moves.
 *
 * Deliberately reports what the numbers **cannot** support alongside what they can. A
 * backtest result presented without its caveats is how a strategy gets funded on noise.
 */
export function formatHonestReport(options: {
  readonly overfit: OverfitVerdict;
  readonly sample: SampleVerdict;
  readonly costs: { readonly ok: boolean; readonly missing: readonly string[] };
  readonly venueNote?: string;
}): string {
  const { overfit, sample, costs, venueNote } = options;
  const lines: string[] = [];

  lines.push(overfit.credible ? "RESULT: not ruled out" : "RESULT: indistinguishable from noise");
  lines.push("");
  lines.push(`  overfitting  ${overfit.verdict}`);
  lines.push(`  sample size  ${sample.detail}`);

  if (!costs.ok) {
    lines.push("  cost model   INCOMPLETE:");
    for (const m of costs.missing) lines.push(`                 - ${m}`);
  } else {
    lines.push(
      "  cost model   complete (slippage from pool state, gas, reverts, fees, own impact)",
    );
  }

  if (venueNote) lines.push(`  venue        ${venueNote}`);

  lines.push("");
  lines.push("  This measures execution cost against historical state. It is NOT a");
  lines.push("  prediction, and no profitability claim may be made to users on this basis.");

  return lines.join("\n");
}
