/**
 * The user's path through the product, as ordered steps that must each exist.
 *
 * ══ Why capabilities are not enough ══
 *
 * `capability.ts` catches a missing feature after the build. This catches something earlier
 * and worse: a product where every feature exists and **the path between them does not**.
 *
 * The measured case had that shape. Connect worked. The split arithmetic worked and was
 * well tested. The holder table rendered. But step two of the user's path — *enter the token
 * this is for* — was absent, so nothing after step one was reachable by any real person. A
 * capability check per feature reports four passes and one failure; what actually happened is
 * that the product was **unusable at step two**, which is a different and more serious claim.
 *
 * ══ Vertical, not horizontal ══
 *
 * Cockburn's walking skeleton (1994) is "the thinnest possible slice of real functionality
 * that can be built, deployed and tested end to end". The failure mode it prevents is named
 * precisely in the literature: horizontal layering builds all the infrastructure, then all the
 * APIs, then all the UI.
 *
 * That is what produced the broken project. The domain model was built first — splits, cycles,
 * claims, all correct — and the UI was assembled at the end from whatever happened to exist.
 * The scaffold offered `<main>{spec.name}</main>` and no notion of a path, so there was nothing
 * to assemble toward.
 *
 * ══ Traceable, because a step with no evidence is a wish ══
 *
 * The Spec Growth Engine names the failure this guards against: **specification drift**, where
 * "specifications and implementations gradually diverge", and its remedy is bidirectional
 * traceability from a spec item to the code implementing it.
 *
 * So every step here carries the `Capability` that decides it. A journey is not documentation
 * — it is an ordered list of things that were checked against the artifact.
 */

import type { Capability } from "./capability.js";

/** One step on the user's path. */
export type JourneyStep = {
  /** Stable id, kebab-case. */
  readonly id: string;
  /** What the user does here, in their words: "enters the token they want cashback on". */
  readonly action: string;
  /**
   * Why this step cannot be skipped.
   *
   * Recorded because a step someone disagrees with must be arguable on its merits. "Step 2 is
   * required because a service for a user's token has no way to learn which token" is a claim
   * that can be accepted or rejected; "step 2 is required" is not.
   */
  readonly why: string;
  /**
   * What must exist for a user to complete this step.
   *
   * The same `Capability` shape the acceptance stage checks, so a step is decided by evidence
   * rather than asserted. A step with no capability is unfalsifiable — see `firstDeadEnd`.
   */
  readonly capability: Capability;
};

/**
 * An ordered path a real person takes to get value from the product.
 *
 * Ordered, because reachability is transitive: if step 2 is missing, steps 3 onward are
 * unreachable no matter how well they are implemented. That is the fact a per-feature check
 * cannot express, and the one that describes what actually shipped.
 */
export type Journey = {
  /** What this path accomplishes: "a creator enrols a token and holders get paid". */
  readonly goal: string;
  readonly steps: readonly JourneyStep[];
};

/** Where a journey stops being walkable, and what that costs. */
export type DeadEnd = {
  /** 1-based index of the first step a user cannot complete. */
  readonly atStep: number;
  readonly step: JourneyStep;
  /**
   * Steps after the dead end.
   *
   * The point of reporting these: they may be perfectly implemented and are still unreachable.
   * The measured project had a correct fee split, a correct holder distribution and a correct
   * keeper — all downstream of a missing input, and all unreachable.
   */
  readonly unreachable: readonly JourneyStep[];
  /**
   * Whether this dead end blocks, taken from the step's own capability level.
   *
   * ══ Two checks disagreeing about the same absence ══
   *
   * Found by wiring the stage up: `assessAcceptance` passed a project — its only gaps were
   * `expected`, which by design do not block — while `walkJourney` refused the same project,
   * because the path stops at the step those gaps belong to.
   *
   * Both readings are true. The path DOES stop there, and the absence is NOT fatal. So the
   * dead end is always reported, because a user genuinely cannot proceed and that is worth
   * saying, and it blocks only when the step it stops at was required. A stage that blocked on
   * every implied step would block on almost every prompt, and get turned off.
   */
  readonly blocking: boolean;
};

/**
 * The first step a user cannot complete, given which capabilities are present.
 *
 * ══ Returns the FIRST, not all of them ══
 *
 * Reporting every missing step invites fixing the cheapest one. Reporting the first says where
 * the product actually stops, and everything after it is consequence rather than separate news.
 */
export function firstDeadEnd(input: {
  readonly journey: Journey;
  /** Capability ids confirmed present against the built artifact. */
  readonly present: readonly string[];
}): DeadEnd | undefined {
  const present = new Set(input.present);

  for (const [index, step] of input.journey.steps.entries()) {
    if (present.has(step.capability.id)) continue;
    return {
      atStep: index + 1,
      step,
      unreachable: input.journey.steps.slice(index + 1),
      blocking: step.capability.level === "required",
    };
  }

  return undefined;
}

/** Why a journey cannot be trusted to describe anything. */
export type JourneyFlaw =
  /** No steps. A product with no user path is not a product. */
  | "empty"
  /** Two steps share an id, so a verdict cannot be attributed to one of them. */
  | "duplicate-step"
  /**
   * A step whose capability has no decidable evidence.
   *
   * The same standard `isCheckable` applies: a step that cannot fail is a step that will
   * always report walkable, which is worse than having no journey at all.
   */
  | "unfalsifiable-step"
  /**
   * The path never reaches an outcome.
   *
   * Measured: the shipped product let a user connect a wallet and do nothing else. A journey
   * of one step is a journey that goes nowhere — the user arrives and the product ends.
   */
  | "no-outcome";

/**
 * Whether a journey is worth checking against an artifact.
 *
 * Validated before use, for the same reason capabilities are: a journey derived by a model
 * will contain steps like "the user has a good experience", and one unfalsifiable step makes
 * the whole path report walkable.
 */
export function validateJourney(
  journey: Journey,
  isCheckable: (capability: Capability) => { readonly ok: boolean; readonly detail?: string },
):
  | { readonly ok: true }
  | { readonly ok: false; readonly flaw: JourneyFlaw; readonly detail: string } {
  if (journey.steps.length === 0) {
    return {
      ok: false,
      flaw: "empty",
      detail: "a journey with no steps describes no product and can never fail",
    };
  }

  /**
   * Two steps is the minimum for a path.
   *
   * One step is an arrival, not a journey. The measured product was exactly this: connect a
   * wallet, and then nothing — which a single-step journey would have reported as complete.
   */
  if (journey.steps.length < 2) {
    return {
      ok: false,
      flaw: "no-outcome",
      detail:
        `"${journey.goal}" has one step, so it describes arriving rather than accomplishing. ` +
        "The measured failure let a user connect a wallet and do nothing else",
    };
  }

  const seen = new Set<string>();
  for (const step of journey.steps) {
    if (seen.has(step.id)) {
      return {
        ok: false,
        flaw: "duplicate-step",
        detail: `two steps share the id "${step.id}", so a verdict cannot be attributed to one`,
      };
    }
    seen.add(step.id);

    const checkable = isCheckable(step.capability);
    if (!checkable.ok) {
      return {
        ok: false,
        flaw: "unfalsifiable-step",
        detail:
          `step "${step.id}" cannot be decided: ${checkable.detail ?? "no evidence"}. One ` +
          "unfalsifiable step makes the whole path report walkable",
      };
    }
  }

  return { ok: true };
}

/** What a journey check concluded. */
export type JourneyVerdict = {
  /** True only when every step is reachable. */
  readonly walkable: boolean;
  /**
   * True when the path stops at a REQUIRED step.
   *
   * `walkable` answers "can a user complete the path"; this answers "should this ship". They
   * differ exactly when a path stops at an `expected` step — reportable, not fatal.
   */
  readonly blocked: boolean;
  readonly deadEnd: DeadEnd | undefined;
  /** Set when the journey itself was malformed, distinct from a product that fails it. */
  readonly invalid?: { readonly flaw: JourneyFlaw; readonly detail: string } | undefined;
  /** Steps confirmed reachable, so a pass states its own coverage. */
  readonly reachable: readonly string[];
};

/**
 * Walk the journey against what is present.
 *
 * A malformed journey is NOT walkable. The alternative — treating an unusable journey as a
 * pass — is the same abstention failure the rest of this package refuses: a check that cannot
 * run must not report success.
 */
export function walkJourney(input: {
  readonly journey: Journey;
  readonly present: readonly string[];
  readonly isCheckable: (capability: Capability) => {
    readonly ok: boolean;
    readonly detail?: string;
  };
}): JourneyVerdict {
  const validity = validateJourney(input.journey, input.isCheckable);
  if (!validity.ok) {
    return {
      walkable: false,
      // An unusable journey blocks: a check that cannot run must not report success.
      blocked: true,
      deadEnd: undefined,
      invalid: { flaw: validity.flaw, detail: validity.detail },
      reachable: [],
    };
  }

  const deadEnd = firstDeadEnd({ journey: input.journey, present: input.present });
  const reachable =
    deadEnd === undefined
      ? input.journey.steps.map((step) => step.id)
      : input.journey.steps.slice(0, deadEnd.atStep - 1).map((step) => step.id);

  return {
    walkable: deadEnd === undefined,
    // Distinct from `walkable`: a path can stop at an `expected` step, which is worth reporting
    // and is not a reason to refuse a build. See DeadEnd.blocking.
    // `=== true` rather than biome's suggested `deadEnd?.blocking`, which types as
    // boolean | undefined — an undefined `blocked` is falsy and would read as "does not block".
    blocked: deadEnd?.blocking === true,
    deadEnd,
    reachable,
  };
}

/**
 * A report that says where the product stops.
 *
 * Written to be read by someone deciding whether to ship. "3 of 6 steps unreachable" is a
 * number; "a user cannot get past entering their token" is a decision.
 */
export function formatJourney(journey: Journey, verdict: JourneyVerdict): string {
  if (verdict.invalid !== undefined) {
    return `JOURNEY UNUSABLE (${verdict.invalid.flaw}): ${verdict.invalid.detail}`;
  }

  if (verdict.walkable) {
    return (
      `journey walkable: "${journey.goal}" — all ${journey.steps.length} steps reachable ` +
      `(${verdict.reachable.join(" -> ")})`
    );
  }

  const deadEnd = verdict.deadEnd;
  if (deadEnd === undefined) {
    // Unreachable by construction: `walkable` is false only when a dead end or an invalid
    // journey exists. Stated rather than assumed, because a silent empty report would be the
    // worst possible output here.
    return "JOURNEY NOT WALKABLE, but no dead end was identified — this is a bug in the checker";
  }

  const lines = [
    `JOURNEY ${deadEnd.blocking ? "DEAD-ENDS" : "stops (not blocking)"} at step ` +
      `${deadEnd.atStep} of ${journey.steps.length}: "${journey.goal}"`,
    `  the user cannot: ${deadEnd.step.action}`,
    `  why it is required: ${deadEnd.step.why}`,
    `  missing: ${deadEnd.step.capability.statement}`,
  ];

  if (deadEnd.unreachable.length > 0) {
    lines.push(
      `  ${deadEnd.unreachable.length} later step(s) are UNREACHABLE regardless of how well ` +
        "they are implemented:",
    );
    for (const step of deadEnd.unreachable) {
      lines.push(`    - ${step.action}`);
    }
  }

  return lines.join("\n");
}
