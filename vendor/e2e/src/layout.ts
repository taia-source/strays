/**
 * Responsive layout checking — the failures that only exist at one viewport width.
 *
 * ══ The measurement that forced this to exist ══
 *
 * A page with a fixed-width table, driven through a real Chromium at two sizes:
 *
 *   desktop (1280):  page scrollWidth 1280 vs viewport 1280  → ok
 *   iPhone 14 (390): page scrollWidth  640 vs viewport  390  → HORIZONTAL SCROLL
 *                    overflowing: table, tbody, tr, td
 *
 * **The same page. The same assertions.** A suite that only runs at desktop width reports
 * green on a page that cannot be read on any phone without pinching sideways.
 *
 * The instructive part is what did NOT overflow: a flex row of three 200px cards fits at
 * 390px, because flexbox shrinks it. A fixed-width `<table>` does not. Which of the two a
 * given component is cannot be reasoned about from the markup with any confidence — it
 * depends on the computed style at that width. So this measures rather than predicts.
 *
 * ══ What is checked ══
 *
 *   1. **horizontal overflow** — `scrollWidth > clientWidth` on the document. The single
 *      highest-signal mobile defect, and the one desktop testing structurally cannot see.
 *   2. **tap target size** — WCAG 2.2 §2.5.8 (AA) sets a 24×24 CSS px minimum. A 16px
 *      icon button is unhittable with a thumb and passes every desktop click test,
 *      because a mouse cursor is one pixel.
 *   3. **clipped text** — `scrollWidth > clientWidth` with `overflow: hidden`. Text that
 *      is silently cut off rather than wrapped. Nothing throws; the words are just gone.
 *
 * ══ What this does and does not claim ══
 *
 * This module measures **one engine at several widths**. Cross-engine differences live in
 * `engines.ts`, and the note that used to sit here was wrong in a way worth recording:
 * it claimed Playwright's device descriptors are "Chromium at a phone-sized viewport, not
 * real iOS Safari". Measured, they are not — `iPhone 14` runs **WebKit**, Safari's actual
 * engine, and `Pixel 7` runs Chromium, which is what Android Chrome is. Safari-specific
 * form-control metrics DO reproduce (see `engines.ts`: `<input type="date">` is 39px in
 * WebKit and 135px in Chromium).
 *
 * The one thing genuinely out of reach is **browser chrome**: headless has no URL bar, so
 * `100vh`, `100svh` and `100dvh` measure identical here. A layout that only breaks as the
 * bar collapses will pass. That boundary is asserted in `engines.ts` rather than assumed.
 */

/** A viewport to test at, in CSS pixels. */
export type Viewport = { readonly name: string; readonly width: number; readonly height: number };

/**
 * The default set: the narrowest phone still in real use, a common phone, a tablet, and a
 * laptop. Kept small on purpose — every viewport is a full page load, and four widths
 * spanning 320→1280 catch essentially every breakpoint mistake that six would.
 */
export const DEFAULT_VIEWPORTS: readonly Viewport[] = [
  { name: "mobile-sm", width: 320, height: 568 },
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];

/** WCAG 2.2 §2.5.8 Target Size (Minimum), level AA. */
export const MIN_TAP_TARGET_PX = 24;

/**
 * Minimum share of viewport height the page's own regions must occupy.
 *
 * Set from the measurement that motivated it: a broken deployed page put its entire
 * interface in **15%** of the viewport, while a correct render of the same page used 62%.
 * 35% sits well clear of both — high enough to catch a crushed layout, low enough that a
 * deliberately sparse page (a splash screen, a single centred prompt) is not accused.
 *
 * A threshold this side of the gap is the point: tightening it toward 60% would start
 * failing designs that are simply airy, which is how a check gets disabled.
 */
export const MIN_LANDMARK_SHARE = 35;

/**
 * Minimum share of viewport height reached by actual painted content.
 *
 * ══ Why this exists alongside MIN_LANDMARK_SHARE ══
 *
 * Measured on the corrected version of the page that motivated these checks:
 * `landmarkShare` read **94%** while the visible interface ended at **70%**, because a
 * `<footer>` was 519px tall holding one line of text at its top. A box that fills its grid
 * row counts as used whether or not anything is drawn in it — so the first check can be
 * fully satisfied by an empty container.
 *
 * Set to 50: a page that stops before the halfway mark has left half the screen blank,
 * which no "one screen" design intends. Deliberately loose — trailing whitespace is a
 * legitimate choice and a checker that demanded 90% would fail every centred layout.
 */
export const MIN_CONTENT_SHARE = 50;

export type LayoutObservation = {
  readonly documentScrollWidth: number;
  readonly viewportWidth: number;
  /** Elements extending past the right edge — the causes of the horizontal scroll. */
  readonly overflowing: readonly string[];
  readonly smallTargets: ReadonlyArray<{
    readonly selector: string;
    readonly width: number;
    readonly height: number;
  }>;
  readonly clippedText: readonly string[];
  /**
   * Full-bleed elements that participate in layout instead of sitting behind it.
   *
   * ══ Measured on a deployed app ══
   *
   * A decorative `<canvas>` was styled `position: fixed`, but a later `.screen > *` rule
   * (specificity 0,1,1 against the canvas's 0,1,0) overrode it to `relative` — so it became
   * a GRID ITEM taking 706px of a 900px viewport and crushed the entire interface into the
   * remaining 170px, labels overlapping their own values.
   *
   * Nine other checks passed on that page: nothing overflowed, because the content was
   * COMPRESSED rather than spilled. And it only broke at desktop width — at 390px the canvas
   * got a small row and the page still read.
   */
  readonly inFlowBackdrops: ReadonlyArray<{
    readonly selector: string;
    readonly position: string;
    /** Share of the viewport's height this element occupies, 0–100. */
    readonly heightShare: number;
  }>;
  /**
   * Share of viewport height occupied by the page's own landmark regions, 0–100.
   *
   * An interface squeezed into a strip renders text, fits the viewport, scrolls nowhere, and
   * is unusable. No other signal here distinguishes that from a deliberately sparse page.
   */
  readonly landmarkShare: number;
  /**
   * Share of viewport height between the top of the page and the LAST PAINTED TEXT, 0–100.
   *
   * ══ Why landmarkShare alone is not enough ══
   *
   * Measured on the fixed version of the page that motivated these checks: `landmarkShare`
   * read 94% while the visible interface ended at 70% of the viewport, because a `<footer>`
   * was 519px tall holding one line of text at its top. A box that fills its grid row counts
   * as "used" whether or not anything is drawn in it.
   *
   * So this measures where content actually STOPS. The two together distinguish a page that
   * fills the screen from one whose empty container does.
   */
  readonly contentShare: number;
  /**
   * Whether the page claims the full viewport height (`100dvh` and friends).
   *
   * `contentShare` is only meaningful when it does. A document-flow page — an article, a
   * form, a test harness — is as tall as its content, and space below it is correct rather
   * than missing. Found by the check firing on a fixture with one heading and one button.
   */
  readonly claimsViewport: boolean;
};

/**
 * Browser-side collection. Injected as a string so this package needs no browser to be
 * unit-tested, matching how `COLLECT_COLORS_SCRIPT` works in `contrast.ts`.
 *
 * The `+ 1` tolerances are deliberate: sub-pixel layout rounding routinely produces
 * differences of a fraction of a pixel, and a checker that fires on 0.5px gets disabled.
 */
export const COLLECT_LAYOUT_SCRIPT = `(() => {
  const de = document.documentElement;
  const viewportWidth = de.clientWidth;
  const name = (e) => e.id ? '#' + e.id
    : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' && e.className.trim()
        ? '.' + e.className.trim().split(/\\s+/)[0] : '');

  const visible = [...document.querySelectorAll('*')].filter((e) => {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  // Elements crossing the right edge. Deduped: one overflowing table reports its tbody,
  // tr and td too, and four names for one bug is noise.
  const overflowing = [...new Set(
    visible.filter((e) => e.getBoundingClientRect().right > viewportWidth + 1).map(name)
  )];

  const smallTargets = visible
    .filter((e) => e.matches('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link]'))
    .map((e) => { const r = e.getBoundingClientRect(); return { selector: name(e), width: r.width, height: r.height }; })
    .filter((t) => t.width < ${MIN_TAP_TARGET_PX} || t.height < ${MIN_TAP_TARGET_PX});

  const clippedText = [...new Set(
    visible.filter((e) => {
      const s = getComputedStyle(e);
      if (s.overflow !== 'hidden' && s.overflowX !== 'hidden') return false;
      if (!e.textContent || !e.textContent.trim()) return false;
      return e.scrollWidth > e.clientWidth + 1;
    }).map(name)
  )];

  // A backdrop is anything covering most of the viewport in BOTH axes. Such an element is
  // either positioned out of flow or it is displacing everything else — there is no third
  // case, which is what makes this checkable without knowing the design.
  const viewportHeight = de.clientHeight;
  const inFlowBackdrops = visible
    .filter((e) => {
      const s = getComputedStyle(e);
      if (s.position === 'fixed' || s.position === 'absolute') return false;
      const r = e.getBoundingClientRect();
      // Landmarks and their containers legitimately fill the screen; a backdrop is a leaf.
      if (e.children.length > 0) return false;
      if (e.textContent && e.textContent.trim()) return false;
      return r.width >= viewportWidth * 0.9 && r.height >= viewportHeight * 0.5;
    })
    .map((e) => {
      const r = e.getBoundingClientRect();
      return {
        selector: name(e),
        position: getComputedStyle(e).position,
        heightShare: Math.round((r.height / viewportHeight) * 100),
      };
    });

  const landmarks = [...document.querySelectorAll('header, footer, main > section, nav, main > article')];
  const landmarkShare = landmarks.length === 0 ? 100 : Math.round(
    (landmarks.reduce((sum, e) => sum + e.getBoundingClientRect().height, 0) / viewportHeight) * 100
  );

  /**
   * Where the last painted text ends.
   *
   * Measured with a Range over each leaf's text nodes rather than the element's own box: a
   * stretched element holding one line at its top has a box reaching the bottom of the
   * screen, and crediting that box is exactly the mistake this check exists to catch. A
   * 519px-tall footer with one line of text must count as one line.
   */
  // The CANVAS exclusion is belt-and-braces and known to be so: sabotage showed removing it
  // changes nothing, because a canvas has no textContent and the next clause drops it. Kept
  // for the reader — "a backdrop is not content" is the rule, and stating it beats implying
  // it through a text check.
  const textBottoms = visible
    .filter((e) => e.tagName !== 'CANVAS' && e.children.length === 0 && (e.textContent || '').trim())
    .map((e) => {
      const range = document.createRange();
      range.selectNodeContents(e);
      const rects = [...range.getClientRects()];
      range.detach();
      return rects.length === 0
        ? e.getBoundingClientRect().bottom
        : Math.max(...rects.map((r) => r.bottom));
    });
  const contentShare = textBottoms.length === 0 ? 0 : Math.round(
    (Math.max(...textBottoms) / viewportHeight) * 100
  );

  /**
   * Whether the page CLAIMS the whole viewport.
   *
   * A document-flow page — an ordinary article, a form, a test harness — is as tall as its
   * content and leaving space below is correct. Only a page that has taken the full viewport
   * height has promised to fill it, and only that page can be accused of leaving it blank.
   *
   * Found by this check firing on an existing test's fixture: a page with one heading and
   * one button, genuinely 20% filled, and entirely fine.
   */
  const claimsViewport = [de, document.body, ...de.querySelectorAll('body > *')].some((e) => {
    if (!(e instanceof Element)) return false;
    const s = getComputedStyle(e);
    if (s.position === 'fixed') return false;
    const h = e.getBoundingClientRect().height;
    return h >= viewportHeight * 0.95 && (s.height.endsWith('vh') || s.height.endsWith('dvh') || h >= viewportHeight);
  });

  return { documentScrollWidth: de.scrollWidth, viewportWidth, overflowing, smallTargets, clippedText, inFlowBackdrops, landmarkShare, contentShare, claimsViewport };
})()`;

export type LayoutFinding = {
  readonly viewport: string;
  readonly kind:
    | "horizontal-overflow"
    | "tap-target"
    | "clipped-text"
    | "backdrop-in-flow"
    | "squeezed";
  /** Stated so someone can act on it, never a bare rule id. */
  readonly detail: string;
};

/**
 * Judge one viewport's observation.
 *
 * Horizontal overflow is reported once for the page, with the culprits listed — not once
 * per element. The bug is "this page scrolls sideways"; the elements are its evidence.
 */
export function checkLayout(viewport: Viewport, obs: LayoutObservation): LayoutFinding[] {
  const findings: LayoutFinding[] = [];

  if (obs.documentScrollWidth > obs.viewportWidth + 1) {
    const by = obs.documentScrollWidth - obs.viewportWidth;
    findings.push({
      viewport: viewport.name,
      kind: "horizontal-overflow",
      detail:
        `the page is ${obs.documentScrollWidth}px wide in a ${obs.viewportWidth}px viewport ` +
        `(${by}px too wide), so it scrolls sideways` +
        (obs.overflowing.length > 0 ? ` — caused by: ${obs.overflowing.join(", ")}` : ""),
    });
  }

  for (const t of obs.smallTargets) {
    findings.push({
      viewport: viewport.name,
      kind: "tap-target",
      detail:
        `${t.selector} is ${Math.round(t.width)}×${Math.round(t.height)}px, below the ` +
        `${MIN_TAP_TARGET_PX}×${MIN_TAP_TARGET_PX} minimum (WCAG 2.2 §2.5.8) — a mouse hits ` +
        `it, a thumb does not`,
    });
  }

  for (const selector of obs.clippedText) {
    findings.push({
      viewport: viewport.name,
      kind: "clipped-text",
      detail: `${selector} has text wider than its box with overflow:hidden — it is silently cut off, not wrapped`,
    });
  }

  for (const backdrop of obs.inFlowBackdrops) {
    findings.push({
      viewport: viewport.name,
      kind: "backdrop-in-flow",
      detail:
        `${backdrop.selector} covers ${backdrop.heightShare}% of the viewport with ` +
        `position:${backdrop.position}, so it DISPLACES the interface instead of sitting ` +
        "behind it. A later rule has probably overridden its position — check for a " +
        "descendant selector like `.parent > *`, which outranks a single class",
    });
  }

  /**
   * Reported only when there are landmarks to measure. A page with none returns 100 from the
   * collector, so a document that has not adopted landmarks is never accused of being
   * squeezed — this checks layout, not semantics.
   */
  if (obs.landmarkShare < MIN_LANDMARK_SHARE) {
    findings.push({
      viewport: viewport.name,
      kind: "squeezed",
      detail:
        `the page's own regions occupy ${obs.landmarkShare}% of the viewport height, below ` +
        `${MIN_LANDMARK_SHARE}% — the interface is compressed into a strip. It renders, it ` +
        "fits, and nothing overflows, which is why every other check here passes",
    });
  }

  /**
   * Checked independently of `landmarkShare`, because the two disagree exactly where it
   * matters: a tall empty container satisfies the first and fails this one, which is the
   * case that was measured.
   */
  if (obs.claimsViewport && obs.contentShare < MIN_CONTENT_SHARE) {
    findings.push({
      viewport: viewport.name,
      kind: "squeezed",
      detail:
        `painted content stops at ${obs.contentShare}% of the viewport height, leaving the ` +
        `bottom ${100 - obs.contentShare}% blank. Note the landmark regions may still ` +
        `measure ${obs.landmarkShare}% — a container that fills its row counts as used ` +
        "whether or not anything is drawn in it",
    });
  }

  return findings;
}

export type LayoutResult = {
  readonly ok: boolean;
  readonly findings: readonly LayoutFinding[];
  readonly viewportsChecked: readonly string[];
};

export function assessLayout(
  observations: ReadonlyArray<{
    readonly viewport: Viewport;
    readonly observation: LayoutObservation;
  }>,
): LayoutResult {
  const findings = observations.flatMap((o) => checkLayout(o.viewport, o.observation));
  return {
    ok: findings.length === 0,
    findings,
    viewportsChecked: observations.map((o) => o.viewport.name),
  };
}

export function formatLayout(result: LayoutResult): string {
  if (result.ok) {
    return `layout passed at all ${result.viewportsChecked.length} viewports (${result.viewportsChecked.join(", ")})`;
  }

  const lines = [`LAYOUT FAILED — ${result.findings.length} finding(s):`];
  for (const viewport of result.viewportsChecked) {
    const at = result.findings.filter((f) => f.viewport === viewport);
    if (at.length === 0) continue;
    lines.push(`  ${viewport}:`);
    lines.push(...at.map((f) => `    ✗ [${f.kind}] ${f.detail}`));
  }

  // The point worth making loudest: a green desktop run proves nothing about a phone.
  const mobileOnly = result.findings.some((f) => f.viewport.startsWith("mobile"));
  const desktopClean = !result.findings.some((f) => f.viewport === "desktop");
  if (mobileOnly && desktopClean) {
    lines.push("");
    lines.push("  Every one of these is invisible at desktop width. Measured, not assumed:");
    lines.push("  a fixed-width table is 1280/1280 (fine) and 640/390 (broken) on one page.");
  }
  return lines.join("\n");
}
