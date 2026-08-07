import { chromium, firefox, webkit } from "playwright";
import { describe, expect, it } from "vitest";
import {
  assessCanvasMotion,
  type CanvasObservation,
  COLLECT_CANVAS_SCRIPT,
  checkCanvases,
} from "./canvas.js";
import { COLLECT_FOCUS_SCRIPT, checkFocus, type FocusableObservation } from "./focus.js";
import {
  assessForcedColors,
  COLLECT_FORCED_COLORS_SCRIPT,
  type ForcedColorsObservation,
} from "./forced-colors.js";
import { COLLECT_MOTION_SCRIPT, checkMotion, isEndless, type MotionObservation } from "./motion.js";
import {
  COLLECT_OVERFLOW_SCRIPT,
  checkOverflow,
  type OverflowObservation,
  type PageScrollProbe,
} from "./overflow.js";

/**
 * The collection scripts, against a real browser.
 *
 * ══ Why this cannot be unit-tested ══
 *
 * `COLLECT_MOTION_SCRIPT` and `COLLECT_CANVAS_SCRIPT` are **strings evaluated inside a
 * page**. Nothing in a unit test executes them, so every assertion elsewhere in this
 * package tests the assessors against hand-written observations — and would keep passing
 * if the collectors returned garbage.
 *
 * That gap is not hypothetical. Running these found three mistakes that unit tests could
 * not have — two in the collectors, one in a comment asserting the opposite of the truth:
 *
 *   - An `animation-name` matching no `@keyframes` rule registers **no animation at all**,
 *     so the original `never-started` rule was checking for a state the browser cannot
 *     produce. It was dead code until `findDeclaredButUnregistered` was added.
 *   - The buffer-size rule fired on **five of five** canvases including correct ones,
 *     because the defect it looks for cannot exist at `devicePixelRatio: 1`.
 *   - `iterations` was documented as arriving `null`. It does not — **Playwright
 *     preserves `Infinity`** — and the first version of the assertion below failed,
 *     which is how the error was caught. The `null` came from `console.log`'s own JSON
 *     formatting in an earlier probe.
 *
 * Both fixtures below reproduce a defect that a settled DOM renders identically to a
 * correct page — which is the entire justification for this package.
 */

const MOTION_PAGE = `<style>
  @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
  @keyframes slide { from { left: 0 } to { left: 200px } }
  #good { width: 40px; height: 40px; background: green; animation: spin 1s linear infinite }
  #thrash { position: absolute; top: 100px; width: 40px; height: 40px; background: red;
            animation: slide 2s linear infinite }
  #miss { width: 40px; height: 40px; background: blue; animation: doesNotExist 1s }
</style>
<div id="good"></div><div id="thrash"></div><div id="miss"></div>`;

/** `#dead`'s rAF loop throws part-way — the failure that leaves the last frame on screen. */
const CANVAS_PAGE = `
<canvas id="blank" width="100" height="100"></canvas>
<canvas id="live" width="100" height="100"></canvas>
<canvas id="dead" width="100" height="100"></canvas>
<script>
  const live = document.getElementById('live').getContext('2d');
  let a = 0;
  (function loop() {
    live.clearRect(0, 0, 100, 100);
    live.fillStyle = '#f00';
    live.fillRect((a += 3) % 90, 10, 10, 10);
    requestAnimationFrame(loop);
  })();

  const dead = document.getElementById('dead').getContext('2d');
  let b = 0;
  (function loop2() {
    dead.clearRect(0, 0, 100, 100);
    dead.fillStyle = '#00f';
    dead.fillRect((b += 3) % 90, 10, 10, 10);
    if (b > 20) throw new Error('this loop dies, and nothing reports it');
    requestAnimationFrame(loop2);
  })();
</script>`;

describe("motion collection in a real browser", () => {
  it("collects animations, frame timing and declared names from Chromium", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(MOTION_PAGE);
      const observation = (await page.evaluate(COLLECT_MOTION_SCRIPT)) as MotionObservation;

      // 40 samples means 41 rAF callbacks — the script's own sampling contract.
      expect(observation.frames.deltasMs.length).toBeGreaterThanOrEqual(30);

      /**
       * ══ What actually crosses the boundary ══
       *
       * Playwright **preserves `Infinity`** — verified on Chromium and WebKit alike. The
       * first version of this test asserted `null` and failed here, which is how the
       * mistake was found: the `null` seen in an earlier probe came from `console.log`
       * formatting the value as JSON, not from Playwright.
       *
       * `isEndless` accepts both forms because a caller who routes the observation
       * through a cache, a log or an HTTP hop WILL see `null`. This asserts the live
       * form, and the unit tests cover the serialised one.
       */
      const spin = observation.animations.find((a) => a.selector === "#good");
      expect(spin?.iterations, "Playwright preserves Infinity; JSON.stringify does not").toBe(
        Number.POSITIVE_INFINITY,
      );
      expect(isEndless(spin?.iterations), "both forms must classify as endless").toBe(true);
      expect(spin?.playState).toBe("running");
      expect(spin?.properties).toContain("transform");

      /**
       * The blind spot. `#miss` declares an animation whose keyframes do not exist, so
       * the browser registers nothing — it must appear in `declared` and be absent from
       * the registered list, or `findDeclaredButUnregistered` has nothing to work with.
       */
      expect(observation.declared?.map((d) => d.selector)).toContain("#miss");
      expect(observation.animations.map((a) => a.selector)).not.toContain("#miss");

      const result = checkMotion(observation);
      const kinds = result.findings.map((f) => f.kind);
      expect(kinds).toContain("never-started");
      expect(kinds).toContain("endless-without-reduced-motion");
      expect(kinds).toContain("layout-thrashing");
      expect(result.ok).toBe(false);
    } finally {
      await browser.close();
    }
  }, 60_000);

  /**
   * WebKit is the engine behind every iOS browser, and the one where `getAnimations`
   * support is likeliest to diverge. `@taia/e2e` exists partly because a `<input
   * type=date>` measured 39px in WebKit against 135px in Chromium.
   */
  it("collects the same defects from WebKit", async () => {
    const browser = await webkit.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(MOTION_PAGE);
      const observation = (await page.evaluate(COLLECT_MOTION_SCRIPT)) as MotionObservation;

      expect(observation.animations.length).toBeGreaterThan(0);
      expect(observation.declared?.map((d) => d.selector)).toContain("#miss");
      expect(checkMotion(observation).findings.map((f) => f.kind)).toContain("never-started");
    } finally {
      await browser.close();
    }
  }, 60_000);

  /**
   * Under `prefers-reduced-motion: reduce` this page keeps animating, because nothing in
   * it honours the preference. Playwright's emulation was verified to work in both
   * engines before this was written.
   */
  it("detects animation that ignores prefers-reduced-motion", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setContent(MOTION_PAGE);
      const observation = (await page.evaluate(COLLECT_MOTION_SCRIPT)) as MotionObservation;

      expect(observation.reducedMotionRequested).toBe(true);
      expect(checkMotion(observation).findings.map((f) => f.kind)).toContain(
        "ignores-reduced-motion",
      );
    } finally {
      await browser.close();
    }
  }, 60_000);
});

describe("canvas collection in a real browser", () => {
  it("catches a blank canvas that every DOM check passes", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(CANVAS_PAGE);
      await page.waitForTimeout(150);
      const observations = (await page.evaluate(COLLECT_CANVAS_SCRIPT)) as CanvasObservation[];

      const blank = observations.find((o) => o.selector === "#blank");
      expect(blank?.nonBlankRatio).toBe(0);
      expect(blank?.contextType).toBe("2d");

      const findings = checkCanvases(observations).findings;
      expect(findings.some((f) => f.kind === "blank" && f.selector === "#blank")).toBe(true);
    } finally {
      await browser.close();
    }
  }, 60_000);

  /**
   * ══ The failure this package exists for ══
   *
   * A `requestAnimationFrame` loop that throws dies **silently** — the error goes to the
   * console and the last good frame stays on screen. `#live` and `#dead` are pixel-wise
   * indistinguishable in any single screenshot; only two samples separated by real time
   * tell them apart.
   */
  it("catches a draw loop that died, and clears one that did not", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(CANVAS_PAGE);
      await page.waitForTimeout(200);
      const before = (await page.evaluate(COLLECT_CANVAS_SCRIPT)) as CanvasObservation[];
      await page.waitForTimeout(400);
      const after = (await page.evaluate(COLLECT_CANVAS_SCRIPT)) as CanvasObservation[];

      const sample = (list: CanvasObservation[], selector: string) => {
        const found = list.find((o) => o.selector === selector);
        if (!found) throw new Error(`no observation for ${selector}`);
        return found;
      };

      const dead = assessCanvasMotion({
        before: sample(before, "#dead"),
        after: sample(after, "#dead"),
        expectMotion: true,
      });
      expect(dead.map((f) => f.kind)).toEqual(["frozen"]);

      const live = assessCanvasMotion({
        before: sample(before, "#live"),
        after: sample(after, "#live"),
        expectMotion: true,
      });
      expect(live, "a canvas still drawing must never be reported").toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);

  /**
   * ══ The false positive that nearly shipped ══
   *
   * The naive buffer-size rule fired on **five of five** canvases in a probe, including
   * correct ones. Measured side by side:
   *
   *     dpr=1   naive: buf=200x200 css=200x200   correct: buf=200x200 css=200x200
   *     dpr=2   naive: buf=200x200 css=200x200   correct: buf=400x400 css=200x200
   *
   * At dpr 1 the two are identical — the defect cannot exist. This asserts both halves
   * against a real browser at both ratios, because a unit test cannot prove that the
   * device pixel ratio reaches the observation at all.
   */
  it("flags an upscaled canvas only on a high-DPI display", async () => {
    const browser = await chromium.launch();
    try {
      const page = `<canvas id="naive" style="width:200px;height:200px" width="200" height="200"></canvas>
        <canvas id="correct" style="width:200px;height:200px"></canvas>
        <script>
          const c = document.getElementById('correct');
          c.width = 200 * devicePixelRatio; c.height = 200 * devicePixelRatio;
          for (const id of ['naive', 'correct']) {
            const ctx = document.getElementById(id).getContext('2d');
            for (let i = 0; i < 200; i++) { ctx.fillStyle = 'hsl(' + i + ',80%,50%)'; ctx.fillRect(i, 0, 1, 400); }
          }
        </script>`;

      const at = async (deviceScaleFactor: number) => {
        const tab = await browser.newPage({
          viewport: { width: 500, height: 400 },
          deviceScaleFactor,
        });
        await tab.setContent(page);
        await tab.waitForTimeout(120);
        const observations = (await tab.evaluate(COLLECT_CANVAS_SCRIPT)) as CanvasObservation[];
        await tab.close();
        return checkCanvases(observations).findings;
      };

      expect(await at(1), "at dpr 1 the correct and naive forms are identical").toEqual([]);

      const retina = await at(2);
      expect(retina.map((f) => f.selector)).toEqual(["#naive"]);
      expect(retina[0]?.kind).toBe("buffer-size-mismatch");
    } finally {
      await browser.close();
    }
  }, 60_000);

  /**
   * A WebGL canvas without `preserveDrawingBuffer` reads back empty after compositing —
   * the WebGL spec mandates the clear. Reporting that as `blank` would be a false
   * positive on correct code, so it must come back `unreadable` and be skipped.
   */
  it("skips a WebGL canvas rather than calling it blank", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<canvas id="gl" width="100" height="100"></canvas>
         <script>document.getElementById('gl').getContext('webgl2');</script>`,
      );
      const observations = (await page.evaluate(COLLECT_CANVAS_SCRIPT)) as CanvasObservation[];

      expect(observations[0]?.contextType).toBe("webgl2");
      expect(observations[0]?.digest).toBe("unreadable");
      expect(checkCanvases(observations).findings).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

describe("forced colours in a real browser", () => {
  const FORCED_PAGE = `
    <button id="shadowbtn" style="box-shadow:0 0 0 2px #333;border:none;background:#fff">Shadow-only</button>
    <button id="goodbtn" style="border:2px solid #333;background:#fff">Bordered</button>
    <button id="gradbtn" style="background:linear-gradient(#f00,#00f);border:none;color:#fff">Gradient</button>
    <div id="spacer" style="box-shadow:0 0 4px #000;width:50px;height:10px"></div>`;

  const observe = async (
    launch: typeof chromium,
  ): Promise<{ before: ForcedColorsObservation[]; after: ForcedColorsObservation[] }> => {
    const browser = await launch.launch();
    try {
      const grab = async (forcedColors: "none" | "active") => {
        const page = await browser.newPage();
        await page.emulateMedia({ forcedColors });
        await page.setContent(FORCED_PAGE);
        const observations = (await page.evaluate(
          COLLECT_FORCED_COLORS_SCRIPT,
        )) as ForcedColorsObservation[];
        await page.close();
        return observations;
      };
      return { before: await grab("none"), after: await grab("active") };
    } finally {
      await browser.close();
    }
  };

  /**
   * The real defect: a button whose only edge was a shadow becomes an invisible
   * rectangle, while a bordered one beside it is untouched.
   */
  it("catches a shadow-only button and spares the bordered one", async () => {
    const result = assessForcedColors({
      engine: "chromium",
      observations: await observe(chromium),
    });

    expect(result.supported).toBe(true);
    if (!result.supported) return;

    const byKind = (kind: string) =>
      result.findings.filter((f) => f.kind === kind).map((f) => f.selector);

    expect(byKind("boundary-vanished")).toEqual(["#shadowbtn"]);
    expect(byKind("gradient-lost")).toEqual(["#gradbtn"]);
    // The false positives a live run exposed: a bordered button and a decorative spacer.
    expect(result.findings.map((f) => f.selector)).not.toContain("#goodbtn");
    expect(result.findings.map((f) => f.selector)).not.toContain("#spacer");
  }, 90_000);

  /**
   * ══ The vacuous pass this module refuses to give ══
   *
   * Measured on Playwright 1.62: WebKit answers `true` to `(forced-colors: active)` while
   * applying none of the forcing — `box-shadow` and gradients survive intact. So the
   * observations come back showing nothing lost, and a naive check would report a clean
   * pass having tested nothing.
   */
  it("confirms WebKit reports the media query while forcing nothing", async () => {
    const browser = await webkit.launch();
    try {
      const page = await browser.newPage();
      await page.emulateMedia({ forcedColors: "active" });
      await page.setContent(FORCED_PAGE);

      // String-form evaluate, like every other collector here: this package has no DOM
      // lib, so browser globals are not in scope for a closure. tsc caught the arrow-
      // function version immediately.
      const reported = (await page.evaluate(
        `matchMedia('(forced-colors: active)').matches`,
      )) as boolean;
      const shadow = (await page.evaluate(
        `getComputedStyle(document.getElementById('shadowbtn')).boxShadow`,
      )) as string;

      expect(reported, "WebKit answers the media query").toBe(true);
      expect(shadow, "and yet forces nothing — the shadow survives").not.toBe("none");
    } finally {
      await browser.close();
    }
  }, 90_000);

  /** Firefox forces correctly, so the same defects must be found there. */
  it("finds the same defects on Firefox", async () => {
    const result = assessForcedColors({
      engine: "firefox",
      observations: await observe(firefox),
    });
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.findings.map((f) => f.selector)).toContain("#shadowbtn");
  }, 90_000);
});

describe("overflow sweep in a real browser", () => {
  /**
   * A realistic page: every element here except the two planted defects is something a
   * naive sweep flags and a developer would rightly call a false positive.
   */
  const REALISTIC = `<meta name="viewport" content="width=device-width,initial-scale=1">
    <nav style="position:sticky;top:0;display:flex;gap:8px"><a href="#">Home</a><a href="#">About</a></nav>
    <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Skip to content</span>
    <div style="width:200px;overflow-x:auto;white-space:nowrap">CAROUSEL AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</div>
    <div style="width:200px;overflow:hidden;white-space:nowrap"><table><tr><td>cell</td><td>cell</td></tr></table></div>
    <select><option>one</option></select>
    <div id="REALBUG" style="width:120px;overflow:hidden;white-space:nowrap">This text is silently cut off with no indicator</div>
    <div id="ELLIPSIS" style="width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Intentional truncation here</div>
    <p>Some text with an <a href="#">inline link</a> inside a sentence.</p>`;

  const sweep = async (launch: typeof chromium, content: string) => {
    const browser = await launch.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(content);
      return (await page.evaluate(COLLECT_OVERFLOW_SCRIPT)) as {
        elements: OverflowObservation[];
        probe: PageScrollProbe;
      };
    } finally {
      await browser.close();
    }
  };

  /**
   * The filters exist because a naive sweep is unusable — measured, Firefox returned 14
   * hits of which 12 were false. Each exclusion here traces to a specific measured false
   * positive: `.sr-only`, a carousel, a table wrapper, a `<select>`, inline links.
   */
  it("finds the real defect and none of the false positives, in every engine", async () => {
    for (const [name, launch] of [
      ["chromium", chromium],
      ["webkit", webkit],
      ["firefox", firefox],
    ] as const) {
      const raw = await sweep(launch, REALISTIC);
      const result = checkOverflow(raw);
      const kinds = result.findings.map((f) => `${f.kind}:${f.selector}`);

      expect(kinds, `${name} must catch the planted clip`).toContain(
        "clipped-without-indicator:#REALBUG",
      );
      expect(kinds, `${name} must note the deliberate ellipsis`).toContain(
        "clipped-with-ellipsis:#ELLIPSIS",
      );

      // The false positives, named individually so a regression says which returned.
      const selectors = result.findings.map((f) => f.selector);
      expect(selectors, `${name} must not report screen-reader text`).not.toContain("span");
      expect(
        selectors.filter((s) => s.startsWith("select")),
        `${name}: <select>`,
      ).toEqual([]);
      expect(
        selectors.filter((s) => s.startsWith("t")),
        `${name}: table internals`,
      ).toEqual([]);
    }
  }, 120_000);

  /**
   * ══ The false negative that makes a scrollWidth check unsound ══
   *
   * Measured: an absolutely-positioned element at left:900px on an 800px viewport gives
   * `documentElement.scrollWidth === clientWidth === 800`, delta 0 — while the page
   * really scrolls 400px. Every scrollWidth-based check in circulation calls this clean.
   */
  it("catches a sideways-scrolling page that scrollWidth reports as clean", async () => {
    const raw = await sweep(
      chromium,
      `<meta name="viewport" content="width=device-width">
       <div style="position:absolute;left:900px;width:300px;height:50px;background:red">off</div>`,
    );

    expect(raw.probe.maxScrollX, "the scroll probe is ground truth").toBeGreaterThan(0);
    expect(checkOverflow(raw).findings.map((f) => f.kind)).toContain("page-scrolls-sideways");
  }, 90_000);

  it("catches a missing viewport meta", async () => {
    const raw = await sweep(chromium, `<p>no meta tag here</p>`);
    expect(checkOverflow(raw).findings.map((f) => f.kind)).toContain("missing-viewport-meta");
  }, 90_000);

  /** An ordinary page must come back silent, or the check gets switched off. */
  it("is silent on a clean page", async () => {
    const raw = await sweep(
      chromium,
      `<meta name="viewport" content="width=device-width"><p>Just some normal text.</p>`,
    );
    expect(checkOverflow(raw).findings).toEqual([]);
  }, 90_000);
});

describe("focus and target size in a real browser", () => {
  const FOCUS_PAGE = `
    <div id="hdr" style="position:fixed;top:0;left:0;right:0;height:60px;background:#333;z-index:9"></div>
    <a id="under" href="#" style="position:absolute;top:20px;left:20px">Fully under the header</a>
    <a id="partial" href="#" style="position:absolute;top:52px;left:20px;font-size:24px">Partly under</a>
    <a id="clear" href="#" style="position:absolute;top:200px;left:20px">Clear of it</a>
    <div style="position:absolute;top:300px;left:20px">
      <button id="tiny1" style="width:16px;height:16px"></button
      ><button id="tiny2" style="width:16px;height:16px"></button>
    </div>
    <button id="big" style="position:absolute;top:400px;left:300px;width:48px;height:48px"></button>
    <p style="position:absolute;top:500px">Text with an <a id="inline" href="#">inline link</a> in it.</p>`;

  /**
   * ══ Why this runs in all three engines ══
   *
   * The first version measured the viewport with `documentElement.clientHeight` and
   * sampled **zero points** on Firefox, passing vacuously. Measured there on an
   * absolutely-positioned page: `clientHeight` was **8** while `innerHeight` was **600** —
   * Firefox sizes the root box to content. Chromium and WebKit happened to agree with the
   * viewport, so the bug was invisible until Firefox ran.
   */
  it("finds obscured focus and crowded targets in every engine", async () => {
    for (const [name, launch] of [
      ["chromium", chromium],
      ["webkit", webkit],
      ["firefox", firefox],
    ] as const) {
      const browser = await launch.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
        await page.setContent(FOCUS_PAGE);
        const observations = (await page.evaluate(COLLECT_FOCUS_SCRIPT)) as FocusableObservation[];

        expect(observations.length, `${name} collected nothing`).toBeGreaterThan(0);
        // The Firefox regression guard: zero sampled points means a vacuous pass.
        const inView = observations.filter((o) => o.inViewport);
        expect(inView.length, `${name} saw nothing in the viewport`).toBeGreaterThan(0);
        expect(
          inView.some((o) => o.sampledPoints > 0),
          `${name} sampled no points — clientHeight vs innerHeight regression`,
        ).toBe(true);

        const kinds = checkFocus(observations).findings.map((f) => `${f.kind}:${f.selector}`);

        expect(kinds, `${name}: fully covered link`).toContain("focus-obscured:#under");
        // 2.4.11 is "entirely hidden" — partial obscuring conforms at Level AA.
        expect(kinds, `${name}: partial cover conforms`).not.toContain("focus-obscured:#partial");
        expect(kinds, `${name}: unobstructed link`).not.toContain("focus-obscured:#clear");

        expect(kinds, `${name}: crowded 16px button`).toContain("target-too-small:#tiny1");
        expect(kinds, `${name}: 48px button passes on size`).not.toContain("target-too-small:#big");
        expect(kinds, `${name}: inline link is exempt`).not.toContain("target-too-small:#inline");
      } finally {
        await browser.close();
      }
    }
  }, 150_000);
});
