import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["vitest/**/*.test.ts"],
    testTimeout: 30_000,
    setupFiles: ["./vitest/load-env.ts"],
    reporters: ["default", "./vitest/no-skipped-reporter.ts"],
    coverage: {
      provider: "v8",
      include: ["vitest/**/*.ts"],
      // Live specs are test code that the default run deliberately does not execute, so
      // counting them as uncovered source penalises the suite for its own separation.
      exclude: ["vitest/**/*.test.ts", "vitest/**/*.live-spec.ts"],
      reporter: ["text-summary", "json-summary"],
      reportOnFailure: true,
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
