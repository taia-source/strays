import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1440,height:900}, colorScheme:"dark" });
p.on("pageerror", e=>console.log("PAGEERROR:", String(e).slice(0,300)));
p.on("console", m=>{ if(m.type()==="error") console.log("ERR:", m.text().slice(0,200)); });
await p.goto("http://127.0.0.1:3000/app",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(7000);
console.log(await p.evaluate(()=>{
  const cs = document.querySelectorAll("canvas");
  return {
    canvasCount: cs.length,
    list: [...cs].map(c=>({cls:c.className, w:c.width,h:c.height, sw:c.style.width, sh:c.style.height, rect:c.getBoundingClientRect().toJSON()})),
    field: (()=>{const f=document.querySelector(".world-field"); return f? {rect:f.getBoundingClientRect().toJSON(), html:f.innerHTML.slice(0,200)}:null;})(),
  };
}));
await b.close();
