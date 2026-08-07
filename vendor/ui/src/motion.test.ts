import { describe, expect, it } from "vitest";
import {
  type AnimationObservation,
  assessFrames,
  assessMotion,
  checkMotion,
  compositedAlternative,
  DEFAULT_JANK_TOLERANCE,
  FRAME_BUDGET_MS,
  findDeclaredButUnregistered,
  formatMotion,
  isEndless,
  type MotionObservation,
} from "./motion.js";

/**
 * ══ These values came off a real browser ══
 *
 * The numbers below were measured on this machine's headless Chromium before being used:
 * a 16.7ms median rAF delta, `iterations` arriving as `null` rather than `Infinity` after
 * the JSON crossing, and an unresolvable keyframe name producing no animation object at
 * all. Each is quoted at the test that depends on it, because each is a claim about how a
 * browser behaves rather than about this code.
 */

const animation = (over: Partial<AnimationObservation> = {}): AnimationObservation => ({
  selector: "#el",
  name: "fade",
  iterations: 1,
  durationMs: 300,
  playState: "running",
  properties: ["opacity"],
  ...over,
});

/** 40 frames at a steady 60Hz — what a healthy page produced when measured. */
const smoothFrames = { deltasMs: Array.from({ length: 40 }, () => 16.7) };

const observation = (over: Partial<MotionObservation> = {}): MotionObservation => ({
  animations: [],
  frames: smoothFrames,
  reducedMotionRequested: false,
  runningUnderReducedMotion: [],
  ...over,
});

describe("isEndless", () => {
  /**
   * The JSON boundary, measured:
   *
   *     { sel: 'inf', raw: null, isInfinity: true, afterJSON: null }
   *
   * In-page the value really is `Infinity`; by the time it reaches this process it is
   * `null`. A check written as `!Number.isFinite(x)` appeared to work and was right for
   * the wrong reason, since `Number.isFinite(null)` is also false.
   */
  it("treats null as endless, because Infinity does not survive JSON", () => {
    expect(isEndless(null)).toBe(true);
  });

  it("treats Infinity as endless for an in-process caller", () => {
    expect(isEndless(Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("treats a finite count as not endless", () => {
    expect(isEndless(1)).toBe(false);
    expect(isEndless(1000)).toBe(false);
  });

  /**
   * `undefined` means the field was absent, which is a different claim from "endless".
   * Reporting a missing field as an infinite animation would be a false positive on
   * every observation that failed to collect one.
   */
  it("does not treat a missing field as endless", () => {
    expect(isEndless(undefined)).toBe(false);
  });

  /** Zero iterations is a real value: the animation is declared but plays no cycles. */
  it("does not treat zero as endless", () => {
    expect(isEndless(0)).toBe(false);
  });
});

describe("assessMotion", () => {
  it("is silent on a healthy page", () => {
    expect(assessMotion(observation({ animations: [animation()] }))).toEqual([]);
  });

  /** WCAG 2.2.2 is Level A, so this blocks rather than warns. */
  it("flags an endless animation as a high-severity accessibility failure", () => {
    const findings = assessMotion(observation({ animations: [animation({ iterations: null })] }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("endless-without-reduced-motion");
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.detail).toContain("2.2.2");
  });

  /**
   * ══ A correction the specification forced ══
   *
   * This module originally advised wrapping an endless animation in a
   * `prefers-reduced-motion` query to satisfy 2.2.2. That is wrong, and verified wrong at
   * w3.org: technique **C39 states it "relates to 2.3.3 Animation from Interactions
   * (Sufficient)"** — 2.3.3 only — while 2.2.2's sufficient techniques are G4, SCR33,
   * G11, G152, SCR22, G186 and G191, every one a control or a time limit.
   *
   * The practical consequence is what makes it worth a test: the old advice would have
   * left someone believing they had fixed a Level A failure they had not, since a media
   * query does nothing for the majority who never set the OS preference.
   */
  it("asks for a pause control, not merely a reduced-motion query", () => {
    const detail =
      assessMotion(observation({ animations: [animation({ iterations: null })] }))[0]?.detail ?? "";
    expect(detail, "G4/G186/G191 are the sufficient techniques for 2.2.2").toMatch(/G4|G186|G191/);
    expect(detail, "the media query must not be presented as satisfying Level A").toContain(
      "NOT sufficient",
    );
  });

  /** A finite animation, however long, is not the 2.2.2 case. */
  it("does not flag a long but finite animation", () => {
    expect(
      assessMotion(observation({ animations: [animation({ durationMs: 60_000, iterations: 1 })] })),
    ).toEqual([]);
  });

  /**
   * An endless animation that is paused is not running, so it is not "automatic motion".
   * Flagging it would report every correctly-paused animation as a failure.
   */
  it("does not flag an endless animation that is paused", () => {
    expect(
      assessMotion(
        observation({ animations: [animation({ iterations: null, playState: "paused" })] }),
      ),
    ).toEqual([]);
  });

  /** Under reduced motion the endless rule is suppressed — the separate rule applies. */
  it("does not double-report an endless animation under reduced motion", () => {
    const findings = assessMotion(
      observation({
        animations: [animation({ iterations: null })],
        reducedMotionRequested: true,
        runningUnderReducedMotion: ["#el"],
      }),
    );
    expect(findings.map((f) => f.kind)).toEqual(["ignores-reduced-motion"]);
  });

  it("flags animation still running under prefers-reduced-motion", () => {
    const findings = assessMotion(
      observation({ reducedMotionRequested: true, runningUnderReducedMotion: ["#hero"] }),
    );
    expect(findings[0]?.kind).toBe("ignores-reduced-motion");
    expect(findings[0]?.severity).toBe("high");
  });

  /**
   * Layout-triggering properties. The animation is functionally correct, which is exactly
   * why nothing else catches it — it simply feels wrong on a mid-range phone.
   */
  it("flags animation of layout-triggering properties", () => {
    const findings = assessMotion(
      observation({ animations: [animation({ properties: ["left"] })] }),
    );
    expect(findings[0]?.kind).toBe("layout-thrashing");
    expect(findings[0]?.severity).toBe("medium");
  });

  it("accepts transform and opacity, which composite on the GPU", () => {
    expect(
      assessMotion(
        observation({ animations: [animation({ properties: ["transform", "opacity"] })] }),
      ),
    ).toEqual([]);
  });

  /** Keyframes report camelCase; the collector normalises to kebab. Both must match. */
  it("recognises a layout property however it was spelled", () => {
    const findings = assessMotion(
      observation({ animations: [animation({ properties: ["margin-left"] })] }),
    );
    expect(findings[0]?.kind).toBe("layout-thrashing");
  });

  it("flags a registered animation that never played", () => {
    const findings = assessMotion(observation({ animations: [animation({ playState: "idle" })] }));
    expect(findings[0]?.kind).toBe("never-started");
  });

  /** Every finding is reported, so one re-render surfaces them all. */
  it("reports every finding rather than the first", () => {
    const findings = assessMotion(
      observation({
        animations: [
          animation({ selector: "#a", iterations: null }),
          animation({ selector: "#b", properties: ["width"] }),
          animation({ selector: "#c", playState: "idle" }),
        ],
      }),
    );
    expect(findings.map((f) => f.kind).sort()).toEqual([
      "endless-without-reduced-motion",
      "layout-thrashing",
      "never-started",
    ]);
  });
});

describe("findDeclaredButUnregistered", () => {
  /**
   * ══ The blind spot this exists for, measured ══
   *
   * On a page with `#good`, `#thrash` and `#miss { animation: doesNotExist 1s }`:
   *
   *     declared:   [#good, #thrash, #miss]
   *     registered: [#good, #thrash]
   *
   * The element with the bad keyframe name produced **no animation object at all**, so
   * `getAnimations()` cannot see it. This is the single most likely animation bug in
   * generated code: a typo yields an element that just sits there, with nothing logged.
   */
  it("catches an animation-name that matches no keyframes", () => {
    const findings = findDeclaredButUnregistered({
      declared: [
        { selector: "#good", animationName: "spin" },
        { selector: "#miss", animationName: "doesNotExist" },
      ],
      registered: ["#good"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.selector).toBe("#miss");
    expect(findings[0]?.kind).toBe("never-started");
    expect(findings[0]?.detail).toContain("doesNotExist");
  });

  it("is silent when every declared animation registered", () => {
    expect(
      findDeclaredButUnregistered({
        declared: [{ selector: "#a", animationName: "spin" }],
        registered: ["#a"],
      }),
    ).toEqual([]);
  });

  it("is silent when nothing is declared", () => {
    expect(findDeclaredButUnregistered({ declared: [], registered: [] })).toEqual([]);
  });

  /** Runs through assessMotion too, not only when called directly. */
  it("is applied by assessMotion when declared data is present", () => {
    const findings = assessMotion(
      observation({
        animations: [],
        declared: [{ selector: "#miss", animationName: "nope" }],
      }),
    );
    expect(findings[0]?.kind).toBe("never-started");
  });

  /** A caller without CSS-side data must not get phantom findings. */
  it("is skipped when no declared data was collected", () => {
    expect(assessMotion(observation({ animations: [] }))).toEqual([]);
  });
});

describe("assessFrames", () => {
  it("is silent on steady 60fps", () => {
    expect(assessFrames(smoothFrames)).toBeUndefined();
  });

  it("reports sustained stutter", () => {
    const finding = assessFrames({ deltasMs: Array.from({ length: 40 }, () => 50) });
    expect(finding?.kind).toBe("janky");
  });

  /**
   * Too few samples is not evidence. A verdict from four frames would fire on any page
   * whose first frames were slow — which is all of them.
   */
  it("says nothing from too few samples", () => {
    expect(assessFrames({ deltasMs: [50, 50, 50] })).toBeUndefined();
  });

  it("says nothing about an empty sample", () => {
    expect(assessFrames({ deltasMs: [] })).toBeUndefined();
  });

  /**
   * The median, not the mean. The first frames after navigation are always slow, and a
   * mean-based check reports every page as janky on first render.
   */
  it("tolerates a few slow frames among many good ones", () => {
    const deltas = [...Array.from({ length: 36 }, () => 16.7), 120, 120, 120, 120];
    expect(assessFrames({ deltasMs: deltas })).toBeUndefined();
  });

  /**
   * ══ Boundaries, both sides ══
   *
   * The fencepost class has survived sabotage repeatedly in this repo. The rule is
   * "report when the dropped ratio EXCEEDS tolerance", so exactly at tolerance must be
   * silent and one frame beyond must report.
   */
  it("is silent at exactly the tolerance", () => {
    // 8 of 40 = 0.2, exactly DEFAULT_JANK_TOLERANCE.
    const deltas = [
      ...Array.from({ length: 32 }, () => 16.7),
      ...Array.from({ length: 8 }, () => 100),
    ];
    expect(DEFAULT_JANK_TOLERANCE).toBe(0.2);
    expect(assessFrames({ deltasMs: deltas })).toBeUndefined();
  });

  it("reports one frame beyond the tolerance", () => {
    const deltas = [
      ...Array.from({ length: 31 }, () => 16.7),
      ...Array.from({ length: 9 }, () => 100),
    ];
    expect(assessFrames({ deltasMs: deltas })?.kind).toBe("janky");
  });

  /**
   * A dropped frame is one exceeding TWICE the budget. A frame at exactly 2× is not yet
   * dropped; just beyond it is.
   */
  it("does not count a frame at exactly twice the budget as dropped", () => {
    const deltas = Array.from({ length: 40 }, () => FRAME_BUDGET_MS * 2);
    expect(assessFrames({ deltasMs: deltas })).toBeUndefined();
  });

  it("counts a frame beyond twice the budget as dropped", () => {
    const deltas = Array.from({ length: 40 }, () => FRAME_BUDGET_MS * 2 + 0.1);
    expect(assessFrames({ deltasMs: deltas })?.kind).toBe("janky");
  });

  /**
   * ══ The statistic itself, not just the verdict ══
   *
   * Sabotage found this: replacing the median with the mean survived all 36 tests,
   * because every jank assertion checked only `kind` and never the number reported.
   *
   * On 30 frames at 16.7ms plus 10 at 500ms, measured both ways:
   *
   *     median  16.7ms      ← most frames are fine; a few are catastrophic
   *     mean   137.5ms      ← reads as though the whole page runs at 7fps
   *
   * An 8× difference in what the developer is told. The mean sends someone to optimise
   * a page that is mostly smooth, so the reported figure is asserted here, not only the
   * fact that something was reported.
   */
  it("reports the median frame time, not the mean", () => {
    const deltas = [
      ...Array.from({ length: 30 }, () => 16.7),
      ...Array.from({ length: 10 }, () => 500),
    ];
    const detail = assessFrames({ deltasMs: deltas })?.detail ?? "";
    expect(detail, "the mean would read 137.5ms and misrepresent a mostly-smooth page").toContain(
      "median 16.7ms",
    );
  });

  /**
   * ══ The index itself, not just the statistic ══
   *
   * Sabotage found this: replacing `sorted[Math.floor(len/2)]` with `sorted[0]` passed all
   * 45 tests, because every existing fixture had its minimum equal to its median.
   *
   * This one separates all three — 10 frames at 16.7ms, 15 at 90ms, 15 at 500ms. The
   * minimum is 16.7, the median is 90 and the maximum is 500, so reading the wrong index
   * reports a visibly wrong number rather than a coincidentally right one.
   */
  it("reads the middle of the sorted sample, not an end of it", () => {
    const deltas = [
      ...Array.from({ length: 10 }, () => 16.7),
      ...Array.from({ length: 15 }, () => 90),
      ...Array.from({ length: 15 }, () => 500),
    ];
    const detail = assessFrames({ deltasMs: deltas })?.detail ?? "";
    expect(detail, "sorted[0] would report 16.7ms and the max would report 500ms").toContain(
      "median 90.0ms",
    );
  });

  it("honours a caller-supplied tolerance", () => {
    const deltas = [
      ...Array.from({ length: 35 }, () => 16.7),
      ...Array.from({ length: 5 }, () => 100),
    ];
    expect(assessFrames({ deltasMs: deltas })).toBeUndefined();
    expect(assessFrames({ deltasMs: deltas }, 0.1)?.kind).toBe("janky");
  });
});

describe("checkMotion", () => {
  it("is not ok when a high-severity finding is present", () => {
    expect(checkMotion(observation({ animations: [animation({ iterations: null })] })).ok).toBe(
      false,
    );
  });

  /** Medium findings are worth saying and do not block. */
  it("is ok when only medium findings are present", () => {
    const result = checkMotion(observation({ animations: [animation({ properties: ["left"] })] }));
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
  });
});

describe("formatMotion", () => {
  it("orders high severity first", () => {
    const text = formatMotion(
      checkMotion(
        observation({
          animations: [
            animation({ selector: "#thrash", properties: ["left"] }),
            animation({ selector: "#endless", iterations: null }),
          ],
        }),
      ),
    );
    expect(text.indexOf("#endless")).toBeLessThan(text.indexOf("#thrash"));
  });

  /**
   * A clean result must not claim the motion looks good — only that it runs, stops and
   * paces. Overclaiming is how a check becomes a false sense of coverage.
   */
  it("does not claim the motion looks good when clean", () => {
    expect(formatMotion({ ok: true, findings: [] })).toContain(
      "cannot judge whether the motion looks good",
    );
  });

  it("distinguishes clean from ok-with-warnings", () => {
    const result = checkMotion(observation({ animations: [animation({ properties: ["top"] })] }));
    expect(formatMotion(result)).toContain("warning");
  });
});

describe("compositedAlternative", () => {
  /**
   * A finding that only says "this is slow" leaves the reader to guess the fix, and a
   * guessed fix is often another layout-triggering property. Each geometry property maps
   * to the transform that replaces it.
   */
  it("maps geometry properties to the transform that replaces them", () => {
    expect(compositedAlternative("left")).toBe("transform: translate()");
    expect(compositedAlternative("margin-left")).toBe("transform: translate()");
    expect(compositedAlternative("width")).toBe("transform: scale()");
  });

  /** A property that is already composited needs no alternative. */
  it("suggests nothing for a property that already composites", () => {
    expect(compositedAlternative("transform")).toBeUndefined();
    expect(compositedAlternative("opacity")).toBeUndefined();
  });

  /** Inventing advice for an unknown property is worse than staying quiet. */
  it("suggests nothing rather than inventing advice", () => {
    expect(compositedAlternative("font-size")).toBeUndefined();
  });

  it("puts the suggestion in the finding", () => {
    const findings = assessMotion(
      observation({ animations: [animation({ properties: ["left"] })] }),
    );
    expect(findings[0]?.detail).toContain("transform: translate()");
  });
});

describe("untested paths found by coverage audit", () => {
  /**
   * ══ The fallback for a property with no mapping ══
   *
   * `padding` and `font-size` are layout-triggering but have no single composited
   * replacement — measured, `compositedAlternative` returns undefined for both while every
   * geometry property maps to a transform. The finding must still be actionable, so it
   * falls back to generic advice rather than emitting an empty "Use  instead".
   */
  it("gives generic advice for a layout property with no direct alternative", () => {
    const findings = assessMotion(
      observation({ animations: [animation({ properties: ["padding"] })] }),
    );
    expect(findings[0]?.kind).toBe("layout-thrashing");
    expect(findings[0]?.detail, "must not emit an empty suggestion").toContain(
      "transform or opacity",
    );
    expect(findings[0]?.detail).not.toContain("Use  instead");
  });

  /** Jank and per-animation findings are independent and must both surface at once. */
  it("reports jank alongside animation findings", () => {
    const findings = assessMotion(
      observation({
        animations: [animation({ iterations: null })],
        frames: { deltasMs: Array.from({ length: 40 }, () => 100) },
      }),
    );
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("endless-without-reduced-motion");
    expect(kinds).toContain("janky");
  });

  /** An even-length sample has no exact middle; the median must still be a real reading. */
  it("takes a median from an even number of samples", () => {
    const deltas = [
      ...Array.from({ length: 10 }, () => 16.7),
      ...Array.from({ length: 10 }, () => 200),
    ];
    const detail = assessFrames({ deltasMs: deltas })?.detail ?? "";
    expect(detail).toMatch(/median 200\.0ms|median 16\.7ms/);
  });
});
