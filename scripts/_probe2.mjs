import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1440,height:900}, colorScheme:"dark" });
p.on("requestfailed", r=>console.log("REQFAIL:", r.url().slice(0,140), r.failure()?.errorText));
p.on("response", async r=>{ if(r.status()>=400) console.log("HTTP",r.status(), r.url().slice(0,160)); });
p.on("pageerror", e=>console.log("PAGEERROR:", String(e).slice(0,400)));
await p.goto("http://127.0.0.1:3000/app",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(8000);
await b.close();
