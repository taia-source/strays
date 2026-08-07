import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1440,height:900}, colorScheme:"dark" });
await p.goto("http://localhost:3101/app",{waitUntil:"load"});
await p.waitForTimeout(10000);
console.log(await p.evaluate(()=>({
  reactRoot: !!document.querySelector("#__next, [data-reactroot]"),
  buttons: document.querySelectorAll("button").length,
  pauseBtnText: document.querySelector(".world-btn")?.textContent,
  canvases: document.querySelectorAll("canvas").length,
  scripts: [...document.querySelectorAll("script[src]")].map(s=>s.src.split("/").pop()).slice(0,12),
  fieldChildren: document.querySelector(".world-field")?.children.length,
})));
// Does clicking pause work => hydration alive?
try { await p.click(".world-btn", {timeout:3000}); console.log("clicked; text now:", await p.textContent(".world-btn")); } catch(e){ console.log("click failed:", e.message.slice(0,120)); }
await b.close();
