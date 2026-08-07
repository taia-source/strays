/**
 * Catching invariant tests that pass while testing nothing.
 *
 * ══ Why this exists ══
 *
 * A Solidity invariant campaign reports `[PASS] … (runs: 256, calls: 128000)` whether it
 * explored the whole state space or none of it. The number is call *attempts*, not
 * coverage, and a green line with 128,000 next to it reads as thorough when it can mean
 * the opposite. **No existing tool checks for this.** Verified on Foundry 1.7.1:
 * `forge lint --only-lint invariant` → `Error: Unknown lint ID`. Its rules are style and
 * gas only. Solhint has none either, and Slither's detectors target source, not tests.
 *
 * Every trap below was reproduced locally on forge 1.7.1 (commit 4072e48) before being
 * encoded here. The transcripts are quoted at each rule.
 *
 * ══ The three confirmed ways to a hollow green ══
 *
 * **1. The `test` prefix wins.** Foundry classifies by prefix, and the `test` arm is
 * matched FIRST — `TestFunctionKind::classify` in `crates/common/src/traits.rs` returns
 * before it ever reaches the `invariant`/`statefulFuzz` arm. So `testInvariant_trap()` is
 * a unit test. Measured, side by side in one suite:
 *
 *     [PASS] invariant_ok()        (runs: 256, calls: 128000, reverts: 0)
 *     [PASS] statefulFuzz_ok()     (runs: 256, calls: 128000, reverts: 0)
 *     [PASS] testInvariant_trap()  (gas: 278)          <- ONE call. Not an invariant.
 *
 * 278 gas versus 128,000 calls. No warning is emitted. A name chosen to read as an
 * invariant silently is not one, and the suite is greener for it.
 *
 * **2. A guard that never fires.** An `invariant_` function whose body is wrapped in a
 * condition that is never true asserts nothing:
 *
 *     function invariant_earlyReturn() public view {
 *         if (c.total() == 0) return;      // always taken
 *         assertEq(c.total(), 999999);     // never executed
 *     }
 *     [PASS] invariant_earlyReturn() (runs: 256, calls: 128000, reverts: 0)
 *
 * 128,000 calls, zero reverts, and an assertion that would fail on contact never ran once.
 * The legacy Foundry book names this directly — "not recommended to introduce conditional
 * logic into invariant assertions" — and that sentence was dropped from the current docs.
 *
 * **3. A handler that always reverts.** `[invariant] fail_on_revert` defaults to **false**
 * (confirmed via `forge config`), so a handler that reverts on every call still passes:
 *
 *     [PASS] invariant_x() (runs: 256, calls: 128000, reverts: 128000)
 *
 * Every single call reverted. Nothing was ever tested.
 *
 * ══ The part that surprised me ══
 *
 * The obvious defence against (3) is a ghost counter — count attempts and successes, then
 * assert a ratio. **It does not work, and it fails silently.** A revert rolls back the
 * counter increment along with everything else, so the evidence is destroyed by the very
 * event it was meant to record. Measured on the always-reverting handler above:
 *
 *     afterInvariant ran. attempts=0 successes=0
 *     [PASS]
 *
 * `assertGe(0 * 100, 0 * 50)` holds. The guard is defeated by exactly the condition it
 * guards against, and reports success. The working form wraps the call so the handler
 * itself never reverts:
 *
 *     function deposit(uint256 amt) external {
 *         attempts++;
 *         try c.deposit(amt) { successes++; } catch { }
 *     }
 *
 * Re-measured: `reverts: 0`, and it correctly **FAILS** with `success ratio too low:
 * 0 < 25000`. That is why {@link checkHandler} demands `try`/`catch` rather than merely
 * demanding a counter — a counter alone is worse than none, because it looks like a
 * control and is not.
 *
 * ══ Scope, stated honestly ══
 *
 * This is a **source-text linter**, not a semantic analyser. It parses Solidity with
 * regular expressions after stripping comments and strings. It reliably catches the
 * mechanical shapes above, which are the ones an agent generating contracts actually
 * produces. It cannot decide whether a semantically meaningful invariant is a *good* one,
 * and it will not catch a guard whose condition is unreachable for reasons requiring
 * evaluation. Those need the runtime signal — see {@link checkCampaignMetrics}, which
 * reads what the campaign actually did rather than what its source looks like.
 *
 * Use both. The linter runs before a campaign costs 128,000 calls; the metrics check runs
 * after and is the one that cannot be fooled by clever source.
 */

export type VacuitySeverity = "high" | "medium" | "low";

export type VacuityFinding = {
  readonly rule: string;
  readonly severity: VacuitySeverity;
  /** What is wrong, in terms of what the campaign will silently fail to test. */
  readonly message: string;
  readonly functionName?: string | undefined;
  readonly line?: number | undefined;
};

/**
 * Strip comments and string literals before pattern-matching.
 *
 * Without this, a rule fires on the word `invariant` inside a docstring, and an agent
 * chasing a phantom finding edits a comment. Replacing with spaces rather than deleting
 * keeps every byte offset intact, so reported line numbers stay true.
 */
export function stripNonCode(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;

  while (i < n) {
    const two = source.slice(i, i + 2);

    if (two === "//") {
      while (i < n && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    if (two === "/*") {
      while (i < n && source.slice(i, i + 2) !== "*/") {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      // The closing delimiter itself, when present.
      for (let k = 0; k < 2 && i < n; k++, i++) out += " ";
      continue;
    }

    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += " ";
      i++;
      while (i < n && source[i] !== quote) {
        // A backslash escape consumes the next character, so a quote inside a string
        // does not terminate it early.
        if (source[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
          continue;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += " ";
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** 1-indexed line number for a byte offset. */
function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

export type SolidityFunction = {
  readonly name: string;
  readonly body: string;
  readonly line: number;
  /** Modifiers and visibility between the parameter list and the body. */
  readonly attributes: string;
};

/**
 * Extract function bodies by brace-matching.
 *
 * A regex cannot match balanced braces, and an invariant body containing a nested block
 * is entirely ordinary — so the opening brace is found by pattern and the closing one by
 * counting. Depth counting is safe here because comments and strings are already gone.
 */
export function extractFunctions(source: string): SolidityFunction[] {
  const code = stripNonCode(source);
  const functions: SolidityFunction[] = [];
  const signature = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;

  let match: RegExpExecArray | null = signature.exec(code);
  while (match !== null) {
    const name = match[1];
    // UNREACHABLE, and no test can cover it. Group 1 of `signature` is not optional and
    // sits outside any alternation, so a successful `exec` always binds it to a string —
    // there is no input for which `match !== null` and `match[1] === undefined` both
    // hold. Required only because `noUncheckedIndexedAccess` types the index access as
    // `string | undefined`.
    if (name === undefined) {
      match = signature.exec(code);
      continue;
    }

    // Walk the parameter list to its close, so a default value containing a paren
    // does not end it early.
    let i = match.index + match[0].length;
    let parenDepth = 1;
    while (i < code.length && parenDepth > 0) {
      if (code[i] === "(") parenDepth++;
      else if (code[i] === ")") parenDepth--;
      i++;
    }

    const attributeStart = i;
    while (i < code.length && code[i] !== "{" && code[i] !== ";") i++;

    // A declaration without a body (interface or abstract) has nothing to analyse.
    if (i >= code.length || code[i] === ";") {
      match = signature.exec(code);
      continue;
    }

    const attributes = code.slice(attributeStart, i);
    const bodyStart = i;
    let braceDepth = 0;
    do {
      if (code[i] === "{") braceDepth++;
      else if (code[i] === "}") braceDepth--;
      i++;
    } while (i < code.length && braceDepth > 0);

    functions.push({
      name,
      body: code.slice(bodyStart, i),
      attributes,
      line: lineAt(code, match.index),
    });

    signature.lastIndex = i;
    match = signature.exec(code);
  }

  return functions;
}

/**
 * Does Foundry treat this name as an invariant?
 *
 * Mirrors `TestFunctionKind::classify`: the `test` arm is checked **first**, so anything
 * beginning `test` is a unit or fuzz test no matter what follows. `invariant` and
 * `statefulFuzz` are the two invariant prefixes, and the trailing underscore that
 * everyone writes is convention, not syntax — bare `invariantFoo` runs.
 *
 * ══ What the arm ordering here does and does not do ══
 *
 * Sabotage established this precisely, against my first assumption. Moving the `test`
 * arm below the `invariant` arm changes **nothing observable**: a name beginning `test`
 * cannot also begin `invariant`, so the two arms are disjoint over every real input and
 * the mutant is semantically null. The tests were right not to fail.
 *
 * The ordering is kept because it mirrors how Foundry is written and documents the
 * precedence for a reader. What actually carries the behaviour is the **presence** of
 * the `test` arm — deleting it reclassifies `testInvariant_x` as an invariant and breaks
 * four tests, which is the mutation that matters and is caught.
 */
export function classifyTestFunction(
  name: string,
): "test" | "invariant" | "afterInvariant" | "setUp" | "other" {
  // Mirrors Foundry's precedence. Note this arm's PRESENCE is what matters, not its
  // position — see the docstring; the arms are disjoint over real names.
  if (name.startsWith("test")) return "test";
  if (name === "afterInvariant") return "afterInvariant";
  if (name.startsWith("invariant") || name.startsWith("statefulFuzz")) return "invariant";
  if (name === "setUp") return "setUp";
  return "other";
}

/**
 * The naming trap: a function that reads as an invariant but runs as a unit test.
 *
 * Measured cost of getting this wrong: `gas: 278` against `calls: 128000`. The suite
 * still says PASS, so nothing downstream reports the loss.
 */
export function checkNamingTrap(source: string): VacuityFinding[] {
  const findings: VacuityFinding[] = [];

  for (const fn of extractFunctions(source)) {
    if (classifyTestFunction(fn.name) !== "test") continue;

    // `testInvariant…`, `test_invariant…`, `testStatefulFuzz…` — named to look like an
    // invariant, classified as a test.
    if (/^test_?(invariant|statefulfuzz)/i.test(fn.name)) {
      findings.push({
        rule: "naming-trap",
        severity: "high",
        functionName: fn.name,
        line: fn.line,
        message:
          `"${fn.name}" is NOT an invariant test — Foundry matches the "test" prefix first ` +
          "(TestFunctionKind::classify), so it runs once as a unit test and returns before " +
          "the invariant arm is reached. Measured side by side: the test-prefixed function " +
          "used 278 gas while its invariant siblings each made 128,000 calls. Rename it to " +
          // Strip the whole `test[_]invariant[_]` prefix, not just `test_` — leaving the
          // middle word behind suggests `invariant_Invariant_trap`, which a caller would
          // paste verbatim. Caught by the test that asserts the suggestion is usable.
          `"${fn.name.replace(/^test_?(invariant|statefulfuzz)_?/i, "invariant_")}". ` +
          "No warning is emitted for this.",
      });
    }
  }

  return findings;
}

/**
 * A guard that swallows the assertion.
 *
 * An `if (…) return;` before every assert makes the invariant vacuous whenever the
 * condition holds — and the campaign cannot tell you it never asserted. Reproduced:
 * 128,000 calls, 0 reverts, PASS, with an `assertEq(total, 999999)` that never ran.
 *
 * Reported as `medium` rather than `high`: an early return can be legitimate when the
 * guard is genuinely sometimes false. It is the *unconditional* pattern that is fatal,
 * and source text alone cannot always distinguish the two — which is why
 * {@link checkCampaignMetrics} exists as the check that can.
 */
export function checkConditionalInvariant(source: string): VacuityFinding[] {
  const findings: VacuityFinding[] = [];

  for (const fn of extractFunctions(source)) {
    if (classifyTestFunction(fn.name) !== "invariant") continue;

    const hasAssertion = /\b(assert\w*|require|expect\w*)\s*\(/.test(fn.body);
    if (!hasAssertion) {
      findings.push({
        rule: "no-assertion",
        severity: "high",
        functionName: fn.name,
        line: fn.line,
        message:
          `"${fn.name}" contains no assertion at all. It will run 128,000 calls by default ` +
          "and report PASS regardless of what the contract does — the most expensive way " +
          "possible to test nothing.",
      });
      continue;
    }

    // A bare `return;` inside an invariant means at least one path asserts nothing.
    const guardedReturn = /\bif\s*\([^;{]*\)\s*(\{[^{}]*\})?\s*return\s*;/.test(fn.body);
    if (guardedReturn) {
      findings.push({
        rule: "conditional-invariant",
        severity: "medium",
        functionName: fn.name,
        line: fn.line,
        message:
          `"${fn.name}" returns early on a condition, so on that path it asserts nothing. ` +
          "Reproduced on forge 1.7.1: a guard that is always taken yields 128,000 calls, 0 " +
          "reverts and PASS, with the assertion never executed once. Prefer bounding the " +
          "handler so the state is always valid, and assert unconditionally here. The " +
          "legacy Foundry book advises against conditional logic in invariant assertions; " +
          "that guidance was dropped from the current docs but the behaviour is unchanged.",
      });
    }
  }

  return findings;
}

/**
 * Handlers that bound with `vm.assume`, and the ghost counter that lies.
 *
 * Two rules, both about a campaign that appears to run and does not:
 *
 * `vm.assume` in a handler discards the call rather than steering it. Foundry's own
 * guidance is "use `bound()` instead"; the discard budget is `max_assume_rejects`
 * (65,536, distinct from `[fuzz] max_test_rejects`). A tight assume was measured passing
 * while discarding **1,147,316 of 1,275,316** calls — the `Discards` column was the only
 * evidence.
 *
 * The counter rule is the subtler one, and it is why this function does not simply reward
 * the presence of a counter. See the module docstring: a naked `successes++` after a
 * call that reverts is rolled back with it, reports `0/0`, and passes.
 */
export function checkHandler(source: string): VacuityFinding[] {
  const findings: VacuityFinding[] = [];

  for (const fn of extractFunctions(source)) {
    const kind = classifyTestFunction(fn.name);
    if (kind === "invariant" || kind === "setUp" || kind === "afterInvariant") continue;
    // Only functions reachable by the fuzzer are handlers.
    if (!/\b(external|public)\b/.test(fn.attributes)) continue;

    if (/\bvm\s*\.\s*assume\s*\(/.test(fn.body)) {
      findings.push({
        rule: "assume-in-handler",
        severity: "medium",
        functionName: fn.name,
        line: fn.line,
        message:
          `handler "${fn.name}" uses vm.assume, which DISCARDS the call instead of steering ` +
          "it. Foundry's documented guidance is to use bound() so every generated input " +
          "produces a real call. Measured: a tight assume passed while discarding 1,147,316 " +
          "of 1,275,316 calls — nothing failed, and the Discards column was the only sign.",
      });
    }

    // A counter incremented after an unguarded external call is destroyed by the revert
    // it exists to detect. Demanding try/catch is the whole point of the rule.
    const incrementsCounter = /\b(success|succeed|ok|calls|count)\w*\s*(\+\+|\+=)/i.test(fn.body);
    const guardsCall = /\btry\b/.test(fn.body);
    if (incrementsCounter && !guardsCall) {
      findings.push({
        rule: "rollback-blind-counter",
        severity: "high",
        functionName: fn.name,
        line: fn.line,
        message:
          `handler "${fn.name}" increments a success counter without try/catch. If the call ` +
          "reverts, the increment is REVERTED WITH IT — the counter cannot record the very " +
          "failure it exists to detect. Measured on an always-reverting handler: 128,000 " +
          "calls, 128,000 reverts, and afterInvariant read attempts=0 successes=0, so " +
          "assertGe(0, 0) passed. Wrap the call: `try target.f(x) { successes++; } catch {}` " +
          "— re-measured that way it correctly FAILS with 'success ratio too low: 0 < 25000'. " +
          "An unguarded counter is worse than none: it looks like a control and is not.",
      });
    }
  }

  return findings;
}

/** Foundry's `[fuzz]` / `[invariant]` settings, as a caller has them. */
export type FoundryFuzzConfig = {
  readonly runs?: number | undefined;
  readonly failOnRevert?: boolean | undefined;
  readonly depth?: number | undefined;
  readonly checkInterval?: number | undefined;
};

/**
 * Config traps, all confirmed against `forge config` on 1.7.1.
 *
 * The defaults for the same key are **opposite** between the two sections —
 * `[fuzz] fail_on_revert = true`, `[invariant] fail_on_revert = false` — and `[invariant]`
 * silently inherits any value the caller sets only under `[fuzz]`. So editing one number
 * in the fuzz section changes how invariants run, with nothing to say so.
 */
export function checkConfig(config: {
  readonly fuzz?: FoundryFuzzConfig | undefined;
  readonly invariant?: FoundryFuzzConfig | undefined;
}): VacuityFinding[] {
  const findings: VacuityFinding[] = [];
  const { fuzz, invariant } = config;

  // Inherited, not defaulted: an unset invariant key takes the fuzz value.
  const effectiveFailOnRevert = invariant?.failOnRevert ?? fuzz?.failOnRevert ?? false;

  if (!effectiveFailOnRevert) {
    findings.push({
      rule: "fail-on-revert-false",
      severity: "high",
      message:
        "invariant fail_on_revert is false (the DEFAULT — [fuzz] defaults to true, the " +
        "opposite). A handler that reverts on every call still reports PASS: measured " +
        "128,000 calls / 128,000 reverts / PASS. Either set it true, or assert a minimum " +
        "success ratio with a try/catch-guarded ghost counter — see rollback-blind-counter " +
        "for why a naked counter cannot do this.",
    });
  }

  if (invariant?.failOnRevert === undefined && fuzz?.failOnRevert !== undefined) {
    findings.push({
      rule: "silent-config-inheritance",
      severity: "medium",
      message:
        "[fuzz] fail_on_revert is set but [invariant] is not, so the invariant section " +
        "INHERITS the fuzz value rather than using its own default. Foundry documents this: " +
        "unset [invariant] entries are set to the [fuzz] values. Set invariant keys " +
        "explicitly — otherwise tuning a fuzz number silently changes invariant behaviour.",
    });
  }

  if (invariant?.checkInterval === 0) {
    findings.push({
      rule: "check-interval-zero",
      severity: "high",
      message:
        "invariant check_interval = 0 means the invariant is asserted only on the LAST call " +
        "of each run rather than after every call (default 1). A violation that arises and " +
        "is repaired mid-sequence is never observed.",
    });
  }

  return findings;
}

/** What a campaign actually did, parsed from forge's own output. */
export type CampaignMetrics = {
  readonly functionName: string;
  readonly calls: number;
  readonly reverts: number;
  readonly discards?: number | undefined;
};

/**
 * The check that source text cannot fool.
 *
 * A linter reasons about what a test looks like. This reasons about what the campaign
 * *did* — and since `show_metrics` defaults to **true** in 1.7.1, forge prints the
 * evidence without any extra configuration. A high revert ratio means the fuzzer bounced
 * off the contract rather than exercising it, and `fail_on_revert = false` means nobody
 * was told.
 *
 * The threshold is a judgement call, so it is a parameter rather than a constant. The
 * Foundry Book's own handler example passes with 5,533 reverts in 10,000 calls (55%),
 * which is normal and healthy for a bounded handler — so a default anywhere near 55%
 * would flag the canonical reference implementation. The default here is 90%: high enough
 * to clear ordinary handler noise, low enough to catch the 100% case that is always a bug.
 */
export function checkCampaignMetrics(
  metrics: readonly CampaignMetrics[],
  options: { readonly maxRevertRatio?: number; readonly maxDiscardRatio?: number } = {},
): VacuityFinding[] {
  const maxRevertRatio = options.maxRevertRatio ?? 0.9;
  // Against generated inputs, not calls — see the discard rule below for why.
  const maxDiscardRatio = options.maxDiscardRatio ?? 0.5;
  const findings: VacuityFinding[] = [];

  for (const m of metrics) {
    if (m.calls === 0) {
      findings.push({
        rule: "no-calls",
        severity: "high",
        functionName: m.functionName,
        message:
          `"${m.functionName}" made zero calls — nothing was targeted. Check targetContract ` +
          "and the handler's visibility; a handler the fuzzer cannot reach tests nothing.",
      });
      continue;
    }

    const ratio = m.reverts / m.calls;
    if (ratio >= maxRevertRatio) {
      findings.push({
        rule: "high-revert-ratio",
        severity: ratio === 1 ? "high" : "medium",
        functionName: m.functionName,
        message:
          `"${m.functionName}" reverted on ${m.reverts} of ${m.calls} calls ` +
          `(${(ratio * 100).toFixed(1)}%)` +
          (ratio === 1
            ? " — EVERY call reverted, so the invariant was never evaluated against any real " +
              "state. This passes silently under the default fail_on_revert = false."
            : " — the fuzzer is mostly bouncing off the contract. Bound the handler inputs so " +
              "calls land.") +
          " Note the Foundry Book's own example runs at 55% reverts, which is healthy; it is " +
          "the approach to 100% that means the campaign explored nothing.",
      });
    }

    /**
     * Discards are assume-rejections: generated, then thrown away.
     *
     * The ratio is against **generated** inputs (calls + discards), not against calls.
     * Measuring discards as a multiple of calls is wrong and was caught by the fixture:
     * the real run discarded 1,147,316 of 1,275,316 generated — 90% of everything
     * produced — yet only 128,000 landed, so `discards > calls * 10` was *false* and the
     * genuine case went unreported. Sharing a denominator with the measurement is the
     * only form that reads the same way the campaign does.
     */
    const generated = m.calls + (m.discards ?? 0);
    if (m.discards !== undefined && generated > 0 && m.discards / generated >= maxDiscardRatio) {
      findings.push({
        rule: "high-discard-ratio",
        severity: "medium",
        functionName: m.functionName,
        message:
          `"${m.functionName}" discarded ${m.discards} of ${generated} generated inputs ` +
          `(${((m.discards / generated) * 100).toFixed(1)}%), landing only ${m.calls} calls. ` +
          "That is vm.assume rejecting nearly everything the fuzzer produces. Measured: " +
          "1,147,316 discards against 1,275,316 generated, and the test still passed — the " +
          "Discards column was the only evidence. Replace assume with bound().",
      });
    }
  }

  return findings;
}

/**
 * Parse forge's metrics table.
 *
 * The table is printed per invariant function under `show_metrics` (default true in
 * 1.7.1), so this reads what the run reported rather than requiring instrumentation:
 *
 *     ╭----------+----------+--------+---------+----------╮
 *     | Contract | Selector | Calls  | Reverts | Discards |
 *     +===================================================+
 *     | BadH     | deposit  | 128000 | 128000  | 0        |
 *     ╰----------+----------+--------+---------+----------╯
 */
export function parseMetricsTable(output: string): CampaignMetrics[] {
  const metrics: CampaignMetrics[] = [];
  const row =
    /^\s*\|\s*([^|\s][^|]*?)\s*\|\s*([^|\s][^|]*?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/;

  for (const line of output.split("\n")) {
    const match = row.exec(line);
    if (!match) continue;

    const [, contract, selector, calls, reverts, discards] = match;
    // The header row matches the shape but not the numbers; requiring digits above
    // already excludes it. Guard the destructure for noUncheckedIndexedAccess.
    //
    // UNREACHABLE, and no test can cover it. All five groups in `row` are mandatory and
    // none sits inside an alternation or an optional quantifier, so a successful `exec`
    // binds every one of them to a string. Kept because `noUncheckedIndexedAccess` types
    // each destructured element as `string | undefined`, and `Number(undefined)` would
    // otherwise yield a silent `NaN` in the metrics — the exact class of failure the
    // "never default a failed read to zero" rule exists to prevent.
    if (
      contract === undefined ||
      selector === undefined ||
      calls === undefined ||
      reverts === undefined ||
      discards === undefined
    ) {
      continue;
    }

    metrics.push({
      functionName: `${contract}.${selector}`,
      calls: Number(calls),
      reverts: Number(reverts),
      discards: Number(discards),
    });
  }

  return metrics;
}

/**
 * Every source-level rule, over one file.
 *
 * Returns all findings rather than the first, for the same reason the spend bounds do:
 * an agent that fixes one and re-runs pays another 128,000-call campaign to discover the
 * next.
 */
export function lintInvariantSource(source: string): VacuityFinding[] {
  return [
    ...checkNamingTrap(source),
    ...checkConditionalInvariant(source),
    ...checkHandler(source),
  ];
}

export function formatFindings(findings: readonly VacuityFinding[]): string {
  if (findings.length === 0) {
    return "no vacuity findings — note this checks the SHAPE of the tests, not whether the invariants are meaningful";
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  const sorted = [...findings].sort((a, b) => rank[a.severity] - rank[b.severity]);

  return [
    `VACUITY — ${findings.length} finding(s):`,
    ...sorted.map((f) => {
      const where = f.functionName ? ` ${f.functionName}` : "";
      const at = f.line !== undefined ? `:${f.line}` : "";
      return `  ✗ [${f.severity}] ${f.rule}${where}${at}\n    ${f.message}`;
    }),
    "",
    "  A passing invariant campaign proves nothing on its own. `calls: 128000` counts",
    "  attempts, not coverage — every trap above was measured passing on forge 1.7.1.",
  ].join("\n");
}
