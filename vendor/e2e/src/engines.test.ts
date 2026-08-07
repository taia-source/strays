import { chromium, devices, webkit } from "playwright";
import { describe, expect, it } from "vitest";
import {
  assertNoChromeDependentUnits,
  assessEngines,
  collectBoxesScript,
  DEFAULT_TARGETS,
  type EngineMeasurement,
  findDivergences,
  formatEngines,
} from "./engines.js";

describe("DEFAULT_TARGETS", () => {
  /**
   * The assertion that corrects the earlier wrong claim in this repo.
   *
   * It was recorded that Playwright device descriptors are "Chromium at a phone-sized
   * viewport, not real iOS Safari". Measured: iPhone descriptors run WEBKIT, which is
   * Safari's engine. This test pins that against Playwright's own data so the mistake
   * cannot be re-made from memory.
   */
  it("iPhone descriptors really do run WebKit, not Chromium", () => {
    expect(devices["iPhone 14"]?.defaultBrowserType).toBe("webkit");
    expect(devices["iPhone 14 Pro"]?.defaultBrowserType).toBe("webkit");
  });

  it("Android descriptors run Chromium, which is what Android Chrome is", () => {
    expect(devices["Pixel 7"]?.defaultBrowserType).toBe("chromium");
    expect(devices["Galaxy S9+"]?.defaultBrowserType).toBe("chromium");
  });

  it("names an engine for every target, with a reason", () => {
    expect(DEFAULT_TARGETS.length).toBeGreaterThan(1);
    for (const t of DEFAULT_TARGETS) {
      expect(devices[t.device]?.defaultBrowserType, t.device).toBe(t.engine);
      expect(t.why.length).toBeGreaterThan(20);
    }
  });

  it("covers both engines, or cross-engine testing is pointless", () => {
    expect(new Set(DEFAULT_TARGETS.map((t) => t.engine))).toEqual(new Set(["webkit", "chromium"]));
  });
});

describe("findDivergences", () => {
  const measure = (
    engine: "webkit" | "chromium",
    device: string,
    width: number,
  ): EngineMeasurement => ({
    engine,
    device,
    boxes: { "#date": { width, height: 20 } },
  });

  it("finds a large layout difference", () => {
    // The measured case: date input 39px in WebKit, 135px in Chromium.
    const d = findDivergences([
      measure("webkit", "iPhone 14", 39),
      measure("chromium", "Pixel 7", 135),
    ]);
    expect(d).toHaveLength(1);
    expect(d[0]?.ratio).toBeCloseTo(135 / 39, 1);
    expect(d[0]?.detail).toContain("broken on the other");
  });

  it("ignores the small differences engines always have", () => {
    // Checkbox 12px vs 13px is normal. Firing on this would make the check noise.
    const d = findDivergences([
      measure("webkit", "iPhone 14", 12),
      measure("chromium", "Pixel 7", 13),
    ]);
    expect(d).toEqual([]);
  });

  it("cannot diverge from a single engine", () => {
    expect(findDivergences([measure("webkit", "iPhone 14", 39)])).toEqual([]);
  });

  it("skips a selector only one engine rendered", () => {
    const d = findDivergences([
      { engine: "webkit", device: "iPhone 14", boxes: { "#a": { width: 10, height: 10 } } },
      { engine: "chromium", device: "Pixel 7", boxes: { "#b": { width: 900, height: 10 } } },
    ]);
    expect(d).toEqual([]);
  });

  it("names the smaller and larger side so the finding is actionable", () => {
    const d = findDivergences([
      measure("webkit", "iPhone 14", 39),
      measure("chromium", "Pixel 7", 135),
    ]);
    expect(d[0]?.detail).toContain("iPhone 14 (webkit)");
    expect(d[0]?.detail).toContain("Pixel 7 (chromium)");
  });

  it("respects a custom threshold", () => {
    const d = findDivergences(
      [measure("webkit", "iPhone 14", 12), measure("chromium", "Pixel 7", 13)],
      1.05,
    );
    expect(d).toHaveLength(1);
  });

  /**
   * ══ An element one engine collapses to zero ══
   *
   * `sizes` drops every non-positive value before comparing, so an element that renders
   * at 0px in one engine leaves fewer than two comparable numbers and the axis is skipped.
   * That `continue` had never run.
   *
   * It is deliberate, not an oversight, and the reasoning is worth pinning: a 0px box
   * means the element was not laid out at all — `display:none`, a collapsed flex child, a
   * font that never loaded. Feeding it into the ratio would produce `Infinity` (or a
   * divide-by-zero), and every such element would be reported as a catastrophic
   * cross-engine divergence. That is a different defect from "the engines sized this
   * differently", and reporting it here would bury the real divergences in noise.
   *
   * Height is 0 in both engines here while width is identical, so the ONLY reason this
   * yields no finding is the skip. Without it the width axis would still agree, but the
   * height axis would compute a ratio from an empty or single-element list.
   */
  it("skips an axis where fewer than two engines produced a positive size", () => {
    const d = findDivergences([
      { engine: "webkit", device: "iPhone 14", boxes: { "#collapsed": { width: 100, height: 0 } } },
      { engine: "chromium", device: "Pixel 7", boxes: { "#collapsed": { width: 100, height: 0 } } },
    ]);
    expect(d, "a zero-height box is not laid out, not a divergence").toEqual([]);
  });

  /** The asymmetric case: laid out in one engine, collapsed to nothing in the other. */
  it("does not report Infinity when one engine collapsed the element entirely", () => {
    const d = findDivergences([
      { engine: "webkit", device: "iPhone 14", boxes: { "#gone": { width: 0, height: 0 } } },
      { engine: "chromium", device: "Pixel 7", boxes: { "#gone": { width: 240, height: 40 } } },
    ]);
    expect(d).toEqual([]);
    // The specific number that must never escape into a report.
    expect(d.map((x) => x.ratio)).not.toContain(Number.POSITIVE_INFINITY);
  });

  /**
   * ══ Which side is named "smallest" and which "largest" ══
   *
   * The detail string is the entire value of a divergence finding: it tells a developer
   * which engine to open. `reduce` picks each end, and the tests above only ever passed
   * the smaller measurement FIRST — so a swapped comparison would have read identically.
   *
   * This orders the input largest-first, so a `<=`/`>=` mix-up in either reducer names
   * the wrong device and this fails. Asserting the full clause rather than a substring,
   * because "iPhone 14" appearing somewhere in the string proves nothing about which
   * role it was given.
   */
  it("names the right side even when the largest measurement comes first", () => {
    const d = findDivergences([
      measure("chromium", "Pixel 7", 135),
      measure("webkit", "iPhone 14", 39),
    ]);
    expect(d).toHaveLength(1);
    expect(d[0]?.detail).toContain("39px on iPhone 14 (webkit) vs 135px on Pixel 7 (chromium)");
  });
});

describe("assertNoChromeDependentUnits", () => {
  it("flags each chrome-dependent unit", () => {
    expect(assertNoChromeDependentUnits("height: 100svh")[0]).toContain("svh");
    expect(assertNoChromeDependentUnits("height: 100lvh")[0]).toContain("lvh");
    expect(assertNoChromeDependentUnits("height: 100dvh")[0]).toContain("dvh");
  });

  it("says plainly that behaviour is unverified rather than wrong", () => {
    // dvh is usually the CORRECT choice on mobile. Calling it an error would push people
    // back to vh, which is worse.
    expect(assertNoChromeDependentUnits("min-height: 100dvh")[0]).toContain("NOT verified");
  });

  it("does not flag plain vh", () => {
    expect(assertNoChromeDependentUnits("height: 100vh")).toEqual([]);
  });

  it("does not flag an unrelated identifier that merely contains the letters", () => {
    expect(assertNoChromeDependentUnits(".dvh-wrapper { color: red }")).toEqual([]);
  });
});

describe("assessEngines", () => {
  it("passes when engines agree, and keeps the warning non-blocking", () => {
    const r = assessEngines({
      measurements: [
        { engine: "webkit", device: "iPhone 14", boxes: { "#a": { width: 100, height: 20 } } },
        { engine: "chromium", device: "Pixel 7", boxes: { "#a": { width: 105, height: 20 } } },
      ],
      css: "height: 100dvh",
    });
    expect(r.ok).toBe(true);
    expect(r.unverifiable).toHaveLength(1);
    expect(formatEngines(r)).toContain("Only a real device");
  });

  it("says so when only one engine ran", () => {
    const r = assessEngines({
      measurements: [
        { engine: "chromium", device: "Pixel 7", boxes: { "#a": { width: 10, height: 10 } } },
      ],
    });
    expect(formatEngines(r)).toContain("cannot be detected from a single engine");
  });
});

/**
 * The measurements the whole module rests on, taken from the real engines.
 *
 * If Playwright ever changes which engine backs a descriptor, or the engines converge on
 * form-control sizing, these fail loudly rather than leaving stale claims in the comments.
 */
describe("against real engines", () => {
  const PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{margin:0;font:16px system-ui}</style>
    <input type="date" id="date">
    <input type="checkbox" id="check">
    <div class="vh" id="vh" style="height:100vh"></div>
    <div class="svh" id="svh" style="height:100svh"></div>
    <div class="dvh" id="dvh" style="height:100dvh"></div>`;

  async function measure(
    engine: typeof webkit | typeof chromium,
    device: string,
  ): Promise<Record<string, { width: number; height: number }>> {
    const browser = await engine.launch();
    try {
      const descriptor = devices[device];
      if (!descriptor) throw new Error(`unknown device: ${device}`);
      const page = await browser.newPage({ ...descriptor });
      await page.setContent(PAGE);
      return (await page.evaluate(collectBoxesScript(["#date", "#check"]))) as Record<
        string,
        { width: number; height: number }
      >;
    } finally {
      await browser.close();
    }
  }

  it("finds the date-input divergence a Chromium-only suite cannot", {
    timeout: 120_000,
  }, async () => {
    const [ios, android] = await Promise.all([
      measure(webkit, "iPhone 14"),
      measure(chromium, "Pixel 7"),
    ]);

    const divergences = findDivergences([
      { engine: "webkit", device: "iPhone 14", boxes: ios },
      { engine: "chromium", device: "Pixel 7", boxes: android },
    ]);

    // The specific claim in the module docs: a form control sized ~3.5x differently.
    const dateFinding = divergences.find((d) => d.selector === "#date");
    expect(
      dateFinding,
      `expected <input type=date> to diverge; got iOS ${ios["#date"]?.width}px vs Android ${android["#date"]?.width}px`,
    ).toBeDefined();
    expect(dateFinding?.ratio).toBeGreaterThan(2);
  });

  it("does NOT flag a checkbox, whose difference is small and normal", {
    timeout: 120_000,
  }, async () => {
    const [ios, android] = await Promise.all([
      measure(webkit, "iPhone 14"),
      measure(chromium, "Pixel 7"),
    ]);
    const divergences = findDivergences([
      { engine: "webkit", device: "iPhone 14", boxes: ios },
      { engine: "chromium", device: "Pixel 7", boxes: android },
    ]);
    expect(divergences.map((d) => d.selector)).not.toContain("#check");
  });

  /**
   * The honest boundary, asserted rather than described.
   *
   * Headless has no URL bar, so the three viewport units that exist precisely to respond
   * to it are all identical. This is what a real device is still needed for.
   */
  it("confirms svh/lvh/dvh are indistinguishable headless", { timeout: 120_000 }, async () => {
    for (const [engine, device] of [
      [webkit, "iPhone 14"],
      [chromium, "Pixel 7"],
    ] as const) {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage({ ...devices[device] });
        await page.setContent(PAGE);
        // Passed as a string, like every other injected script in this package, so the
        // config needs no DOM lib to typecheck a browser-side expression.
        const heights = (await page.evaluate(`(() => {
          const h = (id) => document.getElementById(id).getBoundingClientRect().height;
          return { inner: window.innerHeight, vh: h('vh'), svh: h('svh'), dvh: h('dvh'),
                   supportsDvh: CSS.supports('height', '100dvh') };
        })()`)) as {
          inner: number;
          vh: number;
          svh: number;
          dvh: number;
          supportsDvh: boolean;
        };

        // The units parse — they simply never diverge without chrome to collapse.
        expect(heights.supportsDvh, `${device} should support dvh`).toBe(true);
        expect(heights.svh, `${device}: svh must equal vh headless`).toBe(heights.vh);
        expect(heights.dvh, `${device}: dvh must equal vh headless`).toBe(heights.vh);
        expect(heights.vh).toBe(heights.inner);
      } finally {
        await browser.close();
      }
    }
  });
});

describe("formatEngines unverifiable section", () => {
  /**
   * The section that states this harness's hard limit, and it had never rendered.
   *
   * Measured on this machine: `100vh`, `100svh`, `100dvh` and `100lvh` all report an
   * identical 844 headless, in both engines. A layout that breaks only as a mobile URL
   * bar collapses passes here — so reliance on those units must be reported as
   * *unverified*, never as correct. If this branch never runs, that caveat never reaches
   * anyone and a known blind spot reads as a clean pass.
   */
  it("renders the unverifiable section and names the reason", () => {
    const text = formatEngines({
      ok: true,
      divergences: [],
      unverifiable: ["#hero uses 100dvh, which cannot be verified headless"],
      enginesRun: ["chromium", "webkit"],
    });
    expect(text).toContain("not verifiable in this harness (1)");
    expect(text).toContain("· #hero uses 100dvh");
    expect(text, "the reason must travel with the caveat").toContain("no URL bar to collapse");
  });

  /**
   * ══ Zero engines ran, which must not read as "engines agree" ══
   *
   * The `|| "no"` fallback exists for the case where the measurement list is empty — a
   * browser launch failed, a selector matched nothing, a harness misconfiguration. Joining
   * an empty array gives `""`, so without the fallback the report reads "only  engine ran"
   * with a hole in the sentence.
   *
   * The more dangerous half is what follows it: `ok` is true when there are no
   * divergences, and with no measurements there are trivially none. So a run that measured
   * NOTHING produces `ok: true`. The single-engine warning is the only thing standing
   * between that and a clean-looking pass, and it has to be legible.
   */
  it("says 'no engine ran' rather than leaving a hole in the sentence", () => {
    const r = assessEngines({ measurements: [] });
    expect(r.enginesRun).toEqual([]);
    // Vacuously ok — which is exactly why the warning below has to be present and clear.
    expect(r.ok).toBe(true);

    const text = formatEngines(r);
    expect(text).toContain("only no engine ran");
    expect(text).toContain("cannot be detected from a single engine");
  });

  it("renders divergences alongside the caveat", () => {
    const text = formatEngines({
      ok: false,
      divergences: [
        {
          selector: "input[type=date]",
          detail: "39px in webkit, 135px in chromium",
          // The measured divergence that motivated this module.
          ratio: 135 / 39,
        },
      ],
      unverifiable: ["#a uses 100vh"],
      enginesRun: ["chromium", "webkit"],
    });
    expect(text).toContain("ENGINE DIVERGENCE");
    expect(text).toContain("✗ input[type=date]");
    expect(text).toContain("not verifiable in this harness (1)");
  });
});
