"use client";

/**
 * THE WORLD — the orchestrator.
 *
 * Owns three of silvertongue's four clocks. The fourth (the 30Hz fixed-step sim) lives inside the
 * renderer's rAF loop, deliberately: a `setInterval` at 33ms drifts and doubles up after a tab
 * switch, and the accumulator in the render loop is the only form that stays correct across a
 * backgrounded tab. Silvertongue's camera-mirror clock has no analogue here — this world has no
 * camera, because ART-DIRECTION referent rule 3 says **the camera does not follow**: the frame is
 * fixed and things enter and leave it.
 *
 *   5000ms  — poll `/api/world`. Chain + letscash, both halves independently fallible.
 *   1000ms  — the clock, for the "Ns ago" stamp. One state update a second, not sixty.
 *   rAF     — inside `WorldCanvas`.
 *
 * ══ WHAT THIS PAGE PROMISES, AND WHAT IT REFUSES ══
 *
 * Every cat on the field is a real adopted stray read from `StrayVault`. Every diamond is a real
 * letscash launch read from the pad's own API this minute. When there are no strays the field is
 * EMPTY and the HUD says "no strays adopted yet" in words — never a demo cat, never a placeholder.
 * `chain.ts`'s header states why: *"a blank table reads as broken, a fake one reads as fine"*, and
 * the fake one is the dangerous defect.
 *
 * When a READ FAILS, that is reported as a failure and never as emptiness. Those are different
 * facts and the payload's discriminated union makes it impossible to confuse them here.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorldPayload } from "../api/world/route";
import { EXPLORER, PAD_SITE } from "../lib/config";
import type { CanvasAgent } from "./world-canvas";

/**
 * The canvas is client-only. A 2D canvas has no server-rendered form — `jsdom` and the SSR pass
 * both return `null` from `getContext("2d")`, so a server render is a blank element plus a
 * hydration warning. `ssr: false` is the honest declaration of that.
 */
const WorldCanvas = dynamic(() => import("./world-canvas").then((m) => m.WorldCanvas), {
  ssr: false,
});

const POLL_MS = 5000;

export function WorldApp({
  initial,
  adopt,
}: {
  readonly initial: WorldPayload;
  /**
   * The adoption panel, rendered by the server route and placed into the HUD grid here.
   *
   * A ReactNode rather than a boolean flag: `<Adopt>` is a client component that the SERVER route
   * composes, and passing it through keeps its wallet-connect bundle out of this module while
   * still letting the grid own its position. See the note at the call site in `app/page.tsx`.
   */
  readonly adopt?: ReactNode;
}) {
  const [world, setWorld] = useState<WorldPayload>(initial);
  /** Set when a POLL fails. Distinct from `colony.ok:false` — that is the server's own read. */
  const [pollFailed, setPollFailed] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  /**
   * The first render's clock is the PAYLOAD's timestamp, not `Date.now()`. The server and the
   * client must produce identical text on the first pass or hydration fails (React #418) — and
   * every "Ns ago" label differs between the server's clock and the client's by definition. The
   * interval below moves to real time immediately after mount.
   */
  const [now, setNow] = useState(initial.at);

  /*
   * `prefers-reduced-motion`, read on the client and WATCHED.
   *
   * Read-once-on-mount is the common form and it is wrong: a user who flips the OS setting while
   * the page is open keeps the animation until they reload. The listener costs one line.
   *
   * It starts `false` rather than reading `matchMedia` during render — a render-time media query
   * differs between server (no matchMedia) and client, which is a hydration mismatch.
   */
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // ── Clock. One update a second: enough for a stamp, cheap enough to be free. ──────────
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Poll. A failure marks the data stale; it NEVER blanks the world. ─────────────────
  const pollRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      // A slow read must not stack behind itself: on a bad connection a 5s interval over an 8s
      // request queues requests forever and each one lands out of order.
      if (pollRef.current) return;
      pollRef.current = true;
      try {
        const res = await fetch("/api/world", { cache: "no-store" });
        if (!res.ok) throw new Error(`world poll: ${res.status}`);
        const next = (await res.json()) as WorldPayload;
        if (!cancelled) {
          setWorld(next);
          setPollFailed(false);
        }
      } catch {
        if (!cancelled) setPollFailed(true);
      } finally {
        pollRef.current = false;
      }
    };
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const colony = world.colony;
  const quarry = world.quarry;

  /*
   * The canvas inputs, memoised on the payload.
   *
   * Without `useMemo` these are fresh arrays on every render — and the clock re-renders once a
   * second — so `agentsRef.current` would be a new identity every second. That does not currently
   * break anything (the renderer reads through refs precisely so it cannot), but it is the exact
   * shape of the bug that WOULD break it the moment anyone adds a dependency array.
   */
  const agents = useMemo<readonly CanvasAgent[]>(() => {
    if (!colony.ok) return [];
    /*
     * A DEAD stray is not on the field.
     *
     * `classify` in chain.ts marks a stray dead when its stake is zero and it holds nothing — the
     * cat starved out and left the colony, which DESIGN §2 says is the risk drama. Drawing it
     * anyway would show a cat that is not there. It is still counted in the roster below, as dead,
     * because deleting it from the record would be hiding a loss (DESIGN §9).
     */
    return colony.strays
      .filter((s) => s.state !== "dead")
      .map((s) => ({
        id: s.id,
        stakeEth: s.stakeEth,
        holding: s.holding,
        state: s.state,
        pnlEth: s.pnlEth,
      }));
  }, [colony]);

  const tokens = useMemo(() => {
    if (!quarry.ok) return [];
    return quarry.tokens.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      marketCapEth: t.marketCapEth,
      huntable: t.huntable,
    }));
  }, [quarry]);

  const onHover = useCallback((id: string | null) => setHovered(id), []);

  const huntableCount = quarry.ok ? quarry.tokens.filter((t) => t.huntable).length : 0;
  const liveStrays = agents.length;
  const hunting = agents.filter((a) => a.holding !== null).length;
  const hoveredStray = colony.ok ? colony.strays.find((s) => s.id === hovered) : undefined;
  const ageSec = Math.max(0, Math.round((now - world.at) / 1000));

  return (
    <div className="world-root">
      {/*
        The canvas fills the world and everything else floats OVER it with `pointer-events: none`,
        re-enabled on the interactive children. That is silvertongue's HUD rule and it is what stops
        a full-bleed overlay from eating every pointer event the canvas needs.
      */}
      <div className="world-field">
        <WorldCanvas
          agents={agents}
          tokens={tokens}
          paused={paused}
          reduced={reduced}
          onHover={onHover}
        />
      </div>

      <div className="world-hud">
        {/* ── Top-left: what the world IS, and what it is showing right now. ───────────── */}
        <div className="world-hud-tl" data-world-reserved="">
          <p className="world-line">
            <span className="world-key">COLONY</span>{" "}
            {colony.ok ? (
              <span className="fig">{liveStrays}</span>
            ) : (
              <span className="starve">unreadable</span>
            )}
            {colony.ok ? <span className="world-sub"> live</span> : null}
            {colony.ok && hunting > 0 ? (
              <span className="fed"> · {hunting} in a position</span>
            ) : null}
          </p>
          <p className="world-line">
            <span className="world-key">QUARRY</span>{" "}
            {quarry.ok ? (
              <>
                <span className="fig">{quarry.tokens.length}</span>
                <span className="world-sub"> on field · </span>
                <span className="fed">{huntableCount} huntable</span>
                <span className="world-sub"> of {quarry.scanned} scanned</span>
              </>
            ) : (
              <span className="starve">unreadable</span>
            )}
          </p>
          <p className="stamp world-stamp">
            {colony.ok ? `block ${colony.block} · ` : ""}
            {ageSec < 2 ? "just now" : `${ageSec}s ago`}
            {pollFailed ? " · LAST GOOD READ" : ""}
          </p>
        </div>

        {/* ── Top-right: the controls. One row, 44px targets. ──────────────────────────── */}
        <div className="world-hud-tr" data-world-reserved="">
          <button
            type="button"
            className="world-btn"
            aria-pressed={paused}
            onClick={() => setPaused((p) => !p)}
            /* Disabled under reduced motion: the sim is already suppressed, and a "pause"
               button that pauses nothing is a control that lies about what it does. */
            disabled={reduced}
          >
            {reduced ? "MOTION OFF" : paused ? "▶ RESUME" : "❚❚ PAUSE"}
          </button>
        </div>

        {/*
        ══ THE HONEST STATE BANNERS ══

        These are the whole reason this page can be trusted. Three DIFFERENT sentences for three
        different facts, and the payload's shape means they cannot be conflated:

          - the chain read FAILED           → "the colony could not be read"
          - the chain read SUCCEEDED, empty → "no strays adopted yet"
          - the letscash read FAILED        → "the quarry could not be read"

        Rendering the first as the second is the specific lie this codebase is shaped against.
      */}
      {!colony.ok ? (
        <div className="world-banner starve-banner" role="status">
          <p>
            <strong>The colony could not be read.</strong> {colony.reason}
          </p>
          <p className="stamp">
            This is a failure to reach the chain, NOT an empty colony. No cat is drawn, because we
            do not know what is there.
          </p>
        </div>
      ) : liveStrays === 0 ? (
        <div className="world-banner" role="status">
          <p>
            <strong>No strays are living here yet.</strong>{" "}
            {colony.strays.length > 0
              ? `${colony.strays.length} ${colony.strays.length === 1 ? "cat has" : "cats have"} been adopted and starved out.`
              : "Nothing has been adopted on this vault."}
          </p>
          <p className="stamp">
            The field is empty because the colony is empty — this page will not draw a cat that does
            not exist. The quarry below is real and live; it is what the first stray will hunt.
          </p>
          <Link href="/app#adopt" className="world-banner-cta">
            ADOPT THE FIRST STRAY
          </Link>
        </div>
      ) : null}

      {/*
        ══ THE ROSTER — the canvas's accessible twin ══

        The canvas is `aria-hidden`. A screen reader cannot read a canvas, and a `role="img"` with a
        paragraph-long label is worse than a real list. So the same data the field draws is here as
        text: every cat, its stake, its state, what it holds. This is not a fallback — it is the
        readable form of the world, and it stays useful for a sighted user too (it is where the
        addresses and explorer links live, which a canvas cannot carry).
      */}
      <aside className="world-roster" aria-label="The colony, as data" data-world-reserved="">
        <header className="world-roster-head">
          <h2>ON THE FIELD</h2>
          <p className="stamp">
            {quarry.ok ? `${huntableCount} huntable target${huntableCount === 1 ? "" : "s"}` : "quarry unreadable"}
          </p>
        </header>

        <div className="world-roster-body">
          {colony.ok && colony.strays.length > 0 ? (
            <ul className="world-list">
              {colony.strays.map((s) => (
                <li key={s.id} data-state={s.state} data-hovered={hovered === s.id ? "" : undefined}>
                  <Link href={`/stray/${s.id}`} className="world-list-id">
                    {s.id.slice(0, 8)}…
                  </Link>
                  <span className="fig">{s.stakeEth.toFixed(5)} ETH</span>
                  <span className={`world-list-state ${s.pnlEth > 0 ? "fed" : s.pnlEth < 0 ? "starve" : ""}`}>
                    {s.state}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <h3 className="world-roster-sub">THE QUARRY — live on letscash</h3>
          {quarry.ok ? (
            quarry.tokens.length === 0 ? (
              <p className="stamp">
                No launches on the list right now. The pad returned {quarry.scanned} rows and none
                parsed — this is a real empty list, not a failed read.
              </p>
            ) : (
              <ul className="world-list world-quarry-list">
                {quarry.tokens.map((t) => (
                  <li key={t.address} data-huntable={t.huntable ? "" : undefined}>
                    <a
                      href={`${PAD_SITE}/token/${t.address}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="world-list-id"
                    >
                      {t.symbol}
                    </a>
                    <span className="fig">{t.marketCapEth.toFixed(2)} Ξ</span>
                    {/* WHY a token is not huntable, not just that it isn't. The tax is the one
                        filter that decides whether this product can make money (RESEARCH §3c), so
                        naming it is the difference between a rule and an arbitrary rejection. */}
                    <span className={t.huntable ? "fed" : "world-sub"}>
                      {t.huntable ? "huntable" : `${t.taxPct}% tax`}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="stamp starve">
              The quarry could not be read: {quarry.reason}. This is not "no tokens launched" — it
              is a failed read of the launchpad.
            </p>
          )}
        </div>

        <footer className="world-roster-foot stamp">
          <a href={`${EXPLORER}/address/${process.env.NEXT_PUBLIC_VAULT ?? ""}`} hidden>
            vault
          </a>
          <span>
            {hoveredStray !== undefined
              ? `${hoveredStray.id.slice(0, 10)}… — ${hoveredStray.state}`
              : "cats hunt the diamonds. amber = a target a stray may take."}
          </span>
        </footer>
        </aside>

        {/* DESIGN §7 steps 3 and 4 — the only two interactions in the product. */}
        {adopt}
      </div>
    </div>
  );
}
