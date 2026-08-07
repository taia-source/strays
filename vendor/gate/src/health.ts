/**
 * Runtime health — what a deployed service must keep proving after the deploy is green.
 *
 * ══ The gap this closes ══
 *
 * A platform health check gates the deploy and then never checks anything meaningful
 * again. The usual endpoint is a shallow liveness probe, and it lies. Measured against a
 * server whose database was down and whose indexer was 50,000 blocks behind:
 *
 *   /health -> 200 "OK"                                    ← still passing
 *   /ready  -> 503 {"db":false,"indexerLag":50000}
 *
 * **`/health` returns 200 while the application is completely broken**, because all it
 * proves is that the process is running and can accept a socket. Railway (or any platform)
 * reports the deployment healthy indefinitely.
 *
 * ══ The distinction that matters ══
 *
 * - **Liveness** — is the process up? Failing it should cause a *restart*.
 * - **Readiness** — can it actually serve correct answers? Failing it should cause it to
 *   be *removed from rotation*, not restarted, because restarting does not fix a
 *   downstream outage and a restart loop makes things worse.
 *
 * Conflating them is why "healthy" is so often meaningless. A generated project gets both.
 *
 * ══ Why staleness is the headline check for an indexer ══
 *
 * This whole system's stated enemy is **silent wrongness**, not downtime. An indexer that
 * has stopped advancing is the purest form of it: every endpoint returns 200, every query
 * succeeds, and every answer is quietly out of date. Nothing throws. So indexer lag is a
 * first-class readiness signal here, not an afterthought.
 *
 * On a 100ms chain like 4663, lag needs to be expressed in **time, not blocks** — 50,000
 * blocks is under an hour and a half there, and about a week on a 12-second chain. A
 * threshold in blocks means completely different things per chain, which is exactly the
 * "a fact true of one chain is void on the next" rule.
 */

export type CheckStatus = "pass" | "warn" | "fail";

export type HealthCheck = {
  readonly name: string;
  readonly status: CheckStatus;
  /** What was observed, in terms someone can act on. */
  readonly detail: string;
};

/** A dependency the service cannot serve correct answers without. */
export type DependencyProbe = {
  readonly name: string;
  /** Resolve true when usable. Throwing is treated as a failure, with the message kept. */
  readonly check: () => Promise<boolean>;
  /**
   * Whether the service is unusable without this. A cache being down is degradation; the
   * primary database being down is not.
   */
  readonly required: boolean;
};

export async function probeDependency(probe: DependencyProbe): Promise<HealthCheck> {
  try {
    const ok = await probe.check();
    if (ok) return { name: probe.name, status: "pass", detail: "reachable" };
    return {
      name: probe.name,
      status: probe.required ? "fail" : "warn",
      detail: probe.required
        ? "unreachable, and the service cannot serve correct answers without it"
        : "unreachable — degraded, but the service can still answer",
    };
  } catch (error) {
    // A probe that throws is a failure, never an unknown. Treating an exception as
    // "inconclusive" is how a broken dependency gets reported as healthy.
    return {
      name: probe.name,
      status: probe.required ? "fail" : "warn",
      detail: `probe threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type IndexerLag = {
  readonly chainHead: bigint;
  readonly indexedHead: bigint;
  /** Seconds per block on THIS chain. 4663 is 0.1; most L1s are ~12. */
  readonly blockTimeSeconds: number;
};

export type LagPolicy = {
  /** Beyond this many seconds behind, the service is degraded. */
  readonly warnSeconds: number;
  /** Beyond this, it must not serve reads at all. */
  readonly failSeconds: number;
};

export const DEFAULT_LAG_POLICY: LagPolicy = { warnSeconds: 30, failSeconds: 300 };

/**
 * Judge indexer lag in **time**, not blocks.
 *
 * The same block count means wildly different things per chain: 50,000 blocks is ~83
 * minutes on 4663's 100ms blocks and about a week at 12s. A threshold in blocks silently
 * encodes an assumption about one chain that is void on the next.
 */
export function checkLag(lag: IndexerLag, policy: LagPolicy = DEFAULT_LAG_POLICY): HealthCheck {
  // Ahead of the head means a reorg was mishandled or the wrong chain is being read.
  // Either way it is not "zero lag", and reporting it as healthy would hide a real bug.
  if (lag.indexedHead > lag.chainHead) {
    return {
      name: "indexer-lag",
      status: "fail",
      detail:
        `indexed head ${lag.indexedHead} is AHEAD of chain head ${lag.chainHead} — ` +
        "a reorg was mishandled, or this is pointed at a different chain",
    };
  }

  const blocks = lag.chainHead - lag.indexedHead;
  const seconds = Number(blocks) * lag.blockTimeSeconds;
  const human = seconds < 90 ? `${seconds.toFixed(0)}s` : `${(seconds / 60).toFixed(1)} minutes`;
  const detail = `${blocks} blocks behind (~${human} at ${lag.blockTimeSeconds}s/block)`;

  if (seconds >= policy.failSeconds) {
    return {
      name: "indexer-lag",
      status: "fail",
      detail: `${detail} — past the ${policy.failSeconds}s ceiling. Every answer served now is quietly out of date`,
    };
  }
  if (seconds >= policy.warnSeconds) {
    return {
      name: "indexer-lag",
      status: "warn",
      detail: `${detail} — over the ${policy.warnSeconds}s target`,
    };
  }
  return { name: "indexer-lag", status: "pass", detail };
}

export type HealthReport = {
  /** Process is up. Failing this warrants a restart. */
  readonly live: boolean;
  /** Can serve correct answers. Failing this warrants removal from rotation, NOT a restart. */
  readonly ready: boolean;
  readonly checks: readonly HealthCheck[];
  /** The HTTP status a readiness endpoint should return. */
  readonly status: 200 | 503;
};

/**
 * Combine checks into a readiness verdict.
 *
 * `warn` never fails readiness: a degraded cache should not pull a working service out of
 * rotation. Only `fail` does. This is the difference between a health check that is acted
 * on and one that is muted.
 */
export function assessHealth(checks: readonly HealthCheck[]): HealthReport {
  const ready = !checks.some((c) => c.status === "fail");
  return { live: true, ready, checks, status: ready ? 200 : 503 };
}

export function formatHealth(report: HealthReport): string {
  const icon = (s: CheckStatus) => (s === "pass" ? "✓" : s === "warn" ? "!" : "✗");
  const lines = [
    report.ready ? `ready (HTTP ${report.status})` : `NOT READY (HTTP ${report.status})`,
    ...report.checks.map((c) => `  ${icon(c.status)} ${c.name}: ${c.detail}`),
  ];

  if (!report.ready) {
    lines.push("");
    lines.push("  Readiness failing means: remove from rotation. It does NOT mean restart —");
    lines.push("  restarting does not fix a downstream outage, and a restart loop makes it worse.");
  }
  return lines.join("\n");
}

/**
 * The endpoints a generated project must expose, and what each is for.
 *
 * Written down because the shallow-endpoint failure above is the default outcome when
 * nobody decides deliberately: one `/health` returning 200 forever.
 */
export const REQUIRED_ENDPOINTS: ReadonlyArray<{
  readonly path: string;
  readonly purpose: string;
  readonly onFailure: string;
}> = [
  {
    path: "/health",
    purpose: "liveness — the process is running and can accept a connection",
    onFailure: "restart the container",
  },
  {
    path: "/ready",
    purpose:
      "readiness — every required dependency is reachable AND the indexer is current. Returns 503 with a JSON body naming what failed",
    onFailure: "remove from rotation; do NOT restart",
  },
  {
    path: "/metrics",
    purpose:
      "indexer lag, error counts and request latency, so degradation is visible before it becomes an outage",
    onFailure: "alert only — a missing metrics endpoint is not itself an outage",
  },
];
