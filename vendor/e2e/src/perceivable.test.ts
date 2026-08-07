import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  assessPerceivable,
  describeFailures,
  formatPerceivable,
  PERCEIVABLE_SCRIPT,
  type PerceivableObservation,
} from "./perceivable.js";

describe("describeFailures", () => {
  it("names the occluder rather than saying 'not visible'", () => {
    const text = describeFailures({
      selector: "#submit",
      failures: ["occluded"],
      topElementAtCentre: ".banner",
    });
    expect(text).toContain("covered by .banner");
  });

  it("lists every reason, not just the first", () => {
    const text = describeFailures({
      selector: "#x",
      failures: ["offscreen", "zero-opacity"],
      topElementAtCentre: undefined,
    });
    expect(text).toContain("outside the viewport");
    expect(text).toContain("zero effective opacity");
  });

  it("says plainly that Playwright disagrees", () => {
    expect(
      describeFailures({ selector: "#x", failures: ["offscreen"], topElementAtCentre: undefined }),
    ).toContain("isVisible() returns true");
  });
});

describe("assessPerceivable", () => {
  const ok: Omit<PerceivableObservation, "detail"> = {
    selector: "#a",
    perceivable: true,
    failures: [],
  };

  it("passes when everything is perceivable", () => {
    const result = assessPerceivable([ok, { ...ok, selector: "#b" }]);
    expect(result.ok).toBe(true);
    expect(formatPerceivable(result)).toContain("genuinely perceivable");
  });

  it("fails the run when one element is not", () => {
    const result = assessPerceivable([
      ok,
      { selector: "#b", perceivable: false, failures: ["occluded"], topElementAtCentre: ".modal" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(formatPerceivable(result)).toContain("covered by .modal");
  });
});

/**
 * The tests that make this module worth having.
 *
 * Each asserts the SAME element is `isVisible() === true` in Playwright and NOT
 * perceivable here. If Playwright ever tightens its definition these fail loudly, which is
 * the correct outcome — the module would no longer be needed.
 */
describe("against a real browser, versus Playwright's isVisible()", () => {
  const PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{margin:0;font:16px system-ui}
      .off{position:absolute;left:-9999px}
      .zero{opacity:0}
      .fadedparent{opacity:0}
      .clipped{position:absolute;clip-path:inset(100%)}
      .behind{position:absolute;top:0;left:0;z-index:1}
      .cover{position:absolute;top:0;left:0;width:300px;height:60px;background:#fff;z-index:2}
      .good{display:block;width:200px;height:44px;margin-top:80px}
    </style>
    <a class="off" id="a-off" href="/x">offscreen left</a>
    <a class="zero" id="a-zero" href="/x">opacity zero</a>
    <div class="fadedparent"><a id="a-child" href="/x">child of a faded parent</a></div>
    <a class="clipped" id="a-clip" href="/x">clip-path hidden</a>
    <a class="behind" id="a-behind" href="/x">behind an overlay</a>
    <div class="cover"></div>
    <a class="good" id="a-good" href="/x">genuinely visible</a>`;

  async function withPage<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(PAGE);
      return await fn(page);
    } finally {
      await browser.close();
    }
  }

  async function check(
    page: import("playwright").Page,
    selector: string,
  ): Promise<PerceivableObservation> {
    return (await page.evaluate(
      `(${PERCEIVABLE_SCRIPT})(${JSON.stringify(selector)})`,
    )) as PerceivableObservation;
  }

  it("catches an element parked off the left edge", { timeout: 60_000 }, async () => {
    await withPage(async (page) => {
      expect(await page.locator("#a-off").isVisible()).toBe(true); // Playwright says yes
      const obs = await check(page, "#a-off");
      expect(obs.perceivable).toBe(false);
      expect(obs.failures).toContain("offscreen");
    });
  });

  it("catches zero opacity", { timeout: 60_000 }, async () => {
    await withPage(async (page) => {
      expect(await page.locator("#a-zero").isVisible()).toBe(true);
      const obs = await check(page, "#a-zero");
      expect(obs.perceivable).toBe(false);
      expect(obs.failures).toContain("zero-opacity");
    });
  });

  it("catches a child whose PARENT is faded", { timeout: 60_000 }, async () => {
    // The child's own computed opacity is 1. Only walking the ancestor chain finds this.
    await withPage(async (page) => {
      expect(await page.locator("#a-child").isVisible()).toBe(true);
      const obs = await check(page, "#a-child");
      expect(obs.perceivable).toBe(false);
      expect(obs.failures).toContain("zero-opacity");
    });
  });

  it("catches clip-path removal", { timeout: 60_000 }, async () => {
    await withPage(async (page) => {
      expect(await page.locator("#a-clip").isVisible()).toBe(true);
      const obs = await check(page, "#a-clip");
      expect(obs.perceivable).toBe(false);
    });
  });

  it("catches an element behind an opaque overlay, and names it", { timeout: 60_000 }, async () => {
    await withPage(async (page) => {
      expect(await page.locator("#a-behind").isVisible()).toBe(true);
      const obs = await check(page, "#a-behind");
      expect(obs.perceivable).toBe(false);
      expect(obs.failures).toContain("occluded");
      expect(obs.topElementAtCentre).toBe("div.cover");
    });
  });

  it("does NOT flag a genuinely visible element", { timeout: 60_000 }, async () => {
    // Without this the module could pass every test above by always returning false.
    await withPage(async (page) => {
      const obs = await check(page, "#a-good");
      expect(obs.failures).toEqual([]);
      expect(obs.perceivable).toBe(true);
    });
  });

  it("reports a missing element rather than throwing", { timeout: 60_000 }, async () => {
    await withPage(async (page) => {
      const obs = await check(page, "#does-not-exist");
      expect(obs.perceivable).toBe(false);
      expect(obs.failures).toContain("display-none");
    });
  });
});
