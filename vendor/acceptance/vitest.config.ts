import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Loads /root/.env so TAIA_RPC_<id> overrides reach the live tests.
    setupFiles: ["../tools/vitest/load-env.ts"],
    testTimeout: 30_000,
    // A skipped test is not a pass. Proven to fail the run — see BUILD-LOG.
    reporters: ["default", "../tools/vitest/no-skipped-reporter.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.live-spec.ts", "src/index.ts"],
      reporter: ["text-summary", "json-summary"],
      reportOnFailure: true,
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
