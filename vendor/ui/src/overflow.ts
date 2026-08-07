/**
 * Text that is clipped, spilling, or scrolling the page sideways.
 *
 * ══ Nothing ships this ══
 *
 * axe-core 4.12.1 has **no overflow or truncation rule** — 105 rules, none measuring
 * `scrollWidth` against `clientWidth`. stylelint and `eslint-plugin-jsx-a11y` are static
 * analysers with no layout engine, so this is architecturally out of scope for them. The
 * npm packages one would guess at (`overflow-detect`, `text-overflow-detect`,
 * `stylelint-no-overflow`) do not exist. The only prior art is screenshot diffing, which
 * needs a human-approved baseline and is therefore useless for a UI generated once.
 *
 * ══ Two premises I held that measurement refuted ══
 *
 * **1. "`scrollWidth` is integer-rounded while `clientWidth` is fractional."** False. Both
 * are integers; `getBoundingClientRect()` is the fractional one. Measured on a real
 * element:
 *
 *     scrollW: 44   clientW: 43   rectW: 43.25   textW: 43.59
 *
 * The real rounding hazard comes from *text* advance widths, which are fractional and
 * round independently. True overflow above is **0.34px** — invisible — yet `delta === 1`.
 * Across a 70-case sweep every `delta === 1` corresponded to 0.34–1.31px of true overflow,
 * while genuine defects measured 33–490px. So `delta === 1` carries no information and
 * {@link MIN_OVERFLOW_PX} is 2.
 *
 * **2. "`body { overflow: hidden }` makes `documentElement.scrollWidth` lie."** Also
 * false, and the actual trap is worse. Measured: with a wide child and `body` hidden, the
 * metric correctly reported 1500 against 800 **and the page still scrolled**. The genuine
 * unsoundness is a *false negative* elsewhere —
 *
 *     absolutely-positioned element at left:900px, viewport 800
 *     documentElement.scrollWidth: 800   clientWidth: 800   delta: 0
 *     actual maxScrollX:           400   ← the page really scrolls sideways
 *
 * A `scrollWidth` check reports a clean page. That is why {@link assessPageOverflow} takes
 * a **measured scroll probe** rather than deriving the answer from geometry: attempting the
 * scroll is ground truth, and no metric substitutes for it.
 *
 * ══ Why a naive sweep gets deleted ══
 *
 * Run bare `scrollWidth > clientWidth` over a realistic page and Firefox returns 14 hits
 * of which 12 are false. The filters below were each derived from a measured false
 * positive:
 *
 *     .sr-only        1×1px, clip: rect(0,0,0,0)   delta 96   ← on nearly every real page
 *     carousel        overflow-x: auto             delta 308  ← intentional by definition
 *     inline/table    Firefox only                 delta 1    ← removed by the 2px floor
 *
 * ══ Intent is readable, and it decides severity ══
 *
 * The geometry cannot tell an intentional ellipsis from an accident — measured, they are
 * identical. The *computed style* can: `text-overflow: ellipsis` and `-webkit-line-clamp`
 * are only ever set deliberately and default to `clip`/`none`. So an author who opted into
 * truncation gets a low-severity note, and text cut off with **no visual affordance at
 * all** — the case that is nearly always a bug — is reported properly.
 */

export type OverflowObservation = {
  readonly selector: string;
  /** `scrollWidth - clientWidth`. Both are integers — see the module docstring. */
  readonly overflowX: number;
  readonly overflowY: number;
  /** Computed `overflow-x`. `auto`/`scroll` means a deliberate scroll container. */
  readonly computedOverflowX: string;
  readonly computedOverflowY: string;
  /** Computed `text-overflow`. `ellipsis` is an explicit opt-in to truncation. */
  readonly textOverflow: string;
  /** Computed `-webkit-line-clamp`. Anything but `none` is a deliberate clamp. */
  readonly lineClamp: string;
  /** Whether the element owns visible text directly, rather than via a child. */
  readonly ownsText: boolean;
  /** Set when the element matches the visually-hidden pattern. */
  readonly visuallyHidden: boolean;
  readonly width: number;
  readonly height: number;
  /** How far the content's own box extends past the element's right edge, if measured. */
  readonly spillPx?: number | undefined;
};

/** A measured attempt to scroll the page, rather than a metric derived from geometry. */
export type PageScrollProbe = {
  /** Furthest the page could actually be scrolled horizontally. */
  readonly maxScrollX: number;
  /** `innerWidth - documentElement.clientWidth`. Zero with overlay scrollbars. */
  readonly scrollbarWidth: number;
  /** Whether a `width=device-width` viewport meta is present. */
  readonly hasViewportMeta: boolean;
};

export type OverflowDefect =
  | "clipped-without-indicator"
  | "clipped-with-ellipsis"
  | "content-spills"
  | "page-scrolls-sideways"
  | "missing-viewport-meta";

export type OverflowFinding = {
  readonly kind: OverflowDefect;
  readonly selector: string;
  readonly detail: string;
  readonly severity: "high" | "medium" | "low";
};

/**
 * Smallest overflow worth reporting, in pixels.
 *
 * Two, not one. Measured across 70 label/width combinations, every `delta === 1` case
 * corresponded to between 0.34px and 1.31px of true overflow — never visible — because
 * text advance widths are fractional and round independently of the container. Real
 * defects in the same sweep measured 33px and up. A threshold of 1 produces false
 * positives in all three engines and removes nothing real.
 */
export const MIN_OVERFLOW_PX = 2;

/**
 * Judge one element.
 *
 * The order matters: every exclusion below was derived from a measured false positive, and
 * skipping one puts the check back into the range where a developer switches it off.
 */
export function assessElementOverflow(o: OverflowObservation): readonly OverflowFinding[] {
  // A zero-area element cannot visibly clip anything.
  if (o.width <= 0 || o.height <= 0) return [];

  /**
   * The visually-hidden pattern is *definitionally* clipped text — a 1×1px box with
   * `clip: rect(0,0,0,0)` or `clip-path: inset(50%)`, holding a skip link or a screen-
   * reader label. Measured at delta 96 and 43 on a bare test page, and it appears on
   * nearly every real site. It survives every other filter, so it must be excluded by
   * name or this check reports a false positive on essentially every page.
   */
  if (o.visuallyHidden) return [];

  // A wrapper whose child overflows is not itself the defect; reporting both sends
  // someone to edit the wrong element.
  if (!o.ownsText) return [];

  const findings: OverflowFinding[] = [];
  const worst = Math.max(o.overflowX, o.overflowY);

  /**
   * A deliberate scroll container — a carousel, a code block, a wide table. Intentional by
   * definition, and the single largest source of false positives: measured at delta 308 on
   * a carousel that works exactly as designed.
   */
  const isScrollContainer = (value: string) => value === "auto" || value === "scroll";
  if (isScrollContainer(o.computedOverflowX) || isScrollContainer(o.computedOverflowY)) {
    return [];
  }

  /**
   * `overflow: visible` clips nothing — the text renders in full and spills over whatever
   * is beside it. That is a different defect from clipping and needs a different fix, so
   * it must not be reported as truncation.
   */
  if (o.computedOverflowX === "visible" && o.computedOverflowY === "visible") {
    if (o.spillPx !== undefined && o.spillPx >= MIN_OVERFLOW_PX) {
      findings.push({
        kind: "content-spills",
        selector: o.selector,
        severity: "medium",
        detail:
          `content extends ${Math.round(o.spillPx)}px past its container, which does not clip ` +
          "(overflow: visible). Nothing is cut off — the text renders over whatever sits " +
          "beside it. Whether that is harmless or unreadable depends on the neighbours",
      });
    }
    return findings;
  }

  if (worst < MIN_OVERFLOW_PX) return findings;

  /**
   * A deliberate clamp. `-webkit-line-clamp` is laborious to set by accident, so this is
   * an author opting into truncation — worth noting, not worth blocking.
   *
   * Note the unprefixed `line-clamp` was measured as **doing nothing** in all three
   * engines: computed `none`, no clamping. A codebase that migrated to the standard
   * property has a clamp that silently is not working, which is why the collector reads
   * the prefixed form.
   */
  if (o.lineClamp !== "none" && o.lineClamp !== "") {
    findings.push({
      kind: "clipped-with-ellipsis",
      selector: o.selector,
      severity: "low",
      detail:
        `text is clamped to ${o.lineClamp} line(s), hiding ${Math.round(o.overflowY)}px. That is ` +
        "a deliberate choice, so this is a note rather than a defect — but the hidden text is " +
        "unreachable, so check that nothing essential lives there",
    });
    return findings;
  }

  /**
   * The high-value case: text cut off with **no visual affordance**. No ellipsis, no
   * clamp, no scrollbar — the sentence simply stops. Measured as `overflow: hidden`,
   * `text-overflow: clip`, delta 33. This is nearly always a real defect.
   */
  if (o.textOverflow !== "ellipsis") {
    findings.push({
      kind: "clipped-without-indicator",
      selector: o.selector,
      severity: "high",
      detail:
        `${Math.round(worst)}px of content is clipped with no ellipsis, no clamp and no ` +
        "scrollbar — the text simply stops, with nothing to tell a reader that more exists. " +
        "Either give it room, or opt into truncation with text-overflow: ellipsis so the cut " +
        "is at least visible",
    });
    return findings;
  }

  /**
   * An ellipsis is an explicit opt-in, so the author anticipated truncation. It is still
   * worth surfacing: a designed ellipsis and an accidentally-too-long string are
   * indistinguishable geometrically, and only a human knows which this is.
   */
  findings.push({
    kind: "clipped-with-ellipsis",
    selector: o.selector,
    severity: "low",
    detail:
      `${Math.round(worst)}px is truncated with an ellipsis. The author opted into this, so it ` +
      "is a note rather than a defect — but a designed ellipsis and an accidentally-long " +
      "string look identical here, so confirm the full text is reachable some other way",
  });

  return findings;
}

/**
 * Judge the page as a whole.
 *
 * Takes a **measured** scroll probe rather than deriving the answer from `scrollWidth`,
 * because that derivation is unsound. Measured: an absolutely-positioned element at
 * `left: 900px` on an 800px viewport gives `documentElement.scrollWidth === clientWidth`
 * — delta 0, a clean bill of health — while the page really scrolls 400px sideways.
 * Attempting the scroll is the only ground truth.
 */
export function assessPageOverflow(probe: PageScrollProbe): readonly OverflowFinding[] {
  const findings: OverflowFinding[] = [];

  if (!probe.hasViewportMeta) {
    findings.push({
      kind: "missing-viewport-meta",
      selector: "head",
      severity: "high",
      detail:
        "no <meta name=viewport content='width=device-width'>. A mobile browser then " +
        "assumes a ~980px desktop viewport and scales the page down, so every responsive " +
        "breakpoint is wrong and every width measured here is meaningless",
    });
  }

  if (probe.maxScrollX >= MIN_OVERFLOW_PX) {
    findings.push({
      kind: "page-scrolls-sideways",
      selector: "document",
      severity: "high",
      detail:
        `the page scrolls ${probe.maxScrollX}px horizontally. Measured by attempting the ` +
        "scroll, not by comparing scrollWidth — an absolutely-positioned element off the " +
        "right edge produces a page that scrolls while scrollWidth reports no overflow at " +
        "all" +
        (probe.scrollbarWidth > 0
          ? `. A classic scrollbar is present (${probe.scrollbarWidth}px), so any element sized ` +
            "100vw overflows by exactly that much — 100vw counts the scrollbar, 100% does not"
          : ""),
    });
  }

  return findings;
}

/**
 * Collect overflow data from a live page.
 *
 * Self-contained: Playwright's string-form `evaluate` cannot close over module scope.
 *
 * The scroll probe restores the original position, so calling this does not leave the page
 * scrolled somewhere a later check would misread.
 */
export const COLLECT_OVERFLOW_SCRIPT = `(() => {
  const name = (e) => e.id ? '#' + e.id
    : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' && e.className.trim()
        ? '.' + e.className.trim().split(/\\s+/)[0] : '');

  // The visually-hidden pattern: a 1-2px box clipped to nothing. Definitionally clipped
  // text, present on nearly every real page, and it survives every other filter.
  const isVisuallyHidden = (e, s, r) => {
    if (r.width > 2 || r.height > 2) return false;
    const clip = s.clip || '';
    const clipPath = s.clipPath || '';
    return clip.replace(/\\s/g, '') === 'rect(0px,0px,0px,0px)'
      || clipPath.startsWith('inset(50%)')
      || clipPath.startsWith('inset(100%)');
  };

  const elements = [...document.querySelectorAll('body *')]
    .filter((e) => {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map((e) => {
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();

      // Owns a non-empty text node directly. A wrapper whose CHILD overflows is not the
      // defect, and reporting it sends someone to edit the wrong element.
      const ownsText = [...e.childNodes]
        .some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);

      // Spill magnitude for a non-clipping element, measured from the content's own box
      // rather than inferred. Only meaningful when overflow is visible.
      let spillPx;
      if (s.overflowX === 'visible' && ownsText) {
        try {
          const range = document.createRange();
          range.selectNodeContents(e);
          spillPx = range.getBoundingClientRect().right - r.right;
        } catch (_) { spillPx = undefined; }
      }

      return {
        selector: name(e),
        overflowX: e.scrollWidth - e.clientWidth,
        overflowY: e.scrollHeight - e.clientHeight,
        computedOverflowX: s.overflowX,
        computedOverflowY: s.overflowY,
        textOverflow: s.textOverflow,
        // The PREFIXED property: the unprefixed line-clamp was measured doing nothing in
        // all three engines, so reading it would miss every real clamp.
        lineClamp: s.webkitLineClamp || 'none',
        ownsText,
        visuallyHidden: isVisuallyHidden(e, s, r),
        width: r.width,
        height: r.height,
        spillPx,
      };
    });

  // Ground truth for page overflow: attempt the scroll, then restore. Geometry alone
  // misses an absolutely-positioned element off the right edge.
  const beforeX = window.scrollX;
  const beforeY = window.scrollY;
  window.scrollTo(999999, beforeY);
  const maxScrollX = window.scrollX;
  window.scrollTo(beforeX, beforeY);

  const meta = document.querySelector('meta[name="viewport"]');

  return {
    elements,
    probe: {
      maxScrollX,
      scrollbarWidth: window.innerWidth - document.documentElement.clientWidth,
      hasViewportMeta: !!meta && /width\\s*=\\s*device-width/i.test(meta.getAttribute('content') || ''),
    },
  };
})()`;

export type OverflowResult = {
  readonly ok: boolean;
  readonly findings: readonly OverflowFinding[];
};

export function checkOverflow(input: {
  readonly elements: readonly OverflowObservation[];
  readonly probe?: PageScrollProbe | undefined;
}): OverflowResult {
  const findings = [
    ...(input.probe ? assessPageOverflow(input.probe) : []),
    ...input.elements.flatMap((e) => assessElementOverflow(e)),
  ];

  return { ok: findings.every((f) => f.severity !== "high"), findings };
}

export function formatOverflow(result: OverflowResult): string {
  if (result.findings.length === 0) {
    return "overflow OK — nothing is clipped without an indicator and the page does not scroll sideways";
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  const sorted = [...result.findings].sort((a, b) => rank[a.severity] - rank[b.severity]);

  return [
    result.ok
      ? `overflow OK with ${result.findings.length} note(s):`
      : `OVERFLOW — ${result.findings.length} finding(s):`,
    ...sorted.map((f) => {
      const mark = f.severity === "high" ? "✗" : f.severity === "medium" ? "!" : "·";
      return `  ${mark} [${f.kind}] ${f.selector}\n    ${f.detail}`;
    }),
    "",
    "  axe-core has no rule for any of this, and screenshot diffing needs a baseline that",
    "  a one-shot generated UI does not have. Text that simply stops is invisible to both.",
  ].join("\n");
}
