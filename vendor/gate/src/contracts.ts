/**
 * The contract security stage — the largest hole in the gate until now.
 *
 * Everything else here verifies TypeScript. Contracts are where the money is, and until
 * this existed a generated project could ship a reentrancy bug with a fully green gate.
 *
 * ══ Tool choices, verified by running them ══
 *
 * **aderyn** (Cyfrin, Rust, `@cyfrin/aderyn` on npm — no Rust toolchain needed). Verified
 * 0.6.8 against a contract with three planted bugs: it caught **all three** — reentrancy
 * (state change after external call), unchecked low-level call, and a privileged setter
 * with no zero-address check — across 88 detectors, and emits `.json` / `.sarif` / `.md`.
 * That combination of "actually finds real bugs" and "machine-readable" is what a gate
 * needs.
 *
 * **Dropped, on evidence:** Halmos has stalled ~12 months, mythril is dormant, and
 * 4naly3er and vertigo-rs are dead. Wiring a gate to an unmaintained analyzer buys a
 * false sense of coverage and a future breakage.
 *
 * **Slither** stays optional rather than required: it is excellent but needs a Python
 * toolchain that a generated project may not have. When present, its findings merge in.
 *
 * ══ Why coverage is not the gate ══
 *
 * `forge coverage` with `--via-ir` has been unreliable for roughly four years
 * (foundry#3357, still open; `--ir-minimum` is documented as producing inaccurate source
 * maps). More fundamentally, coverage proves a line **executed**, not that any assertion
 * would notice it breaking. Gate on tests passing and on high-severity findings; track
 * coverage as a trend.
 *
 * Mutation testing is the honest substitute, and it is deliberately NOT in the blocking
 * path: 1,000 mutants against a five-minute suite is ~83 hours. Nightly and scoped.
 */

export type ContractSeverity = "high" | "medium" | "low";

export type ContractFinding = {
  readonly tool: string;
  readonly severity: ContractSeverity;
  readonly title: string;
  readonly file?: string;
  readonly line?: number;
};

/** Shape aderyn actually emits, confirmed by running it. */
type AderynIssue = {
  title?: string;
  instances?: Array<{ contract_path?: string; line_no?: number }>;
};
type AderynReport = {
  high_issues?: { issues?: AderynIssue[] };
  low_issues?: { issues?: AderynIssue[] };
};

export function parseAderyn(json: string): ContractFinding[] {
  let report: AderynReport;
  try {
    report = JSON.parse(json) as AderynReport;
  } catch {
    throw new Error("aderyn output was not valid JSON — the run probably failed; check its stderr");
  }

  const collect = (issues: AderynIssue[] | undefined, severity: ContractSeverity) =>
    (issues ?? []).flatMap((issue) => {
      const instances = issue.instances ?? [];
      const title = issue.title ?? "untitled finding";
      if (instances.length === 0) return [{ tool: "aderyn", severity, title }];
      return instances.map((i) => ({
        tool: "aderyn",
        severity,
        title,
        ...(i.contract_path ? { file: i.contract_path } : {}),
        ...(i.line_no !== undefined ? { line: i.line_no } : {}),
      }));
    });

  return [
    ...collect(report.high_issues?.issues, "high"),
    ...collect(report.low_issues?.issues, "low"),
  ];
}

/** Slither's `--json` findings, merged when a Python toolchain is available. */
type SlitherDetector = {
  check?: string;
  impact?: string;
  description?: string;
  elements?: Array<{ source_mapping?: { filename_relative?: string; lines?: number[] } }>;
};

export function parseSlither(json: string): ContractFinding[] {
  let parsed: { results?: { detectors?: SlitherDetector[] } };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    throw new Error(
      "slither output was not valid JSON — the run probably failed; check its stderr",
    );
  }

  return (parsed.results?.detectors ?? []).map((d) => {
    const impact = (d.impact ?? "").toLowerCase();
    const severity: ContractSeverity =
      impact === "high" || impact === "critical" ? "high" : impact === "medium" ? "medium" : "low";
    const first = d.elements?.[0]?.source_mapping;
    return {
      tool: "slither",
      severity,
      title: d.check ?? d.description?.split("\n")[0] ?? "untitled finding",
      ...(first?.filename_relative ? { file: first.filename_relative } : {}),
      ...(first?.lines?.[0] !== undefined ? { line: first.lines[0] } : {}),
    };
  });
}

export type ContractPolicy = {
  /** Findings at or above this severity fail the gate. Default "high". */
  readonly failOn: ContractSeverity;
  /**
   * Titles knowingly accepted, each with a reason.
   *
   * A reason is mandatory for the same purpose as everywhere else in this system: it
   * forces the exemption to be a decision someone wrote down rather than an accident.
   */
  readonly accepted?: Readonly<Record<string, string>>;
};

export const DEFAULT_CONTRACT_POLICY: ContractPolicy = { failOn: "high" };

const RANK: Record<ContractSeverity, number> = { low: 0, medium: 1, high: 2 };

export type ContractResult = {
  readonly ok: boolean;
  readonly blocking: readonly ContractFinding[];
  readonly informational: readonly ContractFinding[];
  readonly accepted: readonly ContractFinding[];
};

export function assessContracts(
  findings: readonly ContractFinding[],
  policy: ContractPolicy = DEFAULT_CONTRACT_POLICY,
): ContractResult {
  const accepted: ContractFinding[] = [];
  const blocking: ContractFinding[] = [];
  const informational: ContractFinding[] = [];

  for (const f of findings) {
    const reason = policy.accepted?.[f.title];
    if (reason !== undefined && reason.trim() !== "") {
      accepted.push(f);
      continue;
    }
    if (RANK[f.severity] >= RANK[policy.failOn]) blocking.push(f);
    else informational.push(f);
  }

  return { ok: blocking.length === 0, blocking, informational, accepted };
}

/**
 * The stages a contract project must pass, in order.
 *
 * Ordered by cost: a compile failure should not wait behind a fuzz campaign. Each carries
 * why it exists, because a stage nobody understands is a stage someone deletes.
 */
export const CONTRACT_STAGES: ReadonlyArray<{
  readonly name: string;
  readonly command: string;
  readonly blocking: boolean;
  readonly why: string;
}> = [
  {
    name: "build",
    command: "forge build",
    blocking: true,
    why: "nothing downstream means anything if it does not compile",
  },
  {
    name: "test",
    // `--json`, not bare `forge test`: the exit code alone cannot see a vacuous campaign,
    // and `@taia/contracts` judgeRun reads the structured results. Plain `--json` only —
    // `--detailed` yields EMPTY stdout and `--summary` silently drops the detail.
    command: "forge test --json",
    blocking: true,
    why:
      "the whole suite, judged by @taia/contracts rather than by the exit code — forge " +
      "exits 0 for a campaign where every call reverted, for a filter that matched " +
      "nothing, and for a campaign cut short by invariant.timeout",
  },
  {
    name: "fuzz",
    command: "forge test --fuzz-runs 1000 --json",
    blocking: true,
    why: "random inputs find the edge cases hand-written tests encode assumptions around",
  },
  {
    name: "invariant",
    // NOT `--match-test invariant`: a filter that matches nothing prints "No tests found
    // in project!" and exits **0** — verified on 1.7.1. The full run is judged instead,
    // and judgeRun blocks when it contains no invariant campaign at all.
    command: "forge test --json",
    blocking: true,
    why:
      "properties that must hold across ANY sequence of calls. Judged on the campaign " +
      "metrics in the JSON (calls/reverts/discards per selector), because fail_on_revert " +
      "defaults to FALSE for invariants — the opposite of fuzz — so a handler that always " +
      "reverts otherwise reports PASS at 128,000 calls",
  },
  {
    name: "config",
    command: "forge config --json",
    blocking: true,
    why:
      "the EFFECTIVE settings after profile inheritance. [invariant] inherits unset values " +
      "from [fuzz], so reading foundry.toml misses it — and a campaign truncated by " +
      "invariant.timeout reports Success with no flag anywhere, detectable only by " +
      "comparing completed runs against the configured runs",
  },
  {
    name: "aderyn",
    command: "aderyn . -o aderyn.json",
    blocking: true,
    why: "88 detectors; verified to catch reentrancy, unchecked calls and missing zero-address checks",
  },
  {
    name: "slither",
    command: "slither . --json slither.json",
    blocking: false,
    why: "excellent, but needs a Python toolchain a generated project may not have — merged when present",
  },
  {
    name: "coverage",
    command: "forge coverage",
    blocking: false,
    why:
      "tracked as a trend, never gated: it proves a line executed, not that an assertion " +
      "would catch it breaking, and --via-ir has been unreliable for years",
  },
  {
    name: "mutation",
    command: "slither-mutate . --test-cmd 'forge test'",
    blocking: false,
    why:
      "the honest substitute for coverage — but 1,000 mutants against a 5-minute suite is " +
      "~83 hours, so nightly and scoped to changed contracts, never in the blocking path",
  },
];

export function formatContracts(result: ContractResult): string {
  if (result.ok && result.informational.length === 0 && result.accepted.length === 0) {
    return "no contract findings";
  }

  const lines: string[] = [];
  const show = (f: ContractFinding) =>
    `  ${f.severity.toUpperCase().padEnd(7)} [${f.tool}] ${f.title}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ""}` : ""}`;

  if (result.blocking.length > 0) {
    lines.push(`CONTRACT GATE FAILED — ${result.blocking.length} blocking finding(s):`);
    lines.push(...result.blocking.map(show));
    lines.push("");
    lines.push("  A green gate is necessary, never sufficient, for code that holds money.");
    lines.push("  Every line still gets read by a human before it ships.");
  }
  if (result.informational.length > 0) {
    lines.push("");
    lines.push(`Informational (${result.informational.length}):`);
    lines.push(...result.informational.map(show));
  }
  if (result.accepted.length > 0) {
    lines.push("");
    lines.push(`Knowingly accepted (${result.accepted.length}):`);
    lines.push(...result.accepted.map(show));
  }
  return lines.join("\n");
}
