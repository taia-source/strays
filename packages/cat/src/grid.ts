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
export const GRID_W = 24;
export const GRID_H = 24;

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
        tailCurl: Math.max(-1, Math.min(1, geom.tailCurl - Math.sign(geom.tailCurl || 1) * 0.9)),
        tailLift: Math.min(1, geom.tailLift + 0.22),
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
 * How posture and state move the row budget. Returns the rows the BODY occupies and the rows the
 * LEGS do.
 *
 * A function rather than a table because the two spans must tile without a gap — a gap between the
 * body's last row and the leg's first is rule 1 broken, and computing the leg span FROM the body's
 * end makes that impossible to get wrong.
 */
function postureRows(
  posture: Posture,
  state: CatState,
): {
  readonly bodyTop: number;
  readonly bodyEnd: number;
  readonly legEnd: number;
} {
  /*
   * ══ `bodyTop` IS WELDED TO THE HEAD, AND THAT IS NOT AN OVERSIGHT ══
   *
   * v1 moved `bodyTop` down a row for `crouch`, on the reasoning that a crouched cat's body sits
   * lower. It broke 250 of 300 cats: the head still ended where it ended and the body now started a
   * row later, so the row between was EMPTY and the sprite was two disconnected pieces — a floating
   * head above a body. Silhouette rule 1 violated wholesale, found by the flood-fill test rather
   * than by eye because at 96px it read as a slightly odd neck.
   *
   * The lesson generalises: the body's TOP is welded to the head and is not a free parameter.
   * Posture varies the body's BOTTOM and the leg rows, which is where the silhouette has slack —
   * and, conveniently, where a real cat's posture actually varies. A cat lowers its haunches and
   * folds its legs; its head does not detach from its shoulders.
   */
  const bodyTop = ROWS.body[0];
  /*
   * A DEAD cat lies down. The body runs all the way to the floor and the legs get nothing — which
   * is the ONE place a posture is allowed to delete the legs, because a dead cat is not standing on
   * them. Every other state keeps rule 3 intact.
   */
  /*
   * A DEAD cat lies down: the body spreads to the floor and the legs fold under it, so the last two
   * rows are leg rather than body. That is the ONE place a state is allowed to shorten the legs
   * below what rule 3 asks for — a lying animal's legs are folded, not standing — and it is why
   * `legEnd` is not simply `bodyEnd`. Rule 3's two-post assertion is scoped to the living states in
   * `grid.test.ts` for exactly this reason, stated there rather than left implicit.
   */
  /*
   * ══ A DEAD CAT LIES DOWN, AND THAT MEANS THE HEAD COMES DOWN TOO ══
   *
   * The first two attempts kept `bodyTop` welded to the head and only changed the body's bottom, on
   * the rule this function is built around. The result, rendered at both sheet sizes, was a cat
   * standing bolt upright drawn in one flat value — a BELL, or a chess pawn. It did not read as a
   * dead animal at all, because the single most recognisable thing about a dead animal is that it is
   * DOWN, and posture was the one axis the state was not allowed to touch.
   *
   * The weld rule exists to stop a GAP opening between head and body, and it is worth restating why
   * that matters: the head's rows are fixed by `ROWS`, so moving the body down leaves the row between
   * them empty and the sprite becomes two disconnected pieces. That is a real constraint and it is
   * not what is happening here — this raises the body's TOP to overlap the head's own rows, so the
   * body grows UP into the skull rather than dropping away from it. There is no row between them to
   * be empty; there is an overlap, and `partAt` resolves the head first, so the overlap is harmless.
   *
   * The result is a low, wide, flat mass that fills the bottom two thirds of the grid with the skull
   * embedded in its upper edge — a cat collapsed on its side. The flood-fill test covers this state
   * like every other, so the connectivity claim is asserted rather than argued.
   */
  /*
   * ══ THE DEAD BODY STARTS BELOW THE SKULL, NOT INSIDE IT ══
   *
   * Overlapping the body with the head made the two one mass, so the silhouette was a wide triangle
   * with an eye pair in it — the bell again, just lower. The body has to start where the head ENDS,
   * exactly as it does in every living state, and the weld is preserved because both have been
   * displaced by the same `DEAD_DROP`.
   *
   * The rows it gets are DELIBERATELY FEW: two, against the seven a living cat's body has. That is
   * what makes the mass horizontal rather than tall — a lying cat is a long low shape, and the width
   * comes from `deadSpread` while the height is taken away here. A dead cat that kept seven body
   * rows was a standing cat lying about it.
   */
  if (state === "dead") {
    return { bodyTop: ROWS.head[1] + DEAD_DROP, bodyEnd: GRID_H - 1, legEnd: GRID_H };
  }
  switch (posture) {
    /*
     * STANDING — the body ends early and the legs take all four rows, so there is daylight under
     * the cat. The tallest, lightest silhouette of the four.
     */
    case "stand":
      return { bodyTop, bodyEnd: ROWS.legs[0] - 1, legEnd: GRID_H };
    /*
     * CROUCHED — the body runs a row lower over the leg rows and the legs keep two rows underneath
     * it. The lowest, heaviest silhouette: a cat flattened to the ground.
     *
     * v1 gave the body every row down to the floor and left the legs a single row, and rule 3
     * requires two 2px posts with a visible gap — one row of them is not a leg. Posture may change
     * how much daylight there is under the cat; it may NOT delete a feature the silhouette rules
     * require. A rule a posture can switch off is not a rule.
     */
    case "crouch":
      return { bodyTop, bodyEnd: ROWS.legs[0] + 2, legEnd: GRID_H };
    /*
     * STRETCHING — the play bow. The body reaches the same row as sitting, but `postureTilt` drops
     * its FRONT and lifts its back, which is what makes the pose; the rows alone cannot carry it.
     */
    case "stretch":
      return { bodyTop, bodyEnd: ROWS.legs[0] + 1, legEnd: GRID_H };
    default:
      return { bodyTop, bodyEnd: ROWS.legs[0], legEnd: GRID_H };
  }
}

/** The neck row for a given posture — the body's own FIRST row, whichever that is. */
function neckRowFor(posture: Posture, state: CatState): number {
  return postureRows(posture, state).bodyTop;
}

/**
 * How much wider the haunch runs for a given posture.
 *
 * Posture has to change the silhouette without moving the body's top row (which is welded to the
 * head) and without stealing rows from the legs (which rule 3 requires). Width is what is left, and
 * it is the honest cue: a crouching cat spreads against the ground, a standing one draws its mass
 * up and in.
 */
function postureSpread(posture: Posture): number {
  switch (posture) {
    // Drawn up and narrow — a cat on its feet is taller and slimmer through the body.
    case "stand":
      return -1.0;
    // Flattened and spread wide against the ground. 0.9 rather than 1.4 — see `haunchHalfWidth`
    // for why the sum of this and the state spread had to be brought under the clamp.
    case "crouch":
      return 0.9;
    // A stretching cat's haunch is high and its chest is low; the width stays near the reference.
    case "stretch":
      return 0.3;
    default:
      return 0;
  }
}

/**
 * ══ STATE REACHES THE BODY'S WIDTH — this is "the state affects the ANIMAL" ══
 *
 * Returned as a half-width delta in pixels, applied to the haunch alongside `build` and
 * `postureSpread`. A starving cat is nearly two pixels narrower on each side than a fed one, which
 * at 24px is a change of about a fifth of the body's width — unmistakable at 32px, where a dimming
 * is not.
 *
 * The magnitudes are deliberately larger than `build`'s own range. State has to be readable ACROSS
 * cats — a starving stocky cat must read as thinner than a fed lean one — and if state moved the
 * width by less than the identity axis did, it would be masked by it on half the colony.
 */
function stateSpread(state: CatState): number {
  switch (state) {
    /*
     * ══ THE MAGNITUDES ARE 1.2 AND −2.1, WIDENED AFTER A TEST FOUND THEM TOO WEAK ══
     *
     * They were 0.9 and −1.7, a span of 2.6 half-widths. The cell-difference assertion found
     * `stray-2` with only NINETEEN cells between its fed and starving silhouettes — under 5% of the
     * sprite, which at 48px is nothing. The cause is that the haunch is CLAMPED at both ends (see
     * `haunchHalfWidth`), and on a lean cat in a narrow posture the starving value was already
     * hitting the floor, so most of the intended narrowing was being thrown away by the clamp.
     *
     * A span of 3.3 clears the clamp on every combination of build and posture, which the test now
     * asserts across the whole id set rather than on the reference cat alone. This is the same
     * failure mode the hash-budget table warns about — an axis whose effect is smaller than what the
     * downstream quantisation or clamping preserves is a dead axis — arriving in a state rather than
     * in an identity trait.
     */
    // Plump. A cat that has eaten carries visible condition.
    case "fed":
      return 1.2;
    // Visibly thin. Ribs are drawn separately — see `ribDrop`.
    case "starving":
      return -2.1;
    /*
     * ══ A DEAD CAT'S BODY IS NARROWER THAN ITS HEAD, AND THAT IS WHAT BREAKS THE BELL ══
     *
     * Three renders of the dead state produced the same picture — a wide triangle with two dark eyes
     * in it, reading as a bell or a chess pawn — and each fix addressed the wrong variable: first
     * the body's bottom row, then its top, then the whole animal's vertical offset. The empty band
     * above the cat arrived and the bell stayed.
     *
     * The actual cause is a WIDTH relationship. The living cat's silhouette reads because the head
     * is wider than the shoulder — that pinch is rule 2's whole purpose and it is the thing that
     * separates a head from a body at a glance. The dead body kept the living haunch's width, which
     * at its top row already exceeded the skull, so head and body fused into one convex mass with no
     * neck anywhere. A convex mass tapering upward to a point IS a bell; there was nothing else it
     * could have read as.
     *
     * Pulling the haunch in by 2.6 puts the dead body's widest row inside the skull's own width, so
     * the silhouette has a visible shoulder BELOW a wider head — the same pinch every living cat
     * has, which is what makes it read as an animal at all. The mass is then low, compact and
     * horizontal, which is a cat lying down.
     *
     * The general lesson, and this file's sixth instance of it: three fixes in a row that each move
     * a different parameter and produce the same failure mean the failure is STRUCTURAL, and the
     * structure here was a width comparison that no amount of vertical adjustment could reach. It is
     * the identical pattern the whiskers went through, recorded in `isWhisker`.
     */
    case "dead":
      return 0;
    default:
      return 0;
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
 * ══ THE EXPONENT IS 2.2, LOWERED FROM 2.9 — measured at 384x zoom, and it is the largest ══
 * ══ single correction this file has had. ══
 *
 * 2.9 was chosen on the reasoning that "a cat's skull is boxier than a foal's, so the exponent
 * should be higher than openhood's 2.6". The reasoning was right about anatomy and wrong about
 * RASTERISATION, and the render settled it: at 2.9 a 12px-wide superellipse rounds to an almost
 * perfect RECTANGLE — the corners it rounds off are smaller than one pixel, so the head came out as
 * a square slab with two ear nubs stranded on top of it. It read as an owl, or as a robot.
 *
 * That is the same lesson `bodyNormal` records for the body and this file keeps re-learning: an
 * exponent that reads as "gently rounded" in continuous maths reads as "square" once the rounding it
 * produces is under a pixel. The higher the exponent, the smaller that rounding — so the direction
 * that sounds boxier is the direction that DESTROYS the box's corners.
 *
 * At 2.2 the corners round by a visible pixel and a half, which gives the skull a jaw that narrows
 * toward the chin and a crown that curves in toward the ears. That narrowing is what a cat's head
 * actually does, and it is also what gives the ears somewhere to SIT — a rectangle has no shoulders
 * for an ear to rise from.
 */
const HEAD_EXP = 2.2;

/**
 * ══ THE HEAD'S ELLIPSE IS TALLER THAN THE ROWS IT OCCUPIES, AND THAT IS THE POINT ══
 *
 * `ry` is the head's row span plus `HEAD_RY_PAD`, so the rasterised head is the ellipse's MIDDLE
 * band rather than its full height. Without the pad the crown row sits at `ny = -0.88`, where a
 * superellipse has narrowed to about half its width — a 5.2 half-width head takes only 2.8 at its
 * top row.
 *
 * That narrow crown is what made the ears touch. Two ears whose outer edges are flush with a 2.8
 * crown have their inner edges meeting at the centreline, so the pair rasterised as one continuous
 * crest and the cat read as having a mohawk rather than two ears. Widening the ears made it worse
 * and moving them apart detached them from the skull — the two constraints were unsatisfiable
 * because the SKULL was the thing that was wrong.
 *
 * Padding `ry` flattens the taper across the rows that are actually drawn.
 *
 * ══ 2.6, RAISED FROM 1.1, AND THIS WAS THE ROOT CAUSE BEHIND NINE FAILED EAR FIXES ══
 *
 * A trace of the ear's own arithmetic finally showed what every one of those fixes had been working
 * around: at a pad of 1.1 the skull's half-width AT THE EAR'S BASE ROW was 2.10 on a mid-range head
 * — about four columns of crown for TWO ears and a gap between them. There was simply not enough
 * skull to stand two ears on, so every constraint the ear geometry tried to satisfy was
 * unsatisfiable, and each fix moved the failure to a different cat rather than removing it.
 *
 * Nine attempts at the ear, and the ear was never wrong. That is worth recording as a debugging
 * lesson rather than a geometry one: when a series of fixes to one part keeps relocating the same
 * failure, the constraint being violated probably belongs to a NEIGHBOURING part. The trace that
 * settled it took two minutes and would have saved all nine.
 *
 * At 2.6 the crown carries about 3.6 half-columns — seven columns of skull — which fits two 3-column
 * ear bases with a gap, at every head width in the range. The head is correspondingly boxier at the
 * top, which is also what a cat's skull looks like between its brow and its ear line.
 *
 * The chin gains the same flattening, which is also correct — a cat's jaw does not come to a point.
 */
const HEAD_RY_PAD = 2.6;

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

function headNormal(
  px: number,
  py: number,
  headWidth: number,
  drop: number,
  slide: number,
): { nx: number; ny: number } | null {
  const cy = (ROWS.head[0] + ROWS.head[1]) / 2 + drop;
  const ry = (ROWS.head[1] - ROWS.head[0]) / 2 + HEAD_RY_PAD;
  const nyRaw = (py + 0.5 - cy) / ry;
  const rx = headWidth * cheekFlare(nyRaw);
  /*
   * ══ THE HEAD IS CLIPPED TO ITS OWN ROW BUDGET ══
   *
   * `HEAD_RY_PAD` flattens the ellipse's taper by making it taller than the rows it draws on, and it
   * does that at BOTH ends. The crown gain is what the pad is for; the chin gain is a side effect,
   * and it is destructive: a dump showed the head reaching row 13, which is the BODY's first row and
   * the neck. `partAt` resolves the head before the body, so the head painted over the neck row at
   * its own bright floor and rule 2's break had nothing to break against — the head and body fused,
   * which is unitick's amoeba arriving through a padding constant.
   *
   * The budget in `ROWS` is what owns the rows; the pad only shapes the curve within them. Clipping
   * here rather than shrinking the pad keeps the crown wide — the two ends of the ellipse wanted
   * opposite things and only a clip can give both.
   */
  if (py < ROWS.head[0] + drop || py >= ROWS.head[1] + drop) return null;
  const nx = (px + 0.5 - CX) / rx;
  const ny = nyRaw;
  if (Math.abs(nx) ** HEAD_EXP + Math.abs(ny) ** HEAD_EXP > 1) return null;
  return { nx, ny };
}

/**
 * THE CHEEK FLARE. A smooth bulge peaking just below the head's midline, tapering to nothing at the
 * brow and at the chin.
 *
 * A cosine rather than a linear ramp so the widest row is a single row and the flare eases off above
 * and below it; a linear flare produced a head that was a trapezium, which reads as a helmet.
 * Peaking a third of the way down from the midline puts the widest point level with the muzzle,
 * which is where a cat's cheek ruff actually is.
 *
 * 0.09, lowered from 0.14: with the exponent at 2.2 the head is already narrowing toward the chin,
 * so a strong flare fought that narrowing and flattened the jaw back out. The flare's job is to put
 * ONE row of extra width at the cheek, not to restore the slab.
 *
 * Extracted so `headNormal` and `headHalfWidthAt` cannot disagree. Every gap-in-the-silhouette bug
 * in this file has been two pieces of geometry measuring one head two ways.
 */
function cheekFlare(ny: number): number {
  return 1 + 0.09 * Math.max(0, Math.cos((ny - 0.35) * 2.4));
}

/** The head's real half-width at one row, solved from the superellipse the rasteriser used. */
function headHalfWidthAt(py: number, headWidth: number, drop = 0): number {
  const cy = (ROWS.head[0] + ROWS.head[1]) / 2 + drop;
  const ry = (ROWS.head[1] - ROWS.head[0]) / 2 + HEAD_RY_PAD;
  const ny = (py + 0.5 - cy) / ry;
  const remain = 1 - Math.abs(ny) ** HEAD_EXP;
  if (remain <= 0) return 0;
  return headWidth * cheekFlare(ny) * remain ** (1 / HEAD_EXP);
}

/**
 * THE MUZZLE — a SHORT rounded snout, and "short" is the entire cat cue.
 *
 * openhood's muzzle records the failure to avoid: "a first pass at rx 4.2 / ry 2.4 spread the
 * muzzle nine pixels wide and turned the whole lower face into a snout — the exact small-horse
 * failure". A cat's muzzle is shorter than a horse's by a much larger margin than a dog's is: it
 * protrudes barely at all, and the whole lower face is two rounded whisker pads either side of a
 * small nose.
 *
 * So this is drawn WIDE and FLAT — 4.6 across, 1.5 tall — rather than as a protruding snout. That
 * width is the whisker pads, and it is what separates a cat's face from a fox's at 24px. v1 drew
 * this as a fixed 3px mark on one row because there was no room to model it, which is exactly the
 * detail that made v1's faces generic.
 *
 * Its normal leans TOWARD the viewer (`ny` biased negative), so it takes more light than the cheek
 * beside it and separates without an outline.
 */
function muzzleNormal(
  px: number,
  py: number,
  drop: number,
  slide: number,
): { nx: number; ny: number } | null {
  /*
   * ══ 3.3 WIDE, NOT 4.6 — measured at 384x zoom ══
   *
   * At rx 4.6 the muzzle spanned nine of the head's twelve columns, and floored a step above the
   * cheek it came out as a PALE SLAB filling the entire lower face. That is openhood's recorded
   * muzzle failure exactly ("spread the muzzle nine pixels wide and turned the whole lower face into
   * a snout"), reproduced here by copying its first-pass number rather than its corrected one.
   *
   * The whisker PADS are what wanted the width, and they are not the muzzle — a cat's pads sit
   * either side of a small snout, and drawing them as one continuous form loses the small snout that
   * is the actual cat cue. At 3.3 the muzzle is 6-7 columns: a distinct snout with lit cheek either
   * side of it, which is the read the width was reaching for and did not get.
   */
  const cy = 11.6 + drop;
  const rx = 3.3;
  const ry = 1.5;
  /*
   * THE MUZZLE MAY NEVER REACH THE EYE ROWS — measured from a step-grid dump.
   *
   * At `cy` 11.6 with `ry` 1.5 the ellipse's top edge is 10.1, so it claimed pixels on row 10 —
   * which is the eyes' own lower row. `partAt` resolves the eye first, so the eyes survived, but the
   * muzzle filled the 3px bridge BETWEEN them at its own bright floor, and the two eyes plus a lit
   * bridge became one horizontal bar: the VISOR failure that the dark nose bridge exists to prevent,
   * arriving from underneath it.
   *
   * A hard row floor rather than a smaller `ry`, because the muzzle needs its height to model a
   * snout and the constraint is specifically about the eye band. This is the same class of fix as
   * `bodyNormal` stopping where the legs begin: parts owning disjoint rows is cheaper and more
   * legible than depth-sorting them.
   */
  if (py < EYE_Y + EYE_H + drop) return null;
  const nx = (px + 0.5 - CX - slide) / rx;
  const ny = (py + 0.5 - cy) / ry;
  if (nx * nx + ny * ny > 1) return null;
  return { nx: nx * 0.65, ny: ny * 0.65 - 0.2 };
}

/**
 * THE NOSE — a 2x1 dark mark at the top centre of the muzzle.
 *
 * v1 rejected a nose outright: "a dark 1px pixel in the centre of the muzzle read as a missing
 * pixel — a hole in the face — because at 16px a single dark pixel surrounded by lit ones is
 * indistinguishable from a dither dropout."
 *
 * That rejection was correct AT 16PX and is wrong here, and the difference is exactly the two
 * pixels: a 2x1 mark cannot be a dither dropout, because the dither operates per-pixel and never
 * produces an adjacent pair. At 24px the nose is affordable, and it is worth a great deal — the
 * inverted triangle of two eyes and a nose is the single strongest "this is a face" signal there
 * is, and without it a face is two lit dots on a blank field.
 *
 * Returns a STEP rather than a normal, for `eyeStepAt`'s reason: a nose is a MARK, not a surface.
 */
function noseStepAt(px: number, py: number, drop: number, slide: number): number | null {
  if (py !== 11 + drop) return null;
  const dx = px + 0.5 - CX - slide;
  if (Math.abs(dx) > 1) return null;
  // Two steps below the muzzle's own floor, so it reads as a dark mark on a lit snout. Not step 0:
  // at 0 it is the outline's own value and the nose read as a hole punched through the face.
  return 2;
}

/**
 * AN EYE. Returns a STEP directly, never a normal.
 *
 * openhood's reason holds and is worth restating: an eye is not a shaded surface, it is a MARK.
 * Running it through the diffuse model gives it a gradient, and a gradient across a few pixels
 * reads as a dent in the face rather than as an eye.
 *
 * ══ HERE IT IS A BRIGHT MARK WITH A DARK PUPIL — the referent, not a style ══
 *
 * openhood's eyes are step 0, the darkest, which is correct for a creature seen in daylight. This
 * cat is seen through an IR camera trap, and the single most recognisable thing about IR wildlife
 * footage is EYESHINE: the tapetum lucidum reflects the illuminator straight back, so an animal's
 * eyes are the BRIGHTEST thing in the frame by a wide margin.
 *
 * ══ AND AT 24PX THE EYE FINALLY HAS A PUPIL ══
 *
 * v1's eye was 2x1, so it was two lit pixels and nothing else — a cat has the same two dots as
 * every other cat, and eyeshine with no pupil reads as a lamp rather than as an eye. At 3x2 the
 * mask can hold a bright rim AND a dark vertical pupil, which is what makes a cat's eye a CAT's
 * eye: the slit pupil is the most distinctive thing about it.
 *
 * The masks are WRITTEN OUT rather than computed, for openhood's recorded reason: it derived three
 * eye shapes from `dx === 1` predicates and shipped three bugs in four lines, including a "happy
 * squint" that curved downward into a frown. At this size there is nothing to compute.
 *
 * `#` is full eyeshine, `o` is the dimmer iris ring, `.` is the dark slit pupil, ` ` is face.
 */
function eyeStepAt(
  px: number,
  py: number,
  shape: number,
  frame: number,
  drop: number,
  slide: number,
): number | null {
  const dy = py - EYE_Y - drop;
  if (dy < 0 || dy >= EYE_H) return null;
  for (const ex of [EYE_L_X + slide, EYE_R_X + slide]) {
    const dx = px - ex;
    if (dx < 0 || dx >= EYE_W) continue;

    /*
     * ══ THE BLINK IS A FRAME, NOT A SHAPE ══
     *
     * Frame 2 closes every eye regardless of the cat's own `eyeShape`. A blink that varied per cat
     * would be an identity axis rather than an animation, and the two must not share a channel: a
     * viewer watching a cat blink must not conclude that the cat CHANGED.
     *
     * A closed eye is the BOTTOM row only, at a dim step. Bottom rather than top because a cat's
     * upper lid comes down — a closed eye's visible line is the lash line at the bottom of the
     * socket, and drawing it at the top read as the eye having moved up the face.
     */
    if (frame % CAT_FRAMES === 2) {
      if (dy !== EYE_H - 1) return null;
      return 3;
    }

    const MASKS: Readonly<Record<number, readonly string[]>> = {
      /*
       * ══ THE PUPIL IS ONE PIXEL ON THE BOTTOM ROW, NOT A COLUMN THROUGH THE EYE ══
       *
       * The first 24px mask was `#.#` / `o.o` — a vertical slit down the eye's centre, on the
       * reasoning that "the slit pupil is the most distinctive thing about a cat's eye". True of a
       * real cat and false at three pixels: a slit down the middle of a 3px eye is a THIRD of the
       * eye's area, so both eyes rendered as dark holes with a rim, and eyeshine — the entire reason
       * these eyes are bright at all — was gone. At 384x zoom the cat looked hollow-eyed.
       *
       * The correction is the one openhood reached for at the same size: at 3px there are not enough
       * pixels for a knocked-out shape to read as anatomy, it just reads as a missing pixel. So the
       * eye is a solid bright mass with ONE dark pixel low and inward, which reads as a pupil
       * because of where it sits rather than because of its shape — and leaves five of six pixels
       * carrying the eyeshine.
       *
       * ROUND — wide open. Full eyeshine across the top, iris and pupil below. The default and the
       * most legible.
       */
      0: ["###", "o.o"],
      /*
       * NARROW — the top row is iris rather than eyeshine, so the eye reads as more relaxed and
       * slightly hooded. Distinguishable at a glance rather than by counting pixels.
       */
      1: ["o##", "#.o"],
      /*
       * HALF — the upper lid down. The top row is iris rather than eyeshine, so the eye reads as
       * half-closed and drowsy without any pixel going missing.
       *
       * ══ EVERY SHAPE KEEPS ALL SIX PIXELS. This was measured and it is the correction. ══
       *
       * v1's shape 1 was `#.` — the outer pixel only, meant to read as a narrowed slit. Rendered at
       * 96px it did not read as a squint; it read as a cat with ONE EYE, or as a sprite with a
       * dropped pixel. At small sizes a missing pixel is indistinguishable from a dither dropout,
       * and the face is the one place a viewer reads a dropout as damage rather than as detail.
       *
       * So the shapes vary in VALUE, not in presence. What changes is which of the six pixels is
       * eyeshine, which is iris and which is pupil. A variation axis that degrades into "no
       * variation" is fine; one that degrades into "broken" is not.
       */
      2: ["ooo", "#.#"],
    };
    const mask = MASKS[shape] ?? MASKS[0];
    // The LEFT eye reads its mask mirrored, so an asymmetric shape points both eyes outward rather
    // than sending both to the same side of the face — which reads as a squint at something
    // off-frame.
    const i = ex === EYE_L_X + slide ? EYE_W - 1 - dx : dx;
    const cell = mask?.[dy]?.[i];
    if (cell === undefined || cell === " ") return null;
    if (cell === ".") return 1; // the slit pupil — dark, but above the outline's own 0
    if (cell === "o") return RAMP_STEPS - 3; // the iris ring
    return RAMP_STEPS - 1; // full eyeshine
  }
  return null;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE EARS — two triangles with a modelled INNER surface, and the feature that carries identity.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This function occupies the slot `hornNormal` did. §9 of `ART-DIRECTION.md` names ear angle as one
 * of the two fixes for an unreadable colony, and a triangle above a round head is the entire
 * difference between "cat" and "any small mammal".
 *
 * ══ THE INNER EAR IS ITS OWN PART, AND THAT IS A v2 CHANGE ══
 *
 * v1 shaded the inner surface through the NORMAL — biasing `nx` inward so the inner half landed a
 * step or two darker. It recorded why it did not draw an explicit inner triangle: "at a base width
 * of 3px the inset triangle is 1px wide and one row tall — a single dark pixel, which the dither
 * erases roughly half the time."
 *
 * At 24px the base is 5-6px, so the inset triangle is 3px wide and 3 rows tall. That is a real
 * shape, and it is drawn as a real shape — `earInner` is its own `Part` taking its own ramp step,
 * two below the outer ear's. That is what makes an ear read as a CONE OPEN TOWARD THE VIEWER
 * rather than as a triangle sticker, and it is the single detail that most separates these ears
 * from v1's.
 *
 * The normal-based shading is KEPT as well, underneath, so the outer surface still turns toward the
 * light across its own width. The explicit inner wedge and the shaded outer surface are doing
 * different jobs: one is anatomy, the other is lighting.
 *
 * ══ WHAT THE THREE EAR AXES DO ══
 *
 * `earAngle` shears the apex sideways by up to `EAR_SHEAR` px. Negative leans the tips OUTWARD (a
 * relaxed, airplane-eared cat), positive leans them INWARD (alert, pricked).
 *
 * `earHeight` is 3, 4 or 5 rows and `earWidth` is a 1.6..2.9 base half-width. Together they span a
 * broad low triangle to a tall narrow spike — far more than either axis reaches alone.
 *
 * ══ THE SHEAR WAS TRIPLED IN v1, AND IT IS SCALED AGAIN HERE ══
 *
 * v1's `EAR_SHEAR` was 1.15 and became 2.6 after a render review found twelve cats whose ears were
 * "effectively the same": a continuous axis whose full range is smaller than the quantum it is
 * rasterised onto is a dead axis. It looks live in the source and in a unit test, and it does
 * nothing on screen.
 *
 * 3.4 here, scaled by the same 1.5x the grid grew. `grid.test.ts` asserts the ear tip moves at
 * least two columns across the range rather than trusting the constant.
 *
 * REJECTED: rotating the whole ear triangle by an angle. Rotation at this size turns the outer edge
 * into an aliased 2px-wide smear and costs the crisp diagonal that reads as "point". A shear moves
 * the apex and leaves both edges as clean lines, which is the same visual information for none of
 * the cost.
 */
const EAR_SHEAR = 3.4;

function earNormal(
  px: number,
  py: number,
  angle: number,
  height: number,
  width: number,
  headWidth: number,
  drop: number,
  slide: number,
): { nx: number; ny: number; inner: boolean } | null {
  const baseY = ROWS.ear[1] + drop;
  // 0 at the base row, 1 at the apex.
  const t = (baseY - (py + 0.5)) / height;
  if (t < 0 || t > 1) return null;

  for (const side of [-1, 1] as const) {
    /*
     * The ear sits at a fixed FRACTION of the head's half-width rather than at a fixed offset, so a
     * wide head carries its ears further apart and a narrow one carries them close. That is what
     * makes `headWidth` move two features for one hash axis.
     *
     * 0.58 places the ear centre just over halfway out, which keeps the whole base — centre plus
     * `width` — inside the skull at every combination of the two axes. Rule 1 by construction.
     */
    /*
     * ══ THE EAR CENTRE IS A FRACTION OF THE SKULL'S WIDTH AT THE ROW THEY MEET ══
     *
     * This was `headWidth * 0.58` — a fraction of the head's WIDEST half-width, which is measured at
     * the head's vertical centre. But the ear meets the skull at its TOP row, where a superellipse
     * has already tapered in hard: a dump showed a head whose widest half-width was 5.18 taking only
     * 2.78 at its crown. So the ear base sat at ±3.0 against a crown reaching ±2.78, the ear's inner
     * column had no skull beneath it, and the outline pass drew a dark ring straight through the
     * junction. Rendered at 384x zoom, both ears were visibly detached from the head by a dark line
     * — silhouette rule 1, broken on every cat.
     *
     * This is the FIFTH time this file has hit the same defect and the fix is the same one every
     * time: when two pieces of geometry must meet, DERIVE one from the other. The ear now takes its
     * position from the skull's real half-width at its own base row, so a narrow crown carries its
     * ears close together and a broad one sets them apart — and the ear can never start outside the
     * head, at any combination of the axes, by construction rather than by a constant that happened
     * to work.
     *
     * 0.62 of the CROWN's half-width rather than 0.58 of the widest: the crown is the smaller
     * measure, so the fraction has to be larger to keep the ears from bunching over the eyes. It is
     * clamped to leave at least the ear's own base half-width inside the skull, which is what
     * guarantees the inner base column has head under it.
     */
    /*
     * The ear centre sits at the CROWN's own outer edge, less half the ear's base width — i.e. the
     * ear's outer edge is flush with the skull's crown and it grows INWARD from there.
     *
     * Expressed that way rather than as a fraction, because a fraction has to serve two constraints
     * that pull opposite ways: too small and the ears bunch together over the eyes (a dump at 0.62
     * showed the two ear bases TOUCHING at the centreline, so the pair read as one crest); too large
     * and the inner base column hangs off the skull, which is the detachment this whole block exists
     * to prevent. Anchoring the ear's OUTER edge to the crown's edge satisfies both at once and at
     * every combination of `headWidth` and `earWidth`, because both terms are in the expression.
     */
    /*
     * The ear's base is placed so its OUTER edge lands exactly on the crown's edge, by subtracting a
     * full base half-width rather than the 0.55 of one it used to. With the overhang clamp now
     * applied at every row (see below), a base that reached past the crown had its outer columns
     * trimmed away on every row at once — a dump showed cats with ZERO ear pixels, the nub failure
     * taken to its limit.
     *
     * `crownHw - width` puts the whole triangle inside the skull by construction, so the clamp never
     * binds and never trims anything; it remains as the guarantee rather than as the mechanism. The
     * `width * 0.9` floor keeps the two ears from meeting at the centreline on the narrowest crowns,
     * which is the other failure this position has had.
     */
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * THE EAR'S PLACEMENT — derived in ONE direction, after eight bounds fighting each other.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     *
     * This block replaced a chain of eight successive bounds — an anchor fraction, a shear cap, a
     * width shrink, a per-row clamp, a base-row cap, a `t` rescale, a separation floor and a support
     * bound — each added to fix the cats the previous one broke. Every one of them was individually
     * reasonable and the set was unsatisfiable, because two of them computed the WIDTH from the
     * anchor while two others computed the ANCHOR from the width. A cycle cannot be tightened into
     * correctness; it has to be cut.
     *
     * The derivation now runs strictly one way, and each step depends only on the ones above it:
     *
     *   1. `supportHw` — how wide the skull is at the ear's own bottom row. The ground truth.
     *   2. `fitted`    — the ear's half-width, shrunk if the skull cannot carry the hash's request.
     *   3. `baseCx`    — the anchor, placed from `fitted` so the base always lands on the skull.
     *   4. `halfWidth` — a per-row taper in whole columns, non-increasing as the row rises.
     *   5. `centre`    — a per-row shear in whole half-columns, capped so rows always overlap.
     *
     * Nothing below reaches back up. That is what makes rule 1 hold for every id rather than for the
     * ones the last fix happened to be measured on.
     *
     * ══ THE EAR IS HINGED AT THE SKULL'S CORNER ══
     *
     * A cat's ears sit at the CORNERS of the skull: the outer edge of the ear continues the line of
     * the cheek, which is what makes head-plus-ears read as one wedge rather than as a ball with
     * things stuck on it. Anchoring them inboard of that (an early version fitted the whole triangle
     * inside the crown) reads as a V-shaped notch cut into a round head — several cats looked like
     * rabbits.
     */
    /*
     * Measured at the head's OWN FIRST ROW — the row directly beneath the ear's base, which is the
     * row that actually provides the support. It was measured at `baseY - 1`, the ear's own bottom
     * row, where `headHalfWidthAt` reports the width the head WOULD have if it extended that high;
     * the head is clipped to its row budget and does not, so the bound was checking a row that is
     * not drawn. The ear came out spanning columns 7..17 over a head spanning 7..15.
     *
     * The ninth and last instance of this file's most-repeated bug: measuring the ideal rather than
     * the thing the rasteriser draws.
     */
    /*
     * STEP 1 — THE SKULL'S DRAWN COLUMNS AT THE ROW BENEATH THE EAR.
     *
     * `headColsEitherSide` counts the columns the head ACTUALLY OCCUPIES on its own first row, by
     * the same predicate `headNormal` uses. Every earlier version of this bound computed a
     * continuous half-width and compared it against a drawn span, and every one of them was off by a
     * rounding on some subset of ids — the ear overhanging the skull by a column, or the base coming
     * out narrower than the row above it. Counting the drawn columns removes the mismatch at its
     * source: the bound and the drawing are the same integer.
     */
    const headRow = ROWS.head[0] + drop;
    let headMin = GRID_W;
    let headMax = -1;
    for (let c = 0; c < GRID_W; c++) {
      if (headNormal(c, headRow, headWidth, drop, slide) === null) continue;
      if (c < headMin) headMin = c;
      if (c > headMax) headMax = c;
    }
    // No skull on this row at all: there is nothing for an ear to stand on.
    if (headMax < headMin) continue;

    /*
     * STEP 2 — the ear's base half-width, in whole columns.
     *
     * Bounded so that two ears plus a one-column gap fit within the skull's own drawn width. The
     * floor of 1 keeps a 3-column base — the narrowest that has room for an inner cone; below that
     * the ear rasterises to a 1px spike, which reads as an antenna rather than as an ear.
     */
    /*
     * The ear's half-width in whole columns, bounded so TWO ears plus a one-column gap fit inside
     * the skull's own drawn span. Derived from the head's actual first and last drawn column rather
     * than from `CX` and a half-width: the head's rasterised span is not always symmetric about the
     * grid's centre (a slid skull never is), and anchoring to `Math.round(CX)` while measuring width
     * from the drawn span put the ear a column off — `stray-1` reached column 16 over a head ending
     * at 15.
     */
    const gap = 1;
    const supportCols = Math.max(1, Math.floor((headMax - headMin + 1 - gap) / 2));
    const fitted = Math.max(1, Math.min(Math.round(width), supportCols));

    /*
     * STEP 3 — the anchor, in whole columns. The ear's OUTER edge sits on the skull's outer column,
     * so the centre is `fitted` columns inboard of it — which places the entire base on the head by
     * construction, at every head width and every ear width, with no clamp needed afterward.
     *
     * A cat's ears are hinged at the CORNERS of the skull: the outer edge of the ear continues the
     * line of the cheek, which is what makes head-plus-ears read as one wedge rather than as a ball
     * with things stuck on it. An early version fitted the whole triangle inside the crown instead
     * and every cat read as a rabbit — a V-shaped notch cut into a round head.
     */
    /*
     * `Math.min`, not `Math.max`. The separation floor (`gap + fitted`, pushing the ear OUT from the
     * centreline so the pair does not meet) and the corner anchor (`supportCols - fitted`, pulling
     * it IN from the skull's edge) pull in opposite directions, so taking the larger picked whichever
     * was further out and pushed the base past the skull: `stray-1` anchored at column 15 with a
     * half-width of 2, reaching column 17 over a head that ended at 15.
     *
     * The corner is the binding constraint — an ear that touches its twin is ugly, an ear that floats
     * off the skull is broken — so the support bound wins and the separation floor only applies when
     * the skull is wide enough to honour both.
     */
    // The ear's OUTER edge sits on the skull's outermost drawn column, so the centre is `fitted`
    // columns inboard of it. The entire base lands on the head by construction.
    const baseCol = side < 0 ? headMin + fitted : headMax - fitted;

    /*
     * STEP 4 — the taper, stepping down one whole column every `rowsPerColumn` rows.
     *
     * Nine attempts enforced the taper on a continuous half-width and all nine broke on some id,
     * because rounding is what decides the drawn columns: two rows whose continuous widths differ by
     * a tenth of a column can rasterise to spans differing by a whole column in either direction,
     * and a fractional shrink inside a floor OSCILLATES (a single ear came out 9-14, 10-13, 9-14).
     *
     * Integer division cannot oscillate. The width steps down by exactly one column at a time and
     * the span is a pure function of two integers, so a taper that is non-increasing in `rowsUp` is
     * non-increasing in the drawn columns — there is no rasterisation left to get it wrong.
     */
    const rowsUp = Math.max(0, Math.round(baseY - 1 - py));
    /*
     * ONE ROW PER COLUMN — the ear loses a column of half-width every row it rises.
     *
     * `(height - 1) / fitted` was derived so the ear reached a 1-column tip exactly at its apex, and
     * on a tall narrow ear that evaluates to 2 or 3 rows per column — so the first two or three rows
     * were the SAME width and the ear rasterised as a rectangle with a point on top. Rendered, those
     * cats had ears like tower blocks.
     *
     * A cat's ear is a triangle whose sides run at roughly 45 degrees, which is one column per row,
     * and at this size that is also the only rate that reads as a diagonal rather than as a stack of
     * steps. A tall ear therefore reaches its 1-column tip before its apex and simply continues at
     * one column wide — which is a tall pointed ear, exactly what a 6-row ear should be.
     */
    /*
     * ══ THE TAPER RATE IS DERIVED SO THE EAR REACHES A 1-COLUMN TIP AT ITS APEX ══
     *
     * A fixed one column per row was tried and it is too fast: a 4-row ear with a 3-column base
     * loses its whole width by its second row, so rows 1 and 2 were a single column and the ear
     * rendered as a narrow vertical POST — a horn or an antenna, not a cat's ear. Rendered at 384x
     * zoom, four of six cats had them.
     *
     * The rate has to be a function of BOTH the ear's height and its base width, because the ear has
     * to spend exactly `fitted - 1` columns of narrowing over exactly `height - 1` rows of rise. A
     * tall narrow ear then tapers slowly and stays a spike; a short broad one tapers fast and stays
     * a triangle — which is the whole range the `earHeight` and `earWidth` axes are supposed to
     * span, and a fixed rate collapsed it to one shape.
     *
     * `Math.ceil` rather than round: it is better for an ear to reach its tip a row early (a 1-column
     * point, which is what a cat's ear tip is) than a row late, which would leave the apex 2 columns
     * wide and blunt.
     */
    const rowsPerColumn = Math.max(1, Math.ceil((height - 1) / Math.max(1, fitted)));
    const halfCols = Math.max(0, fitted - Math.floor(rowsUp / rowsPerColumn));

    /*
     * STEP 5 — the shear, stepping at the SAME rate the taper does.
     *
     * Tying the two together means every row that leans is also a row that narrows, which keeps
     * consecutive spans nested. Advancing them on different schedules produced a zig-zag edge
     * however carefully each was bounded — `harbour` came out 8-15, 9-14, 8-15 down one ear.
     *
     * `side *` means a positive angle leans BOTH ears inward rather than sliding the pair sideways.
     * A pair of ears that slide together read as a hat.
     */
    /*
     * ══ THE SHEAR STEPS AT HALF THE TAPER'S RATE ══
     *
     * Once the taper stepped one column per row, tying the shear to the SAME rate meant the centre
     * moved a column on every row the width lost one — so the outer edge stayed put while the inner
     * edge moved two, and on a hard lean the rows stopped overlapping entirely. The empty-id cat
     * came apart into 223 pieces.
     *
     * The condition for two consecutive rows to overlap is that the centre moves by less than the
     * sum of their half-widths, and with the width shrinking by one column per row that leaves at
     * most half a column of centre movement per row. `rowsUp / 2` is exactly that bound, and it is
     * the tightest lean the geometry can carry without the flood fill catching it — which is why it
     * is expressed as a bound rather than as a tuned constant.
     */
    /*
     * ══ THE SHEAR MOVES THE CENTRE INWARD ONLY ══
     *
     * The lean is applied as `-side` — always toward the cat's centreline — rather than in the
     * direction the angle names. That is what finally closed rule 1 for the ear, and the reason is
     * geometric rather than aesthetic: the ear's base is anchored with its OUTER edge flush against
     * the skull's outermost drawn column, so there is nothing outside it to lean into. A tip sheared
     * outward leaves the skull's silhouette and, once the taper has narrowed the row, stops
     * overlapping the row below — the empty-id cat came apart into 204 pieces at columns 8 and 14
     * over a row of 9 and 13.
     *
     * Leaning inward is also the more useful half of the range. A cat's ears rotate between "pricked
     * forward" and "flattened back", and on a front-facing sprite both of those read as the tips
     * moving toward or away from the midline — never as the tips moving outside the head's own
     * width, which is what an outward lean would draw.
     *
     * `earAngle` therefore selects HOW FAR the tips lean in (0 for a fully upright ear, up to
     * `EAR_SHEAR` columns for a hard-flattened one) rather than which way. The axis keeps its full
     * range and its two-pixel minimum; it simply spends all of it on one side.
     */
    /*
     * The lean is bounded so the two ears can never reach each other: at full lean the tips must
     * still leave `gap` columns between them. Without that bound both ears converged on the
     * centreline — `stray-2` drew a single column at 11 on two rows and then split back to 10 and 12
     * above it, so each ear was in two pieces and the flood fill found the cat in 202 of them.
     *
     * `maxLean` is how far one ear's centre may travel inward before the pair would touch, derived
     * from the same `baseCol` and `gap` the anchor uses so the two cannot disagree.
     */
    const inwardRoom = Math.max(0, Math.abs(baseCol - Math.round(CX + slide)) - fitted - gap);
    const lean = Math.min(Math.abs(angle) * EAR_SHEAR, inwardRoom, Math.floor(rowsUp / 2));
    const centreCol = baseCol - side * Math.round(lean);

    const dx = px - centreCol;
    if (Math.abs(dx) > halfCols) continue;

    /*
     * ══ THE EAR MAY NOT OVERHANG THE SKULL — rule 1 at the ear's BASE ══
     *
     * Every fix above keeps the ear connected to ITSELF. This keeps it connected to the HEAD, and
     * the two are different failures: an ear whose base column sits outside the skull's own
     * silhouette has nothing beneath it, so it reads as a horn floating off the corner of the head.
     * v1's per-column assertion found it on `stray-1` after the ear taper was widened to fix the
     * self-connectivity bug — one fix opening the next, which is why both are asserted rather than
     * reasoned about.
     *
     * Solving the head's superellipse for its half-width at the ear's BASE row gives the columns
     * the skull actually occupies there. An ear pixel outside them is refused. That trims the outer
     * corner of a hard-leaning ear, which is also what a real ear does — it is hinged at the skull
     * and cannot slide off it.
     */
    /*
     * ══ MEASURED AT THE HEAD'S WIDEST ROW, NOT AT THE EAR'S BASE ROW ══
     *
     * This solved the skull's half-width AT `baseY` — the ear's own base, which is the head's TOP
     * row. On a superellipse the top row is the NARROWEST part of the head, so the test was
     * comparing the ear against the tightest measurement the skull ever takes, and it rejected
     * almost every ear pixel: a step-grid dump showed a cat with `earHeight: 3` whose ears occupied
     * ONE row. The ears had become nubs, which is exactly what the 384x render showed and what no
     * amount of adjusting `earWidth` was going to fix.
     *
     * The rule this test is enforcing is "an ear must have skull beneath it", and "beneath" means
     * anywhere down the head, not on the single row where the ear happens to meet it. Measuring at
     * the head's widest row (its vertical centre) gives the ear the skull's real extent to sit on,
     * while still refusing an ear that has wandered clear of the animal entirely.
     *
     * `+0.5` of slack because an ear is hinged ON the skull's edge rather than strictly inside it —
     * a real ear's outer base is flush with the widest point of the head, not inset from it.
     */
    /*
     * ══ THE TEST IS AGAINST THE SKULL'S CROWN, AND ONLY ON THE EAR'S BASE ROW ══
     *
     * Two earlier versions of this check both failed, in opposite directions, and the pair is worth
     * recording because the fix for one caused the other:
     *
     *   - Measuring at the ear's BASE row used the head's NARROWEST width, which rejected almost
     *     every ear pixel and left the ears as one-row nubs.
     *   - Measuring at the head's WIDEST row was too permissive: the per-column assertion in
     *     `grid.test.ts` found `stray-1` with an ear pixel at column 6 on row 4 and nothing beneath
     *     it on row 5, because the crown at that row is narrower than the head's middle. The ear
     *     overhung the skull and the outline pass drew its ring into the notch.
     *
     * The rule being enforced is "every ear column has head directly beneath it", which is a claim
     * about the row the ear MEETS the head on — the crown — and it only binds on the ear's own
     * bottom row, since higher rows sit above other ear rows rather than above skull. So the test is
     * scoped to `t` near 0 and measured at the crown, which is exactly the geometry the assertion
     * describes. Rows further up are free to overhang, and they must be: a leaning ear's tip is
     * supposed to extend past the skull.
     */
    /*
     * ══ THE CLAMP APPLIES TO EVERY ROW, NOT ONLY THE BASE ══
     *
     * Scoping it to the base row alone produced an ear that was WIDER AT THE TOP THAN AT THE BOTTOM:
     * the base row was trimmed to the crown while the rows above kept their full taper, so an ear
     * spanned columns 5-7 at its base and 4-6 one row up, and column 4 had nothing beneath it. The
     * per-column assertion caught it immediately.
     *
     * That is the same defect the base-row-only version was introduced to fix, inverted — trimming
     * one row of a shape whose other rows are not trimmed just moves the overhang up by a row. An
     * ear is a triangle narrowing upward, and the only way to guarantee every column has support
     * beneath it is for the clamp to be MONOTONIC in the same direction as the taper.
     *
     * Clamping every row to the crown does that: the ear is a triangle inscribed inside the skull's
     * own width at its base, narrowing as it rises, so every column's lowest pixel is either on
     * another ear pixel or on the crown. Rule 1 by construction at every row rather than at one.
     */
    /*
     * ══ THE CLAMP BINDS ONLY WHERE THE HEAD IS — above the crown an ear is free ══
     *
     * Clamping every ear row to the crown's half-width made the ears TRIANGLES INSCRIBED IN THE
     * SKULL: rendered at 384x zoom they read as small bumps on top of a round head rather than as
     * ears rising off it, because their widest row was inside the head's own outline and the
     * silhouette never actually broke. Cat after cat looked like a bear cub.
     *
     * The rule being enforced is "every ear column has support beneath it", and that is a claim
     * about the rows where the ear OVERLAPS the head — at and just above the crown. Rows well above
     * the skull have ear beneath them, not head, so the clamp has nothing to say about them and
     * applying it there only shrinks the ear.
     *
     * `ROWS.ear[1] - 2` is the overlap band: the ear's base row and the one above it. Below that
     * band the clamp guarantees rule 1; above it the ear tapers freely and rises clear of the head,
     * which is the whole point of having ears.
     */
    /*
     * ══ NO PER-ROW TRIMMING AT ALL — the support is guaranteed BY THE ANCHOR ══
     *
     * Three versions of a per-row clamp were tried and each failed the per-column assertion in a
     * different way: clamping every row to the crown inscribed the ears inside the skull (they read
     * as a notch); clamping only the overlap rows to the cheek let the base overhang (`stray-1`,
     * column 5, nothing beneath it); clamping the overlap rows to the base row's own width trimmed
     * the BASE narrower than the row above it, so the ear was wider at the top and the outermost
     * column lost its support again.
     *
     * The third failure is the informative one. An ear is a triangle that narrows as it rises, so
     * its widest row is its base — and any clamp that trims the base without trimming the rows above
     * by at least as much INVERTS that and creates the very overhang it was added to prevent. A
     * clamp cannot be monotonic with a taper it is applied to independently.
     *
     * So there is no clamp. The ear's ANCHOR is bounded instead: `baseCx` is placed so the outer
     * edge of the base — `baseCx + width` — never exceeds the skull's half-width at the base row.
     * The taper then narrows monotonically from a base that is inside the head by construction, so
     * every column's lowest pixel has either ear or skull beneath it, at every angle and every
     * height. Rule 1 held by the geometry rather than by a filter applied on top of it, which is the
     * lesson this file has now recorded six times over.
     */

    /*
     * ══ THE INNER SURFACE — an explicit inset triangle, not a shading bias ══
     *
     * The inner wedge is the part of the ear's cone facing the viewer: inset from the ear's own
     * outer edge by `EAR_RIM` on both sides, and stopping short of the tip so the point stays solid.
     *
     * `EAR_RIM` is 0.8 rather than 1.0 so the rim is a hair under one pixel — which after
     * rasterisation gives a rim exactly 1px wide on most rows and 2px on the widest. A rim of a
     * constant 1.0 gave a 1px rim everywhere including the base, where the ear is 6px across, and a
     * 6px ear with a 1px rim reads as an outline rather than as a cone.
     *
     * `t < 0.72` stops the inner wedge before the apex: an inner surface that reaches the tip makes
     * the tip a single dark pixel, which reads as a notch cut out of the ear.
     */
    /*
     * The inner cone is inset by exactly ONE COLUMN from the ear's outer edge, so the rim is a clean
     * 1px line of lit cartilage around a shadowed hollow. Expressed in integer columns like the rest
     * of the ear; a fractional inset rasterised to a rim that was 1px on some rows and 0 on others,
     * which reads as a broken outline rather than as a cone.
     *
     * It stops before the apex — an inner surface that reaches the tip makes the tip a single dark
     * pixel, which reads as a notch cut out of the ear rather than as a point.
     */
    const inner = halfCols >= 2 && Math.abs(dx) < halfCols && rowsUp <= height - 2;
    /*
     * The outer surface's own normal. `-side` points inward, so each ear's inner half turns toward
     * the cat's centreline and away from the light. `ny` is negative (upward-facing) because an ear
     * leans back off the skull.
     */
    const across = halfCols === 0 ? 0 : dx / halfCols;
    return { nx: across * 0.6 - side * 0.3, ny: -0.4 - t * 0.3, inner };
  }
  return null;
}

/** How far the inner wedge is inset from the ear's outer edge. See `earNormal`. */
const EAR_RIM = 0.8;

/**
 * THE BODY — a cat's body: narrow at the shoulders, widening to a haunch.
 *
 * ══ WHAT v1's FIRST RENDER SHOWED, AND WHY THE SHAPE IS A TAPER ══
 *
 * v1's first pass was a superellipse — the direct analogue of openhood's body with the width
 * relationship inverted (a cat's body is bigger than its head, where a neotenous unicorn's is
 * smaller). Rendered to PNG at 96px and looked at, it failed three ways at once:
 *
 *   1. IT WAS A RECTANGULAR SLAB. At small sizes an exponent-2.4 superellipse rounds to a
 *      full-width block with square corners. The cat read as a head glued to a filing cabinet. An
 *      exponent that reads as "gently rounded" at 24px reads as "square" at 16px, because the
 *      rounding it produces is smaller than one pixel.
 *   2. IT SWALLOWED THE TAIL. Reaching the far column meant the tail root was INSIDE the body, and
 *      the body resolves first — so the first four tail samples were painted as body and only a
 *      stub escaped past the edge.
 *   3. IT ERASED THE NECK. A body as wide as the head makes the whole sprite one mass, and rule 2's
 *      value break cannot rescue a silhouette that has no pinch in it.
 *
 * ══ THE FIX: A TAPER, NOT AN ELLIPSE ══
 *
 * The half-width is a function of the row — narrow at the shoulder and widening to the haunch. That
 * is a cat seen from the front, which is the pose a camera trap actually catches an animal in, and
 * it solves all three failures with one change: the shoulder is narrower than the head so the
 * silhouette PINCHES at the neck; the widest row leaves the tail root outside the body; and a taper
 * has no corners to read as square.
 *
 * REJECTED: keeping the ellipse and simply shrinking rx. It fixed the tail and the neck and left a
 * small round body, which read as a bird — a cat's mass is in its haunches and an evenly round body
 * puts it in the middle.
 *
 * ══ THE HAUNCH FLOOR IS LOAD-BEARING ══
 *
 * `headWidth` tops out at 5.8, so the haunch's floor of 6.0 keeps the body always wider than the
 * head and rule 2's neck pinch survives every combination of the two axes.
 */
/**
 * The shoulder's half-width — the body's NARROWEST point, and the other half of the neck.
 *
 * 2.9, lowered from 3.4. Rule 2 needs the silhouette to PINCH where the head meets the body, and a
 * pinch is a comparison: the head's narrowest half-width is 4.0, so a shoulder at 3.4 was only half
 * a pixel narrower and the notch it produced was under one column — invisible after rasterisation.
 * At 2.9 the shoulder is a full pixel inside the narrowest head on each side, so every cat has a
 * visible waist under its jaw regardless of what its `headWidth` axis gave it.
 */
const BODY_HW_TOP = 2.9;
const BODY_HW_HAUNCH_MIN = 6.0;
const BODY_HW_HAUNCH_MAX = 7.4;

/**
 * The haunch's half-width. The widest the body ever gets.
 *
 * Extracted because FOUR callers need it and every one must agree: `bodyNormal` draws the taper,
 * `tailPixels` roots the tail half a pixel outside it, `coatDrop` insets the tabby bands from it,
 * and `ribDrop` places the ribs inside it. When v1's tail root was a hardcoded 11.6 that agreed
 * with a hardcoded haunch of 4.0, making the haunch a variable silently detached the tail on every
 * stocky cat. Deriving all four from one function is what stops that whole class of bug.
 */
function haunchHalfWidth(build: number, posture: Posture, state: CatState): number {
  const w =
    BODY_HW_HAUNCH_MIN +
    ((build + 1) / 2) * (BODY_HW_HAUNCH_MAX - BODY_HW_HAUNCH_MIN) +
    postureSpread(posture) +
    stateSpread(state);
  /*
   * CAPPED so the tail always has somewhere to go.
   *
   * The tail roots half a pixel outside the haunch and needs at least two columns beyond that to
   * read as a tail at all. Uncapped, a stocky crouching fed cat's haunch reached the grid edge and
   * the tail was clipped — v1's flood-fill test caught 340 truncated tails at once. `CX` is 11.5 and
   * the grid is 24 wide, so 8.4 leaves the last three columns free.
   *
   * FLOORED as well, which the v1 version lacked: a starving standing cat's haunch would otherwise
   * fall below the shoulder's own width and the taper would INVERT, giving a wedge-shaped body that
   * read as a fish. The floor is `BODY_HW_TOP + 0.6` so the body always widens downward.
   */
  /*
   * The ceiling is 7.2, lowered from 8.4 after a step-grid dump showed why the tails were vanishing.
   *
   * `CX` is 11.5 and the grid is 24 wide, so a haunch of 8.4 puts the body's edge at column 19.9 and
   * leaves the tail FOUR columns to exist in — of which its own root takes one. Several cats' tails
   * came out as three cells hugging the hip, which is not a tail, it is a bump. The tail is half the
   * silhouette budget and it was being crowded out by a body that had grown to fill the wider grid.
   *
   * At 7.2 the body's edge sits near column 18.7 and the tail has five clear columns plus the two
   * the curl can reach past them. That is enough for the curl axis to actually sweep — which is the
   * whole point of the axis, and it was measured as dead at the old ceiling in exactly the way the
   * hash-budget table warns about.
   */
  /*
   * ══ THE CEILING IS 7.6 AND THE CROUCH SPREAD WAS CUT, BECAUSE THE CLAMP WAS EATING THE STATE ══
   *
   * The cell-difference assertion found `mackerel` — a CROUCH cat — with only thirteen cells between
   * its fed and starving silhouettes, after the state magnitudes had already been widened once. The
   * cause is that `postureSpread("crouch")` and `stateSpread("fed")` are ADDITIVE and their sum was
   * landing above the ceiling, so both fed and starving were clamped to the same width and the state
   * axis was entirely erased on one posture in four.
   *
   * Two clamps in series, each individually reasonable, silently cancelling a whole axis on a
   * subset of cats: that is the same shape as every dead-axis bug recorded in this file, and it is
   * only ever visible as a difference between two renders rather than in either one.
   *
   * The ceiling rises to 7.6 and `postureSpread`'s crouch drops from 1.4 to 0.9, so the widest
   * combination now sits clear of the clamp. The tail still has its columns — 7.6 puts the body's
   * edge at 19.1 on a 24-wide grid — and the crouch is still visibly the widest posture, it simply
   * no longer consumes the entire budget on its own.
   */
  return Math.max(BODY_HW_TOP + 0.6, Math.min(7.6, w));
}

/**
 * ══ THE POSTURE TILT — what makes `stretch` a pose rather than a width ══
 *
 * Returns how many rows the body's FRONT is displaced relative to its back, at a given row fraction.
 * Only `stretch` uses it: the chest drops toward the ground while the haunch stays up, which is a
 * cat's play bow and is the most recognisable cat pose there is.
 *
 * It is expressed as a row offset applied to the body's TOP at each column rather than as a
 * rotation, because a rotation resamples the whole body and at 24px that turns a taper into a
 * staircase. Displacing rows keeps every edge a clean run.
 */
function postureTilt(posture: Posture): number {
  return posture === "stretch" ? 1.6 : 0;
}

/**
 * ══ THE TAPER IS `sqrt(t)`, NOT `t` — and that is what makes the neck a neck ══
 *
 * A LINEAR taper spreads the width change evenly over every body row. On a `sit` body that is seven
 * rows, so the shoulder row is only one-seventh of the way from the neck's width to the haunch's —
 * about half a pixel narrower than the row below it, which after rasterisation is no narrower at
 * all. A step-grid dump showed the result plainly: rows 13 through 21 were the same width, so the
 * body was a RECTANGLE and rule 2's value break was a stripe across a slab. On a `crouch` body,
 * nine rows long, it was worse.
 *
 * `sqrt(t)` puts most of the widening in the FIRST rows below the neck and then flattens, so the
 * body flares out fast from a narrow shoulder and then runs nearly straight down to the haunch. That
 * is both the shape a cat actually has — the mass is in the barrel and the haunch, not distributed
 * evenly down a cone — and the shape that leaves a visible pinch at the top for the neck to be.
 *
 * The general lesson, and this file's fourth instance of it: a parameter that varies smoothly in
 * continuous maths does nothing once its per-row effect falls under one pixel. The fix is never to
 * widen the range; it is to redistribute where the range is spent.
 */
function taperT(py: number, bodyTop: number, bodyEnd: number): number {
  const raw = Math.max(0, Math.min(1, (py + 0.5 - bodyTop) / Math.max(1, bodyEnd - bodyTop)));
  return Math.sqrt(raw);
}

/** The body's half-width at one row: the taper from shoulder to haunch. */
function bodyHalfWidthAt(py: number, geom: CatGeometry, state: CatState): number {
  const { bodyTop, bodyEnd } = postureRows(geom.posture, state);
  const t = taperT(py, bodyTop, bodyEnd);
  return (
    BODY_HW_TOP + (haunchHalfWidth(geom.build, geom.posture, state) - BODY_HW_TOP) * t
  );
}

function bodyNormal(
  px: number,
  py: number,
  build: number,
  posture: Posture,
  state: CatState,
): { nx: number; ny: number } | null {
  const { bodyTop, bodyEnd } = postureRows(posture, state);
  /*
   * THE STRETCH TILT. The body's top row is pushed DOWN toward the front of the cat (the left, where
   * the chest is) and stays put at the back. `tiltAt` is 0 at the cat's right edge and full at its
   * left, so the shoulder line slopes.
   *
   * The tilt is applied to the body's TOP only, not to its bottom: a cat in a play bow has its
   * chest on the ground and its haunch in the air, so the two ends of the body are at different
   * HEIGHTS but both still reach the floor.
   */
  const tilt = postureTilt(posture);
  const frontness = Math.max(0, Math.min(1, (CX - (px + 0.5)) / 8 + 0.5));
  const top = bodyTop + tilt * frontness;
  // The body STOPS where the legs begin. openhood's recorded bug: without this the body's rounded
  // lower edge spills into the leg rows and, since body resolves before legs, paints over the posts
  // — the creature gets a skirt with feet poking out.
  if (py + 0.5 < top || py >= bodyEnd) return null;
  // 0 at the shoulder, 1 at the haunch — `sqrt`-shaped, so the flare happens fast below the neck.
  const t = taperT(py, bodyTop, bodyEnd);
  const hw = BODY_HW_TOP + (haunchHalfWidth(build, posture, state) - BODY_HW_TOP) * t;
  const dx = px + 0.5 - CX;
  if (Math.abs(dx) > hw) return null;
  // `nx` across the taper, so the body takes light as a cylinder. `ny` leans forward at the chest
  // and away at the haunch, which keeps the lower rows a step darker and stops the body reading as
  // one flat value.
  return { nx: dx / hw, ny: -0.35 + t * 0.95 };
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TAIL — a hash-swept curve, and the second half of the identity budget.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This occupies the slot `maneNormal` did: the largest per-cat SILHOUETTE variation, the part a
 * person would describe first after the colour.
 *
 * ══ IT IS DRAWN AS A SWEPT PATH, NOT AS A REGION ══
 *
 * Every other part in this file is an implicit region: "is this pixel inside my ellipse". A tail
 * cannot be, because a tail is a 1-2px curve and an implicit region 1px wide has no interior — the
 * rasteriser hits it or misses it depending on where the curve crosses the pixel centre, and the
 * result is a dotted line. That IS the NEEDLE failure: "four isolated pixels on a diagonal read as
 * dust rather than as a horn".
 *
 * So the tail is MARCHED. `TAIL_SAMPLES` points are walked along the parametric curve and each one
 * stamps its nearest pixel. A marched path is continuous by construction — consecutive samples are
 * less than a pixel apart, so they either land on the same pixel or on an adjacent one, and there is
 * no way to produce a gap.
 *
 * ══ AND IT IS TWO PIXELS THICK AT THE ROOT, WHICH IS A v2 CHANGE ══
 *
 * v1's tail was 1px along its whole length. At 16px that was the only affordable thickness, and it
 * is why v1's tails read as wires: a real tail is thick where it leaves the body and tapers to a
 * tip. At 24px the root can be 2px and taper to 1, which costs about eight pixels and is the single
 * change that most makes the tail read as part of the animal rather than as a line drawn beside it.
 *
 * ══ WHAT THE AXES DO ══
 *
 *   tailLift  0..1  — how high the tail is carried. 0 is a low slung hunting tail dragging near the
 *                     ground; 1 is the vertical greeting tail a cat raises when approaching. The
 *                     largest single change to the sprite's bounding box.
 *   tailCurl −1..1  — how hard, and which way, the tip hooks. Applied on `t*t` so the base leaves
 *                     the hip straight and the hook accumulates at the tip. A cat's tail bends
 *                     progressively; a constant-curvature arc reads as a rope handle.
 *
 * REJECTED: a fully vertical tail behind the cat, as a Q-shape. It occupies the same columns as the
 * body's own outline and the two merge into one lump — the exact failure openhood recorded for its
 * mane ("the head and mane were one indistinguishable mass"). The tail is pushed OUT to the side,
 * always, so it always breaks the body's outline.
 *
 * REJECTED: a tail that switches sides on a hash bit. Half the colony facing one way and half the
 * other read as two species rather than as one species with variation.
 */
const TAIL_SAMPLES = 72;

function tailPixels(geom: CatGeometry, state: CatState): Map<number, number> {
  const { tailCurl: curl, tailLift: lift, build, posture } = geom;
  const { bodyEnd } = postureRows(posture, state);
  /*
   * THE ROOT IS DERIVED FROM THE HAUNCH, not a constant.
   *
   * v1 had `TAIL_ROOT_X = 11.6`, correct only while the haunch was a fixed 4.0. Once `build` moved
   * the haunch and `posture` moved which row it ended on, a fixed root was inside the body on a
   * stocky cat (the body eats the first samples) and detached from it on a lean one (rule 1 broken,
   * tail reads as dust).
   *
   * Deriving it from the same haunch value `bodyNormal` uses means the root sits exactly half a
   * pixel outside the widest body column at every combination of the axes. Rule 1 held by
   * construction rather than by a constant that happened to work.
   */
  const rootX = CX + haunchHalfWidth(build, posture, state) - 0.5;
  const rootY = bodyEnd - 1.8;

  /** pixel key -> `t` at the sample that claimed it, so the tip can be shaded lighter. */
  const out = new Map<number, number>();
  /** The previous stamped cell, so a diagonal step can be bridged. */
  let last: { x: number; y: number } | null = null;

  const stamp = (sx: number, sy: number, st: number): void => {
    if (sx < 0 || sx >= GRID_W || sy < 0 || sy >= GRID_H) return;
    const k = sy * GRID_W + sx;
    // Keep the SMALLEST `t` that claimed a pixel, so a pixel shared by root and tip shades as root.
    // The tail thins and lightens toward the tip; a pixel that both pass through belongs to the
    // thicker part.
    const prev = out.get(k);
    if (prev === undefined || st < prev) out.set(k, st);
  };

  for (let i = 0; i <= TAIL_SAMPLES; i++) {
    const t = i / TAIL_SAMPLES;
    /*
     * X: the tail exits right, sweeping out over its length, with the curl hooking the tip back.
     * `t*t` on the curl so the hook is a tip event rather than a constant-curvature arc.
     *
     * The curl range is 5.2 — scaled from v1's 4.0 by the same 1.5x the grid grew, so the tip still
     * sweeps about seven columns across the full −1..1 range. A hard negative curl brings the tip
     * back over the cat's own back and a hard positive one throws it clear of the sprite, which are
     * recognisably different tails at map size.
     */
    const x = rootX + 3.6 * t + curl * 5.2 * t * t;
    /*
     * Y: `lift` interpolates the tip's height between +2.4 rows (below the root, a low dragging
     * tail) and −11.0 rows (well above it, a vertical greeting tail). The `t*t` term makes the tail
     * leave the hip roughly horizontal and then turn — a tail that rises linearly from the root
     * reads as a straight stick pointing diagonally, which is a dog's tail or an antenna.
     */
    const rise = -11.0 * lift + 2.4 * (1 - lift);
    const y = rootY + rise * t * t + 0.6 * t;
    const pxi = Math.round(x - 0.5);
    const pyi = Math.round(y - 0.5);

    /*
     * ══ THE DIAGONAL BRIDGE — rule 1 for a marched path, and a measured bug ══
     *
     * Dense sampling guarantees consecutive stamps are ADJACENT, which v1's header claimed was
     * enough for continuity. It is not, and the flood-fill test found 74 cats broken by it: on a
     * steeply climbing segment the path moves DIAGONALLY between two samples, and two diagonally
     * adjacent pixels are not orthogonally connected. The outline pass then draws its ring through
     * the diagonal notch and the tail is visibly cut into pieces by a dark line.
     *
     * This is the same class of error as everywhere else in this file — a rule enforced by a
     * property (sample density) that does not actually imply it. Orthogonal connectivity has to be
     * enforced by orthogonal construction, so every diagonal step lays down the intervening pixel.
     */
    if (last !== null && pxi !== last.x && pyi !== last.y) stamp(pxi, last.y, t);
    stamp(pxi, pyi, t);
    /*
     * ══ THE TAPER — 2px at the root, 1px at the tip ══
     *
     * The second pixel is laid BELOW the path for the first 45% of its length. Below rather than
     * beside, because the tail's own direction is mostly horizontal at the root: thickening
     * perpendicular to the path means thickening vertically there, and a tail thickened
     * horizontally at the root read as a wider hip rather than as a thicker tail.
     *
     * It is dropped past `t = 0.45` so the tip is a clean 1px line, which is what carries the curl.
     */
    if (t < 0.45) stamp(pxi, pyi + 1, t);
    if (pxi >= 0 && pxi < GRID_W && pyi >= 0 && pyi < GRID_H) last = { x: pxi, y: pyi };
  }
  return out;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LEGS AND PAWS — two posts with visible paws, which 16px could not afford.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ TWO POSTS, not four, and this is the resolution being honest ══
 *
 * Rule 3 requires 2px legs with a visible gap. On a cat whose body spans about 14 columns, four 3px
 * posts need 12 columns of leg plus 3 of gap, which does not fit. The options were:
 *
 *   (a) four 1px legs — EXPLICITLY BANNED by rule 3. This is the fringe failure, verbatim.
 *   (b) four posts overflowing the body — openhood recorded this exact bug at 24px ("the outer two
 *       hung past the silhouette and the set read as three legs and a stray mark").
 *   (c) TWO posts. A cat in a near-frontal view occludes its own far legs almost completely, so two
 *       visible legs is not a compromise — it is what the pose actually shows.
 *
 * (c), at 3px wide rather than v1's 2px, because the grid grew and a 2px leg under a 14px body reads
 * as a stilt.
 *
 * ══ AND THEY HAVE PAWS, WHICH IS THE WHOLE REASON THE LEG BUDGET WENT FROM 2 ROWS TO 4 ══
 *
 * v1 had two leg rows and recorded the cost plainly: "at 16x16 there is no room for a modelled leg
 * or a modelled paw." A leg with no paw is a post, and a cat standing on two posts reads as
 * furniture. The bottom row of each leg is a PAW: one column wider than the leg on the outside
 * only, and lit a step brighter than the leg above it.
 *
 * ASYMMETRIC — wider on the outside only — because a paw that flares both ways reads as a hoof or a
 * boot. A cat's paw sits forward and slightly out from the leg, and one column of asymmetry at 24px
 * is what carries that.
 */
const LEG_W = 3;

function legNormal(
  px: number,
  py: number,
  posture: Posture,
  build: number,
  state: CatState,
): { nx: number; ny: number; paw: boolean } | null {
  const { bodyEnd, legEnd } = postureRows(posture, state);
  if (py < bodyEnd || py >= legEnd) return null;
  /*
   * THE POSTS ARE DERIVED FROM THE HAUNCH, not hardcoded.
   *
   * Same lesson as the tail root: v1's legs were at fixed columns that agreed with a fixed body
   * width. Once the body's width became a function of build, posture AND state, fixed legs hung
   * outside a starving cat's silhouette and sat under the centre of a fed one's — which is v1's own
   * recorded "legs under the centre read as a single wide pedestal".
   *
   * 0.62 of the haunch places each post's outer edge just inside the body's widest column, so the
   * legs always sit under the mass they carry.
   */
  const hw = haunchHalfWidth(build, posture, state);
  const inset = hw * 0.62;
  const isPaw = py === legEnd - 1;
  for (const side of [-1, 1] as const) {
    const legLeft = CX + side * inset - LEG_W / 2;
    // The paw is one column wider on the OUTSIDE only. See the header.
    const left = isPaw && side < 0 ? legLeft - 1 : legLeft;
    const width = isPaw ? LEG_W + 1 : LEG_W;
    if (px + 0.5 < left || px + 0.5 >= left + width) continue;
    // A leg is a small cylinder: its normal sweeps across its width and is flat along its length,
    // so it takes light as a rounded post rather than as a flat bar.
    return { nx: ((px + 0.5 - left) / width - 0.5) * 1.6, ny: -0.1, paw: isPaw };
  }
  return null;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE COAT PATTERN — a luminance-only marking, on top of the pigment.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Returns how many ramp steps to subtract from a body pixel. Never a colour — the hue comes from
 * the pigment, and keeping the two axes separate is what gives seven pigments times four patterns
 * rather than seven cats.
 *
 * TWO steps, not one. One step is inside the Bayer dither's own range, so a one-step marking is
 * literally indistinguishable from the noise the shading already produces.
 *
 *   TABBY   — bands on alternating rows across the body. Horizontal because the body's shading
 *             gradient is vertical, so a horizontal band cuts across it and stays legible at every
 *             row; vertical stripes ran parallel to the gradient and disappeared into it.
 *   PATCHED — one block on the cat's left flank, from the shoulder to mid-body. Deliberately
 *             ASYMMETRIC: a symmetric patch reads as shading, and the entire value of this axis is
 *             that it is obviously a MARKING rather than a light effect.
 *   TORTIE  — a scattered mottle keyed on position through the same `fnv1a` the geometry uses, so
 *             it is deterministic and still looks random. Only affordable at 24px.
 */
function coatDrop(
  coat: Coat,
  px: number,
  py: number,
  bodyTop: number,
  bodyHalfWidth: number,
): number {
  switch (coat) {
    /*
     * Every other row — but INSET from both edges, which is the correction.
     *
     * v1's first version banded the full width of the body. Rendered at 96px the bands read as
     * horizontal SLOTS cut through the cat, like louvres in a vent, because a dark line running from
     * one edge of a shape to the other is read as a gap in the shape rather than as a mark on it.
     * The silhouette appeared to be sliced into layers.
     *
     * Leaving the outermost column lit on each side keeps the body's edge continuous, so the band
     * is plainly ON the cat. That is also how a tabby's markings actually sit — they wrap toward the
     * belly and stop, they do not cut the animal in half.
     */
    case "tabby": {
      if ((py - bodyTop) % 2 !== 1) return 0;
      /*
       * INSET BY 2.4 COLUMNS, widened from 1.6 after the louvre failure returned at 24px.
       *
       * The inset exists so the body's outermost lit columns survive on each side and the band reads
       * as a mark ON the cat rather than as a slot cut THROUGH it. 1.6 was carried over from the
       * 16px grid, where the body was 10 columns wide and 1.6 left a fifth of it lit. At 24px the
       * body is 15-17 columns, so the same absolute inset left proportionally far less rim, and at
       * 384x zoom the bands read as louvres in a vent again — the cat looked slatted.
       *
       * An inset that keeps a shape readable is a FRACTION of the shape, not a constant, and this is
       * the third time in this file a constant tuned at 16px has had to be re-derived rather than
       * rescaled. 2.4 keeps roughly the same proportion of lit rim the 16px version had.
       */
      return Math.abs(px + 0.5 - CX) > bodyHalfWidth - 2.4 ? 0 : 2;
    }
    // The left flank only, and only the upper half of the body.
    case "patched":
      return px + 0.5 < CX - 0.5 && py < bodyTop + 4 ? 2 : 0;
    /*
     * TORTIE — a deterministic mottle. `fnv1a` on the coordinate rather than a `Math.random`, so it
     * is stable across renders and the ban holds.
     *
     * The threshold is on the top bits of the hash and the cell is 1x2 (`py >> 1`) rather than 1x1:
     * a 1x1 mottle at this scale is exactly the size of the Bayer dither's own scatter and the two
     * were indistinguishable. Making the cell two rows tall puts the mottle at a different spatial
     * frequency from the dither, which is what lets the eye separate them.
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
 * ══ THE RIBS — how a starving cat is drawn starving ══
 *
 * `ART-DIRECTION.md` §8: "a starving cat is drawn starving. The mechanic is honest about losses or
 * it is a lie with whiskers on it." v1 honoured that with a DIMMING, which is a statement about the
 * light rather than about the animal — a starving cat in v1 looked like a fed cat photographed
 * badly.
 *
 * Two dark bands across the upper body, inset from the edges the same way the tabby bands are so
 * they read as marks on the chest rather than as slots cut through it. Combined with the haunch
 * narrowing in `stateSpread`, a starving cat is both thinner and visibly ribbed, which is a claim
 * about the ANIMAL.
 *
 * THREE steps, deeper than the tabby's two, because the ribs must be legible on a cat that is
 * ALREADY tabby — a rib drawn at the same depth as a stripe is indistinguishable from one.
 */
function ribDrop(px: number, py: number, bodyTop: number, bodyHalfWidth: number): number {
  const row = py - bodyTop;
  if (row !== 1 && row !== 3) return 0;
  return Math.abs(px + 0.5 - CX) > bodyHalfWidth - 2.4 ? 0 : 3;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE WHISKERS — 1px lines off the cheeks, and the part that took four renders to get right.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO NORMAL, and that is deliberate: a whisker is a hair, not a surface. Shading it through the
 * Lambert model lands it at whatever step the cheek beside it is at, which makes it invisible — the
 * whole point of a whisker is that it is a different value from the face.
 *
 * It is also the only part exempt from the outline pass — see `catGrid`. Outlining a 1px line
 * doubles its apparent thickness and turns two whiskers into a moustache.
 *
 * ══ FOUR RENDERS, FOUR DISTINCT FAILURES, AND WHAT EACH TAUGHT ══
 *
 *   RENDER 1 — A MOUSTACHE BAR. Whiskers ran straight out from both cheeks, same length, same row.
 *     At 96px the head and its two whiskers read as a horizontal ROD PASSING THROUGH THE SKULL. A
 *     shape mirrored exactly about the axis reads as one continuous object passing behind whatever
 *     sits between the two halves.
 *   RENDER 2 — DUST. The fix was a one-pixel gap between whisker and cheek. That produced isolated
 *     single pixels floating beside the head, which is NEEDLE's floating horn exactly.
 *   RENDER 3 — THE BAR AGAIN, WORSE. Gap removed, asymmetry (one side a pixel shorter) relied on to
 *     break the rod read. It did not: a one-pixel length difference across a fourteen-pixel span is
 *     invisible, and the eye integrates the whole row and still sees a bar.
 *   RENDER 4 — A STRIKETHROUGH. At 2px per side the whiskers ran three pixels clear of an
 *     eight-pixel head and read as "a line struck through the sprite".
 *
 * ══ THE FIX: BREAK THE ROW, NOT THE LENGTH ══
 *
 * All four failures share one cause — a continuous horizontal run — and length was never going to
 * fix it. The whiskers sit on DIFFERENT ROWS from each other: the left on the muzzle's own row, the
 * right one row up. A stepped pair cannot read as a single rod, because a rod is straight, and that
 * holds at every length and every size. It is also true of a real cat, whose whiskers fan from
 * several rows of follicles rather than from one.
 *
 * ══ RENDER 5, AT 24PX: THE STRIKETHROUGH RETURNED, AND THE CAP GOES BACK TO 1PX ══
 *
 * The 24x24 rebuild allowed 2px per side, reasoning that "the head is now 12px across and a 2px
 * whisker no longer reaches past the body's own width — the strikethrough failure was about the
 * whisker exceeding the BODY, not about its absolute length."
 *
 * Rendered at 384x zoom and looked at, that was wrong twice over. The bar came back on every cat,
 * and the diagnosis is that the whisker's length was never the operative variable at all: what makes
 * a rod is a long run of pixels at ONE VALUE crossing the face, and going from 1px to 2px per side
 * doubles the run's length while the face's own width stays put. The ratio got worse, not better.
 *
 * The second error was subtler and is the one worth recording. The whiskers sat on rows 10 and 11 —
 * and row 11 is the MUZZLE's own centre row, the brightest band on the face. So the left whisker was
 * not a mark beside the face, it was a continuation of the muzzle's own lit run, and the "step"
 * between the two sides did nothing because both whiskers were at the same value as the pale mass
 * between them. A structural fix (different rows) was defeated by a VALUE collision the structure
 * did not consider.
 *
 * So: back to 1px per side, and both whiskers moved OFF the muzzle's rows entirely — the left onto
 * the cheek row below the muzzle, the right two rows above it. The face's lit muzzle band now has
 * nothing colinear with it on either side, which is what actually breaks the rod.
 *

 * ══ THE START IS THE HEAD'S REAL EDGE ON THIS ROW, NOT ITS NOMINAL HALF-WIDTH ══
 *
 * v1 read `start = headWidth` and the flood-fill test found it detaching 238 of 300 cats.
 * `headWidth` is the superellipse's half-width at its WIDEST row, and the whiskers sit rows below
 * that, where the superellipse has already tapered in. So the whisker began a column clear of the
 * face, the outline pass drew its ring in the gap, and the whisker was an isolated pixel separated
 * from the cat by a dark line.
 *
 * Solving the superellipse AT THIS ROW gives the edge the rasteriser actually produced. Rule 1 by
 * construction rather than by a constant that happened to work — the third time this file has
 * learned that when two pieces of geometry must meet, DERIVE one from the other.
 */
const WHISKER_STEP = 3;

function isWhisker(
  px: number,
  py: number,
  len: number,
  headWidth: number,
  drop: number,
  slide: number,
): boolean {
  const dx = px + 0.5 - CX - slide;
  /*
   * THE ROWS. Left whisker on the lower cheek (row 12), right whisker on the upper cheek (row 10) —
   * two rows apart and NEITHER on the muzzle's own centre row of 11. A stepped pair cannot read as a
   * single rod because a rod is straight, and keeping both off the muzzle's lit band means neither
   * is colinear with the brightest run on the face.
   */
  const row = (dx < 0 ? 12 : 10) + drop;
  if (py !== row) return false;
  const start = headHalfWidthAt(py, headWidth, drop);
  // Off the head entirely on this row: there is nothing for a whisker to attach to.
  if (start <= 0) return false;
  const a = Math.abs(dx);
  // ONE pixel, always. `len` survives as a 1-or-2 axis only in that a `len` of 3 reaches a second
  // pixel on the LEFT side alone, which keeps the pair asymmetric without lengthening the run that
  // made the bar.
  const reach = dx < 0 && len >= 3 ? 2 : 1;
  return a > start && a <= start + reach;
}

/**
 * Which part owns this pixel, and its local normal.
 *
 * ══ ORDER IS THE DEPTH SORT, and getting it wrong ruins every cat ══
 *
 * openhood's warning transfers unchanged: "putting the mane before the head swallows the face;
 * putting the head before the eyes erases them." The order here, front to back:
 *
 *   EYE, NOSE, MUZZLE — on the face, so they win over the head they sit on.
 *   EAR               — resolved before the head so an ear base overlapping the skull's top corners
 *                       stays ear. Resolving the head first would eat the ear bases and detach the
 *                       ears — rule 1 broken by a sort order.
 *   HEAD              — in front of the body.
 *   BODY              — in front of the tail. This is what makes the tail's root pixels read as hip.
 *   TAIL              — behind the body, in front of nothing.
 *   LEG               — underneath.
 *   WHISKER           — last, and only where nothing else claimed the pixel.
 */
function partAt(
  px: number,
  py: number,
  geom: CatGeometry,
  tail: Map<number, number>,
  state: CatState,
  frame: number,
): { part: Part; nx: number; ny: number; step?: number; t?: number } | null {
  const drop = stateDrop(state);
  const slide = stateSlide(state);
  const head = headNormal(px, py, geom.headWidth, drop, slide);
  if (head) {
    const eye = eyeStepAt(px, py, geom.eyeShape, frame, drop, slide);
    if (eye !== null) return { part: "eye", nx: 0, ny: 0, step: eye };
    const nose = noseStepAt(px, py, drop, slide);
    if (nose !== null) return { part: "nose", nx: 0, ny: 0, step: nose };
    const muzzle = muzzleNormal(px, py, drop, slide);
    if (muzzle) return { part: "muzzle", ...muzzle };
  }
  const ear = earNormal(
    px,
    py,
    geom.earAngle,
    geom.earHeight,
    geom.earWidth,
    geom.headWidth,
    drop,
    slide,
  );
  if (ear) return { part: ear.inner ? "earInner" : "ear", nx: ear.nx, ny: ear.ny };
  if (head) return { part: "head", ...head };
  const body = bodyNormal(px, py, geom.build, geom.posture, state);
  if (body) return { part: "body", ...body };
  const t = tail.get(py * GRID_W + px);
  if (t !== undefined) {
    // A tail is a tapering cylinder. Its normal sweeps with `t` so the tip catches a different value
    // from the root and the curve reads as round rather than as a drawn line.
    return { part: "tail", nx: 0.25 + t * 0.5, ny: -0.2, t };
  }
  const leg = legNormal(px, py, geom.posture, geom.build, state);
  if (leg) return { part: leg.paw ? "paw" : "leg", nx: leg.nx, ny: leg.ny };
  /*
   * NO WHISKERS ON A DEAD CAT, and this is a connectivity fix as much as a reading.
   *
   * `isWhisker` finds the head's real edge by solving the superellipse at the whisker's own row, and
   * that solve does not know about `slide` — so on a slid skull the whisker started from where the
   * head WOULD have been and landed clear of where it actually is. A dump showed two orphan pixels
   * three columns off the body, which is NEEDLE's dust exactly and breaks rule 4.
   *
   * The fix could have been to thread the slide into the solve, and that was rejected: a dead cat's
   * whiskers are not a feature anyone reads, the flat fill already removes every other fine detail
   * on the sprite, and adding a fifth parameter to a predicate that has broken the silhouette twice
   * already buys nothing. Deleting the part in the one state that does not want it is the smaller
   * change and it cannot regress.
   */
  if (state !== "dead" && isWhisker(px, py, geom.whiskerLen, geom.headWidth, drop, slide)) {
    return { part: "whisker", nx: 0, ny: 0, step: WHISKER_STEP };
  }
  return null;
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
  const tail = tailPixels(geom, state);
  const { bodyTop } = postureRows(geom.posture, state);
  const neckRow = neckRowFor(geom.posture, state);
  /**
   * The head's ramp step per column, filled in as the scan passes the head's rows.
   *
   * The scan runs top-down, so by the time it reaches the neck row every head column above it has
   * already been written. That ordering is load-bearing and is why this is a plain map rather than
   * a second pass: rule 2's break is defined against the pixel directly above.
   */
  const headStepAbove = new Map<number, number>();
  const out: GridPixel[] = [];
  /** Which cells the cat occupies, so the outline pass can find its edge. */
  const filled = new Set<number>();
  /** Whiskers are excluded from the outline seed — see `isWhisker`. */
  const outlineSeed = new Set<number>();

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const hit = partAt(x, y, geom, tail, state, frame);
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
      if (hit.part === "body" && y === neckRow) {
        const above = headStepAbove.get(x);
        step =
          above === undefined
            ? Math.max(1, step - NECK_STEP_DROP)
            : Math.max(1, Math.min(step, above - NECK_STEP_DROP));
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
      if (hit.part === "ear") step = Math.max(5, step);
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
      if (hit.part === "earInner") step = Math.max(2, Math.min(3, step - 2));
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
      if (hit.part === "body" && y !== neckRow) {
        const lower = y >= bodyTop + 3;
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
        const hw = bodyHalfWidthAt(y, geom, state);
        step = Math.max(2, step - coatDrop(geom.coat, x, y, bodyTop, hw));
        // The ribs, on a starving cat only. Applied after the coat so a starving tabby shows both.
        if (state === "starving") step = Math.max(2, step - ribDrop(x, y, bodyTop, hw));
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
      if (hit.part === "body" && y === neckRow && state !== "dead") {
        const above = headStepAbove.get(x);
        if (above !== undefined) {
          finalStep = Math.max(1, Math.min(finalStep, above - NECK_STEP_DROP));
        }
      }

      // Remember the head's own EMITTED value per column, so the neck row below breaks against the
      // value a viewer will actually see rather than against a pre-exposure intermediate.
      if (hit.part === "head" || hit.part === "muzzle") headStepAbove.set(x, finalStep);

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
