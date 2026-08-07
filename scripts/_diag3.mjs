import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:1440,height:900}});
p.on("response",r=>{ if(r.status()>=400) console.log(r.status(), r.url()); });
await p.goto("http://127.0.0.1:3200/",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(2000);
await b.close();
