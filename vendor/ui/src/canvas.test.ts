import { describe, expect, it } from "vitest";
import {
  assessCanvas,
  assessCanvasMotion,
  BUFFER_SIZE_TOLERANCE,
  type CanvasObservation,
  checkCanvases,
  formatCanvas,
  MIN_NON_BLANK_RATIO,
} from "./canvas.js";

/**
 * ══ Every number here came off a real canvas ══
 *
 * The values below were measured on headless Chromium before being used, by rendering
 * canvases with deliberate defects and reading what the collector reported:
 *
 *   #blank   ctx=2d nonBlank=0.0000 colours=1   buf=200x200 css=200x200
 *   #flat    ctx=2d nonBlank=1.0000 colours=1   buf=200x200 css=200x200
 *   #art     ctx=2d nonBlank=1.0000 colours=67  buf=200x200 css=200x200
 *   #sparse  ctx=2d nonBlank=0.0067 colours=2   buf=200x200 css=200x200
 *   #gl      ctx=webgl2 nonBlank=-1  colours=-1 digest=unreadable
 *
 * `#sparse` is the one that shaped the thresholds: 30 dots on a 200×200 canvas is a
 * legitimate dot-and-line aesthetic and reads as 0.67% coverage. Any "is it busy enough"
 * threshold would flag exactly the style this repo exists to support.
 */

const canvas = (over: Partial<CanvasObservation> = {}): CanvasObservation => ({
  selector: "#c",
  bufferWidth: 200,
  bufferHeight: 200,
  cssWidth: 200,
  cssHeight: 200,
  devicePixelRatio: 1,
  contextType: "2d",
  nonBlankRatio: 1,
  distinctColours: 67,
  digest: "12345",
  ...over,
});

describe("assessCanvas", () => {
  it("is silent on a healthy canvas", () => {
    expect(assessCanvas(canvas())).toEqual([]);
  });

  /** Measured: a canvas nothing drew into reports exactly 0.0000. */
  it("catches a blank canvas", () => {
    const findings = assessCanvas(canvas({ nonBlankRatio: 0, distinctColours: 1 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("blank");
    expect(findings[0]?.severity).toBe("high");
  });

  /**
   * A blank canvas is trivially one colour. Reporting both `blank` and `flat-fill` would
   * send someone chasing two bugs when there is one.
   */
  it("does not also report flat-fill for a blank canvas", () => {
    const findings = assessCanvas(canvas({ nonBlankRatio: 0, distinctColours: 1 }));
    expect(findings.map((f) => f.kind)).toEqual(["blank"]);
  });

  /** Measured on a canvas filled entirely with #123456: nonBlank=1.0, colours=1. */
  it("catches a canvas painted a single flat colour", () => {
    const findings = assessCanvas(canvas({ nonBlankRatio: 1, distinctColours: 1 }));
    expect(findings[0]?.kind).toBe("flat-fill");
    expect(findings[0]?.severity).toBe("high");
  });

  /**
   * ══ The aesthetic this must never break ══
   *
   * 30 dots on a 200×200 canvas measured 0.67% coverage. A sparse dot-and-line network
   * animation is the intended output for several of the styles this repo supports, so a
   * coverage threshold anywhere near "meaningful" would flag correct work.
   */
  it("accepts a sparse dot-and-line canvas", () => {
    expect(assessCanvas(canvas({ nonBlankRatio: 0.0067, distinctColours: 2 }))).toEqual([]);
  });

  it("catches a zero-sized backing store", () => {
    const findings = assessCanvas(canvas({ bufferWidth: 0, bufferHeight: 0 }));
    expect(findings[0]?.kind).toBe("zero-sized");
  });

  /** Nothing else is meaningful once the buffer is zero — one clear finding, not five. */
  it("reports only zero-sized when the buffer has no area", () => {
    const findings = assessCanvas(
      canvas({ bufferWidth: 0, bufferHeight: 0, nonBlankRatio: 0, distinctColours: 1 }),
    );
    expect(findings).toHaveLength(1);
  });

  it("catches a canvas that never got a context", () => {
    const findings = assessCanvas(canvas({ contextType: "none" }));
    expect(findings.map((f) => f.kind)).toContain("no-context");
  });
});

describe("high-DPI backing store", () => {
  /**
   * ══ Why this rule is gated on devicePixelRatio ══
   *
   * The naive form of this check fired on FIVE of five canvases in a live probe,
   * including a correct one. Rendering the naive and correct patterns side by side
   * explains it:
   *
   *     dpr=1   naive: buf=200x200 css=200x200   correct: buf=200x200 css=200x200
   *     dpr=2   naive: buf=200x200 css=200x200   correct: buf=400x400 css=200x200
   *
   * At dpr 1 the two are **identical** — the defect does not exist and cannot be
   * observed. Re-verified after the fix: dpr=1 clean, dpr=2 flags only the naive canvas.
   */
  it("says nothing at devicePixelRatio 1, where the bug is unobservable", () => {
    expect(assessCanvas(canvas({ devicePixelRatio: 1, bufferWidth: 200, cssWidth: 200 }))).toEqual(
      [],
    );
  });

  /**
   * ══ The false positive, pinned ══
   *
   * Sabotage removed the `devicePixelRatio > 1` gate and all 27 tests still passed — the
   * exact regression that made this rule fire on five of five canvases in a live probe,
   * including correct ones.
   *
   * The case above only covers a canvas whose buffer equals its CSS size. This covers the
   * one that actually reappears: at dpr 1 a canvas is often SMALLER than its CSS box
   * (`width=200` styled to 400px), which is a deliberate low-resolution choice — pixel
   * art depends on it — and is not blurry-on-retina. Without the gate this reports it.
   */
  it("never flags an intentionally low-resolution canvas at dpr 1", () => {
    expect(
      assessCanvas(
        canvas({
          devicePixelRatio: 1,
          bufferWidth: 100,
          bufferHeight: 100,
          cssWidth: 400,
          cssHeight: 400,
        }),
      ),
      "pixel art scales a small buffer up on purpose; at dpr 1 that is a style, not a defect",
    ).toEqual([]);
  });

  it("catches an upscaled canvas on a high-DPI display", () => {
    const findings = assessCanvas(
      canvas({
        devicePixelRatio: 2,
        bufferWidth: 200,
        bufferHeight: 200,
        cssWidth: 200,
        cssHeight: 200,
      }),
    );
    expect(findings[0]?.kind).toBe("buffer-size-mismatch");
    expect(findings[0]?.detail).toContain("2.0×");
  });

  /** The correct retina pattern: buffer is cssSize × dpr. Must never be flagged. */
  it("accepts a correctly scaled retina canvas", () => {
    expect(
      assessCanvas(
        canvas({
          devicePixelRatio: 2,
          bufferWidth: 400,
          bufferHeight: 400,
          cssWidth: 200,
          cssHeight: 200,
        }),
      ),
    ).toEqual([]);
  });

  /** A buffer LARGER than needed is wasteful, not blurry — not this defect. */
  it("does not flag a canvas with a larger buffer than required", () => {
    expect(
      assessCanvas(
        canvas({
          devicePixelRatio: 2,
          bufferWidth: 800,
          bufferHeight: 800,
          cssWidth: 200,
          cssHeight: 200,
        }),
      ),
    ).toEqual([]);
  });

  /** A canvas not laid out yet has no CSS size; there is nothing to compare against. */
  it("says nothing when the canvas has no CSS size", () => {
    expect(assessCanvas(canvas({ devicePixelRatio: 2, cssWidth: 0, cssHeight: 0 }))).toEqual([]);
  });

  /**
   * Boundary: the tolerance band absorbs rounding, and just beyond it does not.
   *
   * Both dimensions must be set. The rule takes the WORST axis — a canvas blurry in one
   * direction is blurry — so leaving height at its default while raising width produces
   * a shortfall of 0.5 rather than the 0.95 intended. That mistake failed this test on
   * first run, which is the check working.
   */
  it("tolerates a shortfall inside the tolerance band", () => {
    expect(BUFFER_SIZE_TOLERANCE).toBe(0.1);
    // ratio 1.9 against dpr 2 → shortfall 0.95, inside the 0.9 floor.
    expect(
      assessCanvas(
        canvas({
          devicePixelRatio: 2,
          bufferWidth: 380,
          bufferHeight: 380,
          cssWidth: 200,
          cssHeight: 200,
        }),
      ),
    ).toEqual([]);
  });

  /** The worst axis decides: blurry in one direction is blurry. */
  it("reports a canvas undersized in only one dimension", () => {
    const findings = assessCanvas(
      canvas({
        devicePixelRatio: 2,
        bufferWidth: 400,
        bufferHeight: 200,
        cssWidth: 200,
        cssHeight: 200,
      }),
    );
    expect(findings.map((f) => f.kind)).toContain("buffer-size-mismatch");
  });

  it("reports a shortfall beyond the tolerance band", () => {
    // ratio 1.7 against dpr 2 → shortfall 0.85, past the floor.
    const findings = assessCanvas(
      canvas({ devicePixelRatio: 2, bufferWidth: 340, bufferHeight: 340, cssWidth: 200 }),
    );
    expect(findings.map((f) => f.kind)).toContain("buffer-size-mismatch");
  });
});

describe("assessCanvasMotion", () => {
  /**
   * ══ The failure this exists for, reproduced live ══
   *
   * A requestAnimationFrame loop that throws dies **silently** — the error goes to the
   * console and the last good frame stays on screen. Measured on two canvases, one
   * healthy and one whose loop throws after a few frames:
   *
   *     #live  digest  1136864000 -> -1185240320   animating
   *     #dead  digest   193675392 ->   193675392   frozen
   *
   * Both look correct in a screenshot and to every DOM check. Only two samples over time
   * tell them apart.
   */
  it("catches a canvas whose draw loop died", () => {
    const findings = assessCanvasMotion({
      before: canvas({ digest: "193675392" }),
      after: canvas({ digest: "193675392" }),
      expectMotion: true,
    });
    expect(findings[0]?.kind).toBe("frozen");
    expect(findings[0]?.severity).toBe("high");
  });

  it("is silent when the canvas is still drawing", () => {
    expect(
      assessCanvasMotion({
        before: canvas({ digest: "1136864000" }),
        after: canvas({ digest: "-1185240320" }),
        expectMotion: true,
      }),
    ).toEqual([]);
  });

  /**
   * A static generative artwork draws once and stops, and that is correct. Only the
   * caller knows whether motion was intended, so it must be stated rather than guessed —
   * inferring it would make this check either useless or infuriating.
   */
  it("says nothing about an unchanged canvas when motion was not expected", () => {
    expect(
      assessCanvasMotion({
        before: canvas({ digest: "same" }),
        after: canvas({ digest: "same" }),
        expectMotion: false,
      }),
    ).toEqual([]);
  });
});

describe("checkCanvases", () => {
  /**
   * A WebGL canvas without `preserveDrawingBuffer` reads back empty for reasons that are
   * not a bug — measured as `nonBlank=-1, digest='unreadable'`. Reporting it as blank
   * would be a false positive on correct code, and would train a caller to ignore this
   * check entirely.
   */
  it("skips a WebGL canvas that cannot be read back", () => {
    const result = checkCanvases([
      canvas({ selector: "#gl", contextType: "webgl2", nonBlankRatio: -1, digest: "unreadable" }),
    ]);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /** A cross-origin image taints the canvas and makes reads throw. Also not a defect. */
  it("skips a tainted canvas", () => {
    expect(checkCanvases([canvas({ digest: "tainted", nonBlankRatio: -1 })]).findings).toEqual([]);
  });

  it("judges every canvas on the page", () => {
    const result = checkCanvases([
      canvas({ selector: "#a", nonBlankRatio: 0, distinctColours: 1 }),
      canvas({ selector: "#b" }),
      canvas({ selector: "#c", distinctColours: 1 }),
    ]);
    expect(result.findings.map((f) => f.selector)).toEqual(["#a", "#c"]);
    expect(result.ok).toBe(false);
  });

  it("is ok when only warnings are present", () => {
    const result = checkCanvases([
      canvas({ devicePixelRatio: 2, bufferWidth: 200, cssWidth: 200 }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
  });

  /** The threshold is exported so a caller can reason about it. */
  it("uses a deliberately tiny non-blank threshold", () => {
    expect(MIN_NON_BLANK_RATIO).toBe(0.001);
  });

  /**
   * ══ The threshold boundary, both sides ══
   *
   * The fencepost class has survived sabotage repeatedly across this repo. Changing
   * `<` to `<=` here passed all 27 tests, because every case sat far from the line —
   * blank at 0.0 and sparse at 0.0067.
   *
   * The rule is "blank when coverage falls BELOW the threshold", so a canvas at exactly
   * the threshold has drawn something and must pass, while just under it must not.
   */
  it("accepts a canvas at exactly the non-blank threshold", () => {
    expect(
      checkCanvases([canvas({ nonBlankRatio: MIN_NON_BLANK_RATIO, distinctColours: 4 })]).findings,
    ).toEqual([]);
  });

  it("reports a canvas just below the non-blank threshold", () => {
    const findings = checkCanvases([
      canvas({ nonBlankRatio: MIN_NON_BLANK_RATIO - 0.0001, distinctColours: 4 }),
    ]).findings;
    expect(findings.map((f) => f.kind)).toContain("blank");
  });
});

describe("formatCanvas", () => {
  /**
   * A clean result must not claim the drawing is correct — only that something was drawn.
   * Overclaiming is how a check becomes a false sense of coverage.
   */
  it("does not claim the drawing is correct when clean", () => {
    expect(formatCanvas({ ok: true, findings: [] })).toContain(
      "does not judge whether the drawing is correct",
    );
  });

  it("orders high severity first", () => {
    const text = formatCanvas(
      checkCanvases([
        canvas({ selector: "#warn", devicePixelRatio: 2, bufferWidth: 200, cssWidth: 200 }),
        canvas({ selector: "#broken", nonBlankRatio: 0, distinctColours: 1 }),
      ]),
    );
    expect(text.indexOf("#broken")).toBeLessThan(text.indexOf("#warn"));
  });

  it("says why a DOM check cannot see this", () => {
    expect(
      formatCanvas(checkCanvases([canvas({ nonBlankRatio: 0, distinctColours: 1 })])),
    ).toContain("Every DOM check passes a blank canvas");
  });
});

describe("untested paths found by coverage audit", () => {
  /**
   * The warning-only formatter branch. A buffer-size mismatch is the sole medium finding,
   * and no earlier test formatted a result containing one alone — so the `ok: true` arm
   * had never rendered.
   */
  it("formats a warning-only result without claiming failure", () => {
    const text = formatCanvas(
      checkCanvases([canvas({ devicePixelRatio: 2, bufferWidth: 200, cssWidth: 200 })]),
    );
    expect(text).toContain("canvas OK with");
    expect(text).not.toContain("BROKEN");
  });
});
