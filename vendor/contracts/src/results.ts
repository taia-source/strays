/**
 * Judging a `forge test` run from its machine output, rather than from its exit code.
 *
 * ══ Why the exit code is not the answer ══
 *
 * `forge test` exits 0 in three situations that are not success, all verified on Foundry
 * 1.7.1 (commit 4072e48):
 *
 *   1. **Every call reverted.** `[PASS] invariant_x() (calls: 128000, reverts: 128000)`
 *      with `fail_on_revert = false`, the invariant default. Nothing was tested.
 *   2. **No test matched the filter.** A typo in `--match-test` prints
 *      `No tests found in project!` and exits **0**. A gate reading the exit code calls
 *      that green.
 *   3. **The campaign was truncated by a timeout.** `invariant.timeout` stops the run
 *      early and reports `status: "Success"`. Measured: a `runs = 100000` campaign with
 *      `timeout = 5` finished in 5.01s reporting `runs: 465`. There is no timeout field
 *      anywhere in the JSON — the shortfall in `runs` is the *only* evidence.
 *
 * Each of those is a green gate over an untested contract, so this module reads the
 * structured results and decides for itself.
 *
 * ══ Use --json; the metrics are in it ══
 *
 * I expected to have to scrape the `show_metrics` table off stdout. That turned out to be
 * unnecessary: `forge test --json` carries per-selector `calls`/`reverts`/`discards`
 * directly. Confirmed by running it —
 *
 *     "kind": { "Invariant": { "runs": 256, "calls": 128000, "reverts": 128000,
 *       "metrics": { "src/Counter.sol:RevertingHandler.poke":
 *         { "calls": 128000, "reverts": 128000, "discards": 0 } } } }
 *
 * — so vacuity detection is a field comparison rather than text parsing.
 *
 * ══ The trap in --json itself ══
 *
 * **stdout is not guaranteed to be JSON even with `--json`.** Both "no tests matched" and
 * a compile error print plain text there. So a parse failure must fail the gate rather
 * than be treated as "no results", and {@link parseForgeJson} throws rather than returning
 * an empty array. Returning `[]` would make the most dangerous case — a filter matching
 * nothing — indistinguishable from a clean run.
 *
 * Flags to avoid, all measured: `--json --detailed` produces **empty stdout**;
 * `--json --summary` silently replaces the detail with counts; `--gas-report --json`
 * replaces the test results entirely; `--junit` cannot combine with `--json` at all.
 * Plain `--json` is the one that works. Verbosity beyond default only inflates `traces`
 * (896 B → 114 KB for three trivial tests) without adding gate-relevant data.
 *
 * ══ Schema stability ══
 *
 * The shape is **de-facto**, serialised from Rust structs, with no published JSON Schema.
 * `optimization_best_value` and `failed_corpus_replays` are recent additions. So the
 * parser reads the fields it needs and tolerates unknown ones, rather than validating the
 * whole document — a strict schema would break on a Foundry upgrade that adds a field.
 */

export type TestStatus = "Success" | "Failure" | "Skipped";

/** Per-selector metrics, the `show_metrics` table as structured data. */
export type SelectorMetrics = {
  readonly calls: number;
  readonly reverts: number;
  readonly discards: number;
};

export type TestKind =
  | { readonly type: "unit"; readonly gas?: number | undefined }
  | { readonly type: "fuzz"; readonly runs: number }
  | {
      readonly type: "invariant";
      readonly runs: number;
      readonly calls: number;
      readonly reverts: number;
      readonly metrics: Readonly<Record<string, SelectorMetrics>>;
    };

export type TestResult = {
  readonly suite: string;
  readonly name: string;
  readonly status: TestStatus;
  readonly reason?: string | undefined;
  readonly kind: TestKind;
};

/**
 * Parse `forge test --json`.
 *
 * Throws on anything that is not the expected document. That is deliberate: the failure
 * modes this protects against — a filter that matched nothing, a compile error — both
 * emit non-JSON on stdout while exiting 0, and both must fail a gate rather than read as
 * an empty pass.
 */
export function parseForgeJson(stdout: string): TestResult[] {
  const trimmed = stdout.trim();

  if (trimmed.length === 0) {
    throw new Error(
      "forge produced no output. `--json --detailed` yields empty stdout — measured — so " +
        "check the flags; use plain `--json`",
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(trimmed);
  } catch {
    // The single most important branch here. `No tests found in project!` lands on
    // stdout with exit code 0, so silence would turn a filter typo into a green gate.
    const head = trimmed.slice(0, 120);
    throw new Error(
      `forge output was not JSON: "${head}". forge prints plain text to stdout and still ` +
        "exits 0 when no test matched the filter, and when compilation failed. Both are " +
        "gate failures, never empty passes",
    );
  }

  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("forge JSON was not an object of test suites");
  }

  const results: TestResult[] = [];

  for (const [suite, rawSuite] of Object.entries(document as Record<string, unknown>)) {
    if (typeof rawSuite !== "object" || rawSuite === null) continue;
    const testResults = (rawSuite as { test_results?: unknown }).test_results;
    if (typeof testResults !== "object" || testResults === null) continue;

    for (const [name, rawResult] of Object.entries(testResults as Record<string, unknown>)) {
      if (typeof rawResult !== "object" || rawResult === null) continue;
      const record = rawResult as { status?: unknown; reason?: unknown; kind?: unknown };

      const status =
        record.status === "Success" || record.status === "Failure" || record.status === "Skipped"
          ? record.status
          : undefined;
      if (status === undefined) {
        throw new Error(`unexpected status for ${suite}:${name} — ${String(record.status)}`);
      }

      results.push({
        suite,
        name,
        status,
        reason: typeof record.reason === "string" ? record.reason : undefined,
        kind: parseKind(record.kind),
      });
    }
  }

  return results;
}

/**
 * `kind` is an externally-tagged enum: exactly one of `Unit`, `Fuzz`, `Invariant`.
 *
 * An unrecognised tag becomes a unit result rather than an error — a future Foundry may
 * add a kind, and a gate that crashes on an upgrade is worse than one that treats an
 * unknown kind as an ordinary test.
 */
function parseKind(raw: unknown): TestKind {
  if (typeof raw !== "object" || raw === null) return { type: "unit" };
  const kind = raw as Record<string, unknown>;

  const invariant = kind.Invariant;
  if (typeof invariant === "object" && invariant !== null) {
    const inv = invariant as Record<string, unknown>;
    const metrics: Record<string, SelectorMetrics> = {};
    const rawMetrics = inv.metrics;

    if (typeof rawMetrics === "object" && rawMetrics !== null) {
      for (const [selector, value] of Object.entries(rawMetrics as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null) continue;
        const m = value as Record<string, unknown>;
        metrics[selector] = {
          calls: numberOr(m.calls, 0),
          reverts: numberOr(m.reverts, 0),
          discards: numberOr(m.discards, 0),
        };
      }
    }

    return {
      type: "invariant",
      runs: numberOr(inv.runs, 0),
      calls: numberOr(inv.calls, 0),
      reverts: numberOr(inv.reverts, 0),
      metrics,
    };
  }

  const fuzz = kind.Fuzz;
  if (typeof fuzz === "object" && fuzz !== null) {
    return { type: "fuzz", runs: numberOr((fuzz as Record<string, unknown>).runs, 0) };
  }

  const unit = kind.Unit;
  if (typeof unit === "object" && unit !== null) {
    const gas = (unit as Record<string, unknown>).gas;
    return typeof gas === "number" ? { type: "unit", gas } : { type: "unit" };
  }

  return { type: "unit" };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Effective `[invariant]` config, as `forge config --json` reports it. */
export type EffectiveInvariantConfig = {
  readonly runs: number;
  readonly failOnRevert: boolean;
  readonly depth: number;
  readonly timeout: number | null;
  readonly checkInterval: number;
};

/**
 * Read the **effective** invariant config.
 *
 * `forge config --json` resolves profile inheritance and env overrides, so this reports
 * what the run will actually use rather than what the TOML literally says. That matters
 * because `[invariant]` inherits unset values from `[fuzz]`: reading the file would miss
 * it, and verified — a `ci` profile declaring only `runs` correctly reported the
 * inherited `depth: 500`.
 */
export function parseForgeConfig(stdout: string): EffectiveInvariantConfig {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    throw new Error("`forge config --json` did not produce JSON — the run probably failed");
  }

  const invariant = (document as { invariant?: unknown } | null)?.invariant;
  if (typeof invariant !== "object" || invariant === null) {
    throw new Error("`forge config --json` had no [invariant] section");
  }

  const config = invariant as Record<string, unknown>;
  const timeout = config.timeout;

  return {
    runs: numberOr(config.runs, 0),
    failOnRevert: config.fail_on_revert === true,
    depth: numberOr(config.depth, 0),
    timeout: typeof timeout === "number" ? timeout : null,
    checkInterval: numberOr(config.check_interval, 1),
  };
}

export type GateProblem = {
  readonly rule: string;
  readonly severity: "high" | "medium";
  readonly test?: string | undefined;
  readonly message: string;
};

export type GateVerdict = {
  readonly ok: boolean;
  readonly problems: readonly GateProblem[];
  readonly counts: {
    readonly total: number;
    readonly invariants: number;
    readonly failed: number;
    readonly skipped: number;
  };
};

/**
 * Decide whether a contract test run may ship.
 *
 * Every rule below corresponds to a way a run exits 0 while proving nothing, and each was
 * reproduced before being encoded.
 *
 * `requireInvariants` defaults to **true**: a project with no invariant tests passes
 * `forge test` trivially, and for a contract holding money that absence is the finding.
 * A caller who genuinely has none can say so explicitly, which is a decision rather than
 * an oversight.
 */
export function judgeRun(options: {
  readonly results: readonly TestResult[];
  readonly config?: EffectiveInvariantConfig | undefined;
  readonly requireInvariants?: boolean | undefined;
  /** Fraction of calls that may revert before a campaign is called vacuous. */
  readonly maxRevertRatio?: number | undefined;
}): GateVerdict {
  const { results, config, requireInvariants = true, maxRevertRatio = 0.9 } = options;
  const problems: GateProblem[] = [];

  const invariants = results.filter((r) => r.kind.type === "invariant");
  const failed = results.filter((r) => r.status === "Failure");
  const skipped = results.filter((r) => r.status === "Skipped");

  for (const result of failed) {
    problems.push({
      rule: "test-failed",
      severity: "high",
      test: `${result.suite}:${result.name}`,
      message: result.reason ?? "failed without a stated reason",
    });
  }

  // A skipped test is not a pass — the same rule the TypeScript side enforces.
  for (const result of skipped) {
    problems.push({
      rule: "test-skipped",
      severity: "high",
      test: `${result.suite}:${result.name}`,
      message:
        "skipped tests are not passes. forge exits 0 with vm.skip, so nothing else reports this",
    });
  }

  if (requireInvariants && invariants.length === 0) {
    problems.push({
      rule: "no-invariant-tests",
      severity: "high",
      message:
        "the run contains no invariant tests. `forge test` passes trivially without them, " +
        "so a green result here says nothing about any property holding across call " +
        "sequences. Pass requireInvariants: false to make that a decision rather than an oversight",
    });
  }

  for (const result of invariants) {
    // UNREACHABLE, and no test can cover it. `invariants` is
    // `results.filter((r) => r.kind.type === "invariant")`, so every element already
    // satisfies this predicate — the invariant is established one line per element
    // earlier. It survives only because `Array.prototype.filter` without a type
    // predicate returns `TestResult[]` rather than the narrowed member, so `result.kind`
    // is still the full union and destructuring `calls`/`reverts`/`metrics` below will
    // not typecheck without it. Narrowing the filter instead would delete the branch,
    // but at the cost of a type predicate that asserts what this line proves.
    if (result.kind.type !== "invariant") continue;
    const { runs, calls, reverts, metrics } = result.kind;
    const test = `${result.suite}:${result.name}`;

    if (calls === 0) {
      problems.push({
        rule: "no-calls",
        severity: "high",
        test,
        message:
          "the campaign made zero calls — nothing was targeted. Check targetContract and " +
          "handler visibility",
      });
    } else if (reverts / calls >= maxRevertRatio) {
      problems.push({
        rule: "vacuous-campaign",
        severity: "high",
        test,
        message:
          `${reverts} of ${calls} calls reverted (${((reverts / calls) * 100).toFixed(1)}%)` +
          (reverts === calls
            ? " — EVERY call reverted, so the invariant never met any real state. Measured: " +
              "this exact shape reports PASS under the default fail_on_revert = false"
            : " — the fuzzer is mostly bouncing off the contract; bound the handler inputs"),
      });
    }

    // Per-selector, because one dead handler hides inside a healthy aggregate: a suite
    // with nine working handlers and one that always reverts still totals ~10% reverts.
    for (const [selector, m] of Object.entries(metrics)) {
      if (m.calls > 0 && m.reverts === m.calls) {
        problems.push({
          rule: "dead-handler",
          severity: "high",
          test,
          message:
            `handler ${selector} reverted on all ${m.calls} of its calls. The aggregate ratio ` +
            "can look healthy while one handler is entirely dead, so this is checked per selector",
        });
      }
    }

    /**
     * The timeout detector.
     *
     * `invariant.timeout` truncates a campaign and still reports Success — measured, a
     * `runs = 100000` campaign with `timeout = 5` reported `runs: 465`. No field records
     * that a timeout occurred, so the shortfall against the configured `runs` is the only
     * available evidence.
     */
    if (config !== undefined && runs < config.runs) {
      problems.push({
        rule: "campaign-truncated",
        severity: "high",
        test,
        message:
          `completed ${runs} of the configured ${config.runs} runs. A campaign stopped by ` +
          "invariant.timeout still reports Success and sets no flag anywhere in the JSON — " +
          "this shortfall is the only evidence that it was cut short",
      });
    }
  }

  if (config !== undefined && !config.failOnRevert) {
    problems.push({
      rule: "fail-on-revert-false",
      severity: "medium",
      message:
        "effective invariant fail_on_revert is false (the default; [fuzz] defaults to the " +
        "opposite). Reverts are then invisible unless something checks the metrics — which " +
        "is what this gate does, so this is a warning rather than a block",
    });
  }

  const blocking = problems.filter((p) => p.severity === "high");

  return {
    ok: blocking.length === 0,
    problems,
    counts: {
      total: results.length,
      invariants: invariants.length,
      failed: failed.length,
      skipped: skipped.length,
    },
  };
}

export function formatVerdict(verdict: GateVerdict): string {
  const { counts } = verdict;
  const header =
    `${counts.total} tests, ${counts.invariants} invariant campaign(s), ` +
    `${counts.failed} failed, ${counts.skipped} skipped`;

  if (verdict.ok && verdict.problems.length === 0) {
    return `contracts OK — ${header}`;
  }

  return [
    verdict.ok ? `contracts OK with warnings — ${header}` : `CONTRACTS BLOCKED — ${header}`,
    ...verdict.problems.map(
      (p) =>
        `  ${p.severity === "high" ? "✗" : "!"} [${p.rule}]${p.test ? ` ${p.test}` : ""}\n    ${p.message}`,
    ),
    "",
    "  forge exits 0 for a campaign where every call reverted, for a filter that matched",
    "  nothing, and for a campaign cut short by a timeout. The exit code is not the answer.",
  ].join("\n");
}
