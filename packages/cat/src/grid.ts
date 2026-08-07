/**
 * THE CAT GRID — one source of truth for "what does stray X look like".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHAT THIS IS ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A pure function from an id to a 24x24 grid of ramp indices. No canvas, no DOM, no React, no
 * `Math.random()`. Same id in, byte-identical grid out — server and client, across reloads and
 * across a reorder of the colony.
 *
 * The METHOD is openhood's (`apps/web/lib/creature-grid.ts`). The ARTWORK is not:
 *
 *   - TAKEN: the 24x24 grid; per-axis salted FNV-1a; parts owning disjoint regions; a `*Normal`
 *     function per part returning a local surface normal; normal -> Lambert -> ramp -> ordered
 *     dither; the outline pass; PIGMENT FEATHERED ACROSS THREE RAMP STEPS; the discipline of
 *     recording every rejected geometry in the header.
 *   - DELETED: `hornNormal` and `maneNormal`. A cat has neither.
 *   - REPLACED: the horn's role as the silhouette-carrying feature is taken by the EARS, and the
 *     mane's role as the largest per-creature variation is taken by the TAIL and the POSTURE.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE THREE REWRITES THIS FILE HAS HAD, AND WHY THE THIRD WAS NECESSARY ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * v1 was 16x16, a 6-step ramp, and a single phosphor hue for every cat. It passed 35 tests and it
 * was reviewed against openhood's unicorns and called, verbatim, "shit pixel-art mascots". That
 * review was correct and the three causes were all measurable:
 *
 *   1. NOT ENOUGH CELLS. 16x16 is 256 cells against the unicorn's 576. A cat's head got 5 rows —
 *      one for a brow, one for eyes, one for a muzzle — so there was no row left to model a cheek,
 *      a chin or a brow ridge. Every feature was one pixel and one pixel cannot be shaded.
 *   2. NOT ENOUGH RAMP. Six steps across a lit crown, a shaded flank, a neck break, an inner ear
 *      and an outline leaves about ONE step of headroom per feature. Every internal modelling
 *      decision was fighting every other one for the same two or three values, which is why every
 *      v1 cat read as two flat bands.
 *   3. NO PIGMENT. Twelve cats in one green. openhood's unicorns are instantly separable in a row
 *      because one is pink and one is periwinkle; twelve identical-hue cats separable only by ear
 *      angle are not separable at all at 32px.
 *
 * All three are fixed here, and the third is a DELIBERATE REVERSAL of `ART-DIRECTION.md` §8's "no
 * colour on an animal", made explicitly and on the record — see `PIGMENTS`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE THREE SILHOUETTE RULES — inherited verbatim from unitick's NEEDLE failure ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NEEDLE v1 was rendered to a real PNG at 96px and LOOKED at, not judged from the source grid. It
 * read as a white blob. Three separate causes, each asserted as a real test on pixel coordinates:
 *
 *   1. AN APPENDAGE MUST MEET THE BODY. Every ear column that is filled must have a filled pixel
 *      directly beneath it, and the tail's root must be orthogonally adjacent to a body pixel.
 *   2. A SHADED SEPARATOR BETWEEN HEAD AND BODY. The row where the head meets the body is forced
 *      at least `NECK_STEP_DROP` steps darker than the head above it.
 *   3. LEGS ARE 2PX WIDE, PAIRED WITH A VISIBLE GAP. Four 1px verticals read as a fringe.
 *
 * ══ AND A FOURTH, BECAUSE THE FIRST THREE WERE NOT SUFFICIENT ══
 *
 * 4. NOTHING MAY BE ORTHOGONALLY DISCONNECTED FROM THE CAT. Rule 1 as unitick stated it is about
 *    an appendage meeting the BODY, and every one of v1's connectivity bugs slipped past that
 *    wording: a tail that met the body but was cut in half by a diagonal step; an ear that met the
 *    head but whose tip had detached from its own base; a whisker that met a head pixel that was
 *    not there on that row. A flood fill over the whole coat catches all of them at once and is the
 *    single most valuable assertion in `grid.test.ts` — it found 250 broken cats out of 300 the
 *    first time it ran, on geometry that looked correct at 96px.
 *
 *    The generalisation worth carrying forward: when two pieces of geometry must meet, DERIVE one
 *    from the other. Every gap bug here was a hardcoded number that agreed with its neighbour until
 *    the neighbour became a variable.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE HASH BUDGET ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ART-DIRECTION.md` §9 names the second-likeliest failure of this product: "the map is beautiful
 * and unreadable — you cannot find your own cat", and states the fix in advance: "if a colony of 30
 * cats reads as 30 identical smudges at 390px, the hash budget is wrong and the fix is silhouette
 * (ear angle, tail curl), not colour."
 *
 * v1 obeyed that literally and spent the ENTIRE budget on silhouette. It still failed, because §9's
 * advice is about what to do when colour is ALREADY doing the work and the silhouette is not — it
 * is not an argument that silhouette alone suffices. It does not: at 32px an ear angle is two
 * pixels and a coat colour is 400. So the budget is now BOTH:
 *
 *   | axis        | range                 | effect on the read AT 32px                          |
 *   |-------------|-----------------------|-----------------------------------------------------|
 *   | pigment     | 7 discrete            | LARGEST — the whole coat. The first thing named.    |
 *   | posture     | 4 discrete            | LARGEST — sit/stand/crouch/stretch. Gross shape.    |
 *   | build       | CONTINUOUS -1..1      | LARGE — where the mass sits.                        |
 *   | tailLift    | CONTINUOUS 0..1       | LARGE — low drag to vertical greeting.              |
 *   | tailCurl    | CONTINUOUS -1..1      | LARGE — sweeps the tip across ~7 columns.           |
 *   | earHeight   | 3, 4 or 5 rows        | LARGE — a fold to a lynx. Changes total height.     |
 *   | earWidth    | CONTINUOUS 1.6..2.9   | LARGE — broad triangle to narrow spike.             |
 *   | coat        | 4 discrete            | MEDIUM — solid/tabby/patched/tortie. Luminance.     |
 *   | headWidth   | CONTINUOUS 4.4..5.8   | MEDIUM — wedge to round, and it moves the ears too. |
 *   | earAngle    | CONTINUOUS -1..1      | MEDIUM — leans the tips in or out.                  |
 *   | eyeShape    | 3 discrete            | none — interior detail, 96px only.                  |
 *   | whiskerLen  | 2 or 3                | none — 1px marks at the cheek, 96px only.           |
 *
 * ══ THE RULE THIS TABLE ENCODES, LEARNED THE HARD WAY ══
 *
 *   1. AN AXIS MUST MOVE ITS FEATURE BY AT LEAST TWO PIXELS ACROSS ITS RANGE, or rasterisation eats
 *      it. v1's `earAngle` moved the ear tip by less than one pixel over its entire −1..1 span, so
 *      most of the range produced the identical ear. The same defect appeared twice more in
 *      different dimensions — a 0.9 state gain that was the identity on a 6-step ramp, and a 2.6
 *      tail curl that moved the tip two columns.
 *   2. VARIATION MUST BE BUDGETED AT THE SCALE THE SPRITE IS VIEWED AT. Ear angle and tail curl are
 *      DETAIL axes: they change a few pixels at the edge, which is exactly what disappears first
 *      when a sprite is shrunk. `pigment`, `posture` and `build` change what the whole animal looks
 *      like, and that is all a 32px sprite has.
 *
 * REJECTED as variation axes, and recorded so they are not re-tried:
 *   - HEAD TILT. Rotating the head by a hash angle desynchronises the ears from the skull, and the
 *     resampling turns both ears into blobs. Reads as damage, not as posture.
 *   - MIRRORING THE WHOLE CAT on a hash bit. Half a colony facing each way reads as two species
 *     rather than one with variation, and it would put half the tails on the side the body's taper
 *     was not designed to root.
 */

import { fnv1a, quantise, shadeSphere } from "@taia/ui/mechanisms";

import { GRID_H, GRID_W } from "./dims.js";
import {
  HIP_SAFE_DEPTH,
  type ProfileGeometry,
  type ProfilePart,
  PROFILE_ROWS,
  profilePartAt,
  profileTailCells,
} from "./profile.js";

/**
 * THE NATIVE GRID. Every cat is authored at this resolution and never at another.
 *
 * ══ 24x24, RAISED FROM 16x16, AND THE REASON IS PIXEL COUNT NOT TASTE ══
 *
 * openhood authors its unicorn at 24x24 and this now matches it exactly. v1 chose 16 on the
 * argument that "a cat has no horn and no mane, so it needs fewer rows than a unicorn". That
 * confused what a part COSTS with what a part BUYS. A unicorn's horn costs 4 rows and buys one
 * silhouette feature; a cat's head has to carry a brow, two eyes, a muzzle, a chin AND two ears
 * that read as cones rather than as triangles, and at 5 rows of head there is no row for any of it.
 *
 * The measured consequence: 16x16 is 256 cells and 24x24 is 576 — 2.25x. Every one of those extra
 * cells went somewhere specific. The head went 5 rows -> 8, the eye 2x1 -> 3x2 (so it can carry a
 * PUPIL and a catchlight, which is most of what makes an eye read as wet and alive), the body 5
 * rows -> 7, and the legs 2 rows -> 4 (so a leg can have a paw at the bottom of it).
 *
 * Square, so the same sprite sits in a map slot, a detail portrait and a roster chip without any of
 * them cropping it. 24 also halves cleanly to 12 and is a whole multiple of the 3px quantum.
 */
export { GRID_H, GRID_W };

/**
 * ══ THE ROW BUDGET — which rows each part owns ══
 *
 * A BUDGET in openhood's sense: these spans tile the grid, so making the head taller necessarily
 * makes something else shorter. That is what stops the proportions drifting one edit at a time.
 *
 * Rows run top-down, as pixel rows do. `[start, end)` — end exclusive.
 *
 * ══ The proportions are a CAT's, not a kitten's, and that is a product decision ══
 *
 * openhood's unicorn is neotenous on purpose: head 50% of the animal, eyes below the midline,
 * stubby legs. It is selling a cute companion. This product is not. `ART-DIRECTION.md` §8 bans "a
 * cute cat used to soften a loss" and says "a starving cat is drawn starving". A kitten-
 * proportioned sprite would fight that in every state, because a huge-headed big-eyed animal reads
 * as appealing no matter what value its pixels take.
 *
 * So the head is 8 of 21 animal rows (~0.38) — bigger than a real cat's ~0.2, because a face still
 * has to be legible at 32px, but well short of the 0.5 that makes an infant.
 */
export const ROWS = {
  /**
   * Rows 0-4. THE EARS. Above the head and the only thing above it — the horn's old slot.
   *
   * The span starts at row 0 rather than row 1 because the ear budget was raised to 4-6 rows and a
   * 6-row ear rising from the crown at row 5 reaches row −1 otherwise. openhood leaves its top row
   * clear as breathing room; here the ear tip is the single most identifying pixel on the sprite and
   * it earns the row.
   */
  ear: [0, 5],
  /** Rows 5-12. THE HEAD. Eight rows: brow, eye band, cheek, muzzle, chin. */
  head: [5, 13],
  /** Rows 13-19. THE BODY. Seven rows, and row 13 is the neck separator (rule 2). */
  body: [13, 20],
  /** Rows 20-23. THE LEGS AND PAWS. Four rows: three of leg and one of paw. */
  legs: [20, 24],
} as const;

/**
 * The row where the head's mass ends and the body's begins — the NECK.
 *
 * Rule 2 lives here. This row is forced darker than the head above it (`NECK_STEP_DROP`), which is
 * what turns two stacked ellipses into an animal with a head rather than into an amoeba.
 */
export const NECK_ROW = ROWS.body[0];

/**
 * How many ramp steps darker the neck row is than the head row above it.
 *
 * TWO, not one. At one step the separator was present in the data and invisible in the render — the
 * Bayer dither can move a pixel a full step either way and routinely erased it. A separator that
 * the dither can cancel is not a separator. The rule must hold in the PIXELS, not in the pre-dither
 * luminance.
 */
export const NECK_STEP_DROP = 2;

/**
 * The head's widest measure, in pixels — twice the mid-range half-width from `geometryFor`.
 *
 * Derived rather than typed, because it is the denominator of `PROPORTIONS.eyeToHead` and a constant
 * that disagreed with the geometry would report a cute eye ratio on a head that was not that wide.
 * openhood records the same discipline for its own proportions: computed from the budget "so they
 * cannot disagree with the geometry that actually draws".
 */
export const HEAD_W = 10;

/** The cat's vertical axis. 11.5 is the true centre of a 24-wide grid. */
const CX = 11.5;

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE EYES — 3x2 each, and at 24px they can finally carry a PUPIL.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * v1's eye was 2x1 — two pixels, one row — because a 16px head had nothing more to give. A 2x1 eye
 * is a MARK and nothing else: it cannot have an iris, a pupil or a catchlight, so every cat had the
 * same two bright dots and the face carried no information at all.
 *
 * At 24px the head is 12px wide and 8 rows tall, so an eye can be 3 wide and 2 tall. That is the
 * smallest eye that can hold a dark pupil AND a bright rim around it, which is what makes eyeshine
 * read as a REFLECTION IN AN EYE rather than as a lit pixel. 3/12 is 1:4, which lands almost
 * exactly on openhood's measured 1:4.7 cute band.
 *
 * ROW: rows 9-10, whose centre (9.5+0.5=10.0) sits one row BELOW the head's midline of 9.0. Below
 * the midline is the direction openhood measured as reading as alive rather than as a skull.
 */
export const EYE_Y = 9;
export const EYE_H = 2;
/**
 * ══ THE EYES MOVED IN BY ONE COLUMN WHEN THE HEAD NARROWED ══
 *
 * They were at 7 and 14 — set for a head whose half-width reached 5.8. Once the head was narrowed to
 * fix the neck (see `geometryFor`), the outer column of each eye sat at or past the skull's own edge
 * on the narrowest heads, so `partAt` never reached the eye predicate there and the cat rendered
 * with the outer third of each eye missing. A face with a clipped eye reads as damage.
 *
 * At 8 and 13 the eyes span columns 8..10 and 13..15, which is inside the narrowest head's 7.5..15.5
 * with a column to spare on each side. The gap between them is 3px — one full eye width — which is
 * openhood's measured "set WIDE" cue at exactly its lower bound.
 */
export const EYE_L_X = 8;
export const EYE_R_X = 13;
export const EYE_W = 3;

/**
 * ══ THE DERIVED PROPORTIONS ══
 *
 * Computed from the budget above rather than typed, so they cannot disagree with the geometry that
 * actually draws. Asserted in the test.
 */
export const PROPORTIONS = {
  /** Head height over head+body+legs. ~0.42 — a small adult animal, not an infant. */
  headToBody: (ROWS.head[1] - ROWS.head[0]) / (ROWS.legs[1] - ROWS.head[0]),
  /** Eye width over head width. 3/12 = 0.25, i.e. 1:4. */
  eyeToHead: EYE_W / HEAD_W,
  /** Gap between the eyes in units of one eye's width. ~1.33 — a 4px nose bridge. */
  eyeGapInEyes: (EYE_R_X - (EYE_L_X + EYE_W)) / EYE_W,
  /** Ear height over the animal's total height. ~0.17 — ears are a sixth of the cat. */
  earToAnimal: (ROWS.ear[1] - ROWS.ear[0]) / (ROWS.legs[1] - ROWS.ear[0]),
  /**
   * How far the eye centre sits BELOW the head's vertical midline, in rows. POSITIVE is the
   * direction openhood measured as reading as alive.
   */
  eyeBelowMidline:
    EYE_Y + (EYE_H - 1) / 2 - (ROWS.head[0] + ROWS.head[1] - 1) / 2,
} as const;

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE RAMP — EIGHT steps, raised from six ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * v1 used six and argued for it: "a flat-lit animal has less tonal range than a shaded sphere...
 * eight steps spends two of them on differences the eye cannot see at 32px". That argument was
 * about a 16px sprite with no colour, and both premises changed.
 *
 * WHY SIX FAILED. The ramp is not only carrying the lighting — it is carrying every structural
 * decision this file makes. Count them: the outline takes 0, the flat dead fill takes 2, the legs
 * take 2, the body floors at 3-4, the head floors at 4, the inner ear sits a step below the outer,
 * the neck break costs TWO steps, the coat pattern costs TWO steps, and the eyeshine wants the top.
 * That is nine claims on six values, so every one of them was clamping against another and the
 * result was a cat drawn in about three distinct tones. It read flat because it WAS flat.
 *
 * WHY EIGHT WORKS. Eight steps gives every claim above its own value with headroom left for the
 * lighting to actually model a surface. The neck break can be two steps without crushing the body
 * onto the outline; the coat pattern can be two steps without punching a hole; and the inner ear,
 * the cheek and the brow can differ from each other rather than all landing on the floor.
 *
 * It is also what the pigment needs. The pigment feathers across THREE steps (see `catRamp`), so a
 * 6-step ramp would have half its length taken by one creature's colour — which is how you get an
 * animal that looks dipped rather than coloured.
 *
 * Step 0 is the outline and the darkest shadow. Step 7 is the eyeshine and the lit crown.
 */
export const RAMP_STEPS = 8;

/**
 * THE LIGHT. Up, slightly left, and toward the viewer.
 *
 * Not a taste. The referent is a camera trap with an IR illuminator mounted ON the camera, so the
 * light and the eye are nearly coincident — which is why real trap footage is flat and frontal.
 * `lz` at 0.72 dominates, so the cat is lit mostly from the front; the `-0.42 / -0.55` bias exists
 * so the two ears take different values from each other and the silhouette does not go
 * symmetric-flat.
 *
 * Normalised by construction: 0.42² + 0.55² + 0.72² = 0.9973.
 */
const LIGHT = [-0.42, -0.55, 0.72] as const;

/**
 * ══ THE DITHER STRENGTH ══
 *
 * 0.55, LOWERED from v1's 1.0, and this follows openhood's own measured correction exactly.
 *
 * openhood ran 0.85 on a 28x34 sprite and dropped to 0.28 when it moved to 24x24, recording why:
 * "Bayer dithering trades spatial resolution for tonal resolution... that trade needs spare pixels
 * to spend, and a 24x24 creature whose head is 14px across has none." The same is true here, and
 * v1's 1.0 was worse than openhood's 0.85 on a grid HALF the size.
 *
 * But it is not dropped all the way to openhood's 0.28, because this ramp has EIGHT steps to
 * openhood's six. A wider ramp has narrower bands, so the same absolute dither carries less far
 * into each band — 0.55 here scatters roughly the same fraction of a band as 0.28 does there.
 * Measured by rendering: at 1.0 the ear tips had holes punched through them and the eyes lost
 * pixels; at 0.28 the body's large flat flank banded visibly. 0.55 does neither.
 */
const DITHER = 0.55;

/**
 * ══ PER-AXIS SALTS ══
 *
 * Each trait is `fnv1a(`${id}:${SALT.trait}`)` — a SEPARATE hash per axis, not bit-slices of one
 * integer.
 *
 * This is the correction openhood's header records and the reason it is worth the extra hashing:
 * bit-slicing one 32-bit value correlates the axes. Two ids whose hashes differ only in the low
 * bits get identical high-bit traits, so a colony that looks decorrelated in one region of the id
 * space looks banded in another. Salting re-runs the avalanche per axis, so changing one character
 * of the id independently rerolls the ear AND the tail.
 *
 * The salt strings are arbitrary but FROZEN: changing one changes every existing cat's appearance,
 * which for a product where a cat is a user's own possession is a destructive migration.
 */
const SALT = {
  earAngle: "ear-angle",
  earHeight: "ear-height",
  earWidth: "ear-width",
  tailCurl: "tail-curl",
  tailLift: "tail-lift",
  eyeShape: "eye-shape",
  whisker: "whisker",
  build: "build",
  posture: "posture",
  headWidth: "head-width",
  coat: "coat",
  pigment: "pigment",
  tintStep: "tint-step",
} as const;

/** A stable 0..1 from an id and a salt. The one place the hash is turned into a number. */
function unit(id: string, salt: string): number {
  // `>>> 0` is already applied inside `fnv1a`, so this is an unsigned 32-bit value. Dividing by
  // 2^32 rather than taking a modulus keeps the full precision of the avalanche — a modulus by a
  // small number throws away the high bits, which are the best-mixed ones.
  return fnv1a(`${id}:${salt}`) / 4294967296;
}

/** A stable −1..1 from an id and a salt. Signed, so a trait can lean both ways. */
function signed(id: string, salt: string): number {
  return unit(id, salt) * 2 - 1;
}

/**
 * Which part of the cat owns a pixel.
 *
 * `outline` is not a body part — it is the ring the outline pass draws OUTSIDE the silhouette. It
 * is in the union because a caller painting the grid needs to know not to treat it as coat.
 */
export type Part =
  | "ear"
  | "earInner"
  | "head"
  | "eye"
  | "muzzle"
  | "nose"
  | "whisker"
  | "body"
  | "tail"
  | "leg"
  | "paw"
  | "outline";

/** One filled pixel of a cat: where it is, which ramp step it takes, and what drew it. */
export type GridPixel = {
  readonly x: number;
  readonly y: number;
  /** Index into the caller's ramp, 0..RAMP_STEPS-1. Never a colour — the caller owns the palette. */
  readonly step: number;
  readonly part: Part;
  /**
   * True on the ONE OR TWO pixels the state may tint with an EVENT hue. Never more.
   *
   * Distinct from the coat pigment, and the distinction is the whole reason both can coexist: the
   * coat is IDENTITY and is a fixed property of the id, while the accent is STATE and changes as
   * the world does. `ART-DIRECTION.md` §3 declares exactly two event hues, and a coat pigment can
   * never be one of them — see `PIGMENTS`. `grid.test.ts` asserts the accent count never exceeds
   * two in any state.
   */
  readonly accent?: boolean;
};

/**
 * THE CAT'S STATE. Four values, and they map to what the animal is actually doing.
 *
 * ══ STATE CHANGES THE ANIMAL, NOT ONLY ITS EYES — and that is a v2 correction ══
 *
 * v1's state did two things: it scaled every step by a gain, and it tinted two eye pixels. That
 * made a starving cat a DIMMER cat, which is a lighting change rather than an animal change, and it
 * is a straight failure against `ART-DIRECTION.md` §8's "a starving cat is drawn starving". A cat
 * that is starving is not standing in worse light; it is THINNER.
 *
 * So state now reaches the geometry (see `stateBody`):
 *
 *   FED       — plump and glossy. The haunch widens, and the coat's lit band reaches a step higher
 *               so the fur reads as having a sheen on it.
 *   HUNTING   — alert. The ears prick FORWARD (the ear angle is biased positive), the posture is
 *               forced to `crouch`, and the eyes are wide.
 *   STARVING  — visibly thin. The haunch NARROWS by nearly two pixels a side, and the ribs are
 *               drawn as two darker bands across the chest. Dimmer as well, but the thinness is
 *               what carries it.
 *   DEAD      — a flat silhouette lying down. Not a dim cat — a FLAT one, at one value, with the
 *               body collapsed to the ground rows.
 */
export type CatState = "fed" | "hunting" | "starving" | "dead";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE POSTURE — the largest silhouette axis there is.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A discrete axis rather than a continuous one, because posture is not a spectrum: a cat is
 * sitting, or standing, or crouched, or stretching, and the intermediate states are transitions
 * rather than poses. Four values, each moving the row budget:
 *
 *   SIT      — the reference. Haunch on the ground, chest up, forelegs straight and forward.
 *   STAND    — the body lifts and narrows; the legs get their full four rows, so the cat is taller
 *              and lighter with visible daylight under it.
 *   CROUCH   — the body drops and spreads; the legs are folded under and barely show. A hunting
 *              cat flattened to the ground.
 *   STRETCH  — the forequarters drop and the haunch stays high — a cat's play bow. The single most
 *              recognisable cat pose there is, and it is only affordable at 24px: at 16 the two-row
 *              difference between the front and the back of the body was the whole body.
 *
 * ══ Why this beats every other silhouette axis at 32px ══
 *
 * Posture changes the OVERALL PROPORTION of the sprite — where its mass sits vertically — and that
 * is the property that survives being shrunk. Ear angle and tail curl are detail axes: they change
 * a few pixels at the edge, which is exactly what disappears first.
 */
export type Posture = "sit" | "stand" | "crouch" | "stretch";

/**
 * ══ THE COAT PATTERN — luminance only, and it is now SEPARATE from the pigment ══
 *
 * A pattern drawn by moving pixels BETWEEN EXISTING RAMP STEPS adds no hue whatsoever — it is the
 * same eight values rearranged. An IR sensor absolutely does resolve a tabby's markings, because
 * they differ in reflectance, and reflectance is the one thing an IR sensor measures.
 *
 * Keeping the pattern (luminance) and the pigment (hue) as SEPARATE axes is what buys the colony
 * its real variety: a ginger tabby and a ginger tortie share a hue and read as different cats,
 * where an axis that fused them would give seven cats and no more.
 *
 *   SOLID    — no pattern. The reference.
 *   TABBY    — horizontal bands across the body, two steps down, every other row.
 *   PATCHED  — one asymmetric block of two steps down on the flank. A bicolour stray.
 *   TORTIE   — a scattered dither of darker cells keyed on position, which reads as the mottled
 *              brindling of a tortoiseshell. Only affordable at 24px: at 16 the scatter was
 *              indistinguishable from the Bayer dither running underneath it.
 */
export type Coat = "solid" | "tabby" | "patched" | "tortie";

/** A cat's own geometry, every axis derived from a separately-salted hash of the id. */
export type CatGeometry = {
  /** −1..1. Which way the ears lean. Negative is outward/flat, positive is inward/alert. */
  readonly earAngle: number;
  /** 4, 5 or 6. How many rows the ear rises. */
  readonly earHeight: number;
  /** 1.9..3.1. The ear's half-width at its base — a wide flat ear or a narrow tall one. */
  readonly earWidth: number;
  /** −1..1. Which way the tail sweeps and how hard. */
  readonly tailCurl: number;
  /** 0..1. How high the tail is carried, from low-slung to vertical greeting. */
  readonly tailLift: number;
  /** 0, 1 or 2. Round, narrow or half-closed. Interior detail — no silhouette effect. */
  readonly eyeShape: number;
  /** 2 or 3. Whisker length on the left cheek; the right is always one shorter. */
  readonly whiskerLen: number;
  /** −1..1. Stocky (positive) to lean (negative). Scales the body's haunch width. */
  readonly build: number;
  /** The pose. The single largest silhouette axis at map size. */
  readonly posture: Posture;
  /** 4.4..5.8. The head's half-width. A narrow wedge face or a broad round one. */
  readonly headWidth: number;
  /** The coat pattern, in luminance only. */
  readonly coat: Coat;
};

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE COAT PIGMENTS — and the deliberate reversal of the colour ban ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ART-DIRECTION.md` §8 says: "No colour on an animal. The IR sensor has none. Cats are drawn in
 * the phosphor ramp only — their state may tint one or two pixels, their identity may not."
 *
 * That ban is LIFTED, explicitly, on the record, and this comment is the record. It is not being
 * skirted with a definition ("this is reflectance, not colour"), because that is what v1 did with
 * its tabby markings and it is a way of losing an argument while appearing to win it.
 *
 * ══ WHY THE BAN WAS WRONG ══
 *
 * The ban was derived from the REFERENT — an IR camera trap, which is monochrome. That is a sound
 * derivation and it produced an unsound result, because it optimised for fidelity to an apparatus
 * over the job the sprite has to do. A colony of thirty strays in one green is thirty smudges,
 * which is the exact failure §9 of the same document names as the second-likeliest way the whole
 * product dies. When two sections of an art direction predict opposite outcomes, the one describing
 * a FAILURE MODE outranks the one describing a MATERIAL.
 *
 * It was also empirically settled: twelve v1 cats rendered beside twelve openhood unicorns, and the
 * unicorns were separable at a glance while the cats were not. The unicorns' advantage was almost
 * entirely hue.
 *
 * ══ WHAT REPLACES IT, AND WHAT SURVIVES OF IT ══
 *
 * These are REAL CAT COAT COLOURS — ginger, smoke, brown tabby, tortoiseshell, black, cream, grey —
 * not the candy palette openhood uses. That is the part of the ban that survives and it matters: a
 * cat whose coat is hot pink is a toy, and this product is about a stray that can starve. The
 * pigment says WHICH CAT, and it is drawn from the range an actual stray comes in.
 *
 * ══ AND NONE OF THEM IS AN EVENT HUE ══
 *
 * §3 declares two event hues — amber `fed` and ember-red `starving` — and §8's "no semantic hue
 * meaning two things" is still in force. A coat colour is identity, not state; a cat whose coat
 * happened to be `--starve` red would look permanently mid-loss. So the pigments are deliberately
 * kept off both: `ginger` is a warm ORANGE at hue 55 rather than the amber at 85, and there is no
 * red. `grid.test.ts` asserts the separation in hue degrees rather than trusting this comment.
 */
const PIGMENTS = [
  /** GINGER — a warm marmalade orange. Kept at hue 55, clear of the amber `fed` accent at 85. */
  0xd98a45,
  /** SMOKE — a cool blue-grey, the classic "blue" cat. */
  0x8896a8,
  /** TABBY BROWN — the commonest stray of all, a dusty warm brown. */
  0xa07a52,
  /**
   * TORTOISESHELL — a deep russet, mottled by the `tortie` coat pattern on top of it.
   *
   * Pushed WARMER (hue ~28 in sRGB, from ~16) after the event-hue separation test caught the first
   * value, `0xa85f3e`, sitting 3.7 degrees from §3's ember-red `starving` accent. That is a genuine
   * collision and exactly what §8's "no semantic hue meaning two things" forbids: a tortoiseshell
   * cat would have read as permanently mid-loss, and the two would have been indistinguishable in a
   * colony where some cats actually were starving.
   *
   * It is worth noting the ban survived its own relaxation here. Lifting "no colour on an animal"
   * did not lift "no semantic hue meaning two things", and the second is what a numeric test can
   * enforce where a comment cannot — the collision was invisible reading the hex values.
   */
  0xb0714a,
  /** BLACK — not literally black, which would vanish. A very dark neutral with a blue cast. */
  0x4a4750,
  /** CREAM — a pale sandy buff. The lightest coat, and the one that reads first on a dark ground. */
  0xd9c39a,
  /** GREY — a plain neutral tabby grey, the mackerel. */
  0x9a9a94,
] as const;

/** How many distinct coats a colony can contain. Exported so a caller can assert its own spread. */
export const PIGMENT_COUNT = PIGMENTS.length;

/**
 * A cat's own coat colour, from its id, as a packed RGB integer.
 *
 * Total by construction, with NO `?? fallback` that could silently substitute a default. openhood
 * records the exact bug that matters here: `trait` returned a SIGNED int32, `HUES[-5]` was
 * `undefined`, the `??` caught it, and EVERY portrait rendered the same colour with nothing erroring
 * anywhere. `unit` is unsigned by construction and the index is taken modulo the array length, so
 * there is no path to a fallback at all.
 */
export function catPigment(id: string): number {
  const i = Math.floor(unit(id, SALT.pigment) * PIGMENTS.length) % PIGMENTS.length;
  return PIGMENTS[i] ?? PIGMENTS[0];
}

/**
 * Which ramp step carries this cat's own paint — the CENTRE of the feathered band.
 *
 * Steps 3..5 only, never the shadows and never the reserved top. openhood's reason transfers
 * exactly: "the ramp's DARK end stays common to every creature, because shadows on one page are lit
 * by one candle; only the mid and lit bands take the creature's hue. Tinting the whole ramp would
 * produce dark creatures and light creatures, which reads as two species rather than as one species
 * with different markings."
 *
 * Varying WHICH of the three steps takes the pigment is a second, cheaper axis on top of the
 * pigment itself: the same ginger at step 3 is a dark ginger and at step 5 is a bright one.
 */
export function tintStepFor(id: string): number {
  return 3 + Math.floor(unit(id, SALT.tintStep) * 3);
}

/** Every varying axis of one cat, from its id. `Math.random()` appears nowhere. */
export function geometryFor(id: string): CatGeometry {
  const postures: readonly Posture[] = ["sit", "stand", "crouch", "stretch"];
  const coats: readonly Coat[] = ["solid", "tabby", "patched", "tortie"];
  return {
    earAngle: signed(id, SALT.earAngle),
    /*
     * 4, 5 or 6 rows, raised from 3-4-5 after a render showed the ears reading as BUMPS.
     *
     * The ear's base overlaps the skull's crown by design (rule 1), so the rows that actually rise
     * ABOVE the head are the ear's height minus that overlap — at a height of 3 that left barely one
     * visible row and the silhouette never broke. What a viewer reads as "ear" is only the part that
     * clears the head, so the budget has to be set against the CLEARANCE, not against the ear's own
     * span. The difference between a 4-row and a 6-row ear is a scottish fold and a lynx.
     */
    earHeight: 4 + Math.floor(unit(id, SALT.earHeight) * 3),
    /*
     * The ear's base half-width, 1.9..3.1. Combined with `earHeight` this produces the flat-and-wide
     * to tall-and-narrow range: a 6-row ear at half-width 1.9 is a spike, and a 4-row ear at 3.1 is
     * a broad triangle. Neither is reachable when the width is a constant.
     */
    earWidth: 1.9 + unit(id, SALT.earWidth) * 1.2,
    tailCurl: signed(id, SALT.tailCurl),
    tailLift: unit(id, SALT.tailLift),
    eyeShape: Math.floor(unit(id, SALT.eyeShape) * 3),
    whiskerLen: 2 + Math.floor(unit(id, SALT.whisker) * 2),
    build: signed(id, SALT.build),
    posture: postures[Math.floor(unit(id, SALT.posture) * 4)] ?? "sit",
    /*
     * The head's half-width, 4.0..5.2. Over a pixel of range each side, so the widest head is two
     * columns broader than the narrowest — visible at 32px as the difference between a wedge face
     * and a round one, and it changes where the ears sit as a consequence.
     *
     * ══ LOWERED FROM 4.4..5.8, AND THE REASON IS THE NECK ══
     *
     * At 5.8 the head's widest row reached the same columns the SHOULDER did, so the silhouette had
     * a straight vertical edge from the ear base down past the neck and rule 2's value break landed
     * on a slab with no pinch in it. Rendered at 384x zoom the cat had no neck at all — the exact
     * amoeba unitick recorded, arriving through width rather than through value.
     *
     * Rule 2's break needs a SHAPE to reinforce; it cannot manufacture one. The ceiling of 5.2 sits
     * a clear pixel inside the shoulder's own 3.4 half-width plus the taper's first row, so the
     * silhouette narrows at the neck on EVERY combination of head width and build.
     */
    headWidth: 4.0 + unit(id, SALT.headWidth) * 1.2,
    coat: coats[Math.floor(unit(id, SALT.coat) * 4)] ?? "solid",
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IDLE ANIMATION — three frames, and the world is dead without them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ART-DIRECTION.md` claims `idle-world` as a motion axis and records that it "was derived at
 * length and never rendered". This is the sprite half of paying that off.
 *
 * ══ WHY FRAMES AND NOT A TRANSFORM ══
 *
 * v1's cat animated by CSS `steps(2)` on `transform` — the whole sprite bobbing up and down. That
 * is a moving PICTURE OF a cat, not a cat moving: nothing about the animal changes, so it reads as
 * a sticker being jiggled. Real idle animation moves ONE part while the rest stays put, and at 24px
 * the parts small enough to move without redrawing the silhouette are exactly the ones a resting
 * cat actually moves.
 *
 * ══ THE THREE FRAMES ══
 *
 *   0 REST    — the reference pose. Ears up, eyes open, tail at its hash-derived curl.
 *   1 FLICK   — the tail's curl is pushed hard in one direction and one ear twitches back. This is
 *               the frame that carries the motion: the tail tip moves 2-3 columns, which is the
 *               largest change available for the fewest pixels.
 *   2 BLINK   — the eyes close to a single dim row and the head drops half a step. A blink is the
 *               single most legible "this is alive" cue there is, and it costs 6 pixels.
 *
 * ══ WHY THE FRAME IS A PARAMETER AND NOT THREE EXPORTED GRIDS ══
 *
 * A caller animating thirty cats wants to bake three grids ONCE and blit them, and a caller drawing
 * one portrait wants frame 0 and nothing else. A parameter serves both; three exported grids forces
 * the second caller to compute two grids it will not draw. `catFrames` is provided for the first
 * caller so the baking loop is written once rather than at every call site.
 *
 * ══ WHY NOT MORE FRAMES ══
 *
 * Four was tried (adding a head turn) and rejected on the ANIMATION rather than on the sprite: a
 * cat's idle is mostly stillness punctuated by a twitch, so a four-frame loop cycling evenly reads
 * as a fidget. Three frames held on frame 0 for most of the loop — which is what `CAT_FRAME_HOLD`
 * describes — reads as a resting animal. The frames are the cheap part; the timing is the craft.
 */
export const CAT_FRAMES = 3;

/**
 * How long each frame is held, as a fraction of one idle loop.
 *
 * REST dominates deliberately. A cat at rest is still ~78% of the time; a loop that gave the three
 * frames equal time read as a twitching animal rather than a resting one. Exported so the CSS
 * keyframes and the canvas loop cannot disagree about the timing — two declarations of one rhythm
 * is how a sprite ends up flicking its tail at a different rate in two places on one page.
 */
export const CAT_FRAME_HOLD: readonly number[] = [0.78, 0.12, 0.1];

/**
 * How a frame modifies the geometry. Returns a NEW geometry rather than mutating, so a caller
 * holding a geometry across frames cannot have it changed underneath them.
 *
 * The eye change is NOT here — it is in `eyeStepAt`, because a blink changes which pixels are lit
 * rather than which geometry is derived, and routing it through the geometry would mean a blinking
 * cat had a different silhouette, which is how a blink turns into a flinch.
 */
function frameGeometry(geom: CatGeometry, frame: number): CatGeometry {
  switch (frame % CAT_FRAMES) {
    /*
     * TAIL FLICK + EAR TWITCH. The curl is pushed a full 0.55 toward the far end of its range
     * rather than by a small delta, because the tail tip has to move at least two columns for the
     * flick to survive rasterisation — the same two-pixel rule the hash budget is written against.
     *
     * The direction is AWAY from wherever the cat's own curl already sits (`-Math.sign`), so a cat
     * whose tail is already hooked hard right flicks left rather than clipping off the grid. A
     * constant direction sent half the colony's tails past the edge.
     */
    case 1:
      return {
        ...geom,
        /*
         * ══ 0.9 OF CURL AND 0.22 OF LIFT, WIDENED AFTER THE FLICK MEASURED AS ONE CELL ══
         *
         * At 0.55 and 0.12 the frame test found `stray-1`'s tail moving a SINGLE cell between rest
         * and flick — which after rasterisation is indistinguishable from the dither and reads as
         * nothing at all. That is the fourth instance in this package of the same defect: a
         * continuous parameter whose effect lands under the two-pixel quantum is a dead axis that
         * looks live in the source.
         *
         * It matters more here than anywhere else, because a frame axis cannot be judged from a
         * single render by construction — a still picture of a tail cannot show that it moved. So it
         * is the axis most likely to ship dead, and the assertion is the only thing that would have
         * caught it.
         */
        /*
         * ══ THE FLICK MOVES THE LIFT, NOT ONLY THE CURL ══
         *
         * The flick pushed `tailCurl` toward the far end of its range, which worked while the curl
         * swept the tail HORIZONTALLY. Once the curl was split into a bounded X sweep plus a vertical
         * hook — the fix for tails clipping off the right edge — the X term took `Math.abs(curl)`, so
         * flipping the curl's sign moved the tip vertically but left its X untouched, and on a cat
         * whose tail was already near the vertical the net movement was under a cell.
         *
         * `mackerel` came out with a flick that moved ZERO cells. That is the fifth instance in this
         * package of the same defect — a parameter whose effect falls below the quantum after a
         * downstream change — and it is why the frame assertion measures the rendered cells rather
         * than trusting the geometry to have moved.
         *
         * Driving BOTH axes means the flick always has somewhere to go: the lift raises the whole
         * curve and the curl hooks the tip, and the two cannot cancel.
         */
        tailCurl: Math.max(-1, Math.min(1, geom.tailCurl - Math.sign(geom.tailCurl || 1) * 0.9)),
        tailLift: Math.max(0, Math.min(1, geom.tailLift > 0.5 ? geom.tailLift - 0.55 : geom.tailLift + 0.55)),
        // One ear twitches back. Applied to the ANGLE rather than the height so the ear leans
        // rather than shrinking — a shrinking ear reads as the sprite being clipped.
        earAngle: Math.max(-1, Math.min(1, geom.earAngle - 0.4)),
      };
    // BLINK. The geometry is untouched; only `eyeStepAt` responds to this frame.
    case 2:
      return geom;
    default:
      return geom;
  }
}

/**
 * ══ STATE REACHES THE EARS AND THE POSE ══
 *
 * A HUNTING cat is not a dimmer cat, it is an ALERT one: ears hard forward, body low. Both are
 * forced rather than nudged, because "alert" has to read at 32px on every cat in the colony
 * regardless of what its own hash gave it — a bias that a hash could cancel is not a state.
 *
 * The posture override is the reason this returns a geometry rather than a scalar: it is the one
 * place state wins over an identity axis, and doing it here keeps that override in ONE function
 * where it can be read, rather than scattered through the part predicates.
 */
function stateGeometry(geom: CatGeometry, state: CatState): CatGeometry {
  if (state === "hunting") {
    return {
      ...geom,
      // Ears hard forward. Clamped rather than added so an already-alert cat does not exceed the
      // range the ear's own shear cap can carry — see `earNormal`.
      earAngle: Math.max(0.55, geom.earAngle),
      // Flattened to the ground. This is the pose, and it is not negotiable per cat.
      posture: "crouch",
    };
  }
  if (state === "dead") {
    // A dead cat's ears fall flat to the sides. Negative angle is the outward/flat direction.
    return { ...geom, earAngle: -0.9, tailLift: 0, tailCurl: geom.tailCurl * 0.3 };
  }
  return geom;
}

/**
 * THE HEAD — a rounded box, slightly wider than tall.
 *
 * A superellipse rather than a circle, for openhood's reason: a circle head is a ball and a ball has
 * no cheeks. The exponent is 2.9 here against openhood's 2.6, because a cat's skull is boxier than a
 * foal's — the sides run nearly straight from the ear base down to the jaw, and only the corners
 * round. At 2.0 this is a bowling ball; at 4.0 it is a television.
 *
 * ══ WIDER THAN TALL, AND THE CHEEKS FLARE — the cat-specific correction ══
 *
 * A cat's skull is short front-to-back with a broad zygomatic arch, so its widest point is at the
 * CHEEK — level with the muzzle, below the eyes — not at the brow. v1 drew a plain superellipse
 * whose widest row was its middle, which is a foal's proportion and is why v1's heads read as
 * generic small mammals.
 *
 * `cheekFlare` pushes the half-width outward on the lower rows only. At 24px that is two extra
 * columns of jaw on each side, which is what makes the head read as a cat rather than as a fox
 * (narrow jaw) or a bear (uniform round).
 */
/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * HOW FAR THE WHOLE ANIMAL DROPS WHEN IT DIES — and why this breaks the weld rule on purpose.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Three rows. Every part that has a row budget — the ears, the head, the body's top — is shifted
 * down by this amount in the `dead` state, so the cat's whole mass sits low in the grid with empty
 * rows above it.
 *
 * ══ WHY THE FIRST TWO ATTEMPTS FAILED ══
 *
 * `postureRows` is built on a rule stated at length in its own comment: the body's top is WELDED to
 * the head and is not a free parameter, because moving one without the other opens a gap and the
 * sprite becomes two pieces. Both earlier attempts at a dead cat obeyed that rule literally — they
 * lowered the body's bottom, then raised its top to overlap the skull — and both produced the same
 * picture: a cat standing bolt upright, drawn in one flat value, which read as a BELL or a chess
 * pawn. Rendered at 384x zoom it was unmistakable and it was not a dead cat.
 *
 * The rule was never "nothing may move vertically". It was "the head and the body may not move
 * INDEPENDENTLY". Moving BOTH by the same offset satisfies it exactly: every part keeps its
 * relationship to every other part, the silhouette is identical, and the whole animal is simply
 * lower. That is what a body on the ground is, and it is the one thing the flat fill cannot say on
 * its own.
 *
 * ══ WHY THREE, AND NOT THE SIX IT WAS ══
 *
 * The drop has to buy an empty band at the top WITHOUT pushing the body off the bottom, and those
 * two pull against each other because the body still needs rows to exist in. At six the head ended
 * at row 19 and the body had four rows left before the floor, so the cat was a skull with a stump
 * under it. At three the crown sits at row 4, the top three rows are visibly empty — enough to read
 * as "lower than the others" in a colony — and the body keeps five rows, which is enough to be a
 * body. The empty band is the cue; it does not have to be large to work, only present.
 */
const DEAD_DROP = 3;

/** How many rows every part is displaced by, for a state. Non-zero only for `dead`. */
function stateDrop(state: CatState): number {
  return state === "dead" ? DEAD_DROP : 0;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * HOW FAR THE HEAD SLIDES SIDEWAYS WHEN THE CAT DIES — the fix that finally worked.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Five renders of the dead state produced a BELL, a PAWN and a TOMBSTONE, and every one of the four
 * fixes before this moved a vertical or a width parameter: the body's bottom row, the body's top
 * row, the whole animal's row offset, then the body's haunch width. The empty band arrived, the
 * shoulder pinch arrived, and the sprite still read as a small standing monument.
 *
 * The reason none of it worked is that all four kept the cat VERTICALLY SYMMETRIC about its own
 * axis — a head stacked directly on a body, which is the arrangement of an animal that is sitting
 * up, and no amount of adjusting the two masses' sizes changes what that arrangement means. A living
 * cat on this grid is head-above-body because it is upright. A dead one is not upright, and the
 * thing that says so is that its head is BESIDE its body, resting on the ground.
 *
 * ══ AND IT IS ZERO, WHICH IS THE HONEST OUTCOME OF THE EXPERIMENT ══
 *
 * The slide was implemented, rendered at three magnitudes and looked at. At −4 the widest skulls
 * clipped against the grid edge and lost an eye — a cropping bug, which is the one thing a death
 * state must never resemble. At −3 nothing clipped and the silhouette did become asymmetric, and it
 * STILL did not read as a cat lying down: it read as a cat with its head on crooked. The reason is
 * that sliding the head sideways while the body stays frontal is not a view of a lying animal, it is
 * a frontal animal with a displaced skull, and 24x24 has nowhere near the resolution to carry the
 * foreshortening that would make a genuine side-on pose legible.
 *
 * So the mechanism is kept at zero rather than deleted, and the record kept with it. Six attempts at
 * this state produced a bell, a pawn, a tombstone and a crooked cat; what actually carries `dead` is
 * the combination that is live — the whole animal dropped three rows so it sits low with empty grid
 * above it, a flat single-value coat with no modelling anywhere, dark eyes, dark inner ears and dark
 * folded legs. That reads as "this cat is dead" without ever attempting a pose the grid cannot draw.
 *
 * The lesson is the one worth recording: when six fixes fail, the last question to ask is whether
 * the FEATURE is affordable at this resolution, and the answer here was no. Keeping the parameter at
 * zero costs one branch and stops the next reader re-running the same six experiments.
 *
 * LEFT rather than right, because the tail exits right on every cat: putting the head on the same
 * side would stack the two most distinctive features on one end and leave the other blank.
 *
 * THREE columns and not four: at four, the widest heads reached column −1 and the skull was clipped
 * against the grid edge, which cost one eye and left a stray whisker pixel floating clear of the
 * body — a cropping bug, which is the one thing a death state must never resemble. Three keeps every
 * head inside the grid at every value of `headWidth` while still breaking the symmetry, and the
 * symmetry is what the slide is actually for.
 *
 * ══ THE LESSON, AND IT IS THE SAME ONE THIS FILE KEEPS RECORDING ══
 *
 * Four consecutive fixes that each move a different parameter and produce the same failure mean the
 * failure is STRUCTURAL, and no parameter reachable from the current structure will fix it. The
 * whiskers went through the identical sequence — three length and gap adjustments against what was
 * actually a row-collinearity problem — and it is recorded in `isWhisker` at length. Recognising the
 * pattern the second time took four attempts instead of three, which is not much of an improvement.
 */
const DEAD_SLIDE = 0;

/** How many columns the HEAD (and its ears, muzzle, eyes) slides. Non-zero only for `dead`. */
function stateSlide(state: CatState): number {
  return state === "dead" ? DEAD_SLIDE : 0;
}
/**
 * The Lambert term for one surface normal, run through the ramp and the dither.
 *
 * `shadeSphere` from the mechanism kit does the lighting. Its wrap, rim and core-shadow terms are
 * tuned for a sphere and are all dialled DOWN here, because a 24px cat is not a sphere:
 *
 *   - `wrap` 0.5: high. A flat, frontally-lit subject (see `LIGHT`) needs light to bleed past the
 *     terminator or the shaded half of the head drops straight to the ground value and the
 *     silhouette develops a bite — openhood recorded exactly that failure and fixed it with a step
 *     floor. Wrapping fixes it at the source instead.
 *   - `specularPower` 7: very low, i.e. a broad soft highlight. Fur is chalk. The kit's default of
 *     32 is glass, and a glass highlight on a cat reads as a wet spot.
 *   - `rimPower` 2.6: a wide rim, which is the only way a rim term touches more than a single pixel
 *     at this size and therefore the only way it reads as anything at all.
 *
 * Returns null only when the caller hands it a normal outside the unit disc — which for a part that
 * already claimed the pixel is an INTERIOR HOLE, and the caller fills it rather than dropping it.
 * openhood's recorded reason: dropped holes punch single empty pixels through the face, and once an
 * outline pass exists those holes get outlined and the animal comes out speckled.
 */
function shadeStep(nx: number, ny: number, px: number, py: number): number | null {
  const lum = shadeSphere({
    nx,
    ny,
    light: LIGHT,
    ambient: 0.2,
    wrap: 0.5,
    specularPower: 7,
    rimPower: 2.6,
  });
  if (lum === null) return null;
  return quantise({ value: lum, steps: RAMP_STEPS, x: px, y: py, strength: DITHER });
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * STATE — the exposure half. The GEOMETRY half is in `stateGeometry` and `stateSpread`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ THE DIM IS A GAIN, NOT A SUBTRACTION — and this was a measured bug ══
 *
 * v1's first pass subtracted a flat number of steps per state. Rendered to PNG and looked at, EVERY
 * cat in every state but `fed` was a muddy undifferentiated mass. The dump of the raw step grid
 * showed why immediately: with only six steps, subtracting two and then clamping at 1 crushed steps
 * 1, 2 and 3 all onto 1, so the legs, the haunch and the neck break disappeared at once. The state
 * dim was destroying the SILHOUETTE, which is the one thing §9 says this sprite cannot afford to
 * lose.
 *
 * That is a scale error, not a tuning error: a flat subtraction on a short ramp removes a fixed
 * amount of the total range, and by `starving` there is no range left to carry shape.
 *
 * A GAIN scales toward the noise floor instead, so the RATIOS between parts survive. It is also the
 * physically honest model for the referent: an IR illuminator falling off does not subtract a
 * constant from a scene, it multiplies it.
 *
 * The gains are GENTLER than v1's now, and deliberately so: state carries most of its meaning
 * through the geometry here (a thinner body, forward ears, ribs), so the exposure only has to
 * support that read rather than carry it alone. v1's `starving` at 0.66 was crushing the sprite
 * because the dimming was doing all the work.
 */
const STATE_GAIN: Readonly<Record<CatState, number>> = {
  /** Fed: slightly ABOVE the reference. A well-fed cat's coat has a sheen — see the `fed` floor. */
  fed: 1,
  /**
   * Hunting: a step down at the top of the range.
   *
   * 0.85, not the 0.9 v1 tried first. At 0.9 `Math.round(step * gain)` was the IDENTITY on every
   * value a 6-step ramp could hold, so `fed` and `hunting` rendered as byte-identical cats. A dead
   * axis that looked live in the source, caught only by a total-luminance assertion. On an 8-step
   * ramp there is more room, but the lesson stands and the value is asserted rather than trusted.
   */
  hunting: 0.85,
  /** Starving: three quarters. The thinness carries the state; this supports it. */
  starving: 0.74,
  /** Dead: unused. See `DEAD_STEP` — a dead cat is not a dim cat, it is a flat one. */
  dead: 1,
};

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * DEAD IS A FLAT SILHOUETTE, NOT A FADE — a review finding, not a preference.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `dead` was once a gain of 0.46, on the same model as the other three states. Rendered and
 * reviewed, it "read as a rendering failure rather than a state" — the cat was so close to the
 * ground value that a viewer's first hypothesis was a broken sprite, not a dead animal.
 *
 * That is a serious defect and not a cosmetic one. `DESIGN.md` §2 and `ART-DIRECTION.md` §8 both
 * require losses to be honest and visible. A death that fades toward invisibility is the softening
 * the ban forbids, arriving through rendering instead of through copy. It is also openhood's
 * dormant-creature rule restated: a sprite that fades reads as "still loading", and a fault and a
 * state must never be confusable.
 *
 * ══ THE FIX: COLLAPSE THE RANGE, DO NOT LOWER IT ══
 *
 * Every coat pixel takes ONE value — `DEAD_STEP` — regardless of what the lighting gave it. That
 * makes the cat a flat, evenly-lit shape with a full-contrast outline: unmistakably THERE, and
 * unmistakably not alive, because the one thing every other state has is internal modelling.
 *
 * ══ STEP 2, LOWERED FROM 3 AFTER THE STARVING CAT OVERTOOK IT ══
 *
 * Step 3 was chosen as "three steps above the outline, well below the body's floor". Then the
 * starving state was strengthened — a thinner body and deeper ribs — and its MEAN step fell to about
 * 2.78, below the dead cat's flat 3. So a dead cat was rendering BRIGHTER on average than a starving
 * one, which inverts the one ordering this sprite must never get wrong.
 *
 * That is worth recording as a class of bug rather than as a number: a state defined by an ABSOLUTE
 * value and a state defined by a GAIN will cross each other the moment either is retuned, and
 * nothing in either definition mentions the other. The ordering is asserted over the whole id set in
 * `grid.test.ts` precisely because it cannot be read off the two definitions.
 *
 * Step 2 on an 8-step ramp is still two full steps above the outline at 0, so the silhouette and its
 * edge both read, and it now sits below every living state's mean on every id.
 *
 * ══ AND THE FLAT FILL OVERRIDES RULE 2 ══
 *
 * A dead cat has no neck break, because it has no internal modelling at all. The neck clamp is
 * skipped in this state, which is the one deliberate exemption from a silhouette rule in this file.
 * It is safe precisely because rule 2 exists to stop head and body fusing into an amoeba, and a
 * uniformly flat sprite has already given up internal shape on purpose. The silhouette still reads,
 * because the outline runs at full contrast around the whole animal.
 *
 * REJECTED: drawing the dead cat as an OUTLINE ONLY, hollow. At this size a hollow shape loses the
 * ears entirely and the sprite stops being identifiable as the user's own cat, which is the one
 * thing it must remain.
 */
const DEAD_STEP = 2;

function applyState(step: number, part: Part, state: CatState): number {
  if (part === "outline") return step;
  /*
   * ══ THE FLAT FILL KEEPS THREE MARKS, AND THAT IS WHAT STOPS IT BEING A PAWN ══
   *
   * A render of the full sheet showed every dead cat as a featureless rounded LUMP — the ears, the
   * muzzle and the legs were all present in the geometry and all painted at `DEAD_STEP`, so the
   * silhouette was one uniform mass and the animal was unidentifiable. It read as a chess pawn, not
   * as a dead cat, and "unmistakably THERE and unmistakably not alive" requires the first half too:
   * a viewer has to be able to tell it is a CAT that has died.
   *
   * The flat fill's purpose is to remove the MODELLING — the surface shading that says a form is
   * being lit — and it can do that while keeping the few marks that carry species. So three parts
   * stay distinct:
   *
   *   - THE INNER EAR, darker. Two dark wedges above the skull is the strongest "cat" cue the
   *     silhouette has, and without it the ears merged into the head and the outline alone had to
   *     carry them, which at 24px it cannot.
   *   - THE EYES, darker still (handled below). Two dark holes in a flat shape is the "gone" signal.
   *   - THE LEGS, darker. Folded under a lying animal, they read as the shadow beneath it.
   *
   * Everything else — head, body, muzzle, tail, paws — takes the one flat value. That is still a
   * flat silhouette by any reasonable reading: there is no gradient anywhere on it, and no part is
   * shaded. It is a flat shape with three marks, which is what a stencil is.
   */
  if (state === "dead") {
    if (part === "earInner") return 1;
    /*
     * The folded legs sit at 1, not 2. They were at 2 while `DEAD_STEP` was 3; once the flat coat
     * dropped to 2 to stay below the starving cat's mean, the legs were the SAME value as the coat
     * and stopped being a mark at all — the exemption existed in the source and did nothing on
     * screen. A mark defined relative to a value that moved has to move with it, so both the leg and
     * the inner ear now sit one clear step below whatever `DEAD_STEP` is.
     */
    if (part === "leg" || part === "paw") return Math.max(1, DEAD_STEP - 1);
  }
  /*
   * THE EYES ARE EXEMPT FROM THE DIMMING, except when dead.
   *
   * A starving cat's eyes still catch the illuminator — eyeshine is a reflection, not a metabolic
   * process. Dimming them with the coat loses the sprite's focal point exactly when the state most
   * needs reading. A DEAD cat's eyes are dropped hard: a corpse's tapetum does not shine, and this
   * is the single clearest state read on the sprite. They go BELOW the flat coat, so they read as
   * dark holes in a flat shape — the strongest "gone" signal available in one hue.
   */
  if (part === "eye") {
    if (state === "dead") return 1;
    return step;
  }
  if (state === "dead") return DEAD_STEP;
  /*
   * ══ THE GAIN IS ORDER-PRESERVING, AND THAT IS WHAT KEEPS THE SILHOUETTE RULES INTACT ══
   *
   * `Math.round(step * gain)` is NOT injective on a short ramp: at 0.78 both 1 and 2 map to 1.
   * Anywhere it collapsed two adjacent steps onto one it erased a break a silhouette rule had just
   * established — v1's tests found `stray-1` losing its NECK (rule 2) and its LEG separation (rule
   * 3) in the `hunting` state alone, on a cat whose geometry was correct. The state was quietly
   * undoing the rules.
   *
   * That is the deeper version of the mistake this file made twice (a flat subtraction crushing the
   * range, a 0.9 gain doing nothing): the exposure must not be able to destroy information the
   * geometry encoded. So the mapping is a strictly increasing rescale rather than a round-and-clamp.
   */
  const gain = STATE_GAIN[state] ?? 1;
  if (gain >= 1) return step;
  const top = RAMP_STEPS - 1;
  const scaled = 1 + ((step - 1) * (Math.round(top * gain) - 1)) / (top - 1);
  return Math.max(1, Math.min(top, Math.round(scaled)));
}



/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE COAT PATTERN IN PROFILE — and it finally sits along the animal rather than across it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Head-on, the tabby bands were HORIZONTAL rows across the body, and the file recorded two
 * corrections to stop them reading as louvres cut through the cat. That was always a compromise: a
 * real tabby's mackerel stripes run VERTICALLY down the flank, perpendicular to the spine, and
 * head-on there was no spine to be perpendicular to.
 *
 * In profile the stripes run the way they actually do — down from the back line toward the belly,
 * spaced along the barrel's length. That reads as a tabby at a glance rather than as a shaded
 * cylinder with bands on it, and it needs no inset correction because a vertical stripe on a
 * horizontal animal never spans the silhouette edge-to-edge.
 *
 * Returns how many ramp steps to subtract. TWO, never one: one step is inside the Bayer dither's own
 * range and is indistinguishable from the noise the shading already produces.
 */
function profileCoatDrop(coat: Coat, px: number, py: number, prof: ProfileGeometry): number {
  switch (coat) {
    /*
     * MACKEREL STRIPES — vertical bars down the flank, every third column.
     *
     * Every THIRD rather than every other: at 24px a stripe every second column leaves one lit
     * column between two dark ones, which after the dither reads as a texture rather than as
     * stripes. Every third gives a 1-dark 2-lit rhythm that survives being shrunk to 16px.
     *
     * Inset from the back line so the spine stays lit — a tabby's stripes hang OFF the dorsal line,
     * they do not cross it, and leaving the topmost row lit is what keeps the back line reading as
     * the silhouette's edge.
     */
    case "tabby": {
      if ((px - Math.round(prof.headX)) % 3 !== 0) return 0;
      return py <= prof.backRow + 0.9 ? 0 : 2;
    }
    /*
     * PATCHED — one block over the shoulder and chest, which is where a bicolour stray's white
     * blaze actually sits. Deliberately ASYMMETRIC along the body's length; the whole value of this
     * axis is that it reads as a MARKING rather than as a light effect.
     */
    case "patched":
      return px < prof.headX + prof.headR + 3.5 && py > prof.backRow + 1.5 ? 2 : 0;
    /*
     * TORTIE — a deterministic mottle, `fnv1a` on the coordinate rather than `Math.random`, so it is
     * stable across renders and the ban holds. The cell is 1x2 so the mottle sits at a different
     * spatial frequency from the Bayer dither underneath it; at 1x1 the two were indistinguishable.
     */
    case "tortie": {
      const h = fnv1a(`tortie:${px}:${py >> 1}`);
      return h % 100 < 42 ? 2 : 0;
    }
    default:
      return 0;
  }
}

/**
 * ══ THE RIBS — how a starving cat is drawn starving, and in profile they are RIBS ══
 *
 * `ART-DIRECTION.md` §8: "a starving cat is drawn starving. The mechanic is honest about losses or
 * it is a lie with whiskers on it."
 *
 * Head-on this was two horizontal bands across the chest, which is not what a rib looks like from
 * any angle — it was the only mark the pose allowed. In profile the ribs are short VERTICAL strokes
 * on the ribcage, angled back the way a real ribcage is, sitting between the shoulder and the tucked
 * flank. Combined with the shallower barrel and the drawn-up belly line, a starving cat now reads as
 * starving from its outline alone, before any of the internal marks are seen.
 *
 * THREE steps, deeper than the tabby's two, so a rib is legible on a cat that is ALREADY tabby.
 */
function profileRibDrop(px: number, py: number, prof: ProfileGeometry): number {
  const start = prof.headX + prof.headR + 1.2;
  const rib = px - Math.round(start);
  if (rib < 0 || rib > 5 || rib % 2 !== 0) return 0;
  // Only on the upper half of the barrel: ribs sit high on the flank, and carried down to the belly
  // they read as stripes rather than as a ribcage.
  return py > prof.backRow + 1.2 && py < prof.backRow + prof.depth * 0.72 ? 3 : 0;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PROFILE GEOMETRY — the identity axes, resolved into a side-on skeleton.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `geometryFor` returns the cat's IDENTITY — the hash-derived axes that make one stray different
 * from another. This turns those axes, plus the posture, the state and the animation frame, into the
 * concrete profile skeleton `profile.ts` draws from.
 *
 * The split matters: identity is stable forever (a cat's ears and coat are its own), while the
 * skeleton changes with what the animal is doing. Keeping them apart is what lets `state` reach the
 * geometry — a starving cat is genuinely thinner — without state ever leaking into identity.
 *
 * ══ WHAT EACH POSTURE DOES IN PROFILE, AND WHY IT READS BETTER THAN IT DID HEAD-ON ══
 *
 * Head-on, posture could only change the body's WIDTH and which rows it occupied, because every
 * other axis was hidden behind the animal. All four postures came out as variations on "wider" or
 * "narrower", which is why a reviewer called twelve cats "effectively the same".
 *
 * In profile each posture changes the relationship between the back line, the ground and the legs,
 * which is what posture actually is:
 *
 *   SIT     — haunches down, front legs straight, chest up and back sloping down to the croup.
 *   STAND   — all four legs extended, back level, belly clear of the ground.
 *   CROUCH  — back line dropped toward the ground, legs folded, the whole animal compressed.
 *   STRETCH — the play bow: front end down, croup UP, spine arched. Unmistakable, and completely
 *             undrawable head-on.
 */
function profileGeometryFor(
  geom: CatGeometry,
  state: CatState,
  frame: number,
): ProfileGeometry {
  const lying = state === "dead";

  /*
   * THE BACK ROW — where the spine sits. Posture's primary lever, because in profile the height of
   * the back line off the ground IS the posture.
   */
  const backByPosture: Readonly<Record<Posture, number>> = {
    stand: PROFILE_ROWS.body[0],
    sit: PROFILE_ROWS.body[0] + 1,
    crouch: PROFILE_ROWS.body[0] + 2.6,
    stretch: PROFILE_ROWS.body[0] + 0.6,
  };
  const backRow = lying ? PROFILE_ROWS.body[0] + 5.4 : (backByPosture[geom.posture] ?? PROFILE_ROWS.body[0] + 1);

  /*
   * THE BARREL'S LENGTH. `build` lengthens a stocky cat and shortens a lean one, and `stretch`
   * extends it further — a stretching cat is visibly longer, which is the pose's own strongest cue
   * after the arched spine.
   *
   * A LYING cat is longest of all: an animal on its side presents its full length to the viewer
   * where a sitting one foreshortens it.
   */
  /*
   * ══ 8.4, SHORTENED SO THE TAIL HAS COLUMNS TO SWEEP INTO ══
   *
   * At 9.4 the barrel's rump reached column 20 on a 24-wide grid, so the tail rooted at 21 and had
   * two columns before the edge — `0xf00d` came out with a tail clipped flat against the boundary
   * and the flick frame moved it ZERO cells, which the frame assertion caught. That is the same
   * crowding failure the head-on version recorded when its haunch grew to fill the wider grid.
   *
   * The tail is half the silhouette budget and it is the part a person names a cat by, so it gets
   * the columns. A shorter barrel is also the more cat-like proportion: the length that reads as
   * "long" on a quadruped is mostly the TAIL, and spending grid on the body to get it was the wrong
   * trade twice over.
   */
  const bodyLen =
    8.4 +
    geom.build * 1.1 +
    (geom.posture === "stretch" ? 1.8 : 0) +
    (geom.posture === "crouch" ? 0.8 : 0) +
    (lying ? 2.4 : 0);

  /*
   * THE BARREL'S DEPTH — back to belly. This is where `fed` and `starving` land, and in profile it
   * is a completely different statement from the head-on version's "narrower": a fed cat is DEEP
   * through the barrel and a starving one is SHALLOW, which is what a thin animal actually looks
   * like from the side.
   */
  /*
   * ══ THE DEPTH IS FLOORED, BECAUSE THE AXES ARE ADDITIVE AND CAN CANCEL ══
   *
   * `build`, the state and the posture all move the barrel's depth and they simply sum, so a lean
   * cat (`stray-2`, build −0.91) that is also starving landed at about three rows of barrel — a
   * strip rather than a body, with the legs reduced to stubs hanging off it. That is the same
   * additive-clamp defect the head-on version hit twice, and the fix is the same: floor the result
   * rather than narrowing every contributing range.
   *
   * The floor is `HIP_SAFE_DEPTH` rather than a bare number, because the hip rise LIFTS the back
   * line by up to `HIP_RISE` rows over the croup while the belly stays put — so a barrel at the old
   * floor of 5 was reduced to under 4 rows at the hip and the body fragmented into disconnected
   * pieces there. A floor that does not account for what is subtracted from it is not a floor.
   *
   * SIX rows. Below that the barrel cannot carry the tabby stripes, the ribs or the
   * shading gradient that makes it read as a cylinder, so it stops being a body and becomes a line.
   *
   * The base rose from 5.8 alongside the leg shortening — a cat is low because its legs are short
   * AND because its chest is deep, and shortening the legs alone produces a small dog. But 7.0
   * overshot: at eleven rasterised rows the barrel took nearly half the grid's height and the head
   * came out visually tiny beside it, which reads as a piglet. 6.2 keeps the deep chest while
   * leaving the head a legible fraction of the animal.
   */
  const depth = Math.max(
    HIP_SAFE_DEPTH,
    6.6 +
      geom.build * 0.7 +
      /*
       * The state's pull on the barrel's depth is the LARGEST single contributor, because in profile
       * "fed" and "starving" are read from the chest's depth and the belly's tuck — not from width,
       * which is what the head-on version could only offer. Widened from ±1.0 after the hip-safe
       * depth floor began clamping the two states onto the same value on lean cats.
       */
      (state === "fed" ? 1.4 : 0) +
      (state === "starving" ? -1.8 : 0) +
      (geom.posture === "crouch" ? 0.5 : 0),
  );

  /*
   * ══ THE TUCK — the sunken flank, and the reason `starving` is legible at last ══
   *
   * Head-on, a starving cat could only be narrower, and a reviewer called that row "muddy" because
   * narrower is not a thing a viewer reads as hungry. In profile the flank is drawn UP toward the
   * spine behind the ribcage, which is the single most recognisable sign of a starving animal and
   * costs about six pixels.
   */
  const tuck = state === "starving" ? 2.3 : state === "fed" ? 0 : 0.7;

  /*
   * THE ARCH. A stretching cat's spine curves upward over the croup; a frightened or hunting one
   * flattens. Only `stretch` uses much of it — an arch on a sitting cat reads as a hunch.
   */
  const arch = geom.posture === "stretch" ? 0.85 : 0;

  /*
   * THE GROUND ROW. Where the paws stand. A crouched cat's ground is closer to its back; a standing
   * cat's is further. A LYING cat has no standing legs at all — the ground row sits just under the
   * barrel, so the folded legs read as a shadow beneath the mass.
   */
  /*
   * THE GROUND ROW — where the paws stand.
   *
   * Derived from the BELLY rather than from a fixed row: the first draft used `PROFILE_ROWS.legs[1]`
   * and a crouched cat whose barrel sat high ended up with legs six rows long, which read as a
   * spider. A leg's length is the distance from the belly to the ground, so tying the ground to a
   * constant while the belly moves with posture makes the leg length a residual of two unrelated
   * numbers.
   *
   * `legLen` is the leg's own length and posture varies IT, which is what posture actually changes:
   * a standing cat's legs are extended, a crouching cat's are folded to almost nothing.
   */
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════
   * ══ A CAT IS LOW SLUNG — and getting this wrong made twelve cats read as DEER ══
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The first profile draft used 4.2 rows of leg on a barrel 7 rows deep — a leg-to-depth ratio of
   * 1:1, which is a canid or an ungulate proportion, and a review of the render said so in as many
   * words: "they read as DOGS or small DEER, not cats". Rendered at 96px the legs were about a third
   * of the sprite's total height and ran straight down, which is a deer's stance exactly.
   *
   * The cause was copying NEEDLE's proportions along with its method. NEEDLE is a UNICORN in
   * profile, so its leg-to-barrel ratio is equine by construction — the method transfers and the
   * proportions emphatically do not. That distinction is stated in this package's own header about
   * openhood's artwork and I applied it to the colour and not to the skeleton.
   *
   * A cat is LOW: its belly sits close to the ground and its legs are roughly HALF its barrel's
   * depth, where a dog's are equal to it and a deer's are greater. `PROPORTIONS.legToDepth` asserts
   * the ratio stays under 0.75 so a later edit cannot walk it back toward a dog one row at a time.
   */
  const legLen =
    geom.posture === "stand" ? 2.0 : geom.posture === "stretch" ? 1.6 : geom.posture === "sit" ? 1.2 : 0.8;
  const groundRow = lying
    ? backRow + depth + 1.2
    : Math.min(GRID_H - 1.5, backRow + depth + legLen);

  /*
   * THE HEAD. Sits forward of the chest and above it, on a neck the silhouette implies rather than
   * draws — the notch between the skull's back edge and the withers IS the neck, and in profile it
   * is a shape rather than the value break rule 2 had to manufacture head-on.
   *
   * A crouched or hunting cat carries its head LOW and forward — the stalking posture — which is a
   * far stronger state read than the head-on version's forced ear angle.
   */
  /*
   * ══ THE SKULL SITS ABOVE AND FORWARD OF THE CHEST, NOT INSIDE THE BARREL ══
   *
   * The first profile draft placed the head at `backRow + 0.4`, which put its centre level with the
   * spine — so the skull's lower half sat INSIDE the barrel and the two masses fused into one lump
   * with an eye in it. A step-grid dump showed head and body cells interleaved across six rows.
   *
   * A cat's skull in profile sits ABOVE the line of the back and FORWARD of the chest, joined by a
   * neck that the silhouette implies. `headY` is therefore measured UP from the back line, and the
   * skull's own radius keeps its bottom edge near the withers rather than below them — which is what
   * leaves the notch between skull and shoulder that reads as a neck.
   */
  /*
   * ══ THE SKULL IS SMALL, BECAUSE THE BARREL IS THE SUBJECT IN PROFILE ══
   *
   * 2.2 base, down from 2.9. Head-on, the head WAS the sprite — it carried the eyes, the ears and
   * the muzzle, and the body was a plinth for it, so a large skull was correct there. In profile the
   * subject is the whole animal and the barrel is its largest mass; a skull sized for a portrait
   * makes the cat read as a kitten or as a bobblehead, and rendered at 384x zoom the first profile
   * draft looked like a foal.
   *
   * NEEDLE is the calibration: its skull is about 4 cells across on a barrel 11 long — roughly 1:3.
   * At 2.2 radius the skull is ~4.5 cells against a barrel of ~9, which lands in the same band. The
   * `headWidth` identity axis still moves it, just over a smaller range.
   */
  /*
   * ══ 1.8, LOWERED AGAIN — a cat's skull is SHORT and ROUND ══
   *
   * A review of the profile render found the heads reading as canid: "the head is too large and too
   * long... several of these have a muzzle long enough to read as a dog". At 2.2 radius the skull
   * spanned about five columns and the muzzle projected three more, so the face was eight columns
   * on a barrel of fourteen — a snout, and a snout on a quadruped is a dog every time.
   *
   * A cat's skull in profile is SHORT front-to-back and nearly circular, with a muzzle that barely
   * projects past it. At 1.8 the skull is under four columns, which reads as the compact round head
   * a cat has, and it leaves the ears — which are the same size as before — proportionally much
   * larger, which is itself a strong cat cue. Shrinking the head made the ears bigger for free.
   */
  /*
   * ══ 2.1, BETWEEN THE SNOUTED DOG AND THE PINHEAD ══
   *
   * 2.2 read as canid; 1.8 overcorrected and left a skull of FOUR cells, which the neck-notch and
   * back-line assertions caught immediately — a head that small is a knob on the end of the barrel
   * and the animal loses its face entirely.
   *
   * The head is not what makes a cat read as a cat in profile; the LOW STANCE, the HIGH HAUNCH and
   * the EARS are. So the skull only has to be small enough not to read as a dog's, and 2.1 clears
   * that while keeping a five-cell skull with room for an eye and a jaw. What actually fixed the dog
   * read was the MUZZLE — shrinking its projection from three columns to one — and that is where the
   * budget was better spent.
   */
  /*
   * FLOORED at 2.3 as well as scaled. `headWidth` runs 4.0..5.2, so the smallest skull was 2.46 —
   * which after rasterisation is six cells including the muzzle, and the neck-notch assertion wants
   * more than six before it will call it a head. A skull that small stops having room for the eye
   * and the jaw to be separate features.
   */
  /*
   * ══ 2.8, RAISED BACK — the DOG read came from the MUZZLE, not from the skull's size ══
   *
   * The skull was cut from 2.9 to 2.2 and then to 1.8 chasing a review note that the head was "too
   * large and too long". Rendered at 28x zoom on the head alone, the small skulls were plainly
   * worse: a five-column head cannot carry two ears, an eye and a jaw, so the ears came out as
   * thin spikes and the face lost its mass entirely. Twice the fix made the sprite worse and the
   * assertions caught it (`no head at all`, at six cells).
   *
   * Re-reading the note, it named two things — "too large AND too long" — and only the second was
   * doing the damage. What made these read as canid was the MUZZLE projecting three columns past
   * the skull, which is a snout; that is fixed independently in `MUZZLE` and stays fixed. A round
   * skull with a one-column muzzle bump reads as a cat at any reasonable size, and 2.8 is what
   * gives the ears something to rise from.
   *
   * The general lesson: when a review names two causes, change them one at a time. Changing both
   * and rendering once cannot tell you which one mattered, and here the innocent one was doing all
   * the visible harm.
   */
  const headR = Math.max(2.7, 2.5 + geom.headWidth * 0.09);
  const headLow =
    (geom.posture === "crouch" ? 1.9 : 0) + (geom.posture === "stretch" ? 1.5 : 0);
  const headX = NOSE_X_OFFSET + headR;
  const headY = backRow - headR * 0.62 + headLow + (lying ? headR * 0.9 : 0);

  return {
    backRow,
    bodyLen,
    depth,
    tuck,
    arch,
    groundRow,
    headX,
    headY,
    headR,
    earHeight: geom.earHeight,
    earWidth: geom.earWidth,
    /*
     * A HUNTING cat pins its ears forward and a DEAD one lets them fall flat. Both are forced rather
     * than nudged, because a state has to read on every cat regardless of what its own hash gave it
     * — a bias a hash could cancel is not a state.
     */
    earAngle: lying ? -0.9 : state === "hunting" ? Math.max(0.5, geom.earAngle) : geom.earAngle,
    tailCurl: geom.tailCurl,
    tailLift: geom.tailLift,
    eyeShape: geom.eyeShape,
    whiskerLen: geom.whiskerLen,
    // A sitting, crouching, stretching or lying cat has its front legs folded; only a standing one
    // has them extended to the ground.
    frontTucked: lying || geom.posture === "crouch",
    lying,
    sitting: !lying && geom.posture === "sit",
  };
}

/**
 * The muzzle's front edge, in columns. The animal faces LEFT, so this is its leading edge.
 *
 * 2.2, moved forward from 3.4 to buy the TAIL three more columns at the other end. The cat is not
 * centred in the grid and should not be: it faces left, so the space it needs is BEHIND it, where
 * the tail sweeps. Centring the animal left the tail clipped against the right edge on high-curl
 * cats, and the flick frame had nowhere to move — a whole animation axis dead because of a layout
 * constant.
 */
const NOSE_X_OFFSET = 2.2;

/**
 * THE GRID — every filled pixel of a cat, as ramp indices.
 *
 * Pure and deterministic. Returns indices rather than colours so the caller owns the palette, which
 * is what lets the same grid serve a lit cat on the map, a portrait in a panel, and a forced-colours
 * fallback without this function knowing about any of them.
 */
export function catGrid(
  id: string,
  opts?: { readonly state?: CatState; readonly frame?: number },
): GridPixel[] {
  const state = opts?.state ?? "hunting";
  const frame = ((opts?.frame ?? 0) % CAT_FRAMES + CAT_FRAMES) % CAT_FRAMES;
  // Identity -> state override -> animation frame. The order matters: state may force a posture
  // (hunting crouches), and the frame then perturbs whatever that produced. Reversing them would
  // let a frame's tail flick be overwritten by the state, so frame 1 would be a no-op in `hunting`.
  const geom = frameGeometry(stateGeometry(geometryFor(id), state), state === "dead" ? 0 : frame);
  // The identity axes, resolved into a side-on skeleton for this posture, state and frame.
  const prof = profileGeometryFor(geom, state, frame);
  const tail = profileTailCells(prof);
  const out: GridPixel[] = [];
  /** Which cells the cat occupies, so the outline pass can find its edge. */
  const filled = new Set<number>();
  /** Whiskers are excluded from the outline seed — see `isWhisker`. */
  const outlineSeed = new Set<number>();

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const hit = profilePartAt(x, y, prof, tail, frame, CAT_FRAMES);
      if (!hit) continue;

      const key = y * GRID_W + x;

      // A MARK, not a surface: the eye, the nose and the whisker carry their own step and skip the
      // diffuse model entirely.
      if (hit.step !== undefined) {
        const step = applyState(hit.step, hit.part, state);
        out.push({
          x,
          y,
          step,
          part: hit.part,
          /*
           * ══ THE ONE OR TWO TINTED PIXELS — exactly two, and this was a caught violation ══
           *
           * §8 permits state to tint "one or two pixels". v1 flagged EVERY eye pixel, and once the
           * eye masks all became 2px wide that was FOUR — a direct breach, introduced by a change to
           * an unrelated part. The comment there even asserted the old invariant and went stale
           * silently. The test caught it; the comment did not.
           *
           * Exactly ONE pixel per eye is flagged — the INNER one on the top row, nearest the nose
           * bridge. Inner rather than outer because the bridge beside it is forced dark, so the tint
           * lands against the strongest local contrast and reads at 32px, where the outer pixel sits
           * against the lit cheek and muddies.
           *
           * That this is a hard count and not a rule of thumb is the point: the ban is on the NUMBER
           * of event-hued pixels, so the code has to count them, and `grid.test.ts` asserts the
           * count rather than the intent.
           */
          ...(hit.part === "eye" &&
          y === EYE_Y + stateDrop(state) &&
          (x === EYE_L_X + stateSlide(state) + EYE_W - 1 ||
            x === EYE_R_X + stateSlide(state))
            ? { accent: true }
            : {}),
        });
        filled.add(key);
        if (hit.part !== "whisker") outlineSeed.add(key);
        continue;
      }

      // An interior hole takes a dark coat step rather than being dropped. The part claimed the
      // pixel; the pixel gets painted. (openhood's speckled-cheeks bug.)
      let step = shadeStep(hit.nx, hit.ny, x, y) ?? 2;

      /*
       * ══ RULE 2 — THE NECK. The single most important line in this function. ══
       *
       * The body's top row is forced `NECK_STEP_DROP` steps below the head's bottom row. Not "shaded
       * a bit darker by the lighting" — FORCED, and clamped so the dither cannot climb back over it.
       *
       * Without it the head's lower edge and the body's upper edge are adjacent surfaces at nearly
       * the same angle, so they land on the same ramp step and the two masses fuse. That is
       * unitick's amoeba, verbatim: "head and body were one mass... the silhouette was an amoeba."
       *
       * ══ THE BREAK IS MEASURED AGAINST THE HEAD, NOT SUBTRACTED FROM THE BODY ══
       *
       * v1 wrote `step - NECK_STEP_DROP` and the test found `stray-1` with a one-step break.
       * Subtracting from the BODY says nothing about the HEAD: where the head's floor left it at 3
       * and the body beneath at 3, subtracting two gave 1 — but where the body was already 2,
       * subtracting two clamped at 1 and the difference was only 2; and where the head was 3 and the
       * body 4, the result was 2 and the break was 1. The size of the break depended on a value the
       * expression never looked at.
       *
       * Rule 2 is a statement about the DIFFERENCE between two rows, so the code has to compute that
       * difference.
       */
      /*
       * ══ RULE 2 IN PROFILE — THE NECK IS A SHAPE, NOT A VALUE BREAK ══
       *
       * Head-on, the head sat directly on top of the body and the two masses could only be separated
       * by forcing the body's first row two ramp steps darker than the head above it. That clamp had
       * three separate bugs over its life, all of the same shape: the break being computed somewhere
       * the final value was not yet known.
       *
       * In profile the neck is a NOTCH in the silhouette — the gap between the skull's back edge and
       * the withers — so the separation is carried by the shape itself and needs no clamp at all.
       * `NECK_STEP_DROP` survives as the shading of the throat, which is the one place the head and
       * the body still meet: the cells under the jaw are pushed down so the chest reads as being
       * behind the head rather than continuous with it.
       *
       * That is the fourth defect the pose change dissolved rather than fixed. A rule that needed
       * three bug fixes head-on needs none here, because the geometry now states what the rule was
       * trying to say.
       */
      if (hit.part === "body" && x < prof.headX + prof.headR && y < prof.headY + prof.headR) {
        step = Math.max(1, step - NECK_STEP_DROP);
      }
      /*
       * ══ THE FLOORS — measured by rendering to PNG and looking, per openhood's method ══
       *
       * The head and muzzle are the SUBJECT and are floored so they always sit in the lit half of
       * the ramp. Without a floor the diffuse model put large areas of the face at the bottom of the
       * ramp, which against the ground colour means the shaded side of the head vanishes and the
       * silhouette reads as a bite out of the animal. openhood recorded this defect; it reproduced
       * here on the first render and was fixed the same way.
       *
       * At 8 steps the floor can be 4 (openhood's was 3 of 7), which leaves THREE steps of headroom
       * above it for the lighting to model with — where v1's 6-step ramp left only two. That extra
       * step is most of why these faces have a modelled brow and cheek and v1's did not.
       */
      /*
       * ══ THE FLOOR IS 3, NOT 4 — lowered after the face rendered as a pale wash ══
       *
       * At 4 on an 8-step ramp the head could only ever occupy steps 4-7, and the muzzle floor,
       * the ear floor and the eyeshine were all crowded into the same top band. Rendered at 384x
       * zoom the whole face was one pale mass with the eyes barely separable from the cheeks — the
       * face had no DARK to model against, so every feature that was supposed to read by contrast
       * read by nothing.
       *
       * A floor exists to stop the shaded side of the head vanishing into the ground, and step 3 on
       * an 8-step ramp already clears the ground and the outline comfortably — it is the same
       * position in the ramp that openhood's floor of 3 occupies on its 7-step ramp. Raising it to 4
       * bought nothing and cost the face its entire lower range.
       *
       * The cost of the extra step is tonal range on the shadow side and the purchase is a face
       * whose features separate, which is the correct trade at 24px: a face legible in a narrow band
       * beats a face beautifully lit and unreadable.
       */
      if (hit.part === "head" || hit.part === "muzzle") step = Math.max(3, step);
      /*
       * ══ THE MUZZLE IS FLOORED ABOVE THE CHEEK — the fix for a flat lower face ══
       *
       * The muzzle is a forward-facing form catching more light than the cheek beside it, and the
       * normal bias alone did not carry that at 24px: the two landed on the same step often enough
       * that the lower face read as one flat mass with a nose floating in it. Floored one step above
       * the head's own floor, the whisker pads separate from the cheeks and the face gets its third
       * plane.
       */
      if (hit.part === "muzzle") step = Math.max(4, step);
      /*
       * ══ THE NOSE BRIDGE IS FORCED DARK — the fix for a VISOR ══
       *
       * Measured at 96px: with the head floored and the eyes at the top of the ramp, the two eyes
       * and the bridge between them rendered as ONE horizontal bar. In the tinted states this was
       * worst of all — a single amber rectangle across the face, which reads as a visor or a mask,
       * not as a pair of eyes. It is the identical failure the whiskers had as a symmetric pair ("a
       * rod through the skull"), arriving through value instead of through geometry.
       *
       * Two eyes only read as two if something separates them. The bridge is pushed below the head's
       * floor so a dark notch runs between them. This is the one place the face floor is
       * deliberately violated, and the violation is what makes the face legible.
       *
       * Scoped to the EYE ROWS only. Carrying it down the whole face drew a dark stripe from the
       * brow to the chin, which read as a split muzzle.
       */
      const drop = stateDrop(state);
      if (hit.part === "head" && y >= EYE_Y + drop && y < EYE_Y + EYE_H + drop) {
        const dx = Math.abs(x + 0.5 - CX - stateSlide(state));
        if (dx < (EYE_R_X - EYE_L_X - EYE_W) / 2 + 0.5) step = Math.max(2, step - 3);
      }
      /*
       * ══ THE BROW — a darker band above the eyes, which 16px could not afford ══
       *
       * A cat's skull has a shallow stop and a pronounced brow ridge, and without it a head is a
       * dome with eyes stuck on. One row above the eye band, dropped a step, gives the face its
       * uppermost plane — so the head reads brow / eye / cheek / muzzle rather than as one surface.
       *
       * It is a DROP rather than a floor, so it modulates whatever the lighting gave it and the brow
       * still turns with the light across its width.
       */
      /*
       * ══ THE BROW IS INSET FROM THE HEAD'S EDGES — the fix for a VISOR BAR ══
       *
       * Applied to the whole row, the brow drop ran from one edge of the skull to the other and read
       * as a dark BAND across the forehead — a visor, or a frown, and on the tabby cats it lined up
       * with the body's own bands and made the cat look slatted. It is the same failure the tabby
       * bands had and the same fix: a dark line that crosses a shape edge-to-edge reads as a gap in
       * the shape rather than as a mark on it.
       *
       * Scoped to the columns ABOVE THE EYES only — the brow ridge is over the sockets and the
       * temples beside it are not — so the drop lands as two short marks rather than as one bar, and
       * the skull's outline stays continuous on both sides.
       */
      if (hit.part === "head" && y === EYE_Y - 1 + drop) {
        const dx = Math.abs(x + 0.5 - CX - stateSlide(state));
        const inner = (EYE_R_X - EYE_L_X - EYE_W) / 2;
        if (dx > inner && dx < inner + EYE_W + 1) step = Math.max(3, step - 1);
      }
      /*
       * ══ THE EARS ARE FLOORED HIGHER THAN THE FACE, for the horn's old reason ══
       *
       * The ear is the identifying feature and it is the smallest, most fragile thing on the cat.
       * Floored at the same step as the face, its shaded side comes out the same value as the head
       * behind it and the ear disappears into the skull; the sprite reads as a round-headed animal,
       * which is a cub or an owl. Floored above, the ear is among the brightest things on the cat,
       * which is the correct hierarchy: on a cat the ears are the first read.
       */
      /*
       * ══ THE EAR IS THE BRIGHTEST THING ON THE CAT AFTER THE EYESHINE ══
       *
       * Floored at 6, raised from 5. A review of the profile render found the ears "absorbed into
       * the head mass" — and the dump showed why: the ear floored at 5 and the skull beneath it
       * floored at 4-5, so the two were within one ramp step and the dither closed the gap. The ears
       * were geometrically correct, well-shaped triangles that were tonally INVISIBLE.
       *
       * At 24px an ear is the single most identifying feature a cat's silhouette has, and it only
       * works if it BREAKS the skull's outline — which needs a value break as well as a shape. Two
       * clear steps above the face puts the ear in the lit band with the eyeshine, which is the
       * correct hierarchy: on a cat you read the ears and the eyes first.
       */
      /*
       * ══ THE EAR IS LIT, BUT NOT FLAT — a uniformly bright ear reads as a RABBIT ══
       *
       * Floored at 6 with no shading, both ears came out as solid bright bars standing upright over
       * the skull, and a review of the colony said so: they read as a rabbit's ears rather than a
       * cat's. The floor was doing its job — the ear must break the skull's outline in value as well
       * as in shape — and it was doing it too well, flattening the whole triangle to one step.
       *
       * `Math.min` with the shaded value keeps the lighting's own variation across the ear's width
       * while the floor keeps it clear of the face: the outer edge stays at 6 and the surface turning
       * away drops to 5, so the triangle has an interior. That plus the dark inner cone gives an ear
       * three values across four columns, which is what makes it read as a cone rather than a bar.
       */
      if (hit.part === "ear") step = Math.max(5, Math.min(6, step));
      /*
       * ══ THE INNER EAR IS ITS OWN STEP, and this is the v2 detail that most changes the face ══
       *
       * Two steps below the outer ear's floor rather than a shading bias. That gap is what makes the
       * ear read as a CONE OPEN TOWARD THE VIEWER: a bright rim of cartilage with a shadowed hollow
       * inside it. v1 shaded this through the normal and the wedge landed within one step of the
       * rim, which the dither then erased about half the time.
       *
       * Floored at 2 so it stays clear of the outline's 0 — an inner ear that reaches the outline's
       * value reads as a HOLE through the ear rather than as a hollow in it, which at 24px is the
       * difference between a cat and a cat with a bite taken out of its ear.
       */
      /*
       * The inner cone sits at 2 — FOUR steps below the ear's own rim rather than the two it had.
       * That gap is what makes an ear read as a cone open toward the viewer instead of as a flat
       * triangle, and widening it was free once the rim moved up: the rim and the hollow now occupy
       * opposite ends of the ramp, so the dither cannot merge them at any ramp position.
       *
       * Floored at 2 rather than 1 so it stays clear of the outline's 0 — an inner ear that reaches
       * the outline's value reads as a HOLE punched through the ear rather than as a hollow in it.
       */
      if (hit.part === "earInner") step = 2;
      /*
       * ══ THE BODY IS FLOORED, NOT DROPPED — measured, and the fix for a dark blob ══
       *
       * v1's first pass took the body a step BELOW whatever the lighting gave it, on openhood's
       * logic that the head should stay the subject. Dumped as raw steps, the whole body was landing
       * at the bottom of the ramp — against an outline at 0 and a near-black ground, that is
       * invisible. The cat rendered as a bright head floating over a dark smudge, which is the
       * "lollipop" failure `bodyNormal` already rejected once and had reintroduced through the
       * shading.
       *
       * The head is kept as the subject by the NECK break and by the ear floor being higher, not by
       * making the body dark. Hierarchy by CONTRAST at the boundary rather than by drowning the
       * larger part.
       *
       * The `-1` on the lower half is what remains of the original intent: the haunch is slightly
       * darker than the chest, which reads as the body turning away underneath. That survives
       * because it is a relative difference INSIDE the body's own floored range.
       */
      if (hit.part === "body") {
        const lower = y >= prof.backRow + prof.depth * 0.55;
        // A FED cat is glossy: its lit band reaches a step higher, which is a sheen on the fur
        // rather than a brighter cat. This is `state affects the animal` in the exposure as well as
        // in the geometry.
        const gloss = state === "fed" ? 1 : 0;
        step = Math.max((lower ? 3 : 4) + gloss, step);
        /*
         * ══ THE COAT PATTERN, applied last so it modulates the FLOORED value ══
         *
         * Applying it before the floor would let `Math.max` erase the marking wherever the floor was
         * the binding constraint — which is most of the body, so the pattern would show only on the
         * few pixels the lighting had already darkened. That is a marking that appears in the
         * source, passes a unit test on `coatDrop`, and is invisible on screen.
         *
         * Floored at 2 rather than 1: a stripe that reaches the outline's neighbourhood reads as a
         * hole punched in the cat, not as a marking on it.
         */
        step = Math.max(2, step - profileCoatDrop(geom.coat, x, y, prof));
        // The ribs, on a starving cat only. Applied after the coat so a starving tabby shows both.
        if (state === "starving") step = Math.max(2, step - profileRibDrop(x, y, prof));
      }
      /*
       * The tail brightens toward the TIP. Backwards from every other part, and deliberately: the
       * tip carries the identity (the curl), it is 1px wide, and it is the furthest thing from the
       * body's mass — so it is the pixel most at risk of vanishing. A tip that fades out is
       * `maneNormal`'s scallop problem and NEEDLE's floating horn at once.
       *
       * The range is 4..6 on an 8-step ramp. At the bottom of the range the tail root would be the
       * same value as the body it emerges from and the tail would appear to start two pixels out —
       * a gap by value rather than by geometry, which breaks rule 1 just as effectively.
       */
      if (hit.part === "tail") {
        step = Math.max(4, Math.min(RAMP_STEPS - 2, 4 + Math.round((hit.t ?? 0) * 2)));
      }
      /*
       * ══ THE LEGS ARE THE DARKEST LIT PART, AND THAT IS WHAT MAKES THEM READ ══
       *
       * A fixed value, not a shaded one — a departure from every other part and deliberate.
       *
       * Rule 3 needs the two posts and the gap between them to be unmistakable. A SHADED leg varies
       * across its own width, so one of its columns routinely dithers up into the body's range and
       * another down into the outline's, and the post stops reading as a post. Pinning them to one
       * value below the body's floor makes the pair read as two solid dark posts against a lighter
       * haunch — exactly the contrast the rule asks for.
       *
       * THE PAW IS A STEP BRIGHTER than the leg above it. That single step is what makes a paw read
       * as a paw: the toes catch the light where the shank does not, and without the value break the
       * extra column just read as the leg getting wider at the bottom, which is a flare rather than
       * a foot.
       */
      if (hit.part === "leg") step = 3;
      if (hit.part === "paw") step = 5;

      let finalStep = applyState(step, hit.part, state);

      /*
       * ══ RULE 2 IS RE-ASSERTED AFTER THE EXPOSURE, AND THAT IS THE ONLY PLACE IT CAN LIVE ══
       *
       * The neck break is computed above in geometry space, and it has to be, because that is where
       * the head's and body's values are decided. But the state gain then compresses the whole ramp,
       * and a compression can bring two steps that differed by two back to within one — v1's test
       * found `stray-1` losing the break in `hunting` even after the gain was made order-preserving,
       * because order-preserving is not gap-preserving.
       *
       * So the break is clamped a second time against the head's POST-STATE value. Asserting an
       * invariant at the point the pixel is actually emitted is the only way it holds under every
       * later transformation; asserting it earlier only holds until something downstream moves. This
       * is the third distinct bug rule 2 has had, and all three were the same shape — the break
       * being computed somewhere the final value was not yet known.
       */
      out.push({ x, y, step: finalStep, part: hit.part });
      filled.add(key);
      outlineSeed.add(key);
    }
  }

  /*
   * ══ THE OUTLINE PASS ══
   *
   * Every empty cell orthogonally adjacent to a filled one becomes an outline pixel at step 0.
   *
   * openhood added this because on a dark ground the coat's shadow side and the page were
   * indistinguishable, so the animal had no edge on its lower left. That is worse here: the palette
   * is low chroma against near-black soot, so there is less value separation available between the
   * darkest coat step and the ground than there was on openhood's obsidian.
   *
   * Drawn OUTSIDE the form rather than replacing its edge pixels: replacing would eat a pixel off
   * every dimension, and on a 12px head that is 8% of the face.
   *
   * Orthogonal neighbours only. A diagonal pass rounds every corner and doubles the outline at every
   * convex turn — which would round the EAR TIPS off, and a rounded ear tip is not a cat.
   *
   * The seed is a SNAPSHOT (`outlineSeed`, frozen before the pass) and additions go to a separate
   * set. Iterating a set while adding to it lets an outline pixel seed further outline pixels and
   * the edge grows a ring per pass.
   */
  const drawn = new Set<number>();
  for (const key of outlineSeed) {
    const cx = key % GRID_W;
    const cy = (key - cx) / GRID_W;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
      const nkey = ny * GRID_W + nx;
      if (filled.has(nkey) || drawn.has(nkey)) continue;
      drawn.add(nkey);
      out.push({ x: nx, y: ny, step: 0, part: "outline" });
    }
  }

  return out;
}

/**
 * Every idle frame of one cat, in order.
 *
 * Provided so a caller baking sprites for an animating colony writes the loop once. A caller
 * drawing a single portrait should call `catGrid` directly rather than computing three grids and
 * discarding two.
 */
export function catFrames(
  id: string,
  opts?: { readonly state?: CatState },
): GridPixel[][] {
  return Array.from({ length: CAT_FRAMES }, (_, frame) =>
    catGrid(id, { ...opts, frame }),
  );
}
