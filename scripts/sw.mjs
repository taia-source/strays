import { chromium } from "playwright";
const SD=process.argv[2];
const b=await chromium.launch();
for (const [path,name] of [["/app","world"],["/","landing"],["/leaderboard","board"],["/logs","logs"]]) {
  for (const w of [390,1440]) {
    const p=await b.newPage({viewport:{width:w,height:w<500?844:900},deviceScaleFactor:2,colorScheme:"dark"});
    await p.goto(`http://127.0.0.1:3904${path}`,{waitUntil:"domcontentloaded",timeout:25000});
    await p.waitForTimeout(2500); // let the sim run so the world is MOVING
    await p.screenshot({path:`${SD}/w6/${name}-${w}.png`});
    const m=await p.evaluate(()=>({
      hOver: document.documentElement.scrollWidth-document.documentElement.clientWidth,
      vScroll: document.documentElement.scrollHeight-document.documentElement.clientHeight,
    }));
    console.log(`${name}@${w}: hOverflow=${m.hOver} vScrollable=${m.vScroll}`);
    await p.close();
  }
}
await b.close();
