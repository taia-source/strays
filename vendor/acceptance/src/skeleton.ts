/**
 * The thinnest path a user can walk, derived from a prompt.
 *
 * ══ Why the path is derived and not asked for ══
 *
 * A prompt describes a product. It does not describe the sequence a person moves through,
 * because that sequence is obvious to whoever wrote it — which is exactly why it goes missing.
 * The measured prompt asked for "a cashback agent that users use as a service for their pons
 * tokens", and every word of the path is implied by that sentence and stated by none of it:
 *
 *     arrive -> understand what this is -> identify yourself -> name your token
 *            -> fund it -> see it working
 *
 * Step four is where the shipped product stopped. Nobody omitted it deliberately; it was never
 * written down, so nothing could notice it was gone.
 *
 * ══ The order is the load-bearing part ══
 *
 * Cockburn's walking skeleton is the thinnest slice that works END TO END, and the failure it
 * prevents is horizontal layering — all the infrastructure, then all the APIs, then all the UI.
 * The broken project was built that way: the domain model first, correct and well tested, and
 * the interface assembled at the end from whatever existed.
 *
 * A derived path makes that assembly impossible to fake, because the path exists before the
 * code and each step names the evidence that would settle it.
 */

import type { Capability } from "./capability.js";
import { IMPLIED_CAPABILITIES } from "./capability.js";
import type { Journey, JourneyStep } from "./journey.js";

/**
 * The canonical path, and the order it must hold.
 *
 * Each entry names the implied capability that decides it, so a step and its evidence cannot
 * drift apart. `optionalWhen` marks steps that a given product genuinely may not have — a
 * read-only dashboard needs no funding step — and the absence of such a marker means the step
 * applies whenever its capability was implied.
 */
const PATH: readonly {
  readonly id: string;
  readonly action: string;
  readonly why: string;
  /** The `IMPLIED_CAPABILITIES` id that settles this step. */
  readonly capabilityId: string;
}[] = [
  {
    /**
     * ══ First, because it is where a stranger arrives ══
     *
     * `understand` asks whether the product is explained anywhere. This asks whether the page
     * they land on does it — and a product can pass the first while failing this one, which is
     * exactly what shipped: a control panel at `/` with 388 characters of labels and numbers.
     */
    id: "arrive",
    action: "lands on `/` and learns what this is, what it costs, and how to start",
    why:
      "`/` is the only page most people ever see. A product that opens onto its own control " +
      "panel has no way to tell a visitor what it is, and a heading alone does not fix that",
    capabilityId: "landing-page-explains-the-product",
  },
  {
    id: "understand",
    action: "reads what the product does and what it costs, before connecting anything",
    why:
      "a visitor who cannot tell what a service is will not connect a wallet to it. The " +
      "measured page opened directly onto a control panel: 388 characters of visible text, " +
      "every one a label or a number",
    capabilityId: "explains-itself",
  },
  {
    id: "supply-identifier",
    action: "enters the token or address the service will act on",
    why:
      "a product 'for their tokens' has no way to learn which token. This is the step the " +
      "measured product was missing entirely — there was no text input anywhere, so a user " +
      "could connect and then do nothing",
    capabilityId: "user-supplies-identifier",
  },
  {
    id: "configure",
    action: "chooses how the service runs for them, and that choice is remembered",
    why:
      "a setup that lives in component state is lost on reload, so the user's next visit " +
      "starts over and the backend never learns what they chose",
    capabilityId: "state-outlives-a-reload",
  },
  {
    id: "know-the-cost",
    action: "sees what this will cost them, computed on their own numbers",
    why: "a percentage with no worked example is the shape that produces disputes",
    capabilityId: "fee-arithmetic-is-visible",
  },
  {
    id: "know-who-holds-it",
    action: "learns whether a contract or an operator key holds their funds",
    why:
      "a product that takes deposits and explains neither has hidden its trust model. Either " +
      "answer is legitimate; silence is not",
    capabilityId: "custody-is-explicit",
  },
  {
    id: "see-it-working",
    action: "sees evidence the service is actually running for them",
    why:
      "a background worker that reports only to stdout means the only way to learn whether " +
      "the product works is to read platform logs",
    capabilityId: "background-work-is-observable",
  },
];

/**
 * Build the journey a prompt implies.
 *
 * Only steps whose capability was implied by the prompt are included — a project with no fee
 * needs no cost step — so the path is as thin as the product, which is the walking-skeleton
 * discipline rather than a checklist.
 */
export function deriveJourney(input: {
  readonly prompt: string;
  /** Capabilities already derived from the prompt, so derivation happens once. */
  readonly capabilities: readonly Capability[];
}): Journey {
  const byId = new Map(input.capabilities.map((capability) => [capability.id, capability]));

  const steps: JourneyStep[] = [];
  for (const entry of PATH) {
    const capability = byId.get(entry.capabilityId);
    // A step whose capability the prompt never implied does not apply to this product.
    if (capability === undefined) continue;

    steps.push({
      id: entry.id,
      action: entry.action,
      why: entry.why,
      capability,
    });
  }

  return { goal: describeGoal(input.prompt), steps };
}

/**
 * A one-line statement of what the path accomplishes.
 *
 * Taken from the prompt's own words rather than summarised: a goal restated in different words
 * is a goal someone can argue was misunderstood, and the point of the report is to be
 * unarguable about what was asked.
 */
export function describeGoal(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "(no prompt was supplied, so there is no goal to walk toward)";

  // The first clause, which is nearly always the ask. Bounded so a report stays readable.
  const firstClause = collapsed.split(/[.;]|,\s+(?:and|also|plus)\b/)[0] ?? collapsed;
  return firstClause.length > 160 ? `${firstClause.slice(0, 157)}...` : firstClause;
}

/**
 * The step ids that every product needs, whatever it is.
 *
 * ══ Why only two ══
 *
 * Everything else in `PATH` is conditional on what the prompt implied, but these two hold for
 * any product a person uses:
 *
 *   understand         nobody connects a wallet to a thing they cannot identify
 *   supply-identifier  a product that acts on the user's behalf must learn what to act on
 *
 * A read-only price dashboard is the honest counter-example to the second: it acts on nothing
 * the user names. So this is a floor for products that DO act on user input, and the trigger is
 * whether the prompt implied `user-supplies-identifier` at all.
 */
export const ALWAYS_REQUIRED: readonly string[] = ["understand", "supply-identifier"];

/**
 * Whether a journey has the steps its own prompt demanded.
 *
 * Distinct from walking it: a journey can be perfectly walkable and still be the wrong journey,
 * if derivation dropped a step. This checks the DERIVATION, which is the thing that failed —
 * the path was never written down, so nothing noticed the missing step.
 */
export function auditJourney(input: {
  readonly journey: Journey;
  readonly capabilities: readonly Capability[];
}): { readonly ok: boolean; readonly missingSteps: readonly string[]; readonly detail: string } {
  const stepIds = new Set(input.journey.steps.map((step) => step.id));
  const impliedIds = new Set(input.capabilities.map((capability) => capability.id));

  // A step is expected when its capability was implied by the prompt.
  const expected = PATH.filter((entry) => impliedIds.has(entry.capabilityId)).map(
    (entry) => entry.id,
  );
  const missing = expected.filter((id) => !stepIds.has(id));

  if (missing.length > 0) {
    return {
      ok: false,
      missingSteps: missing,
      detail:
        `the prompt implies ${expected.length} step(s) and the journey has ` +
        `${stepIds.size}: missing ${missing.join(", ")}`,
    };
  }

  return {
    ok: true,
    missingSteps: [],
    detail: `${stepIds.size} step(s), matching every capability the prompt implied`,
  };
}

/**
 * Whether the table itself covers a capability.
 *
 * Exists so a capability added to `IMPLIED_CAPABILITIES` without a corresponding step is
 * caught by a test rather than silently producing a shorter path. The two tables must stay in
 * step, and nothing else enforces that.
 */
export function pathCoversEveryCapability(input?: {
  /** Capability ids to require coverage of. Defaults to the real implied table. */
  readonly capabilityIds?: readonly string[] | undefined;
  /** Step-to-capability mappings. Defaults to the real path. */
  readonly pathCapabilityIds?: readonly string[] | undefined;
}): {
  readonly ok: boolean;
  readonly uncovered: readonly string[];
} {
  /**
   * ══ Parameterised so its FAILING branch is observable ══
   *
   * This took no arguments, and sabotage exposed why that was wrong: hardcoding
   * `{ ok: true, uncovered: [] }` passed every test, because with fixed inputs a test can only
   * ever see the all-covered case. A function whose failure path cannot be reached by a test
   * is a function whose failure path is not verified.
   *
   * Defaults are the real tables, so production callers pass nothing and get the real answer.
   */
  const capabilityIds =
    input?.capabilityIds ?? IMPLIED_CAPABILITIES.map((rule) => rule.capability.id);
  const covered = new Set(input?.pathCapabilityIds ?? PATH.map((entry) => entry.capabilityId));
  const uncovered = capabilityIds.filter((id) => !covered.has(id));
  return { ok: uncovered.length === 0, uncovered };
}
