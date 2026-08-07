import { chromium } from "playwright";
const SD = process.argv[2];
const b = await chromium.launch();
for (const scheme of ["light","dark"]) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: scheme });
  await p.goto("http://127.0.0.1:3700/colony", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(700);
  const cat = p.locator(".colony-grid svg").first();
  await cat.screenshot({ path: `${SD}/cat-${scheme}.png` }).catch(()=>console.log("no cat found"));
  await p.close();
}
await b.close(); console.log("shot cat closeups");
