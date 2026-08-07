import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    reporters: ["default", "../../vendor/tools/vitest/no-skipped-reporter.ts"],
    coverage: {
      provider: "v8",
      include: ["src/replay.ts", "src/series.ts", "src/stats.ts"],
      reporter: ["text", "text-summary", "json-summary"],
      reportOnFailure: true,
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
