import { describe, expect, it } from "vitest";
import {
  checkCampaignMetrics,
  checkConditionalInvariant,
  checkConfig,
  checkHandler,
  checkNamingTrap,
  classifyTestFunction,
  extractFunctions,
  formatFindings,
  lintInvariantSource,
  parseMetricsTable,
  stripNonCode,
} from "./vacuity.js";

/**
 * ══ These fixtures are not invented ══
 *
 * Every Solidity snippet below was compiled and RUN on Foundry 1.7.1 (commit 4072e48)
 * before being pasted here, and the campaign output each one produced is quoted with it.
 * That matters more than usual: the whole module is a claim about how Foundry behaves, so
 * a fixture written from memory would test my recollection rather than the tool.
 *
 * The metrics tables are likewise copied verbatim from real `forge test` output, box-
 * drawing characters and all, so the parser is tested against the actual format rather
 * than a tidied version of it.
 */

/** Ran as `[PASS] testInvariant_trap() (gas: 278)` — one call, not 128,000. */
const NAMING_TRAP = `
contract NamingTest is Test {
    function invariant_ok() public view { assertTrue(true); }
    function statefulFuzz_ok() public view { assertTrue(true); }
    function testInvariant_trap() public view { assertTrue(true); }
}`;

/** Ran as `[PASS] invariant_earlyReturn() (runs: 256, calls: 128000, reverts: 0)`. */
const EARLY_RETURN = `
contract T is Test {
    function invariant_earlyReturn() public view {
        if (c.total() == 0) return;
        assertEq(c.total(), 999999);
    }
}`;

/** Produced `attempts=0 successes=0` after 128,000 reverts, and PASSED. */
const ROLLBACK_COUNTER = `
contract BadH is Test {
    uint256 public attempts; uint256 public successes;
    function deposit(uint256 amt) external { attempts++; c.deposit(amt); successes++; }
}`;

/** The try/catch form. Re-measured: FAILED with "success ratio too low: 0 < 25000". */
const GUARDED_COUNTER = `
contract FixedH is Test {
    uint256 public attempts; uint256 public successes;
    function deposit(uint256 amt) external {
        attempts++;
        try c.deposit(amt) { successes++; } catch { }
    }
}`;

describe("classifyTestFunction", () => {
  /**
   * The ordering IS the trap. Foundry's `TestFunctionKind::classify` matches the `test`
   * arm first and returns, so it never reaches the invariant arm. If this ever flips,
   * the naming rule below becomes wrong rather than merely noisy.
   */
  it("matches the test prefix before the invariant prefix, as Foundry does", () => {
    expect(classifyTestFunction("testInvariant_trap")).toBe("test");
    expect(classifyTestFunction("test_invariant_balance")).toBe("test");
    expect(classifyTestFunction("testStatefulFuzz_x")).toBe("test");
  });

  it("accepts both invariant prefixes", () => {
    expect(classifyTestFunction("invariant_ok")).toBe("invariant");
    expect(classifyTestFunction("statefulFuzz_ok")).toBe("invariant");
  });

  /** The trailing underscore is convention, not syntax — bare `invariantFoo` runs. */
  it("does not require the conventional underscore", () => {
    expect(classifyTestFunction("invariantSolvency")).toBe("invariant");
  });

  it("recognises the campaign hook and setup", () => {
    expect(classifyTestFunction("afterInvariant")).toBe("afterInvariant");
    expect(classifyTestFunction("setUp")).toBe("setUp");
  });

  it("treats an ordinary handler as neither", () => {
    expect(classifyTestFunction("deposit")).toBe("other");
  });
});

describe("checkNamingTrap", () => {
  it("catches a test-prefixed function named like an invariant", () => {
    const findings = checkNamingTrap(NAMING_TRAP);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.functionName).toBe("testInvariant_trap");
    expect(findings[0]?.severity).toBe("high");
  });

  it("suggests the corrected name", () => {
    expect(checkNamingTrap(NAMING_TRAP)[0]?.message).toContain("invariant_trap");
  });

  /**
   * The false-positive that would matter most: a real invariant must never be flagged,
   * or an agent "fixing" it renames a working test into the trap.
   */
  it("leaves genuine invariants alone", () => {
    expect(checkNamingTrap("function invariant_ok() public {}")).toHaveLength(0);
    expect(checkNamingTrap("function statefulFuzz_ok() public {}")).toHaveLength(0);
  });

  /** An ordinary unit test is not an invariant and must not be reported as a broken one. */
  it("does not flag ordinary tests", () => {
    expect(checkNamingTrap("function testDeposit() public {}")).toHaveLength(0);
    expect(checkNamingTrap("function test_transfer_reverts() public {}")).toHaveLength(0);
  });
});

describe("checkConditionalInvariant", () => {
  it("catches the guard that swallows the assertion", () => {
    const findings = checkConditionalInvariant(EARLY_RETURN);
    expect(findings.map((f) => f.rule)).toContain("conditional-invariant");
  });

  it("catches an invariant with no assertion at all", () => {
    const findings = checkConditionalInvariant(`
      contract T { function invariant_nothing() public view { uint256 x = 1; } }`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("no-assertion");
    expect(findings[0]?.severity).toBe("high");
  });

  /**
   * `no-assertion` supersedes `conditional-invariant` — reporting both for one function
   * would have an agent add an assertion inside the dead branch, which is worse than
   * where it started.
   */
  it("reports only the stronger finding when a function has neither assert nor guard", () => {
    const findings = checkConditionalInvariant(`
      contract T { function invariant_x() public view { if (a) return; } }`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("no-assertion");
  });

  it("accepts an unconditional assertion", () => {
    expect(
      checkConditionalInvariant(`
      contract T { function invariant_ok() public view { assertEq(a, b); } }`),
    ).toHaveLength(0);
  });

  /** A handler is allowed to return early; only invariants are held to this. */
  it("ignores early returns in non-invariant functions", () => {
    expect(
      checkConditionalInvariant(`
      contract H { function deposit(uint256 a) external { if (a == 0) return; c.d(a); } }`),
    ).toHaveLength(0);
  });
});

describe("checkHandler", () => {
  /**
   * The finding I would not have written without measuring: the counter meant to detect
   * an always-reverting handler is itself reverted, reports 0/0, and passes.
   */
  it("catches a success counter that a revert would roll back", () => {
    const findings = checkHandler(ROLLBACK_COUNTER);
    expect(findings.map((f) => f.rule)).toContain("rollback-blind-counter");
    expect(findings.find((f) => f.rule === "rollback-blind-counter")?.severity).toBe("high");
  });

  /** The try/catch form is the fix, verified to fail correctly. It must not be flagged. */
  it("accepts a counter guarded by try/catch", () => {
    expect(checkHandler(GUARDED_COUNTER).map((f) => f.rule)).not.toContain(
      "rollback-blind-counter",
    );
  });

  it("catches vm.assume used for bounding", () => {
    const findings = checkHandler(`
      contract H { function deposit(uint256 a) external { vm.assume(a < 100); c.d(a); } }`);
    expect(findings.map((f) => f.rule)).toContain("assume-in-handler");
  });

  it("accepts bound()", () => {
    expect(
      checkHandler(`
      contract H { function deposit(uint256 a) external { a = bound(a, 1, 100); c.d(a); } }`),
    ).toHaveLength(0);
  });

  /**
   * Only functions the fuzzer can actually call are handlers. Flagging an internal
   * helper sends an agent to edit code that no campaign ever reaches.
   */
  it("ignores internal and private functions", () => {
    expect(
      checkHandler(`
      contract H { function _helper(uint256 a) internal { vm.assume(a < 100); } }`),
    ).toHaveLength(0);
  });

  /** An invariant may legitimately use vm.assume; the rule is about handlers. */
  it("ignores invariant functions", () => {
    expect(
      checkHandler(`
      contract T { function invariant_x() public view { vm.assume(true); assertTrue(a); } }`),
    ).toHaveLength(0);
  });
});

describe("checkConfig", () => {
  /**
   * `[invariant] fail_on_revert` defaults to false while `[fuzz]` defaults to true —
   * opposite, confirmed by `forge config`. An empty config therefore has the dangerous
   * default and must be reported.
   */
  it("reports the dangerous default when nothing is configured", () => {
    expect(checkConfig({}).map((f) => f.rule)).toContain("fail-on-revert-false");
  });

  it("accepts fail_on_revert set true for invariants", () => {
    expect(checkConfig({ invariant: { failOnRevert: true } }).map((f) => f.rule)).not.toContain(
      "fail-on-revert-false",
    );
  });

  /** The silent-inheritance trap: setting it under [fuzz] alone changes invariant runs. */
  it("warns when the invariant section inherits from fuzz", () => {
    const findings = checkConfig({ fuzz: { failOnRevert: true } });
    expect(findings.map((f) => f.rule)).toContain("silent-config-inheritance");
  });

  /** Inheritance means a true value under [fuzz] genuinely does apply to invariants. */
  it("treats an inherited true as satisfying the requirement", () => {
    expect(checkConfig({ fuzz: { failOnRevert: true } }).map((f) => f.rule)).not.toContain(
      "fail-on-revert-false",
    );
  });

  it("says nothing about inheritance when both are set explicitly", () => {
    expect(
      checkConfig({
        fuzz: { failOnRevert: true },
        invariant: { failOnRevert: true },
      }).map((f) => f.rule),
    ).not.toContain("silent-config-inheritance");
  });

  it("catches check_interval = 0, which asserts only on the final call", () => {
    expect(
      checkConfig({ invariant: { failOnRevert: true, checkInterval: 0 } }).map((f) => f.rule),
    ).toContain("check-interval-zero");
  });
});

describe("checkCampaignMetrics", () => {
  /** The exact numbers the always-reverting handler produced. */
  it("catches a campaign where every call reverted", () => {
    const findings = checkCampaignMetrics([
      { functionName: "BadH.deposit", calls: 128000, reverts: 128000 },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("high-revert-ratio");
    expect(findings[0]?.severity).toBe("high");
  });

  /**
   * The Foundry Book's own handler example runs at 55% reverts. Flagging that would
   * flag the canonical reference implementation, so the default threshold must clear it.
   */
  it("accepts the Foundry Book's own 55% revert rate", () => {
    expect(
      checkCampaignMetrics([{ functionName: "Handler.deposit", calls: 10000, reverts: 5533 }]),
    ).toHaveLength(0);
  });

  it("catches a handler the fuzzer never reached", () => {
    const findings = checkCampaignMetrics([{ functionName: "H.deposit", calls: 0, reverts: 0 }]);
    expect(findings[0]?.rule).toBe("no-calls");
  });

  /** Zero calls is its own diagnosis; a 0/0 ratio must not also be reported. */
  it("does not also report a revert ratio for a zero-call handler", () => {
    const findings = checkCampaignMetrics([{ functionName: "H.d", calls: 0, reverts: 0 }]);
    expect(findings).toHaveLength(1);
  });

  /**
   * The exact numbers from the measured assume-heavy run: 1,147,316 discarded of
   * 1,275,316 generated, with only 128,000 landing. The first version of this rule
   * compared discards to *calls* and missed it, because 1,147,316 is not more than
   * 128,000 × 10. Pinned here so the denominator cannot silently revert to calls.
   */
  it("catches assume-driven discards at the measured ratio", () => {
    const findings = checkCampaignMetrics([
      { functionName: "H.d", calls: 128000, reverts: 0, discards: 1_147_316 },
    ]);
    expect(findings.map((f) => f.rule)).toContain("high-discard-ratio");
    expect(findings[0]?.message).toContain("1275316 generated");
  });

  /** A handful of discards is ordinary and must not be reported. */
  it("accepts a small number of discards", () => {
    expect(
      checkCampaignMetrics([{ functionName: "H.d", calls: 128000, reverts: 0, discards: 500 }]),
    ).toHaveLength(0);
  });

  it("honours a caller-supplied discard threshold", () => {
    const metrics = [{ functionName: "H.d", calls: 100, reverts: 0, discards: 40 }];
    expect(checkCampaignMetrics(metrics)).toHaveLength(0);
    expect(checkCampaignMetrics(metrics, { maxDiscardRatio: 0.25 })).toHaveLength(1);
  });

  it("honours a caller-supplied threshold", () => {
    const metrics = [{ functionName: "H.d", calls: 100, reverts: 60 }];
    expect(checkCampaignMetrics(metrics)).toHaveLength(0);
    expect(checkCampaignMetrics(metrics, { maxRevertRatio: 0.5 })).toHaveLength(1);
  });

  /**
   * ══ The boundary, asserted exactly ══
   *
   * A direction test ("100% is caught, 55% is not") is structurally blind to a fencepost:
   * changing `>=` to `>` passes every one of them. Sabotage confirmed it — flipping the
   * comparison survived all 56 tests, which is the fourth time in this repo that a
   * monotonicity property missed an off-by-one.
   *
   * The threshold is documented as "flag at 90% or above", so exactly 90% must be a
   * finding and one call below it must not. Together these two pin the comparison in
   * both directions and leave no room for either mutant.
   */
  it("flags a revert ratio exactly at the threshold", () => {
    expect(checkCampaignMetrics([{ functionName: "H.d", calls: 100, reverts: 90 }])).toHaveLength(
      1,
    );
  });

  it("does not flag one call below the revert threshold", () => {
    expect(checkCampaignMetrics([{ functionName: "H.d", calls: 100, reverts: 89 }])).toHaveLength(
      0,
    );
  });

  /** The same fencepost, on the discard rule — it survived the identical sabotage. */
  it("flags a discard ratio exactly at the threshold", () => {
    expect(
      checkCampaignMetrics([{ functionName: "H.d", calls: 50, reverts: 0, discards: 50 }]),
    ).toHaveLength(1);
  });

  it("does not flag one discard below the threshold", () => {
    expect(
      checkCampaignMetrics([{ functionName: "H.d", calls: 51, reverts: 0, discards: 50 }]),
    ).toHaveLength(0);
  });

  it("is silent on a healthy campaign", () => {
    expect(
      checkCampaignMetrics([
        { functionName: "H.deposit", calls: 128000, reverts: 1200, discards: 0 },
      ]),
    ).toHaveLength(0);
  });
});

describe("parseMetricsTable", () => {
  /** Copied verbatim from `forge test -vv`, box-drawing characters included. */
  const REAL_OUTPUT = `
[PASS] invariant_x() (runs: 256, calls: 128000, reverts: 128000)

╭----------+----------+--------+---------+----------╮
| Contract | Selector | Calls  | Reverts | Discards |
+===================================================+
| BadH     | deposit  | 128000 | 128000  | 0        |
╰----------+----------+--------+---------+----------╯
`;

  it("parses forge's real metrics table", () => {
    const metrics = parseMetricsTable(REAL_OUTPUT);
    expect(metrics).toEqual([
      { functionName: "BadH.deposit", calls: 128000, reverts: 128000, discards: 0 },
    ]);
  });

  /** The header row has the same pipe shape; requiring digits must exclude it. */
  it("does not mistake the header row for data", () => {
    expect(parseMetricsTable(REAL_OUTPUT)).toHaveLength(1);
  });

  it("parses several handlers", () => {
    const metrics = parseMetricsTable(`
| Contract | Selector | Calls | Reverts | Discards |
| H        | deposit  | 100   | 5       | 0        |
| H        | withdraw | 200   | 10      | 3        |
`);
    expect(metrics).toHaveLength(2);
    expect(metrics[1]?.functionName).toBe("H.withdraw");
    expect(metrics[1]?.discards).toBe(3);
  });

  it("returns nothing for output with no table", () => {
    expect(parseMetricsTable("[PASS] invariant_x() (runs: 256)")).toEqual([]);
  });

  /** End to end: real output in, finding out. */
  it("feeds checkCampaignMetrics directly", () => {
    const findings = checkCampaignMetrics(parseMetricsTable(REAL_OUTPUT));
    expect(findings[0]?.rule).toBe("high-revert-ratio");
  });
});

describe("stripNonCode", () => {
  /**
   * Without stripping, a rule fires on the word `invariant` in prose and an agent edits
   * a comment to chase it.
   */
  it("removes line and block comments", () => {
    expect(stripNonCode("a // testInvariant_x\nb").trim().split("\n")[0]?.trim()).toBe("a");
    expect(stripNonCode("a /* function testInvariant_x() */ b")).not.toContain("function");
  });

  it("removes string literals", () => {
    expect(stripNonCode('require(a, "function testInvariant_x()");')).not.toContain("function");
  });

  /** Byte offsets must survive, or every reported line number is wrong. */
  it("preserves length and newlines so line numbers stay true", () => {
    const source = 'a // x\nb /* y\nz */ c\nd "e"\n';
    const stripped = stripNonCode(source);
    expect(stripped).toHaveLength(source.length);
    expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
  });

  /** An escaped quote must not terminate the literal early. */
  it("handles escaped quotes inside strings", () => {
    expect(stripNonCode('"a\\"b" function f()')).toContain("function");
  });

  /**
   * ══ A newline INSIDE a string literal, which is the case that shifts line numbers ══
   *
   * The test above pins newline preservation for a block comment. A string literal is a
   * separate code path — the scanner runs to the closing quote without caring about
   * newlines — and it is the one that was uncovered.
   *
   * This matters because a finding's `line` is the only thing pointing an agent at the
   * offending function. Measured by mutation: replacing the newline arm with a plain
   * space makes `checkNamingTrap` report the trap function at **line 3 instead of line
   * 5** for the source below. The rule still fires, the message is still correct, and
   * the location is silently wrong — an agent sent to line 3 finds a string constant.
   *
   * A multi-line string is not exotic Solidity; it is how any embedded ABI, error text
   * or SVG literal is written.
   */
  it("keeps line numbers true across a multi-line string literal", () => {
    const source = [
      "contract T {",
      '    string constant NOTE = "first',
      "second",
      'third";',
      "    function testInvariant_trap() public view { assertTrue(true); }",
      "}",
    ].join("\n");

    expect(stripNonCode(source)).toHaveLength(source.length);
    // The trap is on line 5 of the source. Three newlines live inside the literal; if
    // any is collapsed to a space the reported line slides up by that many.
    expect(extractFunctions(source)[0]?.line).toBe(5);
    expect(checkNamingTrap(source)[0]?.line).toBe(5);
  });

  it("leaves ordinary code untouched", () => {
    expect(stripNonCode("function f() public {}")).toBe("function f() public {}");
  });
});

describe("extractFunctions", () => {
  it("finds a function and its body", () => {
    const fns = extractFunctions("contract T { function f() public { assertTrue(a); } }");
    expect(fns).toHaveLength(1);
    expect(fns[0]?.name).toBe("f");
    expect(fns[0]?.body).toContain("assertTrue");
  });

  /** A regex cannot balance braces; nested blocks are entirely ordinary in a handler. */
  it("brace-matches a nested body", () => {
    const fns = extractFunctions(`
      contract T {
        function f() public { if (a) { g(); } assertTrue(b); }
        function h() public { assertEq(1, 2); }
      }`);
    expect(fns).toHaveLength(2);
    expect(fns[0]?.body).toContain("assertTrue");
    expect(fns[1]?.name).toBe("h");
  });

  it("skips declarations with no body", () => {
    const fns = extractFunctions("interface I { function f() external; }");
    expect(fns).toHaveLength(0);
  });

  it("captures attributes so visibility can be read", () => {
    const fns = extractFunctions("contract T { function f() external view returns (uint) { } }");
    expect(fns[0]?.attributes).toContain("external");
  });

  it("reports 1-indexed line numbers", () => {
    const fns = extractFunctions("contract T {\n\n  function f() public { }\n}");
    expect(fns[0]?.line).toBe(3);
  });

  /** A paren inside the parameter list must not end it early. */
  it("walks past parentheses in the parameter list", () => {
    const fns = extractFunctions("contract T { function f(bytes memory b) public { g(); } }");
    expect(fns).toHaveLength(1);
    expect(fns[0]?.body).toContain("g()");
  });

  /**
   * ══ A NESTED paren in the parameter list, and why the depth counter is not cosmetic ══
   *
   * The test above has no nested paren, so it never exercises the increment — only the
   * decrement. A Solidity function-type parameter puts a real paren pair inside the
   * parameter list:
   *
   *     function _h(function(uint256) external cb, uint256 a) internal
   *
   * Counting depth up as well as down is what makes the walk stop at the parameter
   * list's own closing paren rather than at the inner one.
   *
   * Measured by mutation — deleting the `parenDepth++` arm makes `attributes` come back
   * as `" external cb, uint256 a) internal "` instead of `" internal "`. The `external`
   * there belongs to the *callback type*, not to the function, and `checkHandler` tests
   * `attributes` against `/\b(external|public)\b/` to decide whether the fuzzer can
   * reach a function at all. So the mutant reclassifies an `internal` helper as a
   * handler and reports `assume-in-handler` against it.
   *
   * That is a false positive of the precise kind the suite already guards against for
   * ordinary internal functions ("ignores internal and private functions") — it sends an
   * agent to rewrite a helper no campaign ever calls. The attribute assertion is the
   * load-bearing one here; the two `checkHandler` expectations are what turn a parsing
   * detail into the user-visible consequence.
   */
  it("counts nested parens so a function-type parameter does not leak into attributes", () => {
    const source =
      "contract H { function _h(function(uint256) external cb, uint256 a) internal " +
      "{ vm.assume(a < 100); } }";
    const fns = extractFunctions(source);

    expect(fns).toHaveLength(1);
    expect(fns[0]?.attributes.trim()).toBe("internal");
    expect(fns[0]?.attributes).not.toContain("external");

    // The consequence: an internal helper is not a handler, so no finding is reported.
    expect(checkHandler(source)).toEqual([]);
  });

  /**
   * The same shape on a function that genuinely IS reachable, so the test above cannot
   * pass merely by the parser giving up and returning nothing. Here `external` is the
   * function's own visibility and the finding must fire.
   */
  it("still reads real visibility past a function-type parameter", () => {
    const source =
      "contract H { function deposit(function(uint256) internal cb, uint256 a) external " +
      "{ vm.assume(a < 100); } }";

    expect(extractFunctions(source)[0]?.attributes.trim()).toBe("external");
    expect(checkHandler(source).map((f) => f.rule)).toEqual(["assume-in-handler"]);
  });
});

describe("lintInvariantSource", () => {
  it("reports every rule at once rather than the first", () => {
    const findings = lintInvariantSource(`
      contract T is Test {
        function testInvariant_a() public view { assertTrue(true); }
        function invariant_b() public view { if (x) return; assertEq(a, b); }
        function deposit(uint256 a) external { attempts++; c.d(a); successes++; }
      }`);
    const rules = findings.map((f) => f.rule);
    expect(rules).toContain("naming-trap");
    expect(rules).toContain("conditional-invariant");
    expect(rules).toContain("rollback-blind-counter");
  });

  /**
   * The suite that does everything right must come back clean, or the linter is noise
   * and gets switched off.
   */
  it("is silent on a correct invariant suite", () => {
    expect(
      lintInvariantSource(`
      contract T is Test {
        function setUp() public { targetContract(address(h)); }
        function invariant_solvency() public view {
          assertEq(token.totalSupply(), handler.ghost_sumBalances());
        }
        function afterInvariant() public view {
          assertGe(handler.successes() * 100, handler.attempts() * 50);
        }
      }
      contract Handler is Test {
        function deposit(uint256 amt) external {
          attempts++;
          amt = bound(amt, 1, 1e18);
          try token.deposit(amt) { successes++; } catch { }
        }
      }`),
    ).toEqual([]);
  });
});

describe("formatFindings", () => {
  it("orders high severity first", () => {
    const text = formatFindings([
      { rule: "b", severity: "low", message: "low thing" },
      { rule: "a", severity: "high", message: "high thing" },
    ]);
    expect(text.indexOf("high thing")).toBeLessThan(text.indexOf("low thing"));
  });

  /**
   * A clean result must not be reported as proof the invariants are good — it only means
   * the mechanical traps are absent. Overclaiming here is how a linter becomes a
   * false sense of coverage.
   */
  it("does not claim the invariants are meaningful when clean", () => {
    expect(formatFindings([])).toContain("not whether the invariants are meaningful");
  });

  it("includes the location when known", () => {
    expect(
      formatFindings([{ rule: "r", severity: "high", message: "m", functionName: "f", line: 12 }]),
    ).toContain("f:12");
  });
});
