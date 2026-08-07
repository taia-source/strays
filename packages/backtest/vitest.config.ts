import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    reporters: ["default", "../../vendor/tools/vitest/no-skipped-reporter.ts"],
    coverage: {
      provider: "v8",
      // `collect.ts`, `forward.ts` and `run.ts` are excluded as MODULES: all three are
      // network/filesystem entrypoints whose pure logic is exported and IS covered — the Swap
      // decoder via `replay.test.ts`, and `forward.ts`'s launch/hook/address decoders via
      // `forward.test.ts`. Including the modules wholesale would demand coverage of `main()`,
      // which cannot run without an RPC key and 20 minutes of network.
      include: [
        "src/replay.ts",
        "src/series.ts",
        "src/stats.ts",
        "src/null.ts",
        "src/liquidity.ts",
        "src/positions.ts",
        "src/survivorship.ts",
      ],
      reporter: ["text", "text-summary", "json-summary"],
      reportOnFailure: true,
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
