/**
 * RENDERING A CAT GRID — two output formats, one grid.
 *
 * ══ WHY TWO, AND WHY THEY MUST SHARE THE GRID ══
 *
 * `ART-DIRECTION.md` §5a assigns them different jobs, for a measured reason:
 *
 *   - THE COLONY MAP IS A SINGLE CANVAS. openhood renders one `<div>` per lit pixel — 576 nodes
 *     per creature — and ARCHIVE `7j` records that as a real mobile hazard. Thirty cats on the map
 *     would be thousands of nodes. `drawCat` paints into one canvas context instead.
 *   - AN INDIVIDUAL PORTRAIT MAY BE SVG. One cat at a time, server-rendered, zero client JS —
 *     which matters because `jsdom` returns `null` from `canvas.getContext("2d")`, so a canvas
 *     portrait is blank during SSR, blank in every unit test, and hydrate-warns. openhood's whole
 *     grid module exists because of that.
 *
 * The failure this file is built to avoid is openhood's original defect: the SAME creature drawn
 * by TWO unrelated renderers that had never agreed on anything, so RIVET on the map and RIVET in
 * the roster were two different species. Both functions here take a `GridPixel[]` from `catGrid`
 * and do nothing but paint it. Neither may ever compute geometry. If a cat needs to change shape,
 * `grid.ts` changes and both renderers follow for free.
 *
 * ══ NEITHER RENDERER OWNS THE PALETTE ══
 *
 * Both take a ramp. §3's phosphor ramp inverts wholesale in light theme, and unitick shipped two
 * separate bugs from tokens left at dark values — so the ramp has to be supplied by whatever knows
 * the current theme, never baked in here.
 */

import type { CatState, GridPixel } from "./grid.js";
import { GRID_H, GRID_W, RAMP_STEPS } from "./grid.js";

/**
 * A ramp: `RAMP_STEPS` CSS colours, darkest first.
 *
 * A plain readonly array rather than a branded type, so a caller can hand in CSS custom property
 * references (`var(--phos-dim)`) as readily as literals. That matters for the SVG path: a
 * server-rendered portrait that emits `var(--phos)` inherits the theme automatically and needs no
 * client JS to switch, which is the whole reason the SVG path exists.
 */
export type Ramp = readonly string[];

/**
 * THE DEFAULT PHOSPHOR RAMP — §3's palette, sampled at six steps from soot to phosphor.
 *
 * Emitted as `oklch()` literals rather than as `var(--phos-*)` references, because this is the
 * fallback a caller gets when it supplies no ramp, and a fallback that depends on custom
 * properties being defined fails silently to `transparent` — an invisible cat, which is the worst
 * possible failure mode for a default.
 *
 * Six values interpolating §3's declared stops. Step 0 is `--soot-line` rather than `--soot`: the
 * outline takes step 0, and an outline drawn IN the page colour is not an outline. Steps 4 and 5
 * bracket `--phos-dim` and `--phos`.
 *
 * NOT a gradient and never rendered as one — §8 bans gradients-as-decoration. These are six
 * discrete values indexed by a quantised step, which is the opposite operation.
 */
/**
 * ══ THE RAMP IS CSS VARIABLES, NOT LITERALS — AND THAT IS A FIX, NOT A STYLE CHOICE ══
 *
 * These were six hardcoded `oklch()` literals tuned for the dark theme. Rendered on the LIGHT
 * theme the cat lost every internal shading step and read as a flat dark blob on pale paper —
 * a silhouette, not an animal. Caught by screenshotting the deployed page in both themes.
 *
 * unitick recorded the identical defect one level up: its canvas fallbacks were "the DARK theme's
 * hex values hardcoded", so a frame that hit the fallback drew the dark theme's colour on light
 * paper. Its conclusion generalises to any sprite: **a semantic colour must never fall back to
 * the wrong theme's copy of itself.**
 *
 * Using `var()` hands the inversion to `globals.css`, which already restates every token three
 * times. The fallbacks after the comma are the dark values, so a context with no CSS variables
 * at all (a bare SVG file, an email) still renders a correct dark-theme cat.
 */
export const PHOSPHOR_RAMP: Ramp = [
  "var(--cat-0, oklch(0.25 0.026 145))", // outline and deepest shadow
  "var(--cat-1, oklch(0.34 0.030 145))",
  "var(--cat-2, oklch(0.44 0.034 145))", // the noise floor
  "var(--cat-3, oklch(0.55 0.040 145))",
  "var(--cat-4, oklch(0.68 0.047 145))",
  "var(--cat-5, oklch(0.86 0.055 145))", // the lit crown and the eyeshine
];

/**
 * THE TWO EVENT HUES, §3 — and the ONLY chroma this module can emit.
 *
 * They reach exactly the pixels `catGrid` flagged `accent`, which is at most two, which is what
 * §8's "their state may tint one or two pixels" permits and no more.
 *
 * `hunting` is deliberately ABSENT rather than mapped to a third hue. §3 declares exactly two
 * event hues and adding a third would be the nine-hues-is-no-hue defect openhood measured. A
 * hunting cat's eyes stay phosphor, which is also the honest reading: hunting is the default
 * condition of a stray, and a default is not an event.
 *
 * `dead` is absent for a different reason: a dead cat's eyes have gone out, and `applyState`
 * already drops them to step 1. Tinting a dark pixel `--starve` would say "this is happening now"
 * about something that has already finished.
 */
export const STATE_ACCENT: Readonly<Partial<Record<CatState, string>>> = {
  /** AMBER — the cat ate. §3: a closed winning trade. */
  fed: "oklch(0.78 0.170 85)",
  /** EMBER RED — the cat is starving. §3: a loss. */
  starving: "oklch(0.60 0.200 25)",
};

/** Resolve one pixel to a colour. The single place `accent` is honoured, for both renderers. */
function colourOf(px: GridPixel, ramp: Ramp, accent: string | undefined): string {
  if (px.accent === true && accent !== undefined) return accent;
  const i = Math.max(0, Math.min(ramp.length - 1, px.step));
  return ramp[i] ?? ramp[0] ?? "transparent";
}

export type RenderOptions = {
  readonly ramp?: Ramp;
  /**
   * The state, used ONLY to pick the accent hue for flagged pixels. It does not re-derive any
   * geometry — the grid was already built for a state and carries its own `accent` flags. Passing
   * a state here that disagrees with the one passed to `catGrid` tints the eyes of a cat shaded
   * for a different state, which is a caller error this module cannot detect and does not try to.
   */
  readonly state?: CatState;
};

/**
 * ══ SVG — one `<rect>` per lit pixel ══
 *
 * `viewBox="0 0 16 16"` with 1x1 rects, so the sprite is authored in GRID units and scaled by
 * whatever CSS width the caller gives the element. That is what lets one string serve a 32px map
 * chip and a 96px detail portrait with no re-render and no second code path.
 *
 * `shape-rendering="crispEdges"` is REQUIRED, not a preference — §8 bans anti-aliasing in the
 * world outright. Without it the renderer antialiases every rect boundary and a 16px sprite scaled
 * to 96px comes out as a soft blur, which is the single fastest way to stop something being pixel
 * art.
 *
 * ══ Why the rects are not merged into runs ══
 *
 * A run-length pass emitting one wide `<rect>` per horizontal run would cut the node count by
 * roughly half. It was not done, and the reason is measured rather than aesthetic: the dither
 * scatters adjacent pixels across ramp steps by design, so horizontal runs of an identical step
 * are SHORT — the saving is small. Meanwhile a merged rect is no longer addressable per pixel,
 * which forecloses the per-pixel debugging that caught every geometry bug recorded in `grid.ts`.
 * The map does not use this path anyway (§5a sends it to canvas), so the node count this saves is
 * on a page showing exactly one cat.
 */
export function catSvg(grid: readonly GridPixel[], opts?: RenderOptions): string {
  const ramp = opts?.ramp ?? PHOSPHOR_RAMP;
  const accent = opts?.state === undefined ? undefined : STATE_ACCENT[opts.state];
  const rects = grid
    // Painter's order: the grid is emitted in scan order with the outline appended last, and an
    // outline pixel never shares a coordinate with a body pixel — but sorting makes the output
    // byte-stable against any future change to the grid's emission order, which is what makes an
    // SVG snapshot test meaningful.
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(
      (px) =>
        `<rect x="${px.x}" y="${px.y}" width="1" height="1" fill="${colourOf(px, ramp, accent)}"/>`,
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID_W} ${GRID_H}" ` +
    `shape-rendering="crispEdges" role="img">${rects}</svg>`
  );
}

/**
 * The 2D context surface this module needs. Structural, and deliberately minimal.
 *
 * Typing the parameter as `CanvasRenderingContext2D` would drag the DOM lib into a package that
 * otherwise compiles under `"lib": ["es2023"]` with `"types": ["node"]` — and it would make this
 * function untestable without jsdom, which is the exact dependency that forced openhood to extract
 * a grid module in the first place. A structural type lets a test hand in a recording stub.
 */
export type Ctx2D = {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  imageSmoothingEnabled?: boolean;
};

/**
 * ══ CANVAS — the colony map path ══
 *
 * Draws the grid at `(x, y)` with each grid pixel `scale` device pixels square.
 *
 * `scale` is taken as a NUMBER OF WHOLE PIXELS and is floored to an integer here. §5a: "every draw
 * snapped `Math.round(x/q)*q`". A fractional scale puts rect edges between device pixels and the
 * rasteriser fills the boundary partially — which is anti-aliasing arriving through the back door,
 * banned by §8, and it is invisible at dpr 1 and obvious on every phone. Flooring to ≥1 is the
 * cheapest place to make that impossible.
 *
 * `imageSmoothingEnabled = false` is set defensively. This function draws rects, which smoothing
 * does not affect — but a caller that blits this canvas onward (§5c's quarter-resolution glow
 * plate does exactly that) inherits the flag from the context, and leaving it true there is how a
 * pixel-art world comes out soft. Setting it costs nothing and closes the hole at the source.
 *
 * Returns nothing and mutates only `fillStyle` and the pixels — no save/restore, no transform. A
 * transform-based scale would be shorter and would reintroduce the fractional-edge problem the
 * integer floor exists to prevent.
 */
export function drawCat(
  ctx: Ctx2D,
  grid: readonly GridPixel[],
  x: number,
  y: number,
  scale: number,
  opts?: RenderOptions,
): void {
  const ramp = opts?.ramp ?? PHOSPHOR_RAMP;
  const accent = opts?.state === undefined ? undefined : STATE_ACCENT[opts.state];
  const q = Math.max(1, Math.floor(scale));
  const ox = Math.round(x);
  const oy = Math.round(y);
  if (ctx.imageSmoothingEnabled !== undefined) ctx.imageSmoothingEnabled = false;
  for (const px of grid) {
    ctx.fillStyle = colourOf(px, ramp, accent);
    ctx.fillRect(ox + px.x * q, oy + px.y * q, q, q);
  }
}

/** The sprite's footprint at a given scale, for a caller laying out a colony. */
export function catSize(scale: number): { readonly w: number; readonly h: number } {
  const q = Math.max(1, Math.floor(scale));
  return { w: GRID_W * q, h: GRID_H * q };
}

/**
 * The ramp step count, re-exported so a caller building a custom ramp cannot get the length wrong.
 *
 * A ramp shorter than this does not error — `colourOf` clamps — it silently flattens the top of
 * the shading, which is a bug that looks like a design choice. Exporting the number is cheaper
 * than the runtime check that would otherwise be needed.
 */
export { RAMP_STEPS };
