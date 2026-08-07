import { chromium } from "playwright";
const b=await chromium.launch();
for (const w of [390,1440]) {
const p=await b.newPage({viewport:{width:w,height:w<500?844:900},colorScheme:"dark"});
await p.goto("http://localhost:3101/app",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(5000);
console.log(w, JSON.stringify(await p.evaluate(()=>{
  const c=document.querySelector("canvas.world-canvas").getBoundingClientRect();
  return {canvas:{t:c.top,l:c.left,w:c.width,h:c.height},
   reserved:[...document.querySelectorAll("[data-world-reserved]")].map(e=>{
     const r=e.getBoundingClientRect(); return {cls:e.className, t:Math.round(r.top-c.top),b:Math.round(r.bottom-c.top),l:Math.round(r.left-c.left),r:Math.round(r.right-c.left),w:Math.round(r.width),h:Math.round(r.height)};})};
})));
await p.close();}
await b.close();
