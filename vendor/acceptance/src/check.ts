/**
 * Decide whether a built project has the capabilities the prompt required.
 *
 * ══ Every verdict is independent ══
 *
 * PRDBench found that when an agent evaluates criteria in a shared context, "if error occurs
 * in one test case, subsequent evaluations within the same project may be affected due to
 * contextual dependencies" — one bad verdict corrupts the rest.
 *
 * So each piece of evidence is decided from the tree alone, with no reference to any other
 * verdict, and the functions here are pure. A wrong answer stays one wrong answer.
 *
 * ══ Absence of evidence is a FAILURE, not an abstention ══
 *
 * The tempting design returns "unknown" when a check cannot run — no rendered page available,
 * no live route to hit. That is how a stage reports green having verified nothing, which is
 * the failure this whole package exists to correct. An unrunnable check fails and says why.
 */

import type { Capability, Evidence } from "./capability.js";
import { compileTarget, isCheckable } from "./derive.js";

/** The project as this module sees it. Injected so nothing here touches a filesystem. */
export type ProjectView = {
  /** Every shipped source file: path relative to the project root, and contents. */
  readonly files: readonly { readonly path: string; readonly source: string }[];
  /**
   * Symbols the project's own code exports, by path.
   *
   * Supplied by the caller because extracting them needs a parser, and this package stays
   * dependency-free and unit-testable without one.
   */
  readonly exports?: Readonly<Record<string, readonly string[]>> | undefined;
  /**
   * The RENDERED page, per route.
   *
   * `undefined` means no page was rendered — which fails any `rendered` evidence rather than
   * skipping it. A layout bug that 18 source-level checks missed was found only by looking at
   * a real render, so "we could not render" is a real failure.
   */
  readonly rendered?: Readonly<Record<string, RenderedPage>> | undefined;
  /** Routes that were actually requested, and what they answered. */
  readonly routes?: Readonly<Record<string, number>> | undefined;
};

/** What a real browser saw. */
export type RenderedPage = {
  /** Selectors present in the page, resolved in the browser. */
  readonly selectorsPresent: readonly string[];
  /** Visible text, for length and content checks. */
  readonly visibleText: string;
};

/** One evidence verdict. */
export type EvidenceVerdict = {
  readonly evidence: Evidence;
  readonly held: boolean;
  /** Why, in terms a reader can act on. Always populated, pass or fail. */
  readonly detail: string;
};

/** A capability's verdict: every piece of its evidence, and whether all held. */
export type CapabilityVerdict = {
  readonly capability: Capability;
  readonly present: boolean;
  readonly verdicts: readonly EvidenceVerdict[];
  /**
   * Set when the capability itself was malformed — no evidence, or judgement-only.
   *
   * Distinguished from `present: false` because they need different fixes: one is a missing
   * feature, the other is a check that could never have decided anything.
   */
  readonly uncheckable?: string | undefined;
};

/** Decide one piece of evidence against the tree. Pure, and independent of every other. */
export function checkEvidence(evidence: Evidence, view: ProjectView): EvidenceVerdict {
  switch (evidence.kind) {
    case "file": {
      const held = view.files.some((file) => file.path === evidence.target);
      return {
        evidence,
        held,
        detail: held
          ? `${evidence.target} exists`
          : `${evidence.target} does not exist in the project`,
      };
    }

    case "export": {
      const all = Object.values(view.exports ?? {}).flat();
      const held = all.includes(evidence.target);
      return {
        evidence,
        held,
        detail: held
          ? `${evidence.target} is exported`
          : view.exports === undefined
            ? `no export map was supplied, so "${evidence.target}" could not be confirmed — ` +
              "an unrunnable check fails rather than abstaining"
            : `nothing exports ${evidence.target}`,
      };
    }

    case "source": {
      const pattern = compileTarget(evidence.target);
      if (pattern === undefined) {
        return {
          evidence,
          held: false,
          detail: `the evidence pattern /${evidence.target}/ does not compile, so it decides nothing`,
        };
      }

      const hit = view.files.find((file) => pattern.test(file.source));
      return {
        evidence,
        held: hit !== undefined,
        detail:
          hit === undefined
            ? `no shipped file matches /${evidence.target}/`
            : `${hit.path} matches /${evidence.target}/`,
      };
    }

    case "path": {
      const pattern = compileTarget(evidence.target);
      if (pattern === undefined) {
        return {
          evidence,
          held: false,
          detail: `the evidence pattern /${evidence.target}/ does not compile, so it decides nothing`,
        };
      }

      const hit = view.files.find((file) => pattern.test(file.path));
      return {
        evidence,
        held: hit !== undefined,
        detail:
          hit === undefined
            ? `no shipped file has a path matching /${evidence.target}/`
            : `${hit.path} matches /${evidence.target}/`,
      };
    }

    case "rendered": {
      const pages = Object.entries(view.rendered ?? {});
      if (pages.length === 0) {
        return {
          evidence,
          held: false,
          detail:
            "no page was rendered, so nothing about the rendered output is known. A layout " +
            "bug that passed 18 source-level checks was found only in a real render, so this " +
            "fails rather than abstains",
        };
      }

      const match = pages.find(([, page]) => page.selectorsPresent.includes(evidence.target));
      return {
        evidence,
        held: match !== undefined,
        detail:
          match === undefined
            ? `no rendered page contains "${evidence.target}" (checked ${pages.map(([route]) => route).join(", ")})`
            : `${match[0]} renders "${evidence.target}"`,
      };
    }

    case "route": {
      const status = view.routes?.[evidence.target];
      if (status === undefined) {
        return {
          evidence,
          held: false,
          detail: `${evidence.target} was never requested, so it is not known to answer`,
        };
      }
      // Anything that is not a server error counts: a 401 from an auth route is the route
      // working. A 5xx is the route failing.
      const held = status < 500;
      return {
        evidence,
        held,
        detail: `${evidence.target} answered ${status}`,
      };
    }

    case "prose": {
      const pages = Object.entries(view.rendered ?? {});
      if (pages.length === 0) {
        return {
          evidence,
          held: false,
          detail: "no page was rendered, so its prose is unknown",
        };
      }

      const minimumWords = Number.parseInt(evidence.target, 10);
      if (Number.isNaN(minimumWords) || minimumWords <= 0) {
        return {
          evidence,
          held: false,
          detail: `"${evidence.target}" is not a word count, so this evidence decides nothing`,
        };
      }

      /**
       * ══ Sentences, not characters ══
       *
       * The measured page rendered 392 characters of visible text — "MODE DEPOSIT FEE-SHARE
       * BALANCE 0.010000 ETH RUNS UNTIL SPENT STATUS ACTIVE" — and explained nothing. A
       * character threshold passes that; a sentence threshold does not.
       *
       * A word here must contain a letter and be at least two characters, so "0.010000" and
       * "ETH" do not pad a run into looking like prose.
       */
      const best = pages
        .map(([route, page]) => {
          const longest = page.visibleText
            .split(/[.!?]+|\n{2,}/)
            .map(
              (sentence) =>
                sentence
                  .trim()
                  .split(/\s+/)
                  .filter((word) => word.length > 1 && /[a-z]/i.test(word)).length,
            )
            .reduce((a, b) => Math.max(a, b), 0);
          return { route, longest };
        })
        .reduce((a, b) => (b.longest > a.longest ? b : a));

      return {
        evidence,
        held: best.longest >= minimumWords,
        detail:
          best.longest >= minimumWords
            ? `${best.route} has a ${best.longest}-word sentence`
            : `no page has a sentence of ${minimumWords}+ words (longest: ${best.longest} on ` +
              `${best.route}). A page of labels and numbers renders text and explains nothing`,
      };
    }

    case "judgement": {
      /**
       * Never decided here.
       *
       * A judge's verdict enters through `applyJudgements`, so the deterministic pass cannot
       * be influenced by one — and a judgement with no verdict supplied FAILS. Defaulting to
       * held would let every unjudged capability pass silently.
       */
      return {
        evidence,
        held: false,
        detail: `awaiting judgement: ${evidence.target}`,
      };
    }
  }
}

/** Decide one capability. */
export function checkCapability(capability: Capability, view: ProjectView): CapabilityVerdict {
  const checkable = isCheckable(capability);
  if (!checkable.ok) {
    return {
      capability,
      present: false,
      verdicts: [],
      uncheckable: checkable.detail,
    };
  }

  const verdicts = capability.evidence.map((piece) => checkEvidence(piece, view));
  return {
    capability,
    // ALL evidence must hold. "An input exists" and "the input is wired" are both required,
    // and satisfying either alone is the exact shape of the measured failure.
    present: verdicts.every((verdict) => verdict.held),
    verdicts,
  };
}

/**
 * Fold judge verdicts into a deterministic result.
 *
 * ══ A judge can only CONFIRM, never overrule ══
 *
 * Judge alignment with human annotators measures 81.56% (σ 27.83%). So a judgement may settle
 * a `judgement` piece of evidence and nothing else: it cannot flip a failed selector to
 * present, and it cannot rescue a capability whose file does not exist.
 *
 * That asymmetry is the whole safety property. The worst a wrong judge can do is fail
 * something that was fine — noisy, and safe. The reverse would be a rubber stamp.
 */
export function applyJudgements(
  verdict: CapabilityVerdict,
  judgements: Readonly<Record<string, boolean>>,
): CapabilityVerdict {
  if (verdict.uncheckable !== undefined) return verdict;

  const verdicts = verdict.verdicts.map((piece) => {
    if (piece.evidence.kind !== "judgement") return piece;
    const answer = judgements[piece.evidence.target];
    if (answer === undefined) return piece;
    return {
      ...piece,
      held: answer,
      detail: answer
        ? `judged present: ${piece.evidence.target}`
        : `judged ABSENT: ${piece.evidence.target}`,
    };
  });

  return { ...verdict, verdicts, present: verdicts.every((piece) => piece.held) };
}

/** The stage's answer. */
export type AcceptanceResult = {
  /** False when any `required` capability is absent or uncheckable. */
  readonly ok: boolean;
  readonly verdicts: readonly CapabilityVerdict[];
  /** Required capabilities that are absent. The list that blocks a deploy. */
  readonly missing: readonly string[];
  /** Expected capabilities that are absent. Reported loudly, does not block. */
  readonly gaps: readonly string[];
};

/**
 * Judge a whole project.
 *
 * An empty capability list is NOT ok. A prompt always implies something, so deriving nothing
 * means derivation failed — and reporting that as a pass is how this stage would become
 * decorative.
 */
export function assessAcceptance(input: {
  readonly capabilities: readonly Capability[];
  readonly view: ProjectView;
  readonly judgements?: Readonly<Record<string, boolean>> | undefined;
}): AcceptanceResult {
  if (input.capabilities.length === 0) {
    return {
      ok: false,
      verdicts: [],
      missing: ["no capabilities were derived, so nothing was checked"],
      gaps: [],
    };
  }

  const verdicts = input.capabilities
    .map((capability) => checkCapability(capability, input.view))
    .map((verdict) => applyJudgements(verdict, input.judgements ?? {}));

  const missing = verdicts
    .filter((verdict) => verdict.capability.level === "required" && !verdict.present)
    .map((verdict) => verdict.capability.id);

  const gaps = verdicts
    .filter((verdict) => verdict.capability.level === "expected" && !verdict.present)
    .map((verdict) => verdict.capability.id);

  return { ok: missing.length === 0, verdicts, missing, gaps };
}

/** A report that names what a user cannot do, not which rule fired. */
export function formatAcceptance(result: AcceptanceResult): string {
  if (result.verdicts.length === 0) {
    return "ACCEPTANCE FAILED: no capabilities were derived, so nothing was checked";
  }

  const lines: string[] = [];
  lines.push(
    result.ok
      ? `acceptance passed: ${result.verdicts.length} capabilit(ies) checked`
      : `ACCEPTANCE FAILED: ${result.missing.length} required capabilit(ies) absent`,
  );

  for (const verdict of result.verdicts) {
    if (verdict.present) continue;
    const label = verdict.capability.level === "required" ? "MISSING" : "gap";
    lines.push(`  [${label}] ${verdict.capability.id} — ${verdict.capability.statement}`);
    lines.push(`    ${verdict.capability.source}`);
    if (verdict.uncheckable !== undefined) {
      lines.push(`    UNCHECKABLE: ${verdict.uncheckable}`);
    }
    for (const piece of verdict.verdicts.filter((item) => !item.held)) {
      lines.push(`    - ${piece.detail}`);
    }
  }

  if (result.gaps.length > 0 && result.ok) {
    lines.push(`  (${result.gaps.length} expected capabilit(ies) absent but not blocking)`);
  }

  return lines.join("\n");
}
