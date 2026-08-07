import type { Reporter, TestCase, TestModule, TestSuite } from "vitest/node";

function collect(node: TestModule | TestSuite, out: TestCase[]): void {
  for (const child of node.children) {
    if (child.type === "test") out.push(child);
    else collect(child, out);
  }
}

export default class NoSkippedReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const skipped: string[] = [];
    for (const mod of testModules) {
      const tests: TestCase[] = [];
      collect(mod, tests);
      for (const t of tests) {
        const state = t.result().state;
        if (state === "skipped" || state === "pending") skipped.push(t.fullName);
      }
    }
    if (skipped.length > 0) {
      console.error(`\n✖ ${skipped.length} skipped test(s) — the gate fails on skips:`);
      for (const name of skipped) console.error(`  - ${name}`);
      process.exitCode = 1;
    }
  }
}
