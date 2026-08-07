import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assessCanvas, type CanvasObservation, checkCanvases } from "./canvas.js";
import {
  type AnimationObservation,
  assessFrames,
  assessMotion,
  DEFAULT_JANK_TOLERANCE,
  FRAME_BUDGET_MS,
  isEndless,
  type MotionObservation,
} from "./motion.js";

/**
 * Property-based tests for the UI checks.
 *
 * ══ The failure mode these guard against ══
 *
 * The example tests pin behaviour on defects measured in a real browser. What they cannot
 * cover is the risk that gets a check deleted: **a false positive on a page that is fine.**
 *
 * An agent that receives a spurious finding does not shrug — it edits working code. Told
 * its animation is janky, it rewrites a smooth one. Told a canvas is blank, it adds
 * drawing to a canvas that was already correct. So the properties below are mostly
 * negative: over a generated space of well-formed input, the output must be empty.
 *
 * This matters more here than for most checks, because the styles this repo supports are
 * unusual by design. A sparse dot-field canvas, a deliberately low-resolution pixel-art
 * buffer and a page with no animation at all are all *correct*, and all sit close to the
 * shapes a naive check would flag.
 */

/** A correct animation: composited properties, finite, running. */
const healthyAnimation: fc.Arbitrary<AnimationObservation> = fc
  .tuple(
    fc.constantFrom("#a", "#b", ".card", ".hero"),
    fc.constantFrom("fade", "spin", "pulse"),
    fc.integer({ min: 1, max: 100 }),
    fc.integer({ min: 50, max: 5000 }),
    fc.constantFrom<readonly string[]>(["transform"], ["opacity"], ["transform", "opacity"]),
  )
  .map(([selector, name, iterations, durationMs, properties]) => ({
    selector,
    name,
    iterations,
    durationMs,
    playState: "running" as const,
    properties,
  }));

/** Frame deltas that a healthy page produces: measured median was 16.7ms. */
const smoothDeltas = fc.array(fc.double({ min: 8, max: 20, noNaN: true }), {
  minLength: 20,
  maxLength: 60,
});

describe("no false positives on correct motion", () => {
  /**
   * The property that matters most. A page whose animations are finite, running and
   * composited, at a healthy frame rate, must produce nothing at all.
   */
  it("never reports a finding for a well-formed page", () => {
    fc.assert(
      fc.property(
        fc.array(healthyAnimation, { maxLength: 6 }),
        smoothDeltas,
        (animations, deltasMs) => {
          const observation: MotionObservation = {
            animations,
            frames: { deltasMs },
            reducedMotionRequested: false,
            runningUnderReducedMotion: [],
          };
          expect(assessMotion(observation)).toEqual([]);
        },
      ),
    );
  });

  /**
   * A page with no animation is not a broken page. Several of the supported styles —
   * dense fintech tables, minimalist black-and-white — legitimately have none, and a
   * check that demanded motion would flag all of them.
   */
  it("never demands that a page animate", () => {
    fc.assert(
      fc.property(smoothDeltas, (deltasMs) => {
        expect(
          assessMotion({
            animations: [],
            frames: { deltasMs },
            reducedMotionRequested: false,
            runningUnderReducedMotion: [],
          }),
        ).toEqual([]);
      }),
    );
  });

  /**
   * Under reduced motion, a page that stopped its animations is correct. Only those
   * still running are a finding — reporting the compliant case would punish the fix.
   */
  it("never penalises a page that honoured reduced motion", () => {
    fc.assert(
      fc.property(
        fc.array(healthyAnimation, { maxLength: 6 }),
        smoothDeltas,
        (animations, deltasMs) => {
          expect(
            assessMotion({
              animations: animations.map((a) => ({ ...a, playState: "finished" as const })),
              frames: { deltasMs },
              reducedMotionRequested: true,
              runningUnderReducedMotion: [],
            }),
          ).toEqual([]);
        },
      ),
    );
  });
});

describe("isEndless total behaviour", () => {
  /**
   * Both wire forms must agree, over every finite value. `Infinity` is what Playwright
   * delivers live; `null` is what any JSON hop produces. A caller must never get a
   * different verdict for the same animation depending on how it travelled.
   */
  it("classifies every finite iteration count as not endless", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (n) => {
        expect(isEndless(n)).toBe(false);
      }),
    );
  });

  it("agrees on both wire forms of an endless animation", () => {
    expect(isEndless(Number.POSITIVE_INFINITY)).toBe(isEndless(null));
  });
});

describe("jank assessment is monotone", () => {
  /**
   * Adding slower frames must never turn a reported page into a silent one.
   *
   * A threshold applied with an inverted comparison violates this immediately, over the
   * whole domain rather than at the two points an example test happens to pick.
   */
  it("never becomes silent as frames get slower", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 5, max: 400, noNaN: true }), { minLength: 15, maxLength: 40 }),
        (deltas) => {
          const flagged = assessFrames({ deltasMs: deltas }) !== undefined;
          if (!flagged) return;
          // Every delta at least as slow must still be flagged.
          const slower = deltas.map((d) => d * 2);
          expect(assessFrames({ deltasMs: slower })).toBeDefined();
        },
      ),
    );
  });

  /** A page where every frame is inside budget is never janky, at any sample size. */
  it("never reports jank when every frame is inside budget", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1, max: FRAME_BUDGET_MS * 2, noNaN: true }), {
          minLength: 10,
          maxLength: 200,
        }),
        (deltasMs) => {
          expect(assessFrames({ deltasMs })).toBeUndefined();
        },
      ),
    );
  });

  /** Below the minimum sample size, no verdict is reached whatever the timings. */
  it("stays silent below the minimum sample size", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1, max: 5000, noNaN: true }), { maxLength: 9 }),
        (deltasMs) => {
          expect(assessFrames({ deltasMs })).toBeUndefined();
        },
      ),
    );
  });

  it("uses the documented default tolerance", () => {
    expect(DEFAULT_JANK_TOLERANCE).toBe(0.2);
  });
});

describe("no false positives on correct canvases", () => {
  /**
   * ══ The aesthetics this must never break ══
   *
   * A sparse dot-and-line field measured 0.67% coverage, and pixel art deliberately
   * scales a small buffer up. Both are correct output for styles this repo exists to
   * support, and both sit exactly where a naive check would fire.
   */
  const healthyCanvas: fc.Arbitrary<CanvasObservation> = fc
    .tuple(
      fc.integer({ min: 1, max: 4096 }),
      fc.integer({ min: 1, max: 4096 }),
      fc.double({ min: 0.002, max: 1, noNaN: true }),
      fc.integer({ min: 2, max: 4096 }),
    )
    .map(([size, cssSize, nonBlankRatio, distinctColours]) => ({
      selector: "#c",
      bufferWidth: size,
      bufferHeight: size,
      cssWidth: cssSize,
      cssHeight: cssSize,
      // dpr 1: the buffer-vs-CSS defect provably cannot exist here, so any buffer size
      // is legitimate — including a small one scaled up, which IS pixel art.
      devicePixelRatio: 1,
      contextType: "2d" as const,
      nonBlankRatio,
      distinctColours,
      digest: "abc",
    }));

  it("never reports a canvas that drew something at devicePixelRatio 1", () => {
    fc.assert(
      fc.property(healthyCanvas, (observation) => {
        expect(assessCanvas(observation)).toEqual([]);
      }),
    );
  });

  /**
   * An unreadable canvas is skipped rather than failed. A WebGL canvas without
   * `preserveDrawingBuffer` and one holding a cross-origin image are both correct code
   * that cannot be read, and reporting them would train a caller to ignore this check.
   */
  it("never reports a canvas it could not read", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("unreadable", "tainted"),
        fc.integer({ min: 1, max: 4096 }),
        (digest, size) => {
          expect(
            checkCanvases([
              {
                selector: "#gl",
                bufferWidth: size,
                bufferHeight: size,
                cssWidth: size,
                cssHeight: size,
                devicePixelRatio: 2,
                contextType: "webgl2",
                nonBlankRatio: -1,
                distinctColours: -1,
                digest,
              },
            ]).findings,
          ).toEqual([]);
        },
      ),
    );
  });

  /**
   * A correctly scaled retina canvas must pass at every ratio and size. This is the
   * pattern the check tells people to adopt, so flagging it would be self-defeating.
   */
  it("never reports a correctly scaled retina canvas", () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 1000 }), fc.constantFrom(2, 3), (cssSize, dpr) => {
        expect(
          assessCanvas({
            selector: "#c",
            bufferWidth: cssSize * dpr,
            bufferHeight: cssSize * dpr,
            cssWidth: cssSize,
            cssHeight: cssSize,
            devicePixelRatio: dpr,
            contextType: "2d",
            nonBlankRatio: 0.5,
            distinctColours: 100,
            digest: "abc",
          }),
        ).toEqual([]);
      }),
    );
  });

  /** Every finding names the canvas it concerns, or a caller cannot act on it. */
  it("always attributes a finding to a selector", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 10 }),
        fc.constantFrom(1, 2, 3),
        (nonBlankRatio, distinctColours, devicePixelRatio) => {
          const findings = assessCanvas({
            selector: "#target",
            bufferWidth: 100,
            bufferHeight: 100,
            cssWidth: 100,
            cssHeight: 100,
            devicePixelRatio,
            contextType: "2d",
            nonBlankRatio,
            distinctColours,
            digest: "abc",
          });
          for (const finding of findings) expect(finding.selector).toBe("#target");
        },
      ),
    );
  });
});
