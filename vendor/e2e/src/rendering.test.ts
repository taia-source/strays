import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  assessRendering,
  COLLECT_RENDERING_SCRIPT,
  checkRendering,
  formatRendering,
  type RenderingObservation,
} from "./rendering.js";

const empty: RenderingObservation = {
  brokenImages: [],
  collisions: [],
  spills: [],
  collapsed: [],
};

describe("checkRendering", () => {
  it("passes a clean page", () => {
    expect(checkRendering(empty)).toEqual([]);
    expect(formatRendering(assessRendering(empty))).toContain("rendering is correct");
  });

  it("names the failed src on a broken image", () => {
    const [finding] = checkRendering({
      ...empty,
      brokenImages: [{ selector: "#hero", src: "/missing.png", alt: "Product photo" }],
    });
    expect(finding?.kind).toBe("broken-image");
    expect(finding?.detail).toContain("/missing.png");
    expect(finding?.detail).toContain("Product photo");
  });

  it("says when a broken image has no alt to fall back on", () => {
    const [finding] = checkRendering({
      ...empty,
      brokenImages: [{ selector: "#deco", src: "/x.png", alt: "" }],
    });
    expect(finding?.detail).toContain("no alt text");
  });

  it("names what covers a collided element", () => {
    const [finding] = checkRendering({
      ...empty,
      collisions: [{ selector: "#t1", coveredBy: "#t2" }],
    });
    expect(finding?.kind).toBe("text-collision");
    expect(finding?.detail).toContain("#t2");
  });

  it("quantifies a spill", () => {
    const [finding] = checkRendering({ ...empty, spills: [{ selector: "#box", by: 140 }] });
    expect(finding?.kind).toBe("content-spill");
    expect(finding?.detail).toContain("140px wider");
  });

  it("explains a collapsed container rather than just naming it", () => {
    const [finding] = checkRendering({ ...empty, collapsed: ["#wrap"] });
    expect(finding?.kind).toBe("collapsed-container");
    expect(finding?.detail).toContain("thin line");
  });

  it("reports every defect on a page, not just the first", () => {
    const result = assessRendering({
      brokenImages: [{ selector: "#i", src: "/a.png", alt: "" }],
      collisions: [{ selector: "#t1", coveredBy: "#t2" }],
      spills: [{ selector: "#b", by: 10 }],
      collapsed: ["#c"],
    });
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(4);
  });
});

/**
 * Real-browser tests. Split deliberately into "finds the real defects" and "does not fire
 * on legitimate layout" — the second half is what decides whether this check survives
 * contact with a real project or gets switched off.
 */
describe("in a real browser", () => {
  async function observe(html: string): Promise<RenderingObservation> {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(html, { waitUntil: "load" });
      return (await page.evaluate(COLLECT_RENDERING_SCRIPT)) as RenderingObservation;
    } finally {
      await browser.close();
    }
  }

  const BROKEN = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{margin:0;font:16px system-ui}
      .box{width:150px;height:40px;border:2px solid #333;overflow:visible;white-space:nowrap}
      .t1{position:absolute;top:300px;left:20px}
      .t2{position:absolute;top:305px;left:24px}
      .collapsed{border:1px solid red}
      .floated{float:left;height:40px}
    </style>
    <img id="brokenimg" src="/does-not-exist.png" alt="Product photo" width="100" height="100">
    <div class="box" id="spill">This text is far too long for its bordered box</div>
    <div class="t1" id="t1">First line of text here</div>
    <div class="t2" id="t2">Second line collides</div>
    <div class="collapsed" id="collapse"><div class="floated">floated child</div></div>`;

  it("finds an image that failed to load", { timeout: 60_000 }, async () => {
    const obs = await observe(BROKEN);
    expect(obs.brokenImages.map((i) => i.selector)).toContain("#brokenimg");
    expect(obs.brokenImages.find((i) => i.selector === "#brokenimg")?.alt).toBe("Product photo");
  });

  it("finds text drawn on top of other text", { timeout: 60_000 }, async () => {
    const obs = await observe(BROKEN);
    const hit = obs.collisions.find((c) => c.selector === "#t1");
    expect(hit, "#t1 is covered by #t2 and must be reported").toBeDefined();
    expect(hit?.coveredBy).toBe("#t2");
  });

  it("finds content spilling outside its bordered box", { timeout: 60_000 }, async () => {
    const obs = await observe(BROKEN);
    expect(obs.spills.map((s) => s.selector)).toContain("#spill");
  });

  it("finds a container collapsed around a floated child", { timeout: 60_000 }, async () => {
    const obs = await observe(BROKEN);
    expect(obs.collapsed).toContain("#collapse");
  });

  it("fails the page as a whole", { timeout: 60_000 }, async () => {
    const result = assessRendering(await observe(BROKEN));
    expect(result.ok).toBe(false);
    expect(formatRendering(result)).toContain("RENDERING FAILED");
  });

  /**
   * The half that matters most.
   *
   * Naive bounding-box intersection reports BOTH of these as overlaps — measured:
   * `badgeOverlapsCard: true`, `modalOverlapsEverything: true`. Both are correct,
   * intentional design. A checker that flags them is deleted within a day, so each is
   * asserted clean here.
   */
  describe("does not fire on legitimate layout", () => {
    const FINE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{margin:0;font:16px system-ui}
        .card{position:relative;width:300px;height:120px;background:#eee;margin:10px}
        .badge{position:absolute;top:8px;right:8px;background:red;color:#fff;padding:2px 6px}
        .modal{position:fixed;inset:0;background:rgba(0,0,0,.5)}
        .modal-inner{position:absolute;top:50px;left:20px;width:300px;height:200px;background:#fff}
        .scroller{width:150px;overflow-x:auto;white-space:nowrap}
      </style>
      <div class="card"><h3 id="title">Title</h3><p>Body text</p><span class="badge" id="badge">NEW</span></div>
      <div class="modal"><div class="modal-inner"><p id="modaltext">Modal content</p></div></div>
      <div class="scroller" id="scroller">Deliberately scrollable content that is wider than its box</div>
      <img id="okimg" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="10" height="10" alt="tiny">`;

    it("does not call a badge on a card a collision", { timeout: 60_000 }, async () => {
      const obs = await observe(FINE);
      expect(obs.collisions.map((c) => c.selector)).not.toContain("#badge");
      expect(obs.collisions.map((c) => c.selector)).not.toContain("#title");
    });

    it("does not call a modal overlay a collision", { timeout: 60_000 }, async () => {
      const obs = await observe(FINE);
      expect(obs.collisions.map((c) => c.selector)).not.toContain("#modaltext");
    });

    it("does not call a deliberate horizontal scroller a spill", { timeout: 60_000 }, async () => {
      // overflow-x:auto is a scroll region, not content escaping its bounds.
      const obs = await observe(FINE);
      expect(obs.spills.map((s) => s.selector)).not.toContain("#scroller");
    });

    it("does not report an image that loaded", { timeout: 60_000 }, async () => {
      const obs = await observe(FINE);
      expect(obs.brokenImages.map((i) => i.selector)).not.toContain("#okimg");
    });

    it("passes the legitimate page outright", { timeout: 60_000 }, async () => {
      const result = assessRendering(await observe(FINE));
      expect(result.ok, `expected clean, got: ${formatRendering(result)}`).toBe(true);
    });
  });
});
