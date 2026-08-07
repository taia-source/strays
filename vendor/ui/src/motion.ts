/**
 * Animation correctness — the class of defect no DOM check can see.
 *
 * ══ Why the existing checks are blind here ══
 *
 * `@taia/e2e` verifies a page's *static* end state: contrast, layout at five viewports,
 * perceivability, rendering defects, cross-engine divergence. Every one of them reads the
 * DOM after it has settled. An animation that never starts, never stops, or stutters is
 * invisible to all of them — the final frame looks correct, because it is.
 *
 * That matters for the UIs this repo is meant to produce. Idle animations, particle
 * fields, dot-and-line network graphics and scroll-linked motion are all *the product*,
 * not decoration, and all of them fail in ways a settled DOM cannot show.
 *
 * ══ What is measurable here, verified before being designed against ══
 *
 * Measured on this machine's headless Chromium and WebKit, not assumed:
 *
 *   requestAnimationFrame median delta   16.7ms   ← real 60fps timing, not a stub
 *   document.getAnimations().length      1        ← running animations are introspectable
 *   prefers-reduced-motion emulation     true     ← both engines
 *
 * So frame pacing and animation lifecycle are both genuinely observable. The checks below
 * rest on those two facts.
 *
 * ══ The three failures worth catching ══
 *
 * **1. It never started.** A CSS transition on a property that cannot animate, a keyframe
 * name that does not resolve, a library that failed to initialise. The element sits at its
 * initial value and the page looks merely static rather than broken.
 *
 * **2. It never stops.** `iterations: Infinity` on something meant to run once, or a rAF
 * loop with no exit. This drains battery on a phone and pins a CPU core, and the page
 * looks completely normal. It is also the reason an idle animation is more dangerous than
 * a triggered one: nobody is watching when it misbehaves.
 *
 * **3. It stutters.** Animating `left`/`top`/`width` instead of `transform`/`opacity`
 * forces layout every frame. The animation *works*, so every functional check passes, and
 * it still feels broken on a mid-range phone.
 *
 * ══ Accessibility is not optional here ══
 *
 * Two criteria apply, and **they are not satisfied by the same thing** — a distinction I
 * had wrong until it was checked against the specification itself:
 *
 *   **2.2.2 Pause, Stop, Hide — Level A.** *"For any moving, blinking or scrolling
 *   information that (1) starts automatically, (2) lasts more than five seconds, and
 *   (3) is presented in parallel with other content, there is a mechanism for the user to
 *   pause, stop, or hide it."* Its sufficient techniques are G4, SCR33, G11, G152, SCR22,
 *   G186 and G191 — **every one of them is a control or a time limit.**
 *
 *   **2.3.3 Animation from Interactions — Level AAA.** Technique C39 (the
 *   `prefers-reduced-motion` media query) states it *"relates to 2.3.3 Animation from
 *   Interactions (Sufficient)"* — and 2.3.3 only.
 *
 * So **`prefers-reduced-motion` does not satisfy Level A.** C39 appears nowhere in
 * 2.2.2's sufficient techniques, verified at w3.org. An endless animation wrapped in a
 * reduced-motion query is better than one without, and still fails 2.2.2 for every user
 * who has not set that OS preference — which is most of them.
 *
 * That is why {@link assessMotion} asks for a **pause control**, and why the finding says
 * so rather than recommending the media query alone. Telling someone to add a media query
 * would leave them believing they had fixed a Level A failure they had not.
 *
 * Vestibular disorders make this a genuine harm rather than a preference, which is why an
 * unhandled infinite animation is a failure rather than a warning.
 */

/** A single animation observed on the page, via `document.getAnimations()`. */
export type AnimationObservation = {
  readonly selector: string;
  /** Animation or transition name, when the engine reports one. */
  readonly name: string;
  /**
   * Iteration count — `Infinity` for an endless animation, the 2.2.2 case.
   *
   * ══ Both forms occur, and the reason took two measurements to pin down ══
   *
   * Playwright's own serialisation **preserves `Infinity`**. Verified on both engines:
   *
   *     chromium: { raw: Infinity, type: 'number', isInf: true, viaJSON: null }
   *     webkit:   { raw: Infinity, type: 'number', isInf: true, viaJSON: null }
   *
   * An earlier probe appeared to show `null` arriving instead, which is what the first
   * version of this comment claimed. That was an artefact of `console.log` formatting the
   * value as JSON — `viaJSON` above shows the difference: an **explicit**
   * `JSON.stringify` is what turns `Infinity` into `null`, and Playwright does not use
   * one.
   *
   * So `Infinity` is what a live collection yields, while `null` is what any caller who
   * routes the observation through JSON — a cache, a log file, an HTTP boundary — will
   * see. Both must be handled, which is exactly what {@link isEndless} does. Testing
   * `!Number.isFinite(x)` alone would be right for `Infinity` and right by accident for
   * `null`, since `Number.isFinite(null)` is also false — and wrong for a genuinely
   * missing field.
   */
  readonly iterations: number | null;
  /** One iteration, in milliseconds. */
  readonly durationMs: number;
  readonly playState: "idle" | "running" | "paused" | "finished";
  /** Properties the animation actually changes. */
  readonly properties: readonly string[];
};

export type FrameSample = {
  /** Deltas between consecutive rAF callbacks, in milliseconds. */
  readonly deltasMs: readonly number[];
};

export type MotionObservation = {
  readonly animations: readonly AnimationObservation[];
  /**
   * Elements whose computed `animation-name` is not `none`.
   *
   * Collected from the CSS side because an animation-name matching no `@keyframes` rule
   * registers nothing — see {@link findDeclaredButUnregistered}. Optional so a caller
   * with only `getAnimations()` data can still use the rest.
   */
  readonly declared?:
    | ReadonlyArray<{ readonly selector: string; readonly animationName: string }>
    | undefined;
  readonly frames: FrameSample;
  /** Whether the page was rendered under `prefers-reduced-motion: reduce`. */
  readonly reducedMotionRequested: boolean;
  /** Animations still running when reduced motion was requested. */
  readonly runningUnderReducedMotion: readonly string[];
};

export type MotionDefect =
  | "never-started"
  | "endless-without-reduced-motion"
  | "ignores-reduced-motion"
  | "janky"
  | "layout-thrashing";

export type MotionFinding = {
  readonly kind: MotionDefect;
  readonly selector: string;
  readonly detail: string;
  readonly severity: "high" | "medium";
};

/**
 * Properties the browser can animate on the compositor.
 *
 * Everything else animates on the main thread. `transform` and `opacity` are the two the
 * browser can hand to the GPU; `filter` and `backdrop-filter` are compositor-friendly in
 * current engines but not universally, so they are accepted without being recommended.
 *
 * Exported because a finding that only says "this is slow" leaves the reader to guess the
 * fix. {@link compositedAlternative} turns the deny-list into a suggestion.
 */
export const COMPOSITED_PROPERTIES: ReadonlySet<string> = new Set([
  "transform",
  "opacity",
  "filter",
  "backdrop-filter",
]);

/**
 * The composited property that replaces a layout-triggering one.
 *
 * Geometry animations become `transform`; anything else is a judgement call the caller
 * has to make, so this returns `undefined` rather than inventing advice.
 */
export function compositedAlternative(property: string): string | undefined {
  if (COMPOSITED_PROPERTIES.has(property)) return undefined;
  if (/^(left|top|right|bottom|margin)/.test(property)) return "transform: translate()";
  if (property === "width" || property === "height") return "transform: scale()";
  return undefined;
}

/**
 * Properties whose animation forces layout on **every frame**.
 *
 * This is the difference between an animation that works and one that works *and* feels
 * right. `left`/`top`/`width`/`height` recompute geometry each frame; `transform` does
 * not. The animation is functionally correct either way, which is exactly why no
 * functional check catches it.
 */
const LAYOUT_TRIGGERING = new Set([
  "left",
  "top",
  "right",
  "bottom",
  "width",
  "height",
  "margin",
  "margin-left",
  "margin-top",
  "padding",
  "font-size",
]);

/**
 * WCAG 2.2.2 threshold: automatic motion beyond five seconds needs a stop mechanism.
 *
 * An infinite animation exceeds this by construction, whatever its per-iteration duration.
 */
export const PAUSE_STOP_HIDE_SECONDS = 5;

/**
 * Frame budget for 60Hz.
 *
 * 16.7ms is the measured median on this machine, so the budget is not theoretical. A
 * frame that takes longer than two budgets has visibly dropped one.
 */
export const FRAME_BUDGET_MS = 1000 / 60;

/**
 * Fraction of frames allowed to exceed twice the budget before motion is called janky.
 *
 * Deliberately permissive. Headless timing is noisier than a real display, and the first
 * frames after navigation are always slow — flagging a well-built animation would get the
 * check switched off, which costs more than it saves. This catches sustained stutter, not
 * a single hitch.
 */
export const DEFAULT_JANK_TOLERANCE = 0.2;

/**
 * Is this animation endless?
 *
 * Explicit rather than inlined, because the JSON boundary makes the obvious test wrong.
 * `Infinity` survives as `null`, so `null` means endless — while `undefined` means the
 * field was absent, which is not the same claim and must not be reported as endless.
 */
export function isEndless(iterations: number | null | undefined): boolean {
  if (iterations === null) return true;
  if (iterations === undefined) return false;
  return !Number.isFinite(iterations);
}

/**
 * Judge the motion on a page.
 *
 * Reports every finding rather than the first: an agent that fixes one animation and
 * re-renders pays another full page load to discover the next.
 */
export function assessMotion(
  observation: MotionObservation,
  options: { readonly jankTolerance?: number } = {},
): readonly MotionFinding[] {
  const jankTolerance = options.jankTolerance ?? DEFAULT_JANK_TOLERANCE;
  const findings: MotionFinding[] = [];

  for (const animation of observation.animations) {
    /**
     * `idle` means the animation is registered but has never run.
     *
     * ══ What this does NOT catch, established by measurement ══
     *
     * The obvious cause — a keyframe name that does not resolve — does **not** land here.
     * Measured on `#miss { animation: nope 1s }`: the animation is not registered at all,
     * so `getAnimations()` returns nothing for it and there is no observation to judge.
     *
     *     ITER: [{sel:'once',…}, {sel:'inf',…}, {sel:'paused',…}]   ← 'miss' absent
     *
     * That is a genuine blind spot of this approach and is stated rather than papered
     * over: an animation that was never registered is invisible to `getAnimations()`, and
     * catching it needs {@link findDeclaredButUnregistered}, which compares the CSS
     * against what actually registered.
     *
     * This rule still earns its place for the cases that DO register and never play — a
     * Web Animations object never `play()`ed, or one cancelled before starting.
     */
    if (animation.playState === "idle") {
      findings.push({
        kind: "never-started",
        selector: animation.selector,
        severity: "high",
        detail:
          `"${animation.name}" is registered but its play state is idle — it has never run. ` +
          "A Web Animations object that was never played, or one cancelled before it started, " +
          "produces this. The page looks static rather than broken, so no functional check " +
          "reports it",
      });
    }

    // WCAG 2.2.2, Level A. Infinite motion exceeds five seconds by construction.
    if (
      isEndless(animation.iterations) &&
      animation.playState === "running" &&
      !observation.reducedMotionRequested
    ) {
      findings.push({
        kind: "endless-without-reduced-motion",
        selector: animation.selector,
        severity: "high",
        detail:
          `"${animation.name}" runs forever. WCAG 2.2.2 (Pause, Stop, Hide) is **Level A** and ` +
          `requires a mechanism to pause, stop or hide automatic motion lasting over ` +
          `${PAUSE_STOP_HIDE_SECONDS}s. Provide a real control (techniques G4, G186, G191). ` +
          "A @media (prefers-reduced-motion: reduce) query is NOT sufficient for this: " +
          "technique C39 is listed against 2.3.3 (Level AAA) and appears nowhere among 2.2.2's " +
          "sufficient techniques — verified at w3.org. Honour reduced motion as well, but it " +
          "does not satisfy Level A for the majority who never set that preference",
      });
    }

    const thrashing = animation.properties.filter((p) => LAYOUT_TRIGGERING.has(p));
    if (thrashing.length > 0) {
      // Name the replacement rather than only the problem — "this is slow" leaves the
      // reader to guess, and a guessed fix is often another layout-triggering property.
      const suggestions = [
        ...new Set(
          thrashing.map(compositedAlternative).filter((s): s is string => s !== undefined),
        ),
      ];
      findings.push({
        kind: "layout-thrashing",
        selector: animation.selector,
        severity: "medium",
        detail:
          `"${animation.name}" animates ${thrashing.join(", ")}, which forces layout on every ` +
          `frame. Use ${suggestions.length > 0 ? suggestions.join(" or ") : "transform or opacity"}` +
          " instead — those composite on the GPU. The animation is functionally correct either " +
          "way, which is why nothing else catches this; it simply feels broken on a mid-range phone",
      });
    }
  }

  /**
   * Reduced motion is checked as a whole-page property.
   *
   * A page that keeps animating under `prefers-reduced-motion: reduce` has ignored an
   * explicit accessibility request from the operating system. For a user with a
   * vestibular disorder this is a real harm, not a stylistic miss.
   */
  if (observation.reducedMotionRequested) {
    for (const selector of observation.runningUnderReducedMotion) {
      findings.push({
        kind: "ignores-reduced-motion",
        selector,
        severity: "high",
        detail:
          "still animating under prefers-reduced-motion: reduce. The user asked the operating " +
          "system to stop motion and the page continued. Vestibular disorders make this a " +
          "genuine harm rather than a preference",
      });
    }
  }

  // The CSS-side check, for animations that never registered at all.
  if (observation.declared) {
    findings.push(
      ...findDeclaredButUnregistered({
        declared: observation.declared,
        registered: observation.animations.map((a) => a.selector),
      }),
    );
  }

  const jank = assessFrames(observation.frames, jankTolerance);
  if (jank) findings.push(jank);

  return findings;
}

/**
 * The animation that was declared and never registered.
 *
 * ══ Why this needs its own pass ══
 *
 * `getAnimations()` reports animations the engine *created*. An `animation-name` that
 * matches no `@keyframes` rule creates nothing, so the failure is invisible to every
 * observation-based check — measured: `#miss { animation: nope 1s }` produced no entry
 * at all, while its siblings did.
 *
 * This is the single most likely animation bug in generated code. A typo in a keyframe
 * name, or a keyframe block that was never emitted, yields an element that simply sits
 * there. Nothing errors, nothing warns, and the page looks like a design choice.
 *
 * The comparison is: every element whose computed `animation-name` is not `none` should
 * have a registered animation. One that does not was declared and dropped.
 */
export function findDeclaredButUnregistered(input: {
  /** Elements whose computed animation-name is not `none`. */
  readonly declared: ReadonlyArray<{ readonly selector: string; readonly animationName: string }>;
  /** Selectors that actually appear in `getAnimations()`. */
  readonly registered: readonly string[];
}): readonly MotionFinding[] {
  const registered = new Set(input.registered);

  return input.declared
    .filter((d) => !registered.has(d.selector))
    .map((d) => ({
      kind: "never-started" as const,
      selector: d.selector,
      severity: "high" as const,
      detail:
        `declares animation-name "${d.animationName}" but no animation was registered — the ` +
        "name matches no @keyframes rule. Nothing errors and nothing warns; the element just " +
        "sits at its initial value and the page looks like a deliberate design. This is " +
        "invisible to getAnimations(), which only reports animations the engine created",
    }));
}

/**
 * Judge frame pacing.
 *
 * Separate from the per-animation checks because jank is a property of the page as a
 * whole: ten cheap animations can stutter where one expensive one does not.
 *
 * Uses the **median** rather than the mean. Mean frame time is dominated by the first few
 * frames after navigation, which are always slow and never representative — a mean-based
 * check reports every page as janky on its first render.
 */
export function assessFrames(
  frames: FrameSample,
  tolerance: number = DEFAULT_JANK_TOLERANCE,
): MotionFinding | undefined {
  const deltas = frames.deltasMs;
  // Too few samples to say anything. Silence beats a verdict from four frames.
  if (deltas.length < 10) return undefined;

  const dropped = deltas.filter((d) => d > FRAME_BUDGET_MS * 2);
  const ratio = dropped.length / deltas.length;
  if (ratio <= tolerance) return undefined;

  /**
   * ══ A type-level proof instead of a runtime fallback ══
   *
   * This was `sorted[Math.floor(sorted.length / 2)] ?? 0`, and that `?? 0` was
   * **unreachable**: the early return above guarantees `length >= 10`, so the index is
   * always in bounds — verified for lengths 10, 11, 40 and 41. `noUncheckedIndexedAccess`
   * cannot see the invariant, so the fallback existed only to compile, and it was the one
   * branch in this package no test could ever cover.
   *
   * Three ways to resolve that, and they are not equivalent:
   *
   *   a coverage-ignore hint   suppresses the branch — it lies to the number
   *   `sorted[i]!`             erased at compile time; no branch is emitted
   *   a non-empty tuple        the index is genuinely non-optional
   *
   * The tuple is chosen because it is the only one that survives an edit. Verified by
   * deleting the `length < 10` guard: the build fails with
   *
   *     motion.ts(449,56): error TS18048: 'median' is possibly 'undefined'.
   *
   * A `!` or an ignore hint stays silently wrong under the same edit. Note the error
   * lands at the *use* site rather than here — the narrowing propagates — which is enough
   * to stop the build, and is what ties the proof to the invariant rather than merely
   * asserting alongside it.
   */
  const sorted = [...deltas].sort((a, b) => a - b);
  // `slice(i, i + 1)` yields a one-element array whose head destructures to a
  // non-optional `number`, where `sorted[i]` would stay `number | undefined` — a variable
  // index into a tuple is still optional, verified. `?? 0` would be dead code; this is not.
  const [median = 0] = sorted.slice(Math.floor(sorted.length / 2));

  return {
    kind: "janky",
    selector: "page",
    severity: "medium",
    detail:
      `${dropped.length} of ${deltas.length} frames (${(ratio * 100).toFixed(0)}%) exceeded ` +
      `${(FRAME_BUDGET_MS * 2).toFixed(1)}ms, median ${median.toFixed(1)}ms against a ` +
      `${FRAME_BUDGET_MS.toFixed(1)}ms budget. Sustained stutter — check for animation of ` +
      "layout-triggering properties, or too much work per frame",
  };
}

/**
 * Collect motion data from a live page.
 *
 * Self-contained on purpose: Playwright's string-form `evaluate` cannot close over
 * anything from this module's scope, so every helper is defined inline. That constraint
 * is why this is a string rather than a function reference.
 *
 * Samples 40 frames, which at 60Hz is ~667ms — long enough to see sustained stutter,
 * short enough not to dominate a test run.
 */
export const COLLECT_MOTION_SCRIPT = `(() => new Promise((resolve) => {
  const name = (e) => {
    if (!e || !e.tagName) return 'unknown';
    return e.id ? '#' + e.id
      : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' && e.className.trim()
          ? '.' + e.className.trim().split(/\\s+/)[0] : '');
  };

  // getAnimations() covers CSS animations, CSS transitions and Web Animations API alike.
  // A library driving rAF directly will not appear here — that is what frame sampling is
  // for, and why both signals are collected rather than one.
  const collect = () => [...document.getAnimations()].map((a) => {
    const effect = a.effect;
    const timing = effect && effect.getTiming ? effect.getTiming() : {};
    let properties = [];
    try {
      const frames = effect && effect.getKeyframes ? effect.getKeyframes() : [];
      const keys = new Set();
      for (const f of frames) {
        for (const k of Object.keys(f)) {
          if (k !== 'offset' && k !== 'composite' && k !== 'easing' && k !== 'computedOffset') {
            // Keyframes report camelCase; CSS reports kebab. Normalise so the property
            // sets in the assessor match either source.
            keys.add(k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
          }
        }
      }
      properties = [...keys];
    } catch (_) { properties = []; }

    const duration = typeof timing.duration === 'number' ? timing.duration : 0;
    return {
      selector: effect && effect.target ? name(effect.target) : 'unknown',
      name: a.animationName || (a.transitionProperty ? 'transition:' + a.transitionProperty : (a.id || 'animation')),
      iterations: timing.iterations === undefined ? 1 : timing.iterations,
      durationMs: duration,
      playState: a.playState,
      properties,
    };
  });

  // Declared-but-unregistered: an animation-name matching no @keyframes creates no
  // animation object at all, so it must be found from the CSS side. Measured — a bad
  // keyframe name is simply absent from getAnimations().
  const declared = [...document.querySelectorAll('*')]
    .map((e) => ({ e, n: getComputedStyle(e).animationName }))
    .filter((x) => x.n && x.n !== 'none')
    .map((x) => ({ selector: name(x.e), animationName: x.n }));

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const deltas = [];
  let last = 0;
  let n = 0;

  const tick = (ts) => {
    if (last) deltas.push(ts - last);
    last = ts;
    if (++n < 41) { requestAnimationFrame(tick); return; }

    const animations = collect();
    resolve({
      animations,
      declared,
      frames: { deltasMs: deltas },
      reducedMotionRequested: reduced,
      runningUnderReducedMotion: reduced
        ? animations.filter((a) => a.playState === 'running').map((a) => a.selector)
        : [],
    });
  };
  requestAnimationFrame(tick);
}))()`;

export type MotionResult = {
  readonly ok: boolean;
  readonly findings: readonly MotionFinding[];
};

export function checkMotion(
  observation: MotionObservation,
  options: { readonly jankTolerance?: number } = {},
): MotionResult {
  const findings = assessMotion(observation, options);
  return { ok: findings.every((f) => f.severity !== "high"), findings };
}

export function formatMotion(result: MotionResult): string {
  if (result.findings.length === 0) {
    return "motion OK — no animation defects. Note this cannot judge whether the motion looks good, only whether it runs, stops, and paces correctly";
  }

  const rank = { high: 0, medium: 1 } as const;
  const sorted = [...result.findings].sort((a, b) => rank[a.severity] - rank[b.severity]);

  return [
    result.ok
      ? `motion OK with ${result.findings.length} warning(s):`
      : `MOTION BROKEN — ${result.findings.length} finding(s):`,
    ...sorted.map(
      (f) => `  ${f.severity === "high" ? "✗" : "!"} [${f.kind}] ${f.selector}\n    ${f.detail}`,
    ),
    "",
    "  A settled DOM looks identical whether an animation ran, never started, or never",
    "  stopped. These are the defects every static check is blind to by construction.",
  ].join("\n");
}
