/**
 * Load assessment — judging whether a service survives the spike that a launch *is*.
 *
 * ══ Why a launch is the specific case worth testing ══
 *
 * The best-documented step-function failure in this industry is Solana's 2021-09-14
 * outage, and it was triggered by exactly the event this system exists to produce: a token
 * launch (Grape Protocol's IDO on Raydium). The network stalled for ~17.5 hours and needed
 * a hard fork with 80% stake to restart.
 *
 * The transferable lesson is precise, and it is not "add more CPU". From the first-party
 * report: transactions *"flooded a system known as the forwarder queue, causing the memory
 * used by this queue to grow without limits."* **An unbounded queue converts a latency
 * problem into an OOM crash.** Anything that buffers without a cap is the thing that
 * breaks first.
 *
 * ══ The measurement that shaped this module ══
 *
 * Run against a local server returning HTTP 500 to 2% of requests and a 120ms tail to 5%:
 *
 *   { p50: 2, p97_5: 120, p99: 120,
 *     total: 4098, non2xx: 82, errors: 0, timeouts: 0 }
 *
 * **`errors: 0` while 82 responses were 500s.** In autocannon, `errors` counts socket and
 * timeout failures — an HTTP 500 is a *successful request* that returned a bad status. A
 * gate asserting `errors === 0` passes a service erroring on 2% of traffic. So this module
 * derives its error rate from `non2xx + errors + timeouts`, never from `errors` alone.
 *
 * Also measured, and worth stating because it is a silent footgun: **autocannon reports no
 * `p95`.** Its histogram exposes `p90` and `p97_5`. Code reading `result.latency.p95` gets
 * `undefined`, and `undefined < threshold` is `false` — a threshold that never fires.
 *
 * ══ Why this is not in the blocking gate ══
 *
 * Grafana's own guidance for k6 is to run **only smoke tests** in CI, and states plainly:
 * *"do not run larger tests in pipelines meant for automatic deployment"*, and *"unless
 * your verification process is mature, do not rely entirely on Pass/Fail results"*. A full
 * load test takes 3–15+ minutes and is inherently noisy.
 *
 * So the split here is deliberate: a **fast smoke test blocks**, a full load run reports.
 * `p95` is the gate metric; `p99` is advisory, because below a few thousand requests it is
 * dominated by noise and produces false failures.
 */

/** The shape autocannon returns. Declared structurally so this module needs no dependency. */
export type AutocannonLike = {
  readonly latency: Readonly<Record<string, number>> & { readonly p50?: number };
  readonly requests: { readonly average: number; readonly total: number };
  readonly non2xx?: number;
  readonly errors?: number;
  readonly timeouts?: number;
  readonly duration?: number;
};

export type LoadMetrics = {
  readonly p50: number;
  readonly p90: number;
  /** Interpolated: autocannon reports p90 and p97_5, never p95. */
  readonly p95: number;
  readonly p99: number;
  readonly requestsPerSecond: number;
  readonly totalRequests: number;
  /** Every failed request: bad statuses AND socket errors AND timeouts. */
  readonly failedRequests: number;
  readonly errorRate: number;
};

/**
 * Extract the metrics that matter, correcting two traps in the raw shape.
 *
 * `p95` is interpolated between the reported `p90` and `p97_5` rather than invented,
 * because the conventional gate metric is p95 and silently reading `undefined` is worse
 * than an honest estimate. The estimate is documented as such in `formatLoad`.
 */
export function extractMetrics(result: AutocannonLike): LoadMetrics {
  const l = result.latency;
  const p90 = l.p90 ?? 0;
  const p975 = l.p97_5 ?? p90;
  // Linear interpolation across the 90→97.5 span. Exact when the two are equal.
  const p95 = p90 + (p975 - p90) * ((95 - 90) / (97.5 - 90));

  const total = result.requests.total || 0;
  // non2xx is the one that matters and the one that is easy to miss: a 500 is a
  // "successful" request to autocannon. Measured: errors 0, non2xx 82.
  const failedRequests = (result.non2xx ?? 0) + (result.errors ?? 0) + (result.timeouts ?? 0);

  return {
    p50: l.p50 ?? 0,
    p90,
    p95,
    p99: l.p99 ?? 0,
    requestsPerSecond: result.requests.average || 0,
    totalRequests: total,
    failedRequests,
    errorRate: total > 0 ? failedRequests / total : 0,
  };
}

export type LoadThresholds = {
  /** The gate metric. k6's own documented example is `p(95)<200`. */
  readonly p95Ms: number;
  /** Advisory only — p99 is noise-dominated at small sample sizes. */
  readonly p99Ms?: number;
  /** k6's documented example is `rate<0.01`. */
  readonly maxErrorRate: number;
  /** Below this many requests, latency percentiles are not worth gating on. */
  readonly minRequests: number;
};

export const DEFAULT_THRESHOLDS: LoadThresholds = {
  p95Ms: 500,
  p99Ms: 1_500,
  maxErrorRate: 0.01,
  minRequests: 200,
};

export type LoadFinding = {
  readonly severity: "blocking" | "advisory";
  readonly detail: string;
};

export type LoadResult = {
  readonly ok: boolean;
  readonly metrics: LoadMetrics;
  readonly findings: readonly LoadFinding[];
};

export function assessLoad(
  result: AutocannonLike,
  thresholds: LoadThresholds = DEFAULT_THRESHOLDS,
): LoadResult {
  const metrics = extractMetrics(result);
  const findings: LoadFinding[] = [];

  // A run too small to be meaningful must not report a confident pass. Silence about a
  // measurement that did not really happen is the failure mode this whole gate opposes.
  if (metrics.totalRequests < thresholds.minRequests) {
    findings.push({
      severity: "blocking",
      detail:
        `only ${metrics.totalRequests} requests completed (floor is ${thresholds.minRequests}) — ` +
        "too few for a percentile to mean anything. This is not a pass; the test did not really run",
    });
  }

  if (metrics.errorRate > thresholds.maxErrorRate) {
    findings.push({
      severity: "blocking",
      detail:
        `${(metrics.errorRate * 100).toFixed(2)}% of requests failed ` +
        `(${metrics.failedRequests}/${metrics.totalRequests}), above the ` +
        `${(thresholds.maxErrorRate * 100).toFixed(2)}% ceiling. Counts non-2xx responses, ` +
        "not just socket errors — a 500 is a request that succeeded and returned a failure",
    });
  }

  if (metrics.totalRequests >= thresholds.minRequests && metrics.p95 > thresholds.p95Ms) {
    findings.push({
      severity: "blocking",
      detail: `p95 latency ${metrics.p95.toFixed(0)}ms exceeds the ${thresholds.p95Ms}ms budget`,
    });
  }

  if (
    thresholds.p99Ms !== undefined &&
    metrics.totalRequests >= thresholds.minRequests &&
    metrics.p99 > thresholds.p99Ms
  ) {
    findings.push({
      severity: "advisory",
      detail:
        `p99 latency ${metrics.p99.toFixed(0)}ms exceeds ${thresholds.p99Ms}ms — advisory only, ` +
        "because p99 is dominated by noise below a few thousand requests and would fail falsely",
    });
  }

  return { ok: !findings.some((f) => f.severity === "blocking"), metrics, findings };
}

/**
 * The saturation point: where throughput stops rising and latency runs away.
 *
 * Ramp in stages rather than spiking — a spike hits several limits at once and hides which
 * one bound the system. The knee is where added concurrency stops buying throughput.
 */
export type LoadStage = {
  readonly connections: number;
  readonly requestsPerSecond: number;
  readonly p95: number;
  readonly errorRate: number;
};

export type Saturation = {
  /** The last stage before throughput stopped improving, or undefined if it never did. */
  readonly kneeAt?: LoadStage;
  readonly detail: string;
};

export function findSaturation(stages: readonly LoadStage[]): Saturation {
  if (stages.length < 2) {
    return { detail: "need at least two stages to see a trend — no saturation point derivable" };
  }

  /**
   * ══ Destructure rather than index, so there is nothing to defend ══
   *
   * The guard above means this list always holds at least two dense elements, so
   * `ordered[i]` is never undefined — but `noUncheckedIndexedAccess` cannot see that, and
   * every way of telling it costs something:
   *
   *   `if (!prev || !cur) continue`   a branch no test can ever cover
   *   a coverage-ignore hint          suppresses it, and nothing can audit a suppression
   *   `ordered[i]!`                   an assertion that silently rots if the guard moves
   *   a non-empty tuple               does NOT help: a variable index into a tuple is
   *                                   still `T | undefined` — verified, tsc still errors
   *
   * Destructuring is the one that works. `first` is a **non-optional value** because it
   * comes from a rest pattern rather than a subscript, and carrying it forward through the
   * loop means no index access survives at all. The impossible branch stops existing
   * rather than being explained away, and nothing asserts anything the compiler must take
   * on trust.
   */
  const [first, ...rest] = [...stages].sort((a, b) => a.connections - b.connections) as [
    LoadStage,
    ...LoadStage[],
  ];
  let prev: LoadStage = first;
  let last: LoadStage = first;

  for (const cur of rest) {
    last = cur;

    // The knee: throughput gained less than 10% while concurrency rose. Latency rising
    // alongside confirms it, but flat throughput alone is enough — that is the definition.
    const gain =
      prev.requestsPerSecond > 0
        ? (cur.requestsPerSecond - prev.requestsPerSecond) / prev.requestsPerSecond
        : 1;

    if (gain < 0.1) {
      return {
        kneeAt: prev,
        detail:
          `saturated at about ${prev.connections} concurrent connections and ` +
          `${prev.requestsPerSecond.toFixed(0)} req/s — going to ${cur.connections} connections ` +
          `changed throughput by ${(gain * 100).toFixed(1)}% while p95 moved from ` +
          `${prev.p95.toFixed(0)}ms to ${cur.p95.toFixed(0)}ms. Past this point, more load ` +
          "buys latency rather than work",
      };
    }
    prev = cur;
  }

  // `last` was carried through the loop above, so it needs no index access and no
  // fallback — the same reason the loop does not.
  return {
    detail:
      `throughput was still climbing at ${last.connections} connections ` +
      `(${last.requestsPerSecond.toFixed(0)} req/s) — the saturation point is ABOVE the ` +
      "range tested, so this run does not tell you where the service breaks",
  };
}

export function formatLoad(result: LoadResult): string {
  const m = result.metrics;
  const lines = [
    result.ok ? "load: passed" : "LOAD FAILED",
    `  ${m.totalRequests} requests, ${m.requestsPerSecond.toFixed(0)} req/s`,
    `  p50 ${m.p50.toFixed(0)}ms · p90 ${m.p90.toFixed(0)}ms · p95 ~${m.p95.toFixed(0)}ms · p99 ${m.p99.toFixed(0)}ms`,
    `  ${m.failedRequests} failed (${(m.errorRate * 100).toFixed(2)}%)`,
  ];

  if (m.p90 !== m.p95) {
    lines.push("  (p95 is interpolated: autocannon reports p90 and p97_5, never p95)");
  }

  const blocking = result.findings.filter((f) => f.severity === "blocking");
  const advisory = result.findings.filter((f) => f.severity === "advisory");

  if (blocking.length > 0) {
    lines.push("", `  blocking (${blocking.length}):`);
    lines.push(...blocking.map((f) => `    ✗ ${f.detail}`));
  }
  if (advisory.length > 0) {
    lines.push("", `  advisory (${advisory.length}):`);
    lines.push(...advisory.map((f) => `    · ${f.detail}`));
  }
  return lines.join("\n");
}
