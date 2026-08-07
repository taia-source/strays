import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  assessLayout,
  COLLECT_LAYOUT_SCRIPT,
  checkLayout,
  DEFAULT_VIEWPORTS,
  formatLayout,
  type LayoutObservation,
  MIN_CONTENT_SHARE,
  MIN_LANDMARK_SHARE,
  MIN_TAP_TARGET_PX,
  type Viewport,
} from "./layout.js";

const VP: Viewport = { name: "mobile", width: 390, height: 844 };

const clean: LayoutObservation = {
  documentScrollWidth: 390,
  viewportWidth: 390,
  overflowing: [],
  smallTargets: [],
  clippedText: [],
  inFlowBackdrops: [],
  // Measured on a correct render of the page that motivated these checks.
  landmarkShare: 62,
  contentShare: 70,
  claimsViewport: true,
};

describe("checkLayout", () => {
  it("passes a page that fits", () => {
    expect(checkLayout(VP, clean)).toEqual([]);
  });

  it("reports horizontal overflow once for the page, naming the culprits", () => {
    const findings = checkLayout(VP, {
      ...clean,
      documentScrollWidth: 640,
      overflowing: ["table", "td"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("horizontal-overflow");
    expect(findings[0]?.detail).toContain("250px too wide");
    expect(findings[0]?.detail).toContain("table, td");
  });

  it("tolerates sub-pixel rounding rather than firing on half a pixel", () => {
    expect(checkLayout(VP, { ...clean, documentScrollWidth: 390.5 })).toEqual([]);
  });

  it("flags a tap target below the WCAG 2.2 minimum", () => {
    const findings = checkLayout(VP, {
      ...clean,
      smallTargets: [{ selector: "#t", width: 16, height: 16 }],
    });
    expect(findings[0]?.kind).toBe("tap-target");
    expect(findings[0]?.detail).toContain("16×16");
    expect(findings[0]?.detail).toContain("a thumb does not");
  });

  it("flags a target that is wide enough but too short", () => {
    // Height alone is a real failure: a full-width 12px-tall row is easy to miss.
    const findings = checkLayout(VP, {
      ...clean,
      smallTargets: [{ selector: "#wide", width: 300, height: 12 }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("tap-target");
  });

  it("flags clipped text", () => {
    const findings = checkLayout(VP, { ...clean, clippedText: ["#c"] });
    expect(findings[0]?.kind).toBe("clipped-text");
    expect(findings[0]?.detail).toContain("cut off, not wrapped");
  });
});

describe("assessLayout", () => {
  it("is ok only when every viewport is clean", () => {
    const result = assessLayout(
      DEFAULT_VIEWPORTS.map((viewport) => ({ viewport, observation: clean })),
    );
    expect(result.ok).toBe(true);
    expect(result.viewportsChecked).toHaveLength(4);
  });

  it("fails the whole run when a single viewport breaks", () => {
    const result = assessLayout([
      { viewport: { name: "desktop", width: 1280, height: 800 }, observation: clean },
      { viewport: VP, observation: { ...clean, documentScrollWidth: 640 } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
  });

  /**
   * ══ The report a green run actually prints ══
   *
   * Every existing test formatted a FAILING result, so the passing branch of the
   * formatter had never executed. That is the line a developer sees on the overwhelming
   * majority of runs, and an unrendered branch means the first person to read it is the
   * first person it has ever run for.
   *
   * It has to name the viewports, not merely say "passed". A run that silently checked
   * one width — or zero, if the caller passed an empty list — would otherwise be
   * indistinguishable from a run that checked all four, and this module's entire premise
   * is that a green desktop-only run proves nothing about a phone. The count and the
   * names are what make the pass auditable.
   */
  it("names every viewport it checked, so a pass is auditable rather than bare", () => {
    const report = formatLayout(
      assessLayout(DEFAULT_VIEWPORTS.map((viewport) => ({ viewport, observation: clean }))),
    );
    expect(report).toContain("layout passed at all 4 viewports");
    for (const viewport of DEFAULT_VIEWPORTS) {
      expect(report, `${viewport.name} must appear in the passing report`).toContain(viewport.name);
    }
    // A pass must not carry any of the failure vocabulary.
    expect(report).not.toContain("LAYOUT FAILED");
  });

  /** The degenerate pass: nothing was checked at all, and the report must not hide it. */
  it("reports zero viewports rather than implying coverage it does not have", () => {
    const report = formatLayout(assessLayout([]));
    expect(report).toContain("layout passed at all 0 viewports");
  });

  it("says plainly when the failures are mobile-only", () => {
    const report = formatLayout(
      assessLayout([
        { viewport: { name: "desktop", width: 1280, height: 800 }, observation: clean },
        { viewport: VP, observation: { ...clean, documentScrollWidth: 640 } },
      ]),
    );
    expect(report).toContain("invisible at desktop width");
  });

  it("does not add the mobile-only note when desktop is also broken", () => {
    const report = formatLayout(
      assessLayout([
        {
          viewport: { name: "desktop", width: 1280, height: 800 },
          observation: { ...clean, documentScrollWidth: 1600, viewportWidth: 1280 },
        },
        { viewport: VP, observation: { ...clean, documentScrollWidth: 640 } },
      ]),
    );
    expect(report).not.toContain("invisible at desktop width");
  });
});

/**
 * The test that makes the rest trustworthy.
 *
 * Everything above judges observations this file constructed. This one runs the real
 * collection script in a real browser at two real widths, and asserts the specific
 * asymmetry the module exists for: **clean at 1280, broken at 390.**
 */
describe("in a real browser", () => {
  const PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{margin:0;font:16px system-ui}
      .row{display:flex;gap:12px;padding:16px}
      .card{width:200px;background:#eee;padding:16px}
      table{width:640px;border-collapse:collapse}
      td{border:1px solid #ccc;padding:8px}
      .tiny{width:16px;height:16px;font-size:9px;padding:0}
      .clip{width:120px;height:20px;overflow:hidden;white-space:nowrap}
    </style>
    <div class="row"><div class="card">A</div><div class="card">B</div><div class="card">C</div></div>
    <table><tr><td>wide</td><td>table</td><td>that</td><td>overflows</td></tr></table>
    <button class="tiny" id="t">x</button>
    <div class="clip" id="c">this text is clipped and unreadable</div>
    <button id="ok" style="width:120px;height:44px">Fine</button>`;

  async function observe(width: number, height: number): Promise<LayoutObservation> {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.setContent(PAGE);
      return (await page.evaluate(COLLECT_LAYOUT_SCRIPT)) as LayoutObservation;
    } finally {
      await browser.close();
    }
  }

  it("finds nothing wrong with the page width at desktop", { timeout: 60_000 }, async () => {
    const obs = await observe(1280, 800);
    expect(obs.documentScrollWidth).toBeLessThanOrEqual(obs.viewportWidth + 1);
    expect(obs.overflowing).toEqual([]);
    // The identical page. Desktop simply cannot see the overflow.
    expect(
      checkLayout({ name: "desktop", width: 1280, height: 800 }, obs).map((f) => f.kind),
    ).not.toContain("horizontal-overflow");
  });

  it("finds the overflow the same page hides at desktop", { timeout: 60_000 }, async () => {
    const obs = await observe(390, 844);
    expect(obs.documentScrollWidth).toBeGreaterThan(obs.viewportWidth);
    expect(obs.overflowing).toContain("table");

    const findings = checkLayout(VP, obs);
    expect(findings.map((f) => f.kind)).toContain("horizontal-overflow");
  });

  it("measures the 16px button and the clipped div in a real layout", {
    timeout: 60_000,
  }, async () => {
    const obs = await observe(390, 844);

    const tiny = obs.smallTargets.find((t) => t.selector === "#t");
    expect(tiny).toBeDefined();
    expect(tiny?.width).toBeLessThan(MIN_TAP_TARGET_PX);

    // The 44px button beside it must NOT be flagged, or the check is just noise.
    expect(obs.smallTargets.map((t) => t.selector)).not.toContain("#ok");

    expect(obs.clippedText).toContain("#c");
  });

  it("does not flag a flex row that shrinks to fit", { timeout: 60_000 }, async () => {
    // The counterexample that shows this measures rather than guesses: three 200px cards
    // are 600px of content in a 390px viewport, yet flexbox shrinks them and nothing
    // overflows. A markup-reading heuristic would have flagged these.
    const obs = await observe(390, 844);
    expect(obs.overflowing).not.toContain("div.row");
    expect(obs.overflowing).not.toContain("div.card");
  });
});

/**
 * ══ The two checks that a real deploy proved were missing ══
 *
 * A deployed page put its interface in 15% of the viewport with labels overlapping their own
 * values. Nine browser checks passed on it — nothing overflowed, because the content was
 * COMPRESSED rather than spilled, and it only broke at desktop width.
 */
describe("a backdrop that displaces the interface", () => {
  /**
   * The measured cause: a `<canvas>` styled `position: fixed`, overridden to `relative` by a
   * later `.screen > *` rule — specificity 0,1,1 against the canvas's 0,1,0.
   */
  it("reports a full-bleed element that is still in flow", () => {
    const findings = checkLayout(VP, {
      ...clean,
      inFlowBackdrops: [{ selector: "canvas.neural", position: "relative", heightShare: 78 }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("backdrop-in-flow");
    expect(findings[0]?.detail).toContain("78%");
    // The detail must name the likely cause, or someone re-derives it from scratch.
    expect(findings[0]?.detail).toContain("> *");
  });

  it("says nothing about a backdrop that is correctly out of flow", () => {
    // A fixed backdrop never reaches the checker — the collector filters it — so an empty
    // list is what a correct page produces.
    expect(checkLayout(VP, { ...clean, inFlowBackdrops: [] })).toHaveLength(0);
  });

  it("reports every offending backdrop, not just the first", () => {
    const findings = checkLayout(VP, {
      ...clean,
      inFlowBackdrops: [
        { selector: "canvas.neural", position: "relative", heightShare: 78 },
        { selector: "div.grid", position: "static", heightShare: 60 },
      ],
    });
    expect(findings.filter((f) => f.kind === "backdrop-in-flow")).toHaveLength(2);
  });
});

describe("an interface compressed into a strip", () => {
  /** The measured broken value. */
  it("reports a page whose regions occupy 15% of the viewport", () => {
    const findings = checkLayout(VP, { ...clean, landmarkShare: 15 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("squeezed");
    expect(findings[0]?.detail).toContain("15%");
  });

  /** The measured correct value on the same page. */
  it("accepts a page whose regions occupy 62% of the viewport", () => {
    expect(checkLayout(VP, { ...clean, landmarkShare: 62 })).toHaveLength(0);
  });

  /**
   * The threshold sits between the two measurements rather than at either. Pinned so a later
   * tightening toward the correct value — which would start failing merely airy designs — is
   * a deliberate change and not a drift.
   */
  it("does not fire at the threshold itself", () => {
    expect(checkLayout(VP, { ...clean, landmarkShare: MIN_LANDMARK_SHARE })).toHaveLength(0);
    expect(checkLayout(VP, { ...clean, landmarkShare: MIN_LANDMARK_SHARE - 1 })).toHaveLength(1);
  });

  /**
   * A document with no landmarks reports 100 from the collector, so it is never accused.
   * This checks layout, not whether someone adopted semantic elements.
   */
  it("does not accuse a page that has no landmark regions", () => {
    expect(checkLayout(VP, { ...clean, landmarkShare: 100 })).toHaveLength(0);
  });
});

/**
 * ══ The collector, run against the real bug, in a real browser ══
 *
 * The tests above judge observations this file constructed, which proves the CHECKER works
 * and says nothing about whether the collector ever produces those observations. This
 * reproduces the exact CSS from the deployed failure — a `position: fixed` backdrop
 * overridden by a `.screen > *` rule — and asserts the collector notices.
 */
describe("collecting a displaced backdrop in a real browser", () => {
  const BROKEN = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{margin:0;font:16px system-ui}
      .screen{height:100dvh;display:grid;grid-template-rows:auto 1fr auto;gap:10px;padding:14px}
      main{display:grid}
      section{background:#111}
      .neural{position:fixed;inset:0;width:100%;height:100%;z-index:0}
      /* The bug: 0,1,1 outranks .neural's 0,1,0 and drags the canvas back into flow. */
      .screen > *{position:relative;z-index:1}
    </style>
    <div class="screen">
      <canvas class="neural"></canvas>
      <header>Title</header>
      <main><section>Body</section></main>
      <footer>Foot</footer>
    </div>`;

  /**
   * ══ Why the landmarks are auto-sized ══
   *
   * An earlier version of this fixture pinned explicit heights, and the broken page then
   * reported a 69% landmark share — because a fixed height does not compress. That hid the
   * bug entirely: on the real page the content row was `1fr`, so the displaced canvas took
   * the space the interface would have grown into.
   *
   * `main{display:grid}` makes the section fill its row, which is what the real layout did
   * and what makes the difference measurable at all.
   */

  const FIXED = BROKEN.replace(".screen > *{", ".screen > *:not(.neural){");

  /**
   * The measured shape of the CORRECTED page: a 519px-tall footer holding one line of text
   * at its top, so landmarkShare read 94% while the interface ended at 70%.
   */
  const SHORT_CONTENT = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{margin:0;font:16px system-ui}
      .screen{height:100dvh;display:grid;grid-template-rows:auto auto 1fr;gap:10px;padding:14px}
      .neural{position:fixed;inset:0;width:100%;height:100%;z-index:0}
      .screen > *:not(.neural){position:relative;z-index:1}
      /* A tall box whose text sits at the TOP — the measured shape. */
      footer{align-self:stretch;display:flex;align-items:flex-start}
      main,section{align-self:start}
    </style>
    <div class="screen">
      <canvas class="neural"></canvas>
      <header>Title</header>
      <main><section>Body</section></main>
      <footer>One line, at the top of a very tall box</footer>
    </div>`;

  async function observe(html: string, width: number, height: number) {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.setContent(html);
      return (await page.evaluate(COLLECT_LAYOUT_SCRIPT)) as LayoutObservation;
    } finally {
      await browser.close();
    }
  }

  it("sees the canvas displacing the interface", { timeout: 60_000 }, async () => {
    const obs = await observe(BROKEN, 1440, 900);
    expect(
      obs.inFlowBackdrops.map((b) => b.selector),
      "the collector did not notice a full-bleed element in flow",
    ).toContain("canvas.neural");

    const findings = checkLayout({ name: "desktop", width: 1440, height: 900 }, obs);
    expect(findings.map((f) => f.kind)).toContain("backdrop-in-flow");
  });

  /**
   * The page does not overflow — that is the whole point. The interface is compressed, not
   * spilled, which is why the pre-existing checks all passed on the deployed version.
   */
  it("confirms the broken page does NOT overflow", { timeout: 60_000 }, async () => {
    const obs = await observe(BROKEN, 1440, 900);
    expect(obs.documentScrollWidth).toBeLessThanOrEqual(obs.viewportWidth + 1);
    expect(
      checkLayout({ name: "desktop", width: 1440, height: 900 }, obs).map((f) => f.kind),
      "an overflow check would never have caught this",
    ).not.toContain("horizontal-overflow");
  });

  /**
   * The collector must MEASURE the share, not report a constant. Sabotage caught this:
   * hardcoding `landmarkShare = 100` passed every test, because every other fixture supplies
   * the value directly and only this browser path exercises the collector.
   */
  it("measures the real landmark share on the broken page", { timeout: 60_000 }, async () => {
    const broken = await observe(BROKEN, 1440, 900);
    const fixed = await observe(FIXED, 1440, 900);

    expect(
      broken.landmarkShare,
      "the collector returned a constant instead of measuring",
    ).toBeLessThan(MIN_LANDMARK_SHARE);
    expect(fixed.landmarkShare).toBeGreaterThanOrEqual(MIN_LANDMARK_SHARE);
    expect(fixed.landmarkShare).toBeGreaterThan(broken.landmarkShare);
  });

  /**
   * The collector must measure where PAINTED TEXT ends, from leaf elements only, ignoring
   * the canvas. Sabotage caught all three of those independently: crediting containers,
   * counting the canvas, and hardcoding the value all passed every fixture-based test,
   * because only this browser path exercises the collector.
   */
  it("measures where painted content actually ends", { timeout: 60_000 }, async () => {
    const short = await observe(SHORT_CONTENT, 1440, 900);

    // The canvas covers the viewport and the footer box is tall, but the text stops early.
    expect(
      short.contentShare,
      "the collector credited an empty container, or counted the backdrop, or hardcoded a value",
    ).toBeLessThan(MIN_CONTENT_SHARE);

    const full = await observe(FIXED, 1440, 900);
    expect(full.contentShare).toBeGreaterThan(short.contentShare);
  });

  it("reports the fixed page as clean", { timeout: 60_000 }, async () => {
    const obs = await observe(FIXED, 1440, 900);
    expect(obs.inFlowBackdrops).toEqual([]);
    expect(checkLayout({ name: "desktop", width: 1440, height: 900 }, obs)).toEqual([]);
  });
});

/**
 * ══ A tall empty container satisfies landmarkShare and hides a half-blank page ══
 *
 * Measured on the CORRECTED version of the page these checks came from: landmarkShare read
 * 94% while the visible interface ended at 70%, because a <footer> was 519px tall holding
 * one line of text at its top.
 */
describe("content that stops short of the screen", () => {
  it("reports a page whose content ends before halfway", () => {
    const findings = checkLayout(VP, { ...clean, landmarkShare: 94, contentShare: 30 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("squeezed");
    expect(findings[0]?.detail).toContain("70% blank");
  });

  /**
   * The detail must name the disagreement. Someone reading "content stops at 30%" while a
   * sibling check reports 94% would otherwise assume one of them is broken.
   */
  it("explains why the landmark measure disagrees", () => {
    const findings = checkLayout(VP, { ...clean, landmarkShare: 94, contentShare: 30 });
    expect(findings[0]?.detail).toContain("94%");
    expect(findings[0]?.detail).toContain("counts as used");
  });

  it("accepts trailing whitespace that is a design choice, not a bug", () => {
    // 70%, as measured on the real corrected page. Loose on purpose: demanding 90% would
    // fail every centred layout.
    expect(checkLayout(VP, { ...clean, contentShare: 70 })).toHaveLength(0);
  });

  it("does not fire at the threshold itself", () => {
    expect(checkLayout(VP, { ...clean, contentShare: MIN_CONTENT_SHARE })).toHaveLength(0);
    expect(checkLayout(VP, { ...clean, contentShare: MIN_CONTENT_SHARE - 1 })).toHaveLength(1);
  });

  /** Both can fail at once, and both must be reported — one fix does not imply the other. */
  it("reports a squeezed interface and short content separately", () => {
    const findings = checkLayout(VP, { ...clean, landmarkShare: 15, contentShare: 20 });
    expect(findings).toHaveLength(2);
  });
});

/**
 * ══ Only a page that claims the viewport can be accused of not filling it ══
 *
 * This check fired on an existing test's fixture — a page with one heading and one button,
 * genuinely 20% filled and entirely correct, because a document-flow page is as tall as its
 * content. Space below it is not missing content.
 */
describe("pages that do not claim the viewport", () => {
  it("does not accuse a document-flow page of leaving space blank", () => {
    expect(
      checkLayout(VP, { ...clean, claimsViewport: false, contentShare: 20 }),
      "an ordinary article or form is as tall as its content",
    ).toHaveLength(0);
  });

  it("still accuses a page that claimed the full viewport", () => {
    const findings = checkLayout(VP, { ...clean, claimsViewport: true, contentShare: 20 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("squeezed");
  });

  /**
   * `squeezed`-by-landmarks applies either way: an interface compressed into a strip is
   * broken whether or not the page claimed the screen.
   */
  it("checks the landmark share regardless of the viewport claim", () => {
    const findings = checkLayout(VP, { ...clean, claimsViewport: false, landmarkShare: 15 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("compressed into a strip");
  });
});
