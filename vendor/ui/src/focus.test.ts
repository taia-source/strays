import { describe, expect, it } from "vitest";
import {
  assessFocusObscured,
  assessTargetSize,
  checkFocus,
  type FocusableObservation,
  formatFocus,
  MIN_TARGET_PX,
  spacingExceptionMet,
} from "./focus.js";

/**
 * ══ Measured on real pages, in three engines ══
 *
 * The grid-sampling numbers below came from a link under a fixed header:
 *
 *   #under    0/25 visible, covered by #hdr   entirely hidden  → 2.4.11 FAILS
 *   #partial  20/25 visible                   partly hidden    → 2.4.11 PASSES
 *   #clear    25/25 visible                   fine
 *
 * And the three false positives each rule exists to avoid:
 *
 *   transparent overlay   wins every hit test, obscures nothing  (all 3 engines)
 *   off-viewport          elementFromPoint returns null
 *   display: none         0×0 rect at (0,0), hit-tests to the header
 */

const focusable = (over: Partial<FocusableObservation> = {}): FocusableObservation => ({
  selector: "#el",
  width: 100,
  height: 30,
  centreX: 50,
  centreY: 15,
  inViewport: true,
  sampledPoints: 25,
  visiblePoints: 25,
  inlineInText: false,
  ...over,
});

describe("2.4.11 Focus Not Obscured", () => {
  /** Measured: 0 of 25 points reached the element under a fixed header. */
  it("catches an element entirely hidden behind a fixed header", () => {
    const findings = assessFocusObscured(focusable({ visiblePoints: 0, coveredBy: "#hdr" }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("focus-obscured");
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.detail).toContain("#hdr");
  });

  /**
   * ══ Partial obscuring CONFORMS ══
   *
   * 2.4.11 says "not **entirely** hidden", so a link 20/25 visible under a sticky header
   * passes at Level AA. Centre-only sampling would report it as obscured and be wrong —
   * which is why the collector samples a grid.
   */
  it("never reports an element that is only partly covered", () => {
    expect(assessFocusObscured(focusable({ visiblePoints: 20, coveredBy: "#hdr" }))).toEqual([]);
  });

  /** One visible point is enough — the criterion is about total concealment. */
  it("passes an element with a single visible point", () => {
    expect(assessFocusObscured(focusable({ visiblePoints: 1, coveredBy: "#hdr" }))).toEqual([]);
  });

  /**
   * Scrolled out of view is not obscured. `elementFromPoint` returns null there, which is
   * indistinguishable from "nothing covering it" — so the viewport gate comes first.
   */
  it("never reports an element scrolled out of view", () => {
    expect(assessFocusObscured(focusable({ inViewport: false, visiblePoints: 0 }))).toEqual([]);
  });

  /**
   * Measured on `display: none`: a 0×0 rect at the origin that hit-tests to whatever sits
   * there — usually the header. A guaranteed false positive without this filter.
   */
  it("never reports a zero-area element", () => {
    expect(assessFocusObscured(focusable({ width: 0, height: 0, visiblePoints: 0 }))).toEqual([]);
  });

  /** No samples means no verdict. Silence beats a guess from zero evidence. */
  it("says nothing when no points could be sampled", () => {
    expect(assessFocusObscured(focusable({ sampledPoints: 0, visiblePoints: 0 }))).toEqual([]);
  });

  /**
   * ══ Hit-testing is not visibility ══
   *
   * A fully transparent `inset: 0` overlay intercepts every hit test in all three engines
   * while hiding nothing. There is no sound mechanical way to distinguish that from a real
   * cover, so it is downgraded rather than reported as a failure — a hard fail here would
   * send someone deleting an overlay that is doing its job.
   */
  it("downgrades a transparent cover to needs-review", () => {
    const findings = assessFocusObscured(
      focusable({ visiblePoints: 0, coveredBy: "#ghost", coveredByTransparent: true }),
    );
    expect(findings[0]?.kind).toBe("focus-possibly-obscured");
    expect(findings[0]?.severity).toBe("medium");
    expect(findings[0]?.detail).toContain("Hit-testing is not visibility");
  });

  it("is silent on a fully visible element", () => {
    expect(assessFocusObscured(focusable())).toEqual([]);
  });
});

describe("2.5.8 Target Size", () => {
  const target = (over: Partial<FocusableObservation>) =>
    focusable({ width: 16, height: 16, ...over });

  /** Two 16px buttons flush together: undersized AND too close for the exception. */
  it("catches undersized targets that are also crowded", () => {
    const findings = assessTargetSize([
      target({ selector: "#t1", centreX: 8, centreY: 8 }),
      target({ selector: "#t2", centreX: 24, centreY: 8 }),
    ]);
    expect(findings.map((f) => f.selector)).toEqual(["#t1", "#t2"]);
    expect(findings[0]?.kind).toBe("target-too-small");
  });

  /**
   * The Spacing exception, verbatim: a 24px-diameter circle centred on each bounding box
   * must not intersect another's. Two circles of diameter 24 intersect exactly when their
   * centres are under 24 apart.
   */
  it("accepts undersized targets that are far enough apart", () => {
    expect(
      assessTargetSize([
        target({ selector: "#a", centreX: 8, centreY: 8 }),
        target({ selector: "#b", centreX: 100, centreY: 8 }),
      ]),
    ).toEqual([]);
  });

  it("accepts a target that meets the size outright", () => {
    expect(
      assessTargetSize([
        focusable({ selector: "#big", width: 48, height: 48, centreX: 24, centreY: 24 }),
        target({ selector: "#small", centreX: 30, centreY: 24 }),
      ]).map((f) => f.selector),
    ).toEqual(["#small"]);
  });

  /** Exactly 24×24 conforms — the criterion is "at least 24 by 24". */
  it("accepts a target at exactly the minimum", () => {
    expect(
      assessTargetSize([
        focusable({ width: MIN_TARGET_PX, height: MIN_TARGET_PX, centreX: 12, centreY: 12 }),
        focusable({ width: MIN_TARGET_PX, height: MIN_TARGET_PX, centreX: 20, centreY: 12 }),
      ]),
    ).toEqual([]);
  });

  /**
   * The neighbour must be large enough to pass on size, or it is undersized and crowded
   * too and is correctly reported alongside — which is what the first version of this
   * test got wrong. It exists only to defeat the spacing exception for `#under`.
   */
  it("reports a target one pixel under the minimum", () => {
    expect(
      assessTargetSize([
        focusable({
          selector: "#under",
          width: MIN_TARGET_PX - 1,
          height: MIN_TARGET_PX,
          centreX: 12,
          centreY: 12,
        }),
        focusable({ selector: "#neighbour", width: 48, height: 48, centreX: 20, centreY: 12 }),
      ]).map((f) => f.selector),
    ).toEqual(["#under"]);
  });

  /**
   * The Inline exception: a link inside a sentence is constrained by line-height and is
   * exempt. Detectable only heuristically, so it suppresses rather than reports.
   */
  it("exempts a link inline in a sentence", () => {
    expect(
      assessTargetSize([
        target({ selector: "#link", inlineInText: true, centreX: 8, centreY: 8 }),
        target({ selector: "#other", centreX: 20, centreY: 8 }),
      ]).map((f) => f.selector),
    ).toEqual(["#other"]);
  });

  it("ignores a zero-area target", () => {
    expect(assessTargetSize([target({ width: 0, height: 0 })])).toEqual([]);
  });

  /** A lone undersized target has nothing to crowd it, so the exception applies. */
  it("accepts a lone undersized target", () => {
    expect(assessTargetSize([target({ centreX: 8, centreY: 8 })])).toEqual([]);
  });
});

describe("spacingExceptionMet", () => {
  it("is met at exactly the minimum distance", () => {
    expect(
      spacingExceptionMet({ centreX: 0, centreY: 0 }, [{ centreX: MIN_TARGET_PX, centreY: 0 }]),
    ).toBe(true);
  });

  it("is not met one pixel closer", () => {
    expect(
      spacingExceptionMet({ centreX: 0, centreY: 0 }, [{ centreX: MIN_TARGET_PX - 1, centreY: 0 }]),
    ).toBe(false);
  });

  /** Distance is euclidean, not per-axis: diagonal neighbours count. */
  it("measures diagonally, not per axis", () => {
    // dx=20, dy=20 → distance 28.3, which clears 24 despite each axis being under it.
    expect(spacingExceptionMet({ centreX: 0, centreY: 0 }, [{ centreX: 20, centreY: 20 }])).toBe(
      true,
    );
    // dx=17, dy=17 → 24.04, just clear. dx=16,dy=16 → 22.6, too close.
    expect(spacingExceptionMet({ centreX: 0, centreY: 0 }, [{ centreX: 16, centreY: 16 }])).toBe(
      false,
    );
  });

  it("is met when there is nothing else", () => {
    expect(spacingExceptionMet({ centreX: 0, centreY: 0 }, [])).toBe(true);
  });
});

describe("checkFocus", () => {
  it("blocks on an obscured element and warns on a small target", () => {
    const result = checkFocus([
      focusable({ selector: "#hidden", visiblePoints: 0, coveredBy: "#hdr" }),
      focusable({ selector: "#t1", width: 16, height: 16, centreX: 8, centreY: 8 }),
      focusable({ selector: "#t2", width: 16, height: 16, centreX: 20, centreY: 8 }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toContain("focus-obscured");
    expect(result.findings.map((f) => f.kind)).toContain("target-too-small");
  });

  it("is ok when only target-size warnings are present", () => {
    const result = checkFocus([
      focusable({ selector: "#t1", width: 16, height: 16, centreX: 8, centreY: 8 }),
      focusable({ selector: "#t2", width: 16, height: 16, centreX: 20, centreY: 8 }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("is silent on a clean page", () => {
    expect(checkFocus([focusable()]).findings).toEqual([]);
  });
});

describe("formatFocus", () => {
  /** A clean axe run says nothing about any of this, and the reader should know. */
  it("names the axe coverage gap", () => {
    const text = formatFocus(checkFocus([focusable({ visiblePoints: 0, coveredBy: "#hdr" })]));
    expect(text).toContain("zero rules");
  });

  it("orders high severity first", () => {
    const text = formatFocus(
      checkFocus([
        focusable({ selector: "#t1", width: 16, height: 16, centreX: 8, centreY: 8 }),
        focusable({ selector: "#t2", width: 16, height: 16, centreX: 20, centreY: 8 }),
        focusable({ selector: "#hidden", visiblePoints: 0, coveredBy: "#hdr" }),
      ]),
    );
    expect(text.indexOf("#hidden")).toBeLessThan(text.indexOf("#t1"));
  });

  it("reports clean when nothing is wrong", () => {
    expect(formatFocus({ ok: true, findings: [] })).toContain("focus OK");
  });
});

describe("untested paths found by coverage audit", () => {
  /**
   * ══ Hidden with no identified cover ══
   *
   * `coveredBy` is only set when `elementFromPoint` returns something. It can return
   * `null` for a point inside the viewport — an element under a cross-origin iframe, or
   * one clipped out of its own stacking context — so every sampled point can fail without
   * naming a culprit. The finding must still read correctly rather than saying
   * "hidden behind undefined".
   */
  it("reads correctly when nothing could be named as the cover", () => {
    const findings = assessFocusObscured(focusable({ visiblePoints: 0 }));
    expect(findings[0]?.kind).toBe("focus-obscured");
    expect(findings[0]?.detail).toContain("author content");
    expect(findings[0]?.detail).not.toContain("undefined");
  });

  it("reads correctly for an unnamed transparent cover", () => {
    const findings = assessFocusObscured(
      focusable({ visiblePoints: 0, coveredByTransparent: true }),
    );
    expect(findings[0]?.kind).toBe("focus-possibly-obscured");
    expect(findings[0]?.detail).toContain("another element");
    expect(findings[0]?.detail).not.toContain("undefined");
  });

  /** The warning-only branch of the formatter — target-size findings without an obscure. */
  it("formats a warning-only result without claiming failure", () => {
    const text = formatFocus(
      checkFocus([
        focusable({ selector: "#t1", width: 16, height: 16, centreX: 8, centreY: 8 }),
        focusable({ selector: "#t2", width: 16, height: 16, centreX: 20, centreY: 8 }),
      ]),
    );
    expect(text).toContain("focus OK with");
    expect(text).not.toContain("FOCUS —");
  });
});
