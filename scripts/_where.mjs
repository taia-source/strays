import { chromium } from "playwright";
const b=await chromium.launch();
for (const w of [320,390,768,1440]) {
const p=await b.newPage({viewport:{width:w,height:w<500?844:900},colorScheme:"dark"});
await p.goto("http://localhost:3101/app",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(5500);
const r = await p.evaluate(()=>{
  const c=document.querySelector("canvas.world-canvas").getBoundingClientRect();
  const wd=window.__world?window.__world():null;
  const panels=[...new Set([...document.querySelectorAll("[data-world-reserved]"),...document.querySelectorAll(".world-adopt")])].map(e=>{const q=e.getBoundingClientRect();return{cls:e.className.split(" ")[0],t:Math.round(q.top-c.top),b:Math.round(q.bottom-c.top),l:Math.round(q.left-c.left),r:Math.round(q.right-c.left)};});
  return {canvasH:Math.round(c.height), bodies:wd&&wd.bodies, panels};
});
const bod = r.bodies? Object.values(r.bodies)[0]:null;
console.log(`${w}: canvasH=${r.canvasH} cat=${bod?`(${bod.x.toFixed(0)},${bod.y.toFixed(0)}) ${bod.mode}`:"none"}`);
for(const q of r.panels) console.log(`    ${q.cls} t${q.t} b${q.b} l${q.l} r${q.r}${bod&&bod.x>q.l&&bod.x<q.r&&bod.y>q.t&&bod.y<q.b?"  <<< CAT IS UNDER THIS":""}`);
await p.close();}
await b.close();
