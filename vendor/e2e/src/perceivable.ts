/**
 * Whether an element is actually **perceivable by a human**, which is not what Playwright
 * (or the DOM) means by "visible".
 *
 * ══ The measurement that forced this to exist ══
 *
 * Four elements, all broken in different ways, in a real Chromium at 390×844:
 *
 *   a-off     isVisible()=true   NOT clickable    position:absolute; left:-9999px
 *   a-zero    isVisible()=true   NOT clickable    opacity:0
 *   a-clip    isVisible()=true   NOT clickable    clip-path:inset(100%)
 *   a-behind  isVisible()=true   NOT clickable    covered by an opaque overlay
 *
 * **Playwright reports all four as visible.** Its definition is "has a non-empty bounding
 * box and no `visibility:hidden`" — which is true of an element parked 9,999px off the
 * left edge, or one at zero opacity, or one entirely behind a cookie banner.
 *
 * This matters because `runner.ts`'s `expectVisible` step is exactly
 * `waitFor({ state: "visible" })`. A generated project could assert "the success message
 * is visible", pass, and ship a page where that message is off-screen. The assertion that
 * was supposed to prove the UI works is the one lying.
 *
 * ══ What is NOT a gap, verified rather than assumed ══
 *
 * **Occlusion of things we click is already covered.** Playwright's `click()` runs
 * actionability checks and hit-tests the centre point; against a button under a fixed
 * banner it timed out rather than passing:
 *
 *   topElementAtCentre: 'banner'   reachable: false
 *   playwright click(): FAILED — page.click: Timeout 3000ms exceeded
 *
 * So this module deliberately does not re-implement click safety. It closes the
 * **assertion** hole — `expectVisible` — not the interaction one.
 *
 * ══ The definition used here ══
 *
 * An element is perceivable when it is in the viewport, has real opacity, is not clipped
 * away, and its centre actually hit-tests to itself. That last check is the one that
 * subsumes most of the others, because `elementFromPoint` is the browser answering
 * "what would a person's finger land on".
 */

/** Why an element a test called "visible" is not perceivable. */
export type PerceivableFailure =
  | "offscreen"
  | "zero-opacity"
  | "clipped-away"
  | "occluded"
  | "zero-size"
  | "display-none";

export type PerceivableObservation = {
  readonly selector: string;
  readonly perceivable: boolean;
  readonly failures: readonly PerceivableFailure[];
  /** What `elementFromPoint` returned at the element's centre — the occluder, when occluded. */
  readonly topElementAtCentre?: string;
  readonly detail: string;
};

/**
 * The check itself, as a browser-side function of `(el, selector)`.
 *
 * Kept as a bare function expression so both entry points below can embed it without the
 * logic existing twice — one takes a CSS selector, the other an already-resolved element
 * from a Playwright locator, and a second copy of this would drift.
 */
const PERCEIVABLE_BODY = `((el, selector) => {
  if (!el) {
    return { selector, perceivable: false, failures: ['display-none'],
             detail: 'no element matches ' + selector };
  }

  const failures = [];
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  if (s.display === 'none' || s.visibility === 'hidden') failures.push('display-none');
  if (r.width < 1 || r.height < 1) failures.push('zero-size');

  // Effective opacity: a parent at opacity 0 hides the child, and the child's own
  // computed style still reports 1. Walk the ancestor chain.
  let opacity = 1, node = el;
  while (node && node !== document.documentElement) {
    opacity *= Number.parseFloat(getComputedStyle(node).opacity || '1');
    node = node.parentElement;
  }
  if (opacity < 0.05) failures.push('zero-opacity');

  // Entirely outside the viewport. Partially-scrolled-out is NOT a failure: content
  // below the fold is normal, and flagging it would make this unusable.
  if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) failures.push('offscreen');

  // clip-path / clip that removes the box without changing its rect.
  const clipped = (s.clipPath && s.clipPath !== 'none' && /inset\\(\\s*(100%|50%\\s+50%)/.test(s.clipPath))
    || (s.clip && /rect\\(\\s*0(px)?[, ]+0(px)?[, ]+0(px)?[, ]+0(px)?\\s*\\)/.test(s.clip));
  if (clipped) failures.push('clipped-away');

  // The decisive test: does the centre point actually hit this element? This is the
  // browser answering "what would a finger land on here". Only meaningful if the
  // element is on screen at all, so it is skipped when already offscreen.
  let topElementAtCentre;
  if (!failures.includes('offscreen') && !failures.includes('zero-size')) {
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    const top = document.elementFromPoint(cx, cy);
    if (top) {
      topElementAtCentre = top.id ? '#' + top.id
        : top.tagName.toLowerCase() + (top.className && typeof top.className === 'string' && top.className.trim()
            ? '.' + top.className.trim().split(/\\s+/)[0] : '');
    }
    // Covered when the hit element is neither this element, nor inside it, nor an
    // ancestor of it (a label wrapping an input legitimately hit-tests to the label).
    const covered = !top || (top !== el && !el.contains(top) && !top.contains(el));
    if (covered) failures.push('occluded');
  }

  return { selector, perceivable: failures.length === 0, failures, topElementAtCentre, detail: '' };
})`;

/**
 * Entry point taking a **CSS selector**, for `page.evaluate`.
 *
 * Injected as a string so this package needs no browser to be unit-tested — the same
 * shape as `COLLECT_COLORS_SCRIPT` and `COLLECT_LAYOUT_SCRIPT`.
 */
export const PERCEIVABLE_SCRIPT = `((selector) => (${PERCEIVABLE_BODY})(document.querySelector(selector), selector))`;

/**
 * Entry point that finds the element **by accessible role and name**, for `page.evaluate`.
 *
 * `runner.ts` targets by role and name, never CSS, so it has no selector to pass. The
 * element must be re-found inside the page because Playwright's string-form scripts
 * cannot receive an element argument — measured: `locator.evaluate(str)`,
 * `handle.evaluate(str)` and `page.evaluate(str, handle)` all return `undefined`.
 *
 * The name match mirrors how Playwright resolves an accessible name closely enough for
 * this purpose: `aria-label`, then `aria-labelledby`, then trimmed text content.
 */
export function perceivableByRoleScript(role: string, name: string): string {
  return `(() => {
  const wanted = ${JSON.stringify(name)};
  const role = ${JSON.stringify(role)};
  const accName = (el) => {
    const label = el.getAttribute('aria-label');
    if (label) return label.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const ref = document.getElementById(by);
      if (ref) return (ref.textContent || '').trim();
    }
    return (el.textContent || '').trim();
  };
  const candidates = [...document.querySelectorAll('[role=' + JSON.stringify(role) + ']')];
  const el = candidates.find((c) => accName(c) === wanted) || null;
  return (${PERCEIVABLE_BODY})(el, role + ' "' + wanted + '"');
})()`;
}

/** Turn the raw failure list into something a person can act on. */
export function describeFailures(obs: {
  readonly selector: string;
  readonly failures: readonly PerceivableFailure[];
  readonly topElementAtCentre?: string | undefined;
}): string {
  if (obs.failures.length === 0) return `${obs.selector} is perceivable`;

  // A record rather than a switch: `Record<PerceivableFailure, …>` makes adding a failure
  // kind without a description a compile error, and leaves no branch that returns nothing.
  const REASONS: Record<PerceivableFailure, string> = {
    offscreen:
      "positioned entirely outside the viewport — a common way to hide something without removing it",
    "zero-opacity": "at zero effective opacity (its own, or an ancestor's)",
    "clipped-away": "clipped away by clip-path/clip while keeping its bounding box",
    occluded: `covered by ${obs.topElementAtCentre ?? "another element"} at its centre point`,
    "zero-size": "zero-sized",
    "display-none": "not rendered at all",
  };
  const parts = obs.failures.map((f) => REASONS[f]);

  return (
    `${obs.selector} is NOT perceivable: ${parts.join("; ")}. ` +
    `Playwright's isVisible() returns true for every one of these — measured, not assumed.`
  );
}

export type PerceivableResult = {
  readonly ok: boolean;
  readonly observations: readonly PerceivableObservation[];
  readonly failed: readonly PerceivableObservation[];
};

export function assessPerceivable(
  raw: ReadonlyArray<Omit<PerceivableObservation, "detail">>,
): PerceivableResult {
  const observations = raw.map((o) => ({ ...o, detail: describeFailures(o) }));
  const failed = observations.filter((o) => !o.perceivable);
  return { ok: failed.length === 0, observations, failed };
}

export function formatPerceivable(result: PerceivableResult): string {
  if (result.ok) {
    return `all ${result.observations.length} asserted element(s) are genuinely perceivable`;
  }
  return [
    `PERCEIVABILITY FAILED — ${result.failed.length} element(s) a test called "visible":`,
    ...result.failed.map((o) => `  ✗ ${o.detail}`),
    "",
    '  "visible" in Playwright means "has a box and is not visibility:hidden". It does',
    "  not mean a human can see it. An expectVisible assertion on any of the above",
    "  passes while the user sees nothing.",
  ].join("\n");
}
