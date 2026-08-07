// Does an IDLE cat stay put? That is the whole point of the bloodhorn model.
// Sample the cat's drawn position across frames; it must not drift.
import { chromium } from "playwright";
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1,colorScheme:"dark"});
await p.goto("http://127.0.0.1:3970/app",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(3000);
const shots=[];
for (let i=0;i<8;i++){
  shots.push(await p.evaluate(()=>{
    const c=document.querySelector("canvas"); if(!c) return null;
    const ctx=c.getContext("2d"); if(!ctx) return null;
    // hash the canvas so we can tell "identical" from "changing"
    const d=ctx.getImageData(0,0,c.width,c.height).data;
    let h=2166136261;
    for(let k=0;k<d.length;k+=997){ h^=d[k]; h=Math.imul(h,16777619); }
    return h>>>0;
  }));
  await p.waitForTimeout(400);
}
const distinct=new Set(shots.filter(x=>x!==null)).size;
console.log(`canvas hashes over 8 frames @400ms: ${distinct} distinct of ${shots.length}`);
console.log(distinct>1 ? "  -> the canvas IS animating (breath/atmosphere alive)" : "  -> canvas static");
await p.close(); await b.close();
