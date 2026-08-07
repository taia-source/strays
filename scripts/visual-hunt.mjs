/**
 * VISUAL VERIFICATION OF THE HUNT.
 *
 * The live vault has one dead stray, so the deployed world correctly renders zero cats. That is the
 * honest state — and it means I cannot SEE whether cats render, wander, stalk, pounce, hold, or
 * drag. "It compiles and the unit assertions pass" is not the same as "it looks alive", and this
 * project's whole method is to LOOK at the rendered pixels.
 *
 * So: intercept `/api/world` in the BROWSER ONLY, at test time, and serve a colony. Nothing is
 * written to the app; no fixture ships. This is a camera pointed at the renderer.
 */
import { chromium } from "playwright";
const SD = process.argv[2];

const strays = [
  { id: "0x" + "a1".repeat(32), owner: "0x" + "11".repeat(20), stakeEth: 0.021, principalEth: 0.015, pnlEth: 0.006, holding: null, state: "fed" },
  { id: "0x" + "b2".repeat(32), owner: "0x" + "22".repeat(20), stakeEth: 0.0052, principalEth: 0.005, pnlEth: 0.0002, holding: null, state: "hunting" },
  { id: "0x" + "c3".repeat(32), owner: "0x" + "33".repeat(20), stakeEth: 0.0012, principalEth: 0.005, pnlEth: -0.0038, holding: null, state: "starving" },
  { id: "0x" + "d4".repeat(32), owner: "0x" + "44".repeat(20), stakeEth: 0.009, principalEth: 0.008, pnlEth: 0.001, holding: null, state: "hunting" },
  { id: "0x" + "e5".repeat(32), owner: "0x" + "55".repeat(20), stakeEth: 0.0301, principalEth: 0.02, pnlEth: 0.0101, holding: null, state: "fed" },
];

const b = await chromium.launch();

for (const [w, h, tag] of [[1440, 900, "1440"], [390, 844, "390"]]) {
  const page = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: "dark" });

  // Phase 1: nobody is in a position — pure ambient life.
  let phase = 0;
  await page.route("**/api/world", async (route) => {
    // A poll can still be in flight when the page closes; `route.fetch` then throws
    // "Request context disposed". That is a harness race, not an app defect — swallow it.
    let body;
    try {
      const real = await route.fetch();
      body = await real.json();
    } catch {
      return route.abort().catch(() => {});
    }
    const withHold = strays.map((s, i) =>
      phase >= 1 && i < 3 ? { ...s, holding: body.quarry.ok ? body.quarry.tokens[i % body.quarry.tokens.length].address : null, state: "hunting" } : s);
    await route
      .fulfill({ json: { ...body, colony: { ok: true, strays: withHold, block: "30375999" } } })
      .catch(() => {});
  });

  await page.goto(`http://127.0.0.1:3200/app`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${SD}/hunt-${tag}-a-prowl.png` });

  // Phase 2: three cats enter positions. They must STALK there, not teleport.
  phase = 1;
  await page.waitForTimeout(5200);   // one poll + ~2s of stalking
  await page.screenshot({ path: `${SD}/hunt-${tag}-b-stalk.png` });
  await page.waitForTimeout(6000);   // enough to arrive and hold
  await page.screenshot({ path: `${SD}/hunt-${tag}-c-hold.png` });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.close();
}
await b.close();
console.log("hunt shots done");
