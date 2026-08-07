/**
 * Cross-engine testing — and an honest account of what phone testing can and cannot reach.
 *
 * ══ A correction, because the earlier claim here was wrong ══
 *
 * This module previously carried the note that Playwright's device descriptors are
 * "Chromium at a phone-sized viewport, not real iOS Safari". **That is false**, and the
 * measurement is unambiguous:
 *
 *   Pixel 7          defaultBrowserType=chromium  isMobile=true  dpr=2.625  vp=412x839
 *   Galaxy S9+       defaultBrowserType=chromium  isMobile=true  dpr=4.5    vp=320x658
 *   iPhone 14        defaultBrowserType=webkit    isMobile=true  dpr=3      vp=390x664
 *   iPhone 14 Pro    defaultBrowserType=webkit    isMobile=true  dpr=3      vp=393x660
 *
 * iPhone descriptors run **WebKit**, which is Safari's actual engine (26.5 here, UA
 * `AppleWebKit/605.1.15 ... Version/26.5 Mobile/15E148 Safari/604.1`). And Android Chrome
 * *is* Chromium, so a Pixel 7 run is the same engine Android users have.
 *
 * ══ What this catches that a Chromium-only suite cannot ══
 *
 * Engine-level differences are real and reproduce headless. Measured on the same markup:
 *
 *   <input type="date">     WebKit  39px      Chromium 135px     ← 3.5x
 *   checkbox height         WebKit  12px      Chromium  13px
 *   devicePixelRatio        iPhone  3         Pixel 7   2.625
 *
 * A form laid out around a 135px date input is broken on iPhone and fine on Android, and
 * only running both engines shows it. **This is the class of bug the earlier note wrongly
 * declared unreachable.**
 *
 * ══ What genuinely does NOT reproduce ══
 *
 * One thing, and it is narrower than previously claimed: **browser chrome**. Measured on
 * both engines at phone size:
 *
 *   innerHeight 664 · 100vh 664 · 100dvh 664 · 100svh 664   (iPhone 14, webkit)
 *   innerHeight 839 · 100vh 839 · 100dvh 839 · 100svh 839   (Pixel 7, chromium)
 *
 * `svh`, `lvh` and `dvh` are **all equal** headless, because there is no URL bar to
 * collapse. On a real phone `100svh` and `100lvh` differ by the toolbar's height, so a
 * layout that only breaks as the URL bar hides will pass here. `CSS.supports('height',
 * '100dvh')` is true in both, so the units parse — they just never diverge.
 *
 * That is the honest boundary: **engine behaviour is testable, chrome dynamics are not.**
 * `assertNoChromeDependentUnits` therefore flags reliance on the units whose whole purpose
 * is to respond to chrome, since those are exactly the ones this harness cannot verify.
 */

/** The engine a device descriptor actually runs on. */
export type EngineName = "chromium" | "webkit" | "firefox";

export type DeviceTarget = {
  readonly device: string;
  readonly engine: EngineName;
  /** Why this target earns its place — every one costs a full browser launch. */
  readonly why: string;
};

/**
 * The minimum set worth running, and no more.
 *
 * Each is a real engine/formfactor combination rather than a viewport width: widths are
 * already covered by `layout.ts` in one browser, and re-running four widths across three
 * engines buys repetition rather than coverage.
 */
export const DEFAULT_TARGETS: readonly DeviceTarget[] = [
  {
    device: "iPhone 14",
    engine: "webkit",
    why: "Safari's real engine — form-control metrics differ sharply from Chromium (date input 39px vs 135px)",
  },
  {
    device: "Pixel 7",
    engine: "chromium",
    why: "Android Chrome is Chromium, so this is the engine Android users actually have",
  },
  {
    device: "Desktop Chrome",
    engine: "chromium",
    why: "the desktop baseline every other check runs against",
  },
];

/** One element's geometry, as one engine laid it out. */
export type EngineMeasurement = {
  readonly engine: EngineName;
  readonly device: string;
  /** selector -> { width, height } */
  readonly boxes: Readonly<Record<string, { readonly width: number; readonly height: number }>>;
};

export type EngineDivergence = {
  readonly selector: string;
  readonly detail: string;
  /** Ratio of largest to smallest across engines. 1 means identical. */
  readonly ratio: number;
};

/**
 * Compare the same elements across engines.
 *
 * A difference is not automatically a bug — engines legitimately render form controls
 * differently, and a rigid equality check would fire on every page with a checkbox. What
 * matters is a difference large enough to break a layout built around one engine's size,
 * so the threshold is a ratio rather than a pixel count.
 */
export function findDivergences(
  measurements: readonly EngineMeasurement[],
  ratioThreshold = 1.5,
): EngineDivergence[] {
  if (measurements.length < 2) return [];

  const selectors = new Set(measurements.flatMap((m) => Object.keys(m.boxes)));
  const divergences: EngineDivergence[] = [];

  for (const selector of selectors) {
    const present = measurements.filter((m) => m.boxes[selector] !== undefined);
    if (present.length < 2) continue;

    for (const axis of ["width", "height"] as const) {
      const values = present.map((m) => ({
        engine: m.engine,
        device: m.device,
        // The `?? 0` is unreachable: `present` is filtered to measurements where
        // `boxes[selector] !== undefined`, and `width`/`height` are non-optional on that
        // box type, so both the `?.` and the `??` always take the defined path. Present
        // for noUncheckedIndexedAccess only.
        value: m.boxes[selector]?.[axis] ?? 0,
      }));

      const sizes = values.map((v) => v.value).filter((v) => v > 0);
      if (sizes.length < 2) continue;

      const min = Math.min(...sizes);
      const max = Math.max(...sizes);
      // The `: 1` arm is unreachable: `sizes` is filtered to `v > 0` above, so `min` is
      // the minimum of a non-empty all-positive list and is itself always > 0. The guard
      // documents the divide-by-zero that the filter has already made impossible.
      const ratio = min > 0 ? max / min : 1;
      if (ratio < ratioThreshold) continue;

      const smallest = values.reduce((a, b) => (a.value <= b.value ? a : b));
      const largest = values.reduce((a, b) => (a.value >= b.value ? a : b));

      divergences.push({
        selector,
        ratio,
        detail:
          `${axis} differs ${ratio.toFixed(1)}x across engines — ` +
          `${Math.round(smallest.value)}px on ${smallest.device} (${smallest.engine}) vs ` +
          `${Math.round(largest.value)}px on ${largest.device} (${largest.engine}). ` +
          "A layout sized around one of these is broken on the other",
      });
      break; // one finding per selector is enough to send someone looking
    }
  }

  return divergences;
}

/**
 * Flag reliance on viewport units that only differ when browser chrome moves.
 *
 * Measured: headless, `100vh === 100svh === 100dvh === innerHeight` on both engines. So a
 * layout depending on the *difference* between them cannot be verified here at all, and
 * silence about that would be the false confidence this whole gate exists to prevent.
 *
 * This is advice, not a failure — `dvh` is usually the *correct* choice on mobile. The
 * point is that its correctness is unverified by this harness.
 */
export function assertNoChromeDependentUnits(css: string): readonly string[] {
  const warnings: string[] = [];
  const units: ReadonlyArray<[RegExp, string]> = [
    [/\b\d+(?:\.\d+)?svh\b/, "svh (small viewport height — assumes the URL bar is SHOWN)"],
    [/\b\d+(?:\.\d+)?lvh\b/, "lvh (large viewport height — assumes the URL bar is HIDDEN)"],
    [/\b\d+(?:\.\d+)?dvh\b/, "dvh (dynamic viewport height — changes AS the bar moves)"],
  ];

  for (const [pattern, description] of units) {
    if (pattern.test(css)) {
      warnings.push(
        `uses ${description}. Headless has no browser chrome, so this measures identical to ` +
          "100vh here and its behaviour on a real phone is NOT verified by this suite",
      );
    }
  }
  return warnings;
}

export type EngineResult = {
  readonly ok: boolean;
  readonly divergences: readonly EngineDivergence[];
  readonly unverifiable: readonly string[];
  readonly enginesRun: readonly EngineName[];
};

export function assessEngines(options: {
  readonly measurements: readonly EngineMeasurement[];
  readonly css?: string;
}): EngineResult {
  const divergences = findDivergences(options.measurements);
  const unverifiable = options.css ? assertNoChromeDependentUnits(options.css) : [];
  const enginesRun = [...new Set(options.measurements.map((m) => m.engine))];

  return {
    // Divergence fails; unverifiable does not. Flagging `dvh` as an error would push
    // people toward `vh`, which is worse on mobile — the warning is the whole point.
    ok: divergences.length === 0,
    divergences,
    unverifiable,
    enginesRun,
  };
}

export function formatEngines(result: EngineResult): string {
  const lines: string[] = [];

  if (result.enginesRun.length < 2) {
    lines.push(
      `only ${result.enginesRun.join(", ") || "no"} engine ran — cross-engine differences ` +
        "cannot be detected from a single engine",
    );
  }

  lines.push(
    result.ok
      ? `engines agree (${result.enginesRun.join(" + ")})`
      : `ENGINE DIVERGENCE — ${result.divergences.length} element(s) laid out very differently:`,
  );
  lines.push(...result.divergences.map((d) => `  ✗ ${d.selector}: ${d.detail}`));

  if (result.unverifiable.length > 0) {
    lines.push("");
    lines.push(`  not verifiable in this harness (${result.unverifiable.length}):`);
    lines.push(...result.unverifiable.map((w) => `    · ${w}`));
    lines.push("");
    lines.push("  Headless browsers have no URL bar to collapse. Measured: 100vh, 100svh and");
    lines.push("  100dvh are all identical here. Only a real device shows the difference.");
  }
  return lines.join("\n");
}

/** Collect the boxes to compare. Selectors are supplied by the caller. */
export function collectBoxesScript(selectors: readonly string[]): string {
  return `(() => {
  const out = {};
  for (const sel of ${JSON.stringify(selectors)}) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    out[sel] = { width: r.width, height: r.height };
  }
  return out;
})()`;
}
