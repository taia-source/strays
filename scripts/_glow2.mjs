import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage();
await p.goto("about:blank");
console.log(await p.evaluate(()=>{
  const c=document.createElement("canvas"); c.width=c.height=200;
  const x=c.getContext("2d");
  const col="oklch(0.78 0.17 85)";
  const g=x.createRadialGradient(100,100,0,100,100,100);
  g.addColorStop(0,col);
  g.addColorStop(0.35,`color-mix(in oklab, ${col} 42%, transparent)`);
  g.addColorStop(1,`color-mix(in oklab, ${col} 0%, transparent)`);
  x.fillStyle=g; x.fillRect(0,0,200,200);
  // sample alpha along radius
  const prof=[];
  for(let r=0;r<=100;r+=10){ const d=x.getImageData(100+r,100,1,1).data; prof.push(`r${r}:a${d[3]} rgb(${d[0]},${d[1]},${d[2]})`); }
  return prof;
}));
await b.close();
