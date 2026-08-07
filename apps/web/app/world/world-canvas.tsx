"use client";

/**
 * THE RENDERER — one canvas, every cat, every token.
 *
 * ART-DIRECTION §5a: **the colony map is a single canvas.** openhood renders one `<div>` per lit
 * pixel — 576 nodes per creature — and ARCHIVE `7j` records that as the mobile hazard that drew
 * nine complaints. Fourteen tokens and a colony of cats as DOM would be thousands of nodes with
 * layout on every frame. Everything here paints into one 2D context.
 *
 * ══ FOUR THINGS INHERITED FROM SILVERTONGUE'S RENDERER, EACH FOR A MEASURED REASON ══
 *
 * 1. **VIEWPORT CULLING.** Measured there: 200 agents CRASHED the renderer before culling
 *    ("Target crashed"). Anything outside the field plus a margin is skipped before any draw call.
 * 2. **POOLED LABEL BOXES.** Label layout allocated a fresh object per label per frame — 60
 *    allocations a second per label straight into the nursery. The boxes are reused.
 * 3. **`RESERVED_REFRESH_MS = 250` for `getBoundingClientRect`.** The HUD's occupied rectangles
 *    are needed to keep labels out from under the chrome, and `getBoundingClientRect` forces
 *    synchronous layout. Reading it every frame is a guaranteed reflow at 60Hz; every 250ms is
 *    imperceptible and free.
 * 4. **The fixed-step accumulator lives HERE, not in React.** A `setInterval` at 33ms drifts and
 *    doubles up after a tab switch; the accumulator in the rAF loop is the only form that stays
 *    correct across a backgrounded tab.
 *
 * ══ AND ONE RULE FROM THIS PROJECT'S OWN ART DIRECTION ══
 *
 * §8 bans anti-aliasing in the world. `imageSmoothingEnabled = false` and every sprite draw is
 * snapped to a whole device pixel. A cat drawn at a fractional offset is a blurred cat, which is
 * the fastest way to stop something being pixel art — and it is INVISIBLE at dpr 1 and obvious on
 * every phone, which is why it is enforced here rather than trusted.
 */

import {
  catGrid,
  catRamp,
  drawCat as drawCatRaw,
  type Ctx2D,
  type CatState,
  GRID_H,
  GRID_W,
  RAMP_STEPS,
} from "@strays/cat";
import { fnv1a, valueNoise } from "@taia/ui/mechanisms";
import { useEffect, useRef } from "react";
import {
  createSim,
  lerpBody,
  reslot,
  resizeSim,
  setInsets,
  settle,
  type Sim,
  type SimBody,
  step,
  syncBodies,
  syncTokens,
  TICK_MS,
  walking,
  type AgentInput,
  type TokenInput,
} from "./sim";

/**
 * The SHADOW END of the ramp, resolved from the live CSS custom properties once per theme change.
 *
 * ══ WHY THIS NO LONGER BUILDS THE WHOLE RAMP ══
 *
 * `@strays/cat` grew a COAT system: `catRamp(id, state)` derives a per-cat pigmented ramp so the
 * colony reads as individual animals — ginger, lilac, mint — rather than as N copies of one sprite.
 * This module was passing an explicit `ramp` override into `drawCat`, and `rampFor` in that package
 * treats an explicit ramp as authoritative, so **every coat was being suppressed and every cat came
 * out phosphor green.** The bug is invisible from inside this file: the render is correct, it is
 * merely uniform, and uniform is what the world looked like before coats existed.
 *
 * So the cat's own `id` is passed instead and the package resolves the ramp. What is still read
 * from CSS is the DARK END, which is theme-dependent in a way a coat is not: a ginger cat is ginger
 * on white paper (the package's own note), but the shadow it is modelled with has to invert or the
 * animal becomes a flat blob on the light theme — the exact defect that file records being caught by
 * screenshotting both themes.
 *
 * `RAMP_STEPS` rather than a literal 6. It went 6 → 8 when the grid went 24x24, and a hardcoded
 * length here silently dropped the two brightest steps.
 */
function resolveRamp(el: HTMLElement): readonly string[] {
  const cs = getComputedStyle(el);
  return Array.from({ length: RAMP_STEPS }, (_, i) => {
    const v = cs.getPropertyValue(`--cat-${i}`).trim();
    // A missing variable would paint the previous fillStyle — an invisible cat is the worst
    // failure mode for a fallback, so this falls back to a legible ramp rather than to nothing.
    return v === "" ? `oklch(${0.22 + i * 0.098} 0.03 145)` : v;
  });
}

function readVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v === "" ? fallback : v;
}

export type CanvasAgent = AgentInput & {
  readonly state: CatState;
  readonly pnlEth: number;
};

/**
 * `drawCat`, adapted to a real `CanvasRenderingContext2D`.
 *
 * ══ WHY THIS ONE-LINE WRAPPER EXISTS ══
 *
 * `@strays/cat` types its context parameter STRUCTURALLY as `{ fillStyle: string; fillRect(...) }`,
 * and its header explains why that is right: typing it as `CanvasRenderingContext2D` would drag the
 * DOM lib into a package that otherwise compiles under `"lib": ["es2023"]`, and would make the
 * function untestable without jsdom — the exact dependency that forced openhood to extract a grid
 * module in the first place.
 *
 * The consequence is a genuine variance mismatch, not a typing accident: the DOM's `fillStyle` is
 * `string | CanvasGradient | CanvasPattern`, and a MUTABLE property is invariant, so
 * `CanvasRenderingContext2D` is not assignable to `Ctx2D` even though every value `drawCat` ever
 * writes to it is a string.
 *
 * The assertion is confined to this one function rather than sprinkled at each of the call sites,
 * and it is SAFE for a reason that can be checked: `drawCat` only ever assigns the result of
 * `colourOf`, which returns a ramp entry or `"transparent"` — always a string. The alternative is
 * editing `packages/cat`, which another agent is rewriting right now and which the brief forbids.
 */
function drawCat(
  ctx: CanvasRenderingContext2D,
  grid: Parameters<typeof drawCatRaw>[1],
  x: number,
  y: number,
  scale: number,
  opts?: Parameters<typeof drawCatRaw>[5],
): void {
  drawCatRaw(ctx as unknown as Ctx2D, grid, x, y, scale, opts);
}

/** How long a body may sit outside the field before culling stops drawing it. */
const CULL_MARGIN = 90;
/** `getBoundingClientRect` forces layout. 250ms is imperceptible and costs ~4 reflows/sec. */
const RESERVED_REFRESH_MS = 250;

export function WorldCanvas({
  agents,
  tokens,
  paused,
  reduced,
  onHover,
}: {
  readonly agents: readonly CanvasAgent[];
  readonly tokens: readonly TokenInput[];
  readonly paused: boolean;
  /** `prefers-reduced-motion`. Suppresses the sim entirely and renders the settled world. */
  readonly reduced: boolean;
  readonly onHover?: (id: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Sim | null>(null);
  /*
   * Inputs cross into the rAF loop through REFS, never through the effect's dependency array.
   *
   * Listing `agents` as a dependency would tear down and rebuild the entire render loop — and with
   * it the sim, and with it every cat's position — on every 5-second poll. Cats would teleport to
   * fresh random spawns four times a minute, which is precisely the defect the brief names. The
   * loop mounts ONCE; the data flows in through these.
   */
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    const host = canvas.parentElement ?? canvas;
    let ramp = resolveRamp(host);
    let palette = readPalette(host);

    /*
     * DPR is capped RESOLUTION-AWARE (§5a): `cssWidth < 700 ? 1.5 : 2`.
     *
     * A DPR-3 phone quadruples fill rate for no visible gain on a sprite grid that is already
     * quantised to whole pixels. Capping is the difference between 60fps and 20fps on the exact
     * devices most likely to be used.
     */
    const dprFor = (cssWidth: number): number =>
      Math.min(window.devicePixelRatio || 1, cssWidth < 700 ? 1.5 : 2);

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = (): void => {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      dpr = dprFor(width);
      // As an ATTRIBUTE, not only a style. At dpr=1 the correct and incorrect forms are
      // byte-identical, so this bug is invisible on a 1x monitor and appears on every phone.
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if (simRef.current === null) simRef.current = createSim(width, height, Math.random);
      else resizeSim(simRef.current, width, height);
      ramp = resolveRamp(host);
      palette = readPalette(host);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // The theme can change without a resize (OS toggle, [data-theme] flip). Re-resolve on both.
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = (): void => {
      ramp = resolveRamp(host);
      palette = readPalette(host);
      // Invalidate the blended coats: they carry the OLD theme's shadow end until re-derived.
      rampGeneration++;
    };
    scheme.addEventListener("change", onScheme);

    /*
     * ══ RESERVED RECTANGLES — where a label may not go ══
     *
     * The HUD floats over the canvas. A token ticker drawn under the header is unreadable, and the
     * complaint that produces is "the labels are broken", not "the labels are behind the header".
     * These rects are read from the DOM every RESERVED_REFRESH_MS and labels flip to the other side
     * of their token rather than being dropped — a dropped label is a token with no ticker, which
     * defeats the entire feature.
     */
    let reserved: DOMRect[] = [];
    let reservedAt = 0;
    const refreshReserved = (now: number): void => {
      if (now - reservedAt < RESERVED_REFRESH_MS) return;
      reservedAt = now;
      const rect = canvas.getBoundingClientRect();
      /*
       * ══ `.world-adopt` IS MATCHED BY CLASS, NOT BY THE `data-world-reserved` ATTRIBUTE ══
       *
       * Every other opaque panel carries `data-world-reserved`. The adopt panel does not, and the
       * consequence was measured at 390px: it is a full-width block welded to the bottom of the
       * viewport, and because the world could not see it, three token labels (PUSSY, CSUMMIT) and
       * the DEN mark itself were drawn underneath it — invisible, in a layout where the field is
       * already tight.
       *
       * The panel is rendered by `app/page.tsx`, which another agent owns and this task must not
       * edit, so the attribute cannot be added at its source. Matching the class here is the honest
       * way to express the same fact from inside the module that needs it. It is a coupling to a
       * class name and that is a real cost — noted deliberately rather than hidden — but the
       * alternative is a world that draws into pixels nobody can see, which is worse. The selector
       * is a UNION so that adding the attribute upstream later is a no-op rather than a duplicate.
       */
      const panels = new Set<Element>([
        ...document.querySelectorAll("[data-world-reserved]"),
        ...document.querySelectorAll(".world-adopt" /* legacy fallback; the attribute above is authoritative */),
      ]);
      reserved = [...panels].map((el) => el.getBoundingClientRect());

      /*
       * ══ THE SAME RECTANGLES ALSO DEFINE THE PLAYABLE FIELD ══
       *
       * Measured on the rendered 1440px field with five cats: THREE were completely invisible,
       * sitting behind the roster panel, and a fourth had drifted into the strip under the top
       * bar. A cat nobody can see is indistinguishable from a cat that is not there, which undoes
       * the whole feature — and it was invisible as a bug precisely because the world *looked*
       * correct, just emptier than the "COLONY 5 live" counter claimed.
       *
       * Deriving the insets from the SAME measured rectangles the label placer already uses means
       * there is one source of truth for "where is the chrome". A CSS width duplicated into a
       * constant here would drift the first time a panel's width changed, and the symptom would be
       * cats slowly going missing again.
       *
       * Only panels that actually TOUCH an edge contribute to that edge's inset: a panel floating
       * in the middle of the field is something a cat may walk behind briefly, which is fine and
       * even good — it is a world, not a board game. A panel welded to an edge permanently owns
       * those pixels.
       */
      /*
       * ══ A CORNER PANEL DOES NOT BLOCK A WHOLE EDGE ══
       *
       * The first version of this asked "does this panel touch the left edge?" and, if so, set the
       * left inset to the panel's right edge. Measured on the real 1440px page that is catastrophic:
       * `.world-hud-tl` is a 415px-wide stat block in the TOP-LEFT CORNER, so it set
       * `left = 439`; `.world-hud-tr` set `right = 199`; and the roster set `right = 525`. The
       * playable field collapsed from 1440px to a ~700px strip down the middle, which is exactly
       * the "everything clusters in the centre and the left half is empty" symptom that three
       * successive token-layout rewrites failed to fix — because the layout was correct all along
       * and the FIELD it was given was wrong.
       *
       * The rule that is actually true: a panel only owns an edge for the SPAN it covers. A stat
       * block occupying the top-left corner blocks the top edge across its width, and blocks
       * nothing at all at y=600. So each panel contributes to the axis it is SHORTER on — a wide,
       * short panel is a top/bottom band; a tall, narrow panel is a left/right band — and only if
       * it is actually flush against that edge.
       *
       * This is the generalisable version of a mistake worth naming: "touches the edge" and
       * "occupies the edge" are different predicates, and the cheap one silently over-claims.
       */
      const EDGE_TOUCH = 40;
      const ins = { top: 0, right: 0, bottom: 0, left: 0 };
      for (const rc of reserved) {
        if (rc.width <= 0 || rc.height <= 0) continue;
        // To canvas-local coordinates.
        const top = rc.top - rect.top;
        const bottom = rc.bottom - rect.top;
        const left = rc.left - rect.left;
        const right = rc.right - rect.left;
        // Entirely above the canvas (the site nav lives there) — it occludes nothing.
        if (bottom <= 0) continue;

        /*
         * Which axis does this panel band along? The one it is WIDER on relative to the field.
         * A panel wider than it is tall, scaled by the field's own aspect, reads as a horizontal
         * band; otherwise as a vertical one. Using the field's aspect rather than a raw
         * width>height test keeps the classification stable on a portrait phone, where almost
         * everything is wider than it is tall in absolute terms.
         */
        const horizontal = rc.width / Math.max(1, width) >= rc.height / Math.max(1, height);

        if (horizontal) {
          if (top <= EDGE_TOUCH) ins.top = Math.max(ins.top, bottom);
          else if (bottom >= height - EDGE_TOUCH) ins.bottom = Math.max(ins.bottom, height - top);
        } else {
          if (left <= EDGE_TOUCH) ins.left = Math.max(ins.left, right);
          else if (right >= width - EDGE_TOUCH) ins.right = Math.max(ins.right, width - left);
        }
      }
      /*
       * A CEILING ON EACH INSET.
       *
       * On a 320px phone the roster plus the adopt panel can cover most of the height, and an
       * uncapped inset would collapse the playable field to nothing — every cat crushed into a
       * one-pixel band. Capping each inset at 30% of its axis guarantees a usable field always
       * remains; when the chrome really is that large, cats SHOULD overlap it a little rather than
       * be squeezed out of existence.
       */
      ins.top = Math.min(ins.top, height * 0.3);
      ins.bottom = Math.min(ins.bottom, height * 0.3);
      ins.left = Math.min(ins.left, width * 0.3);
      ins.right = Math.min(ins.right, width * 0.3);

      /*
       * A MINIMUM MARGIN ON EVERY EDGE, even an edge with no panel on it.
       *
       * Measured at 390px: a token on the leftmost grid column sat at x≈14 and its ticker box —
       * which is centred on the diamond and wider than it — was cut off by the viewport, so the
       * label read as "ASHBULL". A cat pressed to the same edge lost its ears to the crop.
       *
       * The inset ceiling above deliberately allows an inset of zero where no chrome exists, which
       * is right for the FIELD but wrong for the things drawn in it: every entity has width around
       * its centre point, and a field flush to the canvas edge has nowhere to put it. This floor is
       * the entity's own half-width budget, expressed once, rather than a margin re-derived at each
       * of the three places that place something.
       */
      const EDGE_BREATH = width < 480 ? 26 : 40;
      ins.top = Math.max(ins.top, EDGE_BREATH);
      ins.bottom = Math.max(ins.bottom, EDGE_BREATH);
      ins.left = Math.max(ins.left, EDGE_BREATH);
      ins.right = Math.max(ins.right, EDGE_BREATH);
      const sim = simRef.current;
      if (sim !== null) setInsets(sim, ins);
    };

    /** Pooled label boxes — reused across frames rather than reallocated per label per frame. */
    const labelPool: { x: number; y: number; w: number; h: number }[] = [];
    const takeBox = (i: number): { x: number; y: number; w: number; h: number } => {
      const existing = labelPool[i];
      if (existing !== undefined) return existing;
      const box = { x: 0, y: 0, w: 0, h: 0 };
      labelPool[i] = box;
      return box;
    };

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let hovered: string | null = null;
    const pointer = { x: -1, y: -1, inside: false };

    const onMove = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.inside = true;
    };
    const onLeave = (): void => {
      pointer.inside = false;
      if (hovered !== null) {
        hovered = null;
        hoverRef.current?.(null);
      }
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    /*
     * ══ A READ-ONLY PROBE FOR THE SCREENSHOT HARNESS ══
     *
     * A screenshot of a static frame cannot show motion, and — more importantly for this rewrite —
     * it cannot show STILLNESS either. The claim "an idle cat sits at its slot and does not drift"
     * is exactly the kind of thing that looks fine in one frame and is false over ten seconds, and
     * it is the entire point of the change, so it has to be measurable rather than eyeballed.
     *
     * This exposes the sim's own positions so `scripts/motion-probe.mjs` can sample them over time
     * and assert that an idle cat's coordinates are IDENTICAL across samples while the canvas as a
     * whole is still changing (breath, mist, glow). Nothing reads it in production and nothing can
     * write through it — it returns a fresh plain snapshot, never the live objects.
     */
    (window as unknown as { __world?: () => unknown }).__world = () => {
      const s = simRef.current;
      if (s === null) return null;
      const bodies: Record<string, { x: number; y: number; mode: string; walking: boolean }> = {};
      for (const b of s.bodies.values()) {
        bodies[b.id] = { x: b.x, y: b.y, mode: b.mode, walking: walking(b) };
      }
      return { n: s.bodies.size, tokens: s.tokens.size, bodies };
    };

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const sim = simRef.current;
      if (sim === null) return;

      /*
       * ══ SYNC, THEN RE-SLOT ONLY IF SOMETHING REALLY CHANGED ══
       *
       * Both syncs return whether they altered anything that affects where a cat belongs. On the
       * overwhelming majority of frames the answer is no — the same one stray and the same fourteen
       * tokens came back from the same poll — and re-slotting anyway would be harmless but wasteful.
       *
       * The reason it would be harmless is worth stating, because it is the property that makes the
       * whole model safe: `reslot` is IDEMPOTENT. It computes each cat's slot from state alone, and
       * `setHome` starts a walk only when the slot actually moved more than the re-slot threshold.
       * So a spurious re-slot is a no-op rather than a jitter — which is exactly the guarantee the
       * old steering model could not offer, where any extra force application moved a body.
       */
      const tokensChanged = syncTokens(sim, tokensRef.current);
      const bodiesChanged = syncBodies(sim, agentsRef.current);
      if (tokensChanged || bodiesChanged) reslot(sim);

      let alpha = 1;
      if (reducedRef.current) {
        /*
         * REDUCED MOTION: the sim does not run at all.
         *
         * Not "runs slower", not "runs without the pounce" — `step` is never called, so there is no
         * motion of any kind, and `settle` parks every body where its real state says it belongs.
         * The rAF loop still runs because the theme and the data can still change; it just paints
         * the same frame until one of them does.
         */
        settle(sim);
        last = now;
        acc = 0;
      } else {
        let dt = now - last;
        last = now;
        /*
         * CLAMP the accumulator's input.
         *
         * A backgrounded tab returns a `dt` of minutes. Without this the loop would run thousands
         * of catch-up ticks in one frame and lock the page — and every cat would arrive having
         * "walked" the whole time, which is a spiral-of-death that presents as a browser hang.
         * 250ms (≈7 ticks) is the ceiling; beyond it the world simply missed that time, which is
         * true and cheap.
         */
        if (dt > 250) dt = 250;
        if (!pausedRef.current) acc += dt;
        while (acc >= TICK_MS) {
          step(sim);
          acc -= TICK_MS;
        }
        alpha = pausedRef.current ? 1 : acc / TICK_MS;
      }

      refreshReserved(now);
      draw(ctx, sim, {
        width,
        height,
        dpr,
        alpha,
        ramp,
        palette,
        agents: agentsRef.current,
        reserved,
        canvasRect: canvas.getBoundingClientRect(),
        takeBox,
        now,
        reduced: reducedRef.current,
      });

      // Hover test after the draw, against the interpolated positions the user actually sees.
      if (pointer.inside) {
        let hit: string | null = null;
        for (const body of sim.bodies.values()) {
          const p = lerpBody(body, alpha);
          if (Math.hypot(p.x - pointer.x, p.y - pointer.y) < body.radius + 10) {
            hit = body.id;
            break;
          }
        }
        if (hit !== hovered) {
          hovered = hit;
          hoverRef.current?.(hit);
        }
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scheme.removeEventListener("change", onScheme);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      delete (window as unknown as { __world?: () => unknown }).__world;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="world-canvas"
      /*
       * The canvas is `aria-hidden` and the world's real accessible content is the DOM roster
       * beside it (see `world-app.tsx`'s `.world-roster`). A canvas cannot be read by a screen
       * reader and a `role="img"` with a paragraph-long label is a worse experience than a real
       * list — unitick's finding: describe the DATA in the DOM, not the PICTURE in an alt string.
       */
      aria-hidden="true"
    />
  );
}

type Palette = {
  readonly soot: string;
  readonly sootHi: string;
  readonly rail: string;
  readonly band: string;
  readonly phos: string;
  readonly phosDim: string;
  readonly phosGhost: string;
  readonly fed: string;
  readonly starve: string;
  readonly sootLine: string;
  /* The DECORATIVE tier — see `globals.css`. These carry NO state and never will; they exist so
     the field can have colour without a second hue acquiring a meaning. */
  readonly iris: string;
  readonly bloom: string;
  readonly cyan: string;
};

function readPalette(el: HTMLElement): Palette {
  return {
    soot: readVar(el, "--soot", "oklch(0.14 0.014 145)"),
    sootHi: readVar(el, "--soot-hi", "oklch(0.19 0.02 145)"),
    rail: readVar(el, "--rail", "oklch(0.34 0.075 145)"),
    band: readVar(el, "--band", "oklch(0.24 0.045 145)"),
    phos: readVar(el, "--phos", "oklch(0.9 0.055 145)"),
    phosDim: readVar(el, "--phos-dim", "oklch(0.63 0.045 145)"),
    phosGhost: readVar(el, "--phos-ghost", "oklch(0.58 0.038 145)"),
    fed: readVar(el, "--fed", "oklch(0.78 0.17 85)"),
    starve: readVar(el, "--starve", "oklch(0.6 0.2 25)"),
    sootLine: readVar(el, "--soot-line", "oklch(0.32 0.06 288)"),
    iris: readVar(el, "--iris", "oklch(0.72 0.17 300)"),
    bloom: readVar(el, "--bloom", "oklch(0.74 0.17 350)"),
    cyan: readVar(el, "--cyan", "oklch(0.78 0.12 195)"),
  };
}

type DrawCtx = {
  width: number;
  height: number;
  dpr: number;
  alpha: number;
  ramp: readonly string[];
  palette: Palette;
  agents: readonly CanvasAgent[];
  reserved: readonly DOMRect[];
  canvasRect: DOMRect;
  takeBox: (i: number) => { x: number; y: number; w: number; h: number };
  now: number;
  reduced: boolean;
};

/** Grid cell size in CSS px. A camera-trap frame has a graticule; this is it. */
const GRID_CELL = 64;

/**
 * ══ THE PIXEL QUANTUM ══
 *
 * Bloodhorn snaps every atmospheric mark to a multiple of `PX` (its `pixel.ts`), and the reason is
 * the same one §8 bans anti-aliasing for: a speck drawn at a fractional coordinate is resampled
 * into a soft grey smudge, and a field of soft grey smudges reads as a dirty screen rather than as
 * a rendered texture. Whole quanta read as deliberate marks.
 */
const PX = 2;
const snap = (v: number): number => Math.round(v / PX) * PX;

function draw(ctx: CanvasRenderingContext2D, sim: Sim, d: DrawCtx): void {
  const { width, height, dpr, alpha, ramp, palette } = d;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);

  // ── The ground, and the air above it ─────────────────────────────────────────────────
  drawAtmosphere(ctx, d);

  // ── The den ──────────────────────────────────────────────────────────────────────────
  drawDen(ctx, sim, palette, d.reduced ? 0 : d.now);

  // ── Tethers: cat → the token it is on. Drawn UNDER everything so nothing is obscured. ─
  ctx.lineWidth = 1;
  for (const body of sim.bodies.values()) {
    if (body.quarry === null) continue;
    const token = sim.tokens.get(body.quarry);
    if (token === undefined) continue;
    const p = lerpBody(body, alpha);
    ctx.strokeStyle = palette.fed;
    ctx.globalAlpha = body.mode === "hold" ? 0.5 : 0.28;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(Math.round(p.x), Math.round(p.y));
    ctx.lineTo(Math.round(token.x), Math.round(token.y));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // ── The quarry ───────────────────────────────────────────────────────────────────────
  let boxIndex = 0;
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  ctx.font = `600 11px ${MONO}`;
  ctx.textBaseline = "middle";

  for (const token of sim.tokens.values()) {
    if (token.x < -CULL_MARGIN || token.x > width + CULL_MARGIN) continue;
    if (token.y < -CULL_MARGIN || token.y > height + CULL_MARGIN) continue;

    const bob = d.reduced ? 0 : Math.sin(token.phase) * 2;
    const cx = Math.round(token.x);
    const cy = Math.round(token.y + bob);
    const r = Math.round(token.radius);

    /*
     * A token is a DIAMOND, a cat is a cat.
     *
     * Two things sharing a silhouette in a monochrome world are two things nobody can tell apart.
     * The rotated square is the only other primitive on the field, so "quarry" is readable at a
     * glance with no legend — which matters because at 320px there is no room for a legend.
     */
    /*
     * ══ THE QUARRY IS DEMOTED, BECAUSE THE CAT IS THE SUBJECT ══
     *
     * Measured on the rendered 1440px field after the cats gained their glow: fourteen diamonds at
     * `--fed` on a 1.5px stroke were collectively the LOUDEST thing on the page, and the one cat —
     * the only live animal in the colony, and the thing the whole product is about — read as a small
     * grey smudge among them. The prey dominated the predator.
     *
     * This is a hierarchy failure rather than a colour one, and it is easy to arrive at honestly:
     * each diamond was tuned on its own, where 0.95 alpha looks correct, and nobody adds up
     * fourteen of them. The rule that actually matters is that the field has ONE subject, and every
     * other layer has to sit visibly below it.
     *
     * So a huntable token is now a thin amber outline over a dark fill rather than a filled amber
     * shape, and the alpha comes down. It stays unmistakably amber — `--fed` is the token that means
     * "a stray may take this" and that meaning is load-bearing — but it stops competing.
     */
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fillStyle = palette.soot;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = token.huntable ? palette.fed : palette.phosGhost;
    ctx.globalAlpha = token.huntable ? 0.62 : 0.3;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;

    /*
     * A slow SWEEP ring on huntable tokens — the keeper's scan, made visible.
     *
     * Its period is derived from the token's own phase so fourteen of them never pulse in lockstep.
     * ART-DIRECTION §5d: ambient periods use incommensurate ratios, because motion built on
     * 2s/4s/8s loops realigns every 8 seconds and the eye catches it.
     */
    if (token.huntable && !d.reduced) {
      const pulse = (Math.sin(token.phase * 0.7) + 1) / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 4 + pulse * 9, 0, Math.PI * 2);
      ctx.strokeStyle = palette.fed;
      ctx.globalAlpha = 0.24 * (1 - pulse);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ── The ticker. THE point of the whole layer: the token must be legible as itself. ──
    const label = token.symbol.slice(0, 12);
    const w = ctx.measureText(label).width;
    const box = d.takeBox(boxIndex++);
    box.w = w + 10;
    box.h = 16;
    box.x = cx - box.w / 2;
    box.y = cy + r + 5;

    /*
     * The "flip above the token if the default is occluded" special case that used to sit here is
     * GONE. It was a one-step remedy applied before the real search, and every case it could fix is
     * a case the search below already covers — its second candidate IS the flipped position. Keeping
     * both meant the occlusion rule was expressed in two places that could disagree, and they did:
     * the pre-flip consulted the HUD rectangles while the search did not.
     */

    /*
     * ══ DE-COLLIDE BY TRYING CANDIDATE SLOTS, NOT BY PUSHING DOWN ══
     *
     * The first version nudged a colliding label to `other.y + other.h + 3` — straight DOWN, once,
     * against whichever label it happened to hit first. With several tokens near each other that
     * produces a vertical stack: each label pushed below the last, all sharing one x, which is
     * exactly the unreadable column measured on the rendered field (CHILLCAT / CFH / HM in one
     * pile).
     *
     * The cause is that "push down" is not a search — it is one guess, applied blindly, that can
     * land on top of a third label it never checked. This tries a small ring of real positions
     * around the token (below, above, right, left, then the diagonals) and takes the FIRST one that
     * is clear of everything already placed. A label that finds no clear slot keeps its default
     * rather than being dropped: a token with no ticker defeats the whole layer, so an overlapping
     * label is strictly better than no label.
     */
    const slots: readonly (readonly [number, number])[] = [
      [0, r + 5],
      [0, -r - box.h - 5],
      [r + 8, -box.h / 2],
      [-r - box.w - 8, -box.h / 2],
      [r + 8, r + 2],
      [-r - box.w - 8, r + 2],
      [0, r + box.h + 10],
      [0, -r - box.h * 2 - 10],
    ];
    /*
     * ══ A CANDIDATE MUST CLEAR THE HUD AS WELL AS THE OTHER LABELS ══
     *
     * This predicate used to test only against labels already placed. The consequence was visible on
     * every 1440px screenshot and survived several passes because it looks like a rendering
     * artefact rather than a logic bug: the CSUMMIT ticker rendered as "CS" with the rest of the
     * word disappearing under the roster panel.
     *
     * The reason it slipped through is that the HUD *was* being checked — but only for the ONE
     * default position, in the `collides` test above, whose sole remedy is to flip the label above
     * the token. If the flipped position is also occluded (which it is when the panel is tall), the
     * search below then evaluates seven further candidates while cheerfully ignoring the panel, and
     * happily returns the first one that merely clears the other labels.
     *
     * So the occlusion test belongs in the SAME predicate the search uses, not in a special case
     * ahead of it. That is the generalisable shape of the bug: a constraint enforced at one call
     * site rather than in the function every call site goes through.
     */
    const clashes = (bx: number, by: number): boolean => {
      if (placed.some((o) => bx < o.x + o.w && bx + box.w > o.x && by < o.y + o.h && by + box.h > o.y)) {
        return true;
      }
      // The reserved rectangles are in VIEWPORT coordinates; the box is canvas-local.
      const ax = d.canvasRect.left + bx;
      const ay = d.canvasRect.top + by;
      return d.reserved.some(
        (rc) => ax < rc.right && ax + box.w > rc.left && ay < rc.bottom && ay + box.h > rc.top,
      );
    };
    let bestX = -1;
    let bestY = -1;
    for (const [ox, oy] of slots) {
      // `ox === 0` means "centred under/over the token"; a non-zero ox is a left/right offset
      // already expressed as the box's own left edge relative to the token centre.
      const candX = ox === 0 ? cx - box.w / 2 : cx + ox;
      const candY = cy + oy;
      if (candX < 2 || candX + box.w > width - 2) continue;
      if (candY < 2 || candY + box.h > height - 2) continue;
      if (clashes(candX, candY)) continue;
      bestX = candX;
      bestY = candY;
      break;
    }

    /*
     * ══ NO CLEAR SLOT ⇒ NO LABEL, AND THAT IS THE HONEST OUTCOME ══
     *
     * The previous rule was the opposite: fall back to the default position, on the reasoning that
     * *"a token with no ticker defeats the whole layer, so an overlapping label is strictly better
     * than no label."* That reasoning is wrong once the obstacle is the HUD rather than another
     * label, and the rendered field is what shows why — the fallback is what drew "CS" with the rest
     * of CSUMMIT vanishing under the roster panel.
     *
     * A half-occluded ticker is not a degraded label, it is a WRONG one: "CS" is a different string
     * from "CSUMMIT", and a viewer reading it has been told something false about which token this
     * is. An unlabelled diamond says only "a token is here", which is true, and the roster panel
     * beside it lists every ticker in text anyway — so nothing is actually lost.
     *
     * The diamond itself is always drawn. It is the label, not the token, that is suppressed.
     */
    if (bestX < 0) continue;

    box.x = bestX;
    box.y = bestY;
    placed.push({ x: box.x, y: box.y, w: box.w, h: box.h });

    /*
     * The ticker keeps its dark plate but LOSES its border.
     *
     * The plate is not decoration — it is what keeps 11px type legible over a textured ground, and
     * without it the labels dissolve into the dust field. The BORDER was the part that made fourteen
     * of these read as a scattering of UI widgets over the world rather than as captions in it: a
     * stroked box is a control, an unstroked plate is a shadow behind text.
     *
     * The type also comes down from `--phos` to `--phos-dim`. It stays comfortably legible (the
     * plate guarantees the contrast) while ceding the top of the value range to the one animal.
     */
    ctx.fillStyle = palette.soot;
    ctx.globalAlpha = 0.82;
    ctx.fillRect(Math.round(box.x), Math.round(box.y), Math.round(box.w), box.h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = token.huntable ? palette.phosDim : palette.phosGhost;
    ctx.textAlign = "center";
    ctx.fillText(label, Math.round(box.x + box.w / 2), Math.round(box.y + box.h / 2) + 1);
  }

  // ── The cats ─────────────────────────────────────────────────────────────────────────
  for (const body of sim.bodies.values()) {
    const p = lerpBody(body, alpha);
    // VIEWPORT CULLING, before any draw call. See the header for what this cost when absent.
    if (p.x < -CULL_MARGIN || p.x > width + CULL_MARGIN) continue;
    if (p.y < -CULL_MARGIN || p.y > height + CULL_MARGIN) continue;

    const agent = d.agents.find((a) => a.id === body.id);
    drawStray(ctx, body, p, agent, ramp, palette, d);
  }
}

const MONO = `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`;

/**
 * ══ THE ATMOSPHERE — what makes the field a place rather than a background ══
 *
 * The field this replaces was a flat `--soot` fill with a 64px graticule ruled over it, and
 * Ibrahim's assessment of the result was that it looked empty. It did. The diagnosis is worth
 * writing down because "add some texture" is the wrong lesson:
 *
 * A FLAT FILL IS NOT A SURFACE. It carries no information about depth, distance or material, so the
 * eye reads it as the absence of a background rather than as a background. The graticule did not
 * fix that — a perfectly regular lattice at one alpha is *also* uniform, so the field was two
 * uniform layers instead of one, and a lattice specifically reads as a DIAGRAM, which is the thing
 * the world is trying not to be.
 *
 * Bloodhorn's `atmosphere.ts` builds its page in three passes and the structure transfers directly,
 * even though the referent does not (a grimoire page is flat and lit from nowhere; a camera-trap
 * field has ground and air). What transfers is the PRINCIPLE: a background needs uneven,
 * deterministic, quantised detail at more than one scale.
 *
 *   1. THE GROUND    the base fill, with a broad `valueNoise` unevenness over it, so the surface
 *                    has slow variation instead of being one value.
 *   2. THE GRATICULE kept, but demoted hard and interrupted by the noise field — it is a faint
 *                    survey reference now, not the dominant mark. It earns its place: a cat
 *                    crossing a truly featureless field has nothing to be measured against, and
 *                    the same walk reads as drifting.
 *   3. THE DUST      slow drifting flecks, on incommensurate rates so the field never visibly
 *                    loops, plus a settled scatter that does not move at all.
 *
 * Plus a VIGNETTE, which does the same two jobs it does in bloodhorn: it focuses the eye on the
 * middle of the field, and it implies the world continues past the edge of the canvas instead of
 * stopping at it. A hard canvas edge is one of the strongest "this is a widget" signals there is.
 *
 * Everything here is deterministic — `valueNoise` over fixed lattice coordinates, never
 * `Math.random()` — so the field looks the SAME on every reload. A background whose stains moved
 * between loads is a rendering bug wearing a texture, and it also makes every screenshot
 * comparison meaningless.
 */
function drawAtmosphere(ctx: CanvasRenderingContext2D, d: DrawCtx): void {
  const { width, height, palette } = d;
  // Time in seconds, frozen under reduced motion so the whole layer becomes a still image.
  const t = d.reduced ? 0 : d.now / 1000;

  // ── 1. THE GROUND ────────────────────────────────────────────────────────────────────
  ctx.fillStyle = palette.soot;
  ctx.fillRect(0, 0, width, height);

  /*
   * BROAD UNEVENNESS, drawn as a coarse grid of translucent cells.
   *
   * ══ Why cells rather than a per-pixel field ══
   *
   * A true per-pixel noise field means an `ImageData` write of width*height*4 bytes every frame,
   * which on a 1440x844 canvas at dpr 2 is ~19MB/frame — that is a guaranteed frame drop for a
   * texture nobody is looking at directly. Sampling the same noise at a 56px lattice and filling
   * flat rectangles costs a few hundred `fillRect`s and is visually indistinguishable at this
   * contrast, because the whole point is that the variation is SLOW.
   *
   * The alpha is deliberately tiny (max ~0.05). Atmosphere you can point at is not atmosphere, it
   * is a pattern; the target is a field that looks uneven without any individual patch being
   * visible as a patch.
   */
  const CELL = 56;
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      // Two octaves. One alone gives a field with a single obvious blob size; adding a finer,
      // weaker octave is what stops the unevenness reading as a lava lamp.
      const n =
        valueNoise(cx * 0.17, cy * 0.17) * 0.7 + valueNoise(cx * 0.53 + 11.3, cy * 0.53 + 7.1) * 0.3;
      if (n < 0.42) continue;
      // A faint iris cast on the raised patches, so the ground has hue variation and not merely
      // lightness variation. At this alpha no individual cell is visible as a cell — which is the
      // whole test for atmosphere versus pattern.
      ctx.fillStyle = n > 0.62 ? palette.iris : palette.sootHi;
      ctx.globalAlpha = (n - 0.42) * (n > 0.62 ? 0.05 : 0.09);
      ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
    }
  }
  ctx.globalAlpha = 1;

  // ── 2. THE GRATICULE, demoted ────────────────────────────────────────────────────────
  //
  // At 0.55 alpha this was the loudest thing on an empty field. At 0.16 it is a reference the eye
  // uses without looking at, which is what a survey graticule is for.
  ctx.strokeStyle = palette.sootLine;
  ctx.globalAlpha = 0.16;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = GRID_CELL; x < width; x += GRID_CELL) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, height);
  }
  for (let y = GRID_CELL; y < height; y += GRID_CELL) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(width, Math.round(y) + 0.5);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  /*
   * THE SETTLED SCATTER — grit on the ground that does not move.
   *
   * Bloodhorn calls this "foxing" and places it by `valueNoise` at a derived density: one fleck per
   * N world px², never a chosen count, so the field is equally textured at 320px and at 1440px.
   * Same rule here — density is per-area, so a phone does not get a sparse field and a desktop a
   * crowded one.
   *
   * Two DECORRELATED noise lookups per fleck. Using one for both axes puts every fleck on a
   * diagonal, which is the classic tell of a lazily-sampled noise field.
   */
  const grit = Math.round((width * height) / 5200);
  ctx.fillStyle = palette.sootLine;
  for (let i = 0; i < grit; i++) {
    const nx = valueNoise(i * 1.7, 0.5);
    const ny = valueNoise(0.5, i * 2.3);
    const x = snap(nx * width);
    const y = snap(ny * height);
    // Whole quanta only: 1x1 or 2x2. Anything larger stops being a stain and becomes a mark, and a
    // mark on a field means something — it would read as an entity.
    const big = valueNoise(i * 3.1, i * 0.7) > 0.62;
    const s = big ? PX * 2 : PX;
    ctx.globalAlpha = 0.1 + valueNoise(i * 4.1, i * 1.9) * 0.22;
    ctx.fillRect(x, y, s, s);
  }
  ctx.globalAlpha = 1;

  // ── 3. THE DUST ──────────────────────────────────────────────────────────────────────
  /*
   * Drifting motes. This is the layer that guarantees the field is never a still image, which
   * matters more here than in most products: the world's real events are minutes apart, so the
   * overwhelming majority of frames anyone sees contain no event at all. If nothing moves in those
   * frames the world is a diagram however good the event animations are — bloodhorn's `juice.ts`
   * makes exactly this argument and it is the reason the motes survived its own rebrand.
   *
   * ══ THE RATES ARE INCOMMENSURATE, AND THAT IS THE WHOLE CRAFT ══
   *
   * Each mote's horizontal and vertical speeds come from different noise lookups scaled by an
   * irrational-ish ratio, so its path never closes into a loop. Ambient motion built on
   * commensurate rates (2s/4s/8s) re-syncs, and the eye catches the re-sync — which is precisely
   * what makes ambience read as one animation played many times.
   *
   * The wrap is on the modulus of the drift rather than on a stored position, so there is no state
   * to keep and no per-frame allocation: a mote is a pure function of (index, time).
   */
  const motes = Math.round((width * height) / 9000);
  for (let i = 0; i < motes; i++) {
    const bx = valueNoise(i * 1.3, 0.9) * width;
    const by = valueNoise(0.9, i * 3.9) * height;
    const vx = 2 + valueNoise(i * 6.1, 0.2) * 4;
    const vy = -1.2 - valueNoise(0.2, i * 7.3) * 2.4;
    // `+ height` before the modulus because `vy` is negative and JS `%` keeps the sign.
    const x = snap((((bx + vx * t) % width) + width) % width);
    const y = snap((((by + vy * t) % height) + height) % height);
    /*
     * The mote FADES on its own clock as well as drifting.
     *
     * A fleck at a constant alpha travelling in a straight line reads as a dead pixel sliding
     * across the screen. Coupling brightness to a slow, per-mote oscillator makes it read as
     * something catching the light as it turns.
     */
    const tw = 0.55 + Math.sin(t * (0.5 + valueNoise(i * 2.7, 4.4) * 0.7) + i) * 0.45;
    ctx.globalAlpha = (0.08 + valueNoise(i * 4.7, 0.3) * 0.16) * tw;
    /*
     * The motes are TINTED, and it is the cheapest colour on the field.
     *
     * A single-hue dust field is what made the world read as one flat green wash. Three decorative
     * hues, chosen per-mote by a noise lookup (never `Math.random`, so the field is identical on
     * every reload and screenshots stay comparable), give the air depth without any mote being
     * large or bright enough to read as an entity.
     *
     * Deliberately drawn from the DECORATIVE tier only. A mote in `--fed` amber would be a speck of
     * dust claiming a trade was won.
     */
    const hue = valueNoise(i * 5.3, 2.1);
    ctx.fillStyle = hue < 0.38 ? palette.iris : hue < 0.68 ? palette.cyan : palette.bloom;
    ctx.fillRect(x, y, PX, PX);
  }
  ctx.globalAlpha = 1;

  /*
   * ══ THE VIGNETTE ══
   *
   * ART-DIRECTION bans decorative gradients, and this is not one — which is a claim that has to be
   * defended rather than asserted. It carries a real meaning (DEPTH OF ATTENTION: the middle of the
   * field is where the subject is), it sits behind nothing and carries no data, so it cannot reduce
   * the contrast of any figure, and its second job is structural: it implies the world continues
   * past the canvas edge instead of stopping there.
   *
   * `createRadialGradient` per frame is one object allocation and the GPU rasterises the fill; the
   * alternative (a baked texture) is what bloodhorn does because Pixi wants a Texture, and would be
   * strictly more machinery here for the same pixels.
   */
  const g = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.28,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.72,
  );
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(0.62, "rgba(0,0,0,0.14)");
  g.addColorStop(1, "rgba(0,0,0,0.44)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}


/**
 * THE DEN — where a cat brings back what it kills.
 *
 * A bare mark, not a building. Its only job is to be a fixed, recognisable place so that "went
 * home" is a legible event rather than "wandered off to the left".
 */
function drawDen(ctx: CanvasRenderingContext2D, sim: Sim, palette: Palette, now: number): void {
  const { x, y } = sim.den;
  const cx = Math.round(x);
  const cy = Math.round(y);
  ctx.strokeStyle = palette.iris;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.7;
  ctx.strokeRect(cx - 22.5, cy - 14.5, 45, 29);
  ctx.globalAlpha = 0.35;
  // A slow breath so the den is not a dead rectangle. Zero `now` under reduced motion ⇒ static.
  const breath = now === 0 ? 0 : (Math.sin(now / 1400) + 1) / 2;
  ctx.strokeRect(cx - 27.5 - breath * 2, cy - 19.5 - breath * 2, 55 + breath * 4, 39 + breath * 4);
  ctx.globalAlpha = 1;
  ctx.font = `600 9px ${MONO}`;
  ctx.fillStyle = palette.phosGhost;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("DEN", cx, cy);
}

/**
 * One stray.
 *
 * ══ THE SPRITE COMES FROM `@strays/cat`, VIA `drawCat`, AND NOTHING HERE REDRAWS IT ══
 *
 * ART-DIRECTION §5b's whole point, and openhood's recorded defect: the SAME creature drawn by TWO
 * unrelated renderers that never agreed, so the same animal was two different species on the map
 * and in the roster. `catGrid(id, {state})` produces the pixels and `drawCat` paints them. This
 * function decides only WHERE, HOW BIG, and WHICH WAY UP.
 *
 * `catGrid` is memoised per (id, state): it walks a 16x16 grid with a per-pixel Lambert term and a
 * Bayer dither, and doing that for every cat on every frame is ~256 shading evaluations per cat per
 * frame for a result that changes only when the cat's STATE changes. The cache key is the pair.
 */
/**
 * ══ WHERE THE CAT'S FEET ARE, IN SPRITE PIXELS FROM THE GRID'S CENTRE ══
 *
 * The sprite is drawn centred on the body's position, so the naive place to put a contact shadow is
 * `cy + h/2` — the bottom edge of the 24x24 cell. That is what this shipped with, and zooming a
 * screenshot to 220px showed the result plainly: the shadow sat as a detached smear well below and
 * behind the animal, so the cat read as hovering ABOVE its own shadow. Which is worse than having
 * no shadow, because a detached shadow actively asserts the thing is airborne.
 *
 * The cause is that the grid is not full. `catGrid` occupies rows 4-18 of 24: there is empty
 * padding under the paws, so the cell's bottom edge is ~5 sprite-pixels below where the cat is
 * actually standing. `h / 2` measures the CELL; a contact shadow has to measure the BODY.
 *
 * +6 from centre (row 18 of a 24-row grid, whose centre is row 12) puts the ellipse under the paws.
 * It is a constant rather than a per-frame scan of the grid because the silhouette's footprint is a
 * property of the sprite design, not of any individual cat — every cat `catGrid` produces stands on
 * the same baseline, which is what makes the sprites look like one species.
 */
const FEET_Y = 6;

/**
 * The four whole-pixel offsets the silhouette pass is drawn at.
 *
 * Four (not eight) because the diagonals are already covered by the union of the two axes they lie
 * between, and drawing them as well doubles the cost of the pass for pixels that are already dark.
 */
const OUTLINE_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/**
 * A ramp where every step is the same near-black, used for the silhouette pass.
 *
 * `drawCat` picks a colour per pixel by shading step; feeding it a ramp whose every entry is
 * identical makes it paint a flat mask of the sprite's occupied cells — a silhouette — without
 * needing a second code path inside `@strays/cat`, which another agent owns and the brief puts
 * out of bounds.
 *
 * Not pure `#000`: the ground is `--soot`, a near-black with a green cast, and a pure-black
 * outline on it reads as a hole punched in the field rather than as the animal's own edge.
 */
const DARK_RAMP: readonly string[] = Array.from({ length: RAMP_STEPS }, () => "oklch(0.09 0.012 145)");

/**
 * ══ THE COAT, WITH THE THEME'S SHADOW END PUT BACK ══
 *
 * `catRamp(id, state)` returns eight sRGB hex values: the cat's pigment feathered across the middle
 * of a fixed base ramp. Its own header explains the asymmetry it deliberately ships with — the
 * pigment is theme-INDEPENDENT on purpose ("a ginger cat is ginger on white paper"), while the dark
 * end is the DARK theme's values, and it "leaves the dark end of the ramp untouched by the pigment
 * precisely so a caller may substitute it."
 *
 * This is that caller doing that substitution. On the light theme the two lowest steps are the
 * cat's contact shadows and its outline, and the dark theme's near-black there is what turns the
 * animal into a hole punched in pale paper — the flat-silhouette failure both packages record being
 * caught only by opening the page in both themes.
 *
 * Only steps 0 and 1 are swapped. Reaching further up would start overwriting the pigment band
 * itself (step 4 is where the coat lands), which would undo the coats this exists to preserve.
 *
 * Memoised on (id, state, theme-generation): `catRamp` mixes eight colours per call and the world
 * calls it once per cat per frame.
 */
let rampGeneration = 0;
const coatCache = new Map<string, readonly string[]>();

function coatRamp(id: string, state: CatState, themeRamp: readonly string[]): readonly string[] {
  const key = `${rampGeneration}:${id}:${state}`;
  const hit = coatCache.get(key);
  if (hit !== undefined) return hit;
  const base = catRamp(id, state);
  const merged = base.map((c, i) => (i < 2 ? (themeRamp[i] ?? c) : c));
  if (coatCache.size > 400) {
    const oldest = coatCache.keys().next().value;
    if (oldest !== undefined) coatCache.delete(oldest);
  }
  coatCache.set(key, merged);
  return merged;
}

const gridCache = new Map<string, ReturnType<typeof catGrid>>();
function cachedGrid(id: string, state: CatState): ReturnType<typeof catGrid> {
  const key = `${id}:${state}`;
  const hit = gridCache.get(key);
  if (hit !== undefined) return hit;
  const grid = catGrid(id, { state });
  /*
   * A bounded cache. Every cat has at most 4 states, so this only grows with the colony — but an
   * unbounded map keyed on chain data is a leak with a long fuse, and evicting the oldest entry
   * costs one `delete` on a cache that will never realistically reach the cap.
   */
  if (gridCache.size > 400) {
    const oldest = gridCache.keys().next().value;
    if (oldest !== undefined) gridCache.delete(oldest);
  }
  gridCache.set(key, grid);
  return grid;
}

function drawStray(
  ctx: CanvasRenderingContext2D,
  body: SimBody,
  p: { x: number; y: number },
  agent: CanvasAgent | undefined,
  ramp: readonly string[],
  palette: Palette,
  d: DrawCtx,
): void {
  const state: CatState = agent?.state ?? "hunting";

  /*
   * SCALE is derived from the body's radius, floored to a WHOLE number of device pixels.
   *
   * `drawCat` floors internally too, but computing the footprint from an unfloored scale and then
   * drawing at a floored one puts the sprite half a pixel off its own centre — which is the
   * blurred-edge failure §8 bans, arriving through the back door. Compute once, use the same value
   * for both.
   */
  const scale = Math.max(1, Math.floor((body.radius * 2) / GRID_W));
  const w = GRID_W * scale;
  const h = GRID_H * scale;

  const cx = Math.round(p.x);
  const cy = Math.round(p.y);

  /*
   * ══ BREATH — THE MOST IMPORTANT ANIMATION HERE, AND THE WHOLE REASON A STILL CAT IS ALIVE ══
   *
   * This rewrite took away the cat's wander. That is the correct change, and on its own it would
   * have made things WORSE: a sprite parked at a fixed coordinate with nothing moving is a
   * rendering failure, not a resting animal. Everything that used to be carried by drift has to be
   * carried by an idle instead, which is exactly the trade bloodhorn's `agents.ts` header describes
   * — its world changes twice an hour, and *"with [a continuous idle], twenty sprites read as alive
   * in the gaps."*
   *
   * ══ OWN PHASE **AND** OWN RATE ══
   *
   * Both come from `fnv1a` of the cat's id, in `sim.ts`. The rate is the part that is easy to skip
   * and impossible to do without: with a shared rate and only a phase offset, every cat completes
   * its cycle in the same period, so the colony re-syncs into a travelling wave and the eye
   * immediately reads "one animation, N copies". Different rates drift apart forever.
   *
   * ══ AND IT IS LAYERED, NON-HARMONIC SINES ══
   *
   * A single sine reads as PULSING — a mechanical throb. Three sines at non-harmonic frequency
   * ratios (1.1 / 2.3 / 0.37) never re-sync into a visible loop, so the motion reads as BREATHING.
   * Integer ratios would repeat, and a repeat the eye can catch is the thing that makes ambience
   * look cheap.
   */
  const ts = d.reduced ? 0 : d.now / 1000;
  const phase = body.phase;
  const rate = body.rate;
  const s = ts * rate;
  const sway =
    Math.sin(s * 1.1 + phase) + Math.sin(s * 2.3 + phase * 1.7) * 0.4 + Math.sin(s * 0.37 + phase * 0.6) * 0.25;
  // ~0.3Hz — 18 breaths a minute, the middle of the relaxed human range. Faster reads as panicked,
  // slower reads as broken.
  const breath = (Math.sin(ts * rate * 1.9 + phase) + 1) / 2;

  /*
   * The cat only breathes when it is AT REST.
   *
   * A walking body is already in motion, and layering an idle on top of a walk is how a character
   * ends up looking like it is being dragged while flailing. Bloodhorn gates its idle the same way
   * (`update(dt, worldFrozen, idle)`).
   */
  const idle = !walking(body) && !d.reduced;

  /*
   * THE BOB IS COMPUTED IN WHOLE SPRITE PIXELS.
   *
   * Quantised to `scale` (one sprite pixel) rather than left as a smooth sine, so the bob lands on
   * the pixel grid. A sub-pixel bob is a SHIMMER, not an animation — it resamples the sprite every
   * frame and reads as the cat vibrating, which is the exact opposite of the calm this is for.
   */
  const bob = idle ? Math.round(breath * 1.6 - 0.8) * scale : 0;
  // A slow lean from foot to foot. This is the thing that reads as a body standing rather than a
  // sprite parked, and it is deliberately tiny — visible only as a change of weight.
  const lean = idle ? Math.sin(ts * 0.9 * rate + phase) * 0.03 : 0;
  // Micro-drift, well under one sprite pixel, so a standing cat is never mathematically static.
  const driftX = idle ? sway * 0.5 : 0;

  /*
   * ══ TWITCH — a rare, sharp head-turn on a long per-cat timer ══
   *
   * Idle personality. Without it a resting cat is a loop; with it, the loop is occasionally
   * interrupted by something that looks like a decision. `twitchAt` is 12-30s per cat, from its own
   * hash, so no two cats ever twitch together — a scheduled twitch reads as a metronome, which is
   * worse than no twitch at all.
   *
   * Computed from absolute time rather than accumulated, so it costs no state and cannot drift.
   */
  const twitching = idle && d.now % body.twitchAt < 220;
  const facing = twitching ? (body.facing === 1 ? -1 : 1) : body.facing;

  /*
   * ══ THE THREE-PART BODY — AND WHY THE MIDDLE PART IS GONE ══
   *
   * Ibrahim: *"why are the cats glowing in app route?"*
   *
   * This was SHADOW → AURA+HALO → SPRITE, inherited wholesale from bloodhorn's `agents.ts`. The
   * structure was copied correctly and the REFERENT was not: bloodhorn's agents are MACHINES, lit
   * from within, so a halo is a statement about what they are. A cat is an ANIMAL. Animals are lit
   * BY the world, not from inside it, and a glowing one reads as an artifact — a sprite with a
   * rendering bug — rather than as a creature. No amount of tuning the falloff fixes that, because
   * the defect is the premise and not the numbers.
   *
   * What survives, and why each survives:
   *
   *   1. SHADOW — KEPT. Bloodhorn's own comment is right and applies to a cat exactly as it does to
   *               a machine: *"without it the machine floats"*. A contact shadow is the cheapest
   *               cue that a thing stands ON a surface rather than being pasted over one, and it is
   *               an ABSENCE of light, which is something animals genuinely cast.
   *   2. GROUND RING + STATE PIP — REPLACING the glow. The glow was carrying real information (a
   *               fed cat amber, a starving cat ember) and simply deleting it would have cost the
   *               world its at-a-glance state read. So the state is now said by two marks that are
   *               not light: a thin ring scribed on the GROUND at the cat's feet, and a small
   *               square pip. Both are opaque, hard-edged and quantised to the pixel grid — the
   *               same vocabulary as everything else on the field — so they read as notation about
   *               the animal instead of as emission from it.
   *   3. SPRITE — the cat, on top, and now the brightest thing in its own footprint.
   *
   * `drawGlow` and `radial` are DELETED rather than left unused. A dormant glow helper is an
   * invitation to reintroduce exactly this bug, and the git history is the correct place for code
   * that is no longer wanted.
   */

  // ── 1. SHADOW ────────────────────────────────────────────────────────────────────────
  /*
   * The shadow TIGHTENS as the body rises.
   *
   * A grounded object's contact shadow is coupled to its height; decoupling them is what makes a
   * bobbing sprite look like it is sliding on glass. So the shadow shrinks and fades by the same
   * `bob` that lifted the body — one value, two uses, and they cannot disagree.
   */
  /*
   * The shadow is drawn in near-BLACK at high alpha, not in `--soot-line`.
   *
   * `--soot-line` is a separator token — it is LIGHTER than the ground it would be cast on, so the
   * "shadow" was a pale smudge, and once the additive glow went in on top it disappeared entirely.
   * Bloodhorn is explicit that this is the failure to avoid: *"Additive glow with no dark backing
   * produces mush"*, and its own shadow is a glow sprite tinted `0x000000` at 0.6.
   *
   * A shadow is an ABSENCE OF LIGHT, so it has to be darker than the surface. Black at 0.5 survives
   * the glow being added over it, which is the entire job — it is what keeps the cat standing on
   * the field instead of floating in front of it.
   */
  const lift = idle ? breath : 0;
  ctx.fillStyle = "#000";
  ctx.globalAlpha = 0.5 - lift * 0.1;
  ctx.beginPath();
  ctx.ellipse(
    cx,
    cy + FEET_Y * scale,
    w * (0.34 - lift * 0.03),
    Math.max(2, scale * (1 - lift * 0.1)),
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.globalAlpha = 1;

  // ── 2. THE STATE RING, SCRIBED ON THE GROUND ─────────────────────────────────────────
  /*
   * The state hue, unchanged from what the glow carried — the SEMANTICS were never the problem.
   *
   * `--fed` amber = this cat ate, `--starve` ember = this cat is losing. One hue, one meaning, and
   * the rule survives the change of instrument intact. A hunting cat gets the field's own phosphor,
   * which is a statement that nothing has happened yet rather than a third meaning.
   */
  const mark =
    state === "starving" ? palette.starve : state === "fed" ? palette.fed : palette.phosDim;

  /*
   * ══ A RING ON THE GROUND IS NOT A GLOW, AND THE DIFFERENCE IS NOT COSMETIC ══
   *
   * A glow is EMITTED: it has no edge, it sits between the viewer and the animal, and it says "this
   * thing produces light". A ring is INSCRIBED: it lies flat on the ground plane at the cat's feet,
   * it has a hard edge, and it says "this is where the thing stands" — the vocabulary of a survey
   * marker, which is precisely the referent this world already uses for its graticule.
   *
   * Flattened to 0.34 of its width so it reads as a circle lying ON the ground in perspective
   * rather than as a hoop standing upright around the cat. That single ratio is what makes it
   * ground furniture instead of a halo seen edge-on.
   *
   * Drawn at the FEET (the same `FEET_Y` correction the shadow uses, and for the same measured
   * reason) rather than at the sprite cell's centre, so it stays welded to the contact point as the
   * cat bobs. The shadow and the ring therefore share one anchor and cannot drift apart.
   */
  const footY = cy + FEET_Y * scale;
  const ringPulse = d.reduced ? 0.5 : (Math.sin(ts * rate * 0.9 + phase) + 1) / 2;
  ctx.save();
  ctx.strokeStyle = mark;
  ctx.lineWidth = 1;
  // Fed reads strongest, starving next, hunting faintest — the ring's PRESENCE is proportional to
  // how much there is to report, so an ordinary hunting cat is not shouting.
  const ringAlpha = state === "fed" ? 0.5 : state === "starving" ? 0.42 : 0.2;
  ctx.globalAlpha = ringAlpha * (0.82 + ringPulse * 0.18);
  ctx.beginPath();
  ctx.ellipse(cx, footY, w * 0.42, Math.max(2, w * 0.42 * 0.34), 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();

  /*
   * ══ THE STATE PIP — one square, above the shoulder ══
   *
   * The ring is ambient and low-contrast by design; on a busy field, at 320px, it is not enough on
   * its own to answer "which cat is starving" at a glance. The pip is the sharp version of the same
   * fact: a single hard-edged square at full alpha, on the pixel quantum, with a dark backing plate
   * so it never dissolves into whatever it happens to be drawn over.
   *
   * It is deliberately a SQUARE and not a dot — the field's only round marks are the ring and the
   * token sweep, and a small bright circle beside a cat would read as another token.
   *
   * A HUNTING cat gets no pip at all. "Nothing has happened yet" is the default state of every cat
   * in the colony and giving it a badge would put a mark on every animal on the field, which is the
   * fastest way to make the two marks that MATTER invisible.
   */
  if (state === "fed" || state === "starving") {
    const pip = Math.max(2, scale);
    const px = cx + Math.round(w * 0.30);
    const py = cy + bob - Math.round(h * 0.30);
    ctx.fillStyle = "oklch(0.09 0.012 145)";
    ctx.fillRect(px - pip, py - pip, pip * 3, pip * 3);
    ctx.fillStyle = mark;
    ctx.fillRect(px, py, pip * 2, pip * 2);
  }

  /*
   * The LUNGE stretch. During a pounce the sprite is drawn taller and shifted forward, which reads
   * as a body extending mid-leap. It is deliberately crude: at 24x24 there is no room for a leap
   * POSE, so the leap is carried by the transform.
   */
  const lunge = d.reduced ? 0 : body.lunge;
  const stretch = Math.round(lunge * scale);

  // ── 3. THE SPRITE, drawn LAST so it sits on top of its own light ─────────────────────
  ctx.save();
  ctx.translate(cx + Math.round(driftX), cy + bob);
  if (lean !== 0) ctx.rotate(lean);
  // Facing. A negative x-scale rather than a mirrored grid: one sprite, both directions, no second
  // code path that could disagree with the first.
  if (facing === -1) ctx.scale(-1, 1);
  ctx.imageSmoothingEnabled = false;
  /*
   * The BREATH SQUASH, applied to the sprite's own transform.
   *
   * ±3.5% on the vertical axis only — a chest expanding, not a ball bouncing. Applied here rather
   * than folded into `scale` because `drawCat` quantises `scale` to whole pixels internally, so a
   * fractional breath would be rounded straight back out and produce nothing at all.
   */
  if (idle) ctx.scale(1, 1 + (breath - 0.5) * 0.07);

  /*
   * ══ THE DARK BACKING — what turns a lit smear back into an animal ══
   *
   * Bloodhorn states the failure and its fix in one sentence: *"Additive glow with no dark backing
   * produces mush — the glow washes over the body and the silhouette disappears… the shadow and the
   * near-black chassis outline are what keep the machine readable while still being genuinely
   * luminous."*
   *
   * That is exactly what happened here, and it was only visible by zooming a screenshot to 220px:
   * with the aura and halo behind it, the cat rendered as a pale horizontal smudge in which no ear,
   * leg or tail could be picked out. §5b calls the ears and tail the two axes that carry a cat's
   * identity, and both were being dissolved by the light meant to make it beautiful.
   *
   * The fix is a silhouette pass: the SAME grid drawn first in near-black, one sprite-pixel out in
   * each of four directions, which lays a dark rim under every lit edge. The lit sprite then covers
   * the centre and only the rim survives — so the cat sits in a thin dark outline that separates it
   * from its own glow.
   *
   * ══ Why four offsets and not a scale-up ══
   *
   * Scaling the silhouette by ~1.1 and drawing it behind is the cheaper trick and it is wrong for
   * pixel art: a non-integer scale resamples the grid, so the outline lands on fractional pixels and
   * comes out as a grey fringe — the exact anti-aliased blur §8 bans. Four whole-pixel offsets keep
   * every mark on the quantum.
   */
  const grid = cachedGrid(body.id, state);
  const dark: readonly string[] = DARK_RAMP;
  for (const [ox, oy] of OUTLINE_OFFSETS) {
    drawCat(ctx, grid, -w / 2 + ox * scale, -h / 2 - stretch + oy * scale, scale, {
      ramp: dark,
      state,
    });
  }

  /*
   * ══ THE CAT IS DRAWN IN ITS OWN COAT ══
   *
   * `coatRamp` is `@strays/cat`'s `catRamp(id, state)` with the theme's shadow end spliced back in
   * (see `blendCoat`). Passing the flat `ramp` here instead — which is what this line used to do —
   * overrode the package's pigment and painted every cat phosphor green, so a colony of individually
   * coloured animals rendered as N identical sprites. The bug is invisible locally: the render is
   * correct, just uniform.
   */
  drawCat(ctx, grid, -w / 2, -h / 2 - stretch, scale, { ramp: coatRamp(body.id, state, ramp), state });
  ctx.restore();

  /*
   * ══ THE KILL, DRAGGED HOME ══
   *
   * A cat in `drag` carries a mark behind it. This is the literal rendering of the product's one
   * sentence — "it brings back what it kills" — and it is the only reason `drag` and `slink` are
   * separate modes rather than one "return" mode with a speed parameter.
   *
   * A slinking cat carries nothing, and is drawn at reduced alpha: it comes back THIN. Nothing
   * about a loss is dressed up (DESIGN §2: a losing cat must never look fine).
   */
  if (body.mode === "drag") {
    const trailX = -body.facing * (w * 0.6);
    ctx.fillStyle = palette.fed;
    ctx.fillRect(cx + trailX - scale, cy + bob + h * 0.25, scale * 2, scale * 2);
    ctx.strokeStyle = palette.fed;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(cx + trailX, cy + bob + h * 0.25 + scale);
    ctx.lineTo(cx - body.facing * (w * 0.2), cy + bob);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── The state mark. One glyph, above the cat, only when there is an event to report. ──
  if (body.mode === "hold" || body.mode === "pounce" || body.mode === "stalk") {
    ctx.font = `700 9px ${MONO}`;
    ctx.fillStyle = palette.fed;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const verb = body.mode === "hold" ? "ON IT" : body.mode === "pounce" ? "POUNCE" : "STALKING";
    ctx.fillText(verb, cx, cy + bob - h / 2 - 3);
  } else if (agent !== undefined && agent.state === "starving") {
    ctx.font = `700 9px ${MONO}`;
    ctx.fillStyle = palette.starve;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("STARVING", cx, cy + bob - h / 2 - 3);
  }
}

/*
 * `hashSeed` used to live here — a hand-rolled FNV-1a, duplicating the one in
 * `@taia/ui/mechanisms`. It is gone rather than kept, because a second copy of an identity hash is
 * a latent divergence: the moment the two disagree by a constant, a cat's sprite (hashed by the
 * package) and a cat's rhythm (hashed here) are seeded from different values, and the bug presents
 * as "the animation does not match the animal" with nothing obviously wrong at either site.
 *
 * Every rhythm now derives from `fnv1a` in `sim.ts`, from one hash, once.
 */
