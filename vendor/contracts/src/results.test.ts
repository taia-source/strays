import { describe, expect, it } from "vitest";
import {
  formatVerdict,
  judgeRun,
  parseForgeConfig,
  parseForgeJson,
  type TestResult,
} from "./results.js";

/**
 * ══ The fixtures are real forge output ══
 *
 * Every JSON document below was produced by running `forge test --json` on Foundry 1.7.1
 * (commit 4072e48) against a project built for the purpose, and pasted unedited. The
 * schema is de-facto — serialised Rust structs with no published JSON Schema — so a
 * fixture written from memory would test my recollection of it rather than the tool.
 *
 * `VACUOUS_JSON` in particular is the campaign that matters most: 128,000 calls, 128,000
 * reverts, `"status": "Success"`, exit code 0.
 */

/** Verbatim from a run against an always-reverting handler. */
const VACUOUS_JSON = `{
 "test/InvVacuous.t.sol:InvVacuousTest": {
  "duration": "1s 71ms 484µs 92ns",
  "test_results": {
   "invariant_alwaysTrue()": {
    "status": "Success",
    "reason": null,
    "kind": {
     "Invariant": {
      "runs": 256,
      "calls": 128000,
      "reverts": 128000,
      "metrics": {
       "src/Counter.sol:RevertingHandler.poke": {
        "calls": 128000,
        "reverts": 128000,
        "discards": 0
       }
      },
      "failed_corpus_replays": 0,
      "optimization_best_value": null
     }
    }
   }
  },
  "warnings": []
 }
}`;

/** A healthy run: all three kinds, plus a skipped test. */
const HEALTHY_JSON = `{
 "test/Counter.t.sol:CounterTest": {
  "duration": "2s",
  "test_results": {
   "invariant_numberBounded()": {
    "status": "Success", "reason": null,
    "kind": { "Invariant": { "runs": 256, "calls": 128000, "reverts": 0,
      "metrics": { "src/Counter.sol:Handler.setNumber": { "calls": 128000, "reverts": 0, "discards": 0 } },
      "failed_corpus_replays": 0, "optimization_best_value": null } }
   },
   "testFuzz_SetNumber(uint256)": {
    "status": "Success", "reason": null,
    "kind": { "Fuzz": { "first_case": { "gas": 50493, "stipend": 21204 }, "runs": 256,
      "mean_gas": 27656, "median_gas": 29289, "failed_corpus_replays": 0 } }
   },
   "test_Increment()": {
    "status": "Success", "reason": null, "kind": { "Unit": { "gas": 28783 } }
   }
  },
  "warnings": []
 }
}`;

describe("parseForgeJson", () => {
  it("parses the real vacuous-campaign document", () => {
    const results = parseForgeJson(VACUOUS_JSON);
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result?.status).toBe("Success");
    expect(result?.name).toBe("invariant_alwaysTrue()");
    expect(result?.kind).toEqual({
      type: "invariant",
      runs: 256,
      calls: 128000,
      reverts: 128000,
      metrics: {
        "src/Counter.sol:RevertingHandler.poke": {
          calls: 128000,
          reverts: 128000,
          discards: 0,
        },
      },
    });
  });

  it("distinguishes all three test kinds", () => {
    const kinds = parseForgeJson(HEALTHY_JSON).map((r) => r.kind.type);
    expect(kinds).toContain("invariant");
    expect(kinds).toContain("fuzz");
    expect(kinds).toContain("unit");
  });

  /**
   * ══ The single most important branch in this module ══
   *
   * `forge test --json --match-test <typo>` prints `No tests found in project!` to
   * **stdout** and exits **0**. Verified. If this returned an empty array, a filter typo
   * would present as a clean run and the gate would go green over an untested contract.
   */
  it("throws rather than returning empty when no test matched", () => {
    expect(() =>
      parseForgeJson("No tests found in project! Forge looks for functions that start with `test`"),
    ).toThrow(/not JSON/);
  });

  it("explains that forge still exits 0 in that case", () => {
    expect(() => parseForgeJson("No tests found in project!")).toThrow(/exits 0/);
  });

  /** A compile error also lands as plain text on stdout, and must fail the same way. */
  it("throws on compiler output", () => {
    expect(() => parseForgeJson("Error: Compilation failed")).toThrow(/not JSON/);
  });

  /** `--json --detailed` yields empty stdout — measured. Silence must not read as clean. */
  it("throws on empty output", () => {
    expect(() => parseForgeJson("   ")).toThrow(/no output/);
  });

  it("rejects JSON that is not a suite map", () => {
    expect(() => parseForgeJson("[1, 2, 3]")).toThrow(/suites/);
  });

  it("rejects an unrecognised status", () => {
    expect(() =>
      parseForgeJson('{"s.sol:T":{"test_results":{"t()":{"status":"Weird","kind":{}}}}}'),
    ).toThrow(/unexpected status/);
  });

  /**
   * The schema is de-facto and gains fields between versions — `optimization_best_value`
   * and `failed_corpus_replays` are recent additions. Unknown fields must be ignored
   * rather than rejected, or a Foundry upgrade breaks the gate.
   */
  it("tolerates unknown fields and unknown kinds", () => {
    const results = parseForgeJson(
      '{"s.sol:T":{"test_results":{"t()":{"status":"Success","kind":{"SomethingNew":{}},"future":1}}}}',
    );
    expect(results[0]?.kind.type).toBe("unit");
  });

  it("captures the failure reason", () => {
    const results = parseForgeJson(
      '{"s.sol:T":{"test_results":{"t()":{"status":"Failure","reason":"assertion failed","kind":{"Unit":{"gas":1}}}}}}',
    );
    expect(results[0]?.reason).toBe("assertion failed");
  });

  /**
   * ══ Malformed nodes are skipped, not crashed on ══
   *
   * The schema is de-facto — serialised Rust structs, no published JSON Schema — so the
   * parser tolerates a node it does not recognise rather than validating the whole
   * document. Each guard below is load-bearing: with the guard deleted, every one of
   * these inputs throws a raw `TypeError` out of `parseForgeJson` (verified by deleting
   * each line in turn). A `TypeError` here is strictly worse than the plain-text case
   * the module is built around, because it reads as a crash in the gate rather than as
   * a verdict about the contract.
   *
   * The assertion is on the SURVIVING results, not merely on "did not throw" — a guard
   * that skipped a well-formed sibling would pass a no-throw test and lose a real
   * result.
   */
  it("skips a suite whose value is not an object, keeping its well-formed siblings", () => {
    const results = parseForgeJson(
      '{"a.sol:T":"not an object","b.sol:U":null,' +
        '"c.sol:V":{"test_results":{"t()":{"status":"Success","kind":{"Unit":{"gas":7}}}}}}',
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.suite).toBe("c.sol:V");
  });

  it("skips a suite with no usable test_results, keeping its well-formed siblings", () => {
    const results = parseForgeJson(
      '{"a.sol:T":{"duration":"1s"},"b.sol:U":{"test_results":null},' +
        '"c.sol:V":{"test_results":{"t()":{"status":"Success","kind":{"Unit":{"gas":7}}}}}}',
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.suite).toBe("c.sol:V");
  });

  /**
   * A non-object test node must not reach the status check — the `String(record.status)`
   * in that error would otherwise report `undefined` for a node that never had a status
   * field, blaming the wrong thing.
   */
  it("skips a test node that is not an object, keeping its well-formed siblings", () => {
    const results = parseForgeJson(
      '{"a.sol:T":{"test_results":{"bad()":null,"alsoBad()":5,' +
        '"good()":{"status":"Success","kind":{"Unit":{"gas":7}}}}}}',
    );
    expect(results.map((r) => r.name)).toEqual(["good()"]);
  });

  /** `"kind": null` must degrade to a unit result, not dereference null. */
  it("treats a null kind as a unit test", () => {
    const results = parseForgeJson(
      '{"s.sol:T":{"test_results":{"t()":{"status":"Success","kind":null}}}}',
    );
    expect(results[0]?.kind).toStrictEqual({ type: "unit" });
  });

  /**
   * An invariant campaign with no `metrics` field at all. This is the shape a Foundry
   * version predating per-selector metrics emits, and the shape a future one could
   * return to. It must yield an empty metrics map — `judgeRun` iterates
   * `Object.entries(metrics)` for the dead-handler rule, and `Object.entries(undefined)`
   * throws.
   */
  it("defaults metrics to an empty map when the field is absent", () => {
    const results = parseForgeJson(
      '{"s.sol:T":{"test_results":{"t()":{"status":"Success",' +
        '"kind":{"Invariant":{"runs":256,"calls":128000,"reverts":0}}}}}}',
    );
    expect(results[0]?.kind).toStrictEqual({
      type: "invariant",
      runs: 256,
      calls: 128000,
      reverts: 0,
      metrics: {},
    });
  });

  /** One unusable selector entry must not discard the selectors beside it. */
  it("skips an unusable metrics entry while keeping the rest", () => {
    const results = parseForgeJson(
      '{"s.sol:T":{"test_results":{"t()":{"status":"Success","kind":{"Invariant":' +
        '{"runs":1,"calls":2,"reverts":0,"metrics":{"H.broken":null,' +
        '"H.good":{"calls":2,"reverts":1,"discards":0}}}}}}}}',
    );
    const kind = results[0]?.kind;
    expect(kind?.type).toBe("invariant");
    expect(kind?.type === "invariant" ? kind.metrics : undefined).toStrictEqual({
      "H.good": { calls: 2, reverts: 1, discards: 0 },
    });
  });

  /**
   * ══ Why `toStrictEqual`, and why the explicit `in` check ══
   *
   * A `Unit` node with no `gas` must produce `{ type: "unit" }` with **no `gas` key**,
   * not `{ type: "unit", gas: undefined }`. `exactOptionalPropertyTypes` is on, so the
   * two are different types, and a consumer doing `"gas" in kind` reads them
   * differently.
   *
   * This distinction is invisible to `toEqual` and to `JSON.stringify` — both ignore an
   * `undefined`-valued key. Confirmed by mutation: replacing the conditional with
   * `{ type: "unit", gas: gas as number }` leaves `toEqual({ type: "unit" })` GREEN.
   * `toStrictEqual` and the `in` check below both go red on that mutant, which is the
   * whole reason they are written this way rather than as the obvious `toEqual`.
   */
  it("omits the gas key entirely for a Unit node that has no gas", () => {
    const kind = parseForgeJson(
      '{"s.sol:T":{"test_results":{"t()":{"status":"Success","kind":{"Unit":{}}}}}}',
    )[0]?.kind;
    expect(kind).toStrictEqual({ type: "unit" });
    expect(kind !== undefined && "gas" in kind).toBe(false);
  });

  it("keeps the gas key when the Unit node reports one", () => {
    const kind = parseForgeJson(
      '{"s.sol:T":{"test_results":{"t()":{"status":"Success","kind":{"Unit":{"gas":28783}}}}}}',
    )[0]?.kind;
    expect(kind).toStrictEqual({ type: "unit", gas: 28783 });
  });
});

describe("parseForgeConfig", () => {
  /** Trimmed from real `forge config --json` output — the fields a gate needs. */
  const CONFIG_JSON = `{"invariant":{"runs":256,"depth":500,"fail_on_revert":false,
    "shrink_run_limit":5000,"max_assume_rejects":65536,"show_metrics":true,
    "timeout":null,"check_interval":1}}`;

  it("reads the effective invariant config", () => {
    expect(parseForgeConfig(CONFIG_JSON)).toEqual({
      runs: 256,
      failOnRevert: false,
      depth: 500,
      timeout: null,
      checkInterval: 1,
    });
  });

  it("reads a configured timeout", () => {
    expect(parseForgeConfig('{"invariant":{"runs":1,"timeout":900}}').timeout).toBe(900);
  });

  it("throws when the output is not JSON", () => {
    expect(() => parseForgeConfig("not json")).toThrow(/did not produce JSON/);
  });

  it("throws when there is no invariant section", () => {
    expect(() => parseForgeConfig('{"fuzz":{"runs":256}}')).toThrow(/no \[invariant\]/);
  });
});

describe("judgeRun", () => {
  const invariant = (over: Partial<{ runs: number; calls: number; reverts: number }> = {}) =>
    ({
      suite: "test/T.sol:T",
      name: "invariant_x()",
      status: "Success",
      kind: {
        type: "invariant",
        runs: over.runs ?? 256,
        calls: over.calls ?? 128000,
        reverts: over.reverts ?? 0,
        metrics: {},
      },
    }) satisfies TestResult;

  it("blocks the real vacuous campaign", () => {
    const verdict = judgeRun({ results: parseForgeJson(VACUOUS_JSON) });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.map((p) => p.rule)).toContain("vacuous-campaign");
  });

  it("passes a healthy run", () => {
    expect(judgeRun({ results: parseForgeJson(HEALTHY_JSON) }).ok).toBe(true);
  });

  it("blocks a failing test", () => {
    const verdict = judgeRun({
      results: [{ ...invariant(), status: "Failure", reason: "assertion failed" }],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]?.rule).toBe("test-failed");
  });

  /**
   * ══ A failure with no reason is still a failure, and must still say something ══
   *
   * forge emits `"reason": null` for a failure it has no message for — a plain
   * `assert(false)` with no revert string is the common case, and the parser maps that
   * to `undefined`. Without the `??` fallback the problem's `message` is `undefined`,
   * which `formatVerdict` renders as the literal string "undefined" under the rule name.
   * A gate that blocks a contract while printing "undefined" as its entire justification
   * is one an operator cannot act on.
   *
   * Asserted on the message VALUE rather than on `ok`, because the verdict blocks either
   * way — the fallback changes only what the operator is told, so only the text can
   * catch its removal.
   */
  it("states that a failure had no stated reason rather than reporting undefined", () => {
    const verdict = judgeRun({
      results: parseForgeJson(
        '{"s.sol:T":{"test_results":{"t()":{"status":"Failure","reason":null,' +
          '"kind":{"Unit":{"gas":1}}}}}}',
      ),
      requireInvariants: false,
    });
    const failure = verdict.problems.find((p) => p.rule === "test-failed");
    expect(failure?.message).toBe("failed without a stated reason");
    expect(formatVerdict(verdict)).not.toContain("undefined");
  });

  /** The same rule the TypeScript side enforces: forge exits 0 on vm.skip. */
  it("blocks a skipped test", () => {
    const verdict = judgeRun({ results: [{ ...invariant(), status: "Skipped" }] });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.map((p) => p.rule)).toContain("test-skipped");
  });

  /** A suite with no invariants passes `forge test` trivially; that absence is a finding. */
  it("blocks a run with no invariant tests by default", () => {
    const verdict = judgeRun({
      results: [{ suite: "s", name: "test_x()", status: "Success", kind: { type: "unit" } }],
    });
    expect(verdict.problems.map((p) => p.rule)).toContain("no-invariant-tests");
  });

  it("allows opting out of the invariant requirement explicitly", () => {
    const verdict = judgeRun({
      results: [{ suite: "s", name: "test_x()", status: "Success", kind: { type: "unit" } }],
      requireInvariants: false,
    });
    expect(verdict.ok).toBe(true);
  });

  /**
   * The timeout detector. A truncated campaign reports Success with no flag anywhere in
   * the JSON — measured, `runs: 465` against a configured 100,000 — so the shortfall is
   * the only evidence available.
   */
  it("blocks a campaign truncated by a timeout", () => {
    const verdict = judgeRun({
      results: [invariant({ runs: 465 })],
      config: { runs: 100000, failOnRevert: true, depth: 500, timeout: 5, checkInterval: 1 },
    });
    expect(verdict.problems.map((p) => p.rule)).toContain("campaign-truncated");
  });

  it("does not report truncation when the campaign completed", () => {
    const verdict = judgeRun({
      results: [invariant({ runs: 256 })],
      config: { runs: 256, failOnRevert: true, depth: 500, timeout: null, checkInterval: 1 },
    });
    expect(verdict.problems.map((p) => p.rule)).not.toContain("campaign-truncated");
  });

  /**
   * The aggregate hides a dead handler: nine healthy handlers and one that always
   * reverts totals ~10% reverts, far under any sane threshold. Per-selector catches it.
   */
  it("catches one dead handler inside an otherwise healthy campaign", () => {
    const verdict = judgeRun({
      results: [
        {
          suite: "test/T.sol:T",
          name: "invariant_x()",
          status: "Success",
          kind: {
            type: "invariant",
            runs: 256,
            calls: 100000,
            reverts: 10000,
            metrics: {
              "src/A.sol:H.good": { calls: 90000, reverts: 0, discards: 0 },
              "src/A.sol:H.dead": { calls: 10000, reverts: 10000, discards: 0 },
            },
          },
        },
      ],
    });
    expect(verdict.ok).toBe(false);
    const dead = verdict.problems.find((p) => p.rule === "dead-handler");
    expect(dead?.message).toContain("H.dead");
  });

  it("blocks a campaign that made no calls", () => {
    const verdict = judgeRun({ results: [invariant({ calls: 0 })] });
    expect(verdict.problems.map((p) => p.rule)).toContain("no-calls");
  });

  /** fail_on_revert is a warning, not a block — this gate reads the metrics regardless. */
  it("warns but does not block on fail_on_revert false", () => {
    const verdict = judgeRun({
      results: [invariant()],
      config: { runs: 256, failOnRevert: false, depth: 500, timeout: null, checkInterval: 1 },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.problems.map((p) => p.rule)).toContain("fail-on-revert-false");
  });

  /**
   * ══ Boundaries, asserted exactly ══
   *
   * The fencepost class has survived sabotage four times in this repo. A direction test
   * ("100% blocked, 0% allowed") cannot distinguish `>=` from `>`, so the threshold is
   * pinned from both sides.
   */
  it("blocks a revert ratio exactly at the threshold", () => {
    expect(judgeRun({ results: [invariant({ calls: 100, reverts: 90 })] }).ok).toBe(false);
  });

  it("allows one call below the revert threshold", () => {
    expect(judgeRun({ results: [invariant({ calls: 100, reverts: 89 })] }).ok).toBe(true);
  });

  /** Truncation is `runs < configured`; exactly equal must pass. */
  it("treats exactly the configured run count as complete", () => {
    const config = { runs: 256, failOnRevert: true, depth: 500, timeout: null, checkInterval: 1 };
    expect(
      judgeRun({ results: [invariant({ runs: 256 })], config }).problems.map((p) => p.rule),
    ).not.toContain("campaign-truncated");
    expect(
      judgeRun({ results: [invariant({ runs: 255 })], config }).problems.map((p) => p.rule),
    ).toContain("campaign-truncated");
  });

  it("counts what it saw", () => {
    const verdict = judgeRun({ results: parseForgeJson(HEALTHY_JSON) });
    expect(verdict.counts).toEqual({ total: 3, invariants: 1, failed: 0, skipped: 0 });
  });
});

describe("formatVerdict", () => {
  it("states the exit code is not the answer when blocking", () => {
    const text = formatVerdict(judgeRun({ results: parseForgeJson(VACUOUS_JSON) }));
    expect(text).toContain("CONTRACTS BLOCKED");
    expect(text).toContain("exit code is not the answer");
  });

  it("reports OK for a healthy run", () => {
    expect(formatVerdict(judgeRun({ results: parseForgeJson(HEALTHY_JSON) }))).toContain(
      "contracts OK",
    );
  });

  /** A warning-only run is OK, but must not read as unqualified success. */
  it("distinguishes clean from OK-with-warnings", () => {
    const verdict = judgeRun({
      results: parseForgeJson(HEALTHY_JSON),
      config: { runs: 256, failOnRevert: false, depth: 500, timeout: null, checkInterval: 1 },
    });
    expect(formatVerdict(verdict)).toContain("with warnings");
  });
});
