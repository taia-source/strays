/**
 * The behavioural assertions a screenshot cannot make.
 *   1. The prose routes (/ and /docs) STILL SCROLL — the no-scroll lock must not clip disclosure.
 *   2. The world route does not scroll, in either direction.
 *   3. `prefers-reduced-motion` renders a SETTLED world: two frames 2s apart are identical.
 *   4. Without reduced motion the world MOVES: two frames 1s apart differ.
 */
import { chromium } from "playwright";
const b = await chromium.launch();
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"} ${m}`); if (!c) fail++; };

// 1 + 2 — scrollability per route
for (const [path, name, shouldScroll] of [["/","landing",true],["/docs","docs",true],["/app","world",false],["/logs","logs",false],["/leaderboard","board",false]]) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  await p.goto(`http://127.0.0.1:3200${path}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  const m = await p.evaluate(() => ({ s: document.documentElement.scrollHeight, c: document.documentElement.clientHeight }));
  const scrolls = m.s > m.c + 1;
  ok(scrolls === shouldScroll, `${name}: ${shouldScroll ? "scrolls (prose)" : "does not scroll (fixed)"} — scrollH ${m.s} vs clientH ${m.c}`);
  await p.close();
}

// 3 — reduced motion renders settled
{
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  await p.goto("http://127.0.0.1:3200/app", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  /*
   * Clipped to the LOWER TWO THIRDS of the canvas.
   *
   * A whole-canvas comparison fails for a reason that is not a defect: the HUD panels are
   * translucent, so the "Ns ago" freshness stamp bleeding through them changes those pixels every
   * second — and that clock MUST keep counting under reduced motion, because a stale-data stamp
   * that freezes is a stamp that lies. The thing being asserted is that the WORLD is settled, so
   * the assertion looks at the part of the canvas the world has to itself.
   */
  const clip = { x: 0, y: 300, width: 1440, height: 500 };
  const a = await p.screenshot({ clip: { ...clip, y: clip.y + 56 } });
  await p.waitForTimeout(2000);
  const c = await p.screenshot({ clip: { ...clip, y: clip.y + 56 } });
  ok(Buffer.compare(a, c) === 0, `reduced motion: world region identical across 2s (settled, sim suppressed)`);
  await p.close();
}

// 4 — without it, the world moves
{
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await p.goto("http://127.0.0.1:3200/app", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  // Same region, so the two assertions are measuring exactly the same pixels.
  const clip2 = { x: 0, y: 356, width: 1440, height: 500 };
  const a = await p.screenshot({ clip: clip2 });
  await p.waitForTimeout(1200);
  const c = await p.screenshot({ clip: clip2 });
  ok(Buffer.compare(a, c) !== 0, `normal motion: world region CHANGES across 1.2s (the world is alive)`);
  await p.close();
}
await b.close();
console.log(fail === 0 ? "\nALL BEHAVIOUR ASSERTIONS PASSED" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
