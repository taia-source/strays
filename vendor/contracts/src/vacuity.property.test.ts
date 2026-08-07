import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkCampaignMetrics,
  checkNamingTrap,
  classifyTestFunction,
  extractFunctions,
  lintInvariantSource,
  parseMetricsTable,
  stripNonCode,
} from "./vacuity.js";

/**
 * Property-based tests for the vacuity linter.
 *
 * ══ Why a linter needs properties more than most code ══
 *
 * The example tests pin behaviour on Solidity fixtures I ran through Foundry. Those prove
 * the rules fire on the shapes I already knew about. The risk they cannot cover is the
 * one that makes a linter get switched off: **a false positive on code that is fine.**
 *
 * An agent that receives a spurious finding does not shrug — it edits working code to
 * satisfy the tool. A `naming-trap` fired at a correct `invariant_solvency` would have it
 * renamed into something that no longer runs as an invariant. The linter would then have
 * *caused* the exact defect it exists to prevent. So the properties below lean hard on the
 * negative direction: over a generated space of well-formed inputs, the output must be
 * empty.
 *
 * ══ The generator is the interesting part ══
 *
 * Generating arbitrary text and asserting "no crash" is nearly worthless — random strings
 * are not Solidity and exercise none of the parsing. These generators build *structurally
 * valid* Solidity from parts, so the space explored is the space the linter meets.
 */

const identifier = fc
  .array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")),
    { minLength: 1, maxLength: 12 },
  )
  .map((chars) => `f${chars.join("")}`);

/** A correct invariant: an invariant-prefixed name and an unconditional assertion. */
const correctInvariant = fc
  .tuple(fc.constantFrom("invariant_", "invariant", "statefulFuzz_"), identifier)
  .map(([prefix, name]) => `function ${prefix}${name}() public view { assertEq(a, b); }`);

/** A correct handler: bound() rather than assume, and any counter guarded by try/catch. */
const correctHandler = fc
  .tuple(identifier, fc.boolean())
  .map(
    ([name, withCounter]) =>
      `function ${name}(uint256 amt) external { ` +
      "amt = bound(amt, 1, 1e18); " +
      (withCounter ? "attempts++; try t.f(amt) { successes++; } catch { } " : "t.f(amt); ") +
      "}",
  );

describe("no false positives on correct code", () => {
  /**
   * The property that matters most. A correct suite must produce nothing, over the whole
   * generated space — because the failure mode of a false positive here is an agent
   * renaming a working invariant into one that never runs.
   */
  it("never reports a finding for a well-formed invariant suite", () => {
    fc.assert(
      fc.property(
        fc.array(correctInvariant, { minLength: 1, maxLength: 5 }),
        fc.array(correctHandler, { maxLength: 5 }),
        (invariants, handlers) => {
          const source = `contract T is Test {\n${[...invariants, ...handlers].join("\n")}\n}`;
          expect(lintInvariantSource(source)).toEqual([]);
        },
      ),
    );
  });

  /**
   * A correctly named invariant must never be classified as a test, whatever follows the
   * prefix. `invariantTest…` is the adversarial case: it contains the word "test" but
   * does not begin with it, so it IS a real invariant and must not be flagged.
   */
  it("never flags a name that begins with an invariant prefix", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("invariant", "invariant_", "statefulFuzz", "statefulFuzz_"),
        identifier,
        (prefix, rest) => {
          expect(classifyTestFunction(`${prefix}${rest}`)).toBe("invariant");
          expect(checkNamingTrap(`function ${prefix}${rest}() public {}`)).toEqual([]);
        },
      ),
      { examples: [["invariant", "Test_balance"] as const, ["invariant_", "test"] as const] },
    );
  });

  /**
   * ══ A redundancy, established by sabotage rather than assumed ══
   *
   * `checkNamingTrap` guards with `classifyTestFunction(...) !== "test"` and *then* applies
   * a `^`-anchored regex. Removing either — or both at once — leaves every test passing,
   * and that is correct rather than a gap: the two cannot disagree on any input.
   *
   * For a name starting with `test`, anchored and unanchored regexes match identically.
   * For a name not starting with `test`, the guard has already skipped it. So no input
   * exists that distinguishes them, and the anchor is provably redundant. A test cannot
   * catch a mutation that changes no behaviour, and writing one that appears to would be
   * self-deception.
   *
   * What the property below *does* earn: it pins the guard's real job — a helper whose
   * name merely mentions an invariant is never reported. That is the false positive that
   * would have an agent renaming working helpers to appease the linter.
   */
  it("never flags a function that merely contains the word invariant", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("check", "assert", "verify", "_", "helper"),
        fc.constantFrom("Invariant", "invariant", "StatefulFuzz", "statefulFuzz"),
        identifier,
        (prefix, middle, rest) => {
          const name = `${prefix}${middle}${rest}`;
          // Guard the premise: these must not begin with a test or invariant prefix, or
          // they are a different case entirely.
          fc.pre(classifyTestFunction(name) === "other");
          expect(checkNamingTrap(`function ${name}(uint256 a) internal { g(a); }`)).toEqual([]);
        },
      ),
      { examples: [["check", "Invariant", "Balance"] as const] },
    );
  });
});

describe("classification is total and exclusive", () => {
  /**
   * Every name lands in exactly one bucket, and the `test` prefix always wins.
   *
   * This is the model-based property: it restates Foundry's rule independently of the
   * implementation's branch order, so it holds regardless of how the arms are arranged.
   */
  it("classifies any identifier as test whenever it begins with test", () => {
    fc.assert(
      fc.property(identifier, (rest) => {
        expect(classifyTestFunction(`test${rest}`)).toBe("test");
      }),
    );
  });

  it("never returns invariant for a test-prefixed name", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("Invariant", "_invariant", "StatefulFuzz", "_statefulFuzz", ""),
        identifier,
        (middle, rest) => {
          expect(classifyTestFunction(`test${middle}${rest}`)).not.toBe("invariant");
        },
      ),
    );
  });
});

describe("stripNonCode invariants", () => {
  /**
   * Length and line count are preserved exactly, so every reported line number is true.
   *
   * Asserted with exact equality rather than a tolerance: the function replaces
   * character-for-character, so this is structurally exact, not luckily so.
   */
  it("preserves length and line count for any input", () => {
    fc.assert(
      fc.property(fc.string(), (source) => {
        const stripped = stripNonCode(source);
        expect(stripped).toHaveLength(source.length);
        expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
      }),
    );
  });

  /**
   * Idempotence: stripping twice equals stripping once. If it were not idempotent, the
   * output would still contain something that looks like a comment or string — meaning
   * the first pass missed it.
   */
  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (source) => {
        const once = stripNonCode(source);
        expect(stripNonCode(once)).toBe(once);
      }),
    );
  });

  /**
   * Nothing inside a comment can ever produce a finding.
   *
   * The concrete bug: a rule matching the word `invariant` in a docstring sends an agent
   * to edit prose. Generated over arbitrary text placed inside a comment, including text
   * that is itself valid Solidity.
   */
  it("never lets commented-out code produce a finding", () => {
    fc.assert(
      fc.property(fc.string(), correctInvariant, (junk, real) => {
        // A block-comment terminator inside the junk would end the comment early, which
        // is a lexing question rather than a linting one.
        fc.pre(!junk.includes("*/"));
        const source = `contract T {\n/* ${junk} */\n${real}\n}`;
        expect(lintInvariantSource(source)).toEqual([]);
      }),
    );
  });
});

describe("extractFunctions invariants", () => {
  /** Every extracted body is brace-balanced — the property a regex cannot give you. */
  it("returns balanced bodies for any number of functions", () => {
    fc.assert(
      fc.property(fc.array(correctHandler, { minLength: 1, maxLength: 6 }), (handlers) => {
        const fns = extractFunctions(`contract T {\n${handlers.join("\n")}\n}`);
        expect(fns).toHaveLength(handlers.length);
        for (const fn of fns) {
          const opens = (fn.body.match(/\{/g) ?? []).length;
          const closes = (fn.body.match(/\}/g) ?? []).length;
          expect(opens).toBe(closes);
          expect(fn.body.startsWith("{")).toBe(true);
          expect(fn.body.endsWith("}")).toBe(true);
        }
      }),
    );
  });

  /** Line numbers are 1-indexed and never exceed the source's line count. */
  it("reports line numbers within the source", () => {
    fc.assert(
      fc.property(fc.array(correctHandler, { minLength: 1, maxLength: 5 }), (handlers) => {
        const source = `contract T {\n${handlers.join("\n")}\n}`;
        const lines = source.split("\n").length;
        for (const fn of extractFunctions(source)) {
          expect(fn.line).toBeGreaterThanOrEqual(1);
          expect(fn.line).toBeLessThanOrEqual(lines);
        }
      }),
    );
  });
});

describe("checkCampaignMetrics invariants", () => {
  /**
   * A campaign where nothing reverted is never reported for reverting.
   *
   * The boundary tests pin the threshold; this pins the whole healthy region, so a
   * comparison accidentally inverted is caught over every call count rather than the
   * two the examples happen to use.
   */
  it("never reports a revert finding when nothing reverted", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (calls) => {
        const findings = checkCampaignMetrics([{ functionName: "H.f", calls, reverts: 0 }]);
        expect(findings.map((f) => f.rule)).not.toContain("high-revert-ratio");
      }),
    );
  });

  /**
   * Monotonicity: for a fixed call count, more reverts never turns a finding back into
   * silence. A threshold applied with an inverted comparison violates this immediately.
   */
  it("never becomes silent as the revert count rises", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.nat({ max: 10_000 }),
        fc.nat({ max: 10_000 }),
        (calls, a, b) => {
          const lo = Math.min(a, b, calls);
          const hi = Math.min(Math.max(a, b), calls);
          const flagged = (reverts: number) =>
            checkCampaignMetrics([{ functionName: "H.f", calls, reverts }]).some(
              (f) => f.rule === "high-revert-ratio",
            );
          if (flagged(lo)) expect(flagged(hi)).toBe(true);
        },
      ),
    );
  });

  /** Every finding names the function it concerns, or a caller cannot act on it. */
  it("always attributes a finding to a function", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100_000 }),
        fc.nat({ max: 100_000 }),
        fc.nat({ max: 1_000_000 }),
        (calls, revertSeed, discards) => {
          const reverts = calls === 0 ? 0 : revertSeed % (calls + 1);
          for (const finding of checkCampaignMetrics([
            { functionName: "H.f", calls, reverts, discards },
          ])) {
            expect(finding.functionName).toBe("H.f");
          }
        },
      ),
    );
  });
});

describe("parseMetricsTable round-trip", () => {
  /**
   * Hughes' "there and back again": numbers formatted into forge's table shape must come
   * back unchanged. This catches a column transposition — reading Reverts into Calls —
   * which no single-row example with tidy numbers would reveal.
   */
  it("round-trips any metrics through the table format", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.nat({ max: 1_000_000 }), fc.nat({ max: 1_000_000 }), fc.nat({ max: 1000 })),
          { minLength: 1, maxLength: 5 },
        ),
        (rows) => {
          const table = rows
            .map(
              ([calls, reverts, discards]) => `| C | sel | ${calls} | ${reverts} | ${discards} |`,
            )
            .join("\n");
          const parsed = parseMetricsTable(table);
          expect(parsed).toHaveLength(rows.length);
          rows.forEach(([calls, reverts, discards], i) => {
            expect(parsed[i]?.calls).toBe(calls);
            expect(parsed[i]?.reverts).toBe(reverts);
            expect(parsed[i]?.discards).toBe(discards);
          });
        },
      ),
    );
  });

  /** Text with no table yields nothing rather than inventing a row. */
  it("never invents metrics from arbitrary text", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/\|\s*\S+\s*\|\s*\S+\s*\|\s*\d+/.test(s)),
        (text) => {
          expect(parseMetricsTable(text)).toEqual([]);
        },
      ),
    );
  });
});
