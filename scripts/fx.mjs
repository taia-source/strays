import { chromium } from "playwright";
const SD=process.argv[2]; const b=await chromium.launch();
for (const [p,n] of [["/","landing"],["/logs","logs"]]) {
  for (const w of [390,1440]) {
    const pg=await b.newPage({viewport:{width:w,height:w<500?844:900},deviceScaleFactor:2,colorScheme:"dark"});
    await pg.goto(`http://127.0.0.1:3961${p}`,{waitUntil:"domcontentloaded",timeout:30000});
    await pg.waitForTimeout(2600);
    await pg.screenshot({path:`${SD}/fx/${n}-${w}.png`,fullPage:false});
    const m=await pg.evaluate(()=>({h:document.documentElement.scrollWidth-document.documentElement.clientWidth,v:document.documentElement.scrollHeight-document.documentElement.clientHeight}));
    console.log(`${n}@${w}: hOverflow=${m.h} vScroll=${m.v}`);
    await pg.close();
  }
}
await b.close();
