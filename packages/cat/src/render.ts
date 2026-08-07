/**
 * RENDERING A CAT GRID — two output formats, one grid.
 *
 * ══ WHY TWO, AND WHY THEY MUST SHARE THE GRID ══
 *
 * `ART-DIRECTION.md` §5a assigns them different jobs, and openhood's own header states the
 * constraint that forces the split in as many words:
 *
 *   - THE COLONY MAP IS A SINGLE CANVAS. openhood renders one `<div>` per lit pixel — 576 nodes per
 *     creature — and ARCHIVE `7j` records that as a real mobile hazard. Thirty cats on the map would
 *     be thousands of nodes. `drawCat` paints into one canvas context instead.
 *   - AN INDIVIDUAL PORTRAIT MUST BE SVG. **`jsdom` returns `null` from `canvas.getContext("2d")`**,
 *     and portraits render during SSR. A canvas portrait would be blank on the server, blank in
 *     every unit test, and would hydrate-warn. openhood's whole grid module exists because of that
 *     one fact, and this package inherits it unchanged.
 *
 * The failure this file is built to avoid is openhood's original defect: the SAME creature drawn by
 * TWO unrelated renderers that had never agreed on anything, so RIVET on the map and RIVET in the
 * roster were two different species. Every function here takes a `GridPixel[]` from `catGrid` and
 * does nothing but paint it. None of them may ever compute geometry. If a cat needs to change shape,
 * `grid.ts` changes and both renderers follow for free.
 *
 * ══ AND NEITHER RENDERER OWNS THE PALETTE ══
 *
 * Colour is resolved in exactly one place — `catRamp` — for the same reason openhood extracted
 * `pixelColour`: the moment two renderers each index a ramp themselves, they can disagree about
 * which ramp an inner-ear pixel takes. openhood records that adding a second ramp without a shared
 * resolver "would reintroduce the identical class of defect one layer down".
 */

import type { CatState, GridPixel } from "./grid.js";
import { catPigment, GRID_H, GRID_W, RAMP_STEPS, tintStepFor } from "./grid.js";

/**
 * A ramp: `RAMP_STEPS` CSS colours, darkest first.
 *
 * A plain readonly array rather than a branded type, so a caller can hand in CSS custom property
 * references (`var(--cat-3)`) as readily as literals.
 */
export type Ramp = readonly string[];

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE BASE RAMP — eight steps from soot to phosphor, and it is the GROUND, not the coat.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Eight values interpolating §3's declared stops, raised from six when the grid went to 24x24. Step
 * 0 is `--soot-line` rather than `--soot`: the outline takes step 0, and an outline drawn IN the
 * page colour is not an outline.
 *
 * NOT a gradient and never rendered as one — §8 bans gradients-as-decoration. These are eight
 * discrete values indexed by a quantised step, which is the opposite operation.
 *
 * ══ THE RAMP IS CSS VARIABLES, NOT LITERALS — A FIX, NOT A STYLE CHOICE ══
 *
 * These were once hardcoded `oklch()` literals tuned for the dark theme. Rendered on the LIGHT theme
 * the cat lost every internal shading step and read as a flat dark blob on pale paper — a
 * silhouette, not an animal. Caught by screenshotting the deployed page in both themes.
 *
 * unitick recorded the identical defect one level up: its canvas fallbacks were "the DARK theme's
 * hex values hardcoded", so a frame that hit the fallback drew the dark theme's colour on light
 * paper. Its conclusion generalises to any sprite: **a semantic colour must never fall back to the
 * wrong theme's copy of itself.**
 *
 * Using `var()` hands the inversion to `globals.css`. The fallbacks after the comma are the dark
 * values, so a context with no CSS variables at all (a bare SVG file, an email) still renders a
 * correct dark-theme cat.
 */
export const PHOSPHOR_RAMP: Ramp = [
  "var(--cat-0, oklch(0.22 0.024 145))", // outline and deepest shadow
  "var(--cat-1, oklch(0.29 0.028 145))",
  "var(--cat-2, oklch(0.37 0.032 145))", // the noise floor
  "var(--cat-3, oklch(0.46 0.036 145))",
  "var(--cat-4, oklch(0.56 0.042 145))", // the coat's own band — where pigment lands
  "var(--cat-5, oklch(0.67 0.048 145))",
  "var(--cat-6, oklch(0.79 0.052 145))",
  "var(--cat-7, oklch(0.90 0.055 145))", // the lit crown and the eyeshine
];

/**
 * The base ramp as packed RGB integers, for the pigment mix.
 *
 * The `var()` ramp above cannot be mixed with a pigment — you cannot interpolate a CSS custom
 * property reference in JavaScript — so the numeric ramp is declared alongside it and
 * `PHOSPHOR_RAMP` is the theme-aware fallback for a caller that wants NO pigment at all.
 *
 * These are the DARK theme's phosphor values converted to sRGB. That is a deliberate asymmetry from
 * the `var()` ramp and it is safe for one reason: a pigmented cat is drawn in its COAT's colour, and
 * a coat colour does not invert between themes — a ginger cat is ginger on white paper. Only the
 * SHADOW end, which stays common to every cat, is theme-dependent, and `catRamp` leaves the dark end
 * of the ramp untouched by the pigment precisely so a caller may substitute it.
 */
const BASE_RGB: readonly number[] = [
  0x1c231c, 0x272f26, 0x353f33, 0x455040, 0x56624f, 0x6b7862, 0x8a967f, 0xb4bda6,
];

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PIGMENT IS FEATHERED ACROSS THREE RAMP STEPS, NEVER STAMPED ONTO ONE.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This is openhood's `creatureRamp` correction, transplanted verbatim including its reasoning,
 * because it is the single mechanism that separates "an animal with a coat" from "an animal with a
 * decal on it". openhood's own record:
 *
 *   > This mixed the pigment into a SINGLE ramp step at 0.55. Rendered at 30x zoom, the result was
 *   > flat blocks of saturated pink appearing wherever the shading happened to land on that one
 *   > step — an arbitrary bright patch across a forehead or a chest, reading as a marking the data
 *   > never described rather than as a coat.
 *   >
 *   > The pigment now feathers across the tint step and its two neighbours, strongest at the centre.
 *   > That is what a coat is: the creature's colour modulated BY the light, rather than a decal
 *   > applied at one light level.
 *
 * The weights are openhood's measured 0.5 at the centre and 0.26 at each neighbour. They are not
 * re-derived here, because the property they encode is about how a ramp reads rather than about what
 * animal is drawn — and openhood measured them at 30x zoom on the same 24x24 grid this file uses.
 *
 * ══ AND THE DARK END STAYS COMMON TO EVERY CAT ══
 *
 * `tintStepFor` only ever returns 3, 4 or 5, so steps 0-2 and 7 are never touched. openhood's
 * reason: "shadows on one page are lit by one candle; only the mid and lit bands take the creature's
 * hue. Tinting the whole ramp would produce dark creatures and light creatures, which reads as two
 * species rather than as one species with different markings."
 *
 * That also keeps two invariants this package needs: the OUTLINE (step 0) is the same colour on
 * every cat, so a colony never has two-tone edges, and the EYESHINE (step 7) stays phosphor, so a
 * cat's eyes read as reflecting the illuminator rather than as being its coat colour.
 */
const PIGMENT_CENTRE = 0.5;
const PIGMENT_NEIGHBOUR = 0.26;

/** Relative luminance of a packed RGB integer, Rec. 709 weights. Used to preserve the ramp's ladder. */
function luma(c: number): number {
  return 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PIGMENT MIX PRESERVES THE BASE STEP'S LUMINANCE — and this was a measured failure.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A plain component-wise `mix` — which is what openhood uses — pulls each step toward the pigment in
 * BRIGHTNESS as well as in hue. openhood gets away with that because its base ramp is a saturated
 * violet-to-pink with a wide luminance spread, so a pigment mixed into three of its steps still
 * leaves them clearly ordered.
 *
 * This base ramp is a low-chroma phosphor green whose adjacent steps are close together, and a
 * render at 384x zoom showed what that does: for `mackerel` the ramp came out `#5b6356 #787e72
 * #77816f` at steps 3, 4 and 5 — step 5 was DARKER than step 4. The pigment had flattened the middle
 * of the ramp into three near-identical values, so every piece of modelling that lives in that band
 * (the cheek, the brow, the body's own shading, the neck break) rendered as one wash. The cat had a
 * coat colour and no shape.
 *
 * That is a serious defect and not a subtle one: the ramp's job is to be a monotonic ladder of
 * luminance, and a coat colour that breaks the ladder destroys every structural decision `grid.ts`
 * makes, all of which are expressed as differences between steps.
 *
 * ══ THE FIX: TAKE THE HUE FROM THE PIGMENT AND THE BRIGHTNESS FROM THE BASE ══
 *
 * Mix as normal, then rescale the result back to the base step's own luminance. The pigment supplies
 * chroma — which is the whole point, and is what makes a ginger cat ginger — and the ramp keeps
 * exactly the ladder it was designed with. A cat is now its coat colour AND fully modelled, where
 * before it could be one or the other.
 *
 * This is a genuine divergence from openhood rather than a port of it, and it is forced by the base
 * palette rather than by taste: §3's phosphor ramp is one hue at low chroma, and openhood's method
 * assumes a base with luminance headroom to spare.
 */
function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  let r = ar + (br - ar) * k;
  let g = ag + (bg - ag) * k;
  let bl = ab + (bb - ab) * k;
  // Rescale to the BASE step's luminance, so the ramp's ladder survives the pigment.
  const want = luma(a);
  const got = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  if (got > 0.5) {
    const s = want / got;
    r *= s;
    g *= s;
    bl *= s;
  }
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return (q(r) << 16) | (q(g) << 8) | q(bl);
}

/** A packed RGB int as `#rrggbb`. Universally parseable, unlike `oklch()` in some contexts. */
function hex(c: number): string {
  return `#${(c >>> 0).toString(16).padStart(6, "0")}`;
}

/**
 * THE RAMP ONE CAT IS DRAWN FROM: the shared phosphor ramp with this cat's own coat pigment
 * feathered into its tint step and the two steps either side of it.
 *
 * Shared by the canvas baker and the SVG portrait so a cat cannot be one colour on the map and
 * another in a portrait.
 *
 * A DEAD cat is drawn from the base ramp with NO pigment. That is not a fade — the geometry already
 * makes a dead cat a flat silhouette — it is the statement that the coat has stopped being the thing
 * you are looking at. openhood's dormant creatures do the same and record why: a drained ramp rather
 * than lowered alpha, because alpha reads as "still loading" and a fault and a state must never be
 * confusable.
 */
export function catRamp(id: string, state?: CatState): Ramp {
  if (state === "dead") return BASE_RGB.map(hex);
  const pigment = catPigment(id);
  const centre = tintStepFor(id);
  return BASE_RGB.map((c, i) => {
    const d = Math.abs(i - centre);
    if (d > 1) return hex(c);
    return hex(mix(c, pigment, d === 0 ? PIGMENT_CENTRE : PIGMENT_NEIGHBOUR));
  });
}

/**
 * THE TWO EVENT HUES, §3 — and the ONLY chroma this module emits that is not a coat.
 *
 * They reach exactly the pixels `catGrid` flagged `accent`, which is at most two — one per eye.
 *
 * ══ WHY A COAT PIGMENT DOES NOT COLLIDE WITH THESE ══
 *
 * §8's "no semantic hue meaning two things" is still in force after the coat ban was lifted, and it
 * is honoured by keeping the pigments off both event hues in HUE DEGREES rather than by assertion:
 * the warmest pigment is `ginger` near hue 55, and the amber `fed` accent is at 85. `grid.test.ts`
 * asserts that separation numerically.
 *
 * `hunting` is deliberately ABSENT rather than mapped to a third hue. §3 declares exactly two event
 * hues and adding a third would be the nine-hues-is-no-hue defect openhood measured. A hunting cat's
 * state is carried by its POSTURE and its EARS instead, which is a stronger read than a tint anyway
 * — and it is the honest reading: hunting is the default condition of a stray, and a default is not
 * an event.
 *
 * `dead` is absent for a different reason: a dead cat's eyes have gone out, and `applyState` already
 * drops them below the coat. Tinting a dark pixel `--starve` would say "this is happening now" about
 * something that has already finished.
 */
export const STATE_ACCENT: Readonly<Partial<Record<CatState, string>>> = {
  /** AMBER — the cat ate. §3: a closed winning trade. */
  fed: "oklch(0.80 0.170 85)",
  /** EMBER RED — the cat is starving. §3: a loss. */
  starving: "oklch(0.62 0.200 25)",
};

/** Resolve one pixel to a colour. The single place `accent` is honoured, for every renderer. */
function colourOf(px: GridPixel, ramp: Ramp, accent: string | undefined): string {
  if (px.accent === true && accent !== undefined) return accent;
  const i = Math.max(0, Math.min(ramp.length - 1, px.step));
  return ramp[i] ?? ramp[0] ?? "transparent";
}

export type RenderOptions = {
  /**
   * The ramp to paint from. Omit it and pass `id` instead to get this cat's own pigmented ramp;
   * pass it explicitly to override — a forced-colours fallback, a theme the package does not know
   * about, or a deliberately achromatic render.
   */
  readonly ramp?: Ramp;
  /**
   * The cat's id, used ONLY to derive its coat ramp when `ramp` is not supplied. Omit both and the
   * cat is drawn in the unpigmented phosphor ramp, which is the correct fallback for a caller that
   * has a grid but not the id that produced it.
   */
  readonly id?: string;
  /**
   * The state, used to pick the accent hue for flagged pixels and to drop the pigment when dead. It
   * does not re-derive any geometry — the grid was already built for a state and carries its own
   * `accent` flags. Passing a state here that disagrees with the one passed to `catGrid` tints the
   * eyes of a cat shaded for a different state, which is a caller error this module cannot detect
   * and does not try to.
   */
  readonly state?: CatState;
};

/** The ramp a set of options resolves to. Extracted so every renderer resolves it identically. */
function rampFor(opts: RenderOptions | undefined): Ramp {
  if (opts?.ramp !== undefined) return opts.ramp;
  if (opts?.id !== undefined) return catRamp(opts.id, opts.state);
  return PHOSPHOR_RAMP;
}

/**
 * ══ SVG — the PORTRAIT path, one `<path>` per colour ══
 *
 * `viewBox="0 0 24 24"` with 1x1 cells, so the sprite is authored in GRID units and scaled by
 * whatever CSS width the caller gives the element. That is what lets one string serve a 32px map
 * chip and a 96px detail portrait with no re-render and no second code path.
 *
 * `shape-rendering="crispEdges"` is REQUIRED, not a preference — §8 bans anti-aliasing in the world
 * outright. Without it the renderer antialiases every cell boundary and a 24px sprite scaled to 96px
 * comes out as a soft blur, which is the single fastest way to stop something being pixel art.
 *
 * ══ ONE PATH PER COLOUR, NOT ONE RECT PER PIXEL — and this is a v2 change ══
 *
 * v1 emitted a `<rect>` per lit pixel and argued for it: "the dither scatters adjacent pixels across
 * ramp steps by design, so horizontal runs of an identical step are SHORT — the saving from merging
 * is small", and "a merged rect is no longer addressable per pixel, which forecloses the per-pixel
 * debugging that caught every geometry bug in `grid.ts`".
 *
 * Both halves of that stopped being true. The grid went from 256 cells to 576, so a v1-style
 * portrait is now ~400 `<rect>` elements each carrying its own `fill` attribute — and openhood, at
 * the identical grid size, measured that as the reason to group. Grouping by COLOUR (openhood's
 * approach, `M x y h1v1h-1z` subpaths) gives at most a dozen paths with the fill written once each,
 * regardless of how the dither scattered anything: the subpaths do not need to be contiguous.
 *
 * The debugging argument is answered by the fact that the DEBUGGING TOOL is `scripts/preview.mjs`,
 * which paints from the grid directly and never goes through this function at all.
 */
export function catSvg(grid: readonly GridPixel[], opts?: RenderOptions): string {
  const ramp = rampFor(opts);
  const accent = opts?.state === undefined ? undefined : STATE_ACCENT[opts.state];
  const byColour = new Map<string, string[]>();
  // Sorted before grouping so the output is byte-stable against any future change to the grid's
  // emission order, which is what makes an SVG snapshot test meaningful.
  const sorted = grid.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  for (const px of sorted) {
    const c = colourOf(px, ramp, accent);
    const parts = byColour.get(c) ?? [];
    // `h1v1h-1z` — a 1x1 square as a closed subpath. Shorter than a <rect> and it batches.
    parts.push(`M${px.x} ${px.y}h1v1h-1z`);
    byColour.set(c, parts);
  }
  const paths = [...byColour.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([colour, parts]) => `<path d="${parts.join("")}" fill="${colour}"/>`)
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID_W} ${GRID_H}" ` +
    `shape-rendering="crispEdges" role="img">${paths}</svg>`
  );
}

/**
 * The 2D context surface this module needs. Structural, and deliberately minimal.
 *
 * Typing the parameter as `CanvasRenderingContext2D` would drag the DOM lib into a package that
 * otherwise compiles under `"lib": ["es2023"]` with `"types": ["node"]` — and it would make these
 * functions untestable without jsdom, which is the exact dependency that forced openhood to extract
 * a grid module in the first place. A structural type lets a test hand in a recording stub.
 */
export type Ctx2D = {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  imageSmoothingEnabled?: boolean;
};

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ CANVAS — the colony map path, and it is built for THIRTY CATS ANIMATING AT ONCE ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Draws the grid at `(x, y)` with each grid cell `scale` device pixels square.
 *
 * ══ THE COST MODEL, AND WHY THE PIXELS ARE SORTED BY COLOUR ══
 *
 * A 24x24 cat is ~450 lit cells. Thirty cats at three frames is 40,500 `fillRect` calls per full
 * repaint, and the expensive part of that is NOT the rects — it is the `fillStyle` assignment, which
 * on every major engine parses the string and rebuilds a paint object. v1 assigned `fillStyle` once
 * per pixel: 40,500 string parses a frame, which is where a colony animation actually dies.
 *
 * Sorting the grid by resolved colour and assigning `fillStyle` once per RUN drops that to at most
 * `RAMP_STEPS + 1` assignments per cat — nine instead of 450, a 50x reduction on the one operation
 * that dominates. The rects themselves are cheap and stay one per pixel, because merging them into
 * horizontal runs saves nothing: the Bayer dither scatters adjacent cells across steps by design, so
 * runs of an identical colour are short.
 *
 * ══ AND THE SORT IS DONE ONCE, NOT PER DRAW ══
 *
 * `bakeCat` returns a pre-sorted, pre-resolved draw list. A caller animating a colony bakes each
 * cat's three frames ONCE and then calls `drawBaked` every frame, so the per-frame work is a flat
 * loop over an array with no hashing, no colour resolution and no allocation at all. `drawCat` is
 * the convenience path for a caller drawing a handful of cats; `bakeCat` + `drawBaked` is the path
 * for the map.
 *
 * ══ THE INTEGER SNAP IS NOT OPTIONAL ══
 *
 * `scale` is taken as a NUMBER OF WHOLE PIXELS and floored here. §5a: "every draw snapped
 * `Math.round(x/q)*q`". A fractional scale puts rect edges between device pixels and the rasteriser
 * fills the boundary partially — which is anti-aliasing arriving through the back door, banned by
 * §8, and it is invisible at dpr 1 and obvious on every phone.
 *
 * `imageSmoothingEnabled = false` is set defensively. This function draws rects, which smoothing
 * does not affect — but a caller that blits this canvas onward (§5c's quarter-resolution glow plate
 * does exactly that) inherits the flag from the context, and leaving it true there is how a
 * pixel-art world comes out soft. Setting it costs nothing and closes the hole at the source.
 */
export type BakedCat = {
  /** Runs of cells sharing one colour: `[colour, x, y, x, y, ...]` flattened per run. */
  readonly runs: readonly { readonly colour: string; readonly cells: Int8Array }[];
};

export function bakeCat(grid: readonly GridPixel[], opts?: RenderOptions): BakedCat {
  const ramp = rampFor(opts);
  const accent = opts?.state === undefined ? undefined : STATE_ACCENT[opts.state];
  const byColour = new Map<string, number[]>();
  for (const px of grid) {
    const c = colourOf(px, ramp, accent);
    const cells = byColour.get(c) ?? [];
    cells.push(px.x, px.y);
    byColour.set(c, cells);
  }
  return {
    runs: [...byColour.entries()]
      // Sorted so a baked cat is byte-stable for a given grid, which is what makes it snapshot-able
      // and what stops two bakes of one cat drawing in different orders.
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([colour, cells]) => ({ colour, cells: Int8Array.from(cells) })),
  };
}

/**
 * Paint a baked cat. The hot path — no allocation, no colour resolution, one `fillStyle` per run.
 *
 * `Int8Array` is sufficient because every coordinate is 0..23, and a typed array is what keeps the
 * per-frame loop free of the pointer chasing an array of objects would cost across thirty cats.
 */
export function drawBaked(
  ctx: Ctx2D,
  baked: BakedCat,
  x: number,
  y: number,
  scale: number,
): void {
  const q = Math.max(1, Math.floor(scale));
  const ox = Math.round(x);
  const oy = Math.round(y);
  if (ctx.imageSmoothingEnabled !== undefined) ctx.imageSmoothingEnabled = false;
  for (const run of baked.runs) {
    ctx.fillStyle = run.colour;
    const cells = run.cells;
    for (let i = 0; i < cells.length; i += 2) {
      // `as number` is unnecessary at runtime; the non-null reads are safe because the array's
      // length is even by construction in `bakeCat`.
      const cx = cells[i] ?? 0;
      const cy = cells[i + 1] ?? 0;
      ctx.fillRect(ox + cx * q, oy + cy * q, q, q);
    }
  }
}

/**
 * Draw a cat straight from its grid. The convenience path.
 *
 * Bakes and draws in one call, which is correct for a portrait or a handful of sprites and wasteful
 * for a colony — a caller drawing thirty cats every frame should bake once and call `drawBaked`.
 * Both go through `bakeCat`, so they cannot disagree about what a cat looks like.
 */
export function drawCat(
  ctx: Ctx2D,
  grid: readonly GridPixel[],
  x: number,
  y: number,
  scale: number,
  opts?: RenderOptions,
): void {
  drawBaked(ctx, bakeCat(grid, opts), x, y, scale);
}

/** The sprite's footprint at a given scale, for a caller laying out a colony. */
export function catSize(scale: number): { readonly w: number; readonly h: number } {
  const q = Math.max(1, Math.floor(scale));
  return { w: GRID_W * q, h: GRID_H * q };
}

/**
 * The ramp step count, re-exported so a caller building a custom ramp cannot get the length wrong.
 *
 * A ramp shorter than this does not error — `colourOf` clamps — it silently flattens the top of the
 * shading, which is a bug that looks like a design choice. Exporting the number is cheaper than the
 * runtime check that would otherwise be needed.
 */
export { RAMP_STEPS };
