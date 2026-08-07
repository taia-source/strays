/**
 * MOTION PROOF.
 *
 * A screenshot of a static frame cannot show motion. This grabs 3 raw canvas frames ~400ms apart
 * straight out of the world canvas (via getImageData, so no PNG decode is needed) and diffs them,
 * and separately samples the sim's own body positions over time so we can prove:
 *
 *   - the field is ALIVE   (frames differ: breath, motes, glow)
 *   - an idle cat is STILL (its slot position is identical across samples)
 *   - a re-slotted cat WALKS (its position moves continuously over ~1400ms, then stops)
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const SD = process.argv[2];
const BASE = process.argv[3] ?? "http://127.0.0.1:3000";
const WIDTHS = process.argv[4] ? process.argv[4].split(",").map(Number) : [390, 1440];
mkdirSync(SD, { recursive: true });

const b = await chromium.launch();

for (const w of WIDTHS) {
  const page = await b.newPage({
    viewport: { width: w, height: w < 500 ? 844 : 900 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);

  // Grab raw canvas pixels three times, 400ms apart, and diff in-page.
  await page.evaluate(() => {
    window.__frames = [];
    window.__grab = () => {
      const c = document.querySelector("canvas.world-canvas");
      if (!c) return false;
      const g = c.getContext("2d");
      window.__frames.push(g.getImageData(0, 0, c.width, c.height).data);
      return true;
    };
  });
  const grabs = [];
  for (let i = 0; i < 3; i++) {
    grabs.push(await page.evaluate(() => window.__grab()));
    await page.screenshot({ path: `${SD}/frame-${w}-${i}.png` });
    if (i < 2) await page.waitForTimeout(400);
  }
  const diffs = await page.evaluate(() => {
    const f = window.__frames;
    if (f.length < 3) return null;
    const cmp = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6 || Math.abs(a[i + 2] - b[i + 2]) > 6) n++;
      }
      return (n / (a.length / 4)) * 100;
    };
    return { d01: cmp(f[0], f[1]), d02: cmp(f[0], f[2]) };
  });

  // Sample the sim's own state, if the world exposes it for the harness.
  const samples = [];
  for (let i = 0; i < 8; i++) {
    samples.push(await page.evaluate(() => (window.__world ? window.__world() : null)));
    await page.waitForTimeout(400);
  }

  const layout = await page.evaluate(() => ({
    hOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));

  console.log(`\n═══ ${w}px ═══  (grabs ok: ${grabs.join(",")})`);
  if (diffs) console.log(`canvas diff 0→1: ${diffs.d01.toFixed(3)}%   0→2: ${diffs.d02.toFixed(3)}%   (0 = DEAD field)`);
  console.log(`layout: hOverflow=${layout.hOver} vScrollable=${layout.vScroll}`);
  if (samples[0]) {
    console.log(`bodies=${samples[0].n} tokens=${samples[0].tokens}`);
    const ids = Object.keys(samples[0].bodies ?? {});
    for (const id of ids) {
      const pos = samples.map((s) => s && s.bodies[id]).filter(Boolean);
      const step = pos.map((p, i) => (i === 0 ? 0 : Math.hypot(p.x - pos[i - 1].x, p.y - pos[i - 1].y)));
      console.log(`  ${id.slice(0, 10)} mode=${[...new Set(pos.map((p) => p.mode))].join("/")}`);
      console.log(`     x=${pos.map((p) => p.x.toFixed(1)).join(" ")}`);
      console.log(`     stepPer400ms=${step.map((m) => m.toFixed(2)).join(" ")}`);
    }
  } else {
    console.log("  (no window.__world probe)");
  }
  if (errs.length) console.log(`  CONSOLE ERRORS: ${errs.slice(0, 5).join(" | ")}`);
  await page.close();
}
await b.close();
