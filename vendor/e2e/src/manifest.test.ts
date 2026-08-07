/**
 * Manifest tests.
 *
 * The manifest is what lets a generic package test an unanticipated project, so its
 * validation has to be strict — a bad manifest must fail immediately with a precise
 * message, not halfway through a browser run.
 */
import { describe, expect, it } from "vitest";
import {
  assertLocalOnly,
  demoFlowOf,
  type E2EManifest,
  EXAMPLE_MANIFEST,
  formatIssues,
  validateManifest,
} from "./manifest.js";

describe("validateManifest", () => {
  it("accepts the worked example", () => {
    expect(formatIssues(validateManifest(EXAMPLE_MANIFEST))).toBe("manifest is valid");
  });

  it("rejects a non-object rather than throwing", () => {
    expect(validateManifest(null)[0]?.problem).toMatch(/not an object/);
    expect(validateManifest("nope")[0]?.problem).toMatch(/not an object/);
  });

  it("requires the fields a run cannot proceed without", () => {
    const issues = validateManifest({ version: 1 });
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining(["project", "chainId", "rpcUrl", "baseUrl", "flows"]),
    );
  });

  /**
   * THE rule. Without it a manifest degrades into a UI smoke test — which passes when the
   * transaction reverted, which is the exact failure this package exists to catch.
   */
  it("refuses a flow with no on-chain expectation", () => {
    const manifest = {
      ...EXAMPLE_MANIFEST,
      flows: [{ ...EXAMPLE_MANIFEST.flows[0], expectations: [] }],
    } as unknown as E2EManifest;

    const issues = validateManifest(manifest);
    const problem = issues.find((i) => i.path.endsWith("expectations"))?.problem;
    expect(problem).toMatch(/only proves the UI rendered/);
    expect(problem).toMatch(/passes when the transaction reverted/);
  });

  it("refuses a flow with no steps", () => {
    const manifest = {
      ...EXAMPLE_MANIFEST,
      flows: [{ ...EXAMPLE_MANIFEST.flows[0], steps: [] }],
    } as unknown as E2EManifest;
    expect(validateManifest(manifest).some((i) => /does nothing/.test(i.problem))).toBe(true);
  });

  /** A typo'd probe name would otherwise silently assert nothing. */
  it("catches an expectation pointing at a probe that does not exist", () => {
    const manifest = {
      ...EXAMPLE_MANIFEST,
      flows: [
        {
          ...EXAMPLE_MANIFEST.flows[0],
          expectations: [{ probe: "totlaSupply", expect: "increased" }],
        },
      ],
    } as unknown as E2EManifest;

    const issue = validateManifest(manifest).find((i) => i.path.includes("expectations[0].probe"));
    expect(issue?.problem).toMatch(/does not match any probe/);
    // The message lists what IS available, so the fix is obvious.
    expect(issue?.problem).toMatch(/supply/);
  });

  it("requires an amount for exactly and atLeast", () => {
    const manifest = {
      ...EXAMPLE_MANIFEST,
      flows: [
        {
          ...EXAMPLE_MANIFEST.flows[0],
          expectations: [{ probe: "supply", expect: "exactly" }],
        },
      ],
    } as unknown as E2EManifest;
    expect(validateManifest(manifest).some((i) => /requires a "by" amount/.test(i.problem))).toBe(
      true,
    );
  });

  /** JSON has no bigint, so amounts travel as decimal strings — enforce that. */
  it("rejects a non-integer amount", () => {
    const manifest = {
      ...EXAMPLE_MANIFEST,
      flows: [
        {
          ...EXAMPLE_MANIFEST.flows[0],
          expectations: [{ probe: "supply", expect: "atLeast", by: "1.5e18" }],
        },
      ],
    } as unknown as E2EManifest;
    expect(validateManifest(manifest).some((i) => /decimal integer string/.test(i.problem))).toBe(
      true,
    );
  });

  it("accepts a negative amount, since a decrease is a legitimate expectation", () => {
    const manifest = {
      ...EXAMPLE_MANIFEST,
      flows: [
        {
          ...EXAMPLE_MANIFEST.flows[0],
          expectations: [{ probe: "supply", expect: "exactly", by: "-1000" }],
        },
      ],
    } as unknown as E2EManifest;
    expect(validateManifest(manifest)).toEqual([]);
  });

  it("catches a demoFlow naming a flow that does not exist", () => {
    const manifest = { ...EXAMPLE_MANIFEST, demoFlow: "nonexistent" };
    expect(validateManifest(manifest).some((i) => i.path === "demoFlow")).toBe(true);
  });

  /**
   * ══ The version gate ══
   *
   * `version` is the only field that says "this manifest was written against the schema
   * this code implements". Every existing test passed `version: 1`, so the rejection had
   * never fired.
   *
   * It matters because the failure it prevents is silent rather than loud. A future v2
   * manifest that renames `expectations` or restructures `probes` still parses as JSON,
   * and every field this validator does not recognise is simply ignored — so a v2
   * manifest run by v1 code would validate clean while its on-chain expectations were
   * never read at all. That is a run which proves nothing and reports success.
   *
   * A missing version is the same problem wearing different clothes, so both are checked.
   */
  it("rejects a version it was not written against, including a missing one", () => {
    for (const version of [2, 0, "1", undefined]) {
      const issues = validateManifest({ ...EXAMPLE_MANIFEST, version });
      const issue = issues.find((i) => i.path === "version");
      expect(issue?.problem, `version ${String(version)} must be rejected`).toBe("must be 1");
    }
  });

  /**
   * A flow needs a name and a path, and neither had ever been checked absent.
   *
   * `name` is how `demoFlow` selects the video and how every failure report identifies
   * which flow broke; `path` is the URL the runner opens. A flow missing `path` would
   * have the runner `goto(`${baseUrl}undefined`)` — a 404 that surfaces as "the button
   * was never found", sending someone to debug the UI for a manifest typo.
   */
  it("requires a name and a path on every flow", () => {
    const manifest = {
      ...EXAMPLE_MANIFEST,
      flows: [{ ...EXAMPLE_MANIFEST.flows[0], name: "", path: "" }],
    } as unknown as E2EManifest;

    const paths = validateManifest(manifest).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["flows[0].name", "flows[0].path"]));
  });

  /**
   * ══ A flow that omits the arrays entirely, rather than passing them empty ══
   *
   * The validator reads `flow.steps`, `flow.expectations` and `flow.probes` through
   * `?? []`. Existing tests always supplied `[]` explicitly, so the fallbacks had never
   * run — and a manifest is JSON from outside the type system, where an absent key is by
   * far the more likely shape than an empty array.
   *
   * Without the fallbacks this throws `TypeError: Cannot read properties of undefined
   * (reading 'length')` instead of reporting which field is missing. The whole purpose of
   * this function is that a malformed manifest fails immediately with a precise message
   * rather than crashing somewhere less obvious, so a crash here defeats it entirely.
   *
   * The `probes` fallback additionally feeds the "have: none" message — asserted below.
   */
  it("reports precise issues for a flow with the arrays missing, not a TypeError", () => {
    const manifest = { ...EXAMPLE_MANIFEST, flows: [{ name: "bare", path: "/" }] };

    // Calling it directly IS the "does not throw" assertion — a TypeError here fails the
    // test outright, and the issues it returns are then checked for precision.
    const issues = validateManifest(manifest as unknown as E2EManifest);

    const byPath = new Map(issues.map((i) => [i.path, i.problem]));
    expect(byPath.get("flows[0].steps")).toMatch(/does nothing/);
    expect(byPath.get("flows[0].expectations")).toMatch(/only proves the UI rendered/);
  });

  /**
   * The "have: none" arm of the unknown-probe message.
   *
   * When a flow declares expectations but no probes at all, listing the available probes
   * produces an empty join. Printing `have: )` reads as a truncated message; "none" tells
   * the author the actual problem — they wrote expectations and forgot the probes
   * entirely, which is a different fix from correcting a typo'd label.
   */
  it("says 'have: none' when a flow declared expectations but no probes", () => {
    const manifest = {
      ...EXAMPLE_MANIFEST,
      flows: [
        {
          name: "no-probes",
          path: "/",
          steps: [{ action: "click", role: "button", name: "Mint" }],
          expectations: [{ probe: "supply", expect: "increased" }],
        },
      ],
    } as unknown as E2EManifest;

    const issue = validateManifest(manifest).find(
      (i) => i.path === "flows[0].expectations[0].probe",
    );
    expect(issue?.problem).toContain('"supply" does not match any probe');
    expect(issue?.problem, "an empty probe list must read as 'none'").toContain("have: none");
  });
});

describe("demoFlowOf", () => {
  it("returns the named demo flow", () => {
    expect(demoFlowOf(EXAMPLE_MANIFEST)?.name).toBe("mint");
  });

  it("falls back to the first flow when none is named", () => {
    const { demoFlow, ...rest } = EXAMPLE_MANIFEST;
    expect(demoFlowOf(rest as E2EManifest)?.name).toBe("mint");
  });

  it("returns undefined when there are no flows at all", () => {
    expect(demoFlowOf({ ...EXAMPLE_MANIFEST, flows: [] })).toBeUndefined();
  });
});

describe("formatIssues", () => {
  it("names the exact path so the fix is mechanical", () => {
    const out = formatIssues(validateManifest({ version: 1 }));
    expect(out).toMatch(/manifest is INVALID/);
    expect(out).toMatch(/rpcUrl: required/);
  });

  /**
   * ══ The issue with no path at all ══
   *
   * `validateManifest(null)` returns a single issue with `path: ""` — the manifest itself
   * is the problem, so there is no field to point at. Formatting that with a bare `""`
   * yields a line beginning `  : manifest is not an object`, which reads as a rendering
   * bug rather than a diagnosis. `(root)` names the thing that is wrong.
   *
   * This is the first message anyone sees when a manifest fails to load — a missing file
   * parsed as `null`, a JSON parse that returned a string — so it is the one line that
   * most needs to be legible, and it had never been rendered.
   */
  it("labels a root-level issue '(root)' rather than leaving the path blank", () => {
    const out = formatIssues(validateManifest(null));
    expect(out).toContain("(root): manifest is not an object");
    expect(out, "an empty path must never render as a bare colon").not.toMatch(/^ +: /m);
  });
});

/**
 * The copy-onto-a-real-chain guard.
 *
 * EXAMPLE_MANIFEST exists to be copied, so a comment saying "local only" is not
 * enforcement. The failure it prevents is silent: a probe against an address where nothing
 * is deployed reads empty rather than throwing, so the whole run passes against nothing.
 */
describe("assertLocalOnly", () => {
  const realChain = (over: Partial<E2EManifest> = {}): E2EManifest => ({
    ...EXAMPLE_MANIFEST,
    chainId: 4663,
    rpcUrl: "https://rpc.example.com",
    baseUrl: "https://app.example.com",
    ...over,
  });

  it("passes the example manifest unchanged on its own local chain", () => {
    expect(assertLocalOnly(EXAMPLE_MANIFEST)).toEqual([]);
    expect(validateManifest(EXAMPLE_MANIFEST)).toEqual([]);
  });

  it("also treats 1337 as local", () => {
    expect(assertLocalOnly({ ...EXAMPLE_MANIFEST, chainId: 1337 })).toEqual([]);
  });

  it("refuses Anvil addresses once the chain id is real", () => {
    const problems = assertLocalOnly(realChain());
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toContain("neither throws");
  });

  it("names each distinct local address once, not once per occurrence", () => {
    // EXAMPLE_MANIFEST uses 0x5FbDB2… twice; repeating the same finding is noise.
    const problems = assertLocalOnly(realChain()).filter((p) => p.includes("0x5FbDB2"));
    expect(problems).toHaveLength(1);
  });

  it("flags a localhost URL left on a real chain", () => {
    const problems = assertLocalOnly(realChain({ rpcUrl: "http://127.0.0.1:8545", flows: [] }));
    expect(problems.join(" ")).toContain("cannot reach a real chain");
  });

  it("passes a genuinely real manifest", () => {
    // The control: without this the check could 'pass' by rejecting everything non-local.
    const clean = realChain({
      flows: [
        {
          name: "mint",
          path: "/",
          steps: [{ action: "click", role: "button", name: "Mint" }],
          probes: [
            {
              kind: "totalSupply",
              label: "supply",
              token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            },
          ],
          expectations: [{ probe: "supply", expect: "increased" }],
        },
      ],
      demoFlow: "mint",
    });
    expect(assertLocalOnly(clean)).toEqual([]);
    expect(validateManifest(clean)).toEqual([]);
  });

  it("is enforced by validateManifest, not merely available", () => {
    const issues = validateManifest(realChain());
    expect(issues.some((i) => i.problem.includes("Anvil/Hardhat local address"))).toBe(true);
  });
});
