import { chromium } from "playwright";
const SD = process.argv[2];
const U = "https://web-production-19a12.up.railway.app";
const b = await chromium.launch();
for (const scheme of ["dark", "light"]) {
  for (const [path, name] of [["/","landing"],["/colony","colony"],["/docs","docs"],["/logs","logs"],["/leaderboard","board"]]) {
    for (const w of [390, 1440]) {
      const p = await b.newPage({ viewport: { width: w, height: w < 500 ? 844 : 900 }, deviceScaleFactor: 2, colorScheme: scheme });
      await p.goto(`${U}${path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await p.waitForTimeout(900);
      await p.screenshot({ path: `${SD}/live/${scheme}-${name}-${w}.png`, fullPage: true });
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 0) console.log(`  OVERFLOW ${scheme}/${name}@${w}: ${over}px`);
      await p.close();
    }
  }
}
await b.close();
console.log("shot 20 LIVE screenshots");
