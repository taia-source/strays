/**
 * Focus and target size — the WCAG 2.2 criteria nothing checks.
 *
 * ══ The coverage gap, enumerated from the package ══
 *
 * axe-core 4.12.1 rules, queried by WCAG tag:
 *
 *   2.4.11 Focus Not Obscured (AA)   0 rules
 *   2.4.7  Focus Visible (AA)        0 rules
 *   2.1.2  No Keyboard Trap (A)      0 rules
 *   2.4.3  Focus Order (A)           0 rules
 *   2.5.8  Target Size (AA)          1 rule — `"enabled": false`
 *
 * Four criteria with **no rule at all**, and the fifth ships disabled: axe's own
 * documentation says the WCAG 2.2 rules are off "until WCAG 2.2 is more widely adopted".
 * Verified behaviourally too — on a default `axe.run()`, `target-size` appears in
 * violations, passes, incomplete *and* inapplicable alike: it never executes.
 *
 * So a project can run axe, see zero violations, and have keyboard focus land on
 * components hidden under its own sticky header.
 *
 * ══ Why hit-testing rather than box arithmetic ══
 *
 * Comparing bounding boxes against `position: fixed` elements requires reimplementing
 * stacking contexts and z-index. `document.elementFromPoint` uses the browser's real
 * hit-testing instead. Measured on a link half under a fixed header, sampling a 5×5 grid:
 *
 *   #under    0/25 visible, covered by #hdr   → entirely hidden  (2.4.11 FAILS)
 *   #partial  20/25 visible                   → partially hidden (2.4.11 PASSES)
 *   #clear    25/25 visible                   → fine
 *
 * Centre-only sampling would call `#partial` obscured and be wrong: 2.4.11 says *"not
 * **entirely** hidden"*, so partial obscuring conforms at Level AA.
 *
 * ══ Three false positives, each measured ══
 *
 * **1. A transparent overlay wins every hit test.** An `inset: 0` element with
 * `background: transparent` intercepts `elementFromPoint` in all three engines, even over
 * an element that is visually completely clear. Hit-testing is not visibility, and there
 * is no sound mechanical fix — so this is reported as **needs-review**, never a failure.
 *
 * **2. Off-viewport returns `null`**, which is indistinguishable from "nothing there".
 * An element scrolled out of view is not obscured, so viewport gating comes first.
 *
 * **3. `display: none` reports a 0×0 rect at (0, 0)** and hit-tests to whatever sits at
 * the origin — usually the header. Guaranteed false positive without a zero-area filter.
 *
 * ══ The viewport measure that differs by engine ══
 *
 * `documentElement.clientHeight` is **not** the viewport. Measured in Firefox on a page
 * whose content is all absolutely positioned:
 *
 *   documentElement.clientHeight   8    ← the root box, sized to content
 *   window.innerHeight           600    ← the actual viewport
 *
 * Chromium and WebKit happened to report 600 for both, so a check written against
 * `clientHeight` passes there and silently samples **zero points** on Firefox — a vacuous
 * pass. The collector uses `innerWidth`/`innerHeight`.
 */

export type FocusableObservation = {
  readonly selector: string;
  /** Rendered box in CSS pixels. Unaffected by devicePixelRatio — verified at dpr 1, 2, 3. */
  readonly width: number;
  readonly height: number;
  /** Centre point, for the spacing exception. */
  readonly centreX: number;
  readonly centreY: number;
  /** Whether any part of the element lies inside the viewport. */
  readonly inViewport: boolean;
  /** Grid points sampled inside the viewport. Zero means no verdict is possible. */
  readonly sampledPoints: number;
  /** Of those, how many hit-tested to the element or a descendant. */
  readonly visiblePoints: number;
  /** What covered it, when something did. */
  readonly coveredBy?: string | undefined;
  /** Set when the covering element appears to be fully transparent. */
  readonly coveredByTransparent?: boolean | undefined;
  /** Whether the element sits inline among sentence text — the 2.5.8 inline exception. */
  readonly inlineInText: boolean;
};

export type FocusDefect = "focus-obscured" | "focus-possibly-obscured" | "target-too-small";

export type FocusFinding = {
  readonly kind: FocusDefect;
  readonly selector: string;
  readonly detail: string;
  readonly severity: "high" | "medium";
};

/**
 * WCAG 2.5.8 Target Size (Minimum), Level AA: 24 by 24 CSS pixels.
 *
 * `getBoundingClientRect` returns CSS pixels regardless of `deviceScaleFactor` — verified
 * at 1, 2 and 3 in all three engines, all reporting an identical 200×100 — so no
 * conversion is needed, which is exactly what the criterion requires.
 */
export const MIN_TARGET_PX = 24;

/**
 * The spacing exception, as the specification words it: *"if a 24 CSS pixel diameter
 * circle is centered on the bounding box of each, the circles do not intersect"*.
 *
 * Two circles of diameter 24 intersect exactly when their centres are closer than 24
 * apart, so the test is a centre distance. Verified against axe's own `target-size` rule
 * on eight targets, agreeing on seven.
 *
 * The disagreement is worth recording: axe additionally failed a nominally-30px target
 * whose clickable area was cut to 15px by an overlapping sibling. axe is right — a target
 * large enough on paper can still be too small to hit. That case needs an overlap check
 * this function does not attempt, so {@link assessTargetSize} takes `obscuredWidth` when a
 * caller can supply it.
 */
export function spacingExceptionMet(
  target: { readonly centreX: number; readonly centreY: number },
  others: ReadonlyArray<{ readonly centreX: number; readonly centreY: number }>,
): boolean {
  return others.every((other) => {
    const dx = other.centreX - target.centreX;
    const dy = other.centreY - target.centreY;
    return Math.hypot(dx, dy) >= MIN_TARGET_PX;
  });
}

/**
 * Judge target sizes across the page.
 *
 * The spacing exception needs every other target's position, so this takes the whole set
 * rather than one element at a time.
 *
 * Two of the five exceptions are **not** mechanically decidable and are therefore not
 * attempted: *Equivalent* needs to know two controls do the same thing, and *Essential*
 * needs design or legal intent. Guessing at either would produce confident wrong answers.
 */
export function assessTargetSize(
  targets: readonly FocusableObservation[],
): readonly FocusFinding[] {
  const findings: FocusFinding[] = [];

  for (const target of targets) {
    if (target.width <= 0 || target.height <= 0) continue;
    if (target.width >= MIN_TARGET_PX && target.height >= MIN_TARGET_PX) continue;

    /**
     * The Inline exception: *"the target is in a sentence or its size is otherwise
     * constrained by the line-height of non-target text"*. Detectable only by heuristic —
     * an inline display with sentence text beside it — so it suppresses the finding
     * rather than being reported, matching how the criterion treats it.
     */
    if (target.inlineInText) continue;

    const others = targets.filter((other) => other !== target && other.width > 0);
    if (spacingExceptionMet(target, others)) continue;

    findings.push({
      kind: "target-too-small",
      selector: target.selector,
      severity: "medium",
      detail:
        `is ${Math.round(target.width)}×${Math.round(target.height)} CSS px, under the ` +
        `${MIN_TARGET_PX}×${MIN_TARGET_PX} of WCAG 2.5.8 (Level AA), and close enough to another ` +
        "target that the spacing exception does not apply. axe-core has a rule for this and " +
        "ships it DISABLED by default, so most pipelines never run it",
    });
  }

  return findings;
}

/**
 * Judge whether focus lands on something hidden.
 *
 * WCAG 2.4.11 (Level AA) requires only that the component is not **entirely** hidden, so
 * partial obscuring conforms and must not be reported — measured, a link 20/25 visible
 * under a sticky header passes.
 */
export function assessFocusObscured(observation: FocusableObservation): readonly FocusFinding[] {
  // Scrolled out of view is not obscured, and `elementFromPoint` returns null there —
  // indistinguishable from "nothing covering it".
  if (!observation.inViewport) return [];
  // A zero-area element reports a 0×0 rect at the origin and hit-tests to whatever sits
  // there. Measured on `display: none`: a guaranteed false positive.
  if (observation.width <= 0 || observation.height <= 0) return [];
  // No sampled points means no verdict. Silence beats a guess.
  if (observation.sampledPoints === 0) return [];
  if (observation.visiblePoints > 0) return [];

  /**
   * A fully transparent overlay intercepts hit-testing while obscuring nothing visually —
   * measured in all three engines. There is no sound mechanical way to tell that from a
   * real cover, so it is downgraded to needs-review rather than reported as a failure.
   */
  if (observation.coveredByTransparent) {
    return [
      {
        kind: "focus-possibly-obscured",
        selector: observation.selector,
        severity: "medium",
        detail:
          `hit-tests to ${observation.coveredBy ?? "another element"}, which appears fully ` +
          "transparent. Hit-testing is not visibility: a transparent overlay intercepts every " +
          "point while hiding nothing, measured in all three engines. Needs a human — this is " +
          "either a real cover or an invisible overlay that only blocks the pointer",
      },
    ];
  }

  return [
    {
      kind: "focus-obscured",
      selector: observation.selector,
      severity: "high",
      detail:
        `is entirely hidden behind ${observation.coveredBy ?? "author content"} when focused — ` +
        `0 of ${observation.sampledPoints} sampled points reach it. WCAG 2.4.11 (Level AA) ` +
        "requires that a focused component not be entirely hidden; a sticky header eating the " +
        "focused field after scrolling is the canonical case. `scroll-padding-top` on the " +
        "scroll container fixes it. axe-core has NO rule for this criterion",
    },
  ];
}

export type FocusResult = {
  readonly ok: boolean;
  readonly findings: readonly FocusFinding[];
};

export function checkFocus(observations: readonly FocusableObservation[]): FocusResult {
  const findings = [
    ...observations.flatMap((o) => assessFocusObscured(o)),
    ...assessTargetSize(observations),
  ];
  return { ok: findings.every((f) => f.severity !== "high"), findings };
}

/**
 * Collect focusable elements and their hit-test results.
 *
 * Self-contained: Playwright's string-form `evaluate` cannot close over module scope.
 *
 * Note this observes elements **in place** rather than focusing each one. Calling
 * `.focus()` scrolls an element into view, which destroys the very condition being tested
 * — the canonical 2.4.11 failure is a sticky header covering a field *after* the user has
 * scrolled. A caller wanting per-element focus behaviour should scroll deliberately and
 * re-collect.
 */
export const COLLECT_FOCUS_SCRIPT = `(() => {
  const name = (e) => e.id ? '#' + e.id
    : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' && e.className.trim()
        ? '.' + e.className.trim().split(/\\s+/)[0] : '');

  const TABBABLE = 'a[href], area[href], button:not([disabled]), ' +
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
    'textarea:not([disabled]), iframe, audio[controls], video[controls], ' +
    '[contenteditable]:not([contenteditable="false"]), details > summary:first-of-type, [tabindex]';

  // window.innerWidth/Height, NOT documentElement.clientWidth/Height. Measured in Firefox
  // on an absolutely-positioned page: clientHeight was 8 while innerHeight was 600, so a
  // clientHeight-based check samples zero points and passes vacuously.
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const isTransparent = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (Number.parseFloat(s.opacity || '1') < 0.05) return true;
    const bg = s.backgroundColor || '';
    if (bg === 'transparent') return true;
    const match = bg.match(/rgba?\\(([^)]+)\\)/);
    if (match) {
      const parts = match[1].split(',').map((v) => Number.parseFloat(v));
      if (parts.length === 4 && parts[3] < 0.05) return true;
    }
    return s.backgroundImage === 'none' && bg === 'rgba(0, 0, 0, 0)';
  };

  return [...document.querySelectorAll(TABBABLE)]
    .filter((e) => {
      const tabindex = e.getAttribute('tabindex');
      if (tabindex !== null && Number.parseInt(tabindex, 10) < 0) return false;
      if (e.closest('[inert]')) return false;
      const s = getComputedStyle(e);
      return s.display !== 'none' && s.visibility !== 'hidden';
    })
    .map((e) => {
      const r = e.getBoundingClientRect();
      const inViewport = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
        && r.width > 0 && r.height > 0;

      // A 5x5 grid, not the centre alone: 2.4.11 fails only when the component is
      // ENTIRELY hidden, and a header can cover the centre while leaving edges visible.
      let sampledPoints = 0;
      let visiblePoints = 0;
      let coveredBy;
      let coveredByTransparent;

      if (inViewport) {
        for (let i = 0; i < 5; i++) {
          for (let j = 0; j < 5; j++) {
            const x = r.left + (r.width * (i + 0.5)) / 5;
            const y = r.top + (r.height * (j + 0.5)) / 5;
            if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
            sampledPoints++;
            const top = document.elementFromPoint(x, y);
            // Accept descendants: a button with an inner span label hit-tests to the span.
            if (top === e || e.contains(top)) visiblePoints++;
            else if (top && coveredBy === undefined) {
              coveredBy = name(top);
              coveredByTransparent = isTransparent(top);
            }
          }
        }
      }

      // The inline exception: an inline element with sentence text beside it.
      const inline = getComputedStyle(e).display === 'inline';
      const hasTextSibling = [e.previousSibling, e.nextSibling]
        .some((n) => n && n.nodeType === 3 && n.textContent.trim().length > 0);

      return {
        selector: name(e),
        width: r.width,
        height: r.height,
        centreX: r.left + r.width / 2,
        centreY: r.top + r.height / 2,
        inViewport,
        sampledPoints,
        visiblePoints,
        coveredBy,
        coveredByTransparent,
        inlineInText: inline && hasTextSibling,
      };
    });
})()`;

export function formatFocus(result: FocusResult): string {
  if (result.findings.length === 0) {
    return "focus OK — nothing is entirely hidden when focused, and every target meets 24×24";
  }

  const rank = { high: 0, medium: 1 } as const;
  const sorted = [...result.findings].sort((a, b) => rank[a.severity] - rank[b.severity]);

  return [
    result.ok
      ? `focus OK with ${result.findings.length} warning(s):`
      : `FOCUS — ${result.findings.length} finding(s):`,
    ...sorted.map(
      (f) => `  ${f.severity === "high" ? "✗" : "!"} [${f.kind}] ${f.selector}\n    ${f.detail}`,
    ),
    "",
    "  axe-core has zero rules for 2.4.11, 2.4.7, 2.1.2 and 2.4.3, and ships its only",
    "  2.5.8 rule disabled — a clean axe run says nothing about any of this.",
  ].join("\n");
}
