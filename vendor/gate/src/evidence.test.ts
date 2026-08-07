import { describe, expect, it } from "vitest";
import {
  judgeBuild,
  judgeInstall,
  judgeServing,
  judgeTestRun,
  judgeTypecheck,
} from "./evidence.js";

/**
 * ══ The two shapes measured on this machine ══
 *
 * Not quoted from anywhere. Run while writing this module:
 *
 *     $ pnpm exec vitest run --reporter=json -t 'NO_SUCH_TEST_NAME_XYZ'
 *     exit 0   success=true   numTotalTests=145   numPassedTests=0   numFailedTests=0
 *
 *     $ rm -rf node_modules/@biomejs && pnpm install --frozen-lockfile
 *     Already up to date        exit 0        @biomejs still missing
 *
 * Both are green by every naive measure. The fixtures below are those exact shapes.
 */

describe("a test run that proved nothing", () => {
  /**
   * ══ The measured false green ══
   *
   * Every naive assertion passes this: exit code 0, `success: true`, `numFailedTests === 0`,
   * and a healthy-looking `numTotalTests` of 145. Zero tests executed.
   */
  it("rejects the exact shape a name filter produced on this stack", () => {
    const verdict = judgeTestRun({
      report: {
        success: true,
        numTotalTests: 145,
        numPassedTests: 0,
        numFailedTests: 0,
        numFailedTestSuites: 0,
      },
      minPassed: 1,
    });
    expect(verdict.ok, "a run with zero executed tests was accepted").toBe(false);
    expect(verdict.ok || verdict.failure).toBe("no-tests-ran");
  });

  /** `--passWithNoTests` produces the same verdict by a different route. */
  it("rejects a passWithNoTests run", () => {
    const verdict = judgeTestRun({
      report: { success: true, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0 },
      minPassed: 1,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok || verdict.failure).toBe("no-tests-ran");
  });

  /**
   * ══ The one that hides behind zero ══
   *
   * A file throwing at import reports numTotalTests 0 AND numFailedTests 0. A gate checking
   * only failed tests passes a build where a whole test file never compiled — and reporting
   * it as "no tests ran" would hide the actual cause, so the suite check comes first.
   */
  it("names a suite that failed to load, rather than reporting no tests", () => {
    const verdict = judgeTestRun({
      report: {
        success: false,
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
        numFailedTestSuites: 1,
      },
      minPassed: 1,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok || verdict.failure, "an import error was misreported").toBe(
      "suite-failed-to-load",
    );
  });

  /** Counts drift downward silently when a glob stops matching. */
  it("rejects a run with fewer passing tests than committed", () => {
    const verdict = judgeTestRun({
      report: { numTotalTests: 200, numPassedTests: 3, numFailedTests: 0 },
      minPassed: 100,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok || verdict.failure).toBe("below-minimum");
  });

  /** Skipped tests inflate the total, so the total must never be the assertion. */
  it("does not accept a healthy total when few tests actually passed", () => {
    const verdict = judgeTestRun({
      report: { numTotalTests: 1000, numPassedTests: 2, numFailedTests: 0 },
      minPassed: 500,
    });
    expect(verdict.ok, "numTotalTests was treated as evidence").toBe(false);
  });

  it("accepts a real run", () => {
    const verdict = judgeTestRun({
      report: {
        success: true,
        numTotalTests: 145,
        numPassedTests: 145,
        numFailedTests: 0,
        numFailedTestSuites: 0,
      },
      minPassed: 100,
    });
    expect(verdict.ok).toBe(true);
  });

  it("reports a genuine failure as a failure", () => {
    const verdict = judgeTestRun({
      report: { numTotalTests: 10, numPassedTests: 9, numFailedTests: 1 },
      minPassed: 1,
    });
    expect(verdict.ok || verdict.failure).toBe("tests-failed");
  });

  /** A report without counts is not a report; it must not be read as an empty pass. */
  it("refuses a report with no counts at all", () => {
    expect(judgeTestRun({ report: {}, minPassed: 1 }).ok).toBe(false);
  });

  it("refuses counts that are not numbers", () => {
    const verdict = judgeTestRun({
      report: { numPassedTests: "145", numFailedTests: null },
      minPassed: 1,
    });
    expect(verdict.ok, "a string count was coerced").toBe(false);
  });
});

describe("an install that left a broken tree", () => {
  /**
   * Measured: pnpm printed "Already up to date" and exited 0 with @biomejs deleted. It reads
   * node_modules/.modules.yaml and never stats the package directories.
   */
  it("rejects the exact state pnpm reported as up to date", () => {
    const verdict = judgeInstall({
      declared: ["@biomejs/biome", "vitest", "typescript"],
      unresolvable: ["@biomejs/biome"],
    });
    expect(verdict.ok, "a missing package was accepted because pnpm exited 0").toBe(false);
    expect(verdict.ok || verdict.failure).toBe("unresolvable-dependency");
  });

  it("accepts a tree where every declared dependency resolves", () => {
    expect(judgeInstall({ declared: ["vitest"], unresolvable: [] }).ok).toBe(true);
  });

  it("accepts a package with no dependencies", () => {
    expect(judgeInstall({ declared: [], unresolvable: [] }).ok).toBe(true);
  });

  /** The detail must name what is missing, or the failure is unactionable. */
  it("names the missing packages", () => {
    const verdict = judgeInstall({ declared: ["a", "b"], unresolvable: ["a"] });
    expect(verdict.ok || verdict.detail).toContain("a");
  });
});

describe("a typecheck that checked nothing", () => {
  /**
   * Verified: three real errors in a hand-written .d.ts give exit 2 with skipLibCheck off
   * and exit 0 with it on. It ships in the default tsc --init and in create-next-app.
   */
  it("rejects a green run that had skipLibCheck on", () => {
    const verdict = judgeTypecheck({
      exitCode: 0,
      checkedFiles: 200,
      minFiles: 100,
      skipLibCheck: true,
    });
    expect(verdict.ok, "skipLibCheck skips hand-written .d.ts files too").toBe(false);
    expect(verdict.ok || verdict.failure).toBe("typecheck-skipped");
  });

  /** A glob matching nothing is a hard error; one matching too little is silent. */
  it("rejects a run that checked fewer files than expected", () => {
    const verdict = judgeTypecheck({
      exitCode: 0,
      checkedFiles: 1,
      minFiles: 100,
      skipLibCheck: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok || verdict.failure).toBe("no-inputs");
  });

  /** The same error is exit 2 cold and exit 1 warm-cached, so only non-zero is meaningful. */
  it.each([1, 2, 3, 4])("treats exit %i as a failure", (exitCode) => {
    expect(
      judgeTypecheck({ exitCode, checkedFiles: 200, minFiles: 1, skipLibCheck: false }).ok,
    ).toBe(false);
  });

  it("accepts a real typecheck", () => {
    expect(
      judgeTypecheck({ exitCode: 0, checkedFiles: 200, minFiles: 100, skipLibCheck: false }).ok,
    ).toBe(true);
  });
});

describe("a build that produced a broken app", () => {
  const artifacts = [".next/BUILD_ID", ".next/app-path-routes-manifest.json", ".next/static"];

  /** The only signal that ignoreBuildErrors shipped a live type error. */
  it("rejects a build that skipped type validation", () => {
    const verdict = judgeBuild({
      artifacts,
      routeCount: 5,
      minRoutes: 1,
      typesSkipped: true,
      standalone: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok || verdict.failure).toBe("typecheck-skipped");
  });

  /**
   * The documented standalone trap: static assets are omitted by design, so the server boots
   * and 404s every stylesheet — with exit 0 throughout.
   */
  it("rejects a standalone build missing its static assets", () => {
    const verdict = judgeBuild({
      artifacts,
      routeCount: 5,
      minRoutes: 1,
      typesSkipped: false,
      standalone: true,
    });
    expect(verdict.ok, "standalone without .next/static serves 404s for every asset").toBe(false);
    expect(verdict.ok || verdict.failure).toBe("missing-artifact");
  });

  it("accepts a standalone build that copied its assets", () => {
    const verdict = judgeBuild({
      artifacts: [...artifacts, ".next/standalone/.next/static"],
      routeCount: 5,
      minRoutes: 1,
      typesSkipped: false,
      standalone: true,
    });
    expect(verdict.ok).toBe(true);
  });

  it.each([".next/BUILD_ID", ".next/app-path-routes-manifest.json"])(
    "rejects a build with no %s",
    (missing) => {
      const verdict = judgeBuild({
        artifacts: artifacts.filter((path) => path !== missing),
        routeCount: 5,
        minRoutes: 1,
        typesSkipped: false,
        standalone: false,
      });
      expect(verdict.ok).toBe(false);
    },
  );

  it("rejects a build with fewer routes than expected", () => {
    const verdict = judgeBuild({
      artifacts,
      routeCount: 0,
      minRoutes: 1,
      typesSkipped: false,
      standalone: false,
    });
    expect(verdict.ok || verdict.failure).toBe("below-minimum");
  });

  it("accepts a complete build", () => {
    expect(
      judgeBuild({
        artifacts,
        routeCount: 5,
        minRoutes: 1,
        typesSkipped: false,
        standalone: false,
      }).ok,
    ).toBe(true);
  });
});

describe("a deployment that is not serving what was deployed", () => {
  const healthy = {
    status: 200,
    reportedBuildId: "abc123",
    expectedBuildId: "abc123",
    firstUptime: 30,
    secondUptime: 90,
  };

  /**
   * ══ The 200 that means nothing ══
   *
   * A bare 200 cannot distinguish a live new version from the previous one still serving.
   * Without the build id this check is decorative.
   */
  it("rejects a 200 from the previous version", () => {
    const verdict = judgeServing({ ...healthy, reportedBuildId: "old999" });
    expect(verdict.ok, "the old version answered and was accepted").toBe(false);
  });

  /**
   * A crash-looping container serves 200s between restarts. Uptime going backwards is the
   * only signal available from outside.
   */
  it("catches a crash loop by uptime going backwards", () => {
    const verdict = judgeServing({ ...healthy, firstUptime: 90, secondUptime: 4 });
    expect(verdict.ok, "a restarting container passed on a single 200").toBe(false);
    expect(verdict.ok || verdict.detail).toContain("restarted");
  });

  /** Railway requires exactly 200; a redirect or 204 fails its own healthcheck. */
  it.each([204, 301, 302, 404, 500, 503])("rejects status %i", (status) => {
    expect(judgeServing({ ...healthy, status }).ok).toBe(false);
  });

  it("accepts a service serving the expected build with rising uptime", () => {
    expect(judgeServing(healthy).ok).toBe(true);
  });

  /** An empty reported id must not match an expected one by coincidence. */
  it("rejects an empty build id", () => {
    expect(judgeServing({ ...healthy, reportedBuildId: "" }).ok).toBe(false);
  });
});
