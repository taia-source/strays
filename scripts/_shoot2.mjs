import { chromium } from "playwright";
const SD = process.argv[2] ?? "/tmp/sd";
const only = process.argv[3];
const b = await chromium.launch();
const widths = [320, 390, 768, 1440];
const routes = [["/","landing"],["/app","world"],["/docs","docs"],["/logs","logs"],["/leaderboard","board"]];
let bad = 0;
for (const scheme of ["dark","light"]) {
for (const [path,name] of routes) {
  if (only && name !== only) continue;
  for (const w of widths) {
    const p = await b.newPage({ viewport:{width:w,height:w<500?844:900}, deviceScaleFactor:2, colorScheme:scheme });
    await p.goto(`http://127.0.0.1:3200${path}`,{waitUntil:"domcontentloaded"}).catch(()=>{});
    await p.waitForTimeout(1200);
    await p.screenshot({ path:`${SD}/shots/${scheme}-${name}-${w}.png` });
    const m = await p.evaluate(()=>({sh:document.documentElement.scrollHeight,ch:document.documentElement.clientHeight,sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));
    const scrolls = name==="docs" ? false : (m.sh!==m.ch || m.sw!==m.cw);
    if (scrolls) { console.log(`SCROLL ${scheme}/${name}@${w}: h ${m.sh}/${m.ch} w ${m.sw}/${m.cw}`); bad++; }
    await p.close();
  }
}}
await b.close();
console.log(bad===0?"NO-SCROLL OK":`${bad} SCROLL FAILURES`);
