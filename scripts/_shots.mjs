import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const SD=process.argv[2]; mkdirSync(SD,{recursive:true});
const b = await chromium.launch();
for (const scheme of ["dark","light"]) {
  for (const w of [320,390,768,1440]) {
    const p = await b.newPage({viewport:{width:w,height:w<500?844:900},deviceScaleFactor:2,colorScheme:scheme});
    await p.goto("http://localhost:3101/app",{waitUntil:"domcontentloaded"});
    await p.waitForTimeout(5000);
    await p.screenshot({path:`${SD}/${scheme}-${w}.png`});
    const m = await p.evaluate(()=>({
      hOver: document.documentElement.scrollWidth-document.documentElement.clientWidth,
      vScroll: document.documentElement.scrollHeight-document.documentElement.clientHeight,
    }));
    console.log(`${scheme}@${w}: hOverflow=${m.hOver} vScrollable=${m.vScroll} ${m.hOver||m.vScroll?"*** FAIL":"ok"}`);
    await p.close();
  }
}
await b.close();
