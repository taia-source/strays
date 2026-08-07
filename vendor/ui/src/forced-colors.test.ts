import { describe, expect, it } from "vitest";
import {
  assessForcedColors,
  FORCING_ENGINES,
  type ForcedColorsObservation,
  formatForcedColors,
} from "./forced-colors.js";

/**
 * ══ Measured, not assumed ══
 *
 * Every value here came from rendering the same page twice — forcing off, then on — on
 * Chromium, Firefox and WebKit:
 *
 *   #shadowonly  border:none  shadow:none  bgImage:none            ← invisible
 *   #bordered    border:solid shadow:none  bgImage:none            ← still visible
 *   #grad        border:none  shadow:none  bgImage:none            ← flat
 *   #urlbg       border:none  shadow:none  bgImage:url("data:…")   ← survives
 *
 * And the finding that decides the module's shape:
 *
 *   chromium  mq:true  shadow:"none"                        bg:"none"
 *   firefox   mq:true  shadow:"none"                        bg:"none"
 *   webkit    mq:true  shadow:"rgb(0,0,0) 0px 0px 4px 0px"  bg:"linear-gradient(rgb("
 */

const el = (over: Partial<ForcedColorsObservation> = {}): ForcedColorsObservation => ({
  selector: "#el",
  borderStyle: "none",
  boxShadow: "none",
  backgroundImage: "none",
  meaningful: true,
  width: 100,
  height: 40,
  ...over,
});

describe("engine gating", () => {
  /**
   * The vacuous pass this exists to prevent. WebKit answers `true` to
   * `(forced-colors: active)` and applies none of the forcing, so every element keeps its
   * shadows and no finding can ever be produced. Reporting "ok" there would be the worst
   * kind of green.
   */
  it("refuses to render a verdict on WebKit", () => {
    const result = assessForcedColors({
      engine: "webkit",
      observations: { before: [el({ boxShadow: "0 0 4px #000" })], after: [el()] },
    });
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toContain("vacuous");
  });

  it("answers for the engines that actually force", () => {
    expect(FORCING_ENGINES.has("chromium")).toBe(true);
    expect(FORCING_ENGINES.has("firefox")).toBe(true);
    expect(FORCING_ENGINES.has("webkit")).toBe(false);
  });

  /** A refusal must never read as a pass in the output. */
  it("says NOT CHECKED rather than OK when it refused", () => {
    const text = formatForcedColors(
      assessForcedColors({ engine: "webkit", observations: { before: [], after: [] } }),
    );
    expect(text).toContain("NOT CHECKED");
    expect(text).not.toContain("OK");
  });
});

describe("boundary-vanished", () => {
  /** The shadow-only button — measured as `border:none shadow:none`, an invisible box. */
  it("catches an element whose only boundary was a shadow", () => {
    const result = assessForcedColors({
      engine: "chromium",
      observations: {
        before: [el({ boxShadow: "rgb(51, 51, 51) 0px 0px 0px 2px" })],
        after: [el()],
      },
    });
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.findings[0]?.kind).toBe("boundary-vanished");
    expect(result.findings[0]?.severity).toBe("high");
    expect(result.ok).toBe(false);
  });

  /**
   * ══ The false positive that a live run exposed ══
   *
   * The first version flagged any element computing to `border:none shadow:none` under
   * forcing — which is nearly every element on any page. Measured, it fired on a plain
   * bordered button that never had a shadow at all.
   */
  it("never flags an element that had no boundary to lose", () => {
    const result = assessForcedColors({
      engine: "chromium",
      observations: { before: [el()], after: [el()] },
    });
    expect(result.supported && result.findings).toEqual([]);
  });

  /** A real border survives forcing — measured `borderStyle: "solid"`. */
  it("never flags an element that kept a real border", () => {
    const result = assessForcedColors({
      engine: "chromium",
      observations: {
        before: [el({ borderStyle: "solid" })],
        after: [el({ borderStyle: "solid" })],
      },
    });
    expect(result.supported && result.findings).toEqual([]);
  });

  /** A decorative spacer losing its shadow is not a defect worth reporting. */
  it("ignores elements that carry no meaning", () => {
    const result = assessForcedColors({
      engine: "chromium",
      observations: {
        before: [el({ meaningful: false, boxShadow: "0 0 4px #000" })],
        after: [el({ meaningful: false })],
      },
    });
    expect(result.supported && result.findings).toEqual([]);
  });

  it("ignores a zero-area element", () => {
    const result = assessForcedColors({
      engine: "chromium",
      observations: {
        before: [el({ width: 0, height: 0, boxShadow: "0 0 4px #000" })],
        after: [el({ width: 0, height: 0 })],
      },
    });
    expect(result.supported && result.findings).toEqual([]);
  });
});

describe("gradient-lost", () => {
  it("catches a gradient background that forcing stripped", () => {
    const result = assessForcedColors({
      engine: "chromium",
      observations: {
        before: [el({ backgroundImage: "linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))" })],
        after: [el()],
      },
    });
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.findings.map((f) => f.kind)).toContain("gradient-lost");
    // A gradient loss is ugly, not invisible — it warns rather than blocks.
    expect(result.findings[0]?.severity).toBe("medium");
    expect(result.ok).toBe(true);
  });

  /** `url()` backgrounds survive forcing — measured. Nothing was lost, so nothing is said. */
  it("never flags a url() background, which survives", () => {
    const url = 'url("data:image/gif;base64,R0l")';
    const result = assessForcedColors({
      engine: "chromium",
      observations: {
        before: [el({ backgroundImage: url })],
        after: [el({ backgroundImage: url })],
      },
    });
    expect(result.supported && result.findings).toEqual([]);
  });
});

describe("forced-color-adjust", () => {
  /**
   * Opting out is correct for a colour swatch and an accessibility failure elsewhere, so
   * it is reported as a warning for a human to judge rather than a block.
   */
  it("reports an opt-out for review without blocking", () => {
    const result = assessForcedColors({
      engine: "chromium",
      observations: { before: [el()], after: [el({ forcedColorAdjust: "none" })] },
    });
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.findings[0]?.kind).toBe("forced-color-adjust-abuse");
    expect(result.ok).toBe(true);
    expect(result.findings[0]?.detail).toContain("swatch");
  });

  it("says nothing when the property is left alone", () => {
    const result = assessForcedColors({
      engine: "chromium",
      observations: { before: [el()], after: [el({ forcedColorAdjust: "auto" })] },
    });
    expect(result.supported && result.findings).toEqual([]);
  });
});

describe("formatForcedColors", () => {
  it("reports clean when nothing was lost", () => {
    const text = formatForcedColors(
      assessForcedColors({ engine: "chromium", observations: { before: [el()], after: [el()] } }),
    );
    expect(text).toContain("forced colours OK");
  });

  /** The reader should know who is affected, not just what changed. */
  it("names who is affected when something broke", () => {
    const text = formatForcedColors(
      assessForcedColors({
        engine: "chromium",
        observations: { before: [el({ boxShadow: "0 0 4px #000" })], after: [el()] },
      }),
    );
    expect(text).toContain("high-contrast");
  });
});

describe("untested paths found by coverage audit", () => {
  /**
   * The severity sort only does work when both severities are present — with a uniform
   * list the comparator never returns a non-zero value, so the ordering was never
   * actually exercised.
   */
  it("orders a mixed result high-severity first", () => {
    const result = assessForcedColors({
      engine: "chromium",
      observations: {
        before: [
          el({ selector: "#warn", backgroundImage: "linear-gradient(red, blue)" }),
          el({ selector: "#broken", boxShadow: "0 0 4px #000" }),
        ],
        after: [el({ selector: "#warn" }), el({ selector: "#broken" })],
      },
    });
    const text = formatForcedColors(result);
    expect(text).toContain("FORCED COLOURS BROKEN");
    expect(text.indexOf("#broken")).toBeLessThan(text.indexOf("#warn"));
  });

  /** The warning-only branch: a gradient loss alone does not block. */
  it("formats a warning-only result without claiming failure", () => {
    const text = formatForcedColors(
      assessForcedColors({
        engine: "chromium",
        observations: {
          before: [el({ backgroundImage: "linear-gradient(red, blue)" })],
          after: [el()],
        },
      }),
    );
    expect(text).toContain("forced colours OK with");
    expect(text).not.toContain("BROKEN");
  });
});
