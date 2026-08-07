/**
 * Screenshot + no-scroll assertion harness for the three-defect fix.
 *
 * Asserts BOTH axes on the documentElement for the locked routes: `scrollWidth === clientWidth`
 * AND `scrollHeight === clientHeight`. A page that fits horizontally and overflows vertically is
 * still a scrolling page, and the whole point of DEFECT 3 is that `/` must do neither.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const SD = process.argv[2];
const BASE = process.argv[3] ?? "http://127.0.0.1:3904";
mkdirSync(SD, { recursive: true });

const ROUTES = [
  ["/", "landing", true],
  ["/docs", "docs", true],
  ["/logs", "logs", true],
  ["/leaderboard", "board", false],
];
const WIDTHS = [320, 390, 768, 1440];
const SCHEMES = ["dark", "light"];

const b = await chromium.launch();
let fails = 0;

for (const [path, name, strict] of ROUTES) {
  for (const scheme of SCHEMES) {
    for (const w of WIDTHS) {
      const p = await b.newPage({
        viewport: { width: w, height: w < 500 ? 844 : 900 },
        deviceScaleFactor: 1,
        colorScheme: scheme,
      });
      await p.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      // Let the hero cat cycle land on a frame and any client island hydrate.
      await p.waitForTimeout(2600);
      await p.screenshot({ path: `${SD}/${name}-${scheme}-${w}.png` });
      const m = await p.evaluate(() => {
        const d = document.documentElement;
        return {
          sw: d.scrollWidth,
          cw: d.clientWidth,
          sh: d.scrollHeight,
          ch: d.clientHeight,
          route: document.body.getAttribute("data-route"),
        };
      });
      const okW = m.sw === m.cw;
      const okH = m.sh === m.ch;
      const bad = strict && (!okW || !okH);
      if (bad) fails++;
      console.log(
        `${bad ? "FAIL" : "ok  "} ${name}@${w}/${scheme} route=${m.route} ` +
          `W ${m.sw}/${m.cw}${okW ? "" : " <-OVERFLOW"} H ${m.sh}/${m.ch}${okH ? "" : " <-SCROLLS"}`,
      );
      await p.close();
    }
  }
}

await b.close();
console.log(fails === 0 ? "\nALL LOCKED ROUTES FIT" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
