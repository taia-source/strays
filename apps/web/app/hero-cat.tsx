"use client";

/**
 * ONE cat, cycling its four states, on the landing page.
 *
 * ══ WHAT THIS REPLACES AND WHY ══
 *
 * Ibrahim: *"in the hero section of 6 cats wtf is that, it should be one cat as a loop of those
 * states?"* The strip was six DIFFERENT demo ids in three different states, and it taught a visitor
 * nothing: six unfamiliar animals, no way to tell whether the differences between them were the
 * STATES or just six different coats. He is right, and the fix is the version that carries
 * information — the same animal, the same coat, changing only what the product actually changes.
 *
 * A state is a claim about ONE cat over TIME. Rendering it as a row of strangers turns a temporal
 * axis into a spatial one and loses the only thing worth showing: that the fed cat and the dead cat
 * are the SAME CAT, and that this is what happens to it. That is the whole risk disclosure in a
 * sprite, and it only lands if the identity is held fixed.
 *
 * ══ WHY ALL FOUR FRAMES ARE RENDERED AND ONLY VISIBILITY CHANGES ══
 *
 * `catGrid`/`catSvg` are pure and cheap, but running them in a `useEffect` would mean the FIRST
 * paint has no cat and JS has to land before anything appears — on the landing page, the one route
 * where a visitor decides whether this is a real product. So all four states are built during
 * render (they are deterministic, so the server and the client agree and there is no hydration
 * mismatch) and the only thing that changes on a tick is which one is `opacity: 1`.
 *
 * That also makes the transition free: no layout, no re-render of an SVG, just a compositor-level
 * opacity swap on four elements that already exist.
 *
 * ══ REDUCED MOTION HOLDS ONE STATE, IT DOES NOT HIDE THE OTHERS ══
 *
 * `prefers-reduced-motion` stops the cycle and shows `hunting` — the product's normal, working
 * state — with the four labels still listed beneath it. The rule this obeys is the one unitick
 * recorded and this repo keeps re-learning: **an accessibility accommodation must not remove
 * information.** Suppressing the animation is correct; suppressing the FACT that a cat can starve
 * and die would be a disclosure defect wearing an a11y costume, so the states stay named either way.
 */

import { useEffect, useState } from "react";
import { catGrid, catSvg, type CatState } from "@strays/cat";

/**
 * The loop, in the order the product actually moves through it.
 *
 * fed → hunting → starving → dead → (fed). Not alphabetical and not "nice states first": this is
 * the lifecycle, and running it in order is what makes it read as a consequence rather than as a
 * slideshow. It ends on `dead` and returns to `fed`, which is honest — a cat CAN come back if it
 * eats, and the loop would be a lie in the other direction if it terminated on `fed`.
 */
const CYCLE: readonly CatState[] = ["fed", "hunting", "starving", "dead"];

/** What each state MEANS, in the product's own terms. The sprite is not self-documenting. */
const MEANING: Readonly<Record<CatState, string>> = {
  fed: "closed a winning trade",
  hunting: "holding a position",
  starving: "down on the round trip",
  dead: "out of stake — gone from the colony",
};

/**
 * One id, fixed.
 *
 * `catGrid` derives the coat pigment from the id, so holding it constant is what makes this ONE
 * cat rather than four. It is a `demo:` id and is labelled as a portrait, because a plausible
 * on-screen id that is not a real stray is the class of defect this corpus is most careful about.
 */
const HERO_ID = "demo:tabby";

/** Slow. A state change is a narrative beat, not a spinner — 2.2s is long enough to read the label. */
const HOLD_MS = 2200;

export function HeroCat({ size = 128 }: { readonly size?: number }) {
  const [i, setI] = useState(0);
  /*
   * Starts FALSE so the server-rendered markup and the first client render agree. Reading a media
   * query during render is a hydration mismatch waiting to happen; reading it in an effect and
   * settling on the second frame is not, and the cost is one animation tick for a reduced-motion
   * user, which is exactly the trade `useSyncExternalStore` would also make here for more code.
   */
  const [still, setStill] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (still) return;
    const t = setInterval(() => setI((n) => (n + 1) % CYCLE.length), HOLD_MS);
    return () => clearInterval(t);
  }, [still]);

  // Held on `hunting` when motion is suppressed — the working state, not the dead one.
  const active = still ? CYCLE.indexOf("hunting") : i;
  const state = CYCLE[active] ?? "hunting";

  return (
    <div className="hero-cat">
      <div className="hero-cat-stage" style={{ width: size, height: size }}>
        {CYCLE.map((s, n) => (
          <span
            key={s}
            className="hero-cat-frame"
            data-on={n === active ? "1" : "0"}
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: catSvg(catGrid(HERO_ID, { state: s }), { id: HERO_ID, state: s }) }}
          />
        ))}
      </div>

      {/*
        The label is a LIVE REGION, because for a screen-reader user the sprite carries nothing at
        all — the frames are `aria-hidden` and this sentence is the entire content of the widget.
        `polite` so it does not interrupt; the cycle is ambient, not an alert.
      */}
      <p className="hero-cat-label" aria-live="polite">
        <span className={`hero-cat-state ${state === "fed" ? "fed" : state === "starving" || state === "dead" ? "starve" : ""}`}>
          {state}
        </span>
        <span className="stamp">{MEANING[state]}</span>
      </p>

      {/* The four states, always listed. This is what makes the cycle legible in one glance and it
          is also the reduced-motion fallback's only way of saying "there are three others". */}
      <ol className="hero-cat-ticks" aria-hidden="true">
        {CYCLE.map((s, n) => (
          <li key={s} data-on={n === active ? "1" : "0"}>
            {s}
          </li>
        ))}
      </ol>

      {/*
        The provenance stamp. Referent rule 2: nothing on this page floats free of what it is, and
        a plausible-looking cat that a visitor might read as a LIVE stray is exactly the invented-
        data defect this corpus is most careful about.

        Two spans rather than one sentence, so a short viewport can drop the QUALIFIER and keep the
        CLAIM. That is the difference between shortening a caption and hiding one — at every size,
        the page still says this is a portrait and not a live stray.
      */}
      <p className="stamp hero-cat-note">
        <span className="hero-cat-note-long">one cat, cycling its four states — </span>
        <span>a portrait, not a live stray</span>
      </p>
    </div>
  );
}
