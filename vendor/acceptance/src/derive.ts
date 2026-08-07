/**
 * Turn a prompt into capabilities that can be checked.
 *
 * ══ Two sources, deliberately ══
 *
 * **Implied** capabilities come from the table in `capability.ts` — deterministic, derived
 * from measured omissions, and the ones a model reliably misses because the prompt assumes
 * rather than states them. A service "for users' tokens" never says "add a text input"; it
 * does not occur to anyone to say it, which is exactly why it went missing.
 *
 * **Stated** capabilities are the sentences of the prompt itself. Those a model can extract,
 * and this module accepts them from a caller rather than making the call — the same seam
 * `runPipeline` uses, so a run stays replayable.
 *
 * The union is what gets checked. Neither half is sufficient: the table cannot know this
 * product, and a model asked "what did they ask for?" answers with what was written.
 */

import { type Capability, IMPLIED_CAPABILITIES } from "./capability.js";

/**
 * Capabilities a prompt implies without stating.
 *
 * Every match records the phrase that triggered it, so a capability someone disagrees with
 * can be traced to the words that produced it rather than argued about in the abstract.
 */
export function impliedCapabilities(prompt: string): readonly Capability[] {
  const found: Capability[] = [];

  for (const rule of IMPLIED_CAPABILITIES) {
    // `exec` rather than `test`: the matched text goes into the report, and a rule that
    // fired for a reason nobody can see is a rule that gets deleted.
    const match = rule.when.exec(prompt);
    if (match === null) continue;

    found.push({
      ...rule.capability,
      source: `implied by "${match[0].trim()}"`,
    });
  }

  return found;
}

/**
 * Merge stated and implied capabilities, preferring the stricter of any duplicate.
 *
 * A model asked to extract requirements will sometimes produce one the table also covers. The
 * duplicate is not harmful, but two findings for one gap reads as two gaps — and the STRICTER
 * level must win, or a model calling something "expected" would downgrade a requirement the
 * table knows is measured-fatal.
 */
export function mergeCapabilities(
  stated: readonly Capability[],
  implied: readonly Capability[],
): readonly Capability[] {
  const byId = new Map<string, Capability>();

  for (const capability of [...stated, ...implied]) {
    const existing = byId.get(capability.id);
    if (existing === undefined) {
      byId.set(capability.id, capability);
      continue;
    }

    // Union the evidence and keep the stricter level. More evidence is a stricter check, and
    // the whole point of the table is that its entries were measured.
    byId.set(capability.id, {
      ...existing,
      level:
        existing.level === "required" || capability.level === "required" ? "required" : "expected",
      evidence: [...existing.evidence, ...capability.evidence],
      source: `${existing.source}; ${capability.source}`,
    });
  }

  // Sorted so two runs over the same prompt produce identical reports.
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Sanity-check a model-supplied capability before it is trusted.
 *
 * ══ Why this exists ══
 *
 * PRDBench measured LLM-as-judge alignment at 81.56% with σ 27.83%. The same unreliability
 * applies to a model asked to DERIVE criteria: it will produce capabilities that cannot fail
 * ("the code is well structured"), capabilities with no evidence, and capabilities whose
 * evidence is a restatement of the requirement.
 *
 * A capability that cannot fail is worse than none: it adds a green line to a report and
 * verifies nothing. So each one is checked for being decidable before it counts.
 */
export function isCheckable(
  capability: Capability,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  if (capability.id.trim() === "") {
    return { ok: false, detail: "a capability with no id cannot be correlated with a finding" };
  }

  if (capability.evidence.length === 0) {
    return {
      ok: false,
      detail:
        `"${capability.id}" carries no evidence, so nothing can decide it. A capability that ` +
        "cannot fail adds a green line to a report and verifies nothing",
    };
  }

  const empty = capability.evidence.filter((piece) => piece.target.trim() === "");
  if (empty.length > 0) {
    return {
      ok: false,
      detail: `"${capability.id}" has ${empty.length} piece(s) of evidence with no target`,
    };
  }

  /**
   * Evidence that is entirely judgement is allowed but flagged when it is the ONLY kind.
   *
   * The measured reason: a stage whose verdicts all come from a judge inherits the judge's
   * 81% alignment, and a capability decided that way is a coin flip dressed as a check.
   */
  const decidable = capability.evidence.filter((piece) => piece.kind !== "judgement");
  if (decidable.length === 0) {
    return {
      ok: false,
      detail:
        `"${capability.id}" can only be settled by judgement. Judge alignment with human ` +
        "annotators measures 81.56% (σ 27.83%), so a capability with no decidable evidence " +
        "is not a check — express at least one part as a file, export, selector or route",
    };
  }

  return { ok: true };
}

/**
 * A regex that a `source` evidence target must compile to.
 *
 * Returned rather than thrown: a model-supplied pattern is untrusted input, and an invalid one
 * must produce a finding about the CAPABILITY rather than crash the stage that was checking it.
 */
export function compileTarget(target: string): RegExp | undefined {
  try {
    // `u` is deliberately omitted: a model-written pattern frequently contains escapes that
    // are legal without it and throw with it, and rejecting those would fail the check for a
    // reason unrelated to the project under test.
    return new RegExp(target, "i");
  } catch {
    return undefined;
  }
}
