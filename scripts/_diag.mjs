import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:1440,height:900},colorScheme:"light"});
await p.goto("http://127.0.0.1:3200/",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(1500);
console.log(await p.evaluate(()=>{
  const d=document.documentElement, b=document.body;
  const over=[...document.querySelectorAll("*")].filter(e=>{
    const r=e.getBoundingClientRect();
    return r.bottom > d.clientHeight+1;
  }).slice(0,8).map(e=>`${e.tagName}.${e.className}`.slice(0,70)+` bottom=${Math.round(e.getBoundingClientRect().bottom)}`);
  return {route:d.dataset.route, bodyRoute:b.dataset.route, dsh:d.scrollHeight, dch:d.clientHeight, bodyOverflow:getComputedStyle(b).overflow, htmlOverflow:getComputedStyle(d).overflow, over};
}));
await b.close();
