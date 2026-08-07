import { describe, expect, it } from "vitest";
import type { Capability } from "./capability.js";
import {
  applyJudgements,
  assessAcceptance,
  checkCapability,
  checkEvidence,
  formatAcceptance,
  type ProjectView,
} from "./check.js";

const EMPTY: ProjectView = { files: [] };

function capability(over: Partial<Capability> = {}): Capability {
  return {
    id: "test-capability",
    statement: "a thing must be possible",
    level: "required",
    evidence: [{ kind: "file", target: "a.ts", rationale: "it must exist" }],
    source: "test",
    ...over,
  };
}

describe("file evidence", () => {
  it("holds when the path exists", () => {
    const verdict = checkEvidence(
      { kind: "file", target: "src/a.ts", rationale: "r" },
      { files: [{ path: "src/a.ts", source: "" }] },
    );
    expect(verdict.held).toBe(true);
  });

  /** Exact match: `src/a.ts` is not satisfied by `src/a.test.ts` or `other/src/a.ts`. */
  it.each(["src/a.test.ts", "other/src/a.ts", "src/A.ts"])(
    "does not accept %s as src/a.ts",
    (path) => {
      const verdict = checkEvidence(
        { kind: "file", target: "src/a.ts", rationale: "r" },
        { files: [{ path, source: "" }] },
      );
      expect(verdict.held).toBe(false);
    },
  );
});

describe("export evidence", () => {
  it("holds when something exports the symbol", () => {
    const verdict = checkEvidence(
      { kind: "export", target: "enrol", rationale: "r" },
      { files: [], exports: { "src/a.ts": ["enrol", "other"] } },
    );
    expect(verdict.held).toBe(true);
  });

  /**
   * ══ An unrunnable check FAILS ══
   *
   * The tempting design abstains when no export map was supplied. That is how a stage reports
   * green having verified nothing — the failure this package exists to correct.
   */
  it("fails rather than abstains when no export map was supplied", () => {
    const verdict = checkEvidence({ kind: "export", target: "enrol", rationale: "r" }, EMPTY);
    expect(verdict.held, "an unrunnable check must not pass").toBe(false);
    expect(verdict.detail).toContain("could not be confirmed");
  });
});

describe("source evidence", () => {
  it("holds when a shipped file matches", () => {
    const verdict = checkEvidence(
      { kind: "source", target: "onChange", rationale: "r" },
      { files: [{ path: "a.tsx", source: "<input onChange={x}/>" }] },
    );
    expect(verdict.held).toBe(true);
    expect(verdict.detail).toContain("a.tsx");
  });

  it("names the file that matched, so a finding is actionable", () => {
    const verdict = checkEvidence(
      { kind: "source", target: "drizzle", rationale: "r" },
      {
        files: [
          { path: "a.ts", source: "nothing" },
          { path: "db.ts", source: "import { drizzle } from 'x'" },
        ],
      },
    );
    expect(verdict.detail).toContain("db.ts");
  });

  /**
   * A model-supplied pattern is untrusted input. An invalid one must produce a finding about
   * the CAPABILITY, not crash the stage checking it.
   */
  it("fails on a pattern that does not compile, rather than throwing", () => {
    const verdict = checkEvidence(
      { kind: "source", target: "([unclosed", rationale: "r" },
      { files: [{ path: "a.ts", source: "anything" }] },
    );
    expect(verdict.held).toBe(false);
    expect(verdict.detail).toContain("does not compile");
  });
});

describe("rendered evidence", () => {
  it("holds when a page contains the selector", () => {
    const verdict = checkEvidence(
      { kind: "rendered", target: "input", rationale: "r" },
      { files: [], rendered: { "/": { selectorsPresent: ["input"], visibleText: "" } } },
    );
    expect(verdict.held).toBe(true);
  });

  /**
   * The measured reason this fails rather than abstains: a layout bug passed 18 source-level
   * checks and was visible only in a real render. "We could not render" is a real failure.
   */
  it("fails when nothing was rendered", () => {
    const verdict = checkEvidence({ kind: "rendered", target: "input", rationale: "r" }, EMPTY);
    expect(verdict.held).toBe(false);
    expect(verdict.detail).toContain("no page was rendered");
  });

  it("names every route it checked, so a pass is auditable", () => {
    const verdict = checkEvidence(
      { kind: "rendered", target: "input", rationale: "r" },
      {
        files: [],
        rendered: {
          "/": { selectorsPresent: ["h1"], visibleText: "" },
          "/app": { selectorsPresent: ["button"], visibleText: "" },
        },
      },
    );
    expect(verdict.held).toBe(false);
    expect(verdict.detail).toContain("/app");
  });
});

describe("route evidence", () => {
  /** A 401 from an auth route is the route WORKING. Only 5xx is the route failing. */
  it.each([200, 201, 302, 401, 403, 404, 422])("accepts %i as an answering route", (status) => {
    const verdict = checkEvidence(
      { kind: "route", target: "/api/session", rationale: "r" },
      { files: [], routes: { "/api/session": status } },
    );
    expect(verdict.held).toBe(true);
  });

  it.each([500, 502, 503])("rejects %i", (status) => {
    const verdict = checkEvidence(
      { kind: "route", target: "/api/session", rationale: "r" },
      { files: [], routes: { "/api/session": status } },
    );
    expect(verdict.held).toBe(false);
  });

  it("fails a route that was never requested", () => {
    const verdict = checkEvidence(
      { kind: "route", target: "/api/session", rationale: "r" },
      { files: [], routes: {} },
    );
    expect(verdict.held).toBe(false);
    expect(verdict.detail).toContain("never requested");
  });
});

describe("prose evidence", () => {
  it("holds on a real sentence", () => {
    const verdict = checkEvidence(
      { kind: "prose", target: "8", rationale: "r" },
      {
        files: [],
        rendered: {
          "/": {
            selectorsPresent: [],
            visibleText: "This service pays your token holders from your launchpad fees.",
          },
        },
      },
    );
    expect(verdict.held, verdict.detail).toBe(true);
  });

  /** Numbers and units must not pad a run of labels into looking like a sentence. */
  it("does not count numbers and short tokens as words", () => {
    const verdict = checkEvidence(
      { kind: "prose", target: "8", rationale: "r" },
      {
        files: [],
        rendered: {
          "/": {
            selectorsPresent: [],
            visibleText: "0.010000 ETH 0.000446 ETH 10% 4663 0x11 A B C D E F",
          },
        },
      },
    );
    expect(verdict.held, verdict.detail).toBe(false);
  });

  it("fails a target that is not a number", () => {
    const verdict = checkEvidence(
      { kind: "prose", target: "lots", rationale: "r" },
      { files: [], rendered: { "/": { selectorsPresent: [], visibleText: "a b c" } } },
    );
    expect(verdict.held).toBe(false);
    expect(verdict.detail).toContain("not a word count");
  });

  it("splits on sentence boundaries rather than counting the whole page", () => {
    // Ten short sentences must not add up to one long one.
    const verdict = checkEvidence(
      { kind: "prose", target: "12", rationale: "r" },
      {
        files: [],
        rendered: {
          "/": {
            selectorsPresent: [],
            visibleText: "One two. Three four. Five six. Seven eight. Nine ten. Eleven twelve.",
          },
        },
      },
    );
    expect(verdict.held).toBe(false);
  });
});

describe("judgement evidence", () => {
  /**
   * ══ Unjudged means absent ══
   *
   * Defaulting an unanswered judgement to held would let every capability carrying one pass
   * silently — which is the rubber stamp this design exists to avoid.
   */
  it("fails until a verdict is supplied", () => {
    const verdict = checkEvidence(
      { kind: "judgement", target: "is it good?", rationale: "r" },
      EMPTY,
    );
    expect(verdict.held).toBe(false);
    expect(verdict.detail).toContain("awaiting judgement");
  });
});

describe("a capability's verdict", () => {
  it("requires ALL evidence, not any", () => {
    const verdict = checkCapability(
      capability({
        evidence: [
          { kind: "file", target: "a.ts", rationale: "r" },
          { kind: "file", target: "b.ts", rationale: "r" },
        ],
      }),
      { files: [{ path: "a.ts", source: "" }] },
    );
    expect(
      verdict.present,
      "'an input exists' and 'the input is wired' are both required — satisfying either alone " +
        "is the exact shape of the measured failure",
    ).toBe(false);
  });

  it("is present when every piece holds", () => {
    const verdict = checkCapability(
      capability({
        evidence: [
          { kind: "file", target: "a.ts", rationale: "r" },
          { kind: "source", target: "hello", rationale: "r" },
        ],
      }),
      { files: [{ path: "a.ts", source: "hello world" }] },
    );
    expect(verdict.present).toBe(true);
  });

  it("marks a capability with no evidence uncheckable, not present", () => {
    const verdict = checkCapability(capability({ evidence: [] }), EMPTY);
    expect(verdict.present).toBe(false);
    expect(verdict.uncheckable).toContain("no evidence");
  });

  it("marks a judgement-only capability uncheckable", () => {
    const verdict = checkCapability(
      capability({ evidence: [{ kind: "judgement", target: "good?", rationale: "r" }] }),
      EMPTY,
    );
    expect(verdict.uncheckable).toContain("81.56%");
  });
});

describe("judgements fold in", () => {
  const withJudgement = capability({
    evidence: [
      { kind: "file", target: "a.ts", rationale: "r" },
      { kind: "judgement", target: "clear?", rationale: "r" },
    ],
  });

  it("settles a judgement piece when answered", () => {
    const verdict = applyJudgements(
      checkCapability(withJudgement, { files: [{ path: "a.ts", source: "" }] }),
      { "clear?": true },
    );
    expect(verdict.present).toBe(true);
  });

  /**
   * ══ The safety property ══
   *
   * A judge measures 81.56% agreement with humans. So it may settle a judgement and NOTHING
   * else: the worst a wrong judge can do is fail something fine. The reverse would be a
   * rubber stamp.
   */
  it("cannot rescue a capability whose file is missing", () => {
    const verdict = applyJudgements(checkCapability(withJudgement, EMPTY), {
      "clear?": true,
      // Even a judge answering the file question cannot flip it.
      "a.ts": true,
    });
    expect(verdict.present, "a judge overruled a deterministic failure").toBe(false);
  });

  it("can fail something the deterministic pass allowed", () => {
    const verdict = applyJudgements(
      checkCapability(withJudgement, { files: [{ path: "a.ts", source: "" }] }),
      { "clear?": false },
    );
    expect(verdict.present).toBe(false);
  });

  it("leaves an uncheckable capability alone", () => {
    const verdict = applyJudgements(checkCapability(capability({ evidence: [] }), EMPTY), {
      anything: true,
    });
    expect(verdict.uncheckable).toBeDefined();
    expect(verdict.present).toBe(false);
  });
});

describe("the whole assessment", () => {
  it("blocks on a missing required capability", () => {
    const result = assessAcceptance({ capabilities: [capability()], view: EMPTY });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["test-capability"]);
  });

  it("reports an expected capability as a gap without blocking", () => {
    const result = assessAcceptance({
      capabilities: [capability({ level: "expected" })],
      view: EMPTY,
    });
    expect(result.ok).toBe(true);
    expect(result.gaps).toEqual(["test-capability"]);
  });

  /**
   * ══ Nothing derived is not a pass ══
   *
   * A prompt always implies something, so an empty capability list means derivation failed.
   * Reporting that as ok is how this stage would become decorative.
   */
  it("refuses when no capabilities were derived", () => {
    const result = assessAcceptance({ capabilities: [], view: EMPTY });
    expect(result.ok, "a stage that checked nothing reported success").toBe(false);
    expect(formatAcceptance(result)).toContain("nothing was checked");
  });

  it("reports the requirement in the user's words, not a rule id alone", () => {
    const report = formatAcceptance(
      assessAcceptance({
        capabilities: [
          capability({ statement: "A user can enter the token the service acts on." }),
        ],
        view: EMPTY,
      }),
    );
    expect(report).toContain("A user can enter the token");
    expect(report).toContain("MISSING");
  });

  it("names an uncheckable capability distinctly from an absent one", () => {
    const report = formatAcceptance(
      assessAcceptance({ capabilities: [capability({ evidence: [] })], view: EMPTY }),
    );
    expect(report).toContain("UNCHECKABLE");
  });
});

/**
 * ══ Path evidence: where a file IS, not what it contains ══
 *
 * Added after writing a path pattern as `source` evidence and watching it fail against a tree
 * that plainly had the route. `source` runs `pattern.test(file.source)` — it never looks at a
 * path, and the failure message said "no shipped file matches" while the file was right there.
 */
describe("path evidence", () => {
  it("holds when a file path matches", () => {
    const verdict = checkEvidence(
      { kind: "path", target: "app/app/", rationale: "r" },
      { files: [{ path: "apps/web/app/app/page.tsx", source: "" }] },
    );
    expect(verdict.held).toBe(true);
    expect(verdict.detail).toContain("apps/web/app/app/page.tsx");
  });

  /** The distinction that motivated the kind: contents are not consulted. */
  it("does not match on contents", () => {
    const verdict = checkEvidence(
      { kind: "path", target: "app/app/", rationale: "r" },
      { files: [{ path: "apps/web/app/page.tsx", source: "// see app/app/page.tsx" }] },
    );
    expect(verdict.held, "a path check matched a mention inside a file").toBe(false);
  });

  it("fails when nothing matches, and says so", () => {
    const verdict = checkEvidence(
      { kind: "path", target: "routes/app", rationale: "r" },
      { files: [{ path: "apps/web/app/page.tsx", source: "" }] },
    );
    expect(verdict.held).toBe(false);
    expect(verdict.detail).toContain("no shipped file has a path matching");
  });

  it("fails on a pattern that does not compile rather than throwing", () => {
    const verdict = checkEvidence(
      { kind: "path", target: "([unclosed", rationale: "r" },
      { files: [{ path: "a.ts", source: "" }] },
    );
    expect(verdict.held).toBe(false);
    expect(verdict.detail).toContain("does not compile");
  });

  it("fails over an empty tree", () => {
    expect(
      checkEvidence({ kind: "path", target: "anything", rationale: "r" }, { files: [] }).held,
    ).toBe(false);
  });
});
