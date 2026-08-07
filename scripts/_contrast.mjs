import { chromium } from "playwright";
const b = await chromium.launch();
const routes=["/","/app","/logs","/leaderboard","/docs"];
let worst=99, fails=[];
for (const scheme of ["dark","light"]) {
for (const r of routes) {
  const p = await b.newPage({viewport:{width:1440,height:900},colorScheme:scheme});
  await p.goto(`http://127.0.0.1:3200${r}`,{waitUntil:"domcontentloaded"});
  await p.waitForTimeout(1200);
  const res = await p.evaluate(()=>{
    const lin=v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4);
    // getComputedStyle returns oklch() here, not rgb(). Parsing its components as sRGB is why the
    // first version of this reported ~1.0 for text that is plainly legible. Let the browser do the
    // conversion by painting the colour and reading the pixel back.
    const _cv=document.createElement("canvas"); _cv.width=_cv.height=1;
    const _cx=_cv.getContext("2d",{willReadFrequently:true});
    const toRgb=c=>{_cx.clearRect(0,0,1,1);_cx.fillStyle="#000";_cx.fillStyle=c;_cx.fillRect(0,0,1,1);const d=_cx.getImageData(0,0,1,1).data;return [d[0],d[1],d[2]];};
    const L=c=>{const [r,g,b]=toRgb(c);return 0.2126*lin(r/255)+0.7152*lin(g/255)+0.0722*lin(b/255);};
    const ratio=(a,b)=>{const x=L(a),y=L(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
    const bg=el=>{let e=el;while(e){const c=getComputedStyle(e).backgroundColor;if(c&&!/rgba\(0, 0, 0, 0\)|transparent/.test(c))return c;e=e.parentElement;}return getComputedStyle(document.body).backgroundColor;};
    const out=[];
    for(const el of document.querySelectorAll("p,li,td,th,dd,dt,h1,h2,h3,a,span,strong,button")){
      const t=el.textContent?.trim(); if(!t||el.children.length>0) continue;
      const cs=getComputedStyle(el);
      if(cs.visibility==="hidden"||cs.display==="none"||parseFloat(cs.opacity)<0.5) continue;
      const rc=el.getBoundingClientRect(); if(rc.width<2||rc.height<2) continue;
      const size=parseFloat(cs.fontSize), wgt=parseInt(cs.fontWeight)||400;
      const large = size>=24 || (size>=18.66 && wgt>=700);
      out.push({t:t.slice(0,28), r:+ratio(cs.color,bg(el)).toFixed(2), size, large, cls:el.className?.toString().slice(0,26)});
    }
    return out;
  });
  for (const x of res) {
    // BODY text must clear 7:1. Large display type is held to 4.5.
    const need = x.large ? 4.5 : 7;
    if (x.r < need) fails.push(`${scheme}${r} "${x.t}" ${x.r} < ${need} (${x.size}px .${x.cls})`);
    if (!x.large && x.r < worst) worst = x.r;
  }
  await p.close();
}}
await b.close();
console.log("worst non-large body contrast:", worst);
console.log(fails.length?`FAILURES (${fails.length}):\n`+fails.slice(0,25).join("\n"):"ALL TEXT PASSES");
