import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // A skipped test is not a pass. The reporter sets a non-zero exit code on any skip.
    reporters: ["default", "../../vendor/tools/vitest/no-skipped-reporter.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      reporter: ["text", "text-summary", "json-summary"],
      reportOnFailure: true,
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
