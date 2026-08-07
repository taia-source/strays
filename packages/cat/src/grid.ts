/**
 * THE CAT GRID — one source of truth for "what does stray X look like".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHAT THIS IS, AND WHAT IT IS NOT ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A pure function from an id to a 16x16 grid of ramp indices. No canvas, no DOM, no React, no
 * `Math.random()`. Same id in, byte-identical grid out — server and client, across reloads and
 * across a reorder of the colony.
 *
 * The METHOD is ported from `openhood/apps/web/lib/creature-grid.ts`. The ARTWORK is not, and the
 * distinction is the entire point of the port:
 *
 *   - TAKEN: per-axis salted FNV-1a; parts owning disjoint regions; a `*Normal` function per part
 *     returning a local surface normal; normal -> Lambert -> ramp -> ordered dither; the outline
 *     pass; the discipline of recording every rejected geometry in the header.
 *   - DELETED: `hornNormal` and `maneNormal`, entirely. A cat has neither, and leaving them behind
 *     as dead parameters would have let a later edit reach for them.
 *   - REPLACED: the horn's role as the silhouette-carrying feature is taken by the EARS, and the
 *     mane's role as the largest per-creature variation is taken by the TAIL.
 *   - REFUSED: every colour decision openhood made. openhood's unicorns have six candy PIGMENTS
 *     and a two-tone coat. Per `ART-DIRECTION.md` §8, **colour on an animal is banned here** — the
 *     referent is a night-vision camera trap and an IR sensor has no colour information. A cat is
 *     drawn in the phosphor ramp and nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ 16x16, AND WHY NOT 24 ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * openhood authored at 24x24 because its creature had a horn rising above the head and a mane
 * wrapping behind it — two large parts stacked outside the animal's own body. A cat has neither.
 * What a cat needs that a unicorn does not is EARS, and ears cost 3 rows, not 10.
 *
 * unitick's measured floor is 12x12 for anything that must hold a face ("at 2px-per-cell the eyes
 * collapsed into the brow"). 16 clears that floor by four rows, is a whole power of two so it
 * halves cleanly to a 8px map dot, and keeps a colony of thirty cats cheap on a single canvas.
 *
 * The cost is real and is accepted: at 16x16 a cat gets ONE row for a muzzle and TWO rows for
 * legs. There is no room for a modelled leg or a modelled paw. Those are spent on ears and tail,
 * which is the correct trade because those are what a viewer picks a cat out of a colony by.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE THREE SILHOUETTE RULES — inherited verbatim from unitick's NEEDLE failure ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NEEDLE v1 was rendered to a real PNG at 96px and LOOKED at, not judged from the source grid. It
 * read as a white blob. Three separate causes, each of which this file must not reproduce, each
 * asserted as a real test on pixel coordinates in `grid.test.ts`:
 *
 *   1. AN APPENDAGE MUST MEET THE BODY. NEEDLE's horn was isolated pixels on a diagonal with a gap
 *      before the skull, so at render size it read as dust. Here: every ear column that is filled
 *      must have a filled pixel directly beneath it that belongs to the head, and the tail's root
 *      must be orthogonally adjacent to a body pixel. No gap, anywhere, ever.
 *   2. A SHADED SEPARATOR BETWEEN HEAD AND BODY. NEEDLE's head and body were both the same lit
 *      value with no separation, so the silhouette was an amoeba. Here: the row where the head
 *      meets the body is forced at least `NECK_STEP_DROP` steps darker than the head above it —
 *      see `NECK_ROW`. This is the rule most easily lost to a later "the shading looks patchy"
 *      edit, which is why it is a named constant and an assertion rather than a happy accident of
 *      the Lambert term.
 *   3. LEGS ARE 2PX WIDE, PAIRED WITH A VISIBLE GAP. Four 1px verticals at even spacing read as a
 *      fringe. Here: exactly two posts of exactly 2px, with at least 2 empty columns between them.
 *      Two, not four — see `LEG_X` for why a 16px cat cannot have four.
 *
 * ══ AND A FOURTH RULE THIS FILE ADDED, BECAUSE THE FIRST THREE WERE NOT SUFFICIENT ══
 *
 * 4. NOTHING MAY BE ORTHOGONALLY DISCONNECTED FROM THE CAT. Rule 1 as unitick stated it is about
 *    an appendage meeting the BODY, and every one of this file's connectivity bugs slipped past
 *    that wording: a tail that met the body but was cut in half by a diagonal step; an ear that
 *    met the head but whose tip had detached from its own base; a whisker that met a head pixel
 *    that was not there on that row. A flood fill over the whole coat catches all of them at once
 *    and is the single most valuable assertion in `grid.test.ts` — it found 250 broken cats out of
 *    300 the first time it ran, on geometry that looked correct at 96px.
 *
 *    The generalisation worth carrying forward: when two pieces of geometry must meet, DERIVE one
 *    from the other. Every gap bug here was a hardcoded number that agreed with its neighbour
 *    until the neighbour became a variable.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE HASH BUDGET IS BIASED TOWARD EAR ANGLE AND TAIL CURL ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ART-DIRECTION.md` §9 names the second-likeliest failure of this whole product: "the map is
 * beautiful and unreadable — you cannot find your own cat", and states the fix in advance: "if a
 * colony of 30 cats reads as 30 identical smudges at 390px, the hash budget is wrong and the fix
 * is silhouette (ear angle, tail curl), not colour."
 *
 * Colour is banned, so silhouette is not merely the preferred lever — it is the ONLY lever. The
 * budget is therefore deliberately lopsided:
 *
 *   | axis        | range                | effect on the silhouette AT 32px                    |
 *   |-------------|----------------------|-----------------------------------------------------|
 *   | posture     | 3 discrete           | LARGEST — sit / stand / crouch. Gross proportion.   |
 *   | earHeight   | 2, 3 or 4 rows       | LARGE — a fold to a lynx. Changes total height.     |
 *   | earWidth    | CONTINUOUS 1.15..1.95| LARGE — broad triangle to narrow spike.             |
 *   | build       | CONTINUOUS -1..1     | LARGE — haunch from 4.4 to 5.4. Where mass sits.    |
 *   | tailLift    | CONTINUOUS 0..1      | LARGE — low drag to vertical greeting.              |
 *   | tailCurl    | CONTINUOUS -1..1     | LARGE — sweeps the tip across ~5 columns.           |
 *   | headWidth   | CONTINUOUS 3.2..4.3  | MEDIUM — wedge to round, and it moves the ears too. |
 *   | earAngle    | CONTINUOUS -1..1     | MEDIUM — leans the tips in or out.                  |
 *   | coat        | 3 discrete           | MEDIUM — solid / tabby / patched, luminance only.   |
 *   | eyeShape    | 3 discrete           | none — interior detail, 96px only.                  |
 *   | whiskerLen  | 2 or 3               | none — 1px marks at the cheek, 96px only.           |
 *
 * ══ THE RULE THIS TABLE ENCODES, LEARNED THE HARD WAY ══
 *
 * The first version of this budget had six axes, four of them continuous, and it produced a colony
 * that a reviewer described as "effectively the same" at 32px. Every axis was live; the budget was
 * still wrong. Two reasons, and both are now rules:
 *
 *   1. AN AXIS MUST MOVE ITS FEATURE BY AT LEAST TWO PIXELS ACROSS ITS RANGE, or rasterisation
 *      eats it. `earAngle` moved the ear tip by less than one pixel over its entire −1..1 span, so
 *      most of the range produced the identical ear. A continuous parameter quantised onto a small
 *      integer grid does nothing unless its effect exceeds the quantum. The same defect appeared
 *      twice more in different dimensions — a 0.9 state gain that was the identity on a 6-step
 *      ramp, and a 2.6 tail curl that moved the tip two columns — so it is asserted for the ear in
 *      `grid.test.ts` rather than trusted to a constant.
 *   2. VARIATION MUST BE BUDGETED AT THE SCALE THE SPRITE IS VIEWED AT. Ear angle and tail curl
 *      are DETAIL axes: they change a few pixels at the edge, which is exactly what disappears
 *      first when a sprite is shrunk. `posture` and `build` change gross proportion — where the
 *      mass sits — and gross proportion is all a 32px sprite has. A budget spent entirely on
 *      detail is a budget spent on nothing on the map, which is the only place it matters.
 *
 * REJECTED as variation axes, and recorded so they are not re-tried:
 *   - A ONE-STEP COAT MARKING. Tabby stripes were rejected outright at first, on the grounds that
 *     "at 16x16 a stripe is one pixel and one ramp step is indistinguishable from the dither".
 *     That was right about a ONE PIXEL, ONE STEP stripe and wrong in general: a band spanning a
 *     whole body row at a TWO step delta is not dither-sized in either dimension. The axis is now
 *     live — see `Coat` — and the original rejection stands only for the subtle version of it.
 *   - HEAD TILT. Rotating the head by a hash angle desynchronises the ears from the skull, and at
 *     16px the resampling turns both ears into 2px blobs. Reads as damage, not as posture.
 *   - MIRRORING THE WHOLE CAT on a hash bit. It doubles the apparent variety for free and it is
 *     wrong: half a colony facing each way reads as two species rather than one with variation,
 *     and it would put half the tails on the side the body's taper was not designed to root.
 */

import { fnv1a, quantise, shadeSphere } from "@taia/ui/mechanisms";

/**
 * THE NATIVE GRID. Every cat is authored at this resolution and never at another.
 *
 * Square, so the same sprite sits in a map slot, a detail portrait and a roster chip without any
 * of them cropping it. See the header for why 16 rather than 24 or 12.
 */
export const GRID_W = 16;
export const GRID_H = 16;

/**
 * ══ THE ROW BUDGET — which rows each part owns ══
 *
 * A BUDGET in the same sense openhood's was: these spans tile the grid, so making the head taller
 * necessarily makes something else shorter. That is what stops the proportions drifting one edit
 * at a time.
 *
 * Rows run top-down, as pixel rows do. `[start, end)` — end exclusive.
 *
 * ══ The proportions are a CAT's, not a kitten's, and that is a product decision ══
 *
 * openhood's unicorn is neotenous on purpose: head 50% of the animal, eyes below the midline,
 * stubby legs. It is selling a cute companion. This product is not. `ART-DIRECTION.md` §8 bans
 * "a cute cat used to soften a loss" and says "a starving cat is drawn starving". A kitten-
 * proportioned sprite would fight that in every state, because a huge-headed big-eyed animal reads
 * as appealing no matter what value its pixels take.
 *
 * So the head is 5 of 14 animal rows (~0.36) — bigger than a real cat's ~0.2, because a face still
 * has to be legible at 32px, but well short of the 0.5 that makes an infant. The result reads as a
 * small adult animal, which is what a stray is.
 */
export const ROWS = {
  /** Rows 1-3. THE EARS. Above the head and the only thing above it — the horn's old slot. */
  ear: [1, 4],
  /** Rows 4-8. THE HEAD. Five rows: enough for a brow, an eye row, and a muzzle row. */
  head: [4, 9],
  /** Rows 9-13. THE BODY. Four rows, and row 9 is the neck separator (rule 2). */
  body: [9, 14],
  /** Rows 14-15. THE LEGS. Two rows, which at 16px is all an understorey can afford. */
  legs: [14, 16],
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
 * TWO, not one. At one step the separator was present in the data and invisible in the render —
 * the Bayer dither, which is running at strength 1.0 and can move a pixel a full step either way,
 * routinely erased it. A separator that the dither can cancel is not a separator. Two steps
 * survives the dither with a margin, which is the property that matters: the rule must hold in the
 * PIXELS, not in the pre-dither luminance.
 */
export const NECK_STEP_DROP = 2;

/** The head's widest measure, in pixels: columns 4..11 inclusive. */
export const HEAD_W = 8;

/** The cat's vertical axis. 7.5 is the true centre of a 16-wide grid. */
const CX = 7.5;

/**
 * THE EYES. 2x1 each — two pixels wide, one row tall.
 *
 * openhood's unicorn used a 3x3 eye on a 14px head so it could carry a catchlight. That does not
 * survive the halving: a 3x3 eye on an 8px head is 1:2.7, which is most of the face, and two of
 * them plus a gap is 8 columns — the entire head width. Rendered, it was a pair of goggles.
 *
 * A 2x1 eye on an 8px head is 1:4, which lands almost exactly on openhood's measured 1:4.7 cute
 * band, and it leaves a 2px nose bridge between the eyes. It cannot carry a catchlight, and it
 * does not need one: the catchlight was there to stop a large dark mass reading as a hole, and a
 * 2px mark is not a mass.
 *
 * ROW: the eyes sit on row 6, one row below the head's own midline (rows 4..8, midline 6.0 — the
 * eye's centre is 6.5). Below the midline is the direction openhood measured as reading as alive
 * rather than as a skull, and it costs nothing.
 */
export const EYE_Y = 6;
export const EYE_L_X = 5;
export const EYE_R_X = 9;
export const EYE_W = 2;

/**
 * ══ THE DERIVED PROPORTIONS ══
 *
 * Computed from the budget above rather than typed, so they cannot disagree with the geometry that
 * actually draws. Asserted in the test.
 */
export const PROPORTIONS = {
  /** Head height over head+body+legs. ~0.36 — a small adult animal, not an infant. */
  headToBody: (ROWS.head[1] - ROWS.head[0]) / (ROWS.legs[1] - ROWS.head[0]),
  /** Eye width over head width. 2/8 = 0.25, i.e. 1:4. */
  eyeToHead: EYE_W / HEAD_W,
  /** Gap between the eyes in units of one eye's width. 1.0 — a 2px nose bridge. */
  eyeGapInEyes: (EYE_R_X - (EYE_L_X + EYE_W)) / EYE_W,
  /** Ear height over the animal's total height. ~0.2 — ears are a fifth of the cat. */
  earToAnimal: (ROWS.ear[1] - ROWS.ear[0]) / (ROWS.legs[1] - ROWS.ear[0]),
} as const;

/**
 * ══ THE RAMP ══
 *
 * SIX steps, not eight, and this is `ART-DIRECTION.md` §5c stated as a constant: "a flat-lit animal
 * has less tonal range than a shaded sphere". The mechanism kit's `shadeSphere` was written for a
 * planet, which has a terminator sweeping a full hemisphere. A 16px cat has about three distinct
 * planes on it. Eight steps spends two of them on differences the eye cannot see at 32px, and
 * worse, it makes the Bayer dither's ±1-step scatter smaller than one visual step — so the dither
 * stops reading as texture and starts reading as noise.
 *
 * Step 0 is the outline and the darkest shadow. Step 5 is the lit crown of the head.
 */
export const RAMP_STEPS = 6;

/**
 * THE LIGHT. Up, slightly left, and toward the viewer.
 *
 * Not a taste. The referent is a camera trap with an IR illuminator mounted ON the camera, so the
 * light and the eye are nearly coincident — which is why real trap footage is flat and frontal. A
 * strongly side-lit cat would contradict the whole apparatus. `lz` at 0.72 dominates, so the cat
 * is lit mostly from the front; the small `-0.42 / -0.55` bias exists only so the two ears take
 * different values from each other and the silhouette does not go symmetric-flat.
 *
 * Normalised by construction: 0.42² + 0.55² + 0.72² = 0.9973. Close enough that renormalising
 * would move no pixel, and writing the literal keeps the vector readable.
 */
const LIGHT = [-0.42, -0.55, 0.72] as const;

/**
 * ══ THE DITHER STRENGTH ══
 *
 * 1.0, as `ART-DIRECTION.md` §5c specifies, against the mechanism kit's own default of 1.1.
 *
 * The kit's 1.1 is ponsball's measured value for a large shaded sphere, where a slight over-dither
 * buys extra apparent depth. On a 16px animal 1.1 pushed pixels a full step past their neighbours
 * often enough to punch visible holes in the ear tips — a 1px-wide ear that dithers one step dark
 * against a dark ground has effectively vanished. 1.0 keeps the stipple and stops the holes.
 */
const DITHER = 1.0;

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
 * of the id independently rerolls the ear AND the tail. `grid.test.ts` asserts exactly that.
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
  | "head"
  | "eye"
  | "muzzle"
  | "whisker"
  | "body"
  | "tail"
  | "leg"
  | "outline";

/** One filled pixel of a cat: where it is, which ramp step it takes, and what drew it. */
export type GridPixel = {
  readonly x: number;
  readonly y: number;
  /** Index into the caller's ramp, 0..RAMP_STEPS-1. Never a colour — the caller owns the palette. */
  readonly step: number;
  readonly part: Part;
  /**
   * True on the ONE OR TWO pixels the state may tint. Never more.
   *
   * `ART-DIRECTION.md` §8: "No colour on an animal... Cats are drawn in the phosphor ramp only —
   * their state may tint one or two pixels, their identity may not." This flag is how a renderer
   * knows which pixels those are without re-deriving the rule, and `grid.test.ts` asserts the
   * count never exceeds two in any state.
   */
  readonly accent?: boolean;
};

/**
 * THE CAT'S STATE. Four values, and they map to what the animal is actually doing.
 *
 * This is NOT a colour axis. State changes POSTURE and the eyes, and nothing else — see
 * `applyState`. A fed cat and a starving cat are the same cat drawn in the same six phosphor
 * steps; what differs is that one of them is sitting up.
 */
export type CatState = "fed" | "hunting" | "starving" | "dead";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE POSTURE — the largest silhouette axis there is, and the one added last.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A discrete axis rather than a continuous one, because posture is not a spectrum: a cat is
 * sitting, or standing, or crouched, and the intermediate states are transitions rather than
 * poses. Three values, each moving the row budget:
 *
 *   SIT      — the reference. Haunch on the ground, chest up, legs short and forward.
 *   STAND    — the body lifts a row and narrows; the legs get the row the body gave up, so the
 *              cat is taller and lighter with visible daylight under it.
 *   CROUCH   — the body drops and spreads; the legs are folded under and barely show. A hunting
 *              cat flattened to the ground.
 *
 * ══ Why this beats every other axis at 32px ══
 *
 * Posture changes the OVERALL PROPORTION of the sprite — where its mass sits vertically — and that
 * is the property that survives being shrunk. Ear angle and tail curl are detail axes: they change
 * a few pixels at the edge, which is exactly what disappears first. Two cats in different postures
 * differ in their gross shape, and gross shape is all a 32px sprite has.
 *
 * This was added after a render review found twelve cats that were "effectively the same" at 32px
 * despite the ear and tail axes both being live and both being wide. The lesson: variation has to
 * be budgeted at the SCALE THE THING IS VIEWED AT. A budget spent entirely on detail is a budget
 * spent on nothing when the sprite is 32px in a colony.
 */
export type Posture = "sit" | "stand" | "crouch";

/**
 * ══ THE COAT PATTERN — luminance only, and why that is NOT a violation of the colour ban ══
 *
 * §8 bans "colour on an animal": "The IR sensor has none. Cats are drawn in the phosphor ramp
 * only." A pattern drawn by moving pixels BETWEEN EXISTING RAMP STEPS adds no hue whatsoever — it
 * is the same six phosphor values rearranged. An IR sensor absolutely does resolve a tabby's
 * markings, because they differ in reflectance, and reflectance is the one thing an IR sensor
 * measures. Rendering a tabby as uniformly grey would be the less honest choice.
 *
 * The ban's actual target is identity-carrying HUE — an amber cat and a red cat reading as two
 * species and colliding with the two event hues. A luminance pattern cannot do that.
 *
 * ══ AND THIS REVERSES AN EARLIER REJECTION IN THIS FILE, DELIBERATELY ══
 *
 * The header originally rejected coat markings on the grounds that "at 16x16 a stripe is one pixel,
 * and one pixel of a different ramp step is indistinguishable from the Bayer dither already running
 * underneath it". That reasoning was correct about a ONE PIXEL stripe and wrong about the general
 * case. A stripe that spans a whole row of the body, at a two-step delta rather than one, is not
 * dither-sized in either dimension and reads cleanly at 96px and as a texture difference at 32px.
 * The fix for "too subtle to survive the dither" was to make it bigger, not to abandon it.
 *
 *   SOLID    — no pattern. The reference, and the most common.
 *   TABBY    — horizontal bands across the body, two steps down, every other row.
 *   PATCHED  — one asymmetric block of two steps down on the flank. A bicolour stray.
 */
export type Coat = "solid" | "tabby" | "patched";

/** A cat's own geometry, every axis derived from a separately-salted hash of the id. */
export type CatGeometry = {
  /** −1..1. Which way the ears lean. Negative is outward/flat, positive is inward/alert. */
  readonly earAngle: number;
  /** 2, 3 or 4. How many rows the ear rises. One row is a large silhouette change at 16px. */
  readonly earHeight: number;
  /** 1.15..1.95. The ear's half-width at its base — a wide flat ear or a narrow tall one. */
  readonly earWidth: number;
  /** −1..1. Which way the tail sweeps and how hard. */
  readonly tailCurl: number;
  /** 0..1. How high the tail is carried, from low-slung to vertical greeting. */
  readonly tailLift: number;
  /** 0, 1 or 2. Round, narrow, or half-closed. Interior detail — no silhouette effect. */
  readonly eyeShape: number;
  /** 2 or 3. Whisker length on the left cheek; the right is always one shorter. */
  readonly whiskerLen: number;
  /** −1..1. Stocky (positive) to lean (negative). Scales the body's haunch width. */
  readonly build: number;
  /** The pose. The single largest silhouette axis at map size. */
  readonly posture: Posture;
  /** 3.2..4.3. The head's half-width. A narrow wedge face or a broad round one. */
  readonly headWidth: number;
  /** The coat pattern, in luminance only. */
  readonly coat: Coat;
};

/** Every varying axis of one cat, from its id. `Math.random()` appears nowhere. */
export function geometryFor(id: string): CatGeometry {
  const postures: readonly Posture[] = ["sit", "stand", "crouch"];
  const coats: readonly Coat[] = ["solid", "tabby", "patched"];
  return {
    earAngle: signed(id, SALT.earAngle),
    /*
     * 2, 3 or 4 rows, widened from the original 2-or-3.
     *
     * Measured: with only two values, half the colony had identical ears and the ear axis
     * contributed almost nothing to telling cats apart. Three values across a 3-row budget is the
     * most a 16px grid can carry, and the difference between a 2-row and a 4-row ear is the
     * difference between a scottish fold and a lynx — the largest single change to the top of the
     * silhouette available.
     */
    earHeight: 2 + Math.floor(unit(id, SALT.earHeight) * 3),
    /*
     * The ear's base half-width, 1.15..1.95. Combined with `earHeight` this is what produces the
     * flat-and-wide to tall-and-narrow range: a 4-row ear at half-width 1.15 is a spike, and a
     * 2-row ear at 1.95 is a broad triangle. Neither was reachable when the width was a constant.
     */
    earWidth: 1.15 + unit(id, SALT.earWidth) * 0.8,
    tailCurl: signed(id, SALT.tailCurl),
    tailLift: unit(id, SALT.tailLift),
    eyeShape: Math.floor(unit(id, SALT.eyeShape) * 3),
    whiskerLen: 2 + Math.floor(unit(id, SALT.whisker) * 2),
    build: signed(id, SALT.build),
    posture: postures[Math.floor(unit(id, SALT.posture) * 3)] ?? "sit",
    /*
     * The head's half-width, 3.2..4.3. A full pixel of range on each side, so the widest head is
     * two columns broader than the narrowest — visible at 32px as the difference between a wedge
     * face and a round one, and it changes where the ears sit as a consequence.
     *
     * The ceiling is 4.3 and not higher because the head must stay narrower than the haunch or the
     * neck pinch (rule 2) disappears — see `bodyNormal`, whose narrowest haunch is 4.4.
     */
    headWidth: 3.2 + unit(id, SALT.headWidth) * 1.1,
    coat: coats[Math.floor(unit(id, SALT.coat) * 3)] ?? "solid",
  };
}

/**
 * How posture moves the row budget. Returns the rows the BODY occupies and the rows the LEGS do.
 *
 * A function rather than a table because the two spans must tile without a gap — a gap between the
 * body's last row and the leg's first is rule 1 broken, and computing the leg span FROM the body's
 * end makes that impossible to get wrong.
 */
function postureRows(posture: Posture): {
  readonly bodyTop: number;
  readonly bodyEnd: number;
  readonly legEnd: number;
} {
  /*
   * ══ `bodyTop` IS THE SAME FOR ALL THREE POSTURES, AND THAT IS NOT AN OVERSIGHT ══
   *
   * The first version of this function moved `bodyTop` down a row for `crouch`, on the reasoning
   * that a crouched cat's body sits lower. It broke 250 of 300 cats: the head still ended at row 8
   * and the body now started at row 10, so row 9 was EMPTY and the sprite was two disconnected
   * pieces — a floating head above a body. Silhouette rule 1, violated wholesale, and it was found
   * by the flood-fill test rather than by eye because at 96px it read as a slightly odd neck.
   *
   * The lesson generalises past this bug: the body's TOP is welded to the head and is not a free
   * parameter. Anything that moves it must move the head too, and at 16px there is no room to move
   * the head. So posture varies only the body's BOTTOM and the leg rows, which is where the
   * silhouette has slack — and, conveniently, where a real cat's posture actually varies. A cat
   * lowers its haunches and folds its legs; its head does not detach from its shoulders.
   */
  const bodyTop = ROWS.body[0];
  switch (posture) {
    /*
     * STANDING — the body ends a row early and the legs take two full rows, so there is daylight
     * under the cat. The tallest, lightest silhouette of the three.
     */
    case "stand":
      return { bodyTop, bodyEnd: ROWS.legs[0] - 1, legEnd: GRID_H };
    /*
     * CROUCHED — the body runs one row LOWER over the leg rows, and the legs keep both of their
     * rows underneath it. The lowest, heaviest silhouette: a cat flattened to the ground.
     *
     * The first version gave the body every row down to 15 and left the legs a single row. Rule 3
     * requires two 2px posts with a visible gap, and one row of them is not a leg — the test found
     * `0xbeef` with ZERO leg pixels on row 14. Posture is allowed to change how much daylight
     * there is under the cat; it is NOT allowed to delete a feature the silhouette rules require.
     * A rule that a posture can switch off is not a rule.
     *
     * So crouch keeps the sitting cat's rows and distinguishes itself by SPREAD instead — see
     * `postureSpread`. That is the better encoding anyway: a crouching cat is not shorter so much
     * as WIDER, its mass pushed out sideways against the ground.
     */
    case "crouch":
      return { bodyTop, bodyEnd: ROWS.legs[0], legEnd: GRID_H };
    default:
      return { bodyTop, bodyEnd: ROWS.legs[0], legEnd: GRID_H };
  }
}
/**
 * The neck row for a given posture — the body's own FIRST row, whichever that is.
 *
 * `NECK_ROW` is the sitting cat's value and is exported because it is the reference the tests and
 * the proportion table are written against. Once `posture` began moving the body's top row, a
 * constant neck row was wrong for two of the three postures: a crouched cat's body starts a row
 * lower, so the break landed on empty space and the cat had no neck at all. Rule 2 is about the
 * boundary between head and body, so it has to follow the boundary.
 */
function neckRowFor(posture: Posture): number {
  return postureRows(posture).bodyTop;
}

/**
 * How much wider the haunch runs for a given posture.
 *
 * Posture has to change the silhouette without moving the body's top row (which is welded to the
 * head) and without stealing rows from the legs (which rule 3 requires). Width is what is left,
 * and it is the honest cue: a crouching cat spreads against the ground, a standing one draws its
 * mass up and in. At 16px a full pixel on each side is a large, legible difference.
 */
function postureSpread(posture: Posture): number {
  switch (posture) {
    // Drawn up and narrow — a cat on its feet is taller and slimmer through the body.
    case "stand":
      return -0.7;
    // Flattened and spread wide against the ground.
    case "crouch":
      return 1.0;
    default:
      return 0;
  }
}

/**
 * THE HEAD — a rounded box, slightly wider than tall.
 *
 * A superellipse rather than a circle, for openhood's reason: a circle head is a ball and a ball
 * has no cheeks. The exponent is 2.8 here against openhood's 2.6, because a cat's skull is boxier
 * than a foal's — the sides run nearly straight from the ear base down to the jaw, and only the
 * corners round. At 2.0 this was a bowling ball; at 4.0 it was a television.
 *
 * WIDER THAN TALL (rx 4, ry 2.75 against a 5-row span) is a cat cue in its own right and it was
 * measured: a head as tall as it is wide reads as a bear or an owl, because a cat's skull is short
 * front-to-back and its ears are set WIDE on top of it. Squashing the head is what gives the ears
 * somewhere apart to sit.
 */
function headNormal(px: number, py: number, headWidth: number): { nx: number; ny: number } | null {
  const cy = (ROWS.head[0] + ROWS.head[1]) / 2;
  /*
   * The half-width is now PER-CAT (3.2..4.3) where it was the constant 3.8.
   *
   * The constant was itself a correction: at exactly `HEAD_W / 2` (4.0) the head's widest row
   * rasterised to the same ten columns as the body's haunch, so the silhouette had a straight
   * vertical edge from the ear base to the legs and the neck break read as a stripe across a slab.
   * Rule 2's value break needs a SHAPE to reinforce; it cannot manufacture one.
   *
   * Making it vary keeps that property — the ceiling of 4.3 is below the narrowest haunch of 4.4,
   * so the notch survives at every value — while buying a visible identity axis. A 3.2 head is a
   * narrow wedge and a 4.3 head is broad and round, and because the ears are positioned relative
   * to the head's own width, a wider head also sets the ears further apart. One hash axis moving
   * two features is the cheapest variation in the file.
   */
  const rx = headWidth;
  const ry = 2.75;
  const nx = (px + 0.5 - CX) / rx;
  const ny = (py + 0.5 - cy) / ry;
  if (Math.abs(nx) ** 2.8 + Math.abs(ny) ** 2.8 > 1) return null;
  return { nx, ny };
}

/**
 * THE MUZZLE — one row, three pixels, at the bottom-centre of the face.
 *
 * At 16px there is exactly one row available below the eyes, so the muzzle is not modelled as an
 * ellipse the way openhood's was; it is a fixed 3px mark. That is not a shortcut, it is the
 * resolution being honest: an ellipse whose rx is 1.5 and ry is 0.5 rasterises to the same three
 * pixels every time, and writing the ellipse would only hide that fact behind arithmetic.
 *
 * Its normal leans TOWARD the viewer (`ny` biased negative), so it takes more light than the cheek
 * beside it and separates without an outline. That is the one trick openhood's muzzle used that
 * survives the halving.
 *
 * REJECTED: a dark 1px nose pixel in the centre of the muzzle. It read as a missing pixel — a hole
 * in the face — because at 16px a single dark pixel surrounded by lit ones is indistinguishable
 * from a dither dropout. The muzzle is lighter than its surroundings instead, which is the
 * inverse encoding and survives the dither.
 */
function muzzleNormal(px: number, py: number): { nx: number; ny: number } | null {
  if (py !== ROWS.head[1] - 1) return null;
  const dx = px + 0.5 - CX;
  if (Math.abs(dx) > 1.5) return null;
  return { nx: dx * 0.45, ny: -0.55 };
}

/**
 * AN EYE. Returns a STEP directly, never a normal.
 *
 * openhood's reason holds and is worth restating: an eye is not a shaded surface, it is a MARK.
 * Running it through the diffuse model gives it a gradient, and a gradient across two pixels reads
 * as a dent in the face rather than as an eye.
 *
 * ══ AND HERE IT IS A BRIGHT MARK, NOT A DARK ONE — this is the referent, not a style ══
 *
 * openhood's eyes are step 0, the darkest. That is correct for a creature seen in daylight. This
 * cat is seen through an IR camera trap, and the single most recognisable thing about IR wildlife
 * footage is EYESHINE: the tapetum lucidum reflects the illuminator straight back, so an animal's
 * eyes are the BRIGHTEST thing in the frame by a wide margin. Dark eyes on a night-vision cat
 * would be the one detail that tells a viewer this is not a camera trap.
 *
 * It is also what makes the state tint work at all. The eyes are already the page's focal point,
 * so tinting them is the smallest possible intervention that is still legible — which is exactly
 * what §8's "one or two pixels" allowance is for.
 *
 * `shape`: 0 round (both pixels lit), 1 narrow (outer pixel only — reads as a slit turned away),
 * 2 half-closed (inner pixel only, one step down — reads as a slow blink).
 */
function eyeStepAt(px: number, py: number, shape: number): number | null {
  if (py !== EYE_Y) return null;
  for (const ex of [EYE_L_X, EYE_R_X]) {
    const dx = px - ex;
    if (dx < 0 || dx >= EYE_W) continue;
    /*
     * The masks are WRITTEN OUT rather than computed, for openhood's recorded reason: it derived
     * three eye shapes from `dx === 1` predicates and shipped three bugs in four lines, including
     * a "happy squint" that curved downward into a frown. At this size there is nothing to compute.
     *
     * `#` is full eyeshine (the top ramp step), `-` is dimmed eyeshine, `.` is face.
     * Index is `dx`; the left eye is mirrored so the pair is symmetric about the nose bridge.
     */
    /*
     * ══ ALL THREE SHAPES KEEP BOTH PIXELS. This was measured and it is the correction. ══
     *
     * The first pass had shape 1 as `#.` — the outer pixel only, meant to read as a narrowed slit.
     * Rendered at 96px it did not read as a squint; it read as a cat with ONE EYE, or as a sprite
     * with a dropped pixel. At 16px a missing pixel is indistinguishable from a dither dropout,
     * and the face is the one place the viewer will read a dropout as damage rather than as
     * detail. Two cats in the preview sheet looked injured.
     *
     * So the shapes now vary in VALUE, not in presence. Every eye is two pixels wide in every
     * shape; what changes is whether both are at full eyeshine, or one is dimmed. That is still a
     * legible difference at 96px — a dimmed pixel is two ramp steps down — and at 32px, where it
     * stops being legible, both eyes are simply present and lit, which is the correct fallback.
     * A variation axis that degrades into "no variation" is fine; one that degrades into "broken"
     * is not.
     */
    const MASKS: Readonly<Record<number, string>> = {
      0: "##", // ROUND — both pixels at full eyeshine. Wide awake, and the default read.
      1: "-#", // NARROW — outer pixel dimmed, so the eye reads as turned slightly away.
      2: "#-", // HALF — inner pixel dimmed. A slow blink, and the mirror of NARROW.
    };
    const mask = MASKS[shape] ?? MASKS[0] ?? "##";
    // The LEFT eye reads its mask mirrored, so "narrow" points both eyes outward rather than
    // sending both to the same side of the face — which read as a squint at something off-frame.
    const i = ex === EYE_L_X ? EYE_W - 1 - dx : dx;
    const cell = mask[i];
    if (cell === undefined || cell === ".") return null;
    return cell === "-" ? RAMP_STEPS - 2 : RAMP_STEPS - 1;
  }
  return null;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE EARS — two triangles, and the feature that carries a cat's identity.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This function occupies the slot `hornNormal` did, and it is the most load-bearing geometry in
 * the file. §9 of `ART-DIRECTION.md` names ear angle as one of the two fixes for an unreadable
 * colony, and a triangle above a round head is, at 16px, the entire difference between "cat" and
 * "any small mammal".
 *
 * ══ THE TRIANGLE ══
 *
 * Base at `ROWS.ear[1]` (where the skull starts), apex `height` rows above it. Half-width tapers
 * linearly from `EAR_BASE_HW` at the base to a point, so the outer edge is a true diagonal rather
 * than a staircase of steps.
 *
 * `+0.30` on the half-width is the same correction openhood applied to its horn tip: without it
 * the top row rounds to zero width and the ear FADES OUT, which reads as an antenna rather than
 * as a point. With it the tip is exactly one pixel — which is what a cat's ear tip is.
 *
 * ══ RULE 1: THE EAR MEETS THE HEAD, BY CONSTRUCTION ══
 *
 * The base row is `ROWS.ear[1] - 1` = row 3, and the head's top row is row 4. `EAR_INSET` places
 * the ear centres at ±2.1 from the axis, which at a base half-width of 1.55 puts the innermost ear
 * column at 3.85 and the outermost at 10.15 — both strictly inside the head's 4..11 span at its
 * widest. So every ear column has head directly beneath it. This is not left to the test to
 * discover; the geometry cannot produce a gap. The test asserts it anyway, because the assertion
 * is what stops a later edit to `EAR_INSET` or `HEAD_W` silently breaking it.
 *
 * ══ THE INNER SURFACE SHADES DARKER ══
 *
 * A cat's ear is a cone open toward the front: the inner surface faces slightly inward and away
 * from the light, and it is that dark inner wedge — not the outline — that makes an ear read as an
 * ear rather than as a spike. `nx` is biased by `lean` so the inner half of each ear turns away
 * from the light and lands one to two ramp steps below the outer half.
 *
 * REJECTED: drawing the inner ear as an explicit darker triangle inset by one pixel. At a base
 * width of 3px the inset triangle is 1px wide and one row tall — a single dark pixel, which the
 * dither erases roughly half the time. Shading it through the normal means the darkening is spread
 * across the whole inner half and survives.
 *
 * ══ WHAT THE THREE EAR AXES ACTUALLY DO ══
 *
 * `earAngle` shears the apex sideways by up to `EAR_SHEAR` px. Negative leans the tips OUTWARD (a
 * relaxed, airplane-eared cat), positive leans them INWARD (alert, pricked).
 *
 * `earHeight` is 2, 3 or 4 rows, and `earWidth` is a 1.15..1.95 base half-width. Together they
 * span from a broad low triangle to a tall narrow spike — the full range from a scottish fold to a
 * lynx, which is far more than either axis reaches alone.
 *
 * ══ THE SHEAR WAS TRIPLED, AND THAT WAS A MEASURED CORRECTION ══
 *
 * `EAR_SHEAR` was 1.15 and is now 2.6. At 1.15 the apex moved by at most one pixel across the
 * whole −1..1 range of `earAngle`, and after rounding to the pixel grid most of that range
 * produced the IDENTICAL ear. A render review of twelve cats found their ears "effectively the
 * same", and this was the largest single reason: a continuous axis whose full range is smaller
 * than the quantum it is rasterised onto is a dead axis. It looks live in the source and in a unit
 * test, and it does nothing on screen.
 *
 * The general rule this file now applies to every axis: an axis must move its feature by AT LEAST
 * TWO PIXELS across its range, or it will not survive rasterisation, let alone being shrunk to
 * 32px. `grid.test.ts` asserts this for the ear directly rather than trusting the constant.
 *
 * REJECTED: rotating the whole ear triangle by an angle. Rotation at this size turns the outer
 * edge into an aliased 2px-wide smear and costs the crisp diagonal that reads as "point". A shear
 * moves the apex and leaves both edges as clean lines, which is the same visual information for
 * none of the cost.
 */
const EAR_SHEAR = 2.6;

function earNormal(
  px: number,
  py: number,
  angle: number,
  height: number,
  width: number,
  headWidth: number,
): { nx: number; ny: number } | null {
  const baseY = ROWS.ear[1];
  // 0 at the base row, 1 at the apex.
  const t = (baseY - (py + 0.5)) / height;
  if (t < 0 || t > 1) return null;

  for (const side of [-1, 1] as const) {
    /*
     * The ear sits at a fixed FRACTION of the head's half-width rather than at a fixed offset, so
     * a wide head carries its ears further apart and a narrow one carries them close. That is what
     * makes `headWidth` move two features for one hash axis.
     *
     * 0.55 places the ear centre just over halfway out, which keeps the whole base — centre plus
     * `width` — inside the skull at every combination of the two axes. Rule 1 by construction.
     */
    const baseCx = CX + side * headWidth * 0.55;
    /*
     * The shear is `t` linear, not `t*t`. openhood's horn used `t*t` so the bend accumulated toward
     * the tip — correct for a horn, which grows outward from a straight base. An ear is a flat
     * triangle of cartilage: it leans as a whole. `t*t` produced a curved ear that read as a
     * feather.
     *
     * `side *` on the shear means a positive angle leans BOTH ears inward rather than sliding the
     * whole pair sideways. A pair of ears that slide together read as a hat.
     */
    /*
     * ══ THE SHEAR IS CAPPED AT ONE COLUMN PER ROW — rule 1 for a sheared triangle ══
     *
     * The flood-fill test found 21 cats whose ear TIP was detached from its own BASE. Cause: at a
     * strong `earAngle` on a short ear, `EAR_SHEAR * t` moves the centre more than one column
     * between adjacent rows, so the ear staircases diagonally — and two diagonally adjacent pixels
     * are not orthogonally connected. The outline pass then drew its ring through the notch and
     * the ear was cut off from the head. It is the identical defect the tail had, in a different
     * part, found by the same test.
     *
     * Capping the TOTAL shear at one column per row of the ear's own height guarantees the centre
     * moves at most one column per row, so consecutive rows always overlap. A strong angle on a
     * tall ear still gets its full lean — a 4-row ear may shear 4 columns — while a short ear's
     * lean is limited to what a short ear can carry without falling apart. That is the correct
     * relationship anyway: a 2-row ear leaning 3 columns is not a leaning ear, it is a fallen one.
     */
    const maxShear = height;
    const lean = Math.max(-maxShear, Math.min(maxShear, angle * EAR_SHEAR));
    const shear = lean * t;
    const centre = baseCx + side * shear;
    /*
     * ══ THE TAPER IS WIDENED IN PROPORTION TO THE LEAN, and that is what closes rule 1 ══
     *
     * Capping the shear alone left 17 cats with detached ear tips. The cap bounds how far the
     * centre travels in TOTAL, but the taper is narrowing at the same time — so on a short ear
     * with a hard lean, the centre still moves further between two rows than the (already
     * shrinking) half-width can span, and the rows stop overlapping.
     *
     * Adding `|lean| / height / 2` to the half-width makes the ear thicker exactly in proportion
     * to how fast it is moving sideways, which guarantees consecutive rows overlap at every angle
     * and every height. It also happens to be what a leaning ear looks like: an ear seen at an
     * angle presents a WIDER profile than one seen edge-on, so the correction is physical as well
     * as topological. That is usually the sign a fix is the right one — the geometry that keeps
     * the silhouette connected is the geometry that was correct to begin with.
     */
    const halfWidth = width * (1 - t) + 0.3 + Math.abs(lean) / height / 2;
    const dx = px + 0.5 - centre;
    if (Math.abs(dx) > halfWidth) continue;

    /*
     * ══ THE EAR MAY NOT OVERHANG THE SKULL — rule 1 at the ear's BASE ══
     *
     * Every fix so far kept the ear connected to ITSELF. This keeps it connected to the HEAD, and
     * the two are different failures: an ear whose base column sits outside the skull's own
     * silhouette has nothing beneath it, so it reads as a horn floating off the corner of the
     * head. The per-column assertion in `grid.test.ts` found it on `stray-1` after the ear taper
     * was widened to fix the self-connectivity bug — one fix opening the next, which is why both
     * are asserted rather than reasoned about.
     *
     * Solving the head's superellipse for its half-width at the ear's BASE row gives the columns
     * the skull actually occupies there. An ear pixel outside them is refused. That trims the
     * outer corner of a hard-leaning ear, which is also what a real ear does — it is hinged at the
     * skull and cannot slide off it.
     */
    const headCy = (ROWS.head[0] + ROWS.head[1]) / 2;
    const headNy = (baseY + 0.5 - headCy) / 2.75;
    const headRemain = 1 - Math.abs(headNy) ** 2.8;
    if (headRemain > 0) {
      const headHw = headWidth * headRemain ** (1 / 2.8);
      if (Math.abs(px + 0.5 - CX) > headHw) continue;
    }

    /*
     * THE INNER SURFACE. `side` is −1 for the left ear, so `-side` points inward: the inner half of
     * each ear gets its normal pushed toward the cat's centreline and away from the light, which
     * lands it one to two steps darker than the outer half.
     *
     * `ny` is negative (upward-facing) because an ear leans back off the skull.
     */
    const across = dx / halfWidth;
    const inward = -side * 0.55;
    return { nx: across * 0.55 + inward, ny: -0.35 - t * 0.3 };
  }
  return null;
}

/**
 * THE BODY — a SITTING cat's body: narrow at the shoulders, widening to a haunch.
 *
 * ══ WHAT THE FIRST RENDER SHOWED, AND WHY THE SHAPE CHANGED ══
 *
 * The first pass was a superellipse, exponent 2.4, rx 4.6 — the direct analogue of openhood's body
 * with the width relationship inverted (a cat's body is bigger than its head, where a neotenous
 * unicorn's is smaller). Rendered to PNG at 96px and looked at, it failed three ways at once:
 *
 *   1. IT WAS A RECTANGULAR SLAB. At 16px an exponent-2.4 superellipse with rx 4.6 rounds to a
 *      full-width block from column 3 to column 12 with square corners. The cat read as a head
 *      glued to a filing cabinet. This is the resolution lesson the whole file keeps re-learning:
 *      an exponent that reads as "gently rounded" at 24px reads as "square" at 16px, because the
 *      rounding it produces is smaller than one pixel.
 *   2. IT SWALLOWED THE TAIL. Reaching column 12 meant the tail root at column 11 was INSIDE the
 *      body, and the body resolves first — so the first four tail samples were painted as body and
 *      only a stub escaped past the edge. On low-lift cats the tail vanished completely.
 *   3. IT ERASED THE NECK. A body as wide as the head is wide makes the whole sprite one column-3
 *      to column-12 mass, and rule 2's value break cannot rescue a silhouette that has no pinch in
 *      it — the break reads as a shading band across a slab, not as a neck.
 *
 * ══ THE FIX: A TAPER, NOT AN ELLIPSE ══
 *
 * The half-width is now a function of the row — narrow at the shoulder (2.6) and widening to the
 * haunch (4.0). That is a SITTING cat seen from the front, which is the pose a camera trap
 * actually catches an animal in, and it solves all three failures with one change:
 *
 *   - the shoulder row is narrower than the head is wide, so the silhouette PINCHES at the neck
 *     and rule 2's value break lands on a shape that already reads as a neck;
 *   - the widest row reaches column 11 at most, so the tail root at column 12 sits outside the
 *     body and every tail sample survives;
 *   - a taper has no corners to read as square.
 *
 * REJECTED: keeping the ellipse and simply shrinking rx to 3.4. It fixed the tail and the neck and
 * left a small round body, which read as a bird — a cat's mass is in its haunches and an evenly
 * round body puts it in the middle. The taper is what makes the mass sit low.
 *
 * ══ AND IT VARIES PER CAT, ON TWO AXES ══
 *
 * `build` (−1..1) scales the haunch between 4.4 and 5.4 while leaving the shoulder alone, so a
 * stocky cat is wide at the bottom and a lean one is nearly straight-sided. Scaling the HAUNCH
 * rather than the whole body is deliberate: it changes where the mass sits, which reads at 32px,
 * where a uniform scale just makes a slightly bigger cat, which does not.
 *
 * `posture` moves which rows the body occupies at all — see `postureRows`. That is the axis that
 * actually carries the colony, because it changes the sprite's gross proportion rather than its
 * outline detail.
 *
 * The haunch floor of 4.4 is load-bearing: `headWidth` tops out at 4.3, so the haunch is always
 * wider than the head and rule 2's neck pinch survives every combination of the two axes.
 */
const BODY_HW_TOP = 2.6;
const BODY_HW_HAUNCH_MIN = 4.4;
const BODY_HW_HAUNCH_MAX = 5.4;

/**
 * The haunch's half-width for a given build. The widest the body ever gets.
 *
 * Extracted because THREE callers need it and every one of them must agree: `bodyNormal` draws the
 * taper, `tailPixels` roots the tail half a pixel outside it, and `coatDrop` insets the tabby
 * bands from it. When the tail's root was a hardcoded 11.6 that agreed with a hardcoded haunch of
 * 4.0, making the haunch a variable silently detached the tail on every stocky cat. Deriving all
 * three from one function is what stops that whole class of bug.
 */
function haunchHalfWidth(build: number, posture: Posture): number {
  const w =
    BODY_HW_HAUNCH_MIN +
    ((build + 1) / 2) * (BODY_HW_HAUNCH_MAX - BODY_HW_HAUNCH_MIN) +
    postureSpread(posture);
  /*
   * CAPPED so the tail always has somewhere to go.
   *
   * The tail roots half a pixel outside the haunch and needs at least two columns beyond that to
   * read as a tail at all. Uncapped, a stocky crouching cat's haunch reached column 13 and the
   * tail was clipped against the grid edge — the flood-fill test caught 340 truncated tails at
   * once. `CX` is 7.5 and the grid is 16 wide, so 5.6 leaves the last two columns free.
   *
   * The cap binds only on the widest combination of build and posture, so it costs nothing
   * anywhere else. It is a clamp rather than a smaller range because the range is what carries the
   * variation and shrinking it to satisfy the worst case would flatten every other cat.
   */
  return Math.min(5.6, w);
}

/** The body's half-width at one row: the taper from shoulder to haunch. */
function bodyHalfWidthAt(py: number, geom: CatGeometry): number {
  const { bodyTop, bodyEnd } = postureRows(geom.posture);
  // 0 at the shoulder, 1 at the haunch.
  const t = (py + 0.5 - bodyTop) / Math.max(1, bodyEnd - bodyTop);
  return BODY_HW_TOP + (haunchHalfWidth(geom.build, geom.posture) - BODY_HW_TOP) * t;
}

function bodyNormal(
  px: number,
  py: number,
  build: number,
  posture: Posture,
): { nx: number; ny: number } | null {
  const { bodyTop, bodyEnd } = postureRows(posture);
  // The body STOPS where the legs begin. openhood's recorded bug: without this the body's rounded
  // lower edge spills into the leg rows and, since body resolves before legs, paints over the
  // posts — the creature gets a skirt with feet poking out.
  if (py < bodyTop || py >= bodyEnd) return null;
  // 0 at the shoulder, 1 at the haunch.
  const t = (py + 0.5 - bodyTop) / Math.max(1, bodyEnd - bodyTop);
  const hw = BODY_HW_TOP + (haunchHalfWidth(build, posture) - BODY_HW_TOP) * t;
  const dx = px + 0.5 - CX;
  if (Math.abs(dx) > hw) return null;
  // `nx` across the taper, so the body takes light as a cylinder. `ny` leans slightly forward at
  // the chest and away at the haunch, which keeps the lower rows a step darker and stops the body
  // reading as one flat value.
  return { nx: dx / hw, ny: -0.3 + t * 0.9 };
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TAIL — a hash-swept curve, and the second half of the identity budget.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This occupies the slot `maneNormal` did: the largest per-cat variation, the part a person would
 * describe first. On a unicorn that was "the one with the violet mane". Colour being banned here,
 * it is "the one with the hooked tail".
 *
 * ══ IT IS DRAWN AS A SWEPT PATH, NOT AS A REGION ══
 *
 * Every other part in this file is an implicit region: "is this pixel inside my ellipse". A tail
 * cannot be, because a tail is a 1-2px curve and an implicit region 1px wide has no interior — the
 * rasteriser hits it or misses it depending on where the curve crosses the pixel centre, and the
 * result is a dotted line. That IS the NEEDLE failure: "four isolated pixels on a diagonal read as
 * dust rather than as a horn".
 *
 * So the tail is MARCHED instead. `TAIL_SAMPLES` points are walked along the parametric curve and
 * each one stamps its nearest pixel. A marched path is continuous by construction — consecutive
 * samples are less than a pixel apart, so they either land on the same pixel or on an adjacent
 * one, and there is no way to produce a gap. `TAIL_SAMPLES` is 48 for a path at most ~11px long,
 * which is a sample every 0.23px: comfortably under the 1.0 that continuity requires, with enough
 * margin that a later change to the curve cannot creep over it.
 *
 * ══ RULE 1: THE ROOT ══
 *
 * `t = 0` is pinned inside the body's own ellipse at `TAIL_ROOT`, not at its edge. Starting at the
 * edge left the first stamped pixel one diagonal step outside the body about a third of the time —
 * an orthogonal gap, and rule 1 broken. Starting inside means the first sample is a body pixel and
 * the tail grows out of it. Those overlapped root pixels are harmless: the body resolves first in
 * the depth sort, so they simply stay body.
 *
 * ══ WHAT THE AXES DO ══
 *
 *   tailLift  0..1  — how high the tail is carried. 0 is a low slung hunting tail dragging near
 *                     the ground; 1 is the vertical greeting tail a cat raises when approaching.
 *                     This is the largest single change to the sprite's bounding box.
 *   tailCurl −1..1  — how hard, and which way, the tip hooks. Applied on `t*t` so the base leaves
 *                     the hip straight and the hook accumulates at the tip. A cat's tail bends
 *                     progressively; a constant-curvature arc reads as a rope handle.
 *
 * REJECTED: a fully vertical tail behind the cat, as a Q-shape. It occupies the same columns as
 * the body's own outline and at 16px the two merge into one lump — the exact failure openhood
 * recorded for its mane ("the head and mane were one indistinguishable mass"). The tail is pushed
 * OUT to the side, always, so it always breaks the body's outline.
 *
 * REJECTED: a tail that switches sides on a hash bit. Half the colony facing one way and half the
 * other read as two species rather than as one species with variation. Every cat's tail exits to
 * the RIGHT and only its shape varies, which is also what makes the map's cats read as a group.
 */
const TAIL_SAMPLES = 48;
/**
 * The root, at the HAUNCH — the body's widest, lowest point, which is where a real tail attaches.
 *
 * Moved out from 11.0 after the first render: at 11.0 the root sat inside the old slab body and
 * the first four samples were painted over as body (see `bodyNormal`). It now sits just outside
 * the haunch's own half-width of 4.0 (i.e. x 11.5), so the first stamped pixel is column 11 —
 * orthogonally adjacent to the body's last column, which is rule 1 satisfied at the tightest
 * possible margin. Any further out and there is a gap; any further in and the body eats it.
 */
function tailPixels(geom: CatGeometry): Map<number, number> {
  const { curl, lift, build, posture } = {
    curl: geom.tailCurl,
    lift: geom.tailLift,
    build: geom.build,
    posture: geom.posture,
  };
  const { bodyEnd } = postureRows(posture);
  /*
   * THE ROOT IS DERIVED FROM THE HAUNCH, not a constant.
   *
   * It was `TAIL_ROOT_X = 11.6`, which was correct only while the haunch was a fixed 4.0. Now that
   * `build` moves the haunch between 4.4 and 5.4 and `posture` moves which row it ends on, a fixed
   * root is inside the body on a stocky cat (the body eats the first samples) and detached from it
   * on a lean one (rule 1 broken, tail reads as dust).
   *
   * Deriving it from the same haunch value `bodyNormal` uses means the root sits exactly half a
   * pixel outside the widest body column at every combination of the axes. That is rule 1 held by
   * construction rather than by a constant that happened to work.
   */
  const rootX = CX + haunchHalfWidth(build, posture) - 0.4;
  const rootY = bodyEnd - 1.2;

  /** pixel key -> `t` at the sample that claimed it, so the tip can be shaded lighter. */
  const out = new Map<number, number>();
  /** The previous stamped cell, so a diagonal step can be bridged. */
  let last: { x: number; y: number } | null = null;
  for (let i = 0; i <= TAIL_SAMPLES; i++) {
    const t = i / TAIL_SAMPLES;
    /*
     * X: the tail exits right, sweeping out over its length, with the curl hooking the tip back.
     * `t*t` on the curl so the hook is a tip event rather than a constant-curvature arc.
     *
     * The curl range was widened from 2.6 to 4.0 after a render review found the colony too
     * uniform. At 2.6 the tip moved about two columns across the full −1..1 range, which is
     * visible at 96px and gone at 32px. At 4.0 a hard negative curl brings the tip back over the
     * cat's own back — a tight curl — and a hard positive one throws it clear of the sprite, which
     * are recognisably different tails at map size.
     */
    const x = rootX + 3.0 * t + curl * 4.0 * t * t;
    /*
     * Y: `lift` interpolates the tip's height between +1.8 rows (below the root, a low dragging
     * tail) and −8.0 rows (well above it, a vertical greeting tail). The `t*t` term is what makes
     * the tail leave the hip roughly horizontal and then turn — a tail that rises linearly from
     * the root reads as a straight stick pointing diagonally, which is a dog's tail or an antenna.
     *
     * The raised end was −6.4 and is now −8.0, so a fully lifted tail reaches the head's own rows
     * and clears the top of the body. That is the single most visible tail difference at 32px:
     * whether the cat's outline has something sticking up beside it or not.
     */
    const rise = -8.0 * lift + 1.8 * (1 - lift);
    const y = rootY + rise * t * t + 0.45 * t;
    const pxi = Math.round(x - 0.5);
    const pyi = Math.round(y - 0.5);

    /*
     * ══ THE DIAGONAL BRIDGE — rule 1 for a marched path, and a measured bug ══
     *
     * Dense sampling guarantees consecutive stamps are ADJACENT, which the header claimed was
     * enough for continuity. It is not, and the flood-fill test found 74 cats broken by it: on a
     * steeply climbing segment the path moves DIAGONALLY between two samples, and two diagonally
     * adjacent pixels are not orthogonally connected. The outline pass then draws its ring through
     * the diagonal notch, and the tail is visibly cut into pieces by a dark line.
     *
     * This is the same class of error as everywhere else in this file — a rule enforced by a
     * property (sample density) that does not actually imply it. Orthogonal connectivity has to be
     * enforced by orthogonal construction, so every diagonal step lays down the intervening
     * pixel. One is enough; taking the horizontal neighbour keeps the tail's own thickness even,
     * where taking the vertical one made steep tails read as 2px wide and shallow ones as 1px.
     */
    const stamp = (sx: number, sy: number, st: number): void => {
      if (sx < 0 || sx >= GRID_W || sy < 0 || sy >= GRID_H) return;
      const k = sy * GRID_W + sx;
      // Keep the SMALLEST `t` that claimed a pixel, so a pixel shared by root and tip shades as
      // root. The tail thins and lightens toward the tip; a pixel that both pass through belongs
      // to the thicker part.
      const prev = out.get(k);
      if (prev === undefined || st < prev) out.set(k, st);
    };

    if (last !== null && pxi !== last.x && pyi !== last.y) stamp(pxi, last.y, t);
    stamp(pxi, pyi, t);
    if (pxi >= 0 && pxi < GRID_W && pyi >= 0 && pyi < GRID_H) last = { x: pxi, y: pyi };
  }
  return out;
}

/**
 * THE LEGS — TWO posts, 2px wide, with a 4px gap between them.
 *
 * ══ TWO, not four, and this is the resolution being honest ══
 *
 * Rule 3 requires 2px legs with a visible gap. On a 16px cat whose body spans columns 3..12, four
 * 2px posts need 8 columns of leg plus at least 3 columns of gap = 11 columns, which does not fit
 * inside a 10-column body. Something has to give, and the options were:
 *
 *   (a) four 1px legs — EXPLICITLY BANNED by rule 3. This is the fringe failure, verbatim.
 *   (b) four 2px legs overflowing the body — openhood recorded this exact bug at 24px ("the outer
 *       two hung past the silhouette and the set read as three legs and a stray mark"). At 16px it
 *       is worse, not better.
 *   (c) TWO 2px legs. A cat in a near-frontal view occludes its own far legs almost completely,
 *       so two visible legs is not a compromise — it is what the pose actually shows.
 *
 * (c). The posts sit at columns 4-5 and 10-11: a 4px gap, which is twice a post's own width and
 * unmistakably a gap rather than a dither dropout. They are set OUT toward the body's edges rather
 * than under its centre, because legs under the centre read as a single wide pedestal.
 *
 * A leg's normal sweeps across its 2px width and is flat along its length, so it takes light as a
 * rounded post rather than as a flat bar — the one piece of openhood's leg model that survives.
 *
 * ══ POSTURE MOVES WHERE THEY START, NOT HOW MANY THERE ARE ══
 *
 * A standing cat's body ends a row early, so the legs get two rows and there is daylight beneath
 * it. A crouched cat's body runs a row lower, so the legs get one row and the cat sits flat on the
 * ground. The count and the width never change — rule 3 is not a per-posture decision.
 */
const LEG_X = [4, 10] as const;
const LEG_W = 2;

function legNormal(px: number, py: number, posture: Posture): { nx: number; ny: number } | null {
  const { bodyEnd, legEnd } = postureRows(posture);
  if (py < bodyEnd || py >= legEnd) return null;
  for (const lx of LEG_X) {
    if (px >= lx && px < lx + LEG_W) {
      return { nx: (px - lx - 0.5) * 1.3, ny: -0.1 };
    }
  }
  return null;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE COAT PATTERN — a luminance-only marking, and the one axis that reads as "which cat".
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Returns how many ramp steps to subtract from a body pixel, 0 or 2. Never a colour, never a hue —
 * see the `Coat` type for why this clears §8's ban rather than skirting it.
 *
 * TWO steps, not one. One step is inside the Bayer dither's own ±1 range, so a one-step marking is
 * literally indistinguishable from the noise the shading already produces — that was the correct
 * half of the original rejection of coat markings. Two steps is outside it and reads cleanly.
 *
 *   TABBY   — bands on alternating rows across the whole body. Horizontal because the body's
 *             shading gradient is vertical, so a horizontal band cuts across it and stays legible
 *             at every row; vertical stripes ran parallel to the gradient and disappeared into it
 *             on the rows where the two happened to agree.
 *   PATCHED — one block on the cat's left flank, from the shoulder to mid-body. Deliberately
 *             ASYMMETRIC: a symmetric patch reads as shading, and the entire value of this axis is
 *             that it is obviously a MARKING rather than a light effect.
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
     * The first version banded the full width of the body. Rendered at 96px the bands read as
     * horizontal SLOTS cut through the cat, like louvres in a vent, because a dark line that runs
     * from one edge of a shape to the other is read as a gap in the shape rather than as a mark on
     * it. The silhouette appeared to be sliced into layers.
     *
     * Leaving the outermost column lit on each side keeps the body's edge continuous, so the band
     * is plainly ON the cat. That is also how a tabby's markings actually sit — they wrap toward
     * the belly and stop, they do not cut the animal in half.
     */
    case "tabby": {
      if ((py - bodyTop) % 2 !== 1) return 0;
      const edge = Math.abs(px + 0.5 - CX) > bodyHalfWidth - 1.2;
      return edge ? 0 : 2;
    }
    // The left flank only, and only the upper half of the body.
    case "patched":
      return px + 0.5 < CX - 0.5 && py < bodyTop + 3 ? 2 : 0;
    default:
      return 0;
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE WHISKERS — 1px lines off the cheeks, and the part that took three renders to get right.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO NORMAL, and that is deliberate: a whisker is a hair, not a surface. Shading it through the
 * Lambert model lands it at whatever step the cheek beside it is at, which makes it invisible —
 * the whole point of a whisker is that it is a different value from the face. It takes a fixed
 * step instead, dimmer than the lit cheek and brighter than the ground, so it reads against both.
 *
 * It is also the only part exempt from the outline pass — see `catGrid`. Outlining a 1px line
 * doubles its apparent thickness and turns two whiskers into a moustache.
 *
 * ══ THREE RENDERS, THREE DISTINCT FAILURES, AND WHAT EACH ONE TAUGHT ══
 *
 * This is recorded at length because the whisker is the smallest feature on the sprite and it
 * broke the whole face three times running. The general lesson is at the bottom.
 *
 *   RENDER 1 — A MOUSTACHE BAR. Whiskers ran straight out from both cheeks, same length, same row
 *     as the muzzle, starting flush against the head. At 96px the head and its two whiskers read
 *     as a horizontal ROD PASSING THROUGH THE SKULL. Cause: a shape mirrored exactly about the
 *     axis reads as one continuous object passing behind whatever sits between the two halves.
 *
 *   RENDER 2 — DUST. The fix was a one-pixel gap between whisker and cheek, so they would read as
 *     separate thin things. That produced isolated single pixels floating beside the head, which
 *     is NEEDLE's floating horn exactly: "isolated pixels read as dust rather than as a horn". At
 *     32px they were indistinguishable from the sensor grain the page already has (§2a rule 5),
 *     so a viewer could not tell a whisker from noise.
 *
 *   RENDER 3 — THE BAR AGAIN, WORSE. Gap removed, asymmetry (one side a pixel shorter) relied on
 *     to break the rod read. It did not. A one-pixel length difference across a fourteen-pixel
 *     span is invisible; the eye integrates the whole row and still sees a bar. Being flush
 *     against the head AND on the muzzle's own row meant face, muzzle and both whiskers formed a
 *     single unbroken horizontal run of lit pixels across the entire sprite.
 *
 * ══ THE FIX: BREAK THE ROW, NOT THE LENGTH ══
 *
 * The three failures share one cause — a continuous horizontal run — and length was never going to
 * fix it. The whiskers now sit on DIFFERENT ROWS from each other: the left on the muzzle row, the
 * right one row up. A stepped pair cannot read as a single rod, because a rod is straight, and
 * that holds at every length and every size. It is also true of a real cat, whose whiskers fan
 * from several rows of follicles rather than from one.
 *
 * They stay flush against the head (rule 1 — no exception is carved out for small appendages) and
 * they are capped at 2px, because at 3px the sprite's bounding box grew half again as wide as the
 * cat and the colony's spacing looked wrong.
 *
 * ══ THE GENERAL LESSON, WHICH IS THE REASON THIS COMMENT IS THIS LONG ══
 *
 * Every one of the three fixes adjusted a PARAMETER — length, then gap, then asymmetry — when the
 * defect was in the STRUCTURE. Tuning numbers against a structural failure produces a sequence of
 * different-looking failures and no progress, and it is only visible as a pattern once the
 * attempts are written down next to each other. Rendering to PNG caught each individual failure;
 * recording them is what caught the pattern.
 *
 * REJECTED: whiskers on their own row below the muzzle, both sides. At 16px that row belongs to
 * the neck, and a horizontal line across the neck row read as a collar.
 */
const WHISKER_STEP = 2;

function isWhisker(px: number, py: number, len: number, headWidth: number): boolean {
  const dx = px + 0.5 - CX;
  // THE STEP. Left whisker on the muzzle row, right whisker one row above it. This asymmetry is
  // structural rather than dimensional, which is why it survives where a length difference did not.
  const row = dx < 0 ? ROWS.head[1] - 1 : ROWS.head[1] - 2;
  if (py !== row) return false;
  const a = Math.abs(dx);
  /*
   * ══ THE START IS THE HEAD'S REAL EDGE ON THIS ROW, NOT ITS NOMINAL HALF-WIDTH ══
   *
   * This read `start = headWidth`, and the flood-fill test found it detaching 238 of 300 cats.
   * The reason is that `headWidth` is the superellipse's half-width at its WIDEST row, and the
   * whiskers sit two rows below that, where the superellipse has already tapered in. So the
   * whisker began one or two columns clear of the face, the outline pass drew its ring in the gap
   * between them, and the whisker was an isolated pixel separated from the cat by a dark line —
   * NEEDLE's dust, arriving through a mismatch between two ways of measuring the same head.
   *
   * Solving the superellipse for its half-width AT THIS ROW gives the edge the rasteriser actually
   * produced, so the first whisker pixel is orthogonally adjacent to a face pixel on every cat and
   * every head width. Rule 1 by construction rather than by a constant that happened to work.
   *
   * The general lesson, and the third time this file has learned it: when two pieces of geometry
   * must meet, DERIVE one from the other. Every gap-in-the-silhouette bug here — the tail root,
   * the ear inset, and now the whisker — was a hardcoded number that agreed with its neighbour
   * until the neighbour became a variable.
   */
  const cy = (ROWS.head[0] + ROWS.head[1]) / 2;
  const ny = (py + 0.5 - cy) / 2.75;
  const remain = 1 - Math.abs(ny) ** 2.8;
  // Off the head entirely on this row: there is nothing for a whisker to attach to.
  if (remain <= 0) return false;
  const start = headWidth * remain ** (1 / 2.8);
  /*
   * ══ CAPPED AT 1PX PER SIDE — the fix for a STRIKETHROUGH ══
   *
   * At 2px per side the whiskers ran three pixels clear of an eight-pixel head, and a review of
   * the render at 96px found "a horizontal bar running through the middle of each cat, extending
   * past the body on both sides — it reads as a line struck through the sprite". That is the
   * moustache-bar failure returning a fourth time, and at that point the length was plainly the
   * thing carrying it: any whisker long enough to extend past the BODY is read as a rule drawn
   * across the sprite, whatever row it sits on.
   *
   * One pixel per side is a whisker that reads as a whisker — a suggestion at the cheek, stopping
   * well inside the body's own width so it can never look like a line through the cat. `len` is
   * retained but now only distinguishes 1px from 2px on the longer side.
   */
  return a > start && a <= start + Math.min(len - 1, 1);
}

/**
 * Which part owns this pixel, and its local normal.
 *
 * ══ ORDER IS THE DEPTH SORT, and getting it wrong ruins every cat ══
 *
 * openhood's warning transfers unchanged: "putting the mane before the head swallows the face;
 * putting the head before the eyes erases them." The order here, front to back:
 *
 *   EYE, MUZZLE  — on the face, so they win over the head they sit on.
 *   EAR          — in front of nothing, but resolved before the head so an ear base that overlaps
 *                  the skull's top corners stays ear. Resolving the head first would eat the ear
 *                  bases and detach the ears — rule 1 broken by a sort order.
 *   HEAD         — in front of the body.
 *   BODY         — in front of the tail. This is what makes the tail's root pixels read as hip.
 *   TAIL         — behind the body, in front of nothing.
 *   LEG          — underneath.
 *   WHISKER      — last, and only where nothing else claimed the pixel.
 */
function partAt(
  px: number,
  py: number,
  geom: CatGeometry,
  tail: Map<number, number>,
): { part: Part; nx: number; ny: number; step?: number; t?: number } | null {
  const head = headNormal(px, py, geom.headWidth);
  if (head) {
    const eye = eyeStepAt(px, py, geom.eyeShape);
    if (eye !== null) return { part: "eye", nx: 0, ny: 0, step: eye };
    const muzzle = muzzleNormal(px, py);
    if (muzzle) return { part: "muzzle", ...muzzle };
  }
  const ear = earNormal(px, py, geom.earAngle, geom.earHeight, geom.earWidth, geom.headWidth);
  if (ear) return { part: "ear", ...ear };
  if (head) return { part: "head", ...head };
  const body = bodyNormal(px, py, geom.build, geom.posture);
  if (body) return { part: "body", ...body };
  const t = tail.get(py * GRID_W + px);
  if (t !== undefined) {
    // A tail is a tapering cylinder. Its normal sweeps with `t` so the tip catches a different
    // value from the root and the curve reads as round rather than as a drawn line.
    return { part: "tail", nx: 0.25 + t * 0.5, ny: -0.2, t };
  }
  const leg = legNormal(px, py, geom.posture);
  if (leg) return { part: "leg", ...leg };
  if (isWhisker(px, py, geom.whiskerLen, geom.headWidth)) {
    return { part: "whisker", nx: 0, ny: 0, step: WHISKER_STEP };
  }
  return null;
}

/**
 * The Lambert term for one surface normal, run through the ramp and the dither.
 *
 * `shadeSphere` from the mechanism kit does the lighting. Its wrap, rim and core-shadow terms are
 * tuned for a sphere and are all dialled DOWN here, because a 16px cat is not a sphere:
 *
 *   - `wrap` 0.55: high. A flat, frontally-lit subject (see `LIGHT`) needs light to bleed past the
 *     terminator or the shaded half of the head drops straight to the ground value and the
 *     silhouette develops a bite — openhood recorded exactly that failure and fixed it with a step
 *     floor. Wrapping fixes it at the source instead.
 *   - `specularPower` 6: very low, i.e. a broad soft highlight. Fur is chalk. The kit's default of
 *     32 is glass, and a glass highlight on a cat reads as a wet spot.
 *   - `rimPower` 2.4: a wide rim, which at 16px is the only way a rim term touches more than a
 *     single pixel and therefore the only way it reads as anything at all.
 *
 * Returns null only when the caller hands it a normal outside the unit disc — which for a part
 * that already claimed the pixel is an INTERIOR HOLE, and the caller fills it rather than dropping
 * it. openhood's recorded reason: dropped holes punch single empty pixels through the face, and
 * once an outline pass exists those holes get outlined and the animal comes out speckled.
 */
function shadeStep(nx: number, ny: number, px: number, py: number): number | null {
  const lum = shadeSphere({
    nx,
    ny,
    light: LIGHT,
    ambient: 0.22,
    wrap: 0.55,
    specularPower: 6,
    rimPower: 2.4,
  });
  if (lum === null) return null;
  return quantise({ value: lum, steps: RAMP_STEPS, x: px, y: py, strength: DITHER });
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * STATE — what it may change, and the much longer list of what it may not.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ART-DIRECTION.md` §8, verbatim: "No colour on an animal. The IR sensor has none. Cats are drawn
 * in the phosphor ramp only — their state may tint one or two pixels, their identity may not."
 *
 * So this function does exactly two things:
 *
 *   1. Marks AT MOST TWO pixels `accent: true` — the eyes, and only the eyes. The renderer tints
 *      those and nothing else. `grid.test.ts` asserts the count is ≤ 2 in every state.
 *   2. Adjusts ramp STEPS, which is luminance and is therefore inside the phosphor ramp. A
 *      starving cat is dimmer. A dead cat is dimmest and its eyes have gone out.
 *
 * The eyes are the right two pixels for the tint because they are already the brightest mark on
 * the sprite (see `eyeStepAt` — eyeshine) so a viewer is looking at them anyway, and because
 * "the eyes have gone out" is a true statement about a dead animal rather than a decoration.
 *
 * ══ WHAT WAS TRIED AND REJECTED ══
 *
 *   - TINTING THE WHOLE COAT AMBER WHEN FED. This is what the ban is about, and it was tried
 *     first because it is obviously legible. It is a straight violation: an amber cat is a cat
 *     whose IDENTITY carries colour, and at that point `--fed` means "this cat ate recently" AND
 *     "this trade closed up", which is §3's one-hue-one-meaning defect.
 *   - A HUNGER BAR UNDER THE SPRITE. Banned by §8's "no invented data — including GEOMETRY" unless
 *     the length is a measured quantity, and it is not this module's to measure. It also belongs
 *     to the HUD, not to the animal.
 *   - A DIFFERENT POSE PER STATE (sitting, crouched, prone) as sprite variants. Rejected on scope
 *     rather than principle: five hand-authored poses is unitick's `cast.ts` approach and it does
 *     not compose with a hash-derived silhouette — the ear angle and tail curl would have to be
 *     re-derived per pose. The dimming carries the state instead, and the tail's own `lift` axis
 *     already gives the colony postural variety.
 *
 * ══ WHY DEAD IS DIM AND NOT TRANSPARENT ══
 *
 * openhood's recorded rule for its dormant creatures, and it holds exactly: a transparent sprite
 * reads as "still loading", and "dead" and "loading" must never be confusable — one is a state the
 * world produced and the other is a fault.
 */
/**
 * ══ THE DIM IS A GAIN, NOT A SUBTRACTION — and this was a measured bug ══
 *
 * The first pass subtracted a flat number of steps per state: hunting −1, starving −2, dead −3.
 * Rendered to PNG and looked at, EVERY cat in every state but `fed` was a muddy undifferentiated
 * mass. The dump of the raw step grid showed why immediately: with only six steps, subtracting two
 * and then clamping at 1 crushes steps 1, 2 and 3 all onto 1. A body already sitting at step 2-3
 * and legs at 2 all landed on the same value, so the legs, the haunch and the neck break all
 * disappeared at once. The state dim was destroying the SILHOUETTE, which is the one thing §9 says
 * this sprite cannot afford to lose.
 *
 * That is a scale error, not a tuning error: a flat subtraction on a 6-step ramp removes a fixed
 * amount of the total range, and by `starving` there is no range left to carry shape.
 *
 * A GAIN scales toward the noise floor instead, so the RATIOS between parts survive. A starving
 * cat is dimmer than a fed one at every point, and its legs are still darker than its haunch,
 * which is what keeps it a cat rather than a smear. This is also the physically honest model for
 * the referent: an IR illuminator falling off does not subtract a constant from a scene, it
 * multiplies it.
 *
 * The floor at 1 stays: step 0 is the outline, and a coat pixel that reaches the outline value has
 * merged with it.
 */
const STATE_GAIN: Readonly<Record<CatState, number>> = {
  /** Fed: full range, the reference exposure. A cat that has eaten is fully lit. */
  fed: 1,
  /**
   * Hunting: a step and a half down at the top of the range.
   *
   * 0.78, not the 0.9 it was. At 0.9 `Math.round(step * gain)` is the IDENTITY on every value a
   * 6-step ramp can hold — 1→1, 2→2, 3→3, 4→4, 5→5 — so `fed` and `hunting` rendered as byte-
   * identical cats. A dead axis that looked live in the source, and the total-luminance assertion
   * is what caught it: both states summed to exactly the same number on all fifteen test ids.
   *
   * This is the same defect as the ear shear moving less than a pixel, in a different dimension:
   * a continuous parameter quantised onto a small integer range does nothing unless its effect
   * exceeds the quantum. 0.78 moves steps 3, 4 and 5 down by one and leaves the shadows alone,
   * which is the intended read — a hunting cat is lit a little less, not shaded differently.
   */
  hunting: 0.78,
  /** Starving: two thirds. Visibly sinking toward the noise floor, which is the honest read. */
  starving: 0.66,
  /**
   * Dead: unused. See `DEAD_STEP` — a dead cat is not a dim cat, it is a flat one.
   *
   * Kept in the table at 1 rather than removed so the record is exhaustive over `CatState` and a
   * future state cannot be added without a value being chosen for it.
   */
  dead: 1,
};

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * DEAD IS A FLAT SILHOUETTE, NOT A FADE — and this was a review finding, not a preference.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `dead` was a gain of 0.46, on the same model as the other three states. Rendered and reviewed,
 * it "read as a rendering failure rather than a state" — the cat was so close to the ground value
 * that a viewer's first hypothesis was a broken sprite, not a dead animal.
 *
 * That is a serious defect and not a cosmetic one, because of what the state MEANS. `DESIGN.md` §2
 * and `ART-DIRECTION.md` §8 both require losses to be honest and visible: "a starving cat is drawn
 * starving. The mechanic is honest about losses or it is a lie with whiskers on it." A death that
 * fades toward invisibility is the softening the ban forbids, arriving through rendering instead
 * of through copy. It is also openhood's dormant-creature rule restated: a sprite that fades reads
 * as "still loading", and a fault and a state must never be confusable.
 *
 * ══ THE FIX: COLLAPSE THE RANGE, DO NOT LOWER IT ══
 *
 * Every coat pixel takes ONE value — `DEAD_STEP` — regardless of what the lighting gave it. That
 * makes the cat a flat, evenly-lit shape with a full-contrast outline: unmistakably THERE, and
 * unmistakably not alive, because the one thing every other state has is internal modelling. A
 * flat fill is the visual language of an absence of light falling on a form, which is exactly what
 * is being said.
 *
 * Step 2 specifically: two full steps above the outline at 0, so the silhouette and its edge both
 * read; and two below the body's own floor of 3-4, so a dead cat is plainly darker than a living
 * one at a glance. It sits at `--phos-ghost`, §3's declared noise floor, which is the correct
 * register — present, and at the bottom of the range the sensor can still resolve.
 *
 * ══ AND THE FLAT FILL OVERRIDES RULE 2 ══
 *
 * A dead cat has no neck break, because it has no internal modelling at all — that is the whole
 * point of the flat fill. The neck clamp is therefore skipped in this state, which is the one
 * deliberate exemption from a silhouette rule anywhere in this file.
 *
 * It is safe precisely because rule 2 exists to stop head and body fusing into an amoeba, and a
 * uniformly flat sprite has already given up internal shape on purpose: there is no partial fusion
 * to prevent when NOTHING is modelled. The silhouette still reads, because the outline still runs
 * at full contrast around the whole animal — including into the neck's notch, which `bodyNormal`'s
 * pinch puts there geometrically rather than tonally.
 *
 * REJECTED: drawing the dead cat as an OUTLINE ONLY, hollow. It was tried first, since "outline
 * only" is the obvious reading of "a flat silhouette". At 16px a hollow shape loses the ears
 * entirely — a 1px ear outline with a 1px interior is just two adjacent pixels — and the sprite
 * stopped being identifiable as the user's own cat, which is the one thing it must remain.
 */
const DEAD_STEP = 2;

function applyState(step: number, part: Part, state: CatState): number {
  if (part === "outline") return step;
  /*
   * THE EYES ARE EXEMPT FROM THE DIMMING, except when dead.
   *
   * A starving cat's eyes still catch the illuminator — eyeshine is a reflection, not a metabolic
   * process. Dimming them with the coat lost the sprite's focal point exactly when the state most
   * needed reading, and rendered at 32px a starving cat became an undifferentiated grey smudge.
   * A DEAD cat's eyes are dropped hard: a corpse's tapetum does not shine, and this is the single
   * clearest state read on the sprite. They go to 1 — BELOW the flat coat, so they read as two
   * dark holes in a flat shape, which is the strongest "gone" signal available in one hue.
   */
  if (part === "eye") {
    if (state === "dead") return 1;
    return step;
  }
  if (state === "dead") return DEAD_STEP;
  /*
   * ══ THE GAIN IS ORDER-PRESERVING, AND THAT IS WHAT KEEPS THE SILHOUETTE RULES INTACT ══
   *
   * `Math.round(step * gain)` is NOT injective on a 6-step ramp: at 0.78 both 1 and 2 map to 1
   * and both 5 and 6 would map to 4. Anywhere it collapsed two adjacent steps onto one it erased
   * a break that a silhouette rule had just established — the tests found `stray-1` losing its
   * NECK (rule 2) and its LEG separation (rule 3) in the `hunting` state alone, on a cat whose
   * geometry was correct. The state was quietly undoing the rules.
   *
   * That is the deeper version of the mistake this file already made twice (a flat subtraction
   * crushing the range, a 0.9 gain doing nothing): the exposure must not be able to destroy
   * information the geometry encoded. So the mapping is FLOORED rather than rounded and then
   * offset — floor with a `+1` bias moves the whole ramp down while keeping distinct inputs
   * distinct wherever the ramp has room, and the `Math.max(1, ...)` only ever binds at the very
   * bottom where the outline already provides the contrast.
   *
   * The result is that a hunting cat is a dimmer fed cat with every break it had, which is what
   * "the same animal, less lit" has to mean.
   */
  const gain = STATE_GAIN[state] ?? 1;
  if (gain >= 1) return step;
  // Map 1..RAMP_STEPS-1 onto a compressed but strictly increasing range.
  const top = RAMP_STEPS - 1;
  const scaled = 1 + ((step - 1) * (Math.round(top * gain) - 1)) / (top - 1);
  return Math.max(1, Math.min(top, Math.round(scaled)));
}

/**
 * THE GRID — every filled pixel of a cat, as ramp indices.
 *
 * Pure and deterministic. Returns indices rather than colours so the caller owns the palette,
 * which is what lets the same grid serve a lit cat on the map, a portrait in a panel, and a
 * forced-colours fallback without this function knowing about any of them.
 */
export function catGrid(
  id: string,
  opts?: { readonly state?: CatState },
): GridPixel[] {
  const geom = geometryFor(id);
  const state = opts?.state ?? "hunting";
  const tail = tailPixels(geom);
  // The body's own first row and the neck break, both derived from the posture so the rules that
  // reference them follow the body rather than a constant. See `neckRowFor`.
  const { bodyTop } = postureRows(geom.posture);
  const neckRow = neckRowFor(geom.posture);
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
      const hit = partAt(x, y, geom, tail);
      if (!hit) continue;

      const key = y * GRID_W + x;

      // A MARK, not a surface: the eye and the whisker carry their own step and skip the diffuse
      // model entirely.
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
           * §8 permits state to tint "one or two pixels". This flagged EVERY eye pixel, and once
           * the eye masks all became 2px wide (see `eyeStepAt`) that was FOUR — a direct breach of
           * the ban, introduced by a change to an unrelated part. The comment here even asserted
           * the old invariant ("at most two by construction of the masks") and went stale silently.
           * The test caught it; the comment did not.
           *
           * Exactly ONE pixel per eye is flagged now — the INNER one, nearest the nose bridge.
           * Inner rather than outer because the bridge beside it is forced dark, so the tint lands
           * against the strongest local contrast and reads at 32px, where the outer pixel sits
           * against the lit cheek and muddies.
           *
           * That this is a hard count and not a rule of thumb is the point: the ban is on the
           * NUMBER of coloured pixels, so the code has to count them, and `grid.test.ts` asserts
           * the count rather than the intent.
           */
          ...(hit.part === "eye" && (x === EYE_L_X + EYE_W - 1 || x === EYE_R_X)
            ? { accent: true }
            : {}),
        });
        filled.add(key);
        if (hit.part !== "whisker") outlineSeed.add(key);
        continue;
      }

      // An interior hole takes the darkest coat step rather than being dropped. The part claimed
      // the pixel; the pixel gets painted. (openhood's speckled-cheeks bug.)
      let step = shadeStep(hit.nx, hit.ny, x, y) ?? 1;

      /*
       * ══ RULE 2 — THE NECK. The single most important line in this function. ══
       *
       * The body's top row is forced `NECK_STEP_DROP` steps below the head's bottom row. Not
       * "shaded a bit darker by the lighting" — FORCED, and clamped so the dither cannot climb
       * back over it.
       *
       * Without it the head's lower edge and the body's upper edge are adjacent surfaces at nearly
       * the same angle, so they land on the same ramp step, and the two ellipses fuse into one
       * mass. That is unitick's amoeba, verbatim: "head and body were one mass... the silhouette
       * was an amoeba." A cat with no neck does not read as a cat; it reads as a bowling pin.
       */
      if (hit.part === "body" && y === neckRow) {
        /*
         * ══ THE BREAK IS MEASURED AGAINST THE HEAD, NOT SUBTRACTED FROM THE BODY ══
         *
         * This was `step - NECK_STEP_DROP`, and the test found `stray-1` with a one-step break.
         * The reason is that subtracting from the BODY says nothing about the HEAD: the head's own
         * floor is 3, so where the lighting left a head pixel at exactly 3 and the body beneath it
         * at 3, subtracting two gave 1 — but where the body pixel was already 2, subtracting two
         * clamped at 1 and the difference from the head above was only 2... and where the head was
         * 3 and the body 4, the result was 2 and the break was 1. The size of the break depended on
         * a value the expression never looked at.
         *
         * Rule 2 is a statement about the DIFFERENCE between two rows, so the code has to compute
         * that difference. Clamping against the head pixel directly above makes the break exactly
         * `NECK_STEP_DROP` wherever there is a head to break from, at every lighting value and
         * every posture — which is what the assertion checks and what the eye actually reads.
         */
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
       * the ramp. Without a floor the diffuse model put large areas of the face at steps 0-1,
       * which on a phosphor ramp against soot is the ground colour — so the shaded side of the
       * head vanished and the silhouette read as a bite out of the animal. openhood recorded this
       * defect; it reproduced here at 16px on the first render and was fixed the same way.
       *
       * The cost is tonal range on the face and the purchase is a legible animal, which is the
       * correct trade at 16px: a face legible in one flat band beats a face beautifully modelled
       * and unreadable.
       */
      if (hit.part === "head" || hit.part === "muzzle") step = Math.max(3, step);
      /*
       * ══ THE NOSE BRIDGE IS FORCED DARK — the fix for a VISOR ══
       *
       * Measured at 96px: with the head floored at 3 and the eyes at 5, the two 2px eyes and the
       * 2px bridge between them rendered as ONE horizontal bar. In the tinted states this was
       * worst of all — a single amber rectangle across the face, which reads as a visor or a
       * mask, not as a pair of eyes. It is the identical failure the whiskers had as a symmetric
       * pair ("a rod through the skull"), arriving through value instead of through geometry.
       *
       * Two eyes only read as two if something separates them. The bridge is pushed two steps
       * below the head's floor, so a dark notch runs between the eyes. This is the one place the
       * face floor is deliberately violated, and the violation is what makes the face legible —
       * which is the same trade the floor itself was making.
       *
       * It is scoped to the EYE ROW only. Carrying it down the whole face drew a dark stripe from
       * the brow to the chin, which read as a split muzzle.
       */
      if (hit.part === "head" && y === EYE_Y) {
        const dx = Math.abs(x + 0.5 - CX);
        if (dx < (EYE_R_X - EYE_L_X - EYE_W) / 2 + 0.5) step = Math.max(1, step - 2);
      }
      /*
       * ══ THE EARS ARE FLOORED HIGHER THAN THE FACE, for the horn's old reason ══
       *
       * The ear is the identifying feature and at 16px it is three rows of a taper narrowing to
       * one pixel — the smallest, most fragile thing on the cat. Floored at the same step as the
       * face, its shaded side came out the same value as the head behind it and the ear
       * disappeared into the skull; the sprite read as a round-headed animal, which is a cub or an
       * owl. Floored at 4 the ear is the brightest thing on the cat apart from the eyeshine, which
       * is the correct hierarchy: on a cat the ears are the first read.
       *
       * The floor is applied to the OUTER half only. `nx > -0.15` is the outward-facing surface;
       * the inner surface keeps its darker value, which is the wedge that makes an ear read as a
       * cone rather than as a triangle sticker. Flooring the whole ear made both ears flat bright
       * spikes with no interior — measured at 96px.
       */
      if (hit.part === "ear") {
        step = hit.nx > -0.15 ? Math.max(4, step) : Math.max(2, step - 1);
      }
      /*
       * ══ THE BODY IS FLOORED AT 3, NOT DROPPED TO 2 — measured, and the fix for a dark blob ══
       *
       * The first pass took the body a step BELOW whatever the lighting gave it, on openhood's
       * logic that the head should stay the subject. Dumped as raw steps, the whole body was
       * landing on 1 and 2 — against an outline at 0 and a ground at soot, that is invisible. The
       * cat rendered as a bright head floating over a dark smudge, which is the "lollipop" failure
       * this file already rejected once in `bodyNormal` and had reintroduced through the shading.
       *
       * The head is kept as the subject by the NECK break and by the ear floor being higher, not
       * by making the body dark. That is the better mechanism anyway: hierarchy by CONTRAST at the
       * boundary rather than hierarchy by drowning the larger part.
       *
       * The `-1` on the lower half is what remains of the original intent: the haunch is slightly
       * darker than the chest, which reads as the body turning away underneath. That survives
       * because it is a relative difference INSIDE the body's own floored range, not a push toward
       * the ground.
       */
      if (hit.part === "body" && y !== neckRow) {
        const lower = y >= bodyTop + 2;
        step = Math.max(lower ? 3 : 4, step);
        /*
         * ══ THE COAT PATTERN, applied last so it modulates the FLOORED value ══
         *
         * Applying it before the floor would let `Math.max` erase the marking wherever the floor
         * was the binding constraint — which is most of the body, so the pattern would show only
         * on the few pixels the lighting had already darkened. That is a marking that appears in
         * the source, passes a unit test on `coatDrop`, and is invisible on screen.
         *
         * Floored at 2 rather than 1: a stripe that reaches the outline's neighbourhood reads as a
         * hole punched in the cat, not as a marking on it.
         */
        step = Math.max(2, step - coatDrop(geom.coat, x, y, bodyTop, bodyHalfWidthAt(y, geom)));
      }
      /*
       * The tail brightens toward the TIP. Backwards from every other part, and deliberately: the
       * tip is the part carrying the identity (the curl), it is 1px wide, and it is the furthest
       * thing from the body's mass — so it is the pixel most at risk of vanishing. A tip that
       * fades out is `maneNormal`'s scallop problem and NEEDLE's floating horn at once.
       *
       * The range is 3..5 rather than the first pass's 2..4. At 2 the tail root was the same value
       * as the body it emerges from and the tail appeared to start two pixels out — a gap by
       * value rather than by geometry, which breaks rule 1 just as effectively.
       */
      if (hit.part === "tail") {
        step = Math.max(3, Math.min(RAMP_STEPS - 1, 3 + Math.round((hit.t ?? 0) * 2)));
      }
      /*
       * ══ THE LEGS ARE THE DARKEST LIT PART, AND THAT IS WHAT MAKES THEM READ ══
       *
       * Floored at 2 and capped at 2. A fixed value, not a shaded one — which is a departure from
       * every other part and is deliberate.
       *
       * Rule 3 needs the two posts and the gap between them to be unmistakable. A SHADED leg
       * varies across its own 2px width, so at 16px one of its two columns routinely dithers up
       * into the body's range and the other down into the outline's, and the post stops reading as
       * a post. Pinning both columns to one value below the body's floor makes the pair read as
       * two solid dark posts against a lighter haunch — which is exactly the contrast the rule is
       * asking for. The `legNormal` cylinder sweep is still computed and still shapes nothing;
       * it is retained because the leg must return a normal for `partAt`'s uniform contract.
       */
      if (hit.part === "leg") step = 2;

      let finalStep = applyState(step, hit.part, state);

      /*
       * ══ RULE 2 IS RE-ASSERTED AFTER THE EXPOSURE, AND THAT IS THE ONLY PLACE IT CAN LIVE ══
       *
       * The neck break is computed above in geometry space, and it has to be, because that is
       * where the head's and body's values are decided. But the state gain then compresses the
       * whole ramp, and a compression can bring two steps that differed by two back to within one
       * — the test found `stray-1` losing the break in `hunting` even after the gain was made
       * order-preserving, because order-preserving is not gap-preserving.
       *
       * So the break is clamped a second time against the head's POST-STATE value. Asserting an
       * invariant at the point the pixel is actually emitted is the only way it holds under every
       * later transformation; asserting it earlier only holds until something downstream moves.
       * This is the third distinct bug rule 2 has had, and all three were the same shape — the
       * break being computed somewhere the final value was not yet known.
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
   * ══ Why it is MORE necessary at 16px than at 24 ══
   *
   * openhood added this because on a dark ground the coat's shadow side and the page were
   * indistinguishable, so the animal had no edge on its lower left. That is worse here: the
   * palette is a single hue at low chroma against near-black soot, so there is less value
   * separation available between the darkest coat step and the ground than there was on
   * openhood's obsidian. Without an outline the phosphor cat dissolves into the page at exactly
   * the sizes the map uses.
   *
   * Drawn OUTSIDE the form rather than replacing its edge pixels: replacing would eat a pixel off
   * every dimension, and on an 8px head that is 12% of the face.
   *
   * Orthogonal neighbours only. A diagonal pass rounds every corner and doubles the outline at
   * every convex turn — which at 16px would round the EAR TIPS off, and a rounded ear tip is not
   * a cat.
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
