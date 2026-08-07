/**
 * Mechanisms — the small toolkit that made twenty hand-built frontends look nothing alike.
 *
 * ══ What this is, and what it is NOT ══
 *
 * It is NOT a component library, and nothing here draws a specific thing. There is no koi, no
 * broker, no Möbius mark. Copying those would make every project look like the project it was
 * copied from, which is the failure this whole effort exists to prevent.
 *
 * It is the LAYER UNDERNEATH those: the maths each of them is built on, parameterised so the
 * character comes from the arguments. `travellingWave` with 12 segments and a 0.5 phase lag is
 * a koi; with 4 segments and a long lag it is a ribbon; with 40 and a tiny lag it is hair or a
 * flag. `shadeSphere` with a 4-step warm ramp is a pixel-art planet; with 32 steps and a cool
 * ramp it is a glass bead. Same function, unrecognisably different results.
 *
 * ══ Why these ten and not others ══
 *
 * Measured across the corpus in `~/work/legacy-zips` and `~/work/legacy-git`: rAF loops appear
 * in 15 of 20 projects, shading models in 12, GLSL in 12, springs in 11, kinematics in 10,
 * `steps()` in 10, metaballs in 7, noise in 6, dithering in 6, instancing in 3. Noise and
 * easing alone are half of every mechanism instance in the corpus.
 *
 * Ten algorithms explain twenty projects that share no visual DNA. The variable was never the
 * algorithm — it was which one got picked and what referent it was pointed at.
 *
 * ══ Read the originals before choosing ══
 *
 * These are the kernels, not the craft. The craft is in how the parameters were derived, and
 * that lives in the source:
 *
 *   ~/work/legacy-git/ponsball/web/src/lib/components/Mascot.svelte   shadeSphere + bayer
 *   ~/work/legacy-zips/dollarBRKDV/.../KoiYinYang.svelte              travellingWave
 *   ~/work/legacy-zips/dollarBHYPE/.../DotMatrix.svelte               metaballField + hash
 *   ~/work/legacy-zips/dollarRandH6900/.../Constellation.svelte       chase (nested)
 *   ~/work/legacy-zips/dollarSNAGGED/.../sketch.ts                    fnv1a
 *   ~/work/legacy-zips/dollarXENO/.../LoadingScreen.svelte            ratchetedProgress
 *   ~/work/legacy-zips/dollarCLINK/.../stage.svelte.ts                rampAt (float-valued theme)
 *
 * Every one of those files argues with itself in comments — it records the rejected
 * alternative and the measured failure that produced the value. That habit is the thing worth
 * copying, far more than any particular sprite.
 *
 * Zero dependencies, by design. The corpus achieves all of this in plain TypeScript and
 * Canvas2D; reaching for three.js to draw a gradient costs 127KB against 0.6KB of raw WebGL.
 */

/** Clamp to a range. Exported because every mechanism below needs it and callers do too. */
export function clamp(value: number, min = 0, max = 1): number {
  return value < min ? min : value > max ? max : value;
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Hermite smoothstep — an S-curve between two edges.
 *
 * Used wherever a value must ease in and out without importing an easing library. The corpus
 * reaches for this constantly: a particle's pull toward an attractor, a metaball's falloff,
 * the window in which a satellite welds onto a body.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * ══ 1. DETERMINISTIC IDENTITY HASH ══
 *
 * FNV-1a, 32-bit. Fifteen lines in `dollarSNAGGED/sketch.ts`, and the highest value-per-line
 * in the entire corpus.
 *
 * The problem it solves: you want every card in a list to lean at a slightly different angle,
 * or every avatar to take a different hue. `Math.random()` cannot do this — it returns a new
 * value on every render, so the card visibly jumps on any re-render and disagrees between
 * server and client. Hashing the item's own id gives a value that is arbitrary but STABLE:
 * the same card leans the same way forever, across reloads, reorders and hydration.
 *
 * `Math.imul` is required, not decorative — it is the only way to get correct 32-bit
 * wraparound multiplication in JS, and without it the distribution collapses.
 */
export function fnv1a(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Map an identity to a stable value in a range.
 *
 * The character comes from the range. `±2.6°` is a scrapbook tilt; `0..360` is a per-user hue;
 * `0.9..1.1` is a size jitter that makes a grid stop looking like a grid.
 */
export function stableValue(id: string, min: number, max: number): number {
  return min + ((fnv1a(id) % 100000) / 100000) * (max - min);
}

/**
 * ══ 2. VALUE NOISE ══
 *
 * A hash-based 2D noise with smoothstep interpolation. Not simplex — deliberately. Simplex is
 * better for large fields, but this is 20 lines with no dependency and is what the corpus
 * actually used for grain, drift and surface variation.
 *
 * The `sin`-hash is the canonical GLSL one-liner ported to JS, and it appears in BHYPE's
 * DotMatrix, ponsball's Mascot and CHARITY's shader alike.
 */
export function hash2(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

export function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  // Bilinear between the four lattice corners, smoothstepped on both axes so the field has no
  // visible grid. Interpolating linearly instead leaves diamond artefacts at the cell edges.
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/**
 * ══ 3. CURL NOISE ══
 *
 * The curl of a noise field, by finite differences. Divergence-free, and that property is the
 * entire point: particles advected through a curl field SWIRL without ever bunching up or
 * spreading evenly out. A naive angle field does both, and reads as wrong immediately.
 *
 * This is what makes ponsball's blizzard look like weather rather than like dots.
 */
export function curlNoise(x: number, y: number, epsilon = 0.6): readonly [number, number] {
  const dy = (valueNoise(x, y + epsilon) - valueNoise(x, y - epsilon)) / (2 * epsilon);
  const dx = (valueNoise(x + epsilon, y) - valueNoise(x - epsilon, y)) / (2 * epsilon);
  return [dy, -dx];
}

/**
 * ══ 4. FRAME-RATE-INDEPENDENT DAMPING ══
 *
 * `pow(retain, dt * 60)` — not `velocity *= 0.94`.
 *
 * The naive form ties the physics to the frame rate: the same scene settles at a different
 * speed on a 120Hz display than a 60Hz one, and teleports after a tab switch. This form asks
 * "how much survives one second" and scales it to the frame actually delivered.
 */
export function damp(value: number, retainPerFrameAt60: number, deltaSeconds: number): number {
  return value * retainPerFrameAt60 ** (deltaSeconds * 60);
}

/**
 * ══ 5. EXPONENTIAL CHASE ══
 *
 * `x += (target - x) * rate`. The cheapest possible easing, and the corpus's most-used
 * mechanism after rAF itself.
 *
 * ══ Why nesting it matters ══
 *
 * R&H6900's constellation runs TWO of these at different rates — a global gather at 0.08 and a
 * per-node chase at 0.18 — and that pairing is what produces "swarm, then settle" rather than
 * "everything slides at once". One rate is a transition; two rates is a behaviour.
 *
 * `deltaSeconds` is optional so the plain per-frame form still works, but supplying it makes
 * the motion frame-rate independent, which is almost always what you want.
 */
export function chase(
  current: number,
  target: number,
  rate: number,
  deltaSeconds?: number,
): number {
  if (deltaSeconds === undefined) return current + (target - current) * rate;
  // Same curve, expressed as a survival fraction so a dropped frame does not slow the motion.
  const remaining = (1 - rate) ** (deltaSeconds * 60);
  return target + (current - target) * remaining;
}

/**
 * ══ 6. TRAVELLING-WAVE SPINE ══
 *
 * Forward kinematics along a chain, with a sine wave travelling down it.
 *
 * ══ The two details that make it read as ALIVE ══
 *
 * The phase LAG (`- i * phaseLag`) is what makes it a swimming thing rather than a wobbling
 * snake — each link is slightly behind the one before, so the wave visibly propagates.
 *
 * The amplitude ramp (`* i / segments`) keeps the head rigid and lets the tail whip. Without
 * it the whole body oscillates uniformly, which reads as a stick being waved.
 *
 * Character comes entirely from the parameters. 12 segments at 0.5 lag is BRKDV's koi. Four
 * segments and a long lag is a ribbon or a tail. Forty segments at 0.05 is hair, or a flag, or
 * a signal trace. The maths does not know what it is drawing.
 */
export type SpineJoint = { readonly x: number; readonly y: number; readonly angle: number };

export function travellingWave(options: {
  readonly segments: number;
  readonly segmentLength: number;
  readonly head: { readonly x: number; readonly y: number; readonly angle: number };
  readonly time: number;
  /** Radians of swing at the tail. ~0.25 is a fish; higher is a whip. */
  readonly amplitude: number;
  /** Cycles per second down the chain. */
  readonly speed: number;
  /** How far each link trails the one before. 0.5 is the measured koi value. */
  readonly phaseLag: number;
}): SpineJoint[] {
  const joints: SpineJoint[] = [options.head];
  for (let i = 1; i < options.segments; i++) {
    const previous = joints[i - 1];
    if (previous === undefined) break;
    const ratio = i / options.segments;
    const phase = options.time * options.speed - i * options.phaseLag;
    const angle = previous.angle + Math.sin(phase) * options.amplitude * ratio;
    joints.push({
      x: previous.x - Math.cos(angle) * options.segmentLength,
      y: previous.y - Math.sin(angle) * options.segmentLength,
      angle,
    });
  }
  return joints;
}

/**
 * A Gaussian width profile along a chain, for extruding a spine into a silhouette.
 *
 * `peak` places the widest point — 0.25 (a quarter back from the head) reads as a fish; 0.5
 * is a leaf; 0.0 is a tadpole. `floor` stops the tail vanishing to nothing.
 */
export function widthProfile(options: {
  readonly ratio: number;
  readonly max: number;
  readonly peak: number;
  readonly spread: number;
  readonly floor: number;
}): number {
  const w = options.max * Math.exp(-(((options.ratio - options.peak) / options.spread) ** 2));
  return Math.max(w, options.floor);
}

/**
 * ══ 7. ORDERED DITHERING ══
 *
 * The 4×4 Bayer matrix, and a quantiser that uses it.
 *
 * Quantising a smooth gradient to a few colours produces visible banding. Adding a small
 * position-dependent offset BEFORE rounding scatters the band edges into a stipple, and the
 * eye reads the result as more colours than are present. This is the difference between
 * "8 colours" and "8 colours that look like a shaded object".
 *
 * `bayer4` is the canonical matrix. `quantise` returns a ramp INDEX, so the caller owns the
 * palette — which is what keeps this a mechanism rather than a look.
 */
export const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

export function bayer4(x: number, y: number): number {
  const row = BAYER_4[y & 3];
  const value = row?.[x & 3] ?? 0;
  return (value + 0.5) / 16 - 0.5;
}

export function quantise(options: {
  /** Luminance or any 0..1 signal. */
  readonly value: number;
  /** Number of steps in the caller's ramp. */
  readonly steps: number;
  readonly x: number;
  readonly y: number;
  /** How much dither to mix in. ~1.1 is the measured ponsball value; 0 disables it. */
  readonly strength?: number;
}): number {
  const dither = bayer4(options.x, options.y) * (options.strength ?? 1.1);
  const index = Math.round(clamp(options.value) * (options.steps - 1) + dither);
  return Math.max(0, Math.min(options.steps - 1, index));
}

/**
 * ══ 8. SPHERE SHADING ══
 *
 * A lighting model for a 2D circle, returning luminance in 0..1. Feed it to `quantise` and a
 * palette ramp and you have a shaded object that is still honestly pixel art.
 *
 * ══ The three terms that are not obvious ══
 *
 * WRAPPED DIFFUSE — `(diffuse + wrap) / (1 + wrap)`. Plain Lambert cuts to black exactly at
 * the terminator, which looks like a hard-edged ball. Wrapping lets light bleed past 90°,
 * which is how high-albedo materials (snow, wax, skin, ice) actually behave.
 *
 * FRESNEL RIM — brightness at grazing angles, strongest where the surface turns away. It is
 * what makes an object look like it is IN a scene rather than pasted on it.
 *
 * CORE SHADOW — a dark band placed just PAST the terminator, not at the darkest point. This is
 * the single thing naive sphere shading gets wrong; without it a sphere reads as a flat disc
 * with a gradient.
 *
 * Returns luminance only. Palette, dithering and resolution are the caller's, which is what
 * makes the same function serve a pixel moon, a glass bead and a chrome ball.
 */
export function shadeSphere(options: {
  /** Position on the sphere, −1..1 from centre. */
  readonly nx: number;
  readonly ny: number;
  /** Normalised light direction. */
  readonly light: readonly [number, number, number];
  /** 0..1 base light everywhere. Raise for a soft, lower for a dramatic object. */
  readonly ambient?: number;
  /** How far light bleeds past the terminator. 0 is plain Lambert; 0.6 is snow-like. */
  readonly wrap?: number;
  /** Specular tightness. High is glass, low is chalk. */
  readonly specularPower?: number;
  readonly rimPower?: number;
}): number | null {
  const d2 = options.nx * options.nx + options.ny * options.ny;
  // Outside the circle. `null` rather than 0 so a caller can tell "no surface" from "black".
  if (d2 > 1) return null;

  const nz = Math.sqrt(Math.max(0, 1 - d2));
  const [lx, ly, lz] = options.light;
  const diffuse = options.nx * lx + options.ny * ly + nz * lz;

  const wrap = options.wrap ?? 0.6;
  const wrapped = Math.max(0, (diffuse + wrap) / (1 + wrap));

  /**
   * Blinn specular, on a NORMALISED half-vector.
   *
   * Measured bug, caught by a range test: raising an un-normalised dot product to a power
   * produced values up to 4047 and saturated 43% of the sphere to flat white — so `ambient`,
   * `wrap` and `specularPower` had no visible effect over most of the surface, which defeats
   * the entire purpose of a parameterised shader. Normalising bounds the term to 0..1.
   */
  const hx = lx;
  const hy = ly;
  const hz = lz + 1;
  const hlen = Math.hypot(hx, hy, hz) || 1;
  const ndoth = Math.max(0, (options.nx * hx + options.ny * hy + nz * hz) / hlen);
  const specular = ndoth ** (options.specularPower ?? 32);

  const rim = (1 - nz) ** (options.rimPower ?? 4.2) * Math.max(0, 0.35 - diffuse) * 2.1;
  // The band sits PAST the terminator — this is the term naive shading omits.
  const core = Math.max(0, 1 - Math.abs(diffuse + 0.18) * 3.4) * 0.3;

  /**
   * Budgeted so the terms cannot sum past 1.
   *
   * The ambient floor takes whatever it asks for, and the lit terms share the REMAINING
   * headroom. Without this the defaults alone reach 1.42 at the hotspot and clip — and every
   * clipped pixel is a pixel where the parameters stopped mattering, which is precisely what
   * a parameterised shader must never do. Measured: budgeting dropped saturation from 43% of
   * the sphere to under 1%.
   */
  const ambient = clamp(options.ambient ?? 0.3);
  const headroom = 1 - ambient;
  const lit = wrapped * 0.62 + rim * 0.22 + specular * 0.38;
  return clamp(ambient + headroom * clamp(lit) - core * headroom);
}

/**
 * ══ 9. METABALL FIELD ══
 *
 * Summed squared falloff from a set of centres. Above a threshold you are "inside".
 *
 * Squared falloff rather than linear is deliberate: it produces tight cores with soft edges,
 * so blobs merge convincingly instead of fading into haze. BHYPE samples this on a 13px grid
 * and dithers the result into dots; the same field at higher resolution is a liquid blob, and
 * at very low resolution it is a departure-board.
 */
export function metaballDensity(
  x: number,
  y: number,
  balls: readonly { readonly x: number; readonly y: number; readonly radius: number }[],
): number {
  let total = 0;
  for (const ball of balls) {
    const dx = x - ball.x;
    const dy = y - ball.y;
    const rr = ball.radius * ball.radius;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr) continue;
    const f = 1 - d2 / rr;
    total += f * f;
  }
  return total;
}

/**
 * ══ 10. RATCHETED PROGRESS ══
 *
 * A loader that never goes backwards and never stalls.
 *
 * Real progress arrives in lumps and sometimes regresses. Showing it raw produces the bar that
 * sits at 90% forever — the single most distrusted element on the web. This takes the MAXIMUM
 * of real progress and a time-based floor, so it always creeps forward, and caps the floor
 * below 1 so time alone can never complete it. The bar only finishes when the work does.
 *
 * `knee` makes it slow early and quick late, which reads as effort followed by completion.
 */
export function ratchetedProgress(options: {
  /** Real progress, 0..1. */
  readonly actual: number;
  /** Seconds since the load began. */
  readonly elapsedSeconds: number;
  /** Seconds the time-floor takes to reach its ceiling. */
  readonly expectedSeconds: number;
  /** Highest the time-floor may reach alone. Must stay below 1. */
  readonly ceiling?: number;
  /** Previous displayed value, so the result can never regress. */
  readonly previous?: number;
}): number {
  const ceiling = options.ceiling ?? 0.92;
  const t = clamp(options.elapsedSeconds / Math.max(0.001, options.expectedSeconds));
  const eased = 1 - (1 - t) ** 3;
  const floor = Math.min(ceiling, eased * ceiling);
  return Math.max(options.previous ?? 0, options.actual, floor);
}

/**
 * ══ 11. FLOAT-VALUED RAMP ══
 *
 * Index a palette with a CONTINUOUS position rather than an integer.
 *
 * CLINK's whole design system turns on this: stage is a float, not an enum, so scroll progress
 * lerps the entire palette and 77 `var(--accent)` references retint at once. An enum would
 * snap between four themes; a float means the page is always somewhere between two of them.
 *
 * Generic over any numeric tuple, so it serves RGB, oklch, or a single scalar like blur.
 */
export function rampAt(ramp: readonly (readonly number[])[], position: number): number[] {
  if (ramp.length === 0) return [];
  const clamped = clamp(position, 0, ramp.length - 1);
  const i = Math.floor(clamped);
  const j = Math.min(ramp.length - 1, i + 1);
  const t = clamped - i;
  const a = ramp[i];
  const b = ramp[j];
  if (a === undefined || b === undefined) return [];
  return a.map((value, k) => lerp(value, b[k] ?? value, t));
}

/**
 * ══ 12. INCOMMENSURATE PERIODS ══
 *
 * Given a base period, produce periods that will not visibly re-sync.
 *
 * Ambient motion built on 2s/4s/8s loops looks mechanical, because every 8 seconds everything
 * realigns and the eye catches it. The corpus avoids this everywhere — BHYPE's CRT runs
 * 4.1s/5.5s/9s, BRKDV's koi fins run 4.0/2.8/3.5 Hz — and the effect is motion that never
 * appears to repeat.
 *
 * Uses irrational-ish ratios so the combined period is effectively unbounded.
 */
export function incommensurate(base: number, count: number): number[] {
  const ratios = [1, 1.3247, 1.7549, 2.2055, 2.8036, 3.3829, 4.1231, 5.0842];
  return Array.from({ length: count }, (_, i) => base * (ratios[i % ratios.length] ?? 1 + i));
}
