import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    reporters: ["default", "../../vendor/tools/vitest/no-skipped-reporter.ts"],
    coverage: {
      provider: "v8",
      // `collect.ts` and `run.ts` are excluded: both are network/filesystem entrypoints whose only
      // pure logic (the Swap decoder) is exported and IS covered, via `replay.test.ts`.
      include: [
        "src/replay.ts",
        "src/series.ts",
        "src/stats.ts",
        "src/null.ts",
        "src/liquidity.ts",
        "src/positions.ts",
      ],
      reporter: ["text", "text-summary", "json-summary"],
      reportOnFailure: true,
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
