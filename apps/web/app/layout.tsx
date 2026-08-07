/**
 * The root layout — and the ONE place the nav is mounted.
 *
 * Ibrahim: *"i also said leaderboard route, logs route and something else ... i dont see any routes
 * or header."* Every one of those routes existed and was served; none of them was reachable. A nav
 * added per-page works right up until the page that forgets it, and that is the page that ships.
 * Mounting it here makes "a route with no way to reach it" unrepresentable.
 *
 * ══ WHICH ROUTES SCROLL, AND WHY THAT IS DECIDED IN A LAYOUT ══
 *
 * `/` and `/docs` are LONG-FORM PROSE and must scroll — the landing page carries the four things a
 * visitor has to read before they part with money (what it is, what it costs, what can go wrong,
 * the way in), and the risk disclosure is deliberately not collapsed behind a toggle. unitick
 * recorded the exact trap: the tempting fix for a cramped mobile layout was `display: none` on the
 * help text, which would have hidden "NOT INVESTING — YOUR ENTRY IS AT RISK" and traded a layout
 * defect for a disclosure defect. A no-scroll landing page is that trade with extra steps.
 *
 * Everything else — the world, the leaderboard, the logs — is fixed-viewport with internal scroll
 * on panels only.
 *
 * The switch is a `<body data-route>` attribute set by a client component reading `usePathname`,
 * because the ROOT layout cannot read the pathname on the server (that would opt every route out of
 * static rendering). It is one attribute and CSS does the rest, so nothing renders differently
 * before hydration — only the overflow rule changes, and the pre-hydration default is `scroll`,
 * which is the safe direction to be wrong in: a page that scrolls when it shouldn't is untidy, a
 * page that doesn't scroll when it should is unreadable.
 */
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteNav } from "./nav/site-nav";
import { RouteShell } from "./nav/route-shell";

export const metadata: Metadata = {
  title: "STRAYS",
  description: "Feed a stray. It hunts letscash. It brings back what it kills.",
};

/**
 * `viewport-fit=cover` so `env(safe-area-inset-*)` reports real values on a notched phone; without
 * it the insets are all zero and the padding that keeps the nav clear of the notch does nothing.
 *
 * `maximumScale` is deliberately ABSENT. Locking zoom is the one viewport setting that breaks a
 * low-vision user outright, and no layout problem is worth that.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0d0a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <RouteShell />
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
