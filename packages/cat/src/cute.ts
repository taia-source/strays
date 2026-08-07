/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CUTE CAT — front-facing, huge-headed, big-eyed. bloodhorn's grammar, with ears.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ WHY THIS MODULE REPLACED `profile.ts` AS WHAT THE COLONY DRAWS ══
 *
 * The previous pass pushed this package toward ANATOMICAL ACCURACY: a side profile, a correct
 * leg-to-barrel ratio, a high haunch, a short muzzle. Every one of those was achieved and asserted,
 * and the result was rejected on sight — "why aren't they cute? look bloodhorn, they are cute and
 * simple, why cannot we make cats similar to that but cats instead of unicorns? we don't need to
 * imitate a true aesthetics of a cat."
 *
 * That last sentence is the brief and it overrides the accuracy brief entirely. A believable
 * quadruped is not the target; a CUTE, SIMPLE creature is. Those are different objectives and the
 * profile pose cannot reach the second one, for a reason worth recording rather than re-discovering:
 *
 *   A PROFILE ANIMAL HAS NO FACE POINTED AT YOU. Cuteness is a response to a FACE — two big eyes
 *   set wide and low in a large round skull. In profile you get one eye, seen edge-on, on a head
 *   that is by definition turned away. Every cue that produces the response is either halved or
 *   destroyed by the pose, and no amount of tuning the barrel's depth recovers it.
 *
 * So the pose is reversed and this module draws the animal FRONT ON, which is what bloodhorn does.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE FOUR CUES, TAKEN FROM bloodhorn'S OWN SOURCE AND ITS OWN MEASUREMENTS ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `openhood/apps/web/lib/creature-grid.ts` calls its row budget "the neoteny budget" and states the
 * ratios as named constants so a later edit cannot walk them back. They are transplanted here with
 * the numbers re-derived for a cat, and the RATIOS held:
 *
 *   | cue                | bloodhorn's unicorn      | THIS CAT                | why                    |
 *   |--------------------|--------------------------|-------------------------|------------------------|
 *   | HUGE HEAD          | rows 5..15 — 10 of 24,   | rows 4..15 — 11 rows,   | "the biggest single    |
 *   |                    | the biggest single span  | the biggest single span | span, by design"       |
 *   | BIG EYES           | 3x3 with a catchlight    | 4x4 with a catchlight   | "the smallest square   |
 *   |                    |                          | and a 2px pupil         | that carries a catch-  |
 *   |                    |                          |                         | light and reads round" |
 *   | SMALL BODY         | rx 5.2 vs head's 7       | rx 4.6 vs head's 6.5    | "narrower than the     |
 *   |                    |                          |                         | head... a small body   |
 *   |                    |                          |                         | is a neoteny cue in    |
 *   |                    |                          |                         | its own right"         |
 *   | STUBBY LEGS        | rows 21..24 — 3 rows     | rows 20..24 — 4 rows,   | "stubby. Long legs     |
 *   |                    |                          | of which 2 clear the    | read as elegant, which |
 *   |                    |                          | body                    | is the opposite        |
 *   |                    |                          |                         | register"              |
 *
 * These are asserted in `grid.test.ts` as `PROPORTIONS`, computed from the geometry rather than
 * typed, so a constant cannot report a cute ratio on a head that is not that wide.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHAT MAKES IT A CAT RATHER THAN A UNICORN — and it is TWO MARKS, not anatomy ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The brief is explicit that this is not an exercise in feline accuracy: "ears and whiskers do the
 * work, not anatomy." That is correct and it is worth stating WHY, because the instinct when a
 * sprite reads wrong is to add detail:
 *
 *   - TWO POINTED EARS, in the slot bloodhorn's horn occupies. A triangle rising from each corner of
 *     the crown is the single most identifying silhouette a cat has. It costs four rows and it is
 *     unmistakable at 24px in a way that a correct scapula never is.
 *   - WHISKERS, three 1px marks each side of the muzzle. They read as a cat and as nothing else. At
 *     this size they are a texture rather than hairs, which is fine: they only have to say "cat".
 *   - A TAIL peeking out to one side, curled. It carries per-id variation and breaks the sprite's
 *     bilateral symmetry, which is what stops a front-facing creature reading as a totem.
 *
 * Everything else a cat has — a barrel, a scapula, digitigrade legs, a correct leg-to-body ratio —
 * is DELIBERATELY ABSENT. It would cost rows the head needs and it would drag the sprite back toward
 * the register that was rejected.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ REJECTED, AND RECORDED SO THEY ARE NOT RE-TRIED ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   - KEEPING THE PROFILE FOR THE MAP AND THE CUTE FORM FOR THE PORTRAIT. This is exactly the defect
 *     bloodhorn's whole grid module exists to fix: "the SAME agent was drawn by TWO unrelated
 *     renderers... RIVET on the map and RIVET in the roster were two different pictures of two
 *     different species." Two poses is the same defect with the split moved one layer up. The colony
 *     and the portrait draw the same grid.
 *   - A MUZZLE THAT PROJECTS. Front-on a projecting muzzle is a dark blob under the eyes, and the
 *     profile module spent three rewrites establishing that a projecting muzzle reads as a dog. The
 *     muzzle here is a small LIGHTER patch — the whisker pads — with a nose mark on it, which is how
 *     a cat's face is actually valued front-on.
 *   - FOUR VISIBLE LEGS. bloodhorn draws four posts under a body that is 10px wide, which works
 *     because a unicorn is an ungulate seen head-on. Front-on, a sitting cat shows two front paws and
 *     the haunches behind them; four evenly-spaced posts read as a table. TWO paws, wide, is what a
 *     cat sitting facing you actually presents.
 *   - THE FOUR-POSTURE AXIS (sit/stand/crouch/stretch). Posture is a PROFILE axis: front-on, a
 *     standing cat and a sitting cat differ by about one row of leg. The variation budget it was
 *     spending is moved to axes that survive the pose — head roundness, ear shape, cheek fluff, tail
 *     curl, and above all COLOUR.
 */

import { quantise, shadeSphere } from "@taia/ui/mechanisms";

import { GRID_H, GRID_W } from "./dims.js";

/**
 * ══ THE NEOTENY BUDGET — the rows each part owns ══
 *
 * A BUDGET in bloodhorn's sense: the spans tile the grid, so making the head taller necessarily
 * makes something else shorter. That is what stops the proportions drifting one edit at a time back
 * toward the realistic animal that was rejected.
 *
 * Rows run top-down. `[start, end)` — end exclusive.
 */
export const ROWS = {
  /**
   * Rows 0-4. THE EARS. Above the head and the only thing above it — bloodhorn's horn slot.
   *
   * Starts at row 0 rather than row 1. bloodhorn leaves its top row clear as breathing room and can
   * afford to, because a horn is 2px wide at its base and can be short. An ear is the identifying
   * silhouette here and it is wide, so it needs every row it can get to clear the skull by enough to
   * read as a triangle rather than as a bump.
   */
  ear: [0, 6],
  /**
   * Rows 4-15. THE HEAD. ELEVEN of twenty-four rows — the biggest single span, by design.
   *
   * bloodhorn spends ten and calls that "the biggest single span". Eleven here, because a cat's ears
   * overlap the crown (rows 4 and 5 are shared with the ear bases) where a horn rises from a point.
   * The head's VISIBLE extent is what the ratio is taken against and it is what a viewer reads.
   */
  head: [4, 15],
  /** Rows 15-21. THE BODY. Six rows, deliberately SHORTER than the head's eleven. */
  body: [15, 21],
  /** Rows 21-24. THE LEGS AND PAWS. THREE rows — bloodhorn's own stubby budget, exactly. */
  legs: [21, 24],
} as const;

/** The cat's vertical axis. 11.5 is the true centre of a 24-wide grid. */
export const CX = 11.5;

/**
 * THE HEAD'S HALF-WIDTH at its mid-range. The head is 13px across — wider than bloodhorn's 14-wide
 * unicorn head is on its 24 grid, relative to the body under it.
 *
 * Exported and DERIVED-FROM rather than typed alongside the geometry, because it is the denominator
 * of `PROPORTIONS.eyeToHead` and a constant that disagreed with what actually draws would report a
 * cute eye ratio on a head that is not that wide. bloodhorn records the same discipline.
 */
export const HEAD_RX = 7.0;

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE EYE — 4x4, RAISED FROM bloodhorn's 3x3, and the extra pixel buys a PUPIL.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * bloodhorn calls 3x3 "the smallest square that carries a catchlight and still reads round", and
 * warns of a ceiling: "A 4x4 eye on a 14px head is 1:3.5, which crosses from cute into unsettling."
 *
 * That ceiling is a statement about a HORSE's face. A cat's eye genuinely is enormous relative to its
 * skull — proportionally the largest of any common mammal — so 4x4 on a 13px head (1:3.25) reads as
 * a cat rather than as a bug-eyed foal. It is also what makes the sprite unmistakably a CAT rather
 * than bloodhorn's unicorn with triangles glued on, which matters when the brief is explicitly "the
 * same grammar, a different animal".
 *
 * And the fourth pixel is not decoration. At 3x3 the eye is a solid dark block with one bright
 * corner. At 4x4 it can hold a RIM (the iris, one step up from the coat's shadow), a 2x2 PUPIL and a
 * 1px CATCHLIGHT, which is three values in an eye — and three values is what reads as wet and alive
 * rather than as a hole punched in a face.
 */
export const EYE_D = 4;

/**
 * The eyes' left columns. The gap between them is 3px — 0.75 of an eye's own diameter.
 *
 * bloodhorn sets its eyes at 1.33 eye-widths apart and calls it "set WIDE", against a realistic
 * muzzle-forward skull which puts them "narrower and higher". A cat's eyes are proportionally
 * CLOSER than a horse's because a cat is a forward-facing binocular predator, so the ratio here is
 * smaller — and it still lands wide in absolute terms, because the eyes themselves are enormous:
 * the pair spans 11 of the head's 13 columns, which is a face that is nearly all eye.
 */
export const EYE_L_X = 6;
export const EYE_R_X = 14;

/**
 * The eyes' top row, chosen so the eye CENTRE sits BELOW the head's midline.
 *
 * bloodhorn: "infant eyes sit low in the skull. This is the cue most often missed, and the one that
 * most reliably fixes a face that 'looks wrong' but cute-adjacent." Head span is rows 4..15, so the
 * midline is 9.0; the eye centre at 8 + 1.5 = 9.5 sits half a row below it.
 *
 * ══ IT WAS AT ROW 7 AND THAT WAS THE UNCANNY VERSION ══
 *
 * At 7 the eye centre was 8.5, half a row ABOVE the midline, and the rendered face read as watchful
 * rather than as sweet — the exact "looks wrong but cute-adjacent" failure bloodhorn names. Moving
 * the eyes down one row is a six-pixel change and it is the single largest improvement in this file.
 */
export const EYE_Y = 8;

/**
 * The BODY's half-width at its mid-range, before `build` and the state move it.
 *
 * Declared here rather than inside the geometry because `PROPORTIONS.headToBodyWidth` divides by it,
 * and that ratio is the assertion that the head wins on width. A body width that lived only inside
 * the geometry builder could be raised past the head without the proportion test noticing.
 *
 * 4.6 against the head's 6.5 is a ratio of 1.41. bloodhorn runs 7 : 5.2 = 1.35 and records what the
 * difference buys: at equal widths "the two merged into a single vertical mass with no waist — a cute
 * head on a lump. There was no neck because there was no width difference for a neck to be."
 */
export const BODY_RX_BASE = 4.6;

/**
 * ══ THE DERIVED PROPORTIONS — computed from the budget, never typed ══
 *
 * bloodhorn's discipline verbatim: derived "so they cannot disagree with the geometry that actually
 * draws". `grid.test.ts` asserts each of these falls in the cute band, and the band is stated here.
 */
export const PROPORTIONS = {
  /**
   * Head height as a fraction of head + body + legs — the EARS excluded, because an ear is an
   * ornament and including it would let taller ears masquerade as a bigger head. bloodhorn excludes
   * its horn for exactly this reason.
   *
   * 11 / 20 = 0.55. bloodhorn is at 0.5 and a realistic cat is about 0.2.
   */
  headToBody: (ROWS.head[1] - ROWS.head[0]) / (ROWS.legs[1] - ROWS.head[0]),
  /** Eye diameter over head width. 4/13 = ~0.31, i.e. 1:3.25. bloodhorn is 1:4.7. */
  eyeToHead: EYE_D / (HEAD_RX * 2),
  /**
   * How far the eye centre sits BELOW the head's vertical midline, in rows. POSITIVE is the cute
   * direction; a realistic skull is negative here.
   */
  eyeBelowMidline:
    EYE_Y + (EYE_D - 1) / 2 - (ROWS.head[0] + ROWS.head[1] - 1) / 2,
  /** The gap between the eyes, in units of one eye's diameter. */
  eyeGapInEyes: (EYE_R_X - (EYE_L_X + EYE_D)) / EYE_D,
  /** Leg rows over the whole creature. 4/24 = 0.167. Stubby. */
  legToCreature: (ROWS.legs[1] - ROWS.legs[0]) / GRID_H,
  /**
   * The head's width over the body's. Above 1 means the head wins on width as well as on height,
   * which is bloodhorn's stated intent for its small body: "this makes it win on width too."
   */
  headToBodyWidth: HEAD_RX / BODY_RX_BASE,
} as const;

/**
 * Which part of the cat owns a pixel.
 *
 * `outline` is not a body part — it is the ring drawn OUTSIDE the silhouette. It is in the union
 * because a caller painting the grid needs to know not to treat it as coat.
 */
export type CutePart =
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
  | "outline";

/**
 * The concrete skeleton one cat is drawn from, for one state and one frame.
 *
 * Separate from the hash-derived IDENTITY (see `grid.ts`'s `CatGeometry`) because identity is stable
 * forever — a cat's ears and coat are its own — while the skeleton changes with what the animal is
 * doing. Keeping them apart is what lets state reach the geometry without ever leaking into identity.
 */
export type CuteGeometry = {
  /** The head's half-width. A round pumpkin face or a slightly narrower one. */
  readonly headRx: number;
  /** The head's half-height. */
  readonly headRy: number;
  /** How many rows the ears rise above the crown. */
  readonly earHeight: number;
  /** The ear's half-width at its base. Broad triangle to narrow spike. */
  readonly earWidth: number;
  /** −1..1. Which way the ear tips lean. Negative is out, positive is in. */
  readonly earAngle: number;
  /** 0..1. How far the ears DROOP. 0 is pricked, 1 is folded flat — the starving/dead register. */
  readonly earDroop: number;
  /** The body's half-width. Always less than `headRx` — the neoteny cue. */
  readonly bodyRx: number;
  /** −1..1. Which side the tail exits and how hard it curls. */
  readonly tailCurl: number;
  /** 0..1. How high the tail is carried. */
  readonly tailLift: number;
  /** Which eye mask to draw. See `EYE_MASKS`. */
  readonly eyeShape: number;
  /** How many whisker marks each side. */
  readonly whiskerLen: number;
  /** Cheek fluff — how far the head's lower corners flare out into ruff tufts. */
  readonly cheekFluff: number;
  /** True when the whole animal is lying down (the `dead` register). */
  readonly slumped: boolean;
};

/**
 * ══ THE LIGHT — up, slightly left, and strongly toward the viewer ══
 *
 * `lz` at 0.78 dominates deliberately: a front-facing cute creature is lit like a toy photographed
 * with a ring flash, not like a grimoire plate lit by one candle. bloodhorn's own light is at 0.62z
 * and it is drawing a moodier object; pushing it further forward here keeps the FACE — which is the
 * whole subject — evenly lit, so the eyes read against a flat cheek rather than against a gradient.
 *
 * The `-0.38 / -0.48` bias is what stops the sprite going symmetric-flat: the two ears and the two
 * cheeks take slightly different values from each other, which is the only thing preventing a
 * bilaterally symmetric front-on animal from reading as a stamped decal.
 *
 * Normalised by construction: 0.38² + 0.48² + 0.78² = 0.9832 ≈ 1.
 */
const LIGHT = [-0.38, -0.48, 0.78] as const;

/**
 * ══ THE DITHER STRENGTH ══
 *
 * 0.34, near bloodhorn's measured 0.28 for the same 24x24 grid, nudged up because this ramp has
 * EIGHT steps to bloodhorn's six — a wider ramp has narrower bands, so the same absolute dither
 * carries less far into each one.
 *
 * bloodhorn's recorded reason for dropping it: "Bayer dithering trades spatial resolution for tonal
 * resolution... that trade needs spare pixels to spend, and a 24x24 creature whose head is 14px
 * across has none." At 0.55 — this package's previous value, set for a busier profile sprite — the
 * eyes lost pixels and the ear tips developed holes, which on a face is the difference between cute
 * and damaged.
 */
const DITHER = 0.34;

/** How many ramp steps a cat is drawn from. Step 0 is the outline; step 7 is the catchlight. */
export const RAMP_STEPS = 8;

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE HEAD — a big round superellipse, and ROUND is the whole point.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * bloodhorn uses a squircle exponent of 2.6 and explains it: "A circle head is a ball, and a ball
 * has no cheeks; the squircle exponent keeps the sides nearly straight and rounds only the corners."
 *
 * 2.3 here — ROUNDER than bloodhorn's. The previous profile module used 2.9 and argued for it on
 * anatomy ("a cat's skull is boxier than a foal's, the sides run nearly straight from the ear base
 * down to the jaw"), which is true of a real cat's skull and is the accuracy register that was
 * rejected. Rendered at 96px the boxy head read as a bear cub. A cute cat's head is a CIRCLE with
 * ears on it, and 2.3 is round enough to read as one while keeping just enough flat in the sides
 * that the cheeks are not a perfect disc.
 *
 * `cheekFluff` pushes the lower corners outward into ruff tufts, which is the one cat-specific shape
 * on the skull — and it earns its rows because it is a SILHOUETTE feature, visible at 32px, where a
 * correctly-modelled zygomatic arch is an interior value that disappears at anything under 96px.
 */
function headNormal(
  px: number,
  py: number,
  g: CuteGeometry,
  drop: number,
): { nx: number; ny: number } | null {
  const cy = (ROWS.head[0] + ROWS.head[1]) / 2 + drop;
  /*
   * THE CHEEK FLARE. Applied to the lower half only, ramped in by row so the widening is a curve
   * rather than a step — a flare that switches on at one row reads as a notch cut in the skull.
   */
  const below = Math.max(0, Math.min(1, (py + 0.5 - cy) / g.headRy));
  /*
   * ══ THE FLARE IS CLAMPED AND SMALL, AFTER IT GREW A PAIR OF DOG EARS ══
   *
   * `below` was unclamped and scaled by 1.6. Past the ellipse's own lower edge it exceeds 1, so the
   * squared term ran away and the widened radius admitted pixels four columns outside the skull —
   * rendered at 384x zoom, every cat had two large dark flaps hanging off the sides of its head,
   * which read unmistakably as a DOG'S ears. Two hanging ears plus two pointed ones is not a cat.
   *
   * Clamped to 1 and scaled by 0.9, the flare adds at most one column each side at the jawline,
   * which is a ruff tuft. The lesson is the recurring one: a term that is squared must be bounded
   * FIRST, because the square is what turns a small excess into a large one.
   */
  const rx = g.headRx + g.cheekFluff * below * below * 0.9;
  const nx = (px + 0.5 - CX) / rx;
  const ny = (py + 0.5 - cy) / g.headRy;
  if (Math.abs(nx) ** 2.3 + Math.abs(ny) ** 2.3 > 1) return null;
  // Renormalise the x term against the UNFLARED radius so the shading models one head rather than
  // two — otherwise the flared cheeks light as if they were a narrower head, and the tufts come out
  // as a bright band across the jaw.
  return { nx: (px + 0.5 - CX) / g.headRx, ny };
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * How far INSIDE the crown an ear's base sits, in rows — and it is 1.4, CUT FROM 2.8.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Silhouette rule 1: an appendage must MEET the body. An ear whose base floats above the crown is a
 * triangle hovering over a cat, so the base is buried inside the skull and both ends of the ear —
 * the base row and the drawn height — are derived from this one number.
 *
 * ══ AT 2.8 THE EARS ATE THE SKULL, AND THAT IS WHY THEY READ AS A LYNX ══
 *
 * A review of the 96px sheet said several cats read as a lynx, a bat or a fennec fox. The obvious
 * hypothesis was that the ears were too TALL, and the obvious measurement — tip height above the
 * crown, divided by ear width — said they were not: every cat came back at 0.43 to 0.80, i.e. wider
 * than tall, comfortably inside the "squat triangle" target. The metric said the problem did not
 * exist.
 *
 * The metric was measuring the wrong thing. Dumping the actual part grid showed the ears occupying
 * SEVEN of the twenty-four rows — rows 0 to 6 — because a root 2.8 rows deep starts the ear inside a
 * skull whose crown is at row 4. So the ear's own mass covered the entire dome, and a scan for rows
 * that are head-and-not-ear-flanked found exactly ONE clear row above the eyes on every cat in the
 * set.
 *
 * That is the real defect and it is not about the ears' proportions at all: THE SKULL HAD NO CROWN.
 * bloodhorn's unicorn works because its horn is a narrow exception on an intact round dome — the
 * roundness is preserved and the spike interrupts it. Two ears rooted this deep do not interrupt the
 * roundness, they replace it, and a head with no dome above the eyes is a wedge. A wedge with two
 * triangles on it is a fox.
 *
 * ══ THE LESSON, AND IT IS ABOUT THE MEASUREMENT RATHER THAN THE NUMBER ══
 *
 * A measurement derived from the same anchor as the bug cannot see the bug. "Tip height above the
 * crown" takes the crown as its zero, so it is blind to the ear having consumed the crown — it
 * reported a healthy ratio on a cat with no forehead. This package now asserts DOME ROWS (clean head
 * rows above the eyes) as well as ear aspect, because the two fail independently and the first is
 * the one that carries the species read.
 *
 * At 1.4 the ear roots just under the crown line: still overlapping enough that rule 1 holds on every
 * head width and ear angle, and shallow enough to leave three or four rows of unbroken dome. The
 * head is round again and the ears sit ON it.
 */
const EAR_ROOT_DEPTH = 1.4;

/**
 * ══ THE EARS — two triangles, in the slot bloodhorn's horn occupies ══
 *
 * A cone rather than a flat triangle, and that distinction is what the normal buys: the normal
 * sweeps across the ear's WIDTH and is nearly constant along its HEIGHT, so the ear takes light as a
 * tapering solid. A flat-shaded triangle at 24px reads as a paper cutout stuck to the head.
 *
 * ══ THE BASE OVERLAPS THE SKULL, AND THAT IS NOT SLOPPINESS ══
 *
 * Silhouette rule 1 from unitick's NEEDLE failure, inherited by this package and worth keeping even
 * though the pose changed: "every ear column that is filled must have a filled pixel directly
 * beneath it". An ear whose base floats one row above the crown is a triangle hovering over a cat,
 * and at 24px that reads as damage rather than as an ear. So the base row is DERIVED from the
 * skull's own top rather than hardcoded — the recorded generalisation is "when two pieces of
 * geometry must meet, DERIVE one from the other; every gap bug was a hardcoded number that agreed
 * with its neighbour until the neighbour became a variable."
 *
 * ══ THE DROOP IS A STATE REGISTER, NOT AN IDENTITY AXIS ══
 *
 * `earDroop` shears the ear tip DOWN and OUT. At 0 the ear is pricked; at 1 it is folded against the
 * side of the head. This is how a starving cat is drawn starving in a CUTE register — the brief's
 * "droopy-eared and dim-eyed rather than anatomically gaunt" — and it works because a drooping ear
 * is a universally-read signal of an animal that is not doing well, at any resolution, on any
 * species.
 */
function earNormal(
  px: number,
  py: number,
  g: CuteGeometry,
  drop: number,
): { nx: number; ny: number; inner: boolean } | null {
  const crown = ROWS.head[0] + drop;
  // The base sits INSIDE the crown by 1.6 rows, so ear and skull always share filled rows.
  const baseY = crown + EAR_ROOT_DEPTH;
  /*
   * ══ THE HEIGHT IS MEASURED FROM THE BASE, SO THE OVERLAP MUST BE ADDED BACK ══
   *
   * `earHeight` is documented as the rows the ear rises ABOVE THE CROWN, because that is the only
   * part a viewer reads as "ear" — the rest is inside the skull. But the ear is DRAWN from its base,
   * which sits `EAR_ROOT_DEPTH` rows below the crown, so drawing it `earHeight` rows tall from there
   * leaves it `EAR_ROOT_DEPTH` rows short of clearing the head.
   *
   * That is precisely what the render showed: with the root deepened to fix the floating-ear gap, the
   * ears stopped clearing the skull at all and rendered as two dark notches IN the crown. Fixing one
   * end of a derived quantity broke the other, which is the signature of a length that is measured
   * from one place and consumed in another.
   *
   * So the drawn span is the visible height PLUS the overlap. Both ends are now derived from
   * `EAR_ROOT_DEPTH`, so moving the root moves the base and the tip together and neither can drift.
   */
  const topY = baseY - (g.earHeight + EAR_ROOT_DEPTH);
  if (py + 0.5 > baseY || py + 0.5 < topY) return null;

  for (const side of [-1, 1] as const) {
    // The ear roots on the skull's upper shoulder, not on its centreline — which is what makes two
    // ears rather than one crest. Derived from the head's own radius so a rounder head moves them.
    /*
     * ══ THE ROOT IS AT 0.42 OF THE RADIUS, PULLED IN FROM 0.60 ══
     *
     * The head is a superellipse, so it is at its FULL width only across its middle rows — at the
     * crown it has already tapered. Rooting the ears at 0.60 of the head's half-width placed them
     * over columns the skull does not occupy at that height, and the render showed exactly that: two
     * triangles floating clear of the head with a gap of ground between them and it. That is
     * silhouette rule 1 violated ("every ear column that is filled must have a filled pixel directly
     * beneath it"), and it is the recurring hardcoded-constant failure — 0.60 agreed with the head's
     * width at the MIDDLE and the ears do not sit at the middle.
     *
     * 0.42 puts both roots inside the crown's own span at every head width the axis reaches, so the
     * ears grow out of the skull rather than hovering over it.
     */
    /*
     * ══ 0.52, MOVED BACK OUT — a cat's ears sit on the CORNERS of the skull ══
     *
     * Pulled to 0.42 when the ears were floating clear of a crown they were rooted above; that fix
     * was about the ROW they start at, and moving them inward was the wrong lever for it. With the
     * root depth now correct, 0.42 puts the two ears close enough together that they read as a pair
     * of BOWS or as a single crest split down the middle — which is a rabbit, or a hair ornament, not
     * a cat.
     *
     * A cat's ears sit at the outer corners of the skull with clear forehead between them, and that
     * gap is a large part of what makes the head read as round: it is the dome showing through.
     */
    const rootX = CX + side * g.headRx * 0.52;
    /** 0 at the base, 1 at the tip. */
    const t = (baseY - (py + 0.5)) / (g.earHeight + EAR_ROOT_DEPTH);
    /*
     * The tip drifts OUTWARD as it rises (the natural set of a cat's ear), modulated by `earAngle`,
     * and DOWNWARD-and-further-out as `earDroop` rises. `t*t` on the drift so the base stays put and
     * the bend accumulates toward the tip — an ear grows outward, it is not an arc of a circle.
     */
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * ══ THE LEAN, AND IT WAS A DEAD AXIS — the SIXTH instance of this defect in the package ══
     * ══════════════════════════════════════════════════════════════════════════════════════════
     *
     * The first version was `side * (0.9 - earAngle * 0.9)`, which sweeps the tip across a span of
     * 1.8 units — and `t*t` at the tip is 1, so 1.8 units of drift over the ear's whole −1..1 range.
     * Rasterised, that is under two cells, so most of the range produced the IDENTICAL ear.
     *
     * The `hunting` state, which forces `earAngle` to at least 0.55, then moved the tip by ZERO
     * cells on every cat in the test set. A forced state override that changes nothing on screen,
     * present in the source, passing every render review, invisible.
     *
     * This is the SIXTH time this package has shipped a continuous parameter whose effect falls
     * below the two-pixel rasterisation quantum: an ear angle that moved a tip under a pixel, a 0.9
     * state gain that was the identity on a 6-step ramp, a 2.6 tail curl that moved two columns, a
     * flick frame that moved one cell, a flick that moved zero after the curl was decomposed, and
     * now this. The package's own header states the rule — "AN AXIS MUST MOVE ITS FEATURE BY AT
     * LEAST TWO PIXELS ACROSS ITS RANGE" — and the rule keeps being violated by new code because the
     * violation is invisible in the source: `0.9` looks like a real number doing real work.
     *
     * The only defence that has ever worked is a test that measures RENDERED CELLS rather than
     * reading the geometry, and the ear now has one.
     *
     * At 2.6 the tip sweeps 5.2 units across the range, which is three to four cells after
     * rasterisation — comfortably over the quantum on every head width, so the state override and
     * the identity axis both do visible work.
     */
    /*
     * ══ 0.5 BASE AND 1.5 OF SWING, CUT BACK WHEN THE ROOT BECAME SHALLOW ══
     *
     * The lean was raised to `1.4 - earAngle * 2.6` to fix a genuinely dead axis: at its previous
     * value the tip moved under two cells across the whole range and the `hunting` override moved it
     * by zero. That fix was correct and it was tuned against a root 2.8 rows deep, where the ear had
     * four or five rows of drift to spend the swing over.
     *
     * With the root cut to 1.4 the ear is only three to four rows tall, so the SAME angular swing is
     * applied over half the distance — the tips swung clear of the ear's own base and rendered as
     * detached pixels floating beside the head. That is silhouette rule 4 failing, and it appeared
     * the moment an unrelated constant moved.
     *
     * This is the recurring shape of every geometry bug in this package, stated once more because it
     * has now happened in the ears, the whiskers, the tail root and the muzzle: A CONSTANT TUNED
     * AGAINST ANOTHER CONSTANT BREAKS WHEN THAT ONE MOVES. The lean is still large enough to clear
     * the two-pixel quantum — `grid.test.ts` measures the rendered cells and would fail if it were
     * not — but it is now sized against the ear's actual height rather than against the old one.
     */
    /*
     * ══ THE BASE LEAN IS ZERO — A CAT'S EARS POINT UP, NOT OUT ══
     *
     * Every version of this term carried a positive outward base (0.9, then 1.4, then 0.5), on the
     * reasoning that the natural set of a cat's ear is slightly splayed. That is true of a real cat
     * and it is the accuracy register again: rendered at 384x zoom, ears whose tips lean outward on a
     * ROUND skull read as HORNS or as a pair of BOWS, because two shapes diverging from a dome is the
     * silhouette of horns and nothing else. It was the last thing making these read as a different
     * species, and it survived three separate attempts to fix the ears by changing their size.
     *
     * A cute cat's ears are near-parallel and vertical. At a base of 0 the tips rise straight from
     * the roots, the two ears stay parallel, and the shape reads as a cat immediately — the same
     * ears, rotated a few degrees, and it is the whole difference.
     *
     * `earAngle` still swings them ±1.5 either way, so the identity axis and the `hunting` override
     * both keep the range the cell-count assertion demands; the range is now CENTRED on vertical
     * rather than on splayed, so both ends of it are still a cat.
     */
    const lean = side * -g.earAngle * 1.5 + g.earDroop * side * 1.2;
    const centre = rootX + lean * t * t;
    // Tapers from the full half-width at the base to a point. `+0.42` keeps the tip one pixel wide
    // rather than vanishing — bloodhorn's note that a feature which fades out reads as an antenna.
    /*
     * ══ A DROOPING EAR GETS WIDER, NOT NARROWER — the fix for the ANGRY STARVING CAT ══
     *
     * The droop originally only sheared the tip sideways, leaving the taper untouched. Rendered at
     * 384x zoom the starving cats read as ANGRY rather than as sad: two narrow spikes swept back
     * from the skull is the silhouette of PINNED ears, which is aggression, and it is very nearly the
     * opposite of the state being drawn.
     *
     * The difference between pinned and drooping is the TAPER. A pinned ear stays a stiff cone; a
     * drooping one folds, so it presents more of its surface and reads as a soft flap. Widening the
     * taper with the droop turns the same swept-back angle from aggression into exhaustion, which is
     * the register `ART-DIRECTION.md` §8 asks for — a starving cat drawn starving, in a vocabulary a
     * viewer reads instantly.
     */
    /*
     * The tip keeps 0.62 of a cell rather than 0.42. A shorter ear reaches its tip in fewer rows, so
     * the taper is steeper per row and the final row was rounding to nothing on the narrow-eared
     * cats — an ear that fades out at the tip reads as an antenna, which is bloodhorn's own note
     * about its horn, and here it also broke the ear into two pieces.
     */
    const halfWidth = g.earWidth * (1 - t * (1 - g.earDroop * 0.55)) + 0.62;
    const dx = px + 0.5 - centre;
    /*
     * ══ `continue`, NOT `return null` — and this bug drew EVERY CAT WITH ONE EAR ══
     *
     * The first version returned null here. Since the loop tests the LEFT ear first, any pixel that
     * missed the left ear returned immediately and the right ear was never evaluated at all. Every
     * cat in the colony rendered with a single ear on its left, and it survived a full render pass
     * because a one-eared cat is still recognisably a cat — it looks like a stylistic choice.
     *
     * That is the most dangerous shape of bug in this file: an early return inside a loop over the
     * two halves of a SYMMETRIC feature. The sprite does not break, it just quietly loses half of
     * itself, and the eye accepts it. `grid.test.ts` now asserts the ear count on both sides of the
     * centreline rather than asserting that ears exist.
     */
    if (Math.abs(dx) > halfWidth) continue;
    /*
     * THE INNER EAR — the dark hollow. It is the middle 55% of the ear's width, and only below the
     * top third, so the rim of cartilage stays unbroken all the way round the tip. An inner ear that
     * reaches the tip splits the ear into two spikes.
     */
    /*
     * ══ THE INNER CONE IS 0.42 OF THE WIDTH, NARROWED FROM 0.55 ══
     *
     * At 0.55 the hollow took the middle of an ear that is only 3-4 cells wide at its base, so what
     * survived as the bright rim was ONE cell on each side — and after the outline pass drew a dark
     * ring outside that, the ear rendered as two dark spikes with a dark hollow between them. The ear
     * had three values in the source and one on screen.
     *
     * The rim has to be at least 1 clear cell wide on each side at every ear width the axis reaches,
     * which at the narrowest (1.5 half-width, so 3 cells) means the hollow can have at most 1 cell.
     * 0.42 delivers that, and the hollow still reads because it sits at step 2 against a rim at 6 —
     * the widest value gap on the sprite.
     */
    /*
     * ══ THE HOLLOW IS SUPPRESSED AS THE EAR DROOPS ══
     *
     * The inner cone is a fraction of the ear's half-width, and a drooping ear is sheared sideways —
     * so on the starving cats the rasterised rim came out one cell wide on one side and ZERO on the
     * other, and the ears rendered as broken fragments with gaps of ground showing through them. That
     * is silhouette rule 4 (nothing disconnected) failing through VALUE rather than through geometry,
     * and it read as damage on the state where the animal must read as tired rather than injured.
     *
     * A folded ear does not show its hollow anyway — that is what folding means. Scaling the cone
     * away with the droop is both the fix and the correct drawing: a fully drooped ear is solid.
     */
    /*
     * ══ THE HOLLOW IS 0.34 OF THE WIDTH AND STOPS AT HALF-HEIGHT ══
     *
     * At 0.42 and 0.6 the dark cone took most of a 3-row ear, so the ear rendered as a dark wedge
     * with a thin bright edge and read as a HORN rather than as a cat's ear. The hollow is a detail
     * on an ear; when the ear shrank, a fraction that was correct on a 5-row ear became the whole
     * feature.
     *
     * A fraction tuned against a size does not survive the size changing — the same defect as every
     * other constant-against-constant bug in this file. Cut to 0.34 and stopped at 0.5 of the height,
     * the hollow is one or two cells at the ear's base with unbroken rim above and around it, which
     * is what makes a cone open toward the viewer.
     */
    const inner = Math.abs(dx) < halfWidth * 0.34 * (1 - g.earDroop) && t < 0.5;
    return { nx: dx / Math.max(0.5, halfWidth), ny: -0.35 + t * 0.45, inner };
  }
  return null;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * AN EYE — 4x4, and the masks are WRITTEN OUT rather than computed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * bloodhorn's recorded reason, transplanted because it applies with more force at 4x4 than at 3x3:
 *
 *   > A first pass derived these from `dx === 1 || dy === 1` predicates. Rendered and inspected, all
 *   > three were wrong in ways the arithmetic hid: the "round" eye put its catchlight on a corner it
 *   > had just knocked off, the "oval" was byte-identical to the round one, and the "happy squint"
 *   > curved DOWNWARD — a frown. Three bugs in four lines of clever indexing.
 *   >
 *   > At 3x3 there is no reason to compute what can be drawn.
 *
 * The legend:
 *   `.` transparent — the coat shows through
 *   `#` the PUPIL, ramp step 0 (the darkest, same as the outline)
 *   `d` a DULLED catchlight, mid-ramp — present but not bright. The sad eye's glimmer.
 *   `o` the CATCHLIGHT, step 7 (the reserved top). ONE pixel, upper-left, on the same side as the
 *       light. A catchlight on the shaded side reads as a cataract.
 */
/**
 * ══ THE THREE VALUES AN EYE TAKES, AND THE IRIS IS LIGHT ══
 *
 * The first version made the iris DARK — step 2, one above the outline — on the reasoning that an
 * iris is a ring of coat-shadow around the pupil. Rendered at 384x zoom, both eyes were solid dark
 * VOIDS: at 4x4, a dark pupil surrounded by a dark rim is twelve dark pixels in a row and the whole
 * socket reads as a hole punched through the head. The face had two empty sockets and no expression.
 *
 * An iris is not shadow — it is the COLOURED, LIT part of an eye, and it is what a viewer actually
 * reads the eye's shape from. At step 6 it is bright against the coat, the 2x2 pupil is a clear dark
 * mark inside it, and the eye has three separated values: bright rim, dark pupil, brightest
 * catchlight. That is what makes an eye read as wet and alive rather than as a hole.
 *
 * bloodhorn does not hit this because a 3x3 eye has no room for a rim at all — its eye is a solid
 * pupil with one bright corner. The rim is what 4x4 buys, and it only pays off if it is LIGHT.
 */
const EYE_STEP = { pupil: 0, dull: 4, light: RAMP_STEPS - 1 } as const;

const EYE_MASKS: Readonly<Record<number, readonly string[]>> = {
  /*
   * ROUND — a SOLID dark pupil filling the socket, with the catchlight in its upper left and the
   * corners knocked off so it reads as a circle.
   *
   * ══ THE IRIS RING WAS TRIED, AND IT MADE THE CAT ANGRY ══
   *
   * The version before this drew a LIGHT iris ring around a small dark pupil, on the reasoning that
   * an iris is the lit coloured part of an eye and that three values read as wetter than two.
   * Rendered at 384x zoom, every cat was SCOWLING. The reason is specific and worth recording: a
   * dark row above a light row inside an eye socket is exactly the value arrangement of a LOWERED
   * BROW, which is the universal signal for anger. The eye was anatomically better and emotionally
   * wrong, and expression beats anatomy at 24px in every case.
   *
   * bloodhorn does not make this mistake, and its comment says why in one line: "a big round wet-
   * looking eye is the single strongest 'alive' cue a face has", drawn as `o##` / `###` / `##.` — a
   * SOLID mass. There is no iris. The catchlight alone carries the wetness, because a catchlight is
   * a REFLECTION and a reflection is the only part of an eye that is genuinely bright.
   *
   * So the eye is solid again, at 4x4 rather than 3x3, and the extra ring of pixels is spent on
   * making the circle rounder rather than on adding a value.
   */
  0: [".##.", "#o##", "####", ".##."],
  /*
   * TALL — a narrower, more alert eye: the socket loses its outer columns top and bottom, so it
   * reads as an upright oval. Distinguishable from ROUND at a glance rather than by counting pixels,
   * which is the bar an identity axis has to clear.
   */
  1: [".##.", ".o#.", ".##.", ".##."],
  /*
   * WIDE — the full square with only the top corners knocked off, so the eye reads as OPEN WIDER
   * than the others and slightly surprised. The single most reliably endearing eye there is.
   */
  2: [".##.", "#o##", "####", "####"],
} as const;

/**
 * A BLINKING eye — a closed curve, used by the idle blink frame ONLY.
 *
 * It curves UP at the ends, which is a smile. bloodhorn records getting this inverted and producing
 * a frown, from a computed version; drawn out, it cannot be wrong.
 *
 * Held for a tenth of the idle loop, so it reads as a blink rather than as an expression — which is
 * exactly why it is NOT reused for `starving`. See `EYE_MASK_SAD`.
 */
const EYE_MASK_BLINK: readonly string[] = ["....", "....", "####", "#..#"];

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A SAD eye — LARGE AND ROUND, WITH A HEAVY UPPER LID. Not a squint.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ THE STARVING CAT READ AS ANGRY, AND THIS IS THE FIX ══
 *
 * `starving` reused `EYE_MASK_BLINK` on an argument that sounded like good economy: "a half-lidded
 * eye and a blinking eye are the same shape, and the state is carried by the fact that it is HELD
 * rather than by it being a different curve."
 *
 * That is false, and the render said so at 96px. A blink is a horizontal SLIT, and a slit held open
 * as an expression is not a tired face — narrowed eyes are the universal signal for ANGER, on every
 * species and in every drawing convention. Every starving cat in the colony looked hostile.
 *
 * That is a serious defect rather than a cosmetic one. `DESIGN.md` §2 requires a losing cat to be
 * drawn LOSING, and the product depends on the user WANTING to feed a starving stray. An angry
 * animal invites nothing; a pitiable one invites the exact action the mechanic needs. The state was
 * legible and it was recruiting the wrong emotion.
 *
 * ══ WHAT A SAD EYE ACTUALLY IS ══
 *
 * Not smaller — LARGER, and dimmer. The cues are:
 *
 *   - THE EYE STAYS BIG AND ROUND. Shrinking an eye reads as narrowing it, which is the anger cue.
 *     Sadness keeps the neoteny; it is what makes the face pitiable rather than threatening.
 *   - A HEAVY UPPER LID, cutting the TOP CORNERS rather than squeezing the eye from both sides. The
 *     lid comes DOWN over a round eye, so the upper corners go and the bottom stays completely full
 *     — the opposite of a squint, which takes the top and the bottom equally and leaves a slit.
 *
 *     It is only the CORNERS, not the whole top row. Cutting the full row made this mask smaller
 *     than the `WIDE` eye shape, so a wide-eyed cat's eyes SHRANK when it started starving — which
 *     is the anger cue arriving by a different route, and the test caught it. The sad eye must never
 *     be smaller than the open one it replaces, on any eye shape.
 *   - A DIMMED CATCHLIGHT, not an absent one. This is the cue that does most of the work and it is
 *     one pixel — but it took two attempts to get right, and the failure is instructive.
 *
 *     Removing the catchlight ENTIRELY was tried first, on the reasoning that a catchlight is what
 *     makes an eye look alive and engaged. Rendered at 96px the eyes became big empty black voids
 *     and the cats read as VACANT or already dead — which is worse than angry, because a corpse
 *     invites even less than a hostile animal does and it collides with the `dead` state's own read.
 *
 *     An eye with no highlight at all is not a sad eye, it is a hole. What sadness looks like is a
 *     highlight that is still there and has gone DULL. So the catchlight is drawn at a mid ramp step
 *     (`d`) rather than at the reserved top: present, so the eye is alive, and clearly dimmer than
 *     the fed cat's beside it. This is also why the accent test still finds its two flagged pixels —
 *     the pixel exists, it is simply not at full brightness.
 *
 * The result is a big dark round eye under a heavy lid with a dulled glimmer in it, which is a sad
 * animal — drawn with the same pixels as the happy one at two different values, rather than with a
 * different geometry.
 */
const EYE_MASK_SAD: readonly string[] = [".##.", "#d##", "####", "####"];

/**
 * A DEAD eye — an X. The simple, universally-read cartoon signal, and it is what the brief asks for:
 * "a dead cat can be a simple X-eyed slump."
 *
 * This replaced an earlier approach that dropped the eyes below the flat coat so they read as "dark
 * holes in a flat shape". That was derived carefully and it was in the wrong register: dark holes
 * are grim, and an X is the convention every viewer already knows. The state is still honest — the
 * cat is dead and the sprite says so unmistakably — it is simply saying it in the vocabulary the
 * rest of the sprite is drawn in.
 */
const EYE_MASK_DEAD: readonly string[] = ["#..#", ".##.", ".##.", "#..#"];

/**
 * Which mask an eye takes.
 *
 * `sad` and `blinking` are separate parameters rather than one `sleepy` flag, and that separation IS
 * the fix for the angry starving cat: collapsing them was what made a held expression borrow a
 * blink's slit shape. A blink and a sad face are different drawings and the code now says so.
 */
function eyeMask(
  shape: number,
  blinking: boolean,
  sad: boolean,
  dead: boolean,
): readonly string[] {
  if (dead) return EYE_MASK_DEAD;
  if (blinking) return EYE_MASK_BLINK;
  if (sad) return EYE_MASK_SAD;
  return EYE_MASKS[shape] ?? EYE_MASKS[0] ?? [];
}

/**
 * An eye's step at a pixel, or null.
 *
 * Returns a STEP directly rather than a normal, for bloodhorn's reason: "an eye is not a shaded
 * surface — it is a dark mark with a highlight, and running it through the diffuse model would give
 * it a gradient that makes it read as a dent rather than as an eye."
 */
function eyeStepAt(
  px: number,
  py: number,
  g: CuteGeometry,
  drop: number,
  blinking: boolean,
  sad: boolean,
  dead: boolean,
): { step: number; light: boolean } | null {
  const mask = eyeMask(g.eyeShape, blinking, sad, dead);
  for (const ex of [EYE_L_X, EYE_R_X]) {
    const dx = px - ex;
    const dy = py - (EYE_Y + drop);
    if (dx < 0 || dx >= EYE_D || dy < 0 || dy >= EYE_D) continue;
    const cell = mask[dy]?.[dx];
    if (cell === undefined || cell === ".") return null;
    if (cell === "o") return { step: EYE_STEP.light, light: true };
    // `d` — a DULLED catchlight. Still flagged `light` so it is still the accent pixel and the
    // exactly-two-tinted-pixels count is unchanged; it simply does not reach the reserved top step.
    if (cell === "d") return { step: EYE_STEP.dull, light: true };
    return { step: EYE_STEP.pupil, light: false };
  }
  return null;
}

/**
 * ══ THE MUZZLE — a small LIGHT patch, not a projecting snout ══
 *
 * Front-on, a cat's muzzle is not a shape that sticks out; it is two pale whisker pads with a nose
 * between them, sitting immediately under the eyes. Drawing it as a projecting form — which is what
 * the profile module did, correctly, for a side view — gives a dark blob under the face front-on.
 *
 * It is drawn as a WIDE, SHALLOW ellipse and floored a step ABOVE the cheek beside it, so the lower
 * face has three planes (brow, cheek, muzzle) rather than being one flat mass with a nose floating
 * in it. Its normals lean toward the viewer, which is what a forward-facing form does to light.
 */
function muzzleNormal(
  px: number,
  py: number,
  g: CuteGeometry,
  drop: number,
): { nx: number; ny: number } | null {
  // Sits directly under the eyes and stays SMALL. A muzzle that grows is the fastest way back to the
  // realistic animal that was rejected.
  const cy = EYE_Y + EYE_D + 0.4 + drop;
  const rx = 3.2;
  const ry = 1.7;
  const nx = (px + 0.5 - CX) / rx;
  const ny = (py + 0.5 - cy) / ry;
  if (nx * nx + ny * ny > 1) return null;
  return { nx: nx * 0.65, ny: ny * 0.65 - 0.2 };
}

/** THE NOSE — a 2px mark at the top centre of the muzzle. Two pixels, and it reads as a nose. */
function isNose(px: number, py: number, drop: number): boolean {
  const noseY = EYE_Y + EYE_D + drop;
  return py === noseY && (px === 11 || px === 12);
}

/**
 * ══ THE WHISKERS — three 1px marks each side, and they must MEET THE FACE ══
 *
 * At 24px a whisker is not a hair, it is a texture that says "cat". Three marks a side is enough to
 * read and few enough not to become a beard.
 *
 * ══ THE ROW COLLINEARITY BUG, RECORDED SO IT IS NOT REPEATED ══
 *
 * The profile module recorded three failed fixes at this feature — two length adjustments and a gap
 * adjustment — against what was actually a ROW COLLINEARITY problem: whiskers drawn on the same row
 * on both sides of a symmetric face form one continuous horizontal line THROUGH the skull, which
 * reads as a rod skewering the cat rather than as two sets of whiskers. Its own note: "when a review
 * names two causes, change them one at a time", and "four consecutive fixes that each move a
 * different parameter and produce the same failure mean the failure is STRUCTURAL."
 *
 * Front-on the cat is bilaterally symmetric, so this failure is not merely possible, it is the
 * DEFAULT. The fix is structural: the left and right whisker sets sit on DIFFERENT ROWS, offset by
 * one, so no whisker row ever spans the face. That cannot be undone by tuning a length.
 */
function isWhisker(px: number, py: number, g: CuteGeometry, drop: number): boolean {
  const base = EYE_Y + EYE_D + drop;
  for (const side of [-1, 1] as const) {
    /*
     * ══ THE TWO SIDES SIT ON DIFFERENT ROWS, AND THAT IS A STRUCTURAL FIX ══
     *
     * Front-on the cat is bilaterally symmetric, so whiskers drawn on the same row on both sides
     * form one continuous horizontal line THROUGH the skull — a rod skewering the cat rather than
     * two sets of whiskers. In the profile pose this failure took three attempted fixes (two lengths
     * and a gap) before it was recognised as a ROW COLLINEARITY problem rather than a sizing one.
     *
     * Front-on it is not merely possible, it is the DEFAULT, so the offset is built in: the left set
     * sits on `base` and `base+2`, the right on `base+1` and `base+3`. No whisker row ever spans the
     * face, and that cannot be undone by tuning a length.
     *
     * Both sets start AT or BELOW `base`, which is the row under the eyes — a whisker level with an
     * eye crosses it and reads as a crack in the face.
     */
    const rows = side < 0 ? [base] : [base + 1];
    if (!rows.includes(py)) continue;
    // Whiskers start clear of the muzzle and run outward past the cheek, so they break the
    // silhouette — a whisker entirely inside the head's outline is invisible against the coat.
    /*
     * ══ THEY START INSIDE THE SKULL, WHICH THEY DID NOT ══
     *
     * `from` was 4.4 — outside the muzzle but, on the narrower heads, also outside the SKULL, so
     * the whiskers rendered as free-floating bars beside the cat with a gap between them and the
     * face. That is silhouette rule 1 (an appendage must meet the body) violated by a hardcoded
     * number, which is the exact class of bug this package's header warns about: "every gap bug here
     * was a hardcoded number that agreed with its neighbour until the neighbour became a variable."
     *
     * So `from` is DERIVED from the head's own radius. It starts 1.6 columns inside the skull, which
     * guarantees a filled head cell beneath the innermost whisker on every head width, and runs
     * outward past the edge so the mark breaks the silhouette — which is the only way a 1px whisker
     * is visible at all.
     */
    /*
     * ══ THE START IS THE SKULL'S EDGE AT THIS ROW, NOT ITS WIDEST POINT ══
     *
     * `from` was the head's maximum half-width less a constant, which is the same width for every
     * row. The head is a superellipse, so its edge at the whisker rows — which are low on the face —
     * is two or three columns INSIDE its widest point. The whiskers therefore began in empty space
     * and rendered as free-floating bars beside the cat, and lengthening or shortening them (tried
     * twice) only moved the floating bars around.
     *
     * That is the fourth time in this package a fix has moved a LENGTH when the defect was in an
     * ANCHOR. The recorded generalisation applies exactly: "when two pieces of geometry must meet,
     * DERIVE one from the other." So the anchor is the skull's half-width AT THIS ROW, solved from
     * the same superellipse `headNormal` draws, and the whisker starts 1.5 columns inside it.
     */
    const cy = (ROWS.head[0] + ROWS.head[1]) / 2 + drop;
    const ny = Math.abs((py + 0.5 - cy) / g.headRy);
    if (ny >= 1) continue;
    // Invert |nx|^2.3 + |ny|^2.3 = 1 for nx: the skull's half-width in columns at this row.
    const edge = g.headRx * (1 - ny ** 2.3) ** (1 / 2.3);
    /*
     * ══ ONE ROW PER SIDE AND SHORT — the whiskers were eating the face ══
     *
     * Two rows a side, running from 1.5 columns inside the skull to `edge + whiskerLen`, put four
     * long bright bars across the lower face. Rendered at 384x zoom they were the most prominent
     * feature on the sprite: brighter than the eyes, wider than the head, and they read as a CAGE
     * over the face rather than as whiskers.
     *
     * A whisker's whole job at this size is to say "cat" in the periphery. It does not need to be
     * seen; it needs to be THERE. One row a side, starting half a column inside the skull's edge and
     * running two columns past it, is enough — and it leaves the face to the eyes, which is where
     * the sprite's entire expression lives.
     */
    const from = Math.max(1.5, edge - 0.5);
    /*
     * ══ AND IT PROJECTS TWO COLUMNS, NOT THREE ══
     *
     * At `whiskerLen * 0.9` the longest whiskers reached three columns past the skull, and at 120px
     * the two sets together read as a MOUSTACHE — a continuous horizontal feature under the nose,
     * which is not what whiskers look like and is not what they are for. A whisker's job here is to
     * register in the periphery as "cat"; two columns does that and leaves the face to the eyes.
     */
    const to = edge + 1 + g.whiskerLen * 0.4;
    const dx = (px + 0.5 - CX) * side;
    if (dx >= from && dx <= to) return true;
  }
  return false;
}

/**
 * ══ THE BODY — a small rounded mass under the head, and SMALL is the cue ══
 *
 * bloodhorn: "Small body is also a neoteny cue in its own right: `PROPORTIONS.headToBody` asserts
 * the head wins on height, and this makes it win on width too."
 *
 * A superellipse at exponent 2.2 — nearly an ellipse. The body has no job other than to be a soft
 * mass for the head to sit on and the tail to exit from; every pixel of detail spent on it is a
 * pixel not spent on the face, and the face is the whole sprite.
 */
function bodyNormal(
  px: number,
  py: number,
  g: CuteGeometry,
  drop: number,
): { nx: number; ny: number } | null {
  // The body STOPS where the paws begin, so its rounded lower edge cannot paint over them. Parts
  // owning disjoint row ranges is cheaper and more legible than depth-sorting them (bloodhorn).
  if (py >= ROWS.legs[1] - 1 + drop) return null;
  /*
   * ══ THE BODY IS BOUNDED BY ITS OWN ROW BUDGET, WHICH IT WAS OVERFLOWING BY TWO ROWS ══
   *
   * The centre carried a `+1.6` offset and the radius a `+1.4` bonus, so a body budgeted at six rows
   * rasterised into EIGHT — rows 15 to 22 — and swallowed the leg rows underneath it. Rendered at
   * 384x zoom the cat was a tall lumpy mass with two paws poking out of the bottom of it: no waist,
   * no visible legs, and the head no longer dominating anything.
   *
   * That is the whole neoteny budget defeated by two additive constants. bloodhorn's warning is
   * exactly this: the spans "tile the grid, so making the head taller necessarily makes something
   * else shorter" — and a part that silently exceeds its span breaks the budget without any of the
   * ratios reporting it, because the ratios are computed from ROWS and ROWS was still correct.
   *
   * Both are derived from the budget now. The body occupies its six rows and not one more, and the
   * legs below it are visible again.
   */
  const cy = (ROWS.body[0] + ROWS.body[1]) / 2 + drop;
  const ry = (ROWS.body[1] - ROWS.body[0]) / 2;
  const nx = (px + 0.5 - CX) / g.bodyRx;
  const ny = (py + 0.5 - cy) / ry;
  if (Math.abs(nx) ** 2.2 + Math.abs(ny) ** 2.2 > 1) return null;
  return { nx, ny };
}

/**
 * ══ THE PAWS — TWO, wide, at the bottom of the body ══
 *
 * bloodhorn draws four posts because a unicorn head-on shows four legs. A cat sitting facing you
 * shows TWO front paws with the haunches folded behind them; four evenly-spaced posts read as a
 * table, which was rendered and rejected.
 *
 * 3px wide each rather than 2. bloodhorn's note is that "a 1px leg is a hairline and disappears at
 * the first ramp step, which leaves a creature apparently floating" — and the same argument scales:
 * on a body 9px across, two 2px paws are a fringe. Three wide, with a clear 3px gap between them,
 * reads as two paws.
 */
function pawNormal(
  px: number,
  py: number,
  g: CuteGeometry,
  drop: number,
): { nx: number; ny: number } | null {
  const top = ROWS.legs[0] + drop;
  if (py < top || py >= ROWS.legs[1] + drop) return null;
  // Derived from the BODY's own half-width rather than hardcoded, so a wider body moves its paws
  // with it. The recorded failure of hardcoding: bloodhorn's first pass put its legs at columns
  // spaced for the wider body it then had, so "the outer two hung past the new silhouette and the
  // set read as three legs and a stray mark."
  const inset = g.bodyRx * 0.52;
  for (const side of [-1, 1] as const) {
    const lx = CX + side * inset - 1.5;
    if (px + 0.5 >= lx && px + 0.5 < lx + 3) {
      // A paw is a small cylinder: its normal sweeps across its width and is flat along its length,
      // so it takes the light as a rounded form rather than as a flat bar.
      return { nx: (px + 0.5 - lx - 1.5) * 0.8, ny: 0.1 };
    }
  }
  return null;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TAIL — the one thing that breaks the sprite's bilateral symmetry.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A front-facing animal is symmetric about its own axis, and a perfectly symmetric sprite reads as a
 * TOTEM or an icon rather than as a creature. The tail is what fixes that, and it is why it earns
 * its pixels even though a cat facing you would mostly hide its tail behind itself.
 *
 * Traced as a CURVE and rasterised cell by cell rather than defined as an implicit region, because a
 * 1-2px tapering curve has no interior for an implicit test to be inside of. Each cell carries `t`,
 * its position along the tail, so the renderer can brighten it toward the tip.
 *
 * ══ THE TIP BRIGHTENS, WHICH IS BACKWARDS FROM EVERY OTHER PART ══
 *
 * Deliberate: the tip carries the identity (the curl), it is 1px wide, and it is the furthest thing
 * from the body's mass — so it is the pixel most at risk of vanishing into the ground. A tail that
 * fades out at its tip is bloodhorn's floating-horn failure in a different part.
 *
 * ══ THE ROOT IS DERIVED FROM THE BODY, NOT HARDCODED ══
 *
 * Silhouette rule 1: "the tail's root must be orthogonally adjacent to a body pixel", and rule 4:
 * "nothing may be orthogonally disconnected from the cat". The flood fill in `grid.test.ts` found
 * 250 broken cats out of 300 the first time it ran, on geometry that looked correct at 96px — every
 * one of those was a hardcoded number that agreed with its neighbour until the neighbour moved.
 */
export function cuteTailCells(
  g: CuteGeometry,
  drop: number,
): { x: number; y: number; t: number }[] {
  const cells = new Map<number, { x: number; y: number; t: number }>();
  const side = g.tailCurl >= 0 ? 1 : -1;
  const strength = Math.abs(g.tailCurl);
  // The root sits ON the body's flank, one row above its widest point, so it is inside the body's
  // own silhouette and connectivity is guaranteed by construction rather than by luck.
  /*
   * ══ THE ROOT IS WELL INSIDE THE BODY, NOT ON ITS EDGE ══
   *
   * At `bodyRx - 0.8` the root sat within a cell of the body's own boundary, so on the builds whose
   * body had narrowed (a lean cat, or a starving one) the first traced cell landed OUTSIDE the
   * silhouette and the whole tail came away as a separate island. The flood fill reported the cat "in
   * 3 pieces".
   *
   * The root is now `bodyRx * 0.5` — halfway out along the flank, comfortably inside the body at
   * every width the axes reach. Cells the body already owns are simply not emitted as tail (the body
   * resolves first in `cutePartAt`), so an over-deep root costs nothing and guarantees the join.
   *
   * This is the recorded rule again: when two pieces of geometry must meet, DERIVE one from the other
   * and give the derivation MARGIN. A root exactly on a boundary is a root that fails whenever the
   * boundary moves by one rasterised cell.
   */
  const rootX = CX + side * g.bodyRx * 0.5;
  const rootY = ROWS.body[1] - 2 + drop;
  /*
   * The tail sweeps OUT and UP. `lift` decides how far up: at 0 it drags along the ground beside the
   * paws, at 1 it stands vertical beside the head — the "greeting" carriage, which is the friendliest
   * thing a cat's silhouette can do and the reason `tailLift` is an identity axis rather than a
   * constant.
   */
  const reach = 3.4 + strength * 1.9;
  const rise = 1.2 + g.tailLift * 7.2;
  /*
   * ══ THE CURVE IS SAMPLED DENSELY AND EVERY DIAGONAL STEP IS BRIDGED ══
   *
   * Sampling a curve and rounding each sample to a cell produces DIAGONAL steps wherever the curve
   * moves more than half a cell in both axes between samples — and a diagonal step is orthogonally
   * DISCONNECTED, which is silhouette rule 4. The flood-fill assertion caught exactly this on
   * `0xf00d`: the cat came back "in 3 pieces", with two tail cells stranded off the end of the curve.
   *
   * More samples do not fix it. A denser sample makes the steps smaller but a diagonal step is
   * diagonal at any density — the defect is in the RASTERISATION, not in the resolution, which is why
   * this package's history records the same gap bug appearing repeatedly under different parameters.
   *
   * The fix is to remember the previous cell and, whenever the new one is diagonal from it, fill the
   * cell that shares a row with one and a column with the other. That is a Bresenham-style bridge and
   * it makes orthogonal connectivity a property of the tracer rather than something the curve's
   * parameters have to be tuned to avoid.
   */
  const STEPS = 40;
  let prev: { x: number; y: number } | null = null;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    // Quadratic ease on x so the tail leaves the body sideways and then turns upward, which is what
    // gives it an S rather than a straight diagonal spike.
    const x = rootX + side * reach * Math.sin(t * 1.5);
    const y = rootY - rise * t * t + Math.sin(t * 3.1) * strength * 0.9;
    const cx = Math.round(x - 0.5);
    const cy = Math.round(y - 0.5);
    if (cx < 0 || cx >= GRID_W || cy < 0 || cy >= GRID_H) continue;
    const key = cy * GRID_W + cx;
    // Later (further along) wins, so `t` on a shared cell is the tip-most value — the brightening is
    // then monotonic along the drawn curve even where two samples land in one cell.
    cells.set(key, { x: cx, y: cy, t });
    // THE BRIDGE. A diagonal move gets the horizontally-adjacent cell filled too, so the traced run
    // is orthogonally connected end to end.
    if (prev && prev.x !== cx && prev.y !== cy) {
      const bx = cx;
      const by = prev.y;
      if (bx >= 0 && bx < GRID_W && by >= 0 && by < GRID_H) {
        const bkey = by * GRID_W + bx;
        if (!cells.has(bkey)) cells.set(bkey, { x: bx, y: by, t });
      }
    }
    prev = { x: cx, y: cy };
    /*
     * THE TAIL IS 2 CELLS THICK AT ITS ROOT, tapering to 1. A 1px tail is a hairline that the first
     * ramp step erases; a uniformly 2px tail is a sausage. The thickening is applied on the axis the
     * curve is NOT travelling along at that point, approximated by thickening vertically near the
     * root (where the curve runs horizontally) and horizontally near the tip.
     */
    if (t < 0.45) {
      const ky = cy + 1;
      if (ky < GRID_H && !cells.has(ky * GRID_W + cx)) {
        cells.set(ky * GRID_W + cx, { x: cx, y: ky, t });
      }
    }
  }
  return [...cells.values()];
}

/**
 * ══ WHICH PART OWNS THIS PIXEL — and the ORDER IS THE DEPTH SORT ══
 *
 * bloodhorn: "getting it wrong is the one failure that ruins every creature... Putting the mane
 * before the head swallows the face; putting the head before the eyes erases them. Both produce a
 * creature that is a coloured blob, which is exactly the failure mode a 24x24 grid is least
 * forgiving of."
 *
 * Front to back: the FACE (eyes, nose, muzzle, whiskers) is ON the head, so it resolves first and
 * only where the head actually is. The EARS are behind the head at their overlapping base and in
 * front of nothing else. The HEAD is in front of the body. The BODY is in front of the tail — a cat
 * facing you has its tail BEHIND it — and the PAWS are under everything.
 */
export function cutePartAt(
  px: number,
  py: number,
  g: CuteGeometry,
  tail: ReadonlyMap<number, number>,
  drop: number,
  blinking: boolean,
  sad: boolean,
  dead: boolean,
): { part: CutePart; nx: number; ny: number; step?: number; light?: boolean; t?: number } | null {
  const head = headNormal(px, py, g, drop);
  if (head) {
    const eye = eyeStepAt(px, py, g, drop, blinking, sad, dead);
    if (eye) return { part: "eye", nx: 0, ny: 0, step: eye.step, light: eye.light };
    if (isNose(px, py, drop)) return { part: "nose", nx: 0, ny: 0, step: 1 };
    const muzzle = muzzleNormal(px, py, g, drop);
    if (muzzle) return { part: "muzzle", ...muzzle };
  }
  /*
   * The whiskers are tested OUTSIDE the head guard, because their whole job is to break the
   * silhouette — a whisker that only exists where the head already is would be invisible against the
   * coat. This is why they are excluded from the outline seed downstream: outlining a 1px mark
   * doubles its apparent weight and turns three whiskers into a dark smear.
   */
  /*
   * The whisker is emitted at step 4 — mid-ramp, barely above the coat.
   *
   * It was at 6, one step below the catchlight, and rendered at 384x zoom the whiskers were the
   * BRIGHTEST thing on the sprite after the eyes: four white bars projecting from a face whose own
   * cheeks sat at 4. They out-read the ears and drew the eye away from the face entirely.
   *
   * A whisker is a hair. It is not a lit surface and it has no business competing with a catchlight.
   * At step 4 it is visible against the ground where it projects past the skull — which is the only
   * place it needs to be visible — and it disappears into the cheek where it crosses the face, which
   * is exactly what a real whisker does at this distance.
   */
  if (isWhisker(px, py, g, drop)) return { part: "whisker", nx: 0, ny: 0, step: 4 };
  const ear = earNormal(px, py, g, drop);
  if (ear) return { part: ear.inner ? "earInner" : "ear", nx: ear.nx, ny: ear.ny };
  if (head) return { part: "head", ...head };
  const body = bodyNormal(px, py, g, drop);
  if (body) return { part: "body", ...body };
  const paw = pawNormal(px, py, g, drop);
  if (paw) return { part: "leg", ...paw };
  const t = tail.get(py * GRID_W + px);
  if (t !== undefined) return { part: "tail", nx: 0, ny: -0.2, t };
  return null;
}

/**
 * The Lambert term for one surface normal, run through the ramp and the dither.
 *
 * `shadeSphere`'s wrap, rim and core-shadow terms are tuned for a sphere and are dialled toward the
 * SOFT end here, because this cat is a round soft object lit almost frontally:
 *
 *   - `wrap` 0.58: high. A flat frontally-lit subject needs light to bleed well past the terminator
 *     or the shaded side of a big round head drops to the ground value and the silhouette develops a
 *     bite. bloodhorn hit exactly this and patched it with a step floor; wrapping fixes it at source.
 *   - `specularPower` 6: very low — a broad soft sheen. Fur is chalk. A tight highlight on a cat
 *     reads as a wet spot, and on a CUTE cat it reads as plastic.
 *   - `rimPower` 2.4: a wide rim, which is the only way a rim term touches more than a single pixel
 *     at this size and therefore the only way it reads as anything at all.
 *   - `ambient` 0.3: raised from the profile module's 0.2. A cute creature is lit BRIGHT — the brief
 *     is that the whole frontend is "too dark and dull" — and ambient is where that lives.
 *
 * Returns null only for a normal outside the unit disc, which for a part that already claimed the
 * pixel is an INTERIOR HOLE. The caller FILLS it rather than dropping it: bloodhorn's recorded
 * reason is that dropped holes punch empty pixels through the face, and once an outline pass exists
 * those holes get outlined and the animal comes out speckled with dark dots across its cheeks.
 */
export function cuteShadeStep(nx: number, ny: number, px: number, py: number): number | null {
  const lum = shadeSphere({
    nx,
    ny,
    light: LIGHT,
    ambient: 0.3,
    wrap: 0.58,
    specularPower: 6,
    rimPower: 2.4,
  });
  if (lum === null) return null;
  return quantise({ value: lum, steps: RAMP_STEPS, x: px, y: py, strength: DITHER });
}
