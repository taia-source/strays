/**
 * Rendering correctness — defects that are visible to a person but invisible to every
 * check we had, and that do NOT require a screenshot baseline to find.
 *
 * ══ Why this exists rather than screenshot diffing ══
 *
 * The question was whether pixel-diffing is needed for full coverage. The way to answer
 * it is to enumerate what a screenshot would catch and ask which parts are reachable from
 * the DOM. Measured against a deliberately broken page, four were:
 *
 *   brokenImage:          { complete: true, naturalWidth: 0 }   ← renders as a broken icon
 *   textSpillsOutOfBox:   true                                  ← text escaping its border
 *   collapsedContainer:   height 2px                            ← float collapse
 *   twoTextBlocksOverlap: true                                  ← text on top of text
 *
 * All four are ordinary, high-frequency defects. All four are detectable exactly and
 * deterministically, with no baseline to maintain and no false positives from a
 * legitimate redesign — which is precisely the failure mode that makes screenshot
 * baselines expensive against agent-generated UI that changes every build.
 *
 * ══ The hard part: overlap detection is a false-positive machine ══
 *
 * The naive check — do two bounding boxes intersect — is worse than useless. Measured on
 * a page with entirely NORMAL layout:
 *
 *   badgeOverlapsCard:       true     ← a "NEW" badge sitting on its card. Correct design.
 *   modalOverlapsEverything: true     ← a modal overlay. That is its whole job.
 *
 * A checker firing on those gets deleted in a day. So collision is decided by
 * **hit-testing**, not intersection. Measured on the same page:
 *
 *   badge → hits 'badge'   (itself — legitimate layering)
 *   title → hits 'title'   (itself)
 *   t1    → hits 't2'      (a DIFFERENT text-bearing element — a real collision)
 *
 * An element whose own text area resolves to some other text-bearing element is covered.
 * A badge deliberately stacked on a card is not, because it hit-tests to itself.
 *
 * ══ What still needs a human, honestly ══
 *
 * This does not judge whether a design is *ugly*, whether brand colours are right, or
 * whether spacing is tasteful. Nothing automated does. It catches the class of defect
 * where the page is objectively broken rather than merely unattractive.
 */

export type RenderingDefect =
  | "broken-image"
  | "text-collision"
  | "content-spill"
  | "collapsed-container";

export type RenderingFinding = {
  readonly kind: RenderingDefect;
  readonly selector: string;
  readonly detail: string;
};

export type RenderingObservation = {
  readonly brokenImages: ReadonlyArray<{
    readonly selector: string;
    readonly src: string;
    readonly alt: string;
  }>;
  readonly collisions: ReadonlyArray<{ readonly selector: string; readonly coveredBy: string }>;
  readonly spills: ReadonlyArray<{ readonly selector: string; readonly by: number }>;
  readonly collapsed: readonly string[];
};

/**
 * Browser-side collection, injected as a string so the package stays browser-free for
 * unit tests — matching `COLLECT_COLORS_SCRIPT` and `COLLECT_LAYOUT_SCRIPT`.
 *
 * Must run AFTER images have settled; a still-loading image has `naturalWidth === 0` and
 * would be reported as broken. `collectRendering` in a consuming project should await
 * `networkidle` or `document.readyState === 'complete'` first.
 */
export const COLLECT_RENDERING_SCRIPT = `(() => {
  const name = (e) => e.id ? '#' + e.id
    : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' && e.className.trim()
        ? '.' + e.className.trim().split(/\\s+/)[0] : '');

  const isVisible = (e) => {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (Number.parseFloat(s.opacity || '1') < 0.05) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // ── broken images ──────────────────────────────────────────────────────────────
  // complete && naturalWidth === 0 is the exact signature of a failed load. A
  // still-loading image has complete === false, so it is not misreported.
  // alt="" marks a decorative image; a broken decorative image is a much smaller
  // problem than a broken product photo, but it is still a 404 worth surfacing.
  const brokenImages = [...document.querySelectorAll('img')]
    .filter((img) => img.complete && img.naturalWidth === 0 && img.getAttribute('src'))
    .map((img) => ({ selector: name(img), src: img.getAttribute('src') || '', alt: img.alt || '' }));

  // ── text collisions ────────────────────────────────────────────────────────────
  // Hit-test rather than intersect. Only elements that directly own visible text are
  // considered, because a container "covered" by its own child is normal nesting.
  const textBearing = [...document.querySelectorAll('body *')].filter((e) => {
    if (!isVisible(e)) return false;
    if (e.matches('script, style, head, meta, link, title')) return false;
    return [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent && n.textContent.trim());
  });

  const collisions = [];
  for (const el of textBearing) {
    const r = el.getBoundingClientRect();
    // Sample near the start of the text rather than the geometric centre: a wide block
    // whose centre falls in trailing whitespace would hit-test to whatever is behind it.
    const x = r.left + Math.min(20, r.width / 2);
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= document.documentElement.clientWidth || y >= document.documentElement.clientHeight) continue;

    const top = document.elementFromPoint(x, y);
    if (!top || top === el || el.contains(top) || top.contains(el)) continue;
    // Only a collision if the thing on top ALSO carries text. An opaque decorative
    // panel over text is a different (and usually deliberate) situation.
    if (!textBearing.includes(top)) continue;

    // ── the distinction that makes this usable ──
    //
    // A modal, drawer or popover deliberately covers the page beneath it, and the reader
    // is not confused because the overlay is OPAQUE — the covered text is hidden, not
    // jumbled together with it. A genuine collision is two texts rendering on top of
    // each other because the one in front has no background to hide the one behind.
    //
    // Found by the false-positive control: a card's body text under a modal overlay was
    // being reported, which is exactly the noise that gets a checker deleted. The first
    // attempted fix — "ignore a positioned coverer" — suppressed the REAL collision too,
    // because both texts happened to be position:absolute. Opacity of the backdrop is
    // the property that actually separates the two cases.
    let opaqueBackdrop = false;
    for (let n = top; n && n !== document.documentElement; n = n.parentElement) {
      if (n.contains(el)) break;   // a shared ancestor is not an overlay over 'el'
      const bg = getComputedStyle(n).backgroundColor;
      const m = /rgba?\\(([^)]+)\\)/.exec(bg);
      if (m) {
        const parts = m[1].split(',').map((v) => Number.parseFloat(v));
        const alpha = parts.length > 3 ? parts[3] : 1;
        if (alpha >= 0.9) { opaqueBackdrop = true; break; }
      }
    }
    if (opaqueBackdrop) continue;

    collisions.push({ selector: name(el), coveredBy: name(top) });
  }

  // ── content spilling out of its box ────────────────────────────────────────────
  // scrollWidth beyond clientWidth with visible overflow means the content is drawn
  // OUTSIDE the element's border, over whatever is next to it. With overflow:auto or
  // hidden that is a scroll or a clip, both handled elsewhere.
  const spills = [...document.querySelectorAll('body *')]
    .filter((e) => {
      if (!isVisible(e)) return false;
      const s = getComputedStyle(e);
      if (s.overflowX !== 'visible') return false;
      if (!e.textContent || !e.textContent.trim()) return false;
      // Only meaningful where the box has a definite width it can be exceeded.
      return e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0;
    })
    .map((e) => ({ selector: name(e), by: e.scrollWidth - e.clientWidth }));

  // ── collapsed containers ───────────────────────────────────────────────────────
  // A parent that has element children but almost no height: the classic float or
  // absolute-positioning collapse, where a bordered box renders as a thin line.
  const collapsed = [...document.querySelectorAll('body *')]
    .filter((e) => {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (s.position === 'absolute' || s.position === 'fixed') return false;
      const kids = [...e.children].filter((c) => isVisible(c));
      if (kids.length === 0) return false;
      const r = e.getBoundingClientRect();
      if (r.height > 4) return false;
      // Only a defect if a child actually renders taller than the parent that holds it.
      return kids.some((c) => c.getBoundingClientRect().height > r.height + 4);
    })
    .map(name);

  return { brokenImages, collisions, spills, collapsed };
})()`;

export function checkRendering(obs: RenderingObservation): RenderingFinding[] {
  const findings: RenderingFinding[] = [];

  for (const img of obs.brokenImages) {
    findings.push({
      kind: "broken-image",
      selector: img.selector,
      detail:
        `"${img.src}" failed to load and renders as a broken icon` +
        (img.alt ? ` (alt: "${img.alt}")` : " (no alt text, so nothing replaces it visually)"),
    });
  }

  for (const c of obs.collisions) {
    findings.push({
      kind: "text-collision",
      selector: c.selector,
      detail: `its text is covered by ${c.coveredBy}, which also carries text — the two are drawn on top of each other`,
    });
  }

  for (const s of obs.spills) {
    findings.push({
      kind: "content-spill",
      selector: s.selector,
      detail: `content is ${s.by}px wider than its box with overflow:visible, so it is drawn outside the element's bounds`,
    });
  }

  for (const selector of obs.collapsed) {
    findings.push({
      kind: "collapsed-container",
      selector,
      detail:
        "the container has almost no height while its children render taller — the classic float/absolute collapse, which draws a bordered box as a thin line",
    });
  }

  return findings;
}

export type RenderingResult = {
  readonly ok: boolean;
  readonly findings: readonly RenderingFinding[];
};

export function assessRendering(obs: RenderingObservation): RenderingResult {
  const findings = checkRendering(obs);
  return { ok: findings.length === 0, findings };
}

export function formatRendering(result: RenderingResult): string {
  if (result.ok) return "rendering is correct (no broken images, collisions, spills or collapses)";

  const lines = [`RENDERING FAILED — ${result.findings.length} finding(s):`];
  for (const f of result.findings) {
    lines.push(`  ✗ [${f.kind}] ${f.selector}: ${f.detail}`);
  }
  lines.push("");
  lines.push("  Each of these is visible to a person looking at the page, and none of them");
  lines.push("  throws an error or fails an ordinary assertion.");
  return lines.join("\n");
}
