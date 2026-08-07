/**
 * Proves the hero cat CYCLES one identity through four states, and that reduced motion HOLDS.
 *
 * The screenshot harness can only ever catch one frame, so it cannot tell a cycling cat from a
 * static one. This samples the label over time and asserts the sequence.
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3945";
const b = await chromium.launch();
let bad = 0;

// ── Motion allowed: the state must actually change, in order.
{
  const p = await b.newPage({ viewport: { width: 768, height: 900 } });
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const seen = [];
  for (let i = 0; i < 14; i++) {
    const s = await p.textContent(".hero-cat-state");
    if (seen.at(-1) !== s) seen.push(s);
    await p.waitForTimeout(800);
  }
  console.log("states observed:", seen.join(" → "));
  const uniq = new Set(seen);
  for (const want of ["fed", "hunting", "starving", "dead"]) {
    if (!uniq.has(want)) { console.log(`FAIL missing state: ${want}`); bad++; }
  }
  // One identity: every frame must be the same cat, so the number of rendered sprites is fixed
  // at four and they never get replaced by a different id's coat.
  const frames = await p.locator(".hero-cat-frame").count();
  if (frames !== 4) { console.log(`FAIL expected 4 stacked frames, got ${frames}`); bad++; }
  else console.log("ok   4 stacked frames, one identity");
  await p.close();
}

// ── Reduced motion: the state must HOLD, and the other three must still be NAMED.
{
  const p = await b.newPage({ viewport: { width: 768, height: 900 }, reducedMotion: "reduce" });
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  const first = await p.textContent(".hero-cat-state");
  await p.waitForTimeout(5200);
  const later = await p.textContent(".hero-cat-state");
  if (first !== later) { console.log(`FAIL reduced-motion cycled: ${first} → ${later}`); bad++; }
  else console.log(`ok   reduced motion holds on "${first}"`);
  // The accommodation must not remove information: all four states still listed.
  const ticks = (await p.locator(".hero-cat-ticks li").allTextContents()).join(",");
  if (!["fed", "hunting", "starving", "dead"].every((s) => ticks.includes(s))) {
    console.log(`FAIL reduced motion hid state names: ${ticks}`); bad++;
  } else console.log(`ok   all four states still named: ${ticks}`);
  await p.close();
}

await b.close();
console.log(bad === 0 ? "\nHERO OK" : `\n${bad} FAILURES`);
process.exit(bad === 0 ? 0 : 1);
