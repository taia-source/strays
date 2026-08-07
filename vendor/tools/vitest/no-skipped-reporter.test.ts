import { describe, expect, it } from "vitest";
import NoSkippedReporter from "./no-skipped-reporter.js";

/**
 * The reporter that enforces "a skipped test is not a pass" was itself untested.
 *
 * It is the mechanism behind one of this repo's stated invariants, so its failure mode is
 * the worst kind: if it silently stopped working, skipped tests would sail through the
 * gate and nothing would say so. Verified end-to-end first — a real run with one
 * `it.skip` produced:
 *
 *   Tests  14 passed | 1 skipped (15)
 *   ✖ 1 skipped test(s) — the gate fails on skips:
 *     - probe > is skipped on purpose
 *   EXIT CODE: 1
 *
 * These tests pin that behaviour against vitest's reporter shape so an upgrade that
 * renames a state or restructures `children` fails loudly here rather than quietly
 * disabling the check.
 */

/** Minimal stand-ins for vitest's TestModule / TestSuite / TestCase tree. */
function testCase(fullName: string, state: string) {
  return { type: "test" as const, fullName, result: () => ({ state }) };
}
function suite(name: string, children: unknown[]) {
  return { type: "suite" as const, name, children };
}
function moduleWith(children: unknown[]) {
  return { type: "module" as const, children };
}

function runReporter(modules: unknown[]): { exitCode: number | undefined; errors: string[] } {
  const reporter = new NoSkippedReporter();
  const errors: string[] = [];
  const originalError = console.error;
  const originalExit = process.exitCode;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  process.exitCode = undefined;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: exercising vitest's structural shape
    reporter.onTestRunEnd(modules as any);
    return { exitCode: process.exitCode, errors };
  } finally {
    console.error = originalError;
    process.exitCode = originalExit;
  }
}

describe("NoSkippedReporter", () => {
  it("leaves a clean run alone", () => {
    const { exitCode, errors } = runReporter([
      moduleWith([testCase("a > passes", "passed"), testCase("a > also passes", "passed")]),
    ]);
    expect(exitCode).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it("fails the run on a skipped test and names it", () => {
    const { exitCode, errors } = runReporter([
      moduleWith([testCase("a > passes", "passed"), testCase("a > skipped one", "skipped")]),
    ]);
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("a > skipped one");
  });

  it("treats 'pending' as skipped too", () => {
    // vitest reports a todo/pending test with a different state string; both mean
    // "did not run", and only one of them being caught would be a silent hole.
    const { exitCode } = runReporter([moduleWith([testCase("a > todo", "pending")])]);
    expect(exitCode).toBe(1);
  });

  it("finds skips nested inside suites", () => {
    // The recursion matters: nearly every real test file nests describe blocks, so a
    // reporter that only looked at top-level children would catch almost nothing.
    const { exitCode, errors } = runReporter([
      moduleWith([suite("outer", [suite("inner", [testCase("outer > inner > deep", "skipped")])])]),
    ]);
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("outer > inner > deep");
  });

  it("counts every skip across several modules", () => {
    const { exitCode, errors } = runReporter([
      moduleWith([testCase("m1 > s", "skipped")]),
      moduleWith([testCase("m2 > s", "skipped")]),
    ]);
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("2 skipped test(s)");
  });

  it("does not fail on a failing test — that is vitest's job, not this reporter's", () => {
    // Overreaching here would make the reporter a second, confusing source of failure.
    const { exitCode } = runReporter([moduleWith([testCase("a > fails", "failed")])]);
    expect(exitCode).toBeUndefined();
  });
});
