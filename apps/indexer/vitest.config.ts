import { defineConfig } from "vitest/config";

/**
 * ══ WHY THIS FILE EXISTS: `dist/` WAS BEING TESTED ALONGSIDE `src/` ══
 *
 * With no config, vitest's default `include` sweeps the whole package — which picked up the
 * COMPILED test files in `dist/` as well as the real ones in `src/`. `dist/` is a gitignored build
 * artifact, so those copies are whatever `tsc` last emitted: they can be weeks stale, they can test
 * deleted behaviour, and they keep passing after the source they were compiled from has been fixed
 * or deleted.
 *
 * That is the same defect shape this repo keeps recording — a test agreeing with itself while the
 * real artifact says otherwise (STATE.md bug #2, the mock router). A stale `dist/cap.test.js` ran
 * against the CURRENT `src/ledger.ts` here and failed on a schema race, which is a confusing way to
 * discover that half the suite was measuring a build output nobody had rebuilt.
 *
 * Source is the only thing under test. `dist/` is verified by `tsc` and by running the built
 * artifact, not by re-running its own compiled tests.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
