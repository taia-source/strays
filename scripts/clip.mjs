import { chromium } from "playwright";
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:390,height:844},deviceScaleFactor:2,colorScheme:"dark"});
await p.goto("http://127.0.0.1:3101/",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(1200);
// Is any TEXT clipped by its own container? A no-scroll assertion cannot see this.
const bad = await p.evaluate(() => {
  const out=[];
  for (const el of document.querySelectorAll("li,p,dd,h2,strong")) {
    const s=getComputedStyle(el);
    if (s.display==="none") continue;
    const clipped = el.scrollHeight > el.clientHeight + 1;
    const parent = el.closest("[class]");
    const pClipped = parent ? parent.scrollHeight > parent.clientHeight + 1 : false;
    if (clipped || pClipped) out.push({t:(el.textContent||"").slice(0,50), own:clipped, parent:pClipped, cls:parent?.className});
  }
  return out.slice(0,6);
});
console.log(JSON.stringify(bad,null,1));
await b.close();
