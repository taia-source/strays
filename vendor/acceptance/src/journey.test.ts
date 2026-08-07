import { describe, expect, it } from "vitest";
import { type Capability, IMPLIED_CAPABILITIES } from "./capability.js";
import { assessAcceptance, type ProjectView } from "./check.js";
import { impliedCapabilities, isCheckable, mergeCapabilities } from "./derive.js";
import {
  firstDeadEnd,
  formatJourney,
  type Journey,
  validateJourney,
  walkJourney,
} from "./journey.js";
import {
  ALWAYS_REQUIRED,
  auditJourney,
  deriveJourney,
  describeGoal,
  pathCoversEveryCapability,
} from "./skeleton.js";

function capability(id: string): Capability {
  return {
    id,
    statement: `${id} must be possible`,
    level: "required",
    evidence: [{ kind: "file", target: `${id}.ts`, rationale: "r" }],
    source: "test",
  };
}

function step(id: string, capabilityId = id) {
  return {
    id,
    action: `does ${id}`,
    why: `${id} cannot be skipped`,
    capability: capability(capabilityId),
  };
}

const THREE_STEPS: Journey = {
  goal: "get value from the product",
  steps: [step("one"), step("two"), step("three")],
};

describe("finding where a path stops", () => {
  it("finds nothing wrong when every step is reachable", () => {
    expect(
      firstDeadEnd({ journey: THREE_STEPS, present: ["one", "two", "three"] }),
    ).toBeUndefined();
  });

  /**
   * ══ The measured shape ══
   *
   * Reachability is transitive. The broken product had a correct fee split, a correct holder
   * distribution and a correct keeper — all downstream of a missing input, all unreachable.
   */
  it("reports later steps as unreachable, however well implemented", () => {
    const deadEnd = firstDeadEnd({ journey: THREE_STEPS, present: ["one", "three"] });
    expect(deadEnd?.atStep).toBe(2);
    expect(
      deadEnd?.unreachable.map((entry) => entry.id),
      "step three is present and still unreachable",
    ).toEqual(["three"]);
  });

  /** The FIRST dead end, so a report says where the product stops rather than listing gaps. */
  it("reports the first dead end, not the cheapest", () => {
    const deadEnd = firstDeadEnd({ journey: THREE_STEPS, present: [] });
    expect(deadEnd?.atStep).toBe(1);
  });

  it("reports a dead end at the final step", () => {
    const deadEnd = firstDeadEnd({ journey: THREE_STEPS, present: ["one", "two"] });
    expect(deadEnd?.atStep).toBe(3);
    expect(deadEnd?.unreachable).toEqual([]);
  });
});

describe("a journey worth checking", () => {
  it("accepts a path of two or more decidable steps", () => {
    expect(validateJourney(THREE_STEPS, isCheckable).ok).toBe(true);
  });

  it("rejects a path with no steps", () => {
    const verdict = validateJourney({ goal: "g", steps: [] }, isCheckable);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.flaw).toBe("empty");
  });

  /**
   * ══ One step is an arrival, not a journey ══
   *
   * Measured: the shipped product let a user connect a wallet and do nothing else. A
   * single-step journey would have reported that as complete.
   */
  it("rejects a path of one step, which goes nowhere", () => {
    const verdict = validateJourney({ goal: "g", steps: [step("only")] }, isCheckable);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.flaw).toBe("no-outcome");
    expect(verdict.ok === false && verdict.detail).toContain("connect a wallet and do nothing");
  });

  it("rejects duplicate step ids, which make a verdict unattributable", () => {
    const verdict = validateJourney(
      { goal: "g", steps: [step("same"), step("same")] },
      isCheckable,
    );
    expect(verdict.ok === false && verdict.flaw).toBe("duplicate-step");
  });

  /**
   * One unfalsifiable step makes the whole path report walkable, which is worse than having no
   * journey — it is a green line that verified nothing.
   */
  it("rejects a step whose capability cannot be decided", () => {
    const unfalsifiable: Journey = {
      goal: "g",
      steps: [
        step("one"),
        {
          ...step("two"),
          capability: { ...capability("two"), evidence: [] },
        },
      ],
    };
    const verdict = validateJourney(unfalsifiable, isCheckable);
    expect(verdict.ok === false && verdict.flaw).toBe("unfalsifiable-step");
  });

  /** A judgement-only step is unfalsifiable for the measured 81.56% reason. */
  it("rejects a step decided only by judgement", () => {
    const judged: Journey = {
      goal: "g",
      steps: [
        step("one"),
        {
          ...step("two"),
          capability: {
            ...capability("two"),
            evidence: [{ kind: "judgement", target: "is it good?", rationale: "r" }],
          },
        },
      ],
    };
    expect(validateJourney(judged, isCheckable).ok).toBe(false);
  });
});

describe("walking a journey", () => {
  it("is walkable when every step's capability is present", () => {
    const verdict = walkJourney({
      journey: THREE_STEPS,
      present: ["one", "two", "three"],
      isCheckable,
    });
    expect(verdict.walkable).toBe(true);
    expect(verdict.reachable).toEqual(["one", "two", "three"]);
  });

  it("reports which steps were reachable before the dead end", () => {
    const verdict = walkJourney({ journey: THREE_STEPS, present: ["one"], isCheckable });
    expect(verdict.walkable).toBe(false);
    expect(verdict.reachable).toEqual(["one"]);
    expect(verdict.deadEnd?.atStep).toBe(2);
  });

  /**
   * ══ A malformed journey is NOT walkable ══
   *
   * Treating an unusable journey as a pass is the same abstention failure the rest of this
   * package refuses: a check that cannot run must not report success.
   */
  it("is not walkable when the journey itself is malformed", () => {
    const verdict = walkJourney({ journey: { goal: "g", steps: [] }, present: [], isCheckable });
    expect(verdict.walkable, "an unusable journey reported success").toBe(false);
    expect(verdict.invalid?.flaw).toBe("empty");
    expect(verdict.reachable).toEqual([]);
  });
});

describe("the report", () => {
  it("says where the product stops, in the user's terms", () => {
    const report = formatJourney(
      THREE_STEPS,
      walkJourney({ journey: THREE_STEPS, present: ["one"], isCheckable }),
    );
    expect(report).toContain("DEAD-ENDS at step 2 of 3");
    expect(report).toContain("the user cannot: does two");
    expect(report).toContain("why it is required");
  });

  it("names the later steps that are unreachable", () => {
    const report = formatJourney(
      THREE_STEPS,
      walkJourney({ journey: THREE_STEPS, present: [], isCheckable }),
    );
    expect(report).toContain("UNREACHABLE regardless of how well");
    expect(report).toContain("does two");
    expect(report).toContain("does three");
  });

  it("states its coverage on a pass rather than saying only 'ok'", () => {
    const report = formatJourney(
      THREE_STEPS,
      walkJourney({ journey: THREE_STEPS, present: ["one", "two", "three"], isCheckable }),
    );
    expect(report).toContain("all 3 steps reachable");
    expect(report).toContain("one -> two -> three");
  });

  it("reports a malformed journey as unusable, not as a failing product", () => {
    const report = formatJourney(
      { goal: "g", steps: [] },
      walkJourney({ journey: { goal: "g", steps: [] }, present: [], isCheckable }),
    );
    expect(report).toContain("JOURNEY UNUSABLE");
  });
});

/**
 * ══ Against the real prompt and the real artifact ══
 *
 * Everything above tests the mechanism. This tests the claim: the path a real prompt implies,
 * walked against what a real project actually shipped.
 */
describe("the prompt and project that shipped", () => {
  const PROMPT =
    "use fletchdotclick cashback mode and ponsball engines to create a cashback agent that " +
    "users use as a service for their pons tokens launchpad creator fees, privy to connect, " +
    "whatever cost for this service to run for each user must be self funded by user prepaid " +
    "or perp mode, also 10% of money in from users goes to a tres wallet for the team";

  const SHIPPED: ProjectView = {
    files: [
      {
        path: "apps/web/app/screen.tsx",
        source:
          'const HOLDERS = [{ address: "0x1111111111111111111111111111111111111111", balance: 1n }];',
      },
      { path: "apps/indexer/src/keeper.ts", source: "export function runTick() {}" },
    ],
    rendered: {
      "/": {
        selectorsPresent: ["h1", "button", "canvas", "main", "header", "footer", "section"],
        visibleText:
          "PONS CASHBACK CONNECT MODE DEPOSIT FEE-SHARE BALANCE 0.010000 ETH RUNS UNTIL " +
          "SPENT STATUS ACTIVE SPLIT OF 0.000446 ETH TREASURY 10% CHAIN 4663 NOT CONNECTED",
      },
    },
    routes: { "/": 200, "/api/health": 200 },
  };

  const capabilities = mergeCapabilities([], impliedCapabilities(PROMPT));
  const journey = deriveJourney({ prompt: PROMPT, capabilities });

  it("derives a path of more than one step", () => {
    expect(journey.steps.length).toBeGreaterThan(1);
  });

  it("puts understanding the product before naming a token", () => {
    const ids = journey.steps.map((entry) => entry.id);
    expect(ids.indexOf("understand")).toBeLessThan(ids.indexOf("supply-identifier"));
  });

  /**
   * The load-bearing assertion. The product dead-ends where a user would name their token —
   * and every later step was implemented and unreachable.
   */
  it("dead-ends before the user can name their token", () => {
    const result = assessAcceptance({ capabilities, view: SHIPPED });
    const present = result.verdicts
      .filter((verdict) => verdict.present)
      .map((verdict) => verdict.capability.id);

    const verdict = walkJourney({ journey, present, isCheckable });
    const report = formatJourney(journey, verdict);

    expect(verdict.walkable, report).toBe(false);
    /**
     * `arrive` since the landing-page capability was added, and that is a SHARPER finding than
     * before: that project's `/` really was a control panel — 388 characters of labels and
     * numbers — so the path stops one step earlier than it used to, for a true reason.
     */
    expect(
      verdict.deadEnd?.step.id,
      `expected the path to stop at arrive, understand or supply-identifier:\n${report}`,
    ).toMatch(/arrive|understand|supply-identifier/);
  });

  it("names the unreachable later steps in its report", () => {
    const result = assessAcceptance({ capabilities, view: SHIPPED });
    const present = result.verdicts
      .filter((verdict) => verdict.present)
      .map((verdict) => verdict.capability.id);
    const report = formatJourney(journey, walkJourney({ journey, present, isCheckable }));
    expect(report).toContain("UNREACHABLE");
  });

  it("derives a journey that passes its own validity check", () => {
    expect(validateJourney(journey, isCheckable).ok, journey.steps.map((s) => s.id).join(",")).toBe(
      true,
    );
  });

  it("audits as complete against the capabilities the prompt implied", () => {
    const audit = auditJourney({ journey, capabilities });
    expect(audit.ok, audit.detail).toBe(true);
  });
});

describe("deriving a path", () => {
  it("includes only the steps the prompt implies", () => {
    // A read-only viewer: no fee, no custody, no per-user state.
    const capabilities = mergeCapabilities([], impliedCapabilities("build me a web dashboard"));
    const journey = deriveJourney({ prompt: "build me a web dashboard", capabilities });
    // Two, not one: a dashboard is a product a stranger can land on, so `/` must explain it
    // before any screen does.
    expect(journey.steps.map((entry) => entry.id)).toEqual(["arrive", "understand"]);
  });

  it("grows the path as the prompt implies more", () => {
    const thin = deriveJourney({
      prompt: "a web dashboard",
      capabilities: mergeCapabilities([], impliedCapabilities("a web dashboard")),
    });
    const fat = deriveJourney({
      prompt: "a web app where each user brings their token and we take 10% of fees",
      capabilities: mergeCapabilities(
        [],
        impliedCapabilities("a web app where each user brings their token and we take 10% of fees"),
      ),
    });
    expect(fat.steps.length).toBeGreaterThan(thin.steps.length);
  });

  it("quotes the prompt as the goal rather than paraphrasing it", () => {
    const goal = describeGoal("build a cashback agent for pons tokens, and deploy it");
    expect(goal).toContain("build a cashback agent for pons tokens");
    expect(goal).not.toContain("deploy it");
  });

  it("bounds a very long goal so a report stays readable", () => {
    expect(describeGoal("x".repeat(400)).length).toBeLessThanOrEqual(160);
  });

  it("says plainly when there is no prompt", () => {
    expect(describeGoal("   ")).toContain("no prompt");
  });

  /**
   * ══ The two tables must stay in step ══
   *
   * A capability added to IMPLIED_CAPABILITIES without a step silently produces a shorter
   * path — the requirement would be checked but never placed on the user's route, so a report
   * could say "walkable" about a path missing a step the prompt demanded.
   */
  it("has a path step for every implied capability", () => {
    const coverage = pathCoversEveryCapability();
    expect(
      coverage.ok,
      `these capabilities have no step on the user's path: ${coverage.uncovered.join(", ")}`,
    ).toBe(true);
  });

  /**
   * ══ The coverage check must MEASURE, not assert ══
   *
   * Sabotage caught this: hardcoding `{ ok: true, uncovered: [] }` passed, because the only
   * test asserted `ok === true` — which a constant satisfies. A coverage check that cannot
   * report a gap is a green line that verified nothing.
   *
   * Proven by counting: the path covers exactly the implied capabilities and no more, so both
   * numbers are pinned and either table drifting is caught.
   */
  it("covers exactly the implied capabilities, counted rather than asserted", () => {
    const everyCapabilityId = new Set(IMPLIED_CAPABILITIES.map((rule) => rule.capability.id));
    // Derive from a prompt that triggers every rule, so the path is at full length.
    const everything =
      "a web app where each user brings their token, we take 10% of fees, and a keeper " +
      "runs on a schedule";
    const journey = deriveJourney({
      prompt: everything,
      capabilities: mergeCapabilities([], impliedCapabilities(everything)),
    });

    expect(
      journey.steps.length,
      "the path must have one step per implied capability, or a requirement is checked but " +
        "never placed on the user's route",
    ).toBe(everyCapabilityId.size);

    // And every step's capability is one the table knows about — no invented steps.
    for (const step of journey.steps) {
      expect(everyCapabilityId.has(step.capability.id)).toBe(true);
    }
  });

  it("names the steps no acting product can omit", () => {
    expect(ALWAYS_REQUIRED).toContain("understand");
    expect(ALWAYS_REQUIRED).toContain("supply-identifier");
  });
});

describe("auditing the derivation itself", () => {
  /**
   * Distinct from walking: a journey can be perfectly walkable and still be the WRONG journey
   * if derivation dropped a step. That is the failure that shipped — the path was never
   * written down, so nothing noticed a step was gone.
   */
  it("catches a journey missing a step its prompt implied", () => {
    const capabilities = mergeCapabilities(
      [],
      impliedCapabilities("each user brings their token and we take 10%"),
    );
    const complete = deriveJourney({ prompt: "p", capabilities });
    const truncated: Journey = { ...complete, steps: complete.steps.slice(0, 1) };

    const audit = auditJourney({ journey: truncated, capabilities });
    expect(audit.ok, "a truncated path audited as complete").toBe(false);
    expect(audit.missingSteps.length).toBeGreaterThan(0);
  });

  it("accepts a complete derivation", () => {
    const capabilities = mergeCapabilities(
      [],
      impliedCapabilities("each user brings their token and we take 10%"),
    );
    const audit = auditJourney({
      journey: deriveJourney({ prompt: "p", capabilities }),
      capabilities,
    });
    expect(audit.ok, audit.detail).toBe(true);
  });

  it("states its coverage rather than only ok", () => {
    const capabilities = mergeCapabilities([], impliedCapabilities("a web dashboard"));
    const audit = auditJourney({
      journey: deriveJourney({ prompt: "p", capabilities }),
      capabilities,
    });
    expect(audit.detail).toContain("step(s)");
  });
});

/**
 * ══ The coverage check, with its failing branch actually reached ══
 *
 * `pathCoversEveryCapability` took no arguments, so no test could see it report a gap —
 * hardcoding `{ ok: true, uncovered: [] }` passed everything. It is now parameterised, with
 * the real tables as defaults, so both outcomes are observable.
 */
describe("the coverage check itself", () => {
  it("reports a capability with no step on the path", () => {
    const coverage = pathCoversEveryCapability({
      capabilityIds: ["covered", "orphaned"],
      pathCapabilityIds: ["covered"],
    });
    expect(coverage.ok, "an uncovered capability reported as covered").toBe(false);
    expect(coverage.uncovered).toEqual(["orphaned"]);
  });

  it("reports every uncovered capability, not just the first", () => {
    const coverage = pathCoversEveryCapability({
      capabilityIds: ["a", "b", "c"],
      pathCapabilityIds: ["b"],
    });
    expect(coverage.uncovered).toEqual(["a", "c"]);
  });

  it("passes when the path covers everything", () => {
    const coverage = pathCoversEveryCapability({
      capabilityIds: ["a", "b"],
      pathCapabilityIds: ["a", "b", "extra"],
    });
    expect(coverage.ok).toBe(true);
    expect(coverage.uncovered).toEqual([]);
  });

  /** With no arguments it must still answer about the REAL tables. */
  it("defaults to the real implied table and the real path", () => {
    expect(pathCoversEveryCapability().ok).toBe(true);
  });
});

/**
 * ══ Two checks disagreeing about the same absence ══
 *
 * Found by wiring the acceptance stage into the pipeline: `assessAcceptance` PASSED a project —
 * its only gaps were `expected`, which by design do not block — while `walkJourney` REFUSED the
 * same project, because the path stops at the step those gaps belong to.
 *
 * Both readings are true. The path does stop there, and the absence is not fatal. So a dead end
 * is always reported and blocks only when its step was required. A stage blocking on every
 * implied step would block on nearly every prompt, and get turned off.
 */
describe("a path that stops at a step that was only expected", () => {
  function stepAt(id: string, level: "required" | "expected") {
    return {
      id,
      action: `does ${id}`,
      why: "reason",
      capability: { ...capability(id), level },
    };
  }

  const mixed: Journey = {
    goal: "get value",
    steps: [stepAt("one", "required"), stepAt("two", "expected"), stepAt("three", "required")],
  };

  it("reports the dead end", () => {
    const verdict = walkJourney({ journey: mixed, present: ["one"], isCheckable });
    expect(verdict.walkable, "a user genuinely cannot proceed past step two").toBe(false);
    expect(verdict.deadEnd?.atStep).toBe(2);
  });

  it("does not block on it", () => {
    const verdict = walkJourney({ journey: mixed, present: ["one"], isCheckable });
    expect(
      verdict.blocked,
      "blocking on an expected step contradicts the level that made it expected",
    ).toBe(false);
    expect(verdict.deadEnd?.blocking).toBe(false);
  });

  it("blocks when the path stops at a required step", () => {
    const verdict = walkJourney({ journey: mixed, present: ["one", "two"], isCheckable });
    expect(verdict.deadEnd?.atStep).toBe(3);
    expect(verdict.blocked).toBe(true);
  });

  /** The report has to say which kind it is, or a reader cannot tell why a build shipped. */
  it("says in the report whether the stop is blocking", () => {
    const soft = formatJourney(
      mixed,
      walkJourney({ journey: mixed, present: ["one"], isCheckable }),
    );
    expect(soft).toContain("stops (not blocking)");

    const hard = formatJourney(
      mixed,
      walkJourney({ journey: mixed, present: ["one", "two"], isCheckable }),
    );
    expect(hard).toContain("DEAD-ENDS");
  });

  /**
   * An unusable journey blocks regardless. A check that cannot run must not report success —
   * the abstention failure the whole package refuses.
   */
  it("blocks on a malformed journey", () => {
    const verdict = walkJourney({ journey: { goal: "g", steps: [] }, present: [], isCheckable });
    expect(verdict.blocked).toBe(true);
    expect(verdict.walkable).toBe(false);
  });
});
