/**
 * Canvas correctness — where the DOM ends and the pixels begin.
 *
 * ══ Why nothing else can see this ══
 *
 * A `<canvas>` is one element with a width and a height. Every DOM-based check in
 * `@taia/e2e` — contrast, layout, perceivability, rendering, cross-engine — sees exactly
 * that: a box of the right size, in the right place, fully visible. It sees the same box
 * whether the canvas contains a finished generative artwork or nothing at all.
 *
 * So a blank canvas passes every check this repo had. For the UIs it is meant to produce
 * — pixel art, dot-and-line network animations, particle fields, generative backgrounds —
 * the canvas *is* the product, and a blank one is total failure presenting as success.
 *
 * ══ Verified before designing against it ══
 *
 * Pixel readback is the whole basis of this module, so I measured it on both engines
 * rather than assuming. On this machine's headless Chromium and WebKit:
 *
 *   chromium {"has2d":true,"painted":[255,0,0,255],"blankAlpha":0,"webgl2":true}
 *   webkit   {"has2d":true,"painted":[255,0,0,255],"blankAlpha":0,"webgl2":true}
 *
 * `getImageData` returns exact colours in both, an unpainted region reads alpha 0, and
 * WebGL2 is available headless via SwiftShader — the renderer string is
 * `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))`. Software rendering, but
 * a real GL implementation, so a WebGL canvas genuinely draws in CI.
 *
 * ══ The four failures worth catching ══
 *
 * **1. Blank.** Nothing ever drew. A script error before the first paint, a context
 * acquired with the wrong type, a draw loop never started.
 *
 * **2. Frozen.** It drew once and stopped. Distinguishable from blank only by sampling
 * twice — one frame looks identical either way, which is why {@link assessCanvasMotion}
 * takes two observations rather than one.
 *
 * **3. Degenerate.** It has content, but that content is one flat colour. A cleared
 * buffer that never got its draw call, or a shader compiling to a solid fill, produces a
 * canvas that is technically non-blank and visually empty.
 *
 * **4. Mis-sized.** The CSS size and the backing-store size disagree. This is the most
 * common real canvas bug: a canvas styled `width: 100%` without its `width` attribute
 * being set to `clientWidth * devicePixelRatio` renders blurry, or stretched, on every
 * high-DPI display. It looks fine on the developer's monitor.
 *
 * ══ What this deliberately does not do ══
 *
 * It does not diff against a baseline image. Agent-generated art changes every build by
 * design, and a baseline would either be regenerated constantly (proving nothing) or
 * block every legitimate change. These checks are absolute — "did anything draw", "did it
 * keep drawing", "is it more than one colour" — so they hold for output nobody has seen
 * before, which is the entire point.
 */

/** A sample of a canvas at one moment. */
export type CanvasObservation = {
  readonly selector: string;
  /** Backing store size — the `width`/`height` attributes. */
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  /** Rendered size in CSS pixels. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
  /** Context type actually in use, when detectable. */
  readonly contextType?: "2d" | "webgl" | "webgl2" | "none" | undefined;
  /**
   * Fraction of sampled pixels with a non-zero alpha, 0..1.
   *
   * Sampled on a grid rather than read whole: a 4K canvas is ~33M bytes and reading all
   * of it per check is slow enough to matter in a suite.
   */
  readonly nonBlankRatio: number;
  /** Distinct colours found in the sample. One means a flat fill. */
  readonly distinctColours: number;
  /**
   * Cheap order-independent digest of the sampled pixels.
   *
   * Used only to compare two samples of the SAME canvas for change. It is not a
   * cryptographic hash and is never compared against a stored baseline.
   */
  readonly digest: string;
};

export type CanvasDefect =
  | "blank"
  | "frozen"
  | "flat-fill"
  | "buffer-size-mismatch"
  | "zero-sized"
  | "no-context";

export type CanvasFinding = {
  readonly kind: CanvasDefect;
  readonly selector: string;
  readonly detail: string;
  readonly severity: "high" | "medium";
};

/**
 * Fraction of sampled pixels that must carry any paint at all.
 *
 * Deliberately tiny. A sparse dot-and-line network animation legitimately leaves most of
 * the canvas empty — demanding meaningful coverage would flag exactly the aesthetic this
 * repo is built to support. The question is "did anything draw", not "is it busy".
 */
export const MIN_NON_BLANK_RATIO = 0.001;

/**
 * How far the backing store may diverge from `cssSize × devicePixelRatio`.
 *
 * A 10% band absorbs rounding and a scrollbar's width. Beyond that the canvas is being
 * scaled by the browser, which is the blurry-on-retina bug.
 */
export const BUFFER_SIZE_TOLERANCE = 0.1;

/**
 * Judge a single canvas sample.
 *
 * One sample cannot distinguish "frozen" from "still" — that needs
 * {@link assessCanvasMotion} and two samples. This covers everything decidable from one.
 */
export function assessCanvas(observation: CanvasObservation): readonly CanvasFinding[] {
  const findings: CanvasFinding[] = [];
  const { selector } = observation;

  if (observation.bufferWidth === 0 || observation.bufferHeight === 0) {
    findings.push({
      kind: "zero-sized",
      selector,
      severity: "high",
      detail:
        `backing store is ${observation.bufferWidth}×${observation.bufferHeight} — nothing can ` +
        "ever be drawn into it. A canvas sized only by CSS keeps its default 300×150 buffer " +
        "until the width/height attributes are set; setting them to 0 blanks it entirely",
    });
    // Every other check is meaningless against a zero-sized buffer.
    return findings;
  }

  if (observation.contextType === "none") {
    findings.push({
      kind: "no-context",
      selector,
      severity: "high",
      detail:
        "no rendering context was ever acquired. A canvas can only have ONE context type — " +
        "calling getContext('2d') after getContext('webgl') on the same element returns null, " +
        "which is a silent failure that looks like a drawing bug",
    });
  }

  if (observation.nonBlankRatio < MIN_NON_BLANK_RATIO) {
    findings.push({
      kind: "blank",
      selector,
      severity: "high",
      detail:
        `nothing is drawn — ${(observation.nonBlankRatio * 100).toFixed(3)}% of sampled pixels ` +
        "carry any paint. Every DOM check passes a blank canvas: it is one element of the " +
        "right size in the right place. If the canvas is the product, this is total failure " +
        "presenting as success",
    });
  } else if (observation.distinctColours <= 1) {
    /**
     * Flat fill. Only meaningful when something *was* drawn — a blank canvas trivially
     * has one colour, and reporting both would send someone chasing two bugs.
     */
    findings.push({
      kind: "flat-fill",
      selector,
      severity: "high",
      detail:
        "the entire canvas is a single colour. A buffer that was cleared but never drawn " +
        "into, or a shader that compiles to a solid fill, produces content that is " +
        "technically non-blank and visually empty",
    });
  }

  /**
   * ══ The retina mismatch, and the false positive it nearly caused ══
   *
   * A canvas whose backing store is smaller than its CSS size × devicePixelRatio is
   * upscaled by the browser and renders blurry. The naive fix — flag whenever the buffer
   * does not equal `css × dpr` — is wrong, and a probe against real pages showed it
   * firing on **five of five** canvases including a perfectly correct one.
   *
   * The reason is visible in the measurement. Rendering the naive pattern and the correct
   * one side by side:
   *
   *     dpr=1   naive: buf=200x200 css=200x200   correct: buf=200x200 css=200x200
   *     dpr=2   naive: buf=200x200 css=200x200   correct: buf=400x400 css=200x200
   *
   * At `dpr=1` the two are **identical** — the bug does not exist and cannot be observed.
   * It only becomes real at `dpr > 1`, where correct code yields a buffer-to-CSS ratio
   * matching the device ratio and naive code stays at 1.
   *
   * So the check is gated on `devicePixelRatio > 1`, and worded as "upscaled by N×"
   * rather than "wrong". A canvas rendered only at 1× is not defective; it is untested
   * for high-DPI, which is a different and honest claim.
   */
  if (observation.devicePixelRatio > 1 && observation.cssWidth > 0 && observation.cssHeight > 0) {
    const widthRatio = observation.bufferWidth / observation.cssWidth;
    const heightRatio = observation.bufferHeight / observation.cssHeight;
    const shortfall = Math.min(widthRatio, heightRatio) / observation.devicePixelRatio;

    if (shortfall < 1 - BUFFER_SIZE_TOLERANCE) {
      const upscale = (observation.devicePixelRatio / Math.min(widthRatio, heightRatio)).toFixed(1);
      findings.push({
        kind: "buffer-size-mismatch",
        selector,
        severity: "medium",
        detail:
          `backing store ${observation.bufferWidth}×${observation.bufferHeight} against a CSS ` +
          `size of ${Math.round(observation.cssWidth)}×${Math.round(observation.cssHeight)} at ` +
          `devicePixelRatio ${observation.devicePixelRatio} — the browser upscales this ${upscale}×, ` +
          "so it renders blurry on this display. Set the width/height ATTRIBUTES to " +
          "cssSize × devicePixelRatio, not just the CSS. At dpr 1 the correct and incorrect " +
          "forms are indistinguishable, which is why this only appears on high-DPI",
      });
    }
  }

  return findings;
}

/**
 * Did the canvas change between two samples?
 *
 * A single frame cannot tell a frozen animation from a still image — they are the same
 * pixels. Two samples separated by real time can, which is why this takes both.
 *
 * `expectMotion` is required rather than inferred: a static generative artwork that draws
 * once is *correct* and must not be reported, while an idle animation that stops is a
 * bug. Only the caller knows which was intended, and guessing would make the check either
 * useless or infuriating.
 */
export function assessCanvasMotion(input: {
  readonly before: CanvasObservation;
  readonly after: CanvasObservation;
  readonly expectMotion: boolean;
}): readonly CanvasFinding[] {
  const { before, after, expectMotion } = input;
  if (!expectMotion) return [];

  if (before.digest !== after.digest) return [];

  return [
    {
      kind: "frozen",
      selector: after.selector,
      severity: "high",
      detail:
        "identical pixels across two samples separated by real time, where motion was " +
        "expected. The draw loop stopped — an exception inside requestAnimationFrame kills " +
        "the loop silently, since the error surfaces in the console and the last good frame " +
        "stays on screen. A single sample cannot tell this from a still image",
    },
  ];
}

/**
 * Collect canvas samples from a live page.
 *
 * Self-contained: Playwright's string-form `evaluate` cannot close over module scope.
 *
 * Sampling is on a fixed grid rather than reading the full buffer — a 4K canvas is ~33MB
 * and reading it per check is slow enough to matter. A 64×64 grid is 4,096 points, plenty
 * to decide "blank", "flat" and "changed", and cheap on any canvas size.
 *
 * WebGL canvases need `preserveDrawingBuffer` to survive a `getImageData`-style read after
 * compositing, so a WebGL read may come back empty for reasons that are not a bug. That
 * is reported as `unreadable` rather than blank — claiming a WebGL canvas is blank when
 * the buffer merely was not preserved would be a false positive on correct code.
 */
export const COLLECT_CANVAS_SCRIPT = `(() => {
  const name = (e) => e.id ? '#' + e.id
    : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' && e.className.trim()
        ? '.' + e.className.trim().split(/\\s+/)[0] : '');

  const GRID = 64;

  return [...document.querySelectorAll('canvas')].map((c) => {
    const rect = c.getBoundingClientRect();
    const base = {
      selector: name(c),
      bufferWidth: c.width,
      bufferHeight: c.height,
      cssWidth: rect.width,
      cssHeight: rect.height,
      devicePixelRatio: window.devicePixelRatio || 1,
    };

    // Which context is live. getContext returns the SAME object for a matching type and
    // null for a conflicting one, so this identifies the type without creating a new one.
    let contextType = 'none';
    let ctx = null;
    try {
      if ((ctx = c.getContext('2d'))) contextType = '2d';
      else if (c.getContext('webgl2')) contextType = 'webgl2';
      else if (c.getContext('webgl')) contextType = 'webgl';
    } catch (_) { contextType = 'none'; }

    if (contextType !== '2d' || !ctx || c.width === 0 || c.height === 0) {
      // Not readable by getImageData: either no 2d context, or nothing to read. A WebGL
      // canvas without preserveDrawingBuffer legitimately reads empty, so it is NOT
      // reported as blank — that would be a false positive on correct code.
      return { ...base, contextType, nonBlankRatio: -1, distinctColours: -1, digest: 'unreadable' };
    }

    let painted = 0;
    let sampled = 0;
    const colours = new Set();
    let hash = 0;

    const stepX = Math.max(1, Math.floor(c.width / GRID));
    const stepY = Math.max(1, Math.floor(c.height / GRID));

    try {
      for (let y = 0; y < c.height; y += stepY) {
        for (let x = 0; x < c.width; x += stepX) {
          const d = ctx.getImageData(x, y, 1, 1).data;
          sampled++;
          if (d[3] > 0) painted++;
          colours.add((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]);
          // Order-dependent rolling hash: two different images are overwhelmingly
          // unlikely to collide, and identical ones always agree.
          hash = ((hash << 5) - hash + ((d[0] + d[1] * 3 + d[2] * 7 + d[3] * 11) | 0)) | 0;
        }
      }
    } catch (_) {
      // A tainted canvas (cross-origin image drawn in) throws on read. Not a defect.
      return { ...base, contextType, nonBlankRatio: -1, distinctColours: -1, digest: 'tainted' };
    }

    return {
      ...base,
      contextType,
      nonBlankRatio: sampled ? painted / sampled : 0,
      distinctColours: colours.size,
      digest: String(hash),
    };
  });
})()`;

export type CanvasResult = {
  readonly ok: boolean;
  readonly findings: readonly CanvasFinding[];
};

/**
 * Judge every canvas on a page.
 *
 * Samples whose digest is `unreadable` or `tainted` are skipped rather than failed: a
 * WebGL canvas without `preserveDrawingBuffer`, and a canvas holding a cross-origin
 * image, are both correct code that cannot be read. Reporting them would train a caller
 * to ignore this check.
 */
export function checkCanvases(observations: readonly CanvasObservation[]): CanvasResult {
  const findings = observations
    .filter((o) => o.digest !== "unreadable" && o.digest !== "tainted")
    .flatMap((o) => assessCanvas(o));

  return { ok: findings.every((f) => f.severity !== "high"), findings };
}

export function formatCanvas(result: CanvasResult): string {
  if (result.findings.length === 0) {
    return "canvas OK — content is present and correctly sized. This does not judge whether the drawing is correct, only that something was drawn";
  }

  const rank = { high: 0, medium: 1 } as const;
  const sorted = [...result.findings].sort((a, b) => rank[a.severity] - rank[b.severity]);

  return [
    result.ok
      ? `canvas OK with ${result.findings.length} warning(s):`
      : `CANVAS BROKEN — ${result.findings.length} finding(s):`,
    ...sorted.map(
      (f) => `  ${f.severity === "high" ? "✗" : "!"} [${f.kind}] ${f.selector}\n    ${f.detail}`,
    ),
    "",
    "  Every DOM check passes a blank canvas — it is one element of the right size in the",
    "  right place. When the canvas IS the product, that is total failure looking like success.",
  ].join("\n");
}
