/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PROFILE SKELETON — a cat seen from the SIDE, which is where "cat" actually lives.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ WHY THIS EXISTS: THE HEAD-ON POSE WAS THE ROOT CAUSE OF EVERY REMAINING DEFECT ══
 *
 * The 24x24 rebuild fixed the ramp, the pigment and the resolution, and the cats still read as
 * hunched symmetrical blobs with two ears and two eyes. Three separate defects were logged against
 * it — no legible neck, an illegible `dead` state (six failed attempts), and a muddy `starving` row
 * — and they turned out to be one defect wearing three hats: **the animal was drawn facing the
 * viewer, and a front-facing quadruped hides behind itself.**
 *
 * Everything that makes a cat identifiable as a cat is a PROFILE feature:
 *
 *   | cue                        | head-on         | profile                                  |
 *   |----------------------------|-----------------|------------------------------------------|
 *   | the back line              | INVISIBLE       | the top edge of the silhouette           |
 *   | the chest / brisket        | INVISIBLE       | the curve under the throat               |
 *   | the belly line             | INVISIBLE       | the bottom edge — and where THIN shows   |
 *   | the neck                   | a value break   | an actual notch between skull and withers|
 *   | the muzzle                 | a flat pad      | protrudes IN FRONT of the eye            |
 *   | front vs back legs         | fused into two  | four legs with a gap between the pairs   |
 *   | the tail                   | a stick out one side | leaves the spine at the croup       |
 *   | lying down (`dead`)        | UNDRAWABLE      | the same silhouette, rotated             |
 *
 * The muzzle row is the single biggest one. A face with the muzzle in FRONT of the eye is a cat; a
 * face with the muzzle below and between two eyes is an owl, which is exactly what the head-on
 * version kept reading as no matter how the cheeks and the nose were tuned.
 *
 * ══ THE EVIDENCE, AND IT WAS ALREADY IN THE CORPUS ══
 *
 * `~/work/unitick/apps/web/app/lib/mascot.ts` — NEEDLE — is a full-body quadruped in STRICT LEFT
 * PROFILE, hand-authored as ASCII at **20x16**. That is 320 cells against this file's 576, and it
 * reads as an animal instantly: a horizontal barrel with a back line, a neck rising at the front, a
 * single eye pixel, and four legs with a gap. Its own header records that in profile "an animal
 * reads as alive from posture alone, so the face can be almost absent".
 *
 * openhood's unicorn is head-on and works, and that is not a counterexample — it works BECAUSE a
 * horn and a mane are front-facing features, and because it is a portrait rather than a body. A cat
 * has neither. The head-on pose was inherited from an animal it suited.
 *
 * ══ WHAT THIS MODULE OWNS, AND WHAT IT DOES NOT ══
 *
 * It owns the SKELETON: which cells belong to which body part, in profile, for a given geometry,
 * posture, state and frame. It returns parts and surface normals and nothing else.
 *
 * It does NOT own the ramp, the pigment, the dither, the state exposure, the outline pass or the
 * hash budget. All of those survived the pose change unaltered — they were never the problem — and
 * they stay in `grid.ts`, which calls this module for the geometry and then shades it exactly as
 * before. The pigment feathering and the luminance rescale in particular are untouched.
 *
 * ══ THE CAT FACES LEFT, ALWAYS ══
 *
 * Never mirrored on a hash bit. Half a colony facing each way reads as two species rather than one
 * with variation — the same rejection the tail's side already carries. Facing LEFT specifically so
 * the tail exits RIGHT, which keeps the tail's own axis in the columns it was tuned for.
 */

import { fnv1a } from "@taia/ui/mechanisms";

import { GRID_H, GRID_W } from "./dims.js";

/**
 * ══ THE PROFILE ROW BUDGET ══
 *
 * A profile cat is a HORIZONTAL animal, so the budget is dominated by the barrel rather than by a
 * stack of head-over-body. Rows run top-down; `[start, end)`.
 *
 * The head is no longer stacked ABOVE the body — in profile they sit side by side, with the head at
 * the front and slightly higher. That is the change that frees the vertical budget: the head-on
 * version spent 8 rows on a head and 7 on a body because they could not overlap, and here they
 * overlap by design, which is what leaves room for legs that are actually legs.
 */
export const PROFILE_ROWS = {
  /** Rows 1-5. The ears, above the skull at the front of the animal. */
  ear: [1, 6],
  /** Rows 4-12. THE SKULL, at the front (left). Overlaps the ear rows by design. */
  head: [4, 12],
  /** Rows 8-17. THE BARREL — the back line at 8, the belly at 17. The subject. */
  body: [8, 17],
  /** Rows 16-22. The legs. Six rows, which is what makes them read as legs rather than as feet. */
  legs: [16, 22],
  /** Row 22-23. The ground line the paws sit on. */
  paw: [21, 23],
} as const;

/** The animal's front edge — the tip of the muzzle. Everything is measured back from here. */
export const NOSE_X = 3;

/**
 * ══ THE SPINE — the single most important curve in the file ══
 *
 * A cat's back is not a straight line: it rises from the shoulder, dips slightly behind the withers,
 * and rises again over the croup (the haunch) before falling to the tail. That double curve is what
 * distinguishes a cat from a loaf of bread, and it is the reason a profile cat reads at 16px where a
 * front-facing one does not.
 *
 * Returned as the row of the BACK LINE at a given column, so `bodyAt` can measure the barrel's
 * thickness downward from it. Expressed as a function rather than a table because posture and state
 * both modulate it — an arching stretch, a flattened crouch, a starving cat's jutting spine.
 */
function backLineAt(cx: number, geom: ProfileGeometry): number {
  const { chestX, croupX } = spineAnchors(geom);
  const t = Math.max(0, Math.min(1, (cx - chestX) / Math.max(1, croupX - chestX)));
  /*
   * The withers dip. A cosine hump peaking a third of the way back, which is where a cat's shoulder
   * blades sit. Without it the back is a straight line and the animal reads as a bench.
   *
   * The amplitude is deliberately under one pixel at its peak (0.75): the dip has to be visible in
   * the rasterised silhouette without becoming a notch. At 1.5 it read as a broken back.
   */
  /*
   * ══ THE HIP IS HIGHER THAN THE SHOULDER — the correction that stops it reading as a DOG ══
   *
   * The first profile draft had a LEVEL topline with a small dip at the withers, which is a canid
   * silhouette: a dog's back runs level or falls away toward the tail. A review of the render named
   * it directly — "the back is too flat and the hindquarters too low... the rear falls away, which
   * is exactly a dog silhouette".
   *
   * A standing cat is the opposite. Its hind legs are longer and more angulated than its front ones,
   * so the CROUP is the highest point of the topline and the back rises gently from the withers to
   * the hip before dropping to the tail. That rise is one of the few silhouette cues that separates
   * a cat from a small dog at 24px, and it costs two pixels.
   *
   * `HIP_RISE` lifts the rear of the spine (lower row number is higher on screen) and the cosine
   * places the peak over the hind leg rather than at the very end, so the croup is a rounded haunch
   * rather than a ramp. A LYING cat is exempt: an animal on its side has no weight-bearing
   * hindquarter and a raised croup would read as a hump.
   */
  const dip = 0.75 * Math.sin(t * Math.PI);
  /*
   * ══ A SITTING CAT'S TOPLINE IS THE INVERSE OF A STANDING ONE'S ══
   *
   * Standing, the croup is the HIGHEST point — that hip rise is what stops the silhouette reading as
   * a dog. Sitting, the hindquarters are folded on the ground and the chest is propped up, so the
   * rump is the LOWEST point and the back slopes down from the shoulder to the tail.
   *
   * Reusing the standing rise for `sit` gave a cat with its rear in the air and its chest down,
   * which is the play-bow `stretch` already owns — two postures rendering as the same shape, and the
   * most identifiable cat pose there is wasted on a duplicate. Negating it costs one branch and buys
   * the whole silhouette.
   */
  const hip = geom.lying ? 0 : (geom.sitting ? -SIT_RUMP_DROP : HIP_RISE) * smootherHip(t);
  return geom.backRow + dip * (1 - geom.arch) - geom.arch * 1.6 * Math.sin(t * Math.PI) - hip;
}

/**
 * How far the barrel's rump extends PAST the croup anchor.
 *
 * Named rather than repeated because `bodyAt` draws to it and `profileTailCells` roots the tail just
 * beyond it, and those two must agree — when they did not, the body swallowed the tail whole.
 */
const BODY_REAR_OVERHANG = 2.2;

/**
 * How many rows the croup sits ABOVE the withers on a standing cat.
 *
 * 1.6 — over a pixel and a half, so it survives rasterisation on every posture. At 0.8 the rise was
 * under one pixel across most of the back and the topline rendered level, which is the dead-axis
 * failure this package has recorded four times: a continuous parameter whose effect falls below the
 * quantum does nothing at all.
 */
const HIP_RISE = 1.6;

/**
 * How far a SITTING cat's rump drops below its shoulder line.
 *
 * 2.2 — larger than `HIP_RISE`, so the difference between a sitting cat and a standing one is close
 * to four rows at the croup. That is a gross-proportion change, which is what survives being shrunk
 * to the 16-40px the world renders at; a subtler drop would be invisible exactly where the posture
 * axis is supposed to be doing its work.
 */
const SIT_RUMP_DROP = 2.2;

/**
 * The fewest rows of barrel the body may ever have at any column.
 *
 * Two, because one row of body is a line rather than a mass — at 24px a 1px barrel reads as a wire
 * connecting the head to the haunch, which is worse than no waist at all.
 */
const MIN_BARREL = 2;

/**
 * The shallowest a barrel may be, given that `HIP_RISE` is subtracted from its back line at the
 * croup and `MIN_BARREL` must survive there.
 *
 * Derived rather than typed: the two constants it depends on have both been retuned once already,
 * and a hardcoded floor that agreed with them at one setting is exactly the class of bug this
 * package has recorded nine times.
 */
export const HIP_SAFE_DEPTH = HIP_RISE + MIN_BARREL + 1.2;

/**
 * The hip's own profile along the back — 0 at the withers, 1 over the hind leg, easing off past it.
 *
 * A smoothstep-and-hold rather than a sine, so the croup is a broad rounded HAUNCH rather than a
 * single peak. A sine put the maximum at the body's midpoint, which raised the middle of the back
 * and read as a hunch rather than as hindquarters.
 */
function smootherHip(t: number): number {
  const x = Math.max(0, Math.min(1, (t - 0.28) / 0.45));
  return x * x * (3 - 2 * x);
}

/** Where the chest and the croup sit horizontally. Both move with posture. */
function spineAnchors(geom: ProfileGeometry): { chestX: number; croupX: number } {
  return { chestX: NOSE_X + 4.5, croupX: NOSE_X + 4.5 + geom.bodyLen };
}

/**
 * ══ THE BELLY LINE — where STARVING becomes legible ══
 *
 * The bottom edge of the barrel. On a fed cat it hangs low and nearly level; on a starving one it
 * is tucked up hard behind the ribs, which is the single most recognisable sign of a thin animal
 * and is completely undrawable head-on (where "thin" can only mean "narrower").
 *
 * The tuck is placed BEHIND the ribcage and in front of the haunch — the flank — because that is
 * where a real cat's waist is, and putting it at the midpoint made the animal look pinched rather
 * than hungry.
 */
function bellyLineAt(cx: number, geom: ProfileGeometry): number {
  const { chestX, croupX } = spineAnchors(geom);
  const t = Math.max(0, Math.min(1, (cx - chestX) / Math.max(1, croupX - chestX)));
  // The barrel is deepest at the ribcage (t ~ 0.25) and at the haunch (t ~ 0.9), with the waist
  // between them. A single ellipse gives a sausage; two lobes give a cat.
  const rib = Math.exp(-(((t - 0.22) / 0.3) ** 2));
  const haunch = Math.exp(-(((t - 0.88) / 0.28) ** 2));
  const depth = geom.depth * Math.max(0.42, Math.max(rib, haunch * 1.02));
  // The waist tuck: on a thin cat the flank is drawn up toward the spine.
  const waist = geom.tuck * Math.exp(-(((t - 0.58) / 0.26) ** 2));
  /*
   * ══ THE TUCK MAY NEVER CUT THE BARREL IN TWO ══
   *
   * A step-grid dump of a starving cat showed the waist pulled so far up that the belly line crossed
   * ABOVE the back line at the flank — so the barrel had a hole through it and the cat rendered in
   * two pieces, front and rear, joined by nothing. The flood fill would have caught it; the render
   * caught it first.
   *
   * The floor keeps at least `MIN_BARREL` rows of body at every column, so a starving cat is drawn
   * as thin as the geometry can carry and never as severed. That is also the honest limit: a real
   * animal's flank is drawn up, not absent, and past a certain tuck the drawing stops meaning
   * "hungry" and starts meaning "broken sprite" — the same failure the head-on `dead` state had.
   */
  const back = backLineAt(cx, geom);
  return Math.max(back + MIN_BARREL, back + depth - waist);
}

/** Every varying axis of a profile cat. Derived in `grid.ts` from the same salted hashes. */
export type ProfileGeometry = {
  /** Row of the back line at the shoulder. Lower is a taller-standing cat. */
  readonly backRow: number;
  /** How many columns the barrel spans, chest to croup. The largest silhouette axis. */
  readonly bodyLen: number;
  /** How deep the barrel is, back to belly. Build. */
  readonly depth: number;
  /** How far the flank is drawn up. 0 on a fed cat, large on a starving one. */
  readonly tuck: number;
  /** 0..1. How much the spine arches upward — a stretch or a scared cat. */
  readonly arch: number;
  /** Row the paws stand on. Posture moves this relative to the back. */
  readonly groundRow: number;
  /** How far the head sits forward of the chest, and how high. */
  readonly headX: number;
  readonly headY: number;
  /** The skull's radii. */
  readonly headR: number;
  /** 3..5. Ear height in rows. */
  readonly earHeight: number;
  /** 1.4..2.6. Ear half-width at the base. */
  readonly earWidth: number;
  /** −1..1. Ear lean: negative flattens back, positive pricks forward. */
  readonly earAngle: number;
  /** −1..1 and 0..1, as before. */
  readonly tailCurl: number;
  readonly tailLift: number;
  /** 0,1,2 — eye shape. */
  readonly eyeShape: number;
  /** 2 or 3 — whisker length. */
  readonly whiskerLen: number;
  /** Whether the front legs are tucked under (sitting/lying) rather than standing. */
  readonly frontTucked: boolean;
  /** Whether the animal is lying on its side — the `dead` read. */
  readonly lying: boolean;
  /**
   * Whether the cat is SITTING, which gets its own leg layout rather than being a crouch variant.
   * See `legAt`: sitting inverts which pair is tucked, so it cannot be expressed by `frontTucked`.
   */
  readonly sitting: boolean;
};

/** Which part of the profile cat owns a cell. */
export type ProfilePart =
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
  | "paw";

export type ProfileHit = {
  readonly part: ProfilePart;
  readonly nx: number;
  readonly ny: number;
  /** A MARK rather than a surface: carries its own ramp step and skips the diffuse model. */
  readonly step?: number;
  /** For the tail, how far along its length this cell sits. */
  readonly t?: number;
};

/**
 * THE SKULL — a rounded box in profile, with the muzzle protruding at the FRONT.
 *
 * In profile a cat's skull is a short box with a domed top, and the muzzle is a smaller box stuck on
 * the front of it at the bottom. That relationship — muzzle FORWARD and BELOW, not centred — is what
 * makes the head read as a cat rather than as an owl, and it is the one thing the head-on version
 * could never draw.
 */
function headAt(cx: number, cy: number, geom: ProfileGeometry): ProfileHit | null {
  const nx = (cx + 0.5 - geom.headX) / geom.headR;
  const ny = (cy + 0.5 - geom.headY) / (geom.headR * 0.86);
  // A superellipse at 2.4: flat-sided enough to have a cheek and a jaw, round enough at the corners
  // not to read as a crate. Same reasoning as the head-on version, which got this part right.
  if (Math.abs(nx) ** 2.4 + Math.abs(ny) ** 2.4 <= 1) {
    return { part: "head", nx, ny };
  }
  return null;
}

/**
 * THE MUZZLE — protruding forward and low, in front of the eye.
 *
 * Sits at the skull's lower-front quadrant and extends PAST it toward the nose. Short: a cat's
 * muzzle barely protrudes, and a long one is a dog or a fox immediately. Two rows tall and about
 * three columns proud of the skull is the whole budget.
 */
function muzzleAt(cx: number, cy: number, geom: ProfileGeometry): ProfileHit | null {
  /*
   * ══ THE MUZZLE IS A BUMP, NOT A SNOUT — measured, and the fix for a dog read ══
   *
   * At rx 2.5 the muzzle projected three columns past the skull, which on a small head is a SNOUT
   * and reads as a dog or a fox immediately. openhood recorded the identical failure at the identical
   * scale for its unicorn ("spread the muzzle nine pixels wide and turned the whole lower face into
   * a snout — the exact small-horse failure"), and this is the same mistake in a different species.
   *
   * A cat's muzzle barely projects: the whole face is a round skull with a small wedge at the front
   * for the nose and whisker pads. At rx 1.5 it adds about one column past the skull's own edge,
   * which is the bump a cat actually has — enough to keep the muzzle IN FRONT of the eye (the
   * assertion that pins the profile pose) without ever reading as a snout.
   */
  const mx = geom.headX - geom.headR * MUZZLE.ax;
  const my = geom.headY + geom.headR * MUZZLE.ay;
  const nx = (cx + 0.5 - mx) / MUZZLE.rx;
  const ny = (cy + 0.5 - my) / MUZZLE.ry;
  if (nx * nx + ny * ny > 1) return null;
  // Leans toward the viewer and forward, so it catches more light than the cheek behind it and
  // separates without needing an outline between them.
  return { part: "muzzle", nx: nx * 0.6 - 0.25, ny: ny * 0.6 - 0.2 };
}

/**
 * THE EYE — one eye, because this is a profile and a cat has one visible side.
 *
 * NEEDLE uses a SINGLE PIXEL for its eye at 20x16 and records that in profile the face can be almost
 * absent because posture carries the read. At 24x24 there is room for a 2x2 with a dark pupil and a
 * bright rim, which is the smallest mark that reads as an eye rather than as a dot — but the
 * principle holds: the eye is a mark on a head that is already legible, not the thing carrying the
 * animal.
 *
 * It sits BEHIND and ABOVE the muzzle, which is the relationship that says "profile". Head-on, two
 * eyes flanking a nose is the arrangement of an owl; in profile one eye set back from a protruding
 * muzzle is unambiguously a cat.
 */
function eyeAt(
  cx: number,
  cy: number,
  geom: ProfileGeometry,
  frame: number,
  frames: number,
): ProfileHit | null {
  /*
   * The eye sits forward of the skull's centre and slightly ABOVE it — a cat's eye is high and
   * forward in the skull, over the cheekbone, with the muzzle protruding below and ahead of it. The
   * first draft put it at `-0.12` of the radius, which is essentially the centre, and the face read
   * as having its eye in its cheek.
   */
  const ex = Math.round(geom.headX - geom.headR * 0.34);
  const ey = Math.round(geom.headY - geom.headR * 0.3);
  const dx = cx - ex;
  const dy = cy - ey;
  if (dx < 0 || dx > 1 || dy < 0 || dy > 1) return null;

  /*
   * THE BLINK. Frame 2 closes the eye to its lower row at a dim step, regardless of the cat's own
   * `eyeShape` — a blink that varied per cat would be an identity axis rather than an animation, and
   * a viewer watching a cat blink must not conclude the cat CHANGED.
   */
  if (frame % frames === 2) {
    if (dy !== 1) return null;
    return { part: "eye", nx: 0, ny: 0, step: 3 };
  }

  /*
   * The masks are written out rather than computed, for openhood's recorded reason: it derived three
   * eye shapes from index predicates and shipped three bugs in four lines. At 2x2 there is nothing
   * to compute.
   *
   * `#` full eyeshine, `o` iris, `.` pupil. The pupil is at the FRONT-BOTTOM in every shape, which
   * is where a cat's pupil sits when it is looking ahead — and keeping it constant across shapes
   * means the shapes vary in value rather than in where the cat is looking.
   */
  const MASKS: Readonly<Record<number, readonly string[]>> = {
    0: ["##", ".o"], // wide open — the default and the brightest
    1: ["#o", ".o"], // narrowed — the rear half dims
    2: ["oo", ".#"], // hooded — the upper lid is down, the lower rim catches the light
  };
  const mask = MASKS[geom.eyeShape] ?? MASKS[0];
  const cell = mask?.[dy]?.[dx];
  if (cell === undefined) return null;
  if (cell === ".") return { part: "eye", nx: 0, ny: 0, step: 1 };
  if (cell === "o") return { part: "eye", nx: 0, ny: 0, step: 5 };
  return { part: "eye", nx: 0, ny: 0, step: 7 };
}

/**
 * THE MUZZLE'S PLACEMENT AND SIZE, in one object.
 *
 * `muzzleAt` draws it, `whiskerAt` starts the whiskers where it ends, and `noseAt` puts the nose at
 * its tip. All three must agree; when they did not — the muzzle was shrunk and the other two were
 * left at the old numbers — the whiskers detached and floated beside the face.
 *
 * `ax`/`ay` are offsets from the skull's centre as a fraction of its radius, so the muzzle scales
 * with the head rather than needing to be retuned whenever `headR` moves.
 */
/** The ear's lean, as a whole number of columns. Bounded to one so consecutive rows always overlap. */
function EAR_LEAN(geom: ProfileGeometry): number {
  return Math.round(Math.max(-1, Math.min(1, geom.earAngle)));
}

/**
 * Columns between the near ear's centre and the far ear's.
 *
 * TWO. At three the far ear's base hung past the skull's rear edge with nothing beneath it, which
 * the per-column support assertion caught — an ear whose base has no head under it reads as a horn
 * floating off the corner of the skull.
 *
 * Two columns is enough separation because the far ear is drawn at a fixed DARK step while the near
 * ear is at the lit end of the ramp: the pair is separated by VALUE as well as by position, so it
 * does not need the full column of daylight between them that two equally-lit ears would.
 */
const EAR_GAP = 2;

const MUZZLE = { ax: 0.62, ay: 0.44, rx: 1.5, ry: 1.25 } as const;

/** THE NOSE — a single dark cell at the front tip of the muzzle. */
function noseAt(cx: number, cy: number, geom: ProfileGeometry): ProfileHit | null {
  const nx = Math.round(geom.headX - geom.headR * MUZZLE.ax - MUZZLE.rx);
  const ny = Math.round(geom.headY + geom.headR * MUZZLE.ay - 0.5);
  if (cx !== nx || cy !== ny) return null;
  return { part: "nose", nx: 0, ny: 0, step: 2 };
}

/**
 * THE EARS — two triangles on a skull seen from the side.
 *
 * ══ PROFILE SOLVES THE CROWN-WIDTH PROBLEM THAT TOOK NINE ATTEMPTS HEAD-ON ══
 *
 * Head-on, both ears had to fit across the skull's width with a gap between them, and the skull's
 * crown is its narrowest row — so the ears were permanently starved of columns and nine successive
 * fixes each moved the failure somewhere else. In profile the ears are stacked front-to-back along
 * the skull's TOP rather than side-by-side across its width, and the top of a skull in profile is
 * its LONGEST dimension. The constraint simply disappears.
 *
 * The near ear is drawn fully; the far ear is a partial silhouette behind it, one column back and a
 * row lower, which is what gives the head depth. Two ears at different depths is also unmistakably
 * a profile read, where two symmetric ears is the head-on read this module exists to replace.
 */
function earAt(cx: number, cy: number, geom: ProfileGeometry): ProfileHit | null {
  /*
   * The ear's base sits ON the skull's dome — `headR * 0.5` above the skull's centre, which is where
   * the superellipse still has most of its width, so the base has skull beneath it at every head
   * size. Perching the base on the very top of the dome (`0.62`) put it where the curve has already
   * narrowed and the ears floated a row clear of the head.
   */
  /*
   * ══ THE EAR BASE IS PINNED TO THE SKULL'S TOP EDGE, NOT TO A FRACTION OF ITS RADIUS ══
   *
   * `headY - headR * 0.5` was tuned when the skull had radius 2.9. Once the head was shrunk to fix
   * the dog read, that fraction put the ear's base INSIDE the face — and because `earAt` resolves
   * before `headAt` in the depth sort, the ears painted over the entire skull. A part dump of
   * `stray-2` showed a head of TWO cells with five rows of ear on top of it: the ears had eaten the
   * face.
   *
   * Pinning the base to the skull's actual top edge (`headY - headR`) means the ear always starts
   * where the head ends, at every head size, and the `+0.4` overlap keeps the join continuous so no
   * gap opens between them. This is the same lesson this package has now recorded in five parts:
   * when two pieces of geometry must meet, DERIVE one from the other rather than from a constant
   * that agreed with it at one particular size.
   */
  const baseY = Math.round(geom.headY - geom.headR + 0.4);
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════
   * THE EARS ARE DRAWN AS EXPLICIT TRIANGLES ON THE INTEGER GRID.
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The first profile draft placed the two ears by fractions of the skull's radius and let their
   * tapers overlap. Once the skull was shrunk to fix the dog read, those fractions put the near and
   * far ear within a column of each other and their bases MERGED — a part dump showed a single solid
   * five-column block spanning four rows, with no gap and no inner cone. Rendered, every cat had a
   * bright fan on top of its head rather than two pointed ears.
   *
   * Ears are the single most identifying feature a cat's silhouette has at this size, so they are
   * now built from integer column offsets rather than from fractions of a radius that moves:
   *
   *   - the NEAR ear sits over the brow, at the front of the skull;
   *   - the FAR ear sits `EAR_GAP` columns behind it, one row lower and one column narrower, which
   *     is the parallax of a head seen side-on;
   *   - both taper one column per row — a 45° edge, the only slope that reads as a clean diagonal
   *     in pixel art rather than as a staircase.
   *
   * The gap between them is what makes the pair read as TWO ears. Without it they are a crest.
   */
  /*
   * The ear's base row is the skull's own top edge MINUS one, so the ear rises from just above the
   * crown rather than from inside it. At `+0.4` the base landed a row down into the face and the
   * ears overlapped the eye row — `earAt` resolves before `headAt`, so they painted over the brow.
   *
   * One row of overlap with the skull's outline is deliberate and is what keeps the join continuous:
   * the ear's base row sits exactly on the skull's topmost drawn row, so there is never a gap
   * between them for the outline pass to run through.
   */
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════
   * THE EARS — two solid triangles rising off the BROW, built on the integer grid.
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Four placements were tried and rendered before this one, and the sequence is worth recording
   * because each failed differently and the last two failed for opposite reasons:
   *
   *   1. Fractions of the skull's radius — the two ears MERGED into one solid block once the skull
   *      was shrunk, and every cat had a bright fan on its head instead of ears.
   *   2. Base pinned a row above the crown — the ears floated, detached, with the outline pass
   *      running through the gap.
   *   3. Base pinned a row inside the crown — the ears painted over the eye row, because `earAt`
   *      resolves before `headAt` in the depth sort.
   *   4. Base probed from the skull's topmost DRAWN row — correct at the centre column, where the
   *      dome is highest, which put both ears at the middle of the head and left them as thin
   *      spikes over the crown rather than triangles at the brow.
   *
   * The fix is to stop deriving the base from the skull's top at all. A cat's ears sit at the BACK
   * of the brow, roughly over the eye, and their bases are wide relative to a small skull. So the
   * anchor is the EYE's own column — which is already positioned relative to the head and already
   * correct — and the base row is the highest row of head at that column. Both ears are then placed
   * by whole-column offsets from there, which is the only construction that has held for every head
   * size without a per-cat clamp.
   */
  /*
   * ══ THE EARS SIT ON THE CROWN, BEHIND THE EYE — not over the brow ══
   *
   * Anchoring the near ear to the EYE's own column put it at the front of the skull, directly above
   * the muzzle. A part dump showed the near ear occupying columns 3-5 while the head ran 2-7, so
   * both ears were crowded onto the front third of the face — and rendered at 96px that reads as a
   * single bright spike rising off the nose, which is a horn or a raised paw, not a pair of ears.
   *
   * A cat's ears are set BACK on the skull, behind and above the eye, on the crown. The anchor is
   * therefore the skull's own centre column: the near ear sits just behind it and the far ear
   * `EAR_GAP` further back, which puts the pair over the crown where they belong and leaves the brow
   * and muzzle clear in front of them.
   *
   * The probe still finds the topmost DRAWN row at the ear's own column, so the base always meets
   * the skull whatever `headR` is — the fix that took four attempts and must not be undone.
   */
  const crownCol = Math.round(geom.headX);
  /*
   * ══ EACH EAR PROBES THE SKULL AT ITS OWN COLUMN ══
   *
   * A single `brow` measured at the crown column was correct for the near ear and wrong for the far
   * one: the far ear sits two columns back, where a domed skull has already fallen away by a row, so
   * its base row floated and the flood fill found its tip orphaned on `stray-2`.
   *
   * Probing per ear means each one stands on the skull's real top edge AT THE COLUMN IT OCCUPIES,
   * whatever the head's size or the ear's offset. This is the same fix, for the tenth time in this
   * package: measure the row the rasteriser actually draws, at the place it is drawn.
   */
  const browAt = (col: number): number => {
    let top = Math.round(geom.headY);
    for (let probe = Math.round(geom.headY); probe > geom.headY - geom.headR - 2; probe--) {
      if (headAt(col, probe, geom) !== null) top = probe;
    }
    return top;
  };

  for (const side of [0, 1] as const) {
    const isNear = side === 0;
    /*
     * Height: 3 rows near, 2 far. A cat's ear is about two thirds of its skull's height, and at a
     * skull of ~5 rows that is 3. Taller and the ear out-sizes the head, which reads as a rabbit —
     * measured at 4 rows on a 2.3-radius skull.
     */
    /*
     * ══ THE EAR RISES FOUR ROWS, BECAUSE ITS FIRST TWO ARE INSIDE THE SKULL ══
     *
     * The base OVERLAPS the crown by design — that overlap is what keeps the join continuous and it
     * took four attempts to get right. But the overlap costs rows: at a height of 3, rows 0 and 1
     * sat inside the skull's own silhouette and only the 1-column TIP cleared it, so the ear read as
     * a 1px spike no matter how wide its base was. The taper was correct (3-3-1 columns) and
     * entirely invisible.
     *
     * At 4 rows the ear clears the crown by two, which is what shows the 3-column base narrowing to
     * a point — the triangle a viewer actually reads as an ear. The identity axis still selects
     * between a 4-row and a 5-row ear via `earHeight`.
     */
    /*
     * The FAR ear is two rows shorter than the near one, not one. The flood fill caught `stray-2`
     * with its far-ear TIP orphaned: the far ear sits a row lower and a couple of columns back, where
     * the skull's dome has already fallen away, so a tall far ear reaches past the crown and its top
     * row has neither head nor ear beneath it. An orphaned cell is NEEDLE's dust and it breaks rule 4
     * outright.
     *
     * Two rows shorter is also the correct parallax: an ear seen from behind and further away
     * presents less height, which is what makes the pair read as two ears at different depths rather
     * than as two ears side by side.
     */
    /*
     * ══ THREE ROWS, NOT FOUR — a tall narrow ear is a HORN ══
     *
     * At four rows the near ear rose two clear rows above the crown as a 1-column column, and
     * rendered at 96px every cat had a single bright SPIKE off the front of its head. A viewer reads
     * that as a horn or a raised paw; it is the same failure openhood records for its own horn tip
     * and NEEDLE for its floating one.
     *
     * The fix is proportion, not position: an ear that is TALLER than it is wide reads as a spike at
     * any anchor. Three rows against a three-column base makes it as wide as it is tall — which is
     * roughly a cat's ear — and the triangle finally reads as a triangle.
     */
    const h = (isNear ? 3 : 2) + (geom.earHeight >= 5 ? 1 : 0);
    // The base OVERLAPS the skull's top row by one, so the join is continuous and the outline pass
    // can never run between ear and head. That overlap is the whole reason the ear is drawn before
    // the head in the depth sort.
    const earCol = crownCol + (isNear ? 0 : EAR_GAP);
    // The base sits ON the skull's topmost drawn row at this ear's own column, so the join is always
    // continuous — no gap for the outline pass to run through, and no floating base.
    const baseRow = browAt(earCol);
    const rowsUp = baseRow - cy;
    if (rowsUp < 0 || rowsUp >= h) continue;

    /*
     * A solid triangle: 2 columns at the base narrowing to 1 at the tip, one column per row, which
     * is the 45° edge that reads as a clean diagonal rather than as a staircase.
     */
    /*
     * ══ THE BASE IS THREE COLUMNS, NOT TWO — a spike is not an ear ══
     *
     * At a half-width of 1 the base was two columns and the tip one, and a 3-row ear tapering from
     * two to one rasterises as a near-vertical SPIKE. Rendered at 28x zoom on the head alone, every
     * cat had two thin prongs rather than triangles — the shape read as antennae or as horns.
     *
     * A cat's ear is BROAD at the base relative to its height: roughly as wide as it is tall. A
     * half-width of 1 at the tip rising from 1.5 at the base gives a 3-2-1 taper over three rows,
     * which is the widest triangle a 5-column skull can carry two of, and it is the first version
     * that reads as an ear rather than as a point.
     */
    /*
     * ══ THE TAPER IS IN WHOLE COLUMNS, AND THE FAR EAR NEVER NARROWS BELOW ONE ══
     *
     * A fractional half-width let the far ear go from a 3-column base to a 1-column tip while its
     * CENTRE was also being shifted by the lean, so its top cell could land a column clear of the
     * row beneath it — the flood fill found exactly that on `stray-2`, one orphaned cell at (8,7).
     *
     * The near ear tapers 3-3-1-1 over four rows and the far ear stays a constant single column: at
     * two rows there is nothing for a taper to say, and a fixed width cannot produce a step that the
     * row below fails to cover. Integer arithmetic throughout, which is the only form of this that
     * has ever held for every id.
     */
    // A 3-column base narrowing to 1 at the tip, one column per row: the 45° edge that reads as a
    // clean diagonal. The far ear stays a constant single column — see the lean comment below.
    /*
     * ══ THE BASE IS THREE COLUMNS AND HOLDS FOR TWO ROWS ══
     *
     * `1 - max(0, rowsUp - 1)` gave a half-width of 1 on the base row and 0 on every row above it,
     * so the ear was three columns for exactly one row and one column thereafter — and because the
     * base row overlaps the skull, the only part that CLEARED the head was the 1-column stem. The
     * new proportion assertion caught it on `stray-2` as a 1px base, which is precisely the spike
     * the test was written to keep out.
     *
     * Holding the full width for the first two rows means the part above the crown is a real
     * triangle rather than a stem with a point on it.
     */
    const halfCols = isNear ? Math.max(0, 1 - Math.max(0, rowsUp - 2)) : 0;
    /*
     * The near ear sits ON the crown column and the far ear `EAR_GAP` behind it. An earlier version
     * offset both by −1 "to sit just behind the eye", which cancelled exactly against the crown
     * column's own position and left the pair back where the eye-anchored version had put them — the
     * dump was byte-identical before and after the change, which is how a no-op edit hides.
     */
    /*
     * Only the NEAR ear leans. The far ear is a 1-column stub, so any shift of its centre moves the
     * whole stub — and a stub that steps sideways between two rows is two diagonally adjacent cells,
     * which are not orthogonally connected. That is precisely what the flood fill kept catching on
     * `stray-2`: one orphaned far-ear cell, surviving three different attempts to fix it by changing
     * the ear's HEIGHT and WIDTH when the culprit was its centre moving.
     */
    const centre = earCol + (isNear && rowsUp >= 2 ? EAR_LEAN(geom) : 0);
    const dx = cx - centre;
    if (Math.abs(dx) > halfCols) continue;

    /*
     * The inner cone: the ear's own centre column on its lower rows, two steps below the rim. That
     * dark core inside a lit rim is what makes the ear read as a CONE OPEN TOWARD THE VIEWER rather
     * than as a flat triangle, and at a 3-column base there is finally room for one.
     */
    /*
     * ══ THE INNER CONE IS THE CENTRE COLUMN OF EVERY ROW BUT THE TIP ══
     *
     * The condition was `rowsUp <= 1`, which are the rows INSIDE the skull — so the dark core was
     * drawn where the head covered it and never appeared. Every visible ear row came out at the same
     * bright step, and a solid triangle with no internal value change reads as a blob or a spike
     * however well its outline is shaped.
     *
     * A cat's ear seen from the side is a lit rim of cartilage around a shadowed hollow, and it is
     * that value break — not the silhouette — that says "ear". Drawing the core on every row that
     * has width for one (all but the 1-column tip) gives the rim-core-rim structure at last.
     */
    if (isNear && dx === 0 && halfCols >= 1) {
      return { part: "earInner", nx: 0, ny: -0.5 };
    }

    const nx = (halfCols === 0 ? 0 : dx / halfCols) * 0.6 - 0.2;
    const ny = -0.4 - (rowsUp / h) * 0.3;
    /*
     * The FAR ear is a flat dark triangle rather than a shaded one — it is seen from behind, has no
     * lit surface, and the value break is what makes it read as BEHIND the near ear rather than
     * beside it. Drawn at all because two ears at different depths is unmistakably a profile read.
     */
    if (!isNear) return { part: "ear", nx, ny, step: 3 };
    return { part: "ear", nx, ny };
  }
  return null;
}

/**
 * THE BARREL — the body, between the back line and the belly line.
 *
 * This is the part that carries the animal. Everything above about the spine's double curve and the
 * belly's two lobes lands here: a cell is body if it sits between the two curves at its own column.
 *
 * Drawing it as "between two curves" rather than as an ellipse is the whole point. An ellipse has
 * one shape; two independent curves give a back that arches, a belly that tucks, a chest that
 * deepens and a waist that narrows — four axes on a part that head-on had one (width).
 */
function bodyAt(cx: number, cy: number, geom: ProfileGeometry): ProfileHit | null {
  const { chestX, croupX } = spineAnchors(geom);
  if (cx + 0.5 < chestX - 2.4 || cx + 0.5 > croupX + BODY_REAR_OVERHANG) return null;
  const back = backLineAt(cx + 0.5, geom);
  const belly = bellyLineAt(cx + 0.5, geom);
  if (belly - back < 0.8) return null;
  if (cy + 0.5 < back || cy + 0.5 > belly) return null;
  // The normal sweeps across the barrel's DEPTH, so it takes light as a horizontal cylinder — lit
  // along the spine, shaded under the belly. That vertical gradient is most of what makes a profile
  // animal look round rather than like a cut-out.
  const ny = ((cy + 0.5 - back) / Math.max(1, belly - back)) * 2 - 1;
  // A slight horizontal term so the chest and the rump turn away at the ends.
  const t = (cx + 0.5 - chestX) / Math.max(1, croupX - chestX);
  const nx = (t - 0.5) * 0.5;
  return { part: "body", nx, ny: ny * 0.9 };
}

/**
 * THE LEGS — front pair and back pair, with a visible gap.
 *
 * ══ PROFILE IS WHAT MAKES FOUR LEGS AFFORDABLE ══
 *
 * Head-on, four legs needed eight columns of leg plus gaps across a body that was ten columns wide,
 * and the resolution refused it — the head-on version drew TWO legs and recorded that as the honest
 * trade. In profile the legs are spread along the body's LENGTH, which is its longest dimension, so
 * four legs with a real gap between the pairs is comfortable.
 *
 * That gap is a strong cue in its own right. NEEDLE's own recorded defect was "four 1px verticals at
 * even spacing read as a fringe", fixed by pairing them front and back with a gap — the same
 * arrangement used here.
 *
 * A SITTING or LYING cat tucks its front legs, which is what `frontTucked` selects: the front pair
 * becomes a short stub folded under the chest rather than a post reaching the ground.
 */
function legAt(cx: number, cy: number, geom: ProfileGeometry): ProfileHit | null {
  const { chestX, croupX } = spineAnchors(geom);
  const ground = geom.groundRow;
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════
   * SITTING IS THE MOST CAT-SPECIFIC SILHOUETTE THERE IS, SO IT GETS ITS OWN LEG LAYOUT.
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * A sitting cat is the pose a stranger identifies instantly: the front legs are STRAIGHT and
   * VERTICAL, propping the chest up; the hindquarters are folded flat on the ground behind them; and
   * the rump sits lower than the shoulder, which is the exact inverse of the standing topline.
   * Nothing else in a cat's repertoire looks like it, and no other animal on four legs sits that way.
   *
   * The first profile draft treated `sit` as a crouch variant — same two leg posts, slightly shorter
   * — and it read as a crouch, which wastes the strongest cue available. It now has its own layout:
   *
   *   - the FRONT leg is drawn LONGER than in any other posture and perfectly vertical, reaching the
   *     ground from the chest;
   *   - the BACK leg is TUCKED, a stub folded under the haunch rather than a post;
   *   - the haunch itself drops to the ground — see `postureRows`, where `sit` lowers the croup.
   *
   * That inverts which pair is tucked, which is why `frontTucked` alone could not express it and the
   * pairs are built here instead.
   */
  const sitting = geom.sitting;
  const pairs: readonly { x: number; tucked: boolean }[] = sitting
    ? [
        // FRONT pair — straight and vertical, propping up the chest.
        { x: chestX - 0.2, tucked: false },
        // BACK pair — folded flat under the rump. A sitting cat's hind leg shows as a stub.
        { x: croupX - 1.2, tucked: true },
      ]
    : [
        // FRONT pair — just behind the chest, under the shoulder.
        { x: chestX - 0.4, tucked: geom.frontTucked },
        // BACK pair — under the croup, where a cat's hind leg actually attaches.
        { x: croupX - 0.8, tucked: false },
      ];
  for (const pair of pairs) {
    /*
     * ══ THE POST IS TWO WHOLE COLUMNS, PINNED TO THE INTEGER GRID ══
     *
     * A continuous half-width of 0.9 either side of a fractional centre rasterises to TWO columns on
     * most cats and to ONE wherever the centre happens to land near a cell boundary — `stray-3` came
     * out with a 1px leg, which is the hairline NEEDLE's rule 3 bans outright because it vanishes at
     * the first ramp step and leaves the animal floating.
     *
     * Flooring the centre onto the grid and taking exactly two columns makes the width a property of
     * integer arithmetic rather than of where a float happened to fall. This is the same lesson the
     * head-on ear reached after nine attempts: when a rule must hold in the PIXELS, enforce it in
     * the pixels.
     */
    const leftCol = Math.floor(pair.x - 0.5);
    const dx = cx - leftCol - 0.5;
    if (cx < leftCol || cx > leftCol + 1) continue;
    const belly = bellyLineAt(pair.x, geom);
    // A tucked front leg stops short — it is folded under the chest, not standing on the ground.
    const bottom = pair.tucked ? belly + 1.6 : ground;
    if (cy + 0.5 < belly - 0.6 || cy + 0.5 > bottom) continue;
    const isPaw = !pair.tucked && cy + 0.5 > bottom - 1.1;
    // A leg is a small cylinder: the normal sweeps across its width and is flat along its length.
    return { part: isPaw ? "paw" : "leg", nx: dx * 1.1, ny: -0.1 };
  }
  return null;
}

/**
 * THE TAIL — leaving the SPINE at the croup, which is the profile payoff.
 *
 * Head-on the tail was a stick poking out of one side of a blob, and it never looked attached
 * because there was nowhere for it to attach TO. In profile it leaves the base of the spine at the
 * croup, which is anatomically where a tail is and reads as continuous with the back line.
 *
 * Marched rather than drawn as a region, for the reason the head-on version recorded: an implicit
 * region 1px wide has no interior, so the rasteriser hits or misses it depending on where the curve
 * crosses a pixel centre and the result is a dotted line. Marching stamps every cell along the path,
 * with the diagonal bridge that keeps it orthogonally connected.
 */
export function profileTailCells(geom: ProfileGeometry): Map<number, number> {
  /*
   * ══ THE ROOT SITS OUTSIDE THE BARREL'S OWN REAR EDGE ══
   *
   * `bodyAt` draws the barrel out to `croupX + 2.2`, so rooting the tail at `croupX + 1.4` put it
   * INSIDE the body — and the body resolves first in the depth sort, so every tail cell was painted
   * as rump and `stray-1` rendered with no tail at all. That is the head-on version's recorded
   * tail-root bug arriving in a new pose: a constant that agreed with its neighbour until the
   * neighbour changed.
   *
   * The root is derived from the same rear edge `bodyAt` uses, so the first stamped cell is always
   * orthogonally adjacent to the barrel's last column — rule 1 at the tightest possible margin, by
   * construction rather than by a constant that happened to work.
   */
  const { croupX } = spineAnchors(geom);
  const rootX = croupX + BODY_REAR_OVERHANG + 0.5;
  const rootY = backLineAt(croupX, geom) + 1.2;
  const out = new Map<number, number>();
  let last: { x: number; y: number } | null = null;

  const stamp = (sx: number, sy: number, st: number): void => {
    if (sx < 0 || sx >= GRID_W || sy < 0 || sy >= GRID_H) return;
    const k = sy * GRID_W + sx;
    const prev = out.get(k);
    if (prev === undefined || st < prev) out.set(k, st);
  };

  const SAMPLES = 80;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    /*
     * A LYING cat's tail lies along the ground behind it rather than being carried. Separated from
     * the standing curve rather than folded into it, because a lift value that produced a lying tail
     * would also produce it on a standing cat.
     */
    /*
     * The horizontal sweep is larger than the head-on version's because a profile tail extends
     * BEHIND the animal rather than out to its side, and behind is where the grid has room. A tail
     * that only rises is a pole; a tail that sweeps back and then hooks is a cat's.
     */
    /*
     * ══ THE CURL BENDS THE TAIL VERTICALLY, NOT FURTHER BACKWARD ══
     *
     * The curl was applied to X alone, so a hard-curl low-lift cat (`0xf00d`: curl 0.93, lift 0.14)
     * drew a straight horizontal bar that ran off the right edge and clipped — its flick frame moved
     * the tail ZERO cells because there was nowhere left to move to, and the whole animation axis was
     * dead on that cat.
     *
     * A cat's tail curls in the plane it is seen in: from the side, a curl lifts the tip UP or drops
     * it DOWN, it does not extend the tail further behind the animal. Splitting the curl into a
     * bounded X sweep plus a Y hook is both the honest shape and what keeps the tip inside the grid,
     * so the flick always has room.
     */
    const x = geom.lying
      ? rootX + 5.2 * t + geom.tailCurl * 1.6 * t * t
      : rootX + 3.2 * t + Math.abs(geom.tailCurl) * 1.2 * t * t;
    /*
     * ══ THE RISE IS BOUNDED, BECAUSE A VERTICAL TAIL IS A FLAGPOLE ══
     *
     * At −10.5 a fully lifted tail rose the whole height of the grid as a straight 1px column, and
     * rendered at 96px those cats had a MAST standing off the rump rather than a tail — the exact
     * failure the head-on version recorded for its own tail ("a straight stick pointing diagonally,
     * which is a dog's tail or an antenna").
     *
     * In profile there is less need for the lift to be extreme: the tail already reads as a tail
     * because it leaves the SPINE at the croup, which is a relationship the head-on version could
     * never draw and had to compensate for with height. −6.4 lifts a greeting tail clear above the
     * back line without it leaving the animal's own bounding box, and the curl then bends it — which
     * is what makes it read as a tail rather than as a pole.
     */
    const rise = geom.lying ? 1.2 : -6.4 * geom.tailLift + 3.0 * (1 - geom.tailLift);
    // The curl's own vertical hook, applied on `t*t*t` so it is purely a TIP event — the tail leaves
    // the croup straight and only the last third bends, which is what a cat's tail does and what
    // makes the curl read as a hook rather than as an arc.
    const hook = geom.lying ? 0 : -geom.tailCurl * 4.2 * t * t * t;
    const y = rootY + rise * t * t + hook + 0.5 * t;
    const pxi = Math.round(x - 0.5);
    const pyi = Math.round(y - 0.5);
    // The diagonal bridge — two diagonally adjacent cells are not orthogonally connected, and the
    // outline pass would draw its ring through the notch and cut the tail into pieces.
    if (last !== null && pxi !== last.x && pyi !== last.y) stamp(pxi, last.y, t);
    stamp(pxi, pyi, t);
    // 2px thick at the root, tapering to 1 at the tip: a real tail is thick where it leaves the body.
    if (t < 0.4) stamp(pxi, pyi + 1, t);
    if (pxi >= 0 && pxi < GRID_W && pyi >= 0 && pyi < GRID_H) last = { x: pxi, y: pyi };
  }
  return out;
}

/**
 * THE WHISKERS — forward off the muzzle, which is where they finally read.
 *
 * Head-on this feature broke the face FIVE times (a moustache bar, dust, the bar again, a
 * strikethrough, and the bar once more at 24px) because both whiskers were mirrored about the axis
 * and the eye integrated them into one rod through the skull.
 *
 * In profile that failure is structurally impossible: the whiskers sweep FORWARD from one side of
 * the muzzle, so there is no mirrored pair to fuse into a bar. This is the third defect the pose
 * change fixed for free rather than by tuning.
 */
function whiskerAt(cx: number, cy: number, geom: ProfileGeometry): ProfileHit | null {
  /*
   * ══ THE WHISKER MUST TOUCH THE MUZZLE — rule 1, and the first draft broke it ══
   *
   * The first profile draft started the whiskers 2.6 columns ahead of the muzzle's centre, which put
   * them clear of the muzzle's own rasterised edge — so they rendered as two floating bars beside
   * the face, which is NEEDLE's dust failure exactly. Rendered at 384x zoom they read as the cat
   * having been struck through.
   *
   * The start is now derived from the muzzle's own ellipse at this row, the same way the head-on
   * version eventually had to derive it from the skull: when two pieces of geometry must meet,
   * DERIVE one from the other. A whisker that begins where the muzzle ends is attached by
   * construction at every head size.
   */
  /*
   * The muzzle's anchor and radii are read from the SAME numbers `muzzleAt` uses. When the muzzle
   * was shrunk from a snout to a bump these were left at the old values, so the whiskers started
   * where the muzzle used to end and rendered as two bars floating clear of the face — NEEDLE's dust
   * failure, and the sixth time in this package that two pieces of geometry measuring one feature
   * two ways has broken the silhouette.
   *
   * They are constants in two places because a shared object would have to be threaded through both
   * predicates; `MUZZLE` below is that shared object, so the mismatch cannot recur.
   */
  const mx = geom.headX - geom.headR * MUZZLE.ax;
  const my = geom.headY + geom.headR * MUZZLE.ay;
  const dy = (cy + 0.5 - my) / MUZZLE.ry;
  if (Math.abs(dy) > 1) return null;
  // The muzzle's own half-width at this row, so the whisker starts flush against it.
  const reach = MUZZLE.rx * Math.sqrt(Math.max(0, 1 - dy * dy));
  const front = mx - reach;
  const dx = cx + 0.5 - front;
  // Forward only, and short: 1-2 columns. A whisker long enough to pass the body's own front edge
  // reads as a line drawn through the sprite rather than as a hair.
  if (dx > 0 || dx < -Math.min(geom.whiskerLen, 2)) return null;
  // ONE row, on the muzzle's own centre line, so there is no mirrored pair to fuse into a bar.
  if (Math.abs(cy + 0.5 - (my + 0.2)) > 0.7) return null;
  return { part: "whisker", nx: 0, ny: 0, step: 3 };
}

/**
 * Which part owns this cell, front to back.
 *
 * ══ ORDER IS THE DEPTH SORT ══
 *
 * openhood's warning transfers unchanged: "putting the mane before the head swallows the face;
 * putting the head before the eyes erases them." In profile the sort is a genuine depth order — the
 * near ear is in front of the skull, the skull is in front of the far ear, the body is in front of
 * the tail, and the near legs are in front of everything.
 */
export function profilePartAt(
  cx: number,
  cy: number,
  geom: ProfileGeometry,
  tail: Map<number, number>,
  frame: number,
  frames: number,
): ProfileHit | null {
  // The face resolves first, but only where the skull actually is.
  const head = headAt(cx, cy, geom);
  const muzzle = muzzleAt(cx, cy, geom);
  if (head || muzzle) {
    const eye = eyeAt(cx, cy, geom, frame, frames);
    if (eye) return eye;
    const nose = noseAt(cx, cy, geom);
    if (nose) return nose;
  }
  const ear = earAt(cx, cy, geom);
  if (ear) return ear;
  if (muzzle) return muzzle;
  if (head) return head;
  const body = bodyAt(cx, cy, geom);
  if (body) return body;
  const leg = legAt(cx, cy, geom);
  if (leg) return leg;
  const t = tail.get(cy * GRID_W + cx);
  if (t !== undefined) {
    return { part: "tail", nx: 0.25 + t * 0.5, ny: -0.2, t };
  }
  const whisker = whiskerAt(cx, cy, geom);
  if (whisker) return whisker;
  return null;
}

/** A stable 0..1 from an id and a salt, so this module can derive its own axes deterministically. */
export function profileUnit(id: string, salt: string): number {
  return fnv1a(`${id}:${salt}`) / 4294967296;
}
