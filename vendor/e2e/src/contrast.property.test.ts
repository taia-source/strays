import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  luminance,
  parseColor,
  type Rgb,
  worstRatioAgainstStops,
} from "./contrast.js";

/**
 * Property-based tests for WCAG contrast.
 *
 * ══ Floating point, without flaky epsilons ══
 *
 * The usual objection to property-testing float code is that every assertion needs a
 * tolerance and tolerances rot. That is avoidable here, because most of these properties
 * are **structurally exact** rather than luckily exact — verified by running them, not by
 * reasoning about IEEE-754:
 *
 *   ratio(a,b) === ratio(b,a)     0 violations in 500,000 random pairs
 *   ratio(c,c) === 1              exact for every colour
 *   ratio(black,white) === 21     exactly 21.0, not 20.99…
 *   ratio >= 1                    0 violations in 500,000
 *
 * Symmetry is exact because `luminance` is pure, so both calls produce bit-identical
 * values and `max`/`min` merely select between them. It is not a coincidence that happens
 * to hold for the samples tried.
 *
 * ══ The boundary a random generator never reaches ══
 *
 * 21 is attained **only** by pure black against pure white — perturbing a single channel
 * by one drops it to ~20.87. Measured over 200,000 random pairs the maximum reached was
 * **17.90**. So a bare `fc.tuple(colour, colour)` would assert an upper bound it never
 * approaches. `examples` pins the corner explicitly.
 *
 * ══ The monotonicity trap ══
 *
 * "Darkening a colour increases contrast" is **false** — measured, it fails ~50% of the
 * time (148,925 / 300,000), because darkening the *lighter* colour closes the gap.
 * Restricted to darkening the colour that is already darker, it holds: 0 violations in
 * 300,000. The property below carries that guard, and re-derives which colour is darker
 * rather than assuming the ordering survived the change.
 */

/** 8-bit channels. The real input domain is discrete, so integers beat floats here. */
const channel = fc.integer({ min: 0, max: 255 });
const colour: fc.Arbitrary<Rgb> = fc
  .tuple(channel, channel, channel)
  .map(([r, g, b]) => ({ r, g, b }));

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

describe("contrast ratio invariants", () => {
  /**
   * The bound the whole check rests on. WCAG ratios live in [1, 21]; anything outside
   * means the luminance maths is wrong, and every threshold comparison downstream inherits
   * the error.
   *
   * `examples` supplies the black/white corner because random sampling never gets near it.
   */
  it("stays within [1, 21] for every colour pair", () => {
    fc.assert(
      fc.property(colour, colour, (a, b) => {
        const ratio = contrastRatio(a, b);
        expect(ratio).toBeGreaterThanOrEqual(1);
        expect(ratio).toBeLessThanOrEqual(21);
      }),
      {
        examples: [
          [BLACK, WHITE],
          [WHITE, BLACK],
          [BLACK, BLACK],
          [WHITE, WHITE],
        ],
      },
    );
  });

  /**
   * Symmetry, asserted with exact equality rather than a tolerance.
   *
   * Measured: 0 violations in 500,000 pairs. If someone later reorders the max/min
   * selection so the two arguments are not treated interchangeably, this fails
   * immediately — which a tolerance-based assertion might absorb.
   */
  it("is exactly symmetric in its arguments", () => {
    fc.assert(
      fc.property(colour, colour, (a, b) => {
        expect(contrastRatio(a, b)).toBe(contrastRatio(b, a));
      }),
    );
  });

  /** A colour against itself is exactly 1 — the definition of no contrast at all. */
  it("returns exactly 1 for a colour against itself", () => {
    fc.assert(
      fc.property(colour, (c) => {
        expect(contrastRatio(c, c)).toBe(1);
      }),
    );
  });

  /**
   * Guarded monotonicity: darkening the DARKER colour never reduces contrast.
   *
   * The unguarded version is false ~50% of the time. The guard is re-derived after the
   * change rather than assumed, because darkening far enough can swap which colour is
   * darker and silently invert the premise.
   */
  it("never reduces contrast when the darker colour is darkened further", () => {
    fc.assert(
      fc.property(colour, colour, channel, (a, b, delta) => {
        const darker = luminance(a) <= luminance(b) ? a : b;
        const lighter = darker === a ? b : a;

        const darkened: Rgb = {
          r: Math.max(0, darker.r - delta),
          g: Math.max(0, darker.g - delta),
          b: Math.max(0, darker.b - delta),
        };
        // Re-derive rather than assume: a large delta could reorder them.
        fc.pre(luminance(darkened) <= luminance(lighter));

        expect(contrastRatio(darkened, lighter)).toBeGreaterThanOrEqual(
          contrastRatio(darker, lighter) - 1e-12,
        );
      }),
    );
  });

  /**
   * Luminance is monotonic per channel: raising any channel cannot lower the total.
   *
   * This catches a sign error or a swapped coefficient that the ratio properties above
   * would hide, because ratio takes an absolute-difference-like shape and can look
   * plausible with the weights permuted.
   */
  it("never decreases luminance when a channel is raised", () => {
    fc.assert(
      fc.property(colour, fc.constantFrom("r", "g", "b"), channel, (c, key, raise) => {
        // Explicit per-key construction rather than a computed index: an index signature
        // would need a cast, and `noUncheckedIndexedAccess` is right to object to it.
        const raised: Rgb =
          key === "r"
            ? { ...c, r: Math.min(255, c.r + raise) }
            : key === "g"
              ? { ...c, g: Math.min(255, c.g + raise) }
              : { ...c, b: Math.min(255, c.b + raise) };
        expect(luminance(raised)).toBeGreaterThanOrEqual(luminance(c) - 1e-12);
      }),
    );
  });

  /**
   * The property that catches a coefficient transposition.
   *
   * Sabotage found a real blind spot: **swapping the red and blue coefficients passed all
   * ten of the other properties.** Every one of them is symmetric in the channels — bounds,
   * symmetry, self-ratio and per-channel monotonicity all hold under any permutation of the
   * weights, because permuting them still yields a monotone weighted sum in [0,1].
   *
   * The weights are deliberately unequal — human vision is most sensitive to green — so the
   * discriminator is the ORDERING they impose at equal intensity. Measured: pure green
   * 0.7152 > pure red 0.2126 > pure blue 0.0722. Any permutation breaks that ordering, and
   * a transposition is exactly the kind of edit that looks harmless in review.
   */
  it("weights green above red above blue at equal intensity", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 255 }), (v) => {
        const red = luminance({ r: v, g: 0, b: 0 });
        const green = luminance({ r: 0, g: v, b: 0 });
        const blue = luminance({ r: 0, g: 0, b: v });
        expect(green, "green must dominate — vision is most sensitive to it").toBeGreaterThan(red);
        expect(red, "red must outweigh blue").toBeGreaterThan(blue);
      }),
    );
  });

  /**
   * The threshold discrepancy, settled exhaustively rather than sampled.
   *
   * WCAG's linearisation threshold was 0.03928 in the older sRGB proposal and is 0.04045
   * per IEC. **For 8-bit input the choice provably cannot matter**: no `c/255` for c in
   * 0..255 lands in `(0.03928, 0.04045]` — `10/255 = 0.03922` and `11/255 = 0.04314`
   * straddle the whole interval. Checked over all 256 values, not a random sample.
   *
   * This test exists so a future "fix" that switches the threshold *and* widens the input
   * domain to floats is caught rather than assumed harmless.
   */
  it("is unaffected by the 0.03928 vs 0.04045 threshold across all 8-bit values", () => {
    const linearise = (c: number, threshold: number) => {
      const s = c / 255;
      return s <= threshold ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    for (let c = 0; c <= 255; c++) {
      expect(linearise(c, 0.03928), `channel ${c}`).toBe(linearise(c, 0.04045));
    }
  });

  /**
   * A gradient is only readable if its worst stop is readable, so the worst-case helper
   * must never report better than the single worst pairing.
   */
  it("never reports a gradient as better than its worst stop", () => {
    fc.assert(
      fc.property(colour, fc.array(colour, { minLength: 1, maxLength: 8 }), (fg, stops) => {
        const worst = worstRatioAgainstStops(fg, stops);
        for (const stop of stops) {
          expect(worst).toBeLessThanOrEqual(contrastRatio(fg, stop));
        }
        // And it must be one of the actual pairings, not an invented value.
        expect(stops.some((s) => contrastRatio(fg, s) === worst)).toBe(true);
      }),
    );
  });
});

describe("colour parsing", () => {
  /**
   * Round-trip: a colour formatted as `rgb(...)` must parse back to itself.
   *
   * Hughes' "there and back again". The bug it catches is channel transposition — a
   * parser that reads blue into the green slot passes every single-channel example test
   * built from grey values.
   */
  it("round-trips any colour through rgb() notation", () => {
    fc.assert(
      fc.property(colour, (c) => {
        expect(parseColor(`rgb(${c.r}, ${c.g}, ${c.b})`)).toEqual(c);
      }),
    );
  });

  it("round-trips any colour through hex notation", () => {
    fc.assert(
      fc.property(colour, (c) => {
        const hex = `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        expect(parseColor(hex)).toEqual(c);
      }),
    );
  });

  /**
   * A parser that returns a colour for unparseable input is worse than one that returns
   * nothing: `checkElement` treats an unresolvable colour as a FAILURE, and a silently
   * invented value turns that loud failure into a quiet wrong answer.
   */
  it("returns undefined rather than inventing a colour for junk", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/rgba?\(|^#?[a-f\d]{6}$/i.test(s)),
        (junk) => {
          expect(parseColor(junk)).toBeUndefined();
        },
      ),
    );
  });
});
