"use client";

/**
 * Stamps `data-route` on `<body>` so CSS can decide which routes scroll.
 *
 * ══ WHY AN ATTRIBUTE AND NOT A PER-ROUTE LAYOUT ══
 *
 * A per-route layout is the obvious answer and it does not work for this problem: the rule that has
 * to change is `overflow` on `html` and `body`, which are owned by the ROOT layout and rendered
 * once. A nested layout cannot restyle its own ancestors, and `position: fixed` on a child does not
 * stop the document from having scrollable overflow — silvertongue's `.world-root` only holds
 * because the document behind it has nothing tall in it. Ours does: a nav, and whatever the route
 * renders. So the switch has to reach `html`/`body`, and this is the smallest thing that does.
 *
 * ══ WHY THE DEFAULT IS `scroll` ══
 *
 * `data-route` is absent until hydration. The stylesheet's default — with no attribute — is
 * scrollable, and the no-scroll lock is an additive rule. Being wrong in that direction for one
 * frame gives an untidy page; being wrong the other way gives an unreadable one, and a first-paint
 * lock would clip the landing page's risk disclosure for every user with JS disabled.
 */

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Routes that must SCROLL. Long-form prose only.
 *
 * An allowlist of scrollers rather than an allowlist of locked routes, deliberately: a new route is
 * far more likely to be another world-like panel view than another essay, and the failure mode of
 * getting it wrong is milder (an unnecessary scrollbar, versus a clipped page).
 *
 * ══ `/` CAME OFF THIS LIST ══
 *
 * Ibrahim: *"didn't i tell you no scroll on the frontend? have you checked the landing page?"* It
 * was on this list, and the argument for it — that the risk disclosure could not fit a fixed
 * viewport — assumed the word count was immovable. It was not. The copy was cut to fit and every
 * risk claim survived intact; the risk panel scrolls INTERNALLY on a short viewport rather than
 * the document scrolling. See the header of `app/page.tsx`.
 *
 * `/docs` stays: it is a genuine reference document (the mechanism, the fee maths, the custody
 * model, the full unaudited disclosure) and there is no honest word budget that fits it in one
 * viewport. It is a fixed SHELL with an internally-scrolling body — see `.doc` in `globals.css` —
 * so the DOCUMENT still does not scroll, which is the property the rule is actually about.
 */
const SCROLLS: readonly string[] = [];

export function RouteShell() {
  const pathname = usePathname();

  useEffect(() => {
    const scrolls = SCROLLS.includes(pathname) || pathname.startsWith("/docs/");
    const mode = scrolls ? "scroll" : "fixed";
    document.body.setAttribute("data-route", mode);
    document.documentElement.setAttribute("data-route", mode);
    return () => {
      // Cleanup matters here: without it, navigating world → landing leaves the lock on and the
      // landing page's risk copy is unreachable. That is a disclosure bug wearing a CSS costume.
      document.body.removeAttribute("data-route");
      document.documentElement.removeAttribute("data-route");
    };
  }, [pathname]);

  return null;
}
