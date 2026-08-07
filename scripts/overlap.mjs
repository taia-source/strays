// Do two idle cats actually overlap? Measure the drawn positions, do not eyeball it.
import { chromium } from "playwright";
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1440,height:900},colorScheme:"dark"});
await p.goto("http://127.0.0.1:3970/app",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(3500);
const r = await p.evaluate(()=>{
  const w = window;
  const dbg = w.__STRAYS_DEBUG__;
  if (dbg) return dbg();
  return null;
});
if (r) { console.log(JSON.stringify(r,null,1)); }
else {
  // No debug hook — fall back to pixel analysis of the den region.
  const shot = await p.screenshot({clip:{x:250,y:600,width:400,height:300}});
  console.log("no debug hook; captured den region, bytes:", shot.length);
}
await p.close(); await b.close();
