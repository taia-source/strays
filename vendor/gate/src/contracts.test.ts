/**
 * Contract-stage tests.
 *
 * The aderyn fixture is REAL output from running aderyn 0.6.8 against a contract with
 * three deliberately planted vulnerabilities — not a hand-written approximation of what
 * the tool might emit.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assessContracts,
  CONTRACT_STAGES,
  DEFAULT_CONTRACT_POLICY,
  formatContracts,
  parseAderyn,
  parseSlither,
} from "./contracts.js";

const REAL_ADERYN = readFileSync(
  fileURLToPath(new URL("./__aderyn-real.json", import.meta.url)),
  "utf8",
);

describe("parseAderyn — against real tool output", () => {
  /**
   * The planted bugs were: reentrancy (state change after external call), an unchecked
   * low-level call, and a privileged setter with no zero-address check. All three must
   * survive parsing as HIGH.
   */
  it("extracts every high-severity finding the tool reported", () => {
    const highs = parseAderyn(REAL_ADERYN)
      .filter((f) => f.severity === "high")
      .map((f) => f.title);

    expect(
      highs.some((t) => /Reentrancy/i.test(t)),
      "reentrancy must be caught",
    ).toBe(true);
    expect(
      highs.some((t) => /Unchecked Low level/i.test(t)),
      "unchecked call must be caught",
    ).toBe(true);
    expect(
      highs.some((t) => /address checks/i.test(t)),
      "missing address check must be caught",
    ).toBe(true);
  });

  it("keeps file and line so a finding is actionable", () => {
    const located = parseAderyn(REAL_ADERYN).filter((f) => f.file !== undefined);
    expect(located.length).toBeGreaterThan(0);
    expect(located[0]?.file).toMatch(/\.sol$/);
    expect(located[0]?.line).toBeGreaterThan(0);
  });

  it("also surfaces low findings rather than dropping them", () => {
    expect(parseAderyn(REAL_ADERYN).filter((f) => f.severity === "low").length).toBeGreaterThan(0);
  });

  /** A failed run must not read as "clean". */
  it("throws on non-JSON rather than reporting zero findings", () => {
    expect(() => parseAderyn("aderyn: command not found")).toThrow(/not valid JSON/);
  });

  it("handles an empty report without inventing findings", () => {
    expect(parseAderyn(JSON.stringify({ high_issues: { issues: [] } }))).toEqual([]);
  });

  /**
   * The degenerate issue shapes, which the real fixture never exercises because a healthy
   * aderyn run always populates them.
   *
   * The one that matters is an issue with **no instances**: dropping it would silently
   * lower the finding count, and a gate that reports fewer high-severity findings than the
   * tool did is precisely the silent wrongness this whole system opposes. It must survive
   * as one finding with no location rather than vanish.
   */
  it("keeps an issue that has no instances rather than dropping it", () => {
    const findings = parseAderyn(
      JSON.stringify({ high_issues: { issues: [{ title: "Project-wide finding" }] } }),
    );
    expect(findings).toEqual([{ tool: "aderyn", severity: "high", title: "Project-wide finding" }]);
  });

  it("names an untitled issue rather than emitting an empty title", () => {
    // An empty title renders as a blank line in the report — unreadable, and easy to skip.
    const findings = parseAderyn(
      JSON.stringify({ low_issues: { issues: [{ instances: [{ contract_path: "src/A.sol" }] }] } }),
    );
    expect(findings).toEqual([
      { tool: "aderyn", severity: "low", title: "untitled finding", file: "src/A.sol" },
    ]);
  });

  it("omits file and line when an instance carries neither", () => {
    // Emitting `line: undefined` would make `f.line ? ...` in the formatter read as absent
    // anyway, but the finding object is also compared and serialised — it must be clean.
    const findings = parseAderyn(
      JSON.stringify({ high_issues: { issues: [{ title: "T", instances: [{}] }] } }),
    );
    expect(findings).toEqual([{ tool: "aderyn", severity: "high", title: "T" }]);
    expect(Object.hasOwn(findings[0] ?? {}, "line")).toBe(false);
  });

  it("keeps line 0 rather than treating it as missing", () => {
    // `i.line_no !== undefined`, not a truthiness test: line 0 is falsy and would be lost.
    const findings = parseAderyn(
      JSON.stringify({
        high_issues: {
          issues: [{ title: "T", instances: [{ contract_path: "a.sol", line_no: 0 }] }],
        },
      }),
    );
    expect(findings[0]?.line).toBe(0);
  });

  it("returns nothing for a report with neither issue bucket", () => {
    expect(parseAderyn("{}")).toEqual([]);
  });
});

describe("parseSlither", () => {
  it("maps slither impact onto our severity scale", () => {
    const json = JSON.stringify({
      results: {
        detectors: [
          {
            check: "reentrancy-eth",
            impact: "High",
            elements: [{ source_mapping: { filename_relative: "src/A.sol", lines: [12] } }],
          },
          { check: "timestamp", impact: "Low", elements: [] },
          { check: "unused-state", impact: "Informational", elements: [] },
        ],
      },
    });
    const findings = parseSlither(json);
    expect(findings[0]).toMatchObject({
      tool: "slither",
      severity: "high",
      file: "src/A.sol",
      line: 12,
    });
    expect(findings[1]?.severity).toBe("low");
    expect(findings[2]?.severity).toBe("low");
  });

  it("throws on non-JSON rather than reporting zero findings", () => {
    expect(() => parseSlither("Traceback (most recent call last):")).toThrow(/not valid JSON/);
  });

  /**
   * Slither's "Medium" impact had no test, and it is the rung that decides whether a
   * finding blocks under a tightened `failOn: "medium"` policy. Collapsing it into "low"
   * would silently let medium-severity findings through a policy that was set to catch
   * them — the failure is invisible, because the report still lists the finding.
   */
  it("maps Medium impact onto its own rung, not down into low", () => {
    const json = JSON.stringify({
      results: { detectors: [{ check: "divide-before-multiply", impact: "Medium" }] },
    });
    expect(parseSlither(json)[0]?.severity).toBe("medium");
  });

  it("treats Critical as high, since our scale tops out there", () => {
    const json = JSON.stringify({ results: { detectors: [{ check: "x", impact: "Critical" }] } });
    expect(parseSlither(json)[0]?.severity).toBe("high");
  });

  it("falls back to low when a detector reports no impact at all", () => {
    // Guessing "high" for an unknown impact would make the gate noisy and get it disabled;
    // guessing anything but a real rung would be inventing a severity the tool did not give.
    const json = JSON.stringify({ results: { detectors: [{ check: "mystery" }] } });
    expect(parseSlither(json)[0]?.severity).toBe("low");
  });

  it("falls back to the first line of the description when there is no check name", () => {
    const json = JSON.stringify({
      results: {
        detectors: [
          { impact: "High", description: "Reentrancy in A.f()\n\tExternal calls:\n\t- ..." },
        ],
      },
    });
    expect(parseSlither(json)[0]?.title).toBe("Reentrancy in A.f()");
  });

  it("names a detector with neither a check nor a description", () => {
    const json = JSON.stringify({ results: { detectors: [{ impact: "Low" }] } });
    expect(parseSlither(json)[0]?.title).toBe("untitled finding");
  });

  it("omits the location when an element carries no source mapping", () => {
    const json = JSON.stringify({
      results: { detectors: [{ check: "x", impact: "Low", elements: [{}] }] },
    });
    expect(parseSlither(json)).toEqual([{ tool: "slither", severity: "low", title: "x" }]);
  });

  /** An empty `results` object is what slither emits for a clean project. */
  it("reports nothing for a clean run", () => {
    expect(parseSlither("{}")).toEqual([]);
    expect(parseSlither(JSON.stringify({ results: {} }))).toEqual([]);
  });
});

describe("assessContracts", () => {
  const findings = parseAderyn(REAL_ADERYN);

  it("fails on high-severity findings by default", () => {
    const result = assessContracts(findings, DEFAULT_CONTRACT_POLICY);
    expect(result.ok, "three real vulnerabilities must fail the gate").toBe(false);
    expect(result.blocking.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps low findings informational rather than blocking", () => {
    const result = assessContracts(findings, DEFAULT_CONTRACT_POLICY);
    expect(result.informational.every((f) => f.severity === "low")).toBe(true);
  });

  /** An exemption must state a reason — same rule as everywhere else in this system. */
  it("honours an accepted finding that states a reason", () => {
    const title = findings.find((f) => /Reentrancy/.test(f.title))?.title ?? "";
    const result = assessContracts(findings, {
      failOn: "high",
      accepted: { [title]: "guarded by a nonReentrant modifier; reviewed 2026-07-27" },
    });
    expect(result.accepted.length).toBeGreaterThan(0);
  });

  it("ignores an exemption with an empty reason", () => {
    const title = findings.find((f) => /Reentrancy/.test(f.title))?.title ?? "";
    const before = assessContracts(findings, { failOn: "high" }).blocking.length;
    const after = assessContracts(findings, { failOn: "high", accepted: { [title]: "   " } })
      .blocking.length;
    expect(after, "a blank reason is not an exemption").toBe(before);
  });

  it("can be tightened to fail on low findings too", () => {
    const result = assessContracts(findings, { failOn: "low" });
    expect(result.informational).toHaveLength(0);
    expect(result.blocking.length).toBe(findings.length);
  });

  it("passes cleanly when there is nothing to report", () => {
    const result = assessContracts([]);
    expect(result.ok).toBe(true);
    expect(formatContracts(result)).toBe("no contract findings");
  });
});

describe("CONTRACT_STAGES", () => {
  it("blocks on compile, tests, fuzz, invariants, config and aderyn", () => {
    expect(CONTRACT_STAGES.filter((s) => s.blocking).map((s) => s.name)).toEqual([
      "build",
      "test",
      "fuzz",
      "invariant",
      "config",
      "aderyn",
    ]);
  });

  /**
   * ══ Two command shapes that are silently wrong, both measured on forge 1.7.1 ══
   *
   * `forge test --match-test invariant` was the original invariant stage. A filter that
   * matches nothing prints `No tests found in project!` to stdout and exits **0** —
   * verified — so a typo, a renamed test, or a project with no invariants at all reads
   * as a green gate. The full run is judged instead, and `judgeRun` blocks when the
   * results contain no invariant campaign.
   *
   * Every stage that produces results a gate must read also needs `--json`, because the
   * exit code cannot see a campaign in which every call reverted.
   */
  it("never filters the invariant stage by a test-name match", () => {
    const invariant = CONTRACT_STAGES.find((s) => s.name === "invariant");
    expect(
      invariant?.command,
      "a filter that matches nothing exits 0 — measured on forge 1.7.1",
    ).not.toMatch(/--match-test/);
  });

  it("reads results as JSON wherever a stage is judged programmatically", () => {
    for (const name of ["test", "fuzz", "invariant", "config"]) {
      const stage = CONTRACT_STAGES.find((s) => s.name === name);
      expect(stage?.command, `${name} must emit machine-readable output`).toMatch(/--json/);
    }
  });

  /**
   * `--json --detailed` produces EMPTY stdout and `--json --summary` silently replaces
   * the per-test detail with counts. Both measured. Either would leave the gate reading
   * nothing while forge exits 0.
   */
  it("never combines --json with the flags that empty or flatten it", () => {
    for (const stage of CONTRACT_STAGES) {
      if (!stage.command.includes("--json")) continue;
      expect(stage.command, `${stage.name} would lose its results`).not.toMatch(
        /--detailed|--summary|--gas-report|--junit/,
      );
    }
  });

  /**
   * Coverage proves a line executed, not that an assertion would catch it breaking — and
   * forge coverage with --via-ir has been unreliable for years. Tracked, never gated.
   */
  it("does NOT block on coverage, and says why", () => {
    const coverage = CONTRACT_STAGES.find((s) => s.name === "coverage");
    expect(coverage?.blocking).toBe(false);
    expect(coverage?.why).toMatch(/proves a line executed/);
  });

  /** ~83 hours for 1,000 mutants against a 5-minute suite. Nightly, never blocking. */
  it("does NOT block on mutation testing, and says why", () => {
    const mutation = CONTRACT_STAGES.find((s) => s.name === "mutation");
    expect(mutation?.blocking).toBe(false);
    expect(mutation?.why).toMatch(/83 hours/);
  });

  it("warns about the fail_on_revert default that hides dead handlers", () => {
    expect(CONTRACT_STAGES.find((s) => s.name === "invariant")?.why).toMatch(/fail_on_revert/);
  });

  it("gives every stage a stated reason for existing", () => {
    expect(CONTRACT_STAGES.every((s) => s.why.length > 20)).toBe(true);
  });
});

describe("formatContracts", () => {
  it("states that a green gate is never sufficient for money code", () => {
    const out = formatContracts(assessContracts(parseAderyn(REAL_ADERYN)));
    expect(out).toMatch(/CONTRACT GATE FAILED/);
    expect(out).toMatch(/necessary, never sufficient/);
    expect(out).toMatch(/read by a human before it ships/);
  });

  /**
   * The "knowingly accepted" section, which no test had ever rendered.
   *
   * An exemption that is invisible in the report is worse than no exemption at all: the
   * next reader sees a clean gate and has no way to know a high-severity finding was
   * waved through. This section is the only place that record surfaces, so it must
   * actually print — and the run must still read as passing.
   */
  it("lists knowingly accepted findings even on a passing run", () => {
    const result = assessContracts(
      [{ tool: "aderyn", severity: "high", title: "Reentrancy (state change after call)" }],
      { failOn: "high", accepted: { "Reentrancy (state change after call)": "nonReentrant" } },
    );
    expect(result.ok, "an accepted finding does not block").toBe(true);

    const out = formatContracts(result);
    expect(out).toContain("Knowingly accepted (1):");
    expect(out).toContain("HIGH    [aderyn] Reentrancy (state change after call)");
    expect(out).not.toContain("CONTRACT GATE FAILED");
  });

  it("renders informational findings under their own heading", () => {
    const out = formatContracts(
      assessContracts([{ tool: "slither", severity: "low", title: "timestamp" }]),
    );
    expect(out).toContain("Informational (1):");
    expect(out).toContain("LOW     [slither] timestamp");
  });

  /**
   * The location suffix has three shapes, and a finding with a file but no line is the
   * one that reads wrongly if the nesting is off: aderyn emits exactly that for a
   * contract-level finding with no `line_no`. A naive `${f.file}:${f.line}` would print
   * "A.sol:undefined" and send a reviewer to a line that does not exist.
   */
  it("appends file and line only when each is present", () => {
    const out = formatContracts(
      assessContracts([
        { tool: "aderyn", severity: "high", title: "with-both", file: "src/A.sol", line: 42 },
        { tool: "aderyn", severity: "high", title: "file-only", file: "src/B.sol" },
        { tool: "aderyn", severity: "high", title: "neither" },
      ]),
    );
    expect(out).toContain("with-both — src/A.sol:42");
    expect(out).toContain("file-only — src/B.sol");
    expect(out).not.toContain("undefined");
    expect(out).toMatch(/\[aderyn\] neither$/m);
  });
});
