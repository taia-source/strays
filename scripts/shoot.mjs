import { chromium } from "playwright";
const SD = process.argv[2];
const b = await chromium.launch();
// BOTH themes get shot. unitick shipped a light theme nobody had opened, with near-black type on a
// near-black rail — "a contrast checker never fails on a surface with no text on it". The only
// thing that finds that class of bug is opening the page in both.
// The four widths ART-DIRECTION §6 requires. openhood took ZERO mobile captures and drew NINE
// mobile complaints; the one session that shot 320/390/480/767 is where the complaints stopped.
const widths = [320, 390, 768, 1440];
const routes = [["/","landing"],["/colony","colony"],["/docs","docs"],["/logs","logs"],["/leaderboard","board"]];
for (const scheme of ["dark", "light"]) {
for (const [path, name] of routes) {
  for (const w of widths) {
    const p = await b.newPage({
      viewport: { width: w, height: w < 500 ? 844 : 900 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
    await p.goto(`http://127.0.0.1:3200${path}`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(400); // let fonts and the idle animation settle to frame 1
    await p.screenshot({ path: `${SD}/shots/${scheme}-${name}-${w}.png`, fullPage: true });
    // report any horizontal overflow — the body must NEVER scroll sideways
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) console.log(`  OVERFLOW ${scheme}/${name}@${w}: ${over}px`);
    await p.close();
  }
}
}
await b.close();
console.log("shot", routes.length * widths.length, "screenshots");
