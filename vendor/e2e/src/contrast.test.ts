/**
 * Contrast tests.
 *
 * The numbers here come from running axe 4.12.1 in a real Chromium against deliberately
 * broken buttons — not from reading its docs.
 */
import { describe, expect, it } from "vitest";
import {
  AA_LARGE,
  AA_NORMAL,
  assessA11y,
  checkElement,
  contrastRatio,
  formatA11y,
  gradientStops,
  parseColor,
  requiredRatio,
  worstRatioAgainstStops,
} from "./contrast.js";

const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };

describe("parseColor", () => {
  it("parses the forms a browser actually reports", () => {
    expect(parseColor("rgb(255, 255, 255)")).toEqual(WHITE);
    expect(parseColor("rgba(0, 0, 0, 0.5)")).toEqual(BLACK);
    expect(parseColor("#ffffff")).toEqual(WHITE);
    expect(parseColor("#000000")).toEqual(BLACK);
  });

  it("returns undefined rather than guessing at a value it cannot read", () => {
    expect(parseColor("currentColor")).toBeUndefined();
    expect(parseColor("")).toBeUndefined();
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference points", () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 1);
    expect(contrastRatio(BLACK, BLACK)).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(contrastRatio(WHITE, BLACK), 5);
  });
});

describe("requiredRatio", () => {
  it("uses the large-text threshold only where WCAG does", () => {
    expect(requiredRatio(16, false)).toBe(AA_NORMAL);
    expect(requiredRatio(24, false)).toBe(AA_LARGE);
    expect(requiredRatio(19, true)).toBe(AA_LARGE);
    expect(requiredRatio(19, false)).toBe(AA_NORMAL);
  });
});

describe("gradients — where axe gives up", () => {
  it("extracts every colour stop", () => {
    expect(gradientStops("linear-gradient(90deg, rgb(0, 0, 0), rgb(255, 255, 255))")).toHaveLength(
      2,
    );
  });

  /** A gradient is readable only if its LEAST readable point is readable. */
  it("scores a gradient at its worst stop", () => {
    const ratio = worstRatioAgainstStops(BLACK, [WHITE, BLACK]);
    expect(ratio).toBeCloseTo(1, 5);
  });
});

describe("gradientStops — tokens that look like colours but are not", () => {
  /**
   * ══ The stop the extractor must DROP, not push ══
   *
   * `gradientStops` scans for `rgba?(...)` / `#rrggbb` and pushes whatever `parseColor`
   * returns. The `if (color)` guard had never been exercised with a falsy result, so the
   * behaviour on an unparseable stop was unproven.
   *
   * It is not hypothetical. CSS relative-colour syntax — `rgb(from red r g b)`, shipping
   * in every modern engine — matches the scan regex (`rgba?\([^)]+\)`) yet has no numeric
   * channels for `parseColor` to read. `color-mix()` and `rgb(var(--brand))` truncate the
   * same way, because `[^)]+` stops at the first `)`.
   *
   * Without the guard, `parseColor`'s `undefined` would be pushed into a `Rgb[]`, and the
   * next `contrastRatio` would read `.r/.g/.b` off `undefined` and throw — mid-run, from
   * inside a helper, on a page that merely used a modern gradient. Dropping it is what
   * makes the module degrade to "score the stops I could read" instead of crashing.
   */
  it("drops a stop it cannot parse rather than pushing undefined", () => {
    const stops = gradientStops("linear-gradient(90deg, rgba(from red r g b / 1), #ffffff)");
    // Two tokens match the scan; only the hex one resolves to a colour.
    expect(stops).toEqual([WHITE]);
  });

  /** The same shape via `rgb(var(--x))`, which `[^)]+` truncates to an unparseable token. */
  it("drops a var() stop and keeps the readable ones", () => {
    const stops = gradientStops("linear-gradient(rgb(var(--brand)), rgb(0, 0, 0))");
    expect(stops).toEqual([BLACK]);
  });

  /** A gradient whose stops are ALL unreadable yields nothing at all — no throw. */
  it("returns an empty list when no stop is readable", () => {
    expect(gradientStops("linear-gradient(rgb(from red r g b), rgb(var(--x)))")).toEqual([]);
  });
});

describe("worstRatioAgainstStops — the empty case", () => {
  /**
   * No stops means "nothing constrains this", and the only safe encoding of that is
   * `+Infinity`: it is `>= required` for every threshold, so an element whose background
   * could not be resolved into stops is never *failed* by the gradient path — it falls
   * through to the solid-colour path, which fails loudly on an unresolvable background.
   *
   * Returning 0 instead would fail every such element, and returning 1 would report the
   * invisible-text message for a page that simply used an unparseable gradient.
   */
  it("returns Infinity for no stops, so an unknown gradient does not fabricate a failure", () => {
    expect(worstRatioAgainstStops(BLACK, [])).toBe(Number.POSITIVE_INFINITY);
    // The property that matters: it clears every AA threshold rather than tripping one.
    expect(worstRatioAgainstStops(BLACK, [])).toBeGreaterThan(AA_NORMAL);
  });
});

describe("checkElement — the two cases axe cannot judge", () => {
  /**
   * MEASURED: axe 4.12.1 reports `equalRatio` for identical colours, which lands in
   * `incomplete`, not `violations`. A gate checking only violations passes an invisible
   * button — which is exactly what shipped for weeks in a prior project.
   */
  it("catches black-on-black that axe reports as equalRatio", () => {
    const finding = checkElement({
      selector: "#solid",
      color: "rgb(0, 0, 0)",
      backgroundColor: "rgb(0, 0, 0)",
      backgroundImage: "none",
      fontSizePx: 16,
      bold: false,
    });
    expect(finding.ok).toBe(false);
    expect(finding.ratio).toBeCloseTo(1, 5);
    expect(finding.detail).toMatch(/same colour, so it is invisible/);
    expect(finding.detail).toMatch(/equalRatio/);
  });

  /** MEASURED: `/gradient/.test(backgroundImage)` makes axe abandon the check entirely. */
  it("catches a black-on-black gradient that axe reports as bgGradient", () => {
    const finding = checkElement({
      selector: "#grad",
      color: "rgb(0, 0, 0)",
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundImage: "linear-gradient(90deg, rgb(0, 0, 0), rgb(17, 17, 17))",
      fontSizePx: 16,
      bold: false,
    });
    expect(finding.ok).toBe(false);
    expect(finding.detail).toMatch(/worst gradient stop/);
    expect(finding.detail).toMatch(/incomplete/);
  });

  it("passes a genuinely readable element", () => {
    const finding = checkElement({
      selector: "#fine",
      color: "rgb(17, 17, 17)",
      backgroundColor: "rgb(255, 255, 255)",
      backgroundImage: "none",
      fontSizePx: 16,
      bold: false,
    });
    expect(finding.ok).toBe(true);
    expect(finding.ratio).toBeGreaterThan(4.5);
  });

  /**
   * The control for the gradient path: a gradient that is genuinely readable must PASS,
   * and say so in the gradient vocabulary.
   *
   * Without this, the gradient branch could "work" by failing every gradient — which
   * would be indistinguishable from the real check on the failing tests above, and would
   * make every gradient button in a crypto UI a false positive.
   */
  it("passes a gradient whose worst stop still clears the threshold", () => {
    const finding = checkElement({
      selector: "#readable-grad",
      color: "rgb(255, 255, 255)",
      backgroundColor: "rgba(0, 0, 0, 0)",
      // Worst stop is the lighter #333333; white on #333 is ~12.6:1.
      backgroundImage: "linear-gradient(90deg, rgb(0, 0, 0), #333333)",
      fontSizePx: 16,
      bold: false,
    });
    expect(finding.ok).toBe(true);
    expect(finding.ratio).toBeGreaterThan(AA_NORMAL);
    expect(finding.detail).toMatch(/at its worst gradient stop \(needs 4\.5:1\)/);
    // The passing message must NOT carry the failure language.
    expect(finding.detail).not.toMatch(/incomplete/);
  });

  /**
   * ══ Below threshold, but NOT invisible ══
   *
   * `checkElement` has three distinct failure messages, and the middle one had never
   * rendered: a ratio that is too low yet plainly above 1.0. Grey-on-white (#767676 is
   * the canonical WCAG borderline) reads as *faint*, not as *absent*.
   *
   * The distinction is the whole point of the message. Telling someone "the text and
   * background are the same colour, so it is invisible" about text they can clearly see
   * on screen sends them looking for a bug that is not there. This asserts the message
   * matches the actual defect.
   */
  it("reports a low-but-visible ratio without claiming the text is invisible", () => {
    const finding = checkElement({
      selector: "#faint",
      color: "rgb(153, 153, 153)", // #999 on white ≈ 2.85:1 — readable, but under AA.
      backgroundColor: "rgb(255, 255, 255)",
      backgroundImage: "none",
      fontSizePx: 16,
      bold: false,
    });
    expect(finding.ok).toBe(false);
    expect(finding.ratio).toBeGreaterThan(1.05);
    expect(finding.ratio).toBeLessThan(AA_NORMAL);
    expect(finding.detail).toMatch(/below the 4\.5:1 required/);
    expect(
      finding.detail,
      "text that is merely faint must not be described as the same colour",
    ).not.toMatch(/same colour|invisible/);
  });

  /**
   * The background counterpart to the unresolvable-foreground case below.
   *
   * A background the module cannot read is a background it cannot score, and the rule
   * this whole file exists for is that an unscored element is a FAILURE, never a skip.
   * `backgroundImage: "none"` sends this down the solid path, so an unparseable
   * `backgroundColor` — a bare `var()` that never resolved, say — lands here.
   */
  it("fails rather than skips when the BACKGROUND cannot be resolved", () => {
    const finding = checkElement({
      selector: "#unknown-bg",
      color: "rgb(0, 0, 0)",
      backgroundColor: "var(--surface)",
      backgroundImage: "none",
      fontSizePx: 16,
      bold: false,
    });
    expect(finding.ok).toBe(false);
    expect(finding.ratio).toBe(0);
    expect(finding.detail).toMatch(/could not resolve the background "var\(--surface\)"/);
    expect(finding.detail).toMatch(/treated as a failure rather than skipped/);
  });

  /** An unreadable value must fail, never be skipped — skipping is how holes appear. */
  it("fails rather than skips when a colour cannot be resolved", () => {
    const finding = checkElement({
      selector: "#weird",
      color: "currentColor",
      backgroundColor: "rgb(255,255,255)",
      backgroundImage: "none",
      fontSizePx: 16,
      bold: false,
    });
    expect(finding.ok).toBe(false);
    expect(finding.detail).toMatch(/treated as a failure rather than skipped/);
  });
});

describe("assessA11y", () => {
  /**
   * THE test. Measured in a real browser: two black-on-black buttons produced
   * `violations: []` — zero — and two `incomplete` entries. A gate that checks only
   * violations passes a page whose buttons cannot be read.
   */
  it("fails on axe 'incomplete', which is a non-verdict rather than a pass", () => {
    const result = assessA11y({
      axe: {
        violations: [],
        incomplete: [
          { id: "color-contrast", nodes: [{ target: ["#solid"] }, { target: ["#grad"] }] },
        ],
      },
    });
    expect(result.ok, "incomplete must never count as a pass").toBe(false);
    expect(result.unresolved).toHaveLength(2);
    expect(formatA11y(result)).toMatch(/could not decide.*NOT a pass/);
  });

  it("passes when axe is clean and every measured element is readable", () => {
    const result = assessA11y({
      axe: { violations: [], incomplete: [] },
      elements: [
        {
          selector: "#a",
          color: "rgb(0,0,0)",
          backgroundColor: "rgb(255,255,255)",
          backgroundImage: "none",
          fontSizePx: 16,
          bold: false,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(formatA11y(result)).toMatch(/1 interactive elements measured/);
  });

  it("reports real axe violations too", () => {
    const result = assessA11y({
      axe: { violations: [{ id: "button-name", nodes: [{ target: ["button"] }] }], incomplete: [] },
    });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatch(/button-name/);
  });

  /**
   * ══ Running with no axe result at all ══
   *
   * `assessA11y` is designed to stand alone — a project that has not wired axe in yet,
   * or a page where axe crashed, should still get the measured contrast verdict. The
   * `?? []` fallbacks on `violations` and `incomplete` are what make that work, and they
   * had never been reached: every existing test passed an `axe` object.
   *
   * The failure this catches is a `TypeError` on `undefined.flatMap` — which would take
   * out the entire accessibility check for the projects that need it most, since the
   * ones without axe have no other contrast signal at all.
   */
  it("works with no axe result at all, judging on its own measurement", () => {
    const bad = assessA11y({
      elements: [
        {
          selector: "#solo",
          color: "rgb(0,0,0)",
          backgroundColor: "rgb(0,0,0)",
          backgroundImage: "none",
          fontSizePx: 16,
          bold: false,
        },
      ],
    });
    expect(bad.violations, "no axe result means no axe findings, not a crash").toEqual([]);
    expect(bad.unresolved).toEqual([]);
    expect(bad.ok, "our own measurement must still fail an invisible button").toBe(false);
    expect(bad.contrast[0]?.detail).toMatch(/invisible/);
  });

  /** And with neither axe nor elements: nothing measured is vacuously ok, but reported. */
  it("reports zero measured elements rather than throwing on an empty call", () => {
    const empty = assessA11y({});
    expect(empty).toEqual({ ok: true, violations: [], unresolved: [], contrast: [] });
    expect(formatA11y(empty)).toMatch(/0 interactive elements measured/);
  });

  it("fails on our own measurement even when axe says nothing at all", () => {
    const result = assessA11y({
      axe: { violations: [], incomplete: [] },
      elements: [
        {
          selector: "#invisible",
          color: "rgb(0,0,0)",
          backgroundColor: "rgb(0,0,0)",
          backgroundImage: "none",
          fontSizePx: 16,
          bold: false,
        },
      ],
    });
    expect(result.ok, "our measurement stands on its own").toBe(false);
  });
});

describe("formatA11y findings sections", () => {
  /**
   * ══ The branches nobody had rendered ══
   *
   * A coverage audit found all three sections of this formatter had never executed — the
   * existing tests only formatted passing results. This is the text a developer reads
   * when accessibility fails, so an unrendered branch means the first person to see it is
   * the first person it has ever run for.
   *
   * The `unresolved` section matters most: this repo's own rule is that axe returning
   * `incomplete` on a gradient background is a **failure, not a pass** — a black-on-black
   * button survived weeks in a prior project that way. The heading has to say so.
   */
  it("renders axe violations", () => {
    const text = formatA11y({
      ok: false,
      violations: ["color-contrast: insufficient ratio on .cta"],
      unresolved: [],
      contrast: [],
    });
    expect(text).toContain("ACCESSIBILITY FAILED");
    expect(text).toContain("axe violations (1)");
    expect(text).toContain("✗ color-contrast");
  });

  it("renders unresolved results and says they are NOT a pass", () => {
    const text = formatA11y({
      ok: false,
      violations: [],
      unresolved: ["color-contrast incomplete on .hero (gradient background)"],
      contrast: [],
    });
    expect(text).toContain("could not decide (1)");
    expect(text, "an incomplete result must never read as a pass").toContain("NOT a pass");
    expect(text).toContain("? color-contrast incomplete");
  });

  it("renders measured contrast failures", () => {
    const text = formatA11y({
      ok: false,
      violations: [],
      unresolved: [],
      contrast: [
        {
          ok: false,
          selector: ".btn",
          ratio: 1.2,
          required: 4.5,
          detail: "1.2:1 against a required 4.5:1",
        },
      ],
    });
    expect(text).toContain("measured contrast failures (1)");
    expect(text).toContain("✗ .btn");
  });

  /** All three at once, each under its own heading. */
  it("keeps the three sections separate", () => {
    const text = formatA11y({
      ok: false,
      violations: ["v"],
      unresolved: ["u"],
      contrast: [{ ok: false, selector: ".c", ratio: 1, required: 4.5, detail: "d" }],
    });
    expect(text).toContain("axe violations (1)");
    expect(text).toContain("could not decide (1)");
    expect(text).toContain("measured contrast failures (1)");
  });
});
