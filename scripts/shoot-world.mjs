/**
 * The screenshot harness, with ASSERTIONS.
 *
 * Extends `shoot.mjs` with the two things the world route has to prove and a document cannot:
 *
 *   1. NO HORIZONTAL OVERFLOW, anywhere, at any width. (Already in shoot.mjs.)
 *   2. NO VERTICAL SCROLL on the fixed routes: `scrollHeight === clientHeight`.
 *
 * BOTH colour schemes are shot. Headless Chromium defaults to LIGHT, and a first pass that shoots
 * only the default never sees the real palette — unitick shipped a light theme nobody had opened,
 * with near-black type on a near-black rail, and "a contrast checker never fails on a surface with
 * no text on it".
 *
 * `fullPage: false` on the fixed routes ON PURPOSE: `fullPage` on a `position: fixed` layout
 * captures the document's height, not the viewport's, which hides the exact defect being tested.
 */
import { chromium } from "playwright";

const SD = process.argv[2];
const BASE = process.argv[3] ?? "http://127.0.0.1:3200";

const widths = [320, 390, 768, 1440];
const routes = [
  { path: "/", name: "landing", fixed: false },
  { path: "/app", name: "world", fixed: true },
  { path: "/leaderboard", name: "board", fixed: true },
  { path: "/logs", name: "logs", fixed: true },
  { path: "/docs", name: "docs", fixed: false },
];

const b = await chromium.launch();
let failures = 0;

for (const scheme of ["dark", "light"]) {
  for (const r of routes) {
    for (const w of widths) {
      const page = await b.newPage({
        viewport: { width: w, height: w < 500 ? 844 : 900 },
        deviceScaleFactor: 2,
        colorScheme: scheme,
      });
      await page.goto(`${BASE}${r.path}`, { waitUntil: "domcontentloaded" });
      // The world needs a moment for the canvas to mount (dynamic import) and for the sim to have
      // taken a few ticks — a screenshot at t=0 shows cats at their spawn points, which tells you
      // nothing about whether they move.
      await page.waitForTimeout(r.fixed ? 1800 : 600);

      await page.screenshot({
        path: `${SD}/${scheme}-${r.name}-${w}.png`,
        fullPage: !r.fixed,
      });

      const m = await page.evaluate(() => ({
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scrollH: document.documentElement.scrollHeight,
        clientH: document.documentElement.clientHeight,
        bodyScrollH: document.body.scrollHeight,
        route: document.body.getAttribute("data-route"),
      }));

      if (m.overflowX > 0) {
        console.log(`  FAIL OVERFLOW-X ${scheme}/${r.name}@${w}: ${m.overflowX}px`);
        failures++;
      }
      if (r.fixed && m.scrollH !== m.clientH) {
        console.log(
          `  FAIL VSCROLL ${scheme}/${r.name}@${w}: scrollHeight ${m.scrollH} !== clientHeight ${m.clientH} (data-route=${m.route})`,
        );
        failures++;
      }
      await page.close();
    }
  }
}

await b.close();
console.log(failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION FAILURES`);
process.exit(failures === 0 ? 0 : 1);
