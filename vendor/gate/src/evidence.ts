/**
 * Verifying a stage by what it left on disk, never by what it said about itself.
 *
 * ══ Why exit codes are not evidence ══
 *
 * Every stage in a build pipeline reports success for the wrong thing. Measured on this
 * machine, not quoted from a blog:
 *
 *     $ pnpm exec vitest run --reporter=json -t 'NO_SUCH_TEST_NAME_XYZ'
 *     exit 0   success=true   numTotalTests=145   numPassedTests=0   numFailedTests=0
 *
 * Zero tests executed. Exit code 0, `success: true`, and `numFailedTests === 0` are all
 * satisfied. A gate asserting any of those passes a run in which **nothing ran**.
 *
 *     $ rm -rf node_modules/@biomejs
 *     $ pnpm install --frozen-lockfile
 *     Already up to date
 *     exit 0                      <- and @biomejs is still missing
 *
 * pnpm short-circuits on `node_modules/.modules.yaml`, a state file recording the last
 * successful install, and never stats the package directories. `--force`, `--offline` and
 * deleting `.modules.yaml` all still exit 0 on a broken tree; only `rm -rf node_modules`
 * repairs it. There is no pnpm command that audits the tree against the lockfile.
 *
 * ══ What this module does instead ══
 *
 * Each check takes *observations* — parsed JSON, a list of paths that exist — and returns a
 * verdict with a reason. Nothing here runs a command or touches the filesystem, so every
 * rule is testable against the exact shapes that fooled the naive check.
 *
 * The relevant measurement for why this matters at all: agents self-report success on
 * failed work **44–52%** of the time, falling to **3%** when an independent check verifies
 * the environment rather than reading the agent's own claim.
 */

/** Why a stage is not believed, as a code a caller can branch on. */
export type EvidenceFailure =
  | "no-tests-ran"
  | "tests-failed"
  | "suite-failed-to-load"
  | "below-minimum"
  | "missing-artifact"
  | "unresolvable-dependency"
  | "typecheck-skipped"
  | "no-inputs";

export type Evidence =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly failure: EvidenceFailure; readonly detail: string };

/**
 * The shape a test runner reports. Vitest's JSON is deliberately Jest-compatible, so this
 * covers both.
 */
export type TestReport = {
  readonly success?: unknown;
  readonly numTotalTests?: unknown;
  readonly numPassedTests?: unknown;
  readonly numFailedTests?: unknown;
  readonly numTotalTestSuites?: unknown;
  readonly numFailedTestSuites?: unknown;
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

/**
 * Whether a test run actually proved anything.
 *
 * ══ The four ways a green test run is worthless ══
 *
 * **1. Zero tests ran.** Measured above: a name filter matching nothing exits 0 with
 * `success: true` and `numPassedTests: 0`. `--passWithNoTests` produces the same shape with
 * `numTotalTests: 0`. A whole-suite `describe.skip` does too.
 *
 * **2. A suite failed to load.** A file that throws at import yields `numTotalTests: 0`
 * **and** `numFailedTests: 0` — so a gate checking only `numFailedTests` passes a build
 * where an entire test file never compiled. Only `numFailedTestSuites` catches it.
 *
 * **3. Fewer tests than expected.** Counts drift downward silently when a glob stops
 * matching. `minPassed` is the assertion that catches it, and it must be a committed number
 * rather than derived from the run being checked.
 *
 * **4. `numTotalTests` looks healthy while nothing passed.** Skipped tests inflate the
 * total, so the load-bearing number is `numPassedTests`, never the total.
 */
export function judgeTestRun(input: {
  readonly report: TestReport;
  /** Minimum passing tests, committed to the repo. Below this, the run proved nothing. */
  readonly minPassed: number;
}): Evidence {
  const passed = count(input.report.numPassedTests);
  const failed = count(input.report.numFailedTests);
  const failedSuites = count(input.report.numFailedTestSuites);
  const total = count(input.report.numTotalTests);

  if (passed < 0 || failed < 0) {
    return {
      ok: false,
      failure: "missing-artifact",
      detail: "the report has no test counts, so it is not a test report",
    };
  }

  // Checked BEFORE the pass count: a suite that failed to load reports 0 failed tests and 0
  // total, so a pass-count check alone would report "no tests ran" and hide the real cause.
  if (failedSuites > 0) {
    return {
      ok: false,
      failure: "suite-failed-to-load",
      detail:
        `${failedSuites} test file(s) failed to load. A file that throws at import reports ` +
        "zero failed TESTS, so only the suite count catches it",
    };
  }

  if (failed > 0) {
    return { ok: false, failure: "tests-failed", detail: `${failed} test(s) failed` };
  }

  if (passed === 0) {
    return {
      ok: false,
      failure: "no-tests-ran",
      detail:
        `no tests passed (total reported: ${total}). Measured on this stack: a name filter ` +
        "matching nothing exits 0 with success=true and numFailedTests=0, so exit code and " +
        "the success flag both prove nothing",
    };
  }

  if (passed < input.minPassed) {
    return {
      ok: false,
      failure: "below-minimum",
      detail:
        `${passed} tests passed, expected at least ${input.minPassed}. A silently narrowing ` +
        "glob shows up here and nowhere else",
    };
  }

  return { ok: true, detail: `${passed} tests passed, ${total} total` };
}

/**
 * Whether an install produced a usable tree.
 *
 * ══ Why this takes resolution results rather than an exit code ══
 *
 * Measured: `pnpm install --frozen-lockfile` printed "Already up to date" and exited 0 with
 * a top-level package deleted from `node_modules`. `pnpm list` is no help either — it reads
 * the lockfile and reports a resolved path that does not exist.
 *
 * The only thing that catches it is resolving each declared dependency from disk, which is
 * what the caller passes in here.
 */
export function judgeInstall(input: {
  /** Every dependency declared in the manifest. */
  readonly declared: readonly string[];
  /** Those that could NOT be resolved from disk. */
  readonly unresolvable: readonly string[];
}): Evidence {
  if (input.declared.length === 0) {
    return { ok: true, detail: "nothing declared, so nothing to resolve" };
  }

  if (input.unresolvable.length > 0) {
    return {
      ok: false,
      failure: "unresolvable-dependency",
      detail:
        `${input.unresolvable.length} declared dependency(ies) do not resolve: ` +
        `${input.unresolvable.slice(0, 5).join(", ")}. Measured: pnpm exits 0 and prints ` +
        '"Already up to date" for exactly this state, because it reads .modules.yaml rather ' +
        "than the tree",
    };
  }

  return { ok: true, detail: `${input.declared.length} declared dependencies resolve` };
}

/**
 * Whether a typecheck actually checked anything.
 *
 * ══ Two ways tsc reports success without doing the work ══
 *
 * **`skipLibCheck` skips every `.d.ts`, including ones you wrote.** Verified: three genuine
 * errors in a project's own hand-written declaration file — exit 2 with `skipLibCheck:
 * false`, **exit 0** with it true. It ships in the default `tsc --init` and in
 * `create-next-app`, and the docs mention only "type-system accuracy", never your own files.
 *
 * **A glob that matches fewer files than intended exits 0 silently.** Matching *nothing* is
 * a hard error (TS18003), but matching *some* is not — so the file count is the assertion.
 *
 * The exit code is also unreliable as a discriminator: the same unchanged error yields exit
 * 2 cold and exit 1 warm-cached under `--build`. Assert non-zero, never a specific code.
 */
export function judgeTypecheck(input: {
  readonly exitCode: number;
  /** Files tsc actually loaded, excluding dependencies. From `--listFiles`. */
  readonly checkedFiles: number;
  readonly minFiles: number;
  /** Whether `skipLibCheck` was on. True means declaration files went unchecked. */
  readonly skipLibCheck: boolean;
}): Evidence {
  if (input.exitCode !== 0) {
    return {
      ok: false,
      failure: "tests-failed",
      detail: `tsc exited ${input.exitCode}. Any non-zero code is a failure; the specific value varies between a cold and a cached run`,
    };
  }

  if (input.skipLibCheck) {
    return {
      ok: false,
      failure: "typecheck-skipped",
      detail:
        "skipLibCheck was on, which skips EVERY .d.ts including hand-written ones in this " +
        "repo. Verified: three real errors in an own declaration file gave exit 2 with it " +
        "off and exit 0 with it on",
    };
  }

  if (input.checkedFiles < input.minFiles) {
    return {
      ok: false,
      failure: "no-inputs",
      detail:
        `tsc checked ${input.checkedFiles} files, expected at least ${input.minFiles}. A glob ` +
        "matching NOTHING is a hard error, but one matching too little exits 0 in silence",
    };
  }

  return { ok: true, detail: `${input.checkedFiles} files typechecked` };
}

/**
 * Whether a Next build produced a serveable app.
 *
 * ══ What exit 0 does not tell you ══
 *
 * `next build` exiting 0 means webpack finished. It does not mean the app works:
 *
 *   - `typescript.ignoreBuildErrors` ships a live type error with exit 0. The only signal
 *     is the log line `Skipping validation of types`.
 *   - `output: 'standalone'` **omits static assets by design** — after a successful build
 *     `.next/standalone/.next/static` does not exist, so the server boots and every asset
 *     404s. It requires an explicit copy step.
 *   - `build-manifest.json` lists only `/_app` and `/_error` for an App Router app, so it is
 *     not the route list. Next 16 emits `app-path-routes-manifest.json` — verified against
 *     a real build; `app-build-manifest.json` is an older name and is NOT produced.
 */
export function judgeBuild(input: {
  /** Paths that exist under the build output. */
  readonly artifacts: readonly string[];
  /** Routes read from `app-path-routes-manifest.json`, excluding framework entries. */
  readonly routeCount: number;
  readonly minRoutes: number;
  /** Whether the build log contained `Skipping validation of types`. */
  readonly typesSkipped: boolean;
  /** Whether `output: 'standalone'` was configured. */
  readonly standalone: boolean;
}): Evidence {
  const has = (path: string): boolean => input.artifacts.includes(path);

  if (input.typesSkipped) {
    return {
      ok: false,
      failure: "typecheck-skipped",
      detail:
        "the build logged 'Skipping validation of types', so ignoreBuildErrors shipped a " +
        "live type error with exit 0",
    };
  }

  for (const required of [".next/BUILD_ID", ".next/app-path-routes-manifest.json"]) {
    if (!has(required)) {
      return {
        ok: false,
        failure: "missing-artifact",
        detail: `${required} is absent, so the build did not complete however it exited`,
      };
    }
  }

  // The documented trap: standalone omits static assets, and the failure is a booting
  // server serving 404s for every stylesheet — which no exit code reflects.
  if (input.standalone && !has(".next/standalone/.next/static")) {
    return {
      ok: false,
      failure: "missing-artifact",
      detail:
        "output: 'standalone' does not copy .next/static. The server will boot and 404 every " +
        "asset unless the copy step ran",
    };
  }

  if (input.routeCount < input.minRoutes) {
    return {
      ok: false,
      failure: "below-minimum",
      detail:
        `${input.routeCount} routes in app-path-routes-manifest.json, expected at least ` +
        `${input.minRoutes}. Note build-manifest.json lists only /_app and /_error for an ` +
        "App Router app and must not be used for this",
    };
  }

  return { ok: true, detail: `${input.routeCount} routes built` };
}

/**
 * Whether a deployment is actually serving the code that was just deployed.
 *
 * ══ Why one 200 is not enough ══
 *
 * Three separate gaps, all documented:
 *
 *   - A bare 200 cannot distinguish "new version live" from "old version still serving",
 *     which is why the response must carry the build id.
 *   - Railway marks a deploy active on **container start alone** when no `healthcheckPath`
 *     is set, so an app that binds a port and throws on first request records SUCCESS.
 *   - A crash-looping container serves a 200 between restarts. The signal from outside is
 *     **uptime that went backwards** between two polls.
 *
 * `railway up --ci` exits when the *build* completes, not the deploy — so the CLI's exit
 * code attests to an image, not a running service.
 */
export function judgeServing(input: {
  readonly status: number;
  /** Build id reported by the service itself. */
  readonly reportedBuildId: string;
  readonly expectedBuildId: string;
  /** `process.uptime()` from two polls, seconds apart. */
  readonly firstUptime: number;
  readonly secondUptime: number;
}): Evidence {
  // Railway requires exactly 200 — a 204 or a redirect fails its healthcheck, so accepting
  // the 200-399 range here would be more lenient than the platform.
  if (input.status !== 200) {
    return {
      ok: false,
      failure: "missing-artifact",
      detail: `health returned ${input.status}; only 200 counts as healthy`,
    };
  }

  if (input.reportedBuildId !== input.expectedBuildId) {
    return {
      ok: false,
      failure: "missing-artifact",
      detail:
        `serving build ${input.reportedBuildId || "(none)"}, expected ${input.expectedBuildId}. ` +
        "A 200 from the PREVIOUS version is indistinguishable from a successful deploy " +
        "without this check",
    };
  }

  // Uptime going backwards means the process restarted between polls. This is the only
  // crash-loop signal available from outside a platform that exposes no restart counter.
  if (input.secondUptime < input.firstUptime) {
    return {
      ok: false,
      failure: "missing-artifact",
      detail:
        `uptime went backwards (${input.firstUptime}s then ${input.secondUptime}s), so the ` +
        "container restarted between polls — a crash loop serving 200s between restarts",
    };
  }

  return { ok: true, detail: `serving ${input.expectedBuildId}, uptime ${input.secondUptime}s` };
}
