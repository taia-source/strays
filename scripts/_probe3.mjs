import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1440,height:900}, colorScheme:"dark" });
p.on("console", m=>console.log(m.type().toUpperCase().slice(0,4), m.text().slice(0,300)));
p.on("pageerror", e=>console.log("PAGEERROR:", (e.stack||String(e)).slice(0,800)));
await p.goto("http://127.0.0.1:3000/app",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(9000);
console.log("--- field html:", await p.evaluate(()=>document.querySelector(".world-field")?.innerHTML.slice(0,600)));
await b.close();
