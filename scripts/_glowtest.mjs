import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage();
await p.goto("about:blank");
console.log(await p.evaluate(()=>{
  const c=document.createElement("canvas"); c.width=c.height=100;
  const x=c.getContext("2d");
  const out={};
  // does color-mix work in a gradient stop?
  try { const g=x.createRadialGradient(50,50,0,50,50,50);
    g.addColorStop(0,"oklch(0.78 0.17 85)");
    g.addColorStop(0.35,"color-mix(in oklab, oklch(0.78 0.17 85) 42%, transparent)");
    g.addColorStop(1,"color-mix(in oklab, oklch(0.78 0.17 85) 0%, transparent)");
    x.fillStyle=g; x.fillRect(0,0,100,100);
    const d=x.getImageData(50,50,1,1).data; out.colorMixCentre=[...d];
    const d2=x.getImageData(70,50,1,1).data; out.colorMixMid=[...d2];
  } catch(e){ out.colorMixError=e.message; }
  // clear, try oklch + globalAlpha
  x.clearRect(0,0,100,100);
  try { const g=x.createRadialGradient(50,50,0,50,50,50);
    g.addColorStop(0,"oklch(0.78 0.17 85 / 1)");
    g.addColorStop(0.35,"oklch(0.78 0.17 85 / 0.42)");
    g.addColorStop(1,"oklch(0.78 0.17 85 / 0)");
    x.fillStyle=g; x.fillRect(0,0,100,100);
    out.oklchAlphaCentre=[...x.getImageData(50,50,1,1).data];
    out.oklchAlphaMid=[...x.getImageData(70,50,1,1).data];
  } catch(e){ out.oklchAlphaError=e.message; }
  return out;
}));
await b.close();
