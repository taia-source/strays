"use client";

/**
 * THE PERSISTENT NAV — one component, mounted in `layout.tsx`, on every route.
 *
 * ══ WHY IT IS IN THE LAYOUT AND NOT IN EACH PAGE ══
 *
 * Ibrahim: *"i also said leaderboard route, logs route and something else ... i dont see any routes
 * or header."* The routes EXISTED — `/logs`, `/leaderboard`, `/docs` were all built and all served
 * — and every one of them was unreachable from anywhere except a link at the bottom of the landing
 * page. That is the same class of failure as not building them.
 *
 * Putting it in the layout makes "a route with no way to reach it" unrepresentable: a new route
 * inherits the nav by existing. A per-page `<Nav/>` would work identically until the first page
 * that forgets it, which is the page that gets shipped.
 *
 * ══ DESKTOP IS A ROW. MOBILE IS ONE 44px BUTTON AND A BOTTOM SHEET. ══
 *
 * The sheet opens from the BOTTOM, and silvertongue records the reason in its own words: *"the
 * trigger sits in the top bar but the thumb does not: on a 844px-tall phone the top-right corner is
 * the hardest place to reach one-handed, so the CONTENT opens from the bottom where the thumb
 * already is."* Four nav links crammed into a 320px row is the alternative, and at 320px they wrap
 * to two rows and eat a fifth of a no-scroll viewport.
 *
 * ══ THE NAV IS PART OF THE NO-SCROLL BUDGET, WHICH IS WHY IT DECLARES ITS OWN HEIGHT ══
 *
 * `--nav-h` is set here in CSS and the world subtracts it. A nav that sizes itself from its content
 * would silently change the world's height whenever a label changed, and the failure mode of that
 * is a 1px scrollbar on one route at one width — which is exactly the bug being fixed.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";

type NavLink = { readonly href: string; readonly label: string; readonly short: string };

/**
 * The routes, in the order a visitor needs them.
 *
 * THE COLONY leads because it is the app. DOCS is last because it is the only one that is prose.
 * The adopt CTA is separate below — it is an ACTION, not a place, and putting it in this list would
 * make it the fifth of five equal things.
 */
const LINKS: readonly NavLink[] = [
  { href: "/app", label: "THE COLONY", short: "COLONY" },
  { href: "/leaderboard", label: "LEADERBOARD", short: "BOARD" },
  { href: "/logs", label: "LOGS", short: "LOGS" },
  { href: "/docs", label: "DOCS", short: "DOCS" },
];

export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const sheetId = useId();

  // Route change closes the sheet. Without this, tapping a link navigates and leaves the sheet
  // covering the page it navigated to — the classic mobile-nav bug that only shows up on a real tap.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape closes it. A sheet that traps a keyboard user is worse than no sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /** `/app` is the colony; `/colony` is kept as an alias so an old link still highlights. */
  const isActive = (href: string): boolean =>
    href === "/app"
      ? pathname === "/app" || pathname.startsWith("/colony") || pathname.startsWith("/stray")
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="site-nav" data-world-reserved="">
      <div className="site-nav-row">
        <Link href="/" className="site-mark" aria-label="STRAYS — home">
          <span className="site-mark-word">STRAYS</span>
          {/* The one live signal in the header: the sensor is on. It is CSS-animated, so it
              costs nothing and it is suppressed by the reduced-motion rule with everything else. */}
          <span className="site-mark-dot" aria-hidden="true" />
        </Link>

        <nav className="site-links" aria-label="Primary">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="site-link"
              aria-current={isActive(l.href) ? "page" : undefined}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="site-nav-end">
          <Link href="/app#adopt" className="site-cta">
            ADOPT
          </Link>
          {/*
            ONE button. 44px, per the pointer-agnostic rule — a thumb target, not a mouse target.
            `aria-expanded` and `aria-controls` are what make it a real disclosure rather than a
            div that happens to toggle something.
          */}
          <button
            type="button"
            className="site-burger"
            aria-expanded={open}
            aria-controls={sheetId}
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "✕" : "☰"}
          </button>
        </div>
      </div>

      {open ? (
        <>
          {/*
            A real `<button>` as the scrim, not a click handler on a div: it dismisses on click AND
            on keyboard activation, which is what the a11y rule is actually about.
          */}
          <button
            type="button"
            className="site-scrim"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
          <div className="site-sheet" id={sheetId} role="dialog" aria-label="Menu">
            <div className="site-sheet-grip" aria-hidden="true" />
            <nav className="site-sheet-links" aria-label="Primary, mobile">
              {LINKS.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="site-sheet-link"
                  aria-current={isActive(l.href) ? "page" : undefined}
                >
                  {l.label}
                </Link>
              ))}
            </nav>
            <Link href="/app#adopt" className="site-sheet-cta">
              ADOPT A STRAY
            </Link>
            <p className="stamp site-sheet-note">
              Robinhood Chain · 4663 — a stray trades memecoins. You can lose all of it.
            </p>
          </div>
        </>
      ) : null}
    </header>
  );
}
