import { describe, expect, it } from "vitest";
import {
  assessPlaceholders,
  findAdmissions,
  findPlaceholders,
  formatPlaceholders,
  isExemptPath,
} from "./placeholder.js";

/**
 * ══ Closing sabotage survivors ══
 *
 * Four guards here survived sabotage: sequential addresses, the zero-address exemption, the
 * test-file exemption, and the zero-files-scanned report. Each existed and nothing checked it.
 */
describe("invented addresses", () => {
  it.each([
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
  ])("flags %s as a repeated nibble", (address) => {
    const findings = findPlaceholders({ file: "a.ts", source: `const x = "${address}";` });
    expect(findings.map((f) => f.kind)).toContain("repeated-nibble-address");
  });

  /**
   * Sabotage survivor: removing the sequential check changed nothing, because no test used a
   * counting address. 8 ascending hex digits has probability ~16^-7 by chance.
   */
  it.each([
    "0x0123456789abcdef0123456789abcdef01234567",
    "0xff0123456789abcdefff0123456789abcdefff01",
  ])("flags %s as sequential", (address) => {
    const findings = findPlaceholders({ file: "a.ts", source: `const x = "${address}";` });
    expect(
      findings.map((f) => f.kind),
      "a counting address is typed by hand, not generated",
    ).toContain("sequential-address");
  });

  /** A real address must not be flagged, or the checker gets disabled. */
  it.each([
    "0x4eeac3e373a9f8baecf90dedc5d4b7444b9c841b",
    "0x736D76699C26D0d966744cAe304C000d471f7F35",
    "0x54964DBc09A59Ff7D9d7F578316D16EC9f06A5CF",
    // Begins 0x1234 by chance, which is not a long enough run to be suspicious.
    "0x1234f8baecf90dedc5d4b7444b9c841b4eeac3e3",
  ])("does not flag the real address %s", (address) => {
    expect(findPlaceholders({ file: "a.ts", source: `const x = "${address}";` })).toEqual([]);
  });

  /**
   * Sabotage survivor: removing the exemption changed nothing. The zero address means "none"
   * throughout Ethereum and the burn address is conventional — flagging either fires on
   * correct code, which is the fastest way to get a checker turned off.
   */
  it.each([
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dEaD",
    "0x000000000000000000000000000000000000dead",
  ])("never flags the meaningful address %s", (address) => {
    expect(
      findPlaceholders({ file: "a.ts", source: `const BURN = "${address}";` }),
      "the zero and burn addresses are real values, not placeholders",
    ).toEqual([]);
  });

  it("reports the line number so a finding is clickable", () => {
    const source = [
      "// header",
      "",
      'const x = "0x1111111111111111111111111111111111111111";',
    ].join("\n");
    expect(findPlaceholders({ file: "a.ts", source })[0]?.line).toBe(3);
  });

  it("finds every invented address in one file, not just the first", () => {
    const source = [
      'a = "0x1111111111111111111111111111111111111111";',
      'b = "0x2222222222222222222222222222222222222222";',
      'c = "0x3333333333333333333333333333333333333333";',
    ].join("\n");
    const nibbles = findPlaceholders({ file: "a.ts", source }).filter(
      (f) => f.kind === "repeated-nibble-address",
    );
    expect(nibbles).toHaveLength(3);
  });
});

describe("placeholder prose and domains", () => {
  it("flags lorem ipsum", () => {
    expect(
      findPlaceholders({ file: "a.tsx", source: "<p>Lorem ipsum dolor sit</p>" }).map(
        (f) => f.kind,
      ),
    ).toContain("lorem");
  });

  /** RFC 2606 reserves example.com precisely so it can never resolve to a real service. */
  it.each(["example.com", "example.org", "example.net"])("flags %s", (domain) => {
    expect(
      findPlaceholders({ file: "a.ts", source: `const url = "https://${domain}/api";` }).map(
        (f) => f.kind,
      ),
    ).toContain("example-domain");
  });

  it("does not flag a real domain", () => {
    expect(
      findPlaceholders({ file: "a.ts", source: 'const url = "https://ponsfamily.com";' }),
    ).toEqual([]);
  });

  it.each(["TODO", "FIXME", "XXX", "HACK"])("flags a %s marker", (marker) => {
    expect(
      findPlaceholders({ file: "a.ts", source: `// ${marker}: finish this` }).map((f) => f.kind),
    ).toContain("todo-marker");
  });

  /** Lowercase "todo" in prose is a word, not a marker. */
  it("does not flag the word todo in ordinary prose", () => {
    expect(
      findPlaceholders({ file: "a.ts", source: "// the todo list feature is complete" }),
    ).toEqual([]);
  });
});

describe("admissions that span a line break", () => {
  /**
   * ══ The measured case the first version missed ══
   *
   * "NOT" ended one line and "wired up" began the next, across a comment marker. A line-by-line
   * scan saw neither half and reported the file clean.
   */
  it("finds an admission split across two comment lines", () => {
    const source = [
      "async function tick() {",
      "  // the chain I/O that would feed it is NOT",
      "  // wired up: reading enrolments needs an RPC endpoint",
      "}",
    ].join("\n");
    const findings = findAdmissions({ file: "a.ts", source });
    expect(findings, "a wrapped admission was invisible to a line-by-line scan").toHaveLength(1);
    expect(findings[0]?.text.toLowerCase()).toContain("not");
  });

  it.each([
    "// this is a no-op for now",
    "// does nothing yet",
    "// placeholder until the contracts land",
    "// returns mock data",
    "// fake response while we build the api",
    "// will be implemented next week",
    "// not yet implemented",
    "// hardcoded for now",
  ])("finds the admission in %s", (source) => {
    expect(findAdmissions({ file: "a.ts", source })).toHaveLength(1);
  });

  /** One finding per file: the same admission restated is one unfinished module. */
  it("reports one finding per file even when an admission is restated", () => {
    const source = "// not wired up\n// does nothing\n// is a no-op";
    expect(findAdmissions({ file: "a.ts", source })).toHaveLength(1);
  });

  it("says nothing about finished code", () => {
    expect(
      findAdmissions({
        file: "a.ts",
        source: "// reads the claim and decides whether it pays for itself",
      }),
    ).toEqual([]);
  });
});

describe("what is exempt", () => {
  /**
   * Sabotage survivor: scanning test files changed nothing, because no test passed one in. A
   * fixture is SUPPOSED to be invented.
   */
  it.each([
    "src/a.test.ts",
    "src/a.spec.tsx",
    "src/a.live-spec.ts",
    "src/__fixtures__/data.ts",
    "src/__mocks__/api.ts",
    "test/helper.ts",
    "e2e/flow.ts",
  ])("exempts %s", (path) => {
    expect(isExemptPath(path)).toBe(true);
  });

  /**
   * A candidly-named file under src/ is NOT exempt. `mock-data.ts` is invented data with an
   * honest name, which is exactly what shipped.
   */
  it.each(["src/mock-data.ts", "src/screen.tsx", "apps/web/app/page.tsx", "src/fixtures.ts"])(
    "does not exempt %s",
    (path) => {
      expect(isExemptPath(path), "an honestly-named mock still ships to users").toBe(false);
    },
  );

  it("skips exempt files when assessing a tree", () => {
    const verdict = assessPlaceholders([
      {
        path: "src/a.test.ts",
        source: 'const x = "0x1111111111111111111111111111111111111111";',
      },
    ]);
    expect(verdict.ok).toBe(true);
    expect(verdict.filesScanned).toBe(0);
  });
});

describe("the report", () => {
  /**
   * Sabotage survivor: removing the zero-files branch changed nothing. "No findings over
   * nothing" must never read as clean — the same reason assessLayout names its viewports.
   */
  it("says plainly when nothing was scanned", () => {
    const verdict = assessPlaceholders([]);
    expect(verdict.filesScanned).toBe(0);
    expect(formatPlaceholders(verdict), "a scan of zero files reported as clean").toContain(
      "NO FILES SCANNED",
    );
    expect(formatPlaceholders(verdict)).toContain("not a pass");
  });

  it("counts the files it scanned on a pass, so the pass is auditable", () => {
    const report = formatPlaceholders(
      assessPlaceholders([{ path: "src/a.ts", source: "const x = 1;" }]),
    );
    expect(report).toContain("1 shipped file");
  });

  it("names the file, line and reason for each finding", () => {
    const report = formatPlaceholders(
      assessPlaceholders([
        {
          path: "src/screen.tsx",
          source: 'const H = "0x1111111111111111111111111111111111111111";',
        },
      ]),
    );
    expect(report).toContain("src/screen.tsx:1");
    expect(report).toContain("repeated-nibble-address");
    expect(report).toContain("nobody generates that");
  });
});
