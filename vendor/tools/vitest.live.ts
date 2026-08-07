import { defineConfig } from "vitest/config";

/**
 * The live suite: specs that need the network.
 *
 * Separate from the default run because a registry outage must not turn the gate red — a
 * fetch failure is a failure mode, not a conclusion. These are run deliberately, and their
 * own assertions report when a lookup could not be made.
 */
export default defineConfig({
  test: {
    include: ["vitest/**/*.live-spec.ts"],
    setupFiles: ["./vitest/load-env.ts"],
    testTimeout: 120_000,
  },
});
