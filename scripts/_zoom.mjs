import { chromium } from "playwright";
const SD=process.argv[2], W=Number(process.argv[3]||1440);
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:W,height:W<500?844:900},deviceScaleFactor:2,colorScheme:process.argv[4]||"dark"});
await p.goto("http://localhost:3101/app",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(7000);
const w = await p.evaluate(()=>window.__world?window.__world():null);
console.log(JSON.stringify(w,null,1).slice(0,500));
if (w) {
  for (const [id,b2] of Object.entries(w.bodies)) {
    await p.screenshot({path:`${SD}/cat-${W}.png`, clip:{x:Math.max(0,b2.x-110),y:Math.max(0,b2.y-110),width:220,height:220}});
    console.log("cat at",b2.x,b2.y);
  }
}
await b.close();
