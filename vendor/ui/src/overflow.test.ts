import { describe, expect, it } from "vitest";
import {
  assessElementOverflow,
  assessPageOverflow,
  checkOverflow,
  formatOverflow,
  MIN_OVERFLOW_PX,
  type OverflowObservation,
} from "./overflow.js";

/**
 * ══ Measured on real pages, in three engines ══
 *
 * Every fixture below reproduces something observed rather than imagined:
 *
 *   .sr-only      1×1px  clip:rect(0,0,0,0)   delta 96   ← on nearly every real page
 *   carousel      overflow-x: auto            delta 308  ← intentional by definition
 *   #clip         overflow:hidden, te:clip    delta 33   ← the real defect
 *   "Log in"      scrollW 44  clientW 43      delta 1    ← 0.34px of TRUE overflow
 *
 * And the page-level result that shaped the design:
 *
 *   abs-positioned at left:900px, viewport 800
 *   documentElement.scrollWidth 800 === clientWidth 800   delta 0   "clean"
 *   actual maxScrollX 400                                 ← it really scrolls
 */

const el = (over: Partial<OverflowObservation> = {}): OverflowObservation => ({
  selector: "#el",
  overflowX: 0,
  overflowY: 0,
  computedOverflowX: "hidden",
  computedOverflowY: "hidden",
  textOverflow: "clip",
  lineClamp: "none",
  ownsText: true,
  visuallyHidden: false,
  width: 200,
  height: 20,
  ...over,
});

describe("clipped without an indicator", () => {
  /** The high-value case: text stops, with nothing to say more exists. */
  it("catches text cut off with no ellipsis, clamp or scrollbar", () => {
    const findings = assessElementOverflow(el({ overflowX: 33 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("clipped-without-indicator");
    expect(findings[0]?.severity).toBe("high");
  });

  /** An explicit ellipsis is an opt-in, so it notes rather than blocks. */
  it("downgrades truncation the author opted into", () => {
    const findings = assessElementOverflow(el({ overflowX: 251, textOverflow: "ellipsis" }));
    expect(findings[0]?.kind).toBe("clipped-with-ellipsis");
    expect(findings[0]?.severity).toBe("low");
  });

  /**
   * `-webkit-line-clamp` is laborious to set by accident. Note the PREFIXED property is
   * read: the unprefixed `line-clamp` was measured doing nothing in all three engines.
   */
  it("treats a line clamp as deliberate", () => {
    const findings = assessElementOverflow(el({ overflowY: 48, lineClamp: "2" }));
    expect(findings[0]?.kind).toBe("clipped-with-ellipsis");
    expect(findings[0]?.severity).toBe("low");
    expect(findings[0]?.detail).toContain("2 line");
  });
});

describe("the false positives that would get this deleted", () => {
  /**
   * ══ The one that survives every other filter ══
   *
   * The visually-hidden pattern is definitionally clipped text — measured at delta 96
   * with `clip: rect(0,0,0,0)` and delta 43 with `clip-path: inset(50%)`. It appears on
   * nearly every real site, so without this exclusion the check fires everywhere.
   */
  it("never reports visually-hidden screen-reader text", () => {
    expect(
      assessElementOverflow(el({ overflowX: 96, visuallyHidden: true, width: 1, height: 1 })),
    ).toEqual([]);
  });

  /** Measured at delta 308 on a carousel working exactly as designed. */
  it("never reports a deliberate scroll container", () => {
    expect(assessElementOverflow(el({ overflowX: 308, computedOverflowX: "auto" }))).toEqual([]);
    expect(assessElementOverflow(el({ overflowY: 308, computedOverflowY: "scroll" }))).toEqual([]);
  });

  /**
   * ══ The rounding threshold, measured rather than assumed ══
   *
   * My premise — "scrollWidth is integer-rounded while clientWidth is fractional" — was
   * false. Both are integers; getBoundingClientRect is the fractional one. The real
   * hazard is fractional TEXT width: measured `scrollW 44, clientW 43, rectW 43.25,
   * textW 43.59` is 0.34px of true overflow reporting as delta 1.
   *
   * Across a 70-case sweep every delta-1 case was 0.34–1.31px — never visible — while
   * genuine defects measured 33px and up.
   */
  it("ignores a one-pixel delta, which carries no information", () => {
    expect(assessElementOverflow(el({ overflowX: 1 }))).toEqual([]);
    expect(MIN_OVERFLOW_PX).toBe(2);
  });

  it("reports at exactly the minimum", () => {
    expect(assessElementOverflow(el({ overflowX: MIN_OVERFLOW_PX }))).toHaveLength(1);
  });

  it("does not report just below the minimum", () => {
    expect(assessElementOverflow(el({ overflowX: MIN_OVERFLOW_PX - 1 }))).toEqual([]);
  });

  /** A wrapper whose child overflows is not the defect; editing it fixes nothing. */
  it("never reports an element that owns no text", () => {
    expect(assessElementOverflow(el({ overflowX: 300, ownsText: false }))).toEqual([]);
  });

  it("never reports a zero-area element", () => {
    expect(assessElementOverflow(el({ overflowX: 300, width: 0, height: 0 }))).toEqual([]);
  });

  it("is silent on an element that fits", () => {
    expect(assessElementOverflow(el())).toEqual([]);
  });
});

describe("spilling content is a different defect", () => {
  /**
   * `overflow: visible` clips nothing — the text renders fully and lands on whatever is
   * beside it. Reporting it as truncation would send someone to widen a container that
   * is not cutting anything.
   */
  it("reports a spill separately from a clip", () => {
    const findings = assessElementOverflow(
      el({
        overflowX: 311,
        computedOverflowX: "visible",
        computedOverflowY: "visible",
        spillPx: 136.88,
      }),
    );
    expect(findings[0]?.kind).toBe("content-spills");
    expect(findings[0]?.severity).toBe("medium");
    expect(findings[0]?.detail).toContain("137px");
  });

  /** Without a measured spill there is no claim to make. */
  it("says nothing about a visible-overflow element it could not measure", () => {
    expect(
      assessElementOverflow(
        el({ overflowX: 311, computedOverflowX: "visible", computedOverflowY: "visible" }),
      ),
    ).toEqual([]);
  });

  it("ignores a sub-pixel spill", () => {
    expect(
      assessElementOverflow(
        el({
          overflowX: 311,
          computedOverflowX: "visible",
          computedOverflowY: "visible",
          spillPx: 0.4,
        }),
      ),
    ).toEqual([]);
  });
});

describe("page-level overflow", () => {
  /**
   * ══ The false negative that makes scrollWidth unsound ══
   *
   * Measured: an absolutely-positioned element at left:900px on an 800px viewport gives
   * `documentElement.scrollWidth === clientWidth === 800` — delta 0, a clean bill of
   * health — while the page really scrolls 400px. Every scrollWidth-based check in
   * circulation misses this, which is why the probe measures the scroll instead.
   */
  it("catches a page that really scrolls sideways", () => {
    const findings = assessPageOverflow({
      maxScrollX: 400,
      scrollbarWidth: 0,
      hasViewportMeta: true,
    });
    expect(findings[0]?.kind).toBe("page-scrolls-sideways");
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.detail).toContain("scrollWidth reports no overflow");
  });

  /** With a classic scrollbar present, 100vw overflows by exactly its width. */
  it("names the 100vw trap when a classic scrollbar is present", () => {
    const findings = assessPageOverflow({
      maxScrollX: 15,
      scrollbarWidth: 15,
      hasViewportMeta: true,
    });
    expect(findings[0]?.detail).toContain("100vw");
  });

  it("says nothing about 100vw with overlay scrollbars", () => {
    const findings = assessPageOverflow({
      maxScrollX: 400,
      scrollbarWidth: 0,
      hasViewportMeta: true,
    });
    expect(findings[0]?.detail).not.toContain("100vw");
  });

  /**
   * Without the meta tag a mobile browser assumes ~980px and scales down, so every
   * breakpoint is wrong and every width measured is meaningless.
   */
  it("catches a missing viewport meta", () => {
    const findings = assessPageOverflow({
      maxScrollX: 0,
      scrollbarWidth: 0,
      hasViewportMeta: false,
    });
    expect(findings[0]?.kind).toBe("missing-viewport-meta");
  });

  it("is silent on a page that does not scroll", () => {
    expect(assessPageOverflow({ maxScrollX: 0, scrollbarWidth: 0, hasViewportMeta: true })).toEqual(
      [],
    );
  });

  it("ignores a sub-threshold scroll", () => {
    expect(assessPageOverflow({ maxScrollX: 1, scrollbarWidth: 0, hasViewportMeta: true })).toEqual(
      [],
    );
  });

  /**
   * ══ The boundary, asserted exactly ══
   *
   * The fencepost class has survived sabotage repeatedly across this repo, and it did
   * again here: changing `>=` to `>` passed all 26 tests, because every case sat far from
   * the line — 400, 15, 1 and 0. A page scrolling exactly `MIN_OVERFLOW_PX` would have
   * gone unreported.
   *
   * The rule is "report at or above the minimum", so exactly at it must fire.
   */
  it("reports a scroll of exactly the minimum", () => {
    expect(
      assessPageOverflow({
        maxScrollX: MIN_OVERFLOW_PX,
        scrollbarWidth: 0,
        hasViewportMeta: true,
      }),
    ).toHaveLength(1);
  });

  it("does not report one pixel below the minimum", () => {
    expect(
      assessPageOverflow({
        maxScrollX: MIN_OVERFLOW_PX - 1,
        scrollbarWidth: 0,
        hasViewportMeta: true,
      }),
    ).toEqual([]);
  });
});

describe("checkOverflow", () => {
  it("combines page and element findings", () => {
    const result = checkOverflow({
      elements: [el({ overflowX: 33 })],
      probe: { maxScrollX: 400, scrollbarWidth: 0, hasViewportMeta: true },
    });
    expect(result.findings.map((f) => f.kind)).toEqual([
      "page-scrolls-sideways",
      "clipped-without-indicator",
    ]);
    expect(result.ok).toBe(false);
  });

  /** Low-severity notes do not block. */
  it("is ok when only notes are present", () => {
    const result = checkOverflow({
      elements: [el({ overflowX: 50, textOverflow: "ellipsis" })],
    });
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
  });

  it("works without a page probe", () => {
    expect(checkOverflow({ elements: [el()] }).findings).toEqual([]);
  });
});

describe("formatOverflow", () => {
  it("orders high severity first", () => {
    const text = formatOverflow(
      checkOverflow({
        elements: [
          el({ selector: "#note", overflowX: 50, textOverflow: "ellipsis" }),
          el({ selector: "#bug", overflowX: 50 }),
        ],
      }),
    );
    expect(text.indexOf("#bug")).toBeLessThan(text.indexOf("#note"));
  });

  it("reports clean when nothing is wrong", () => {
    expect(formatOverflow({ ok: true, findings: [] })).toContain("overflow OK");
  });

  /** The reader should know nothing else covers this. */
  it("says axe has no rule for it", () => {
    expect(formatOverflow(checkOverflow({ elements: [el({ overflowX: 50 })] }))).toContain(
      "axe-core has no rule",
    );
  });
});

describe("untested paths found by coverage audit", () => {
  /**
   * Three severities share one formatter, and the medium marker was never rendered — a
   * spill is the only medium finding, and no earlier test formatted one.
   */
  it("marks each severity distinctly", () => {
    const text = formatOverflow(
      checkOverflow({
        elements: [
          el({ selector: "#high", overflowX: 50 }),
          el({
            selector: "#medium",
            overflowX: 50,
            computedOverflowX: "visible",
            computedOverflowY: "visible",
            spillPx: 40,
          }),
          el({ selector: "#low", overflowX: 50, textOverflow: "ellipsis" }),
        ],
      }),
    );
    expect(text).toContain("✗ [clipped-without-indicator] #high");
    expect(text).toContain("! [content-spills] #medium");
    expect(text).toContain("· [clipped-with-ellipsis] #low");
    // And ordered by severity, worst first.
    expect(text.indexOf("#high")).toBeLessThan(text.indexOf("#medium"));
    expect(text.indexOf("#medium")).toBeLessThan(text.indexOf("#low"));
  });
});

describe("the warning-only formatter branch", () => {
  /** A note-only result must not read as a failure. */
  it("formats notes without claiming failure", () => {
    const text = formatOverflow(
      checkOverflow({ elements: [el({ overflowX: 50, textOverflow: "ellipsis" })] }),
    );
    expect(text).toContain("overflow OK with");
    expect(text).not.toContain("OVERFLOW —");
  });
});
