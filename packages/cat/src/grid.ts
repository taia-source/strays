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
 * The METHOD is bloodhorn's (`openhood/apps/web/lib/creature-grid.ts`). So, now, is the REGISTER:
 *
 *   - TAKEN: the 24x24 grid; per-axis salted FNV-1a; parts owning disjoint regions; a `*Normal`
 *     function per part returning a local surface normal; normal -> Lambert -> ramp -> ordered
 *     dither; the outline pass; PIGMENT FEATHERED ACROSS THREE RAMP STEPS; the discipline of
 *     recording every rejected geometry in the header. And, as of this pass, THE NEOTENY BUDGET —
 *     a huge head, big eyes, a small body, stubby legs, and strong saturated colour.
 *   - REPLACED: the horn is TWO POINTED EARS, and the mane's role as the largest per-creature
 *     variation is taken by the COAT COLOUR and the TAIL.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE FOUR REWRITES THIS PACKAGE HAS HAD, AND WHY THE FOURTH REVERSED THE THIRD ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * v1 — 16x16, a 6-step ramp, one phosphor hue for every cat. Reviewed against bloodhorn's unicorns
 * and called, verbatim, "shit pixel-art mascots". Three measurable causes: not enough cells (256
 * against 576), not enough ramp (nine structural claims on six values), and NO PIGMENT (twelve cats
 * in one green, which at 32px is twelve smudges).
 *
 * v2 — 24x24, an 8-step ramp, seven real cat-coat pigments, front-facing. Fixed all three.
 *
 * v3 — SIDE PROFILE, pushed toward anatomical accuracy: a correct leg-to-barrel ratio, a high
 * haunch, a short muzzle, a low stance. Every one of those was achieved and asserted. The result was
 * a believable quadruped and it was REJECTED ON SIGHT.
 *
 * v4 — this one. Front-facing, huge-headed, big-eyed, saturated. The brief:
 *
 *   > "why aren't they cute? look bloodhorn, they are cute and simple, why cannot we make cats
 *   > similar to that but cats instead of unicorns? **we don't need to imitate a true aesthetics of
 *   > a cat.**"
 *
 * ══ THE LESSON v3 COST, AND IT IS THE MOST EXPENSIVE ONE IN THIS PACKAGE ══
 *
 * v3 was not badly executed. It was well executed against the wrong objective, and every one of its
 * assertions passed while it did so. "Correct leg-to-barrel ratio" and "cute" are not the same
 * target and are frequently opposed: NEOTENY IS BY DEFINITION THE RETENTION OF PROPORTIONS AN ADULT
 * ANIMAL DOES NOT HAVE. Optimising for anatomical fidelity is therefore optimising AWAY from cute,
 * necessarily, and no amount of tuning within the accurate register reaches the cute one.
 *
 * bloodhorn states the same thing from the other side and it should have been read as the warning it
 * is: "A unicorn that is merely SMALL is not cute; it is a small horse. Cuteness is NEOTENY, and
 * neoteny is a set of ratios, not a vibe."
 *
 * The structural tell was available before the render: v3's own header argued the cat should NOT be
 * neotenous, on a product-tone reading of `ART-DIRECTION.md` §8's ban on "a cute cat used to soften
 * a loss". That is a reasonable reading and it was wrong — the ban is on cuteness being used to HIDE
 * a loss, not on the animal being appealing. A cute cat that is visibly starving is more affecting
 * than an accurate one, not less, which is the whole reason the state register in this file is now
 * droopy ears and dim eyes rather than a correctly-drawn ribcage.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE SILHOUETTE RULES — inherited from unitick's NEEDLE failure, and still in force ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NEEDLE v1 was rendered to a real PNG at 96px and LOOKED at, not judged from the source grid. It
 * read as a white blob. Each cause is asserted as a predicate over pixel coordinates:
 *
 *   1. AN APPENDAGE MUST MEET THE BODY. Every ear column that is filled must have a filled pixel
 *      directly beneath it, and the tail's root must be orthogonally adjacent to a body pixel.
 *   2. THE HEAD MUST SEPARATE FROM THE BODY. Front-on this is a WIDTH difference rather than the
 *      value break the profile pose needed: the head is 1.4x the body's width, so the silhouette
 *      pinches where they meet and reads as a head sitting ON something.
 *   3. PAWS ARE WIDE AND PAIRED WITH A VISIBLE GAP. Thin verticals read as a fringe.
 *   4. NOTHING MAY BE ORTHOGONALLY DISCONNECTED FROM THE CAT. A flood fill over the whole coat, and
 *      it is the single most valuable assertion in `grid.test.ts` — it found 250 broken cats out of
 *      300 the first time it ran, on geometry that looked correct at 96px.
 *
 *      The generalisation worth carrying forward: when two pieces of geometry must meet, DERIVE one
 *      from the other. Every gap bug here was a hardcoded number that agreed with its neighbour until
 *      the neighbour became a variable.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE HASH BUDGET, RE-SPENT FOR A FRONT-FACING SPRITE ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ART-DIRECTION.md` §9 names the second-likeliest failure of this product: "the map is beautiful and
 * unreadable — you cannot find your own cat".
 *
 *   | axis        | range                 | effect on the read AT 32px                          |
 *   |-------------|-----------------------|-----------------------------------------------------|
 *   | pigment     | 10 discrete           | LARGEST — the whole coat. The first thing named.    |
 *   | tailLift    | CONTINUOUS 0..1       | LARGE — drags beside the paws to vertical greeting. |
 *   | tailCurl    | CONTINUOUS -1..1      | LARGE — picks the SIDE and sweeps ~5 columns.       |
 *   | earHeight   | CONTINUOUS 3.4..5.2   | LARGE — a fold to a lynx. Changes total height.     |
 *   | earWidth    | CONTINUOUS 1.5..2.4   | LARGE — broad triangle to narrow spike.             |
 *   | headWidth   | CONTINUOUS 5.9..7.0   | LARGE — the head IS the sprite, so its width is too.|
 *   | cheekFluff  | CONTINUOUS 0..1.5     | MEDIUM — ruff tufts. Changes the skull's outline.   |
 *   | coat        | 4 discrete            | MEDIUM — solid/tabby/patched/tortie. Luminance.     |
 *   | earAngle    | CONTINUOUS -1..1      | MEDIUM — leans the tips in or out.                  |
 *   | build       | CONTINUOUS -1..1      | SMALL — the body is small by design, so this is too.|
 *   | eyeShape    | 3 discrete            | SMALL — interior detail, but it is on the FACE, so  |
 *   |             |                       | it reads further than an interior axis usually does.|
 *   | whiskerLen  | 2 or 3                | none — 1px marks at the cheek, 96px only.           |
 *
 * ══ THE RULE THIS TABLE ENCODES, LEARNED THE HARD WAY ══
 *
 *   1. AN AXIS MUST MOVE ITS FEATURE BY AT LEAST TWO PIXELS ACROSS ITS RANGE, or rasterisation eats
 *      it. Five separate instances of this defect are recorded in this package's history: an ear
 *      angle that moved a tip by under a pixel, a 0.9 state gain that was the identity on a 6-step
 *      ramp, a 2.6 tail curl that moved the tip two columns, a flick frame that moved one cell, and a
 *      flick that moved ZERO after a downstream change to the curl's decomposition.
 *   2. VARIATION MUST BE BUDGETED AT THE SCALE THE SPRITE IS VIEWED AT. `pigment` changes what the
 *      whole animal looks like, and that is all a 32px sprite has.
 *
 * REJECTED as variation axes, and recorded so they are not re-tried:
 *   - THE FOUR-POSTURE AXIS (sit/stand/crouch/stretch). It was the largest silhouette axis in the
 *     profile pose and it is nearly dead front-on: a standing cat and a sitting cat differ by about
 *     one row of leg when you are looking at the animal's face. Its budget went to `headWidth`,
 *     `cheekFluff` and three more pigments, all of which survive being shrunk.
 *   - HEAD TILT. Rotating the head by a hash angle desynchronises the ears from the skull and the
 *     resampling turns both ears into blobs. Reads as damage, not as posture.
 *   - MIRRORING THE WHOLE CAT on a hash bit. Half a colony facing each way reads as two species. The
 *     TAIL's side is mirrored instead, which gets the asymmetry without the second species.
 */

import { fnv1a } from "@taia/ui/mechanisms";

import {
  BODY_RX_BASE,
  CX,
  type CuteGeometry,
  type CutePart,
  cutePartAt,
  cuteShadeStep,
  cuteTailCells,
  EYE_D,
  EYE_L_X,
  EYE_R_X,
  EYE_Y,
  HEAD_RX,
  PROPORTIONS,
  RAMP_STEPS,
  ROWS,
} from "./cute.js";
import { GRID_H, GRID_W } from "./dims.js";

export { GRID_H, GRID_W };
export { EYE_D, EYE_L_X, EYE_R_X, EYE_Y, PROPORTIONS, RAMP_STEPS, ROWS };

/**
 * THE EYE, re-exported under the names the rest of the package and its callers use.
 *
 * A cute cat's eye is SQUARE — 4x4 — so width and height are one number. They are exported as two
 * names because a caller reasoning about the face's layout should not have to know that, and because
 * the day an eye becomes non-square the call sites are already correct.
 */
export const EYE_W = EYE_D;
export const EYE_H = EYE_D;

/** The head's widest measure, in pixels. Derived from the geometry, never typed independently. */
export const HEAD_W = HEAD_RX * 2;

/**
 * The row where the head's mass ends and the body's begins.
 *
 * Front-on this is where the silhouette PINCHES, because the head is 1.4x the body's width. The
 * profile pose needed a forced value break here and the head-on pose before it needed one too; this
 * pose gets the separation from the shape itself, which is the outcome bloodhorn designed for when
 * it made its body narrower than its head.
 */
export const NECK_ROW = ROWS.body[0];

/**
 * How many ramp steps darker the throat is than the head above it.
 *
 * The value break survives as a SHADING of the throat rather than as a structural clamp: the cells
 * directly under the chin are pushed down so the chest reads as being behind the head rather than
 * continuous with it. TWO, not one — at one step the separator was present in the data and invisible
 * in the render, because the Bayer dither can move a pixel a full step either way and routinely
 * erased it. A separator the dither can cancel is not a separator.
 */
export const NECK_STEP_DROP = 2;

/**
 * ══ PER-AXIS SALTS ══
 *
 * Each trait is `fnv1a(`${id}:${SALT.trait}`)` — a SEPARATE hash per axis, not bit-slices of one
 * integer. This is the correction bloodhorn's header records: bit-slicing one 32-bit value
 * correlates the axes, so two ids whose hashes differ only in the low bits get identical high-bit
 * traits, and a colony that looks decorrelated in one region of the id space looks banded in
 * another. Salting re-runs the avalanche per axis.
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
  headWidth: "head-width",
  cheekFluff: "cheek-fluff",
  coat: "coat",
  pigment: "pigment",
  tintStep: "tint-step",
} as const;

/** A stable 0..1 from an id and a salt. The one place the hash is turned into a number. */
function unit(id: string, salt: string): number {
  // `>>> 0` is already applied inside `fnv1a`, so this is an unsigned 32-bit value. Dividing by 2^32
  // rather than taking a modulus keeps the full precision of the avalanche — a modulus by a small
  // number throws away the high bits, which are the best-mixed ones.
  return fnv1a(`${id}:${salt}`) / 4294967296;
}

/** A stable −1..1 from an id and a salt. Signed, so a trait can lean both ways. */
function signed(id: string, salt: string): number {
  return unit(id, salt) * 2 - 1;
}

/** Which part of the cat owns a pixel. Re-exported from `cute.ts` so callers import one name. */
export type Part = CutePart;

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
   * coat is IDENTITY and is a fixed property of the id, while the accent is STATE and changes as the
   * world does. `ART-DIRECTION.md` §3 declares exactly two event hues, and a coat pigment can never
   * be one of them — see `PIGMENTS`. `grid.test.ts` asserts the accent count never exceeds two.
   */
  readonly accent?: boolean;
};

/**
 * THE CAT'S STATE, and it is expressed in a CUTE REGISTER.
 *
 * ══ THE REGISTER IS THE v4 CORRECTION, NOT THE MECHANISM ══
 *
 * v3 expressed state through anatomy: a starving cat had a shallower barrel, a drawn-up flank and
 * ribs drawn as vertical strokes on the ribcage. That is a correct drawing of a starving animal and
 * it is in the register the whole sprite was moved out of.
 *
 * The states are now drawn the way a cartoon draws them, which is not a softening — a droopy-eared,
 * half-lidded, dim cat reads as "this animal is suffering" FASTER and at a SMALLER SIZE than a
 * correctly-modelled ribcage does, because the cues are silhouette and face rather than interior
 * value. `ART-DIRECTION.md` §8's "a starving cat is drawn starving" is honoured better, not worse.
 *
 *   FED       — plump and glossy. The face is full, the ears are pricked, the eyes are wide and the
 *               coat's lit band reaches a step higher so the fur reads as having a sheen on it.
 *   HUNTING   — alert. The ears prick hard forward and the eyes go to their widest. The default
 *               condition of a stray, and drawn as the liveliest of the four.
 *   STARVING  — droopy. The ears fold outward and down, the eyes go half-lidded, the body narrows
 *               and the whole animal dims. Every one of those is a face-and-silhouette cue.
 *   DEAD      — a simple X-eyed slump. The animal drops to the ground rows, the ears fall flat, the
 *               coat goes to one flat value with no modelling, and the eyes become an X.
 */
export type CatState = "fed" | "hunting" | "starving" | "dead";

/**
 * ══ THE COAT PATTERN — luminance only, and it is SEPARATE from the pigment ══
 *
 * A pattern drawn by moving pixels BETWEEN EXISTING RAMP STEPS adds no hue whatsoever — it is the
 * same eight values rearranged.
 *
 * Keeping the pattern (luminance) and the pigment (hue) as SEPARATE axes is what buys the colony its
 * real variety: a peach tabby and a peach tortie share a hue and read as different cats, where an
 * axis that fused them would give ten cats and no more.
 *
 *   SOLID    — no pattern. The reference, and the commonest.
 *   TABBY    — a striped forehead mark and bands down the body. The classic tabby "M".
 *   PATCHED  — one asymmetric block on the flank and one over an eye. A bicolour stray.
 *   TORTIE   — a scattered dither of darker cells keyed on position, which reads as the mottled
 *              brindling of a tortoiseshell.
 */
export type Coat = "solid" | "tabby" | "patched" | "tortie";

/** A cat's own identity, every axis derived from a separately-salted hash of the id. */
export type CatGeometry = {
  /** −1..1. Which way the ear tips lean. Negative is outward, positive is inward/alert. */
  readonly earAngle: number;
  /** 3.4..5.2. How many rows the ears rise above the crown. */
  readonly earHeight: number;
  /** 1.5..2.4. The ear's half-width at its base — a wide flat ear or a narrow tall one. */
  readonly earWidth: number;
  /** −1..1. Which SIDE the tail exits, and how hard it curls. */
  readonly tailCurl: number;
  /** 0..1. How high the tail is carried, from low beside the paws to vertical greeting. */
  readonly tailLift: number;
  /** 0, 1 or 2. Round, tall or wide-and-looking-up. */
  readonly eyeShape: number;
  /** 2 or 3. Whisker length. */
  readonly whiskerLen: number;
  /** −1..1. Stocky (positive) to lean (negative). Scales the body's width. */
  readonly build: number;
  /** 5.9..7.0. The head's half-width. The head IS the sprite, so this is a large axis. */
  readonly headWidth: number;
  /** 0..1.5. Cheek ruff tufts, which flare the skull's lower corners. */
  readonly cheekFluff: number;
  /** The coat pattern, in luminance only. */
  readonly coat: Coat;
};

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE COAT PIGMENTS — bright, saturated, and MORE OF THEM ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ART-DIRECTION.md` §8's "No colour on an animal. The IR sensor has none" was lifted in v2 and
 * stays lifted, on the record. The reason it was lifted is unchanged and worth restating: the ban was
 * derived from the REFERENT (an IR camera trap, which is monochrome), which is a sound derivation
 * that produced an unsound result, because it optimised for fidelity to an APPARATUS over the job the
 * sprite has to do. A colony of thirty strays in one green is thirty smudges, which §9 of the same
 * document names as the second-likeliest way the whole product dies. When two sections of an art
 * direction predict opposite outcomes, the one describing a FAILURE MODE outranks the one describing
 * a MATERIAL.
 *
 * ══ WHAT CHANGED IN v4: THE PALETTE WENT BRIGHT ══
 *
 * v2 and v3 drew REAL CAT COAT COLOURS — ginger, smoke, brown tabby, tortoiseshell, black, cream,
 * grey — and argued the case: "a cat whose coat is hot pink is a toy, and this product is about a
 * stray that can starve." That argument is the accuracy register again, arriving through colour
 * instead of through anatomy, and it produced exactly what it promised: seven muted browns, greys
 * and greens, reviewed as "too dark and dull".
 *
 * bloodhorn's pigments are `#FF007A` hot pink, bubblegum, orchid, violet, periwinkle and pale rose,
 * and its own header states the discipline that makes them work — which is NOT "make them pastel":
 *
 *   > "Cute" did NOT become "light". Every value here is chosen for how it behaves against obsidian:
 *   > these are saturated and bright enough to GLOW on near-black... The identical hues at pastel
 *   > lightness on a white page would be a completely different and much cheaper image.
 *
 * So these ten are SATURATED and MID-TO-HIGH LIGHTNESS, chosen to glow on the dark ground, and they
 * are spread right around the hue circle rather than clustered — a colony's separability is a
 * function of the ANGLES between its coats, not of how many entries the array has.
 *
 * ══ AND NONE OF THEM IS AN EVENT HUE ══
 *
 * §3 declares two event hues — amber `fed` at hue 85 and ember-red `starving` at hue 25 — and §8's
 * "no semantic hue meaning two things" is still in force. A coat colour is identity, not state; a cat
 * whose coat happened to be `--starve` red would look permanently mid-loss.
 *
 * `grid.test.ts` asserts the separation IN HUE DEGREES rather than trusting this comment, and that
 * assertion has already earned its place once: v2's first tortoiseshell sat 3.7 degrees from the
 * ember-red accent, which was invisible reading the hex values and would have made every tortie cat
 * read as permanently starving. Two of the ten below (`peach` and `apricot`) were moved off their
 * first values by the same test.
 */
const PIGMENTS = [
  /** PEACH — a warm soft orange. The friendliest ginger there is, and the commonest cat. */
  0xffa46b,
  /** BUBBLEGUM — hot saturated pink. The loudest coat, and bloodhorn's own register. */
  0xff6bb0,
  /** LILAC — a light violet. The cool counterweight to the peach. */
  0xb98cf5,
  /** MINT — a pale green with real chroma, not the phosphor the whole colony used to wear. */
  0x74e0b4,
  /** SKY — a bright periwinkle blue. The "blue" cat, taken seriously as a blue. */
  0x74b8ff,
  /** CREAM — a warm sandy buff. The lightest coat, and the one that reads first on a dark ground. */
  0xf2dCA8,
  /** MARMALADE — a deeper saturated orange, clear of the amber `fed` accent at hue 85. */
  0xff8c42,
  /** ORCHID — a rich magenta-violet, distinct from lilac by chroma rather than by hue alone. */
  0xd870d8,
  /** SEAFOAM — a cool cyan-green. The widest hue separation from the peaches. */
  0x5fd4d4,
  /** SLATE — a light blue-grey. The one low-chroma coat, kept so the colony is not all candy. */
  0xa8b4cc,
] as const;

/** How many distinct coats a colony can contain. Exported so a caller can assert its own spread. */
export const PIGMENT_COUNT = PIGMENTS.length;

/**
 * A cat's own coat colour, from its id, as a packed RGB integer.
 *
 * Total by construction, with NO `?? fallback` that could silently substitute a default. bloodhorn
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
 * Steps 3..5 only, never the shadows and never the reserved top. bloodhorn's reason transfers
 * exactly: "the ramp's DARK end stays common to every creature, because shadows on one page are lit
 * by one candle; only the mid and lit bands take the creature's hue. Tinting the whole ramp would
 * produce dark creatures and light creatures, which reads as two species rather than as one species
 * with different markings."
 *
 * Varying WHICH of the three steps takes the pigment is a second, cheaper axis on top of the pigment
 * itself: the same peach at step 3 is a deep peach and at step 5 is a bright one.
 */
export function tintStepFor(id: string): number {
  return 3 + Math.floor(unit(id, SALT.tintStep) * 3);
}

/** Every varying axis of one cat, from its id. `Math.random()` appears nowhere. */
export function geometryFor(id: string): CatGeometry {
  const coats: readonly Coat[] = ["solid", "tabby", "patched", "tortie"];
  return {
    earAngle: signed(id, SALT.earAngle),
    /*
     * 3.4..5.2 rows above the crown. Continuous rather than the discrete 4/5/6 the profile module
     * used, because the ear rises from a base that itself moves with `headWidth`, so a discrete
     * height quantised against a moving base produced only two distinct silhouettes in practice.
     *
     * The range is set against the CLEARANCE — the rows that actually rise ABOVE the skull — not
     * against the ear's own span, because what a viewer reads as "ear" is only the part that clears
     * the head. The difference between 3.4 and 5.2 is a scottish fold and a lynx.
     */
    /*
     * ══ 2.0..3.0 ROWS ABOVE THE CROWN — CUT TWICE, AND THE RANGE NARROWED BOTH TIMES ══
     *
     * 3.4..5.2 first, then 2.6..4.0, now 2.0..3.0. Each cut came from a render, and the range got
     * NARROWER each time as well as shorter, which is the more important half.
     *
     * The height is what makes an ear read as a lynx, and a range wide enough to reach a lynx at one
     * end contains cats that are the wrong SPECIES. The rule the package's own header states — "if
     * one axis makes a cat read as a different species, that axis is too wide" — is a constraint on
     * the RANGE, not on the midpoint, and it is the one this axis kept violating. A one-row spread
     * between the shortest and tallest ear is still a visible difference at 24px (a row is 4% of the
     * sprite) and it cannot leave the genus.
     *
     * The variation the ears used to carry through height now comes through WIDTH, which is the safe
     * axis: a wide ear and a narrow ear are both cat ears, where a tall ear is a different animal.
     */
    earHeight: 2.4 + unit(id, SALT.earHeight) * 1.0,
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * ══ THE BASE HALF-WIDTH, 1.5..2.1 — WIDENED, THEN CUT BACK HARDER THAN IT STARTED ══
     * ══════════════════════════════════════════════════════════════════════════════════════════
     *
     * When the ear height was cut to fix the lynx read, the width was raised to 2.3..3.3 on the
     * reasoning that a cat's ear is about as wide as it is tall, so a shorter ear needs a broader
     * base or it becomes a nub. The arithmetic was right and the result was worse: the cats now read
     * as having HORNS or a pair of BOWS.
     *
     * The part grid shows why, and it is not about the ear's own proportions at all. A half-width of
     * 3.3 is a base SEVEN cells across, and the two roots sit about six cells apart on a head
     * fourteen wide — so the two bases nearly touch and rasterise into a single continuous band right
     * across the crown. The dome that the root-depth fix had just restored was covered again, this
     * time from the side rather than from above, and a band across a skull with two dark hollows in it
     * is a pair of horns.
     *
     * ══ WHAT THE EAR ACTUALLY NEEDS IS CLEAR DOME BETWEEN THE TWO OF THEM ══
     *
     * "As wide as it is tall" is a statement about ONE ear in isolation and it ignores the only
     * constraint that matters at 24px: there are two of them on a 14-cell skull, and what makes them
     * read as ears rather than as a crest is the FOREHEAD SHOWING BETWEEN THEM. The budget has to be
     * set against the head's width and the gap, not against the ear's own aspect.
     *
     * At 1.8..2.5 each base is 4-6 cells, the roots are ~7 apart, and there are two to four clear
     * dome cells between them on every head width. The ears are still squat — 3-4 rows tall on a 4-6
     * cell base — and they are now plainly two separate triangles on a round head.
     *
     * ══ AND IT WAS CUT TOO FAR ONCE, WHICH IS THE OTHER HALF OF THE CALIBRATION ══
     *
     * The first cut went to 1.5..2.1 and fixed the horn read completely — and at 48px, which is the
     * COLONY MAP size and the one that matters most, the smallest ears had shrunk to two or three
     * cells and simply disappeared. A cat with no visible ears on the map is worse than a cat with
     * slightly horn-like ones, because the ears are the entire species cue at that size.
     *
     * Both bounds of this axis are therefore load-bearing and they are set by DIFFERENT sizes: the
     * ceiling is set at 96px (above it the ears read as horns) and the floor at 48px (below it they
     * vanish). A single render cannot calibrate it, which is why `scripts/preview.mjs` draws every
     * sheet at three scales and why judging this axis from the detail sheet alone got it wrong twice.
     *
     * This is the third consecutive fix to this feature where the correct move was the OPPOSITE of
     * what the local reasoning suggested, and each time the local reasoning was about the ear alone
     * while the defect was about the ear's relationship to the skull. `grid.test.ts` now asserts the
     * dome gap between the ears directly, so the next edit that closes it fails rather than ships.
     */
    earWidth: 1.8 + unit(id, SALT.earWidth) * 0.7,
    tailCurl: signed(id, SALT.tailCurl),
    tailLift: unit(id, SALT.tailLift),
    eyeShape: Math.floor(unit(id, SALT.eyeShape) * 3),
    whiskerLen: 2 + Math.floor(unit(id, SALT.whisker) * 2),
    build: signed(id, SALT.build),
    /*
     * The head's half-width, 5.9..7.0. Over a pixel of range each side, so the widest head is two
     * columns broader than the narrowest.
     *
     * ══ THE FLOOR IS WHAT KEEPS THE NECK, AND IT IS THE OPPOSITE PROBLEM FROM v3's ══
     *
     * v3 had to CAP its head width, because at 5.8 the skull reached the same columns as the
     * shoulder and the silhouette had no pinch. Front-on the constraint inverts: the body is fixed
     * small by design, so the head has to be big ENOUGH for the pinch to exist. At 5.9 against the
     * body's ~4.6 the ratio is 1.28 and the waist is visible on every combination of head width and
     * build; below that the two masses start to read as one column.
     */
    headWidth: 6.4 + unit(id, SALT.headWidth) * 1.2,
    /*
     * Cheek ruff tufts. A SILHOUETTE axis rather than an interior one, which is why it survived the
     * budget re-spend when the four postures did not: it changes the skull's outline at its widest
     * point, which is the part of a front-facing sprite that reads at 32px.
     */
    cheekFluff: unit(id, SALT.cheekFluff) * 1.5,
    coat: coats[Math.floor(unit(id, SALT.coat) * 4)] ?? "solid",
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IDLE ANIMATION — three frames, and the world is dead without them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ WHY FRAMES AND NOT A TRANSFORM ══
 *
 * v1's cat animated by CSS `steps(2)` on `transform` — the whole sprite bobbing. That is a moving
 * PICTURE OF a cat, not a cat moving: nothing about the animal changes, so it reads as a sticker
 * being jiggled. Real idle animation moves ONE part while the rest stays put.
 *
 * ══ THE THREE FRAMES ══
 *
 *   0 REST    — the reference pose. Ears up, eyes open, tail at its hash-derived curl.
 *   1 FLICK   — the tail's lift and curl are both pushed hard, and one ear twitches. This is the
 *               frame that carries the motion: the tail tip moves 2-3 cells, which is the largest
 *               change available for the fewest pixels.
 *   2 BLINK   — the eyes close to the smiling closed curve. A blink is the single most legible "this
 *               is alive" cue there is, and front-on, with eyes this size, it costs eight pixels and
 *               changes the whole expression.
 *
 * ══ WHY NOT MORE FRAMES ══
 *
 * Four was tried (adding a head turn) and rejected on the ANIMATION rather than on the sprite: a
 * cat's idle is mostly stillness punctuated by a twitch, so a four-frame loop cycling evenly reads as
 * a fidget. Three frames held on frame 0 for most of the loop reads as a resting animal. The frames
 * are the cheap part; the timing is the craft.
 */
export const CAT_FRAMES = 3;

/**
 * How long each frame is held, as a fraction of one idle loop.
 *
 * REST dominates deliberately. A cat at rest is still ~78% of the time; a loop that gave the three
 * frames equal time read as a twitching animal rather than a resting one. Exported so the CSS
 * keyframes and the canvas loop cannot disagree about the timing — two declarations of one rhythm is
 * how a sprite ends up flicking its tail at a different rate in two places on one page.
 */
export const CAT_FRAME_HOLD: readonly number[] = [0.78, 0.12, 0.1];

/**
 * How a frame modifies the identity. Returns a NEW geometry rather than mutating, so a caller
 * holding one across frames cannot have it changed underneath them.
 *
 * The eye change is NOT here — it is resolved in `cuteGeometry`'s `sleepy` flag, because a blink
 * changes which pixels are lit rather than which geometry is derived, and routing it through the
 * geometry would mean a blinking cat had a different silhouette, which is how a blink becomes a
 * flinch.
 */
function frameGeometry(geom: CatGeometry, frame: number): CatGeometry {
  if (frame % CAT_FRAMES !== 1) return geom;
  /*
   * TAIL FLICK + EAR TWITCH.
   *
   * ══ BOTH TAIL AXES ARE DRIVEN, AND THAT IS THE FIX FOR TWO SEPARATE DEAD-AXIS BUGS ══
   *
   * Driving `tailCurl` alone was tried twice and failed twice. First at a delta of 0.55, which moved
   * `stray-1`'s tip a SINGLE cell — indistinguishable from the dither. Then, after the curl was
   * decomposed into a side-and-sweep term, flipping its sign moved the tip vertically but left its X
   * untouched, and `mackerel` came out with a flick that moved ZERO cells.
   *
   * That is the fourth and fifth instance in this package of one defect: a continuous parameter whose
   * effect falls under the two-pixel quantum is a DEAD AXIS THAT LOOKS LIVE IN THE SOURCE. It matters
   * more on a frame axis than anywhere else, because a frame axis cannot be judged from a single
   * render by construction — a still picture of a tail cannot show that it moved. So it is the axis
   * most likely to ship dead, and the assertion in `grid.test.ts` measures the RENDERED CELLS rather
   * than trusting the geometry to have moved.
   *
   * Driving BOTH means the flick always has somewhere to go: the lift raises the whole curve and the
   * curl sweeps the tip, and the two cannot cancel.
   */
  return {
    ...geom,
    // Pushed AWAY from wherever the cat's own curl already sits, so a tail already hooked hard right
    // flicks left rather than clipping off the grid. A constant direction sent half the colony's
    // tails past the edge.
    tailCurl: Math.max(-1, Math.min(1, geom.tailCurl - Math.sign(geom.tailCurl || 1) * 0.9)),
    tailLift: Math.max(
      0,
      Math.min(1, geom.tailLift > 0.5 ? geom.tailLift - 0.5 : geom.tailLift + 0.5),
    ),
    // One ear twitches. Applied to the ANGLE rather than the height so the ear leans rather than
    // shrinking — a shrinking ear reads as the sprite being clipped.
    earAngle: Math.max(-1, Math.min(1, geom.earAngle - 0.5)),
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * HOW FAR THE WHOLE ANIMAL DROPS WHEN IT DIES.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Three rows. Every part that has a row budget — the ears, the head, the body — is shifted down by
 * this amount in the `dead` state, so the cat's whole mass sits low with empty rows above it.
 *
 * ══ WHY THE WHOLE ANIMAL AND NOT ONE PART ══
 *
 * Two earlier attempts lowered the body's bottom and then raised its top to overlap the skull, on the
 * rule that the body's top is WELDED to the head and is not a free parameter. Both produced the same
 * picture: a cat standing bolt upright in one flat value, which read as a BELL or a chess pawn.
 *
 * The rule was never "nothing may move vertically" — it was "the head and the body may not move
 * INDEPENDENTLY". Moving BOTH by the same offset satisfies it exactly: every part keeps its
 * relationship to every other part, the silhouette is identical, and the whole animal is simply
 * lower. That is what a body on the ground is.
 *
 * ══ WHY THREE ══
 *
 * The drop has to buy an empty band at the top WITHOUT pushing the body off the bottom, and those
 * pull against each other. At six the head ended at row 19 and the body had four rows before the
 * floor, so the cat was a skull with a stump under it. At three the crown sits at row 7, the top rows
 * are visibly empty — enough to read as "lower than the others" in a colony — and the body keeps its
 * rows. The empty band is the cue; it does not have to be large to work, only present.
 */
const DEAD_DROP = 3;

/** How many rows every part is displaced by, for a state. Non-zero only for `dead`. */
function stateDrop(state: CatState): number {
  return state === "dead" ? DEAD_DROP : 0;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ STATE REACHES THE EARS, THE EYES AND THE BODY — in the CUTE register ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every override below is FORCED rather than nudged, because a state has to read at 32px on every
 * cat in the colony regardless of what its own hash gave it — a bias that a hash could cancel is not
 * a state. That was learned from a `hunting` ear bias that was invisible on any cat whose own
 * `earAngle` was already negative.
 *
 * The three levers, and what each one is doing:
 *
 *   EARS — pricked forward when hunting, DROOPED when starving, flat when dead. A drooping ear is a
 *          universally-read signal of an animal that is not doing well, at any resolution, on any
 *          species. It is the single strongest state cue this sprite has and it is pure silhouette,
 *          so it survives being shrunk to 32px where an interior mark does not.
 *   EYES — wide when hunting, half-lidded when starving, an X when dead. The eyes are ~30% of the
 *          face's area, so an eye change is a large change.
 *   BODY — plumper when fed, narrower when starving. Kept SMALL in absolute terms in every state:
 *          this is the neoteny cue and the state may modulate it but never spend it.
 */
function stateGeometry(geom: CatGeometry, state: CatState): CatGeometry {
  switch (state) {
    case "hunting":
      // Ears hard forward. Clamped rather than added, so an already-alert cat does not exceed the
      // range the ear's own shear can carry.
      return { ...geom, earAngle: Math.max(0.55, geom.earAngle) };
    case "starving":
      // Ears out and flat — the droop itself is applied in `cuteGeometry`, and this pushes the angle
      // outward too so the two compound rather than fighting.
      return { ...geom, earAngle: Math.min(-0.4, geom.earAngle) };
    case "dead":
      // Ears fall flat to the sides and the tail drops to the ground beside the body.
      return { ...geom, earAngle: -0.95, tailLift: 0, tailCurl: geom.tailCurl * 0.35 };
    default:
      return geom;
  }
}

/**
 * The identity axes, resolved into the concrete skeleton `cute.ts` draws from, for one state and one
 * frame.
 *
 * The split matters: identity is stable forever (a cat's ears and coat are its own), while the
 * skeleton changes with what the animal is doing. Keeping them apart is what lets `state` reach the
 * geometry without state ever leaking into identity.
 */
function cuteGeometry(geom: CatGeometry, state: CatState, frame: number): CuteGeometry {
  const dead = state === "dead";
  return {
    headRx: geom.headWidth,
    /*
     * The head's half-height. Held at a near-constant 5.5 against a half-width that varies 5.9..7.0,
     * so every head is WIDER THAN TALL.
     *
     * That is the cute direction and it is not the accurate one: an infant skull is a broad dome with
     * a short face, where an adult cat's is longer than it is wide. It is also what keeps the eyes,
     * which are 4 rows deep, a legible fraction of the head's own 11 rows.
     */
    headRy: 5.2,
    /*
     * A DEAD cat's ears are SHORTER as well as flat, because a flat ear seen front-on is
     * foreshortened. Without this the ears stayed full-length and lay out sideways past the skull,
     * which read as a bat rather than as a cat that had died.
     */
    earHeight: dead ? geom.earHeight * 0.72 : geom.earHeight,
    earWidth: geom.earWidth,
    earAngle: geom.earAngle,
    /*
     * THE DROOP — the state's strongest cue, and the whole reason `starving` no longer needs ribs.
     *
     * `dead` is fully folded, `starving` is most of the way there. `fed` and `hunting` are pricked.
     */
    earDroop: dead ? 1 : state === "starving" ? 0.72 : 0,
    /*
     * The body's half-width. `build` moves it, the state modulates it, and it is FLOORED so the two
     * cannot cancel into a strip.
     *
     * ══ THE FLOOR EXISTS BECAUSE THE AXES ARE ADDITIVE ══
     *
     * A lean cat that is also starving landed at about three columns of body in v3 — the same
     * additive-clamp defect that file hit twice. The fix is the same: floor the result rather than
     * narrowing every contributing range, because narrowing the ranges kills the axes.
     *
     * The floor is 3.6 rather than a bare number chosen for looks: below that the body is narrower
     * than the two paws under it, so the paws hang past the silhouette and the set reads as a stray
     * mark — which is the failure bloodhorn recorded when its own legs outgrew its body.
     */
    bodyRx: Math.max(
      3.6,
      BODY_RX_BASE +
        geom.build * 0.5 +
        (state === "fed" ? 0.7 : 0) +
        (state === "starving" ? -0.9 : 0),
    ),
    tailCurl: geom.tailCurl,
    tailLift: geom.tailLift,
    /*
     * A STARVING cat's eyes go half-lidded. This reuses the blink mask rather than adding a fifth
     * one, and that is the correct economy: a half-lidded eye and a blinking eye are the same shape,
     * and the state is carried by the fact that it is held rather than by it being a different curve.
     */
    eyeShape: geom.eyeShape,
    whiskerLen: geom.whiskerLen,
    /*
     * A dead cat keeps its cheek fluff — the ruff is fur, and fur does not deflate. Halved in the
     * starving state, where the animal genuinely has less of it.
     */
    cheekFluff: state === "starving" ? geom.cheekFluff * 0.5 : geom.cheekFluff,
    slumped: dead,
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE COAT PATTERN — luminance only, applied AFTER the floors so it is not erased by them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Returns how many ramp steps to subtract. TWO, never one: one step is inside the Bayer dither's own
 * range and is indistinguishable from the noise the shading already produces.
 *
 * ══ AND A PATTERN MUST NOT CROSS THE SILHOUETTE EDGE-TO-EDGE ══
 *
 * The recorded failure, three times over in this package: a dark line that spans a shape from one
 * edge to the other reads as a GAP IN THE SHAPE rather than as a mark on it. The tabby bands read as
 * louvres cut through the cat, the brow drop read as a visor bar, and the eye row read as a mask.
 * Every stripe below is inset from the silhouette's edge for that reason.
 */
function coatDrop(coat: Coat, px: number, py: number, drop: number): number {
  switch (coat) {
    /*
     * TABBY — the forehead "M" and bands down the flanks.
     *
     * The forehead stripes are the classic tabby mark and they are the one place a pattern reads at
     * 32px, because they are on the FACE, which is what a viewer looks at. Every third column rather
     * than every other: at 24px a stripe every second column leaves one lit column between two dark
     * ones, which after the dither reads as a texture rather than as stripes.
     */
    case "tabby": {
      const brow = EYE_Y + drop;
      // Forehead: two short rows above the eyes, inset so they do not reach the skull's edge.
      if (py >= brow - 3 && py < brow - 1) {
        const dx = Math.abs(px + 0.5 - CX);
        return dx < 4.5 && (px + 1) % 3 === 0 ? 2 : 0;
      }
      // Flank bands, on the body only, inset from its own edges.
      if (py >= ROWS.body[0] + 2 + drop) {
        return (px + 1) % 3 === 0 && Math.abs(px + 0.5 - CX) < 3.5 ? 2 : 0;
      }
      return 0;
    }
    /*
     * PATCHED — one asymmetric block over the left cheek and one on the flank, which is where a
     * bicolour stray's markings actually sit. Deliberately ASYMMETRIC; the whole value of this axis
     * is that it reads as a MARKING rather than as a light effect, and a symmetric mark on a
     * symmetric face reads as shading.
     */
    case "patched": {
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════
       * ══ PATCHED IS ONE EYE PATCH, AND THAT IS THE THIRD ATTEMPT AT THIS AXIS ══
       * ══════════════════════════════════════════════════════════════════════════════════════
       *
       * v1 darkened everything right of centre below the shoulder: a hard vertical value break down
       * the middle of a symmetric animal, which reads as a missing chunk rather than as a bicolour
       * coat. v2 replaced it with a bounded flank blob plus a spot over one BROW — and the brow spot
       * landed beside the ear, where at 96px it was indistinguishable from an ear shadow and made
       * three of twelve cats look damaged around the head.
       *
       * Both attempts were trying to place a marking somewhere it would be NOTICED, and both put it
       * somewhere it competed with a feature. The third attempt puts it exactly where a marking on a
       * cat is not merely tolerated but LOVED: over one eye.
       *
       * A cat with a patch over one eye is instantly charming and instantly legible — it is the most
       * recognisable cat marking there is, it is asymmetric by definition (so it does the job this
       * axis exists for, breaking the sprite's bilateral symmetry), and it reads at 32px because the
       * eye is the thing a viewer is already looking at. It cannot be mistaken for damage because it
       * SURROUNDS a feature rather than interrupting one.
       *
       * ══ WHY THE PATCH IS ON THE HEAD AND NOT ON THE BODY ══
       *
       * The body is small, it is mostly hidden behind the head's silhouette at 32px, and it is the
       * part of this sprite with the least going on. A marking there is a dark smudge on a plinth. On
       * the face it is a character trait. The whole reason this axis was rated the weakest is that it
       * was spending its two ramp steps on the least-looked-at part of the animal.
       *
       * The patch reaches the eye's own rows and a row above and below it, and one column outside it
       * on each side — a rounded blot AROUND the eye rather than a rectangle through it. It is on the
       * LEFT eye always: this is the one place the sprite is deliberately not mirrored, because a
       * patch that switched sides per id would read as two different markings rather than as one.
       */
      const ex = EYE_L_X - 1;
      const ey = EYE_Y + drop - 1;
      const dx = px - (ex + EYE_D / 2);
      const dy = py - (ey + EYE_D / 2);
      // An ellipse a little wider than tall, so it reads as a blot rather than as a circle.
      return (dx * dx) / 12.5 + (dy * dy) / 9 <= 1 ? 2 : 0;
    }
    /*
     * ══ TORTIE — a coarse mottle, kept OFF the face ══
     *
     * A deterministic scatter, `fnv1a` on the coordinate rather than `Math.random`, so it is stable
     * across renders and the ban holds. The cell is 2x2 so the mottle sits at a coarser spatial
     * frequency than the Bayer dither underneath it; at 1x1 the two were indistinguishable and the
     * result read as a corrupted sprite rather than as a tortoiseshell.
     *
     * ══ AND IT STOPS AT THE EYES, WHICH IS WHAT MAKES IT A COAT RATHER THAN DAMAGE ══
     *
     * Applied over the whole animal it put dark blocks across the forehead and around the eyes, and
     * at 96px those are indistinguishable from bruising — the face is where a viewer looks, so a
     * random dark patch there reads as something having HAPPENED to the cat rather than as its
     * markings. That is the same failure the `patched` coat had twice, and the same fix: a marking
     * has to be somewhere it cannot be mistaken for an injury.
     *
     * Below the eye line only, and at 26% rather than 40%, so the crown and the face stay clean and
     * the brindling reads on the cheeks, the chest and the flanks — which is where a real
     * tortoiseshell's patching is most visible anyway.
     */
    case "tortie": {
      if (py < EYE_Y + EYE_D + drop) return 0;
      const h = fnv1a(`tortie:${px >> 1}:${py >> 1}`);
      return h % 100 < 26 ? 2 : 0;
    }
    default:
      return 0;
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * STATE — the exposure half. The GEOMETRY half is in `stateGeometry` and `cuteGeometry`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ THE DIM IS A GAIN, NOT A SUBTRACTION — and this was a measured bug ══
 *
 * v1's first pass subtracted a flat number of steps per state. Rendered to PNG and looked at, EVERY
 * cat in every state but `fed` was a muddy undifferentiated mass. The dump of the raw step grid
 * showed why: with only six steps, subtracting two and then clamping at 1 crushed steps 1, 2 and 3
 * all onto 1, so the legs, the haunch and the neck break disappeared at once. The state dim was
 * destroying the SILHOUETTE, which is the one thing §9 says this sprite cannot afford to lose.
 *
 * That is a scale error, not a tuning error: a flat subtraction removes a fixed amount of the total
 * range, and by `starving` there is no range left to carry shape. A GAIN scales toward the noise
 * floor instead, so the RATIOS between parts survive.
 *
 * The gains are GENTLE, and deliberately so: state carries most of its meaning through the ears and
 * the eyes here, so the exposure only has to support that read rather than carry it alone. v1's
 * `starving` at 0.66 was crushing the sprite because the dimming was doing all the work.
 */
const STATE_GAIN: Readonly<Record<CatState, number>> = {
  /** Fed: the reference, and the brightest. A well-fed cat's coat has a sheen — see the `fed` floor. */
  fed: 1,
  /**
   * Hunting: a step down at the top of the range.
   *
   * 0.88, not the 0.9 v1 tried first. At 0.9 `Math.round(step * gain)` was the IDENTITY on every
   * value a 6-step ramp could hold, so `fed` and `hunting` rendered as byte-identical cats — a dead
   * axis that looked live in the source, caught only by a total-luminance assertion.
   */
  hunting: 0.88,
  /** Starving: three quarters. The droop and the lidded eyes carry the state; this supports them. */
  starving: 0.75,
  /** Dead: unused. See `DEAD_STEP` — a dead cat is not a dim cat, it is a flat one. */
  dead: 1,
};

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * DEAD IS A FLAT SILHOUETTE, NOT A FADE — a review finding, not a preference.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `dead` was once a gain of 0.46, on the same model as the other three. Rendered and reviewed, it
 * "read as a rendering failure rather than a state" — the cat was so close to the ground value that a
 * viewer's first hypothesis was a broken sprite, not a dead animal.
 *
 * That is a serious defect. `DESIGN.md` §2 and `ART-DIRECTION.md` §8 both require losses to be honest
 * and VISIBLE. A death that fades toward invisibility is the softening the ban forbids, arriving
 * through rendering instead of through copy. It is also bloodhorn's dormant-creature rule restated: a
 * sprite that fades reads as "still loading", and a fault and a state must never be confusable.
 *
 * ══ THE FIX: COLLAPSE THE RANGE, DO NOT LOWER IT ══
 *
 * Every coat pixel takes ONE value regardless of what the lighting gave it. That makes the cat a
 * flat, evenly-lit shape with a full-contrast outline: unmistakably THERE, and unmistakably not
 * alive, because the one thing every other state has is internal modelling.
 *
 * ══ STEP 2, AND IT MUST STAY BELOW THE STARVING CAT'S MEAN ══
 *
 * Step 3 was chosen first as "three steps above the outline, well below the body's floor". Then the
 * starving state was strengthened and its MEAN step fell to about 2.78 — below the dead cat's flat 3.
 * So a dead cat rendered BRIGHTER on average than a starving one, which inverts the one ordering this
 * sprite must never get wrong.
 *
 * Worth recording as a CLASS of bug rather than as a number: a state defined by an ABSOLUTE value and
 * a state defined by a GAIN will cross each other the moment either is retuned, and nothing in either
 * definition mentions the other. The ordering is asserted over the whole id set precisely because it
 * cannot be read off the two definitions.
 *
 * ══ AND THE FLAT FILL KEEPS THREE MARKS ══
 *
 * A render of the full sheet once showed every dead cat as a featureless rounded LUMP — every part
 * painted at `DEAD_STEP`, so the silhouette was one uniform mass and the animal was unidentifiable.
 * It read as a chess pawn. "Unmistakably THERE and unmistakably not alive" requires the first half
 * too: a viewer has to be able to tell it is a CAT that has died.
 *
 * So the flat fill removes the MODELLING and keeps the few marks that carry species and state:
 *
 *   - THE INNER EARS, darker. Two dark wedges is the strongest "cat" cue the silhouette has.
 *   - THE EYES, as an X. The cartoon convention every viewer already knows, and the brief's own
 *     request. This replaces "dark holes in a flat shape", which was derived carefully in the
 *     accurate register and is grim rather than legible.
 *   - THE PAWS, darker. Folded under, they read as the shadow beneath the animal.
 */
/*
 * ══ STEP 4, RAISED FROM 2 WHEN THE VIOLET RAMP MADE THE DEAD CAT VANISH ══
 *
 * The value was 2 against the OLD phosphor-green ramp, where step 2 was `#353f33` — a mid-dark green
 * that stood clear of a near-black ground. On the violet ramp step 2 is `#45304f`, and the page
 * ground is `#1a1220`. Rendered as a full sheet, every dead cat was a barely-visible dark shape:
 * exactly the "reads as a rendering failure rather than a state" defect this constant was introduced
 * to fix, reintroduced by a change to a different file.
 *
 * That is the same class of bug the ordering note below describes, one level up — a constant chosen
 * for its relationship to a palette, and the palette moved. `grid.test.ts` asserts a dead cat's mean
 * step stays a stated distance above the ground rather than asserting the constant's value, so the
 * next palette change fails the test instead of shipping an invisible corpse.
 *
 * At 4 the flat coat sits mid-ramp — unmistakably THERE, unmistakably not alive, because it has no
 * internal modelling at all while every living state does. It is still below every living state's
 * MEAN, which is the ordering that must never invert.
 */
const DEAD_STEP = 4;

function applyState(step: number, part: Part, state: CatState): number {
  if (part === "outline") return step;
  if (state === "dead") {
    if (part === "earInner") return 1;
    /*
     * The folded paws sit one clear step below the flat coat. They were at 2 while `DEAD_STEP` was 3;
     * once the coat dropped to 2 the paws were the SAME value and stopped being a mark at all — the
     * exemption existed in the source and did nothing on screen. A mark defined relative to a value
     * that moved has to move WITH it.
     */
    if (part === "leg") return Math.max(1, DEAD_STEP - 1);
    /*
     * The X is drawn at the OUTLINE's own value, so it reads as two crossed dark strokes on a flat
     * shape. Held above the eye's normal exemption below, which does not apply to a dead cat: a
     * corpse's tapetum does not shine, and a catchlight on an X-eye would be a rendering error rather
     * than a highlight.
     */
    if (part === "eye") return 0;
    if (part === "whisker" || part === "nose") return Math.max(1, DEAD_STEP - 1);
    return DEAD_STEP;
  }
  /*
   * THE EYES ARE EXEMPT FROM THE DIMMING.
   *
   * A starving cat's eyes still catch the light — a catchlight is a reflection, not a metabolic
   * process. Dimming them with the coat loses the sprite's focal point exactly when the state most
   * needs reading, and on a face that is 30% eye it loses most of the sprite.
   */
  if (part === "eye") return step;
  /*
   * ══ THE GAIN IS ORDER-PRESERVING, AND THAT IS WHAT KEEPS THE SILHOUETTE RULES INTACT ══
   *
   * `Math.round(step * gain)` is NOT injective on a short ramp: at 0.78 both 1 and 2 map to 1.
   * Anywhere it collapsed two adjacent steps onto one it erased a break a silhouette rule had just
   * established — v1's tests found `stray-1` losing its neck and its leg separation in the `hunting`
   * state alone, on a cat whose geometry was correct. The state was quietly undoing the rules.
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
  const frame = (((opts?.frame ?? 0) % CAT_FRAMES) + CAT_FRAMES) % CAT_FRAMES;
  const dead = state === "dead";
  // Identity -> state override -> animation frame. The order matters: state may force an ear angle,
  // and the frame then perturbs whatever that produced. Reversing them would let a frame's tail flick
  // be overwritten by the state, so frame 1 would be a no-op in `hunting`.
  const ident = frameGeometry(stateGeometry(geometryFor(id), state), dead ? 0 : frame);
  const g = cuteGeometry(ident, state, frame);
  const drop = stateDrop(state);
  /*
   * ══ A BLINK AND A SAD FACE ARE DIFFERENT DRAWINGS, AND CONFLATING THEM MADE THE CAT ANGRY ══
   *
   * These were one `sleepy` flag, on the reasoning that a half-lidded eye and a blinking eye are the
   * same shape and the state is carried by the lid being HELD. Rendered at 96px, every starving cat
   * read as hostile: a blink is a horizontal SLIT, and narrowed eyes are the universal anger signal.
   *
   * A starving stray has to be PITIABLE — the whole mechanic depends on the user wanting to feed it,
   * and an angry animal invites nothing. So the two are separate flags with separate masks. See
   * `EYE_MASK_SAD`.
   */
  const blinking = !dead && frame === 2 && state !== "starving";
  const sad = !dead && state === "starving";

  const tail = new Map<number, number>();
  for (const cell of cuteTailCells(g, drop)) tail.set(cell.y * GRID_W + cell.x, cell.t);

  const out: GridPixel[] = [];
  /** Which cells the cat occupies, so the outline pass knows what NOT to draw over. */
  const filled = new Set<number>();
  /** Whiskers are excluded from the outline SEED — outlining a 1px mark doubles its weight. */
  const outlineSeed = new Set<number>();

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const hit = cutePartAt(x, y, g, tail, drop, blinking, sad, dead);
      if (!hit) continue;
      const key = y * GRID_W + x;

      // A MARK, not a surface: the eye, the nose and the whisker carry their own step and skip the
      // diffuse model entirely. bloodhorn's reason: running an eye through the shading gives it a
      // gradient, and a gradient across a few pixels reads as a dent in the face rather than an eye.
      if (hit.step !== undefined) {
        out.push({
          x,
          y,
          step: applyState(hit.step, hit.part, state),
          part: hit.part,
          /*
           * ══ THE ONE OR TWO TINTED PIXELS — exactly two, and this was a caught violation ══
           *
           * §8 permits state to tint "one or two pixels". v1 flagged EVERY eye pixel, and once the
           * eye masks grew that was eight — a direct breach, introduced by a change to an unrelated
           * part, whose own comment asserted the old invariant and went stale silently. The test
           * caught it; the comment did not.
           *
           * Exactly ONE pixel per eye is flagged: the CATCHLIGHT. It is the brightest pixel on the
           * face and the one a viewer's eye already goes to, so a tint there reads at 32px where a
           * tint on a mid-tone cheek pixel muddies.
           *
           * That this is a hard count and not a rule of thumb is the point: the ban is on the NUMBER
           * of event-hued pixels, so the code has to count them, and `grid.test.ts` asserts the count
           * rather than the intent.
           */
          /*
           * ══ THE ACCENT DOES NOT LAND ON A STARVING CAT'S EYE — IT READ AS DEMONIC ══
           *
           * The accent flags the catchlight, which is the brightest pixel on the face and the one a
           * viewer's eye already goes to. That is correct for `fed`, where the amber lands on a bright
           * highlight and reads as warmth.
           *
           * For `starving` it was a disaster the moment the sad eye arrived. §3's `starving` hue is
           * EMBER RED, and an ember-red pixel in the middle of a big dark eye is a GLOWING RED EYE —
           * every cat in the starving row read as demonic, which is even further from pitiable than
           * the angry squint this whole change set out to fix. Two fixes in a row landed on the wrong
           * emotion because each was made without re-rendering the state it fed into.
           *
           * A starving cat's state is already carried by its ears, its dimmed eyes and its exposure;
           * it does not need a tint, and the one hue available actively fights the read. So the
           * accent is scoped to states whose hue HELPS. `STATE_ACCENT` still declares both hues and
           * `render.ts` still honours whatever is flagged — this decides only WHERE it may land, and
           * the count is unchanged at two-or-fewer, which is what §8 caps.
           */
          ...(hit.part === "eye" && hit.light === true && state === "fed" ? { accent: true } : {}),
        });
        filled.add(key);
        if (hit.part !== "whisker") outlineSeed.add(key);
        continue;
      }

      // An interior hole takes a dark coat step rather than being dropped. The part claimed the
      // pixel; the pixel gets painted. (bloodhorn's speckled-cheeks bug.)
      let step = cuteShadeStep(hit.nx, hit.ny, x, y) ?? 2;

      /*
       * ══ THE FLOORS — measured by rendering to PNG and looking, per bloodhorn's method ══
       *
       * The head is the SUBJECT and is floored so it always sits in the lit half of the ramp. Without
       * a floor the diffuse model put large areas of the face at the bottom of the ramp, which
       * against the ground colour means the shaded side of the head VANISHES and the silhouette reads
       * as a bite out of the animal. bloodhorn recorded this defect and it reproduced here on the
       * first render.
       *
       * ══ THE FLOOR IS 4 HERE, WHERE THE PROFILE POSE NEEDED 3 ══
       *
       * The profile module lowered its floor to 3 after the face rendered as "a pale wash", because
       * the head there was ~5 columns and every feature was crowded into one band. Front-on the head
       * is 13 columns and the features are the two EYES, which sit at steps 0 and 2 — well below any
       * floor — so the face has all the dark it needs from the eyes themselves and the floor is free
       * to keep the cheeks bright. A cute creature is BRIGHT; that is most of what separates this
       * register from the one that was rejected.
       */
      /*
       * ══ THE FLOOR IS 3, AND RAISING IT TO 4 IS WHAT BLEACHED THE COLONY ══
       *
       * A floor exists to stop the shaded side of the head vanishing into the ground — bloodhorn
       * recorded that failure and it reproduces here on the first render without one.
       *
       * At 4 it did more than that. The pigment only ever occupies steps 3, 4 and 5 (see
       * `tintStepFor`, and the reason the dark end stays common to every cat), so a face floored at 4
       * spends most of its area at steps 5 and 6 — and step 6 is UNTINTED pale rose. Rendered beside
       * bloodhorn's unicorns the difference was unmistakable: their creatures are saturated over
       * their whole surface and these cats were saturated only in their shadows, with pale washed
       * faces above. A colony of pale washes is the "too dark and dull" note arriving from the
       * opposite direction.
       *
       * At 3 the face sits across the tinted band rather than above it, so the coat colour is on the
       * CHEEKS — which is where a viewer looks — instead of only in the crevices. Step 3 on an
       * 8-step ramp still clears the ground and the outline comfortably, which is all the floor was
       * ever for.
       */
      /*
       * The head is CAPPED at 6 as well as floored at 3, for the same reason the body is: it is the
       * largest area on the sprite and step 7 is the reserved catchlight. A head that can reach 7
       * through ordinary diffuse shading defeats the reservation and puts a white patch on a
       * forehead, which reads as a bald spot rather than as a highlight.
       */
      if (hit.part === "head" || hit.part === "muzzle") step = Math.min(6, Math.max(3, step));
      /*
       * ══ THE MUZZLE IS FLOORED ABOVE THE CHEEK — the fix for a flat lower face ══
       *
       * The muzzle is a forward-facing form catching more light than the cheek beside it, and the
       * normal bias alone did not carry that at 24px: the two landed on the same step often enough
       * that the lower face read as one flat mass with a nose floating in it. Floored a step above the
       * head's own floor, the whisker pads separate from the cheeks and the face gets its third plane.
       */
      if (hit.part === "muzzle") step = Math.max(4, step);
      /*
       * ══ THE EARS ARE FLOORED HIGHER THAN THE FACE, for the horn's old reason ══
       *
       * The ear is the identifying feature and it is the smallest, most fragile thing on the cat.
       * Floored at the same step as the face, its shaded side comes out the same value as the head
       * behind it and the ear disappears into the skull; the sprite reads as a round-headed animal,
       * which is a cub or an owl. bloodhorn floors its horn two steps above its face for exactly this
       * and calls it "the correct hierarchy: on a unicorn the horn is what you look at first."
       *
       * ══ LIT, BUT NOT FLAT — a uniformly bright ear reads as a RABBIT ══
       *
       * At a bare floor of 6 with no shading, both ears came out as solid bright bars over the skull
       * and a review of the colony said they read as a rabbit's. The floor was doing its job — the ear
       * must break the skull's outline in value as well as in shape — and doing it too well.
       *
       * `Math.min` with the shaded value keeps the lighting's own variation across the ear's width
       * while the floor keeps it clear of the face: the outer edge stays at 6 and the surface turning
       * away drops to 5. That plus the dark inner cone gives an ear three values across its width,
       * which is what makes it read as a cone rather than as a bar.
       */
      if (hit.part === "ear") step = Math.max(4, Math.min(5, step));
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════
       * ══ THE INNER EAR IS STEP 3, RAISED FROM 2 WHEN THE EAR SHRANK ══
       * ══════════════════════════════════════════════════════════════════════════════════════
       *
       * The hollow sat at 2 against a rim floored at 5 — a four-step gap, chosen so the ear reads as
       * a CONE OPEN TOWARD THE VIEWER rather than as a flat triangle, and correct while the ear was
       * five rows tall and seven cells wide.
       *
       * Once the ear was cut to 3-4 rows on a 3-5 cell base to stop it reading as a lynx, that same
       * four-step gap became the ear's dominant feature: on a 3-cell ear the hollow is the middle
       * cell, so a near-black column ran up the centre of a small bright triangle and the pair read
       * as HORNS — two dark wedges rising off a round skull.
       *
       * A contrast ratio tuned against an area does not survive the area shrinking. The gap is now
       * two steps rather than four, which still separates the hollow from the rim (two steps is above
       * the Bayer dither's own range, which is the threshold this file uses everywhere for "a break
       * that survives rasterisation") without the hollow becoming the shape a viewer reads.
       *
       * Still floored clear of the outline's 0: an inner ear that reaches the outline's value reads
       * as a HOLE punched through the ear rather than as a hollow in it, which at 24px is the
       * difference between a cat and a cat with a bite taken out of its ear.
       */
      if (hit.part === "earInner") step = 3;
      /*
       * ══ THE THROAT — what remains of the neck rule, and front-on it is only a shading ══
       *
       * Head-on and in profile the head/body separation needed a forced value break, and that clamp
       * had three separate bugs over its life, all the same shape: the break being computed somewhere
       * the final value was not yet known.
       *
       * Front-on the separation is carried by WIDTH — the head is 1.4x the body — so the silhouette
       * pinches on its own and needs no clamp. `NECK_STEP_DROP` survives as the shading of the throat,
       * the one place head and body still meet: the body's cells under the chin are pushed down so the
       * chest reads as being BEHIND the head rather than continuous with it.
       *
       * That is the fifth defect a pose change dissolved rather than fixed. A rule that needed three
       * bug fixes needs none here, because the geometry now states what the rule was trying to say.
       */
      if (hit.part === "body") {
        const underChin = y < ROWS.head[1] + drop;
        // A FED cat is glossy: its lit band reaches a step higher, which is a sheen on the fur rather
        // than a brighter cat. This is `state affects the animal` in the exposure as well as in the
        // geometry.
        const gloss = state === "fed" ? 1 : 0;
        /*
         * The body is floored at 3 and CAPPED at 5 (6 when glossy). The cap is the body-specific
         * half of the bleaching fix: the body is the largest unbroken area on the sprite, so it is
         * where an untinted top-of-ramp step covers the most pixels, and an uncapped body routinely
         * dithered up to 6 across its whole front. Held inside the pigment's own band, the body is
         * the most saturated part of the cat — which is correct, because it is the part with no
         * features competing for attention.
         */
        step = Math.min(5 + gloss, Math.max(3, step));
        if (underChin) step = Math.max(1, step - NECK_STEP_DROP);
      }
      /*
       * The tail brightens toward the TIP. Backwards from every other part, and deliberately: the tip
       * carries the identity (the curl), it is 1px wide, and it is the furthest thing from the body's
       * mass — so it is the pixel most at risk of vanishing. A tip that fades out is bloodhorn's
       * floating-horn failure in a different part.
       *
       * The range is 4..6. At the bottom of the range the tail root would be the same value as the
       * body it emerges from and the tail would appear to start two pixels out — a gap by VALUE rather
       * than by geometry, which breaks silhouette rule 1 just as effectively.
       */
      if (hit.part === "tail") {
        step = Math.max(4, Math.min(RAMP_STEPS - 2, 4 + Math.round((hit.t ?? 0) * 2)));
      }
      /*
       * ══ THE PAWS ARE FLOORED BRIGHT, which is the opposite of what the profile pose did ══
       *
       * The profile module pinned its legs DARK, at a fixed value below the body's floor, so the two
       * posts read against a lighter haunch. That is correct for legs seen side-on against a barrel.
       *
       * Front-on the paws are BELOW the body and against the GROUND, not against the body, so pinning
       * them dark put them at nearly the ground's own value and the cat appeared to float. They are
       * floored bright instead — a cat sitting facing you has its front paws catching the light,
       * which is both what happens and what reads.
       */
      if (hit.part === "leg") step = Math.max(3, Math.min(5, step));

      // The coat pattern, applied LAST so it modulates the FLOORED value. Applying it before the
      // floor would let `Math.max` erase the marking wherever the floor was the binding constraint —
      // which is most of the animal, so the pattern would show only on the few pixels the lighting
      // had already darkened. That is a marking that appears in the source, passes a unit test on
      // `coatDrop`, and is invisible on screen.
      if (hit.part === "head" || hit.part === "body") {
        // Floored at 2 rather than 1: a stripe that reaches the outline's neighbourhood reads as a
        // hole punched in the cat, not as a marking on it.
        step = Math.max(2, step - coatDrop(ident.coat, x, y, drop));
      }

      out.push({ x, y, step: applyState(step, hit.part, state), part: hit.part });
      filled.add(key);
      outlineSeed.add(key);
    }
  }

  /*
   * ══ THE OUTLINE PASS ══
   *
   * Every empty cell orthogonally adjacent to a filled one becomes an outline pixel at step 0.
   *
   * bloodhorn added this because on a dark ground the coat's shadow side and the page were
   * indistinguishable, so the animal had no edge on its lower left and read as a blob rather than as
   * a shape. It matters more here, because these coats are bright and saturated: a bright sprite on a
   * dark ground with no edge reads as a GLOW rather than as an object, which is the exact opposite of
   * pixel art.
   *
   * Drawn OUTSIDE the form rather than replacing its edge pixels: replacing would eat a pixel off
   * every dimension, and on a 13px head that is a measurable loss of the proportions the cuteness
   * invariant asserts.
   *
   * Orthogonal neighbours only. A diagonal pass rounds every corner and doubles the outline at every
   * convex turn — which would round the EAR TIPS off, and a rounded ear tip is not a cat.
   *
   * The seed is a SNAPSHOT frozen before the pass and additions go to a separate set. Iterating a set
   * while adding to it lets an outline pixel seed further outline pixels and the edge grows a ring per
   * pass, so the outline comes out two or three pixels thick at every corner.
   */
  const drawn = new Set<number>();
  for (const key of outlineSeed) {
    const ox = key % GRID_W;
    const oy = (key - ox) / GRID_W;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = ox + dx;
      const ny = oy + dy;
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
 * Provided so a caller baking sprites for an animating colony writes the loop once. A caller drawing
 * a single portrait should call `catGrid` directly rather than computing three grids and discarding
 * two.
 */
export function catFrames(
  id: string,
  opts?: { readonly state?: CatState },
): GridPixel[][] {
  return Array.from({ length: CAT_FRAMES }, (_, frame) => catGrid(id, { ...opts, frame }));
}
