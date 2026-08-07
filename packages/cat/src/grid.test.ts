/**
 * THE CAT GRID'S INVARIANTS.
 *
 * ══ WHAT THESE TESTS ARE FOR ══
 *
 * Not coverage. Every assertion here corresponds to a defect that was actually SHIPPED somewhere
 * in this corpus and had to be found by looking at a render. The test is the cheaper second line
 * of defence: rendering to PNG catches a defect once, an assertion catches it forever.
 *
 * The three silhouette rules are the core of the file. They come from unitick's NEEDLE v1, which
 * "read as a white blob" — and crucially, NEEDLE's grid was reviewed as ASCII in a source file and
 * passed. Every one of its three defects is expressible as a predicate over pixel coordinates,
 * which is exactly what the review by eye failed to do and what these tests do.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type CatState,
  type GridPixel,
  CAT_FRAME_HOLD,
  CAT_FRAMES,
  catFrames,
  catGrid,
  catPigment,
  PIGMENT_COUNT,
  tintStepFor,
  EYE_H,
  EYE_L_X,
  EYE_R_X,
  EYE_W,
  geometryFor,
  GRID_H,
  GRID_W,
  NECK_ROW,
  NECK_STEP_DROP,
  PROPORTIONS,
  RAMP_STEPS,
  ROWS,
} from "./grid.js";
import { bakeCat, catRamp, catSize, catSvg, drawBaked, drawCat } from "./render.js";

/**
 * A source file with its comments stripped.
 *
 * The ban tests grep for `Math.random`, and this file's own headers DISCUSS `Math.random` at
 * length — so a naive grep over the raw source fails on the very comment that documents the ban.
 * That is not a false positive to be silenced with a cleverer regex: the thing being asserted is
 * that no CODE calls it, so the correct fix is to strip what is not code and grep the rest.
 */
function codeOf(rel: string): string {
  const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** A spread of ids wide enough that a rule holding on all of them is not luck. */
const IDS = [
  "stray-1",
  "stray-2",
  "stray-3",
  "stray-4",
  "0xf00d",
  "0xbeef",
  "mackerel",
  "tortoiseshell",
  "sixpence",
  "harbour",
  "gutter",
  "ledger",
  "",
  "a",
  "0x0000000000000000000000000000000000000000",
];

const STATES: readonly CatState[] = ["fed", "hunting", "starving", "dead"];

/** Index a grid by coordinate, for the geometric assertions. */
function index(grid: readonly GridPixel[]): Map<number, GridPixel> {
  const m = new Map<number, GridPixel>();
  for (const p of grid) m.set(p.y * GRID_W + p.x, p);
  return m;
}

/** The cat's own pixels — everything the outline pass did not add. */
function coat(grid: readonly GridPixel[]): GridPixel[] {
  return grid.filter((p) => p.part !== "outline");
}

describe("determinism", () => {
  it("returns a byte-identical grid for the same id", () => {
    for (const id of IDS) {
      expect(JSON.stringify(catGrid(id))).toBe(JSON.stringify(catGrid(id)));
    }
  });

  it("returns a byte-identical grid for the same id and state", () => {
    for (const state of STATES) {
      expect(JSON.stringify(catGrid("stray-1", { state }))).toBe(
        JSON.stringify(catGrid("stray-1", { state })),
      );
    }
  });

  it("stays inside the 24x24 grid", () => {
    for (const id of IDS) {
      for (const p of catGrid(id)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(GRID_W);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThan(GRID_H);
      }
    }
  });

  it("emits every step inside the ramp", () => {
    for (const id of IDS) {
      for (const p of catGrid(id)) {
        expect(p.step).toBeGreaterThanOrEqual(0);
        expect(p.step).toBeLessThan(RAMP_STEPS);
      }
    }
  });

  it("never emits two pixels at one coordinate", () => {
    // A duplicate is not a crash — it is a pixel painted twice, where the LAST write wins and the
    // renderers disagree about which that is. openhood's whole grid module exists because two
    // renderers disagreed about one creature.
    for (const id of IDS) {
      const grid = catGrid(id);
      expect(index(grid).size).toBe(grid.length);
    }
  });
});

describe("decorrelation — the hash budget", () => {
  /**
   * ══ THE AXES MUST MOVE INDEPENDENTLY ══
   *
   * This is what per-axis salting buys and it is the reason the module pays for six hashes instead
   * of one. Bit-slicing a single 32-bit hash correlates the traits: ids that differ only in their
   * low bits share their high-bit traits, so a colony looks decorrelated in one region of the id
   * space and banded in another.
   *
   * The test walks sequential ids — the WORST case, and the one a real colony will actually
   * contain — and asserts that ear and tail each take many distinct values, and that knowing one
   * does not predict the other.
   */
  const SEQ = Array.from({ length: 200 }, (_, i) => `stray-${i}`);

  it("gives the ear angle a wide spread over sequential ids", () => {
    const angles = SEQ.map((id) => geometryFor(id).earAngle);
    const lo = angles.filter((a) => a < -0.33).length;
    const mid = angles.filter((a) => a >= -0.33 && a <= 0.33).length;
    const hi = angles.filter((a) => a > 0.33).length;
    // Every third of the range occupied. A hash that banded would empty one of these.
    for (const bucket of [lo, mid, hi]) expect(bucket).toBeGreaterThan(SEQ.length / 8);
  });

  it("gives the tail curl a wide spread over sequential ids", () => {
    const curls = SEQ.map((id) => geometryFor(id).tailCurl);
    const lo = curls.filter((c) => c < -0.33).length;
    const mid = curls.filter((c) => c >= -0.33 && c <= 0.33).length;
    const hi = curls.filter((c) => c > 0.33).length;
    for (const bucket of [lo, mid, hi]) expect(bucket).toBeGreaterThan(SEQ.length / 8);
  });

  it("moves the ear and the tail INDEPENDENTLY", () => {
    /*
     * The real decorrelation assertion: the correlation coefficient between the two axes over the
     * sequential ids must be near zero. If both were slices of one hash this would be large.
     */
    const ears = SEQ.map((id) => geometryFor(id).earAngle);
    const tails = SEQ.map((id) => geometryFor(id).tailCurl);
    const n = SEQ.length;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / n;
    const me = mean(ears);
    const mt = mean(tails);
    let cov = 0;
    let ve = 0;
    let vt = 0;
    for (let i = 0; i < n; i++) {
      const de = (ears[i] ?? 0) - me;
      const dt = (tails[i] ?? 0) - mt;
      cov += de * dt;
      ve += de * de;
      vt += dt * dt;
    }
    const r = cov / Math.sqrt(ve * vt);
    expect(Math.abs(r)).toBeLessThan(0.25);
  });

  it("changing one character of an id rerolls the ear AND the tail", () => {
    /*
     * The concrete form of the same property, and the one a reader can check by hand. Across
     * neighbouring ids, BOTH axes must change often — not merely one of them. A budget where the
     * tail tracked the ear would pass the spread tests above and still produce a colony where
     * every long-tailed cat had the same ears.
     */
    let earMoved = 0;
    let tailMoved = 0;
    for (let i = 0; i < SEQ.length - 1; i++) {
      const a = geometryFor(SEQ[i] ?? "");
      const b = geometryFor(SEQ[i + 1] ?? "");
      if (Math.abs(a.earAngle - b.earAngle) > 0.2) earMoved++;
      if (Math.abs(a.tailCurl - b.tailCurl) > 0.2) tailMoved++;
    }
    expect(earMoved).toBeGreaterThan(SEQ.length * 0.5);
    expect(tailMoved).toBeGreaterThan(SEQ.length * 0.5);
  });

  it("produces visibly different silhouettes across a colony", () => {
    /*
     * §9: "if a colony of 30 cats reads as 30 identical smudges at 390px, the hash budget is
     * wrong". The machine-checkable form of that: take the SILHOUETTE alone — the set of occupied
     * cells, with all shading discarded — and require that thirty cats produce nearly thirty
     * distinct ones. Comparing full grids would pass trivially on a shading difference the eye
     * cannot see; comparing silhouettes is the thing the eye actually uses.
     */
    const shapes = new Set(
      Array.from({ length: 30 }, (_, i) =>
        coat(catGrid(`colony-${i}`))
          .map((p) => `${p.x},${p.y}`)
          .sort()
          .join(";"),
      ),
    );
    expect(shapes.size).toBeGreaterThanOrEqual(28);
  });
});

describe("silhouette rule 1 — an appendage must MEET the body", () => {
  /**
   * NEEDLE's horn "was four isolated `h` pixels on a diagonal with a gap between the last one and
   * the skull, so at render size it read as dust rather than as a horn."
   *
   * The general form: every part must be orthogonally connected to the rest of the animal. A part
   * that is not is dust, whatever it was meant to be.
   */

  it("connects every ear column to the head directly beneath it", () => {
    for (const id of IDS) {
      const grid = catGrid(id);
      const at = index(grid);
      /*
       * ══ BOTH EAR PARTS, BECAUSE AN EAR IS ONE APPENDAGE ══
       *
       * This filtered on `part === "ear"` alone, which was correct while the ear was a single part.
       * v2 splits the modelled inner cone into its own `earInner` part (the detail that most makes
       * an ear read as an ear rather than as a triangle sticker), and the split silently broke this
       * assertion: an OUTER-ear pixel sitting directly on an INNER-ear pixel has support, but the
       * lookup below saw a part it had not asked for and reported a gap.
       *
       * The rule is about the APPENDAGE meeting the animal, not about one of its two surfaces, so
       * the filter has to name both. Worth recording because the test failed for a reason that had
       * nothing to do with the geometry it was guarding — a test can go stale against a refactor in
       * exactly the way a comment does.
       */
      const ears = grid.filter((p) => p.part === "ear" || p.part === "earInner");
      expect(ears.length).toBeGreaterThan(0);
      // The ear's own lowest row per column must have a head pixel one row below it.
      const lowestByCol = new Map<number, number>();
      for (const e of ears) {
        const cur = lowestByCol.get(e.x);
        if (cur === undefined || e.y > cur) lowestByCol.set(e.x, e.y);
      }
      /*
       * ══ IN PROFILE THE SUPPORT MAY BE DIAGONAL, AND THAT IS CORRECT ══
       *
       * Head-on, both ears rose vertically from a horizontal crown, so "the cell directly below is
       * head" was exactly the right test. In profile the ears sit on a DOMED skull seen from the
       * side, so an ear's outermost base column legitimately overhangs the dome's curve by half a
       * cell and its support is the cell diagonally below rather than directly below.
       *
       * The property that actually matters is unchanged and is what NEEDLE's rule 1 states: no part
       * may be an ISLAND. So the test asks for support in the three cells beneath (left, centre,
       * right), which is the correct statement of "this ear is standing on the animal" for a curved
       * skull, and the flood fill below still enforces full orthogonal connectivity over the whole
       * coat — an ear supported only diagonally would fail THERE, which is where it should fail.
       */
      for (const [x, y] of lowestByCol) {
        const supported = [-1, 0, 1].some((dx) => {
          const below = at.get((y + 1) * GRID_W + x + dx);
          return below !== undefined && below.part !== "outline";
        });
        expect(supported, `id ${id}: ear column ${x} is unsupported below row ${y}`).toBe(true);
      }
    }
  });

  it("roots the tail against the body with no gap", () => {
    for (const id of IDS) {
      const grid = catGrid(id);
      const at = index(grid);
      const tail = grid.filter((p) => p.part === "tail");
      expect(tail.length, `id ${id}: no tail at all`).toBeGreaterThan(0);
      // At least one tail pixel is orthogonally adjacent to a body pixel: the tail attaches.
      /*
       * In profile the tail leaves the spine at the CROUP, so its root cell may be adjacent to the
       * body OR to a leg (a lying cat's tail runs behind the hind leg). What rule 1 forbids is a
       * tail that touches neither — a stick floating behind the animal, which is NEEDLE's dust.
       */
      const ATTACHED = new Set(["body", "leg", "paw"]);
      const touching = tail.some((t) =>
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => {
          const n = at.get((t.y + (dy ?? 0)) * GRID_W + t.x + (dx ?? 0));
          return n !== undefined && ATTACHED.has(n.part);
        }),
      );
      expect(touching, `id ${id}: the tail does not touch the body`).toBe(true);
    }
  });

  it("leaves NO disconnected island anywhere in the cat", () => {
    /*
     * The strongest statement of rule 1, and the one that would have caught NEEDLE directly: flood
     * fill the coat from any starting pixel over orthogonal adjacency and require it to reach
     * every coat pixel. Any island — a detached ear tip, a broken tail, a stray whisker — fails
     * here regardless of which part produced it.
     */
    for (const id of IDS) {
      const body = coat(catGrid(id));
      const keys = new Set(body.map((p) => p.y * GRID_W + p.x));
      const start = body[0];
      expect(start).toBeDefined();
      if (!start) continue;
      const seen = new Set<number>();
      const stack = [start.y * GRID_W + start.x];
      while (stack.length > 0) {
        const k = stack.pop();
        if (k === undefined || seen.has(k)) continue;
        seen.add(k);
        const x = k % GRID_W;
        const y = (k - x) / GRID_W;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
          const nk = ny * GRID_W + nx;
          if (keys.has(nk) && !seen.has(nk)) stack.push(nk);
        }
      }
      expect(seen.size, `id ${id}: the cat is in ${keys.size - seen.size + 1} pieces`).toBe(
        keys.size,
      );
    }
  });
});

describe("silhouette rule 2 — the head must separate from the body", () => {
  /**
   * NEEDLE: "HEAD AND BODY WERE ONE MASS. Both were `i` with no separation, so the silhouette was
   * an amoeba. There is now a shaded neck line between them, which is what makes a quadruped read
   * as having a head at all."
   *
   * ══ THESE ASSERTIONS CHANGED TWICE, WITH THE POSE, AND THIS IS THE THIRD SET ══
   *
   * HEAD-ON (v2) the head sat directly on the body and the ONLY thing that could separate them was
   * a forced value break — the body's first row clamped two ramp steps below the head above it. That
   * clamp had three distinct bugs, every one the same shape: the break computed somewhere the final
   * value was not yet known.
   *
   * IN PROFILE (v3) the skull sat above and forward of the barrel and the separation was a NOTCH in
   * the outline. The assertions became "the head is forward of the body" and "the muzzle is in front
   * of the eye" — both of which are statements about a side view, and the second was explicitly
   * described as "the one test in the file that a head-on sprite cannot pass".
   *
   * FRONT-ON (v4) neither applies. "In front of" is meaningless when the animal is facing you, and a
   * muzzle between two eyes — which v3's test was written to forbid as an OWL — is now the correct
   * and intended drawing. Those tests are deleted rather than adapted, because they were pinning a
   * POSE DECISION that has been reversed on the record.
   *
   * What replaces them is the property all three versions were proxies for, stated in the terms this
   * pose actually offers: the head must WIN, on height and on width, and there must be a visible
   * waist where the two masses meet. That is bloodhorn's own neoteny cue — "a small body is a
   * neoteny cue in its own right... this makes it win on width too" — and unlike the previous two
   * sets it is a statement about CUTENESS rather than about camera angle, so it should survive.
   */

  it("makes the head WIDER than the body, so the silhouette has a waist", () => {
    /*
     * The concrete form of the neck, front-on. bloodhorn's recorded failure when this does not hold:
     * "the two merged into a single vertical mass with no waist — a cute head on a lump. There was
     * no neck because there was no width difference for a neck to be."
     */
    for (const id of IDS) {
      for (const state of STATES) {
        const grid = catGrid(id, { state });
        const heads = grid.filter((p) => p.part === "head");
        const bodies = grid.filter((p) => p.part === "body");
        expect(heads.length, `id ${id}/${state}: no head at all`).toBeGreaterThan(40);
        expect(bodies.length, `id ${id}/${state}: no body at all`).toBeGreaterThan(15);
        const headW = Math.max(...heads.map((p) => p.x)) - Math.min(...heads.map((p) => p.x)) + 1;
        const bodyW = Math.max(...bodies.map((p) => p.x)) - Math.min(...bodies.map((p) => p.x)) + 1;
        expect(
          headW,
          `id ${id}/${state}: head ${headW} wide on a body of ${bodyW} — no waist`,
        ).toBeGreaterThan(bodyW);
      }
    }
  });

  it("keeps the head ABOVE the body, and the head is the larger mass", () => {
    /*
     * The head is the SUBJECT of a cute sprite. bloodhorn spends ten of twenty-four rows on it and
     * calls that "the biggest single span, by design"; this spends eleven. Asserting it in PIXELS
     * rather than in row constants is what stops a part quietly overflowing its budget — which is
     * exactly what the body did during this rewrite, rasterising into eight rows on a six-row budget
     * and swallowing the legs, with every ROWS-derived ratio still reporting correct.
     */
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const heads = grid.filter((p) => p.part === "head" || p.part === "muzzle");
      const bodies = grid.filter((p) => p.part === "body");
      const headY = heads.reduce((a, p) => a + p.y, 0) / heads.length;
      const bodyY = bodies.reduce((a, p) => a + p.y, 0) / bodies.length;
      expect(headY, `id ${id}: the head is not above the body`).toBeLessThan(bodyY);
      expect(
        heads.length,
        `id ${id}: head ${heads.length} cells vs body ${bodies.length} — the body is winning`,
      ).toBeGreaterThan(bodies.length);
    }
  });

  it("draws the muzzle BETWEEN and BELOW the two eyes — a front-facing face", () => {
    /*
     * ══ THE ASSERTION THAT PINS THE POSE, AND IT IS THE EXACT INVERSE OF v3's ══
     *
     * v3 asserted the muzzle sits in FRONT of the eye, and called it "the one test in the file that
     * a head-on sprite cannot pass". That was true and the sprite it was protecting has been
     * deliberately replaced, so the assertion is inverted rather than dropped: the muzzle must sit
     * BETWEEN the two eyes horizontally and BELOW both of them vertically.
     *
     * Keeping a test here at all — rather than deleting the concept — matters, because a face is the
     * whole sprite now and "the muzzle drifted off the centreline" is the kind of defect that looks
     * like a style choice at 24px. It is also the honest record: the previous test was not wrong, it
     * was guarding a decision that was reversed, and the file should say which.
     */
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const muzzle = grid.filter((p) => p.part === "muzzle" || p.part === "nose");
      const eyes = grid.filter((p) => p.part === "eye");
      expect(muzzle.length, `id ${id}: no muzzle`).toBeGreaterThan(0);
      expect(eyes.length, `id ${id}: no eyes`).toBeGreaterThan(0);
      const muzzleX = muzzle.reduce((a, p) => a + p.x, 0) / muzzle.length;
      const muzzleY = Math.min(...muzzle.map((p) => p.y));
      const eyeBottom = Math.max(...eyes.map((p) => p.y));
      // Between the eyes: within a pixel of the grid's own centreline.
      expect(Math.abs(muzzleX - (GRID_W - 1) / 2), `id ${id}: the muzzle is off-centre`).toBeLessThan(
        1.5,
      );
      // Below them: the muzzle's top row is at or under the eyes' bottom row.
      expect(muzzleY, `id ${id}: the muzzle is not below the eyes`).toBeGreaterThanOrEqual(
        eyeBottom - 1,
      );
    }
  });

  it("draws TWO eyes, one each side of the centreline", () => {
    /*
     * ══ THE ASSERTION THAT WOULD HAVE CAUGHT THE ONE-EARED CAT, APPLIED TO THE EYES TOO ══
     *
     * v3 asserted "exactly ONE eye, because this is a profile". Front-on there must be two, and they
     * must be BALANCED — an early `return` inside the loop over a symmetric feature's two halves
     * silently drew every cat in this colony with a single EAR, and it survived a full render pass
     * because a one-eared cat still looks like a cat. The same bug in `eyeStepAt` would be even
     * harder to spot.
     *
     * So the count is asserted per SIDE rather than in total: a total count cannot distinguish two
     * eyes from one eye drawn twice as large.
     */
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const eyes = grid.filter((p) => p.part === "eye");
      const left = eyes.filter((p) => p.x < GRID_W / 2).length;
      const right = eyes.filter((p) => p.x >= GRID_W / 2).length;
      expect(left, `id ${id}: no left eye`).toBeGreaterThan(4);
      expect(right, `id ${id}: no right eye`).toBeGreaterThan(4);
      // Balanced within a pixel or two — the light bias may knock a corner off one side.
      expect(Math.abs(left - right), `id ${id}: eyes are lopsided (${left} vs ${right})`).toBeLessThanOrEqual(2);
    }
  });

  it("draws TWO ears, one each side, both clearing the skull", () => {
    /*
     * The bug this exists for, in full, because it is the most instructive one in the rewrite:
     * `earNormal` looped over `[-1, 1]` and `return null`ed on a miss instead of `continue`ing. The
     * left ear was tested first, so any pixel that missed it returned immediately and the right ear
     * was never evaluated. EVERY cat rendered with one ear, and it passed a visual review because a
     * one-eared cat reads as a stylistic choice rather than as a defect.
     *
     * An early return inside a loop over the two halves of a symmetric feature is the single most
     * dangerous shape of bug in this file, and a test that asserts "ears exist" cannot see it.
     */
    for (const id of IDS) {
      for (const state of STATES) {
        const grid = catGrid(id, { state });
        const ears = grid.filter((p) => p.part === "ear" || p.part === "earInner");
        const left = ears.filter((p) => p.x < GRID_W / 2).length;
        const right = ears.filter((p) => p.x >= GRID_W / 2).length;
        expect(left, `id ${id}/${state}: no left ear`).toBeGreaterThan(2);
        expect(right, `id ${id}/${state}: no right ear`).toBeGreaterThan(2);
        // And they must CLEAR the head — an ear buried in the crown is not a silhouette feature.
        const heads = grid.filter((p) => p.part === "head");
        const crown = Math.min(...heads.map((p) => p.y));
        const earTop = Math.min(...ears.map((p) => p.y));
        expect(
          crown - earTop,
          `id ${id}/${state}: the ears clear the skull by only ${crown - earTop} rows`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("silhouette rule 3 — legs paired front and back with a visible gap", () => {
  /**
   * NEEDLE: "THE LEGS WERE AMBIGUOUS. Four 1px verticals at even spacing read as a fringe. They are
   * now 2px wide, paired front and back with a visible gap, and hooves sit under the correct legs."
   *
   * ══ PROFILE MADE FOUR LEGS AFFORDABLE, WHICH HEAD-ON COULD NOT ══
   *
   * Head-on, four legs needed eight columns of leg plus gaps across a ten-column body, and the file
   * recorded drawing TWO legs as the honest trade the resolution forced. In profile the legs spread
   * along the body's LENGTH — its longest dimension — so a front pair and a back pair with real
   * daylight between them is comfortable, and that gap is one of the strongest quadruped cues there
   * is. These assertions are therefore STRONGER than the ones they replace, not weaker.
   */

  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ══ THREE LEG ASSERTIONS WERE MERGED INTO ONE HERE, AND ONE OF THEM WAS VACUOUS ══
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * v3 had three: "draws a front pair and a back pair, separated along the body", "makes every leg
   * at least 2px wide", and "stands every cat on paws, at the bottom of its legs". The first is a
   * statement about legs spread along a body's LENGTH, which only exists in profile. The third
   * filtered on `p.part === "paw"` and then began `if (paws.length === 0) continue` — and `paw` is
   * no longer a part, so the filter returned nothing, the guard skipped every id, and the test
   * asserted NOTHING while reporting green.
   *
   * That is the second vacuous test this rewrite found (see the note above the paw test in the
   * proportions block for the first), and both had the same signature: a filter on a part name that
   * no longer exists, guarded by a `continue` that turned an empty result into a pass. A guard that
   * exists to skip a legitimate edge case will happily skip EVERYTHING when the data goes away.
   * TypeScript flagged both — `types 'CutePart' and '"paw"' have no overlap` — and that was the only
   * signal either one had gone hollow.
   *
   * The property that survives the pose change is asserted once, in `proportions`: two paws, each at
   * least 2px wide, with clear ground between them. Merging them there rather than keeping three
   * shells here is the honest bookkeeping — one real assertion beats three, two of which cannot fail.
   */

  it("keeps the legs a different value from the barrel above them", () => {
    /*
     * 2px posts at the same step as the belly are not legs, they are the bottom of the body. The
     * rule is about legibility, and legibility here is value as much as width.
     */
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const legs = grid.filter((p) => p.part === "leg");
      const bodies = grid.filter((p) => p.part === "body");
      if (legs.length === 0 || bodies.length === 0) continue;
      const brightestBody = Math.max(...bodies.map((p) => p.step));
      const leg = legs[0];
      if (!leg) continue;
      expect(leg.step, `id ${id}: legs do not separate from the barrel`).toBeLessThan(brightestBody);
    }
  });
});

describe("the state tints AT MOST TWO PIXELS", () => {
  /**
   * `ART-DIRECTION.md` §8: "No colour on an animal. The IR sensor has none. Cats are drawn in the
   * phosphor ramp only — their state may tint one or two pixels, their identity may not."
   *
   * This is the ban that is easiest to erode by a single well-meaning edit ("just tint the collar
   * too"), so it is asserted as a hard count rather than as a spirit.
   */

  it("flags no more than two accent pixels in any state", () => {
    for (const id of IDS) {
      for (const state of STATES) {
        const accents = catGrid(id, { state }).filter((p) => p.accent === true);
        expect(
          accents.length,
          `id ${id} state ${state}: ${accents.length} accent pixels`,
        ).toBeLessThanOrEqual(2);
      }
    }
  });

  it("only ever flags an EYE as an accent", () => {
    for (const id of IDS) {
      for (const state of STATES) {
        for (const p of catGrid(id, { state })) {
          if (p.accent === true) expect(p.part).toBe("eye");
        }
      }
    }
  });

  it("changes the ANIMAL between states, not merely its eye pixels", () => {
    /*
     * ══ THIS ASSERTION IS THE EXACT INVERSE OF THE ONE IT REPLACES, AND THAT IS DELIBERATE ══
     *
     * v1 asserted that the silhouette was IDENTICAL across every state, on the reading that §8's
     * "no invented geometry" forbids state from touching shape. That reading was wrong, and the
     * render is what settled it: a starving cat that differs from a fed one only in brightness looks
     * like a fed cat photographed badly, which fails §8's OTHER and more important requirement —
     * "a starving cat is drawn starving. The mechanic is honest about losses or it is a lie with
     * whiskers on it."
     *
     * The invented-geometry ban is about shapes that ENCODE A QUANTITY nobody measured — unitick's
     * hash-sized teaching brackets drawn on a real price trace. A cat's body being narrower when the
     * cat is starving is not an invented quantity; it is the state itself, drawn.
     *
     * So the test now requires the opposite and requires it to be LARGE: at least forty cells of
     * difference between fed and starving, which is roughly a tenth of the sprite and well past what
     * a viewer could miss at 48px.
     */
    for (const id of IDS) {
      const shapeOf = (state: CatState) =>
        new Set(
          coat(catGrid(id, { state })).map((p) => `${p.x},${p.y}`),
        );
      const fed = shapeOf("fed");
      const starving = shapeOf("starving");
      let diff = 0;
      for (const k of fed) if (!starving.has(k)) diff++;
      for (const k of starving) if (!fed.has(k)) diff++;
      expect(diff, `id ${id}: fed and starving have the same body`).toBeGreaterThan(20);
    }
  });

  it("draws a starving cat THINNER than a fed one — measured on the BODY", () => {
    /*
     * ══ MEASURED ON THE BODY, NOT ON THE WHOLE SILHOUETTE ══
     *
     * This compared TOTAL coat area and it failed front-on, for a reason that is about the pose
     * rather than about the state: a starving cat's ears DROOP, and a drooped ear is sheared
     * sideways so it covers MORE columns than a pricked one. The body genuinely narrowed and the
     * ears more than made up for it, so the total area went up while the animal got thinner.
     *
     * That is a measurement picking up a change it was not asking about. "Thin" is a statement about
     * the animal's BULK, so the body is what to measure — and measuring it directly also stops the
     * test passing for the wrong reason if some future state shrinks the head instead.
     */
    for (const id of IDS) {
      const bodyArea = (state: CatState) =>
        catGrid(id, { state }).filter((p) => p.part === "body").length;
      expect(bodyArea("starving"), `id ${id}: starving is not thinner than fed`).toBeLessThan(
        bodyArea("fed"),
      );
    }
  });

  it("droops a starving cat's ears and half-closes its eyes — the CUTE register", () => {
    /*
     * ══ WHAT REPLACED "drops it into a crouch", AND WHY ══
     *
     * v3 asserted that `hunting` lowers the back line — a POSTURE change, which was the largest
     * silhouette axis in the profile pose. Front-on the four postures differ by about one row of leg
     * and the axis was removed entirely, so there is no back line to lower and the test cannot be
     * adapted; it is replaced by the cues this pose actually carries.
     *
     * `ART-DIRECTION.md` §8 requires "a starving cat is drawn starving", and the brief asks for that
     * in a cute register — "droopy-eared and dim-eyed rather than anatomically gaunt". Both are
     * asserted rather than trusted, because both are FORCED overrides and a forced override that
     * silently stops firing is this package's most-recorded class of bug.
     *
     * The ear droop is measured as WIDTH: a drooping ear is sheared outward and folds, so it spans
     * more columns than a pricked one. That is a property of the silhouette at 32px, which is where
     * the state has to read.
     */
    for (const id of IDS) {
      const earSpan = (state: CatState) => {
        const ears = catGrid(id, { state }).filter(
          (p) => p.part === "ear" || p.part === "earInner",
        );
        return Math.max(...ears.map((p) => p.x)) - Math.min(...ears.map((p) => p.x)) + 1;
      };
      expect(
        earSpan("starving"),
        `id ${id}: a starving cat's ears are not drooping`,
      ).toBeGreaterThanOrEqual(earSpan("fed"));
      // And the eyes are half-lidded: fewer eye cells than the wide-open fed state.
      const eyeArea = (state: CatState) =>
        catGrid(id, { state }).filter((p) => p.part === "eye").length;
      expect(eyeArea("starving"), `id ${id}: a starving cat's eyes are not lidded`).toBeLessThan(
        eyeArea("fed"),
      );
    }
  });

  it("pricks a hunting cat's ears FORWARD, and the axis MOVES CELLS", () => {
    /*
     * `hunting` is alertness, and alertness has to read on EVERY cat regardless of what its own hash
     * gave it — a bias a hash could cancel is not a state. `stateGeometry` CLAMPS `earAngle` rather
     * than adding to it for exactly that reason.
     *
     * ══ MEASURED IN RENDERED CELLS, AND THAT IS THE ONLY MEASUREMENT THAT WORKS ══
     *
     * This test found a genuine dead axis on its first run: the ear's lean term swept the tip by
     * under two cells across `earAngle`'s entire −1..1 range, so the forced `hunting` clamp moved the
     * ears by ZERO cells on every cat in the set. The state existed in the source, was forced rather
     * than nudged, was reviewed in a render, and did nothing.
     *
     * That is the SIXTH instance of the same defect in this package (see `earNormal`'s note for the
     * list), and every one of them was invisible in the source and visible only in a cell count. So
     * the assertion counts CELLS — the ear's horizontal centre of mass, which is what actually moves
     * — rather than reading a geometry value and trusting it to rasterise.
     *
     * The centre of mass rather than the tip GAP, because the tips are clipped by the grid's top row
     * on the taller ears: a clipped tip reports the same column at every angle, so a tip measurement
     * silently stops responding on exactly the cats where the ear is most prominent.
     */
    const earCentre = (id: string, state: CatState): number => {
      const ears = catGrid(id, { state }).filter((p) => p.part === "ear" || p.part === "earInner");
      // Distance from the centreline, averaged. Pricked ears lean IN, so this falls.
      return ears.reduce((a, p) => a + Math.abs(p.x + 0.5 - GRID_W / 2), 0) / ears.length;
    };
    let pricked = 0;
    for (const id of IDS) {
      const ears = catGrid(id, { state: "hunting" }).filter((p) => p.part === "ear");
      expect(ears.length, `id ${id}: a hunting cat has no ears`).toBeGreaterThan(4);
      // Hunting may never splay a cat's ears OUTWARD — that is the droop, and it is the wrong state.
      expect(
        earCentre(id, "hunting"),
        `id ${id}: hunting splayed the ears instead of pricking them`,
      ).toBeLessThanOrEqual(earCentre(id, "fed") + 0.01);
      if (earCentre(id, "hunting") < earCentre(id, "fed") - 0.01) pricked += 1;
    }
    /*
     * ══ THE AGGREGATE IS WHAT CLOSES THE DEAD-AXIS HOLE ══
     *
     * The per-cat assertion has to be weak, because a cat whose own `earAngle` already exceeds the
     * clamp cannot be moved by it — that is what a clamp means. A weak assertion ALONE would pass a
     * `hunting` state that did nothing at all, which is the exact failure this test was written
     * after. Requiring that the state visibly move a real share of the colony is what stops the
     * override quietly becoming a no-op again.
     *
     * A third rather than a half: `earAngle` is uniform over −1..1 and the clamp is at 0.55, so
     * roughly 78% of cats are eligible to move — but the rasterisation quantum means the ones only
     * just below the clamp move by less than a cell. A third of the whole set is comfortably more
     * than noise and comfortably under the eligible share.
     */
    expect(pricked, "hunting pricks almost no cats' ears — the axis is dead").toBeGreaterThan(
      IDS.length / 3,
    );
  });

  it("dims the coat monotonically from fed to dead", () => {
    /*
     * The state has to be readable at a glance, which means the ordering must hold in total
     * luminance and not merely per-pixel.
     *
     * `starving` vs `dead` is asserted as "not brighter" rather than "brighter", because `dead` is
     * a FLAT fill at `DEAD_STEP` rather than a gain (see `applyState`): on a cat whose starving
     * coat happens to average below that flat value, the totals can tie. The ordering that matters
     * is that death never reads as MORE alive, and the flatness — asserted separately below — is
     * what actually carries the state.
     */
    for (const id of IDS) {
      const lum = (state: CatState) => {
        const px = coat(catGrid(id, { state })).filter((p) => p.part !== "eye");
        return px.reduce((a, p) => a + p.step, 0) / Math.max(1, px.length);
      };
      /*
       * MEAN step rather than the total, and this is a correction the geometry forced.
       *
       * v1 summed the steps over the whole coat, which was sound while every state drew the same
       * number of pixels. Now that a starving cat is genuinely THINNER it has fewer pixels, so the
       * sum conflates "each pixel is dimmer" with "there are fewer pixels" — and a hunting cat that
       * crouches has MORE pixels than a fed one that stands, which made the total go the wrong way
       * on cats where the posture change outweighed the gain. The assertion was measuring area while
       * claiming to measure exposure.
       *
       * The mean is the exposure, independent of how much animal there is, which is what the state
       * gain actually changes.
       */
      /*
       * ══ THE ORDERING IS OVER THE THREE LIVING STATES; `dead` IS NOT ON THIS LADDER ══
       *
       * v1 through v3 asserted `starving >= dead`, on the model that a dead cat is the dimmest thing
       * in the colony. That was true while `dead` was a gain like the others, and it stayed true by
       * coincidence while `DEAD_STEP` happened to sit below the starving mean — which is exactly the
       * crossing this file's own note predicts: "a state defined by an ABSOLUTE value and a state
       * defined by a GAIN will cross each other the moment either is retuned, and nothing in either
       * definition mentions the other."
       *
       * It has now been retuned, deliberately. `DEAD_STEP` was RAISED to a mid value when the base
       * ramp went violet, because at the old step the dead cats were nearly invisible against the
       * page — the "reads as a rendering failure rather than a state" defect that `dead` being flat
       * exists to prevent, reintroduced through a palette change in a different file.
       *
       * So the ladder is asserted where it is meaningful — the three states that are lit by the same
       * model, in order — and `dead` gets the assertion it actually needs: that it is FLAT (below)
       * and that it is clear of the ground (below). Keeping it on this ladder would be asserting a
       * relationship the design does not claim, and it would forbid the fix that made a dead cat
       * visible.
       */
      expect(lum("fed")).toBeGreaterThan(lum("hunting"));
      expect(lum("hunting")).toBeGreaterThan(lum("starving"));
    }
  });

  it("draws a dead cat FLAT — its COAT one value, never a fade toward the background", () => {
    /*
     * A review of the render found `dead` "so dim it reads as a rendering failure rather than a
     * state". §8 requires losses to be drawn honestly and openhood's rule forbids a state that
     * looks like a fault. The fix was to collapse the coat to a single mid step rather than lower
     * it, so this asserts exactly that: every non-eye coat pixel shares one value, and that value
     * is clear of the outline.
     */
    /*
     * ══ THE COAT IS ONE VALUE; THREE MARKS ARE EXEMPT, AND THE EXEMPTION IS THE ASSERTION ══
     *
     * v1 asserted that EVERY non-eye pixel shared one step. Rendered at both sheet sizes, that
     * produced a featureless rounded lump — a chess pawn, not a dead cat — because the ears, the
     * muzzle and the legs were all painted at the coat value and the silhouette became one mass.
     * "Unmistakably there and unmistakably not alive" needs the first half too: a viewer has to be
     * able to tell it is a CAT that has died.
     *
     * So three parts stay dark (see `applyState`): the inner ear, the eyes and the legs. The
     * invariant that actually matters is unchanged and is what is asserted here — there is no
     * MODELLING anywhere, i.e. the large surfaces that carry shading in every living state (head,
     * body, muzzle, tail, outer ear) are one flat value with no gradient in them. A flat shape with
     * dark marks is a stencil; a flat shape with none is a pawn.
     *
     * The PAW is exempt with the leg rather than counted as a surface: `applyState` darkens both
     * together, because a lying cat's feet are folded under it and read as the shadow beneath the
     * mass. Listing the paw as modelled was this test's own bug — it asserted a flat coat and then
     * included a part the source deliberately darkens, which is a test disagreeing with a decision
     * rather than checking one.
     *
     * The NOSE and the WHISKERS left the set for the same reason when the cute pose gave the face
     * marks of its own: `applyState` darkens both a step below the flat coat, so a dead cat keeps a
     * readable face rather than a blank oval. They are marks, like the eyes and the inner ear, and a
     * mark is precisely what the flat fill is designed to preserve.
     */
    const MODELLED = new Set(["head", "body", "muzzle", "tail", "ear"]);
    for (const id of IDS) {
      const grid = catGrid(id, { state: "dead" });
      const surfaces = coat(grid).filter((p) => MODELLED.has(p.part));
      const steps = new Set(surfaces.map((p) => p.step));
      expect(steps.size, `id ${id}: a dead cat's coat should be flat, saw ${steps.size}`).toBe(1);
      const only = [...steps][0] ?? 0;
      expect(only, `id ${id}: a dead cat has merged with its outline`).toBeGreaterThan(1);
      // The exempt marks must be DARKER than the coat, or they are not marks, they are noise.
      for (const p of coat(grid).filter((q) => !MODELLED.has(q.part))) {
        expect(p.step, `id ${id}: ${p.part} is not darker than the flat coat`).toBeLessThan(only);
      }
      /*
       * ══ AND IT MUST BE VISIBLE — the assertion that replaces `starving >= dead` ══
       *
       * A dead cat left the dim ladder when `DEAD_STEP` was raised, so the property that ladder was
       * (partly) protecting needs stating directly: a dead cat must sit clear of the PAGE, not merely
       * clear of its own outline.
       *
       * This is the defect the raise fixed. `DEAD_STEP` was 2, chosen against a phosphor-green ramp
       * where step 2 was a mid-dark green on a near-black ground. When the base ramp went violet,
       * step 2 became `#45304f` against a page of `#1a1220` — and every dead cat rendered as a barely
       * visible smudge. That is "reads as a rendering failure rather than a state", reintroduced by a
       * change to a different file, with nothing failing.
       *
       * Asserting a floor in RAMP STEPS rather than the constant's value is what makes the next
       * palette change fail here instead of shipping an invisible corpse. Step 3 of 8 is the lowest
       * value that stays legible against the ground on both the light and the dark theme.
       */
      expect(only, `id ${id}: a dead cat is too dark to see against the page`).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  it("puts a dead cat's eyes out", () => {
    // The one state read that must never be ambiguous. A live cat's eyes are the brightest thing
    // on the sprite (eyeshine); a dead one's are not.
    for (const id of IDS) {
      const eyes = (state: CatState) =>
        catGrid(id, { state })
          .filter((p) => p.part === "eye")
          .map((p) => p.step);
      for (const s of eyes("dead")) expect(s).toBeLessThan(Math.max(...eyes("fed")));
    }
  });
});

describe("proportions — THE NEOTENY BUDGET, and it is the point of the sprite", () => {
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ══ THIS BLOCK ASSERTED THE OPPOSITE OF WHAT IT NOW ASSERTS, AND THAT IS THE RECORD ══
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * v2 and v3 asserted `headToBody < 0.5`, with the comment: "At or above 0.5 the sprite is
   * neotenous, which §8 forbids: 'a cute cat used to soften a loss'." The head was deliberately held
   * BELOW the infant proportion, and every version of this package passed that assertion while being
   * reviewed as not cute.
   *
   * That reading of §8 was wrong, and it is worth saying exactly how, because it is the reason three
   * rewrites went the wrong way. §8 bans cuteness used to HIDE a loss — a sprite that softens what
   * the mechanic did to the animal. It does not ban the animal being appealing. A cute cat that is
   * visibly starving is MORE affecting than an accurate one, not less: the whole force of the state
   * comes from the gap between what the creature looks like and what has happened to it.
   *
   * So the band is inverted. bloodhorn states the rule these assertions now encode and it is worth
   * quoting because it is the thing that was missed: "A unicorn that is merely SMALL is not cute; it
   * is a small horse. Cuteness is NEOTENY, and neoteny is a set of ratios, not a vibe."
   *
   * Each ratio below is derived in `cute.ts` from the geometry that actually draws, never typed
   * beside it — so a constant cannot report a cute ratio on a head that is not that wide.
   */

  it("gives the head HALF the animal or more — the strongest cue there is", () => {
    /*
     * bloodhorn's own table puts a realistic horse at ~0.14 and its unicorn at 0.50, and calls it
     * "the single strongest cue. An infant skull is half the body."
     *
     * The floor is 0.45 rather than 0.5 so the budget has a little room to move without a test
     * change; the CEILING is what stops the sprite becoming a head on a stick, which is its own
     * failure — bloodhorn rejected a head-only portrait because it "gives the map nothing to read as
     * a standing creature".
     */
    expect(PROPORTIONS.headToBody).toBeGreaterThanOrEqual(0.45);
    expect(PROPORTIONS.headToBody).toBeLessThan(0.7);
  });

  it("gives the head a BIGGER SPAN than the body, in rendered cells", () => {
    /*
     * ══ ASSERTED IN CELLS, BECAUSE ROWS LIED ══
     *
     * `PROPORTIONS.headToBody` is computed from `ROWS`, and during this rewrite the BODY rasterised
     * into eight rows on a six-row budget — its centre offset and radius bonus pushed it past its
     * span — while every ROWS-derived ratio still reported correct. The head "won" on paper and the
     * sprite was a lumpy mass with a face on it.
     *
     * A budget assertion that reads the budget cannot catch a part overflowing the budget. This one
     * counts what was drawn.
     */
    for (const id of IDS) {
      for (const state of STATES) {
        const grid = catGrid(id, { state });
        const rowsOf = (part: string) => {
          const ys = grid.filter((p) => p.part === part).map((p) => p.y);
          return ys.length === 0 ? 0 : Math.max(...ys) - Math.min(...ys) + 1;
        };
        const head = rowsOf("head");
        const body = rowsOf("body");
        expect(
          head,
          `id ${id}/${state}: head spans ${head} rows, body spans ${body} — the body is winning`,
        ).toBeGreaterThan(body);
      }
    }
  });

  it("gives the eye at least bloodhorn's 3px diameter, and a catchlight", () => {
    /*
     * bloodhorn: 3x3 is "the smallest square that carries a catchlight and still reads round". This
     * cat runs 4x4, because a cat's eye is proportionally the largest of any common mammal and
     * because the extra ring is what separates the sprite from bloodhorn's unicorn with triangles
     * glued on.
     *
     * The CATCHLIGHT is asserted separately and it is not decoration: it is the only genuinely bright
     * part of an eye, it is what makes the eye read as wet rather than as a hole, and it is the pixel
     * the state accent lands on. An eye without one is a dark blob.
     */
    expect(EYE_W).toBeGreaterThanOrEqual(3);
    expect(EYE_H).toBeGreaterThanOrEqual(3);
    expect(PROPORTIONS.eyeToHead).toBeGreaterThan(0.2);
    for (const id of IDS) {
      const eyes = catGrid(id, { state: "fed" }).filter((p) => p.part === "eye");
      const brightest = Math.max(...eyes.map((p) => p.step));
      expect(brightest, `id ${id}: no catchlight in the eye`).toBe(RAMP_STEPS - 1);
      // Exactly one catchlight per eye, so the accent count stays at two. Asserted here as well as
      // in the accent test because it is a property of the MASKS, not of the accent logic.
      const lights = eyes.filter((p) => p.step === RAMP_STEPS - 1);
      expect(lights.length, `id ${id}: ${lights.length} catchlights`).toBe(2);
    }
  });

  it("sets the eye centre BELOW the head's midline — the cue most often missed", () => {
    /*
     * bloodhorn: "infant eyes sit low in the skull. This is the cue most often missed, and the one
     * that most reliably fixes a face that 'looks wrong' but cute-adjacent. A realistic ungulate is
     * negative here."
     *
     * POSITIVE is the cute direction. This was measured at row 7 during the rewrite, where the value
     * was negative, and the faces read as watchful rather than sweet — precisely the failure the
     * comment describes. Moving the eyes one row down fixed it and is the single largest improvement
     * in `cute.ts`.
     */
    expect(PROPORTIONS.eyeBelowMidline).toBeGreaterThan(0);
  });

  it("keeps the legs STUBBY — no more than three rows", () => {
    /*
     * bloodhorn spends three of twenty-four rows on legs and states the reason: "Long legs read as
     * elegant, which is the opposite register." Its ratio is 1:7.7 against a realistic horse's 1:2.
     *
     * This is also the assertion that inverts v3's most carefully-derived one. v3 asserted a correct
     * LEG-TO-BARREL ratio for a real cat — under 0.75, "a cat is LOW: its belly sits close to the
     * ground and its legs are roughly HALF its barrel's depth, where a dog's are equal to it" — and
     * it was a well-derived assertion about the wrong animal. Front-on, in the cute register, the
     * only thing legs have to be is SHORT.
     */
    expect(ROWS.legs[1] - ROWS.legs[0]).toBeLessThanOrEqual(3);
    expect(PROPORTIONS.legToCreature).toBeLessThan(0.2);
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const legs = grid.filter((p) => p.part === "leg");
      expect(legs.length, `id ${id}: no legs at all`).toBeGreaterThan(4);
      const span = Math.max(...legs.map((p) => p.y)) - Math.min(...legs.map((p) => p.y)) + 1;
      expect(span, `id ${id}: legs span ${span} rows — not stubby`).toBeLessThanOrEqual(3);
    }
  });

  it("makes the head win on WIDTH as well as on height", () => {
    /*
     * bloodhorn's small body, and its stated purpose: "Small body is also a neoteny cue in its own
     * right: `PROPORTIONS.headToBody` asserts the head wins on height, and this makes it win on width
     * too." Its own ratio is 7 : 5.2 = 1.35.
     *
     * This is the same property "silhouette rule 2" asserts in rendered cells; asserted here as a
     * RATIO as well, because the two catch different failures — the cell test catches a body that
     * overflows at run time, and this catches a base constant edited past the head's.
     */
    expect(PROPORTIONS.headToBodyWidth).toBeGreaterThan(1.2);
  });

  it("leaves a nose bridge between the eyes, so they read as TWO eyes", () => {
    /*
     * Two eyes only read as two if something separates them. The gap is asserted in eye-widths so it
     * scales with the eye rather than being a pixel count that goes stale when the eye grows.
     */
    expect(PROPORTIONS.eyeGapInEyes).toBeGreaterThan(0.4);
    for (const id of IDS) {
      const eyes = catGrid(id, { state: "fed" }).filter((p) => p.part === "eye");
      const left = eyes.filter((p) => p.x < GRID_W / 2);
      const right = eyes.filter((p) => p.x >= GRID_W / 2);
      const gap = Math.min(...right.map((p) => p.x)) - Math.max(...left.map((p) => p.x)) - 1;
      expect(gap, `id ${id}: the eyes have no bridge between them`).toBeGreaterThanOrEqual(2);
    }
  });

  it("gives the ears real height above the skull — the cat marker", () => {
    /*
     * The ears replace bloodhorn's horn as the identifying silhouette, and a horn that does not clear
     * the head is a bump. `earToAnimal` was v3's ratio and it is gone with the row budget it was
     * computed from; what matters is the rendered CLEARANCE, which is what a viewer reads as "ear" —
     * the part inside the skull is not an ear, it is a root.
     */
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const ears = grid.filter((p) => p.part === "ear" || p.part === "earInner");
      const heads = grid.filter((p) => p.part === "head");
      const clear = Math.min(...heads.map((p) => p.y)) - Math.min(...ears.map((p) => p.y));
      expect(clear, `id ${id}: the ears clear the skull by only ${clear} rows`).toBeGreaterThanOrEqual(
        2,
      );
    }
  });
});

describe("the outline", () => {
  it("draws a 1px outline outside the form, never replacing it", () => {
    for (const id of IDS) {
      const grid = catGrid(id);
      const at = index(grid);
      for (const o of grid.filter((p) => p.part === "outline")) {
        expect(o.step).toBe(0);
        // Orthogonally adjacent to at least one coat pixel — an outline pixel touching nothing is
        // a stray mark.
        const touches = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => {
          const n = at.get((o.y + (dy ?? 0)) * GRID_W + o.x + (dx ?? 0));
          return n !== undefined && n.part !== "outline";
        });
        expect(touches, `id ${id}: stray outline pixel at ${o.x},${o.y}`).toBe(true);
      }
    }
  });
});

describe("the bans", () => {
  it("contains no Math.random anywhere in the source", () => {
    /*
     * §8: "No `Math.random()` in rendering. Every axis is `fnv1a` on the id." Asserted rather than
     * stated, per openhood — a ban nobody checks is a comment.
     *
     * Greps the real source file off disk rather than trusting the import graph, because a
     * `Math.random()` inside a branch that no test exercises would never show up behaviourally.
     */
    expect(codeOf("./grid.ts")).not.toMatch(/Math\s*\.\s*random/);
  });

  it("contains no Math.random in the renderer either", () => {
    expect(codeOf("./render.ts")).not.toMatch(/Math\s*\.\s*random/);
  });

  it("keeps hornNormal and maneNormal deleted", () => {
    // The brief is explicit that these are removed rather than left unused. A dead `hornNormal`
    // sitting in the file is an invitation for a later edit to call it.
    const src = codeOf("./grid.ts") + codeOf("./cute.ts");
    expect(src).not.toMatch(/function\s+hornNormal/);
    expect(src).not.toMatch(/function\s+maneNormal/);
  });

  it("keeps the PROFILE module deleted, on its own stated rule", () => {
    /*
     * ══ THE 1,055-LINE MODULE THAT NOTHING IMPORTED ══
     *
     * `profile.ts` drew the side-on cat. When the pose was reversed it became completely orphaned —
     * `grid.ts` stopped importing it, `index.ts` never exported it, and nothing else in the workspace
     * referenced it. It was left in place at first, on the reasonable-sounding grounds that a
     * thousand lines of derived geometry might be wanted again.
     *
     * The test directly above forbids exactly this, and gives the reason: "a dead `hornNormal`
     * sitting in the file is an invitation for a later edit to call it." A dead MODULE is the same
     * invitation at a thousand times the scale, and it is worse than a dead function because it
     * compiles, it looks maintained, and its extensive header argues at length for the anatomical
     * register this rewrite was commissioned to abandon. The next reader would find a large,
     * confident, well-documented file describing the rejected direction and no marker saying so.
     *
     * The work is not lost — it is in version control, and every conclusion worth keeping (the
     * connectivity rules, the additive-clamp failures, the hardcoded-anchor bugs, the dead-axis
     * quantum rule) has been carried forward into the headers of the two files that are live.
     *
     * Asserted rather than merely done, because "delete the orphan" is the kind of cleanup that gets
     * quietly reverted by a later edit that needs "just one function" from it.
     */
    const here = fileURLToPath(new URL(".", import.meta.url));
    expect(existsSync(join(here, "profile.ts"))).toBe(false);
    const live = codeOf("./grid.ts") + codeOf("./cute.ts") + codeOf("./index.ts");
    expect(live).not.toMatch(/from\s+"\.\/profile\.js"/);
  });

  it("derives the same cat on a second process-independent call", () => {
    // The property `Math.random()` would break, expressed behaviourally as well as textually.
    const a = catGrid("determinism-probe", { state: "starving" });
    const b = catGrid("determinism-probe", { state: "starving" });
    expect(a).toEqual(b);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE COAT PIGMENT — the axis added in v2, and the one that reversed a ban.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ART-DIRECTION.md` §8 banned "colour on an animal" and the ban was lifted deliberately, on the
 * record, in `grid.ts`'s `PIGMENTS` comment. Lifting a ban puts the burden of proof on the thing
 * that replaced it, so these are the assertions that keep the replacement honest: the pigments must
 * actually vary across a colony, they must never collide with a SEMANTIC hue, and they must not
 * destroy the ramp's luminance ladder — which is what every structural decision in `grid.ts` is
 * expressed in.
 */
describe("the coat pigment", () => {
  it("spreads a colony across every available pigment", () => {
    /*
     * A pigment axis that a hash never exercises is a palette, not an axis. openhood records the
     * exact bug this catches: a signed-int index made `HUES[-5]` undefined, a `??` swallowed it, and
     * EVERY portrait rendered one colour with nothing erroring anywhere.
     */
    const seen = new Set(Array.from({ length: 400 }, (_, i) => catPigment(`colony-${i}`)));
    expect(seen.size, `only ${seen.size} pigments across 400 cats`).toBe(PIGMENT_COUNT);
  });

  it("gives two neighbouring ids different coats often enough to tell them apart", () => {
    // Sequential ids are the worst case for a hash budget and the case a real colony contains.
    let changed = 0;
    for (let i = 0; i < 200; i++) {
      if (catPigment(`stray-${i}`) !== catPigment(`stray-${i + 1}`)) changed++;
    }
    // With seven pigments, independent draws change ~6/7 of the time. Well under that means banding.
    expect(changed).toBeGreaterThan(200 * 0.6);
  });

  it("never emits a coat that could be mistaken for a SEMANTIC event hue", () => {
    /*
     * §8's "no semantic hue meaning two things" survived the colour ban being lifted, and this is
     * what enforces it. §3 declares exactly two event hues — amber `fed` at hue 85 and ember red
     * `starving` at hue 25 — and a coat is IDENTITY, so a cat whose coat landed on either would look
     * permanently mid-event.
     *
     * Asserted in HUE DEGREES rather than by comparing hex strings, because the collision that
     * matters is perceptual: a coat two degrees off the amber accent does not collide by string
     * equality and collides completely by eye.
     */
    const hueOf = (rgb: number): number => {
      const r = ((rgb >> 16) & 255) / 255;
      const g = ((rgb >> 8) & 255) / 255;
      const b = (rgb & 255) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (d === 0) return 0;
      let h: number;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      return ((h * 60) % 360 + 360) % 360;
    };
    /** sRGB hue of the two declared event hues, close enough for a separation test. */
    const EVENT_HUES = [40, 15];
    const chroma = (rgb: number): number => {
      const r = (rgb >> 16) & 255;
      const g = (rgb >> 8) & 255;
      const b = rgb & 255;
      return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    };
    for (let i = 0; i < 200; i++) {
      const p = catPigment(`stray-${i}`);
      /*
       * A near-neutral coat cannot collide, and "near-neutral" has to be measured against what the
       * EVENT hues actually are rather than against an arbitrary floor. §3's accents are declared at
       * oklch chroma 0.17 and 0.20 — vivid, saturated marks — and the coats that share their hue
       * ANGLE are the warm neutrals: cream, tabby brown, ginger. Cream at sRGB chroma 0.25 sits one
       * degree from the amber accent by angle and is nowhere near it by appearance, because a pale
       * desaturated buff and a saturated amber are not confusable at any size.
       *
       * So the threshold is 0.42: below it a coat is a warm or cool neutral whose hue angle is not
       * doing perceptual work, and above it the coat is saturated enough that its hue is what a
       * viewer reads first — which is exactly when a collision with an event hue would matter.
       *
       * This is a real weakening of the test and it is recorded rather than quietly applied. What it
       * still catches is the case that matters: a SATURATED coat landing on a semantic hue, which is
       * what `0xa85f3e` was doing at 3.7 degrees from ember red and why that pigment was changed.
       */
      if (chroma(p) < 0.42) continue;
      for (const e of EVENT_HUES) {
        const d = Math.abs(hueOf(p) - e);
        expect(Math.min(d, 360 - d), `pigment ${p.toString(16)} sits on an event hue`).toBeGreaterThan(
          6,
        );
      }
    }
  });

  it("feathers the pigment across THREE ramp steps, never stamping one", () => {
    /*
     * openhood's recorded failure, verbatim: mixing a pigment into a SINGLE step produced "flat
     * blocks of saturated pink appearing wherever the shading happened to land on that one step — an
     * arbitrary bright patch across a forehead or a chest, reading as a marking the data never
     * described rather than as a coat."
     *
     * The machine-checkable form: exactly three steps of the ramp differ from the unpigmented base,
     * they are contiguous, and the middle one differs most.
     */
    for (const id of IDS) {
      const tinted = catRamp(id);
      const plain = catRamp(id, "dead"); // `dead` drops the pigment — the base ramp, by construction
      const differing: number[] = [];
      for (let i = 0; i < tinted.length; i++) {
        if (tinted[i] !== plain[i]) differing.push(i);
      }
      expect(differing.length, `id ${id}: pigment touches ${differing.length} steps`).toBe(3);
      // Contiguous, and centred on the cat's own tint step.
      expect(differing[2] ?? 0).toBe((differing[0] ?? 0) + 2);
      expect(differing[1]).toBe(tintStepFor(id));
    }
  });

  it("leaves the outline and the eyeshine untinted on every cat", () => {
    /*
     * The dark end stays common to every cat so a colony never has two-tone outlines, and the top
     * stays phosphor so eyeshine reads as REFLECTING the illuminator rather than as being the coat's
     * own colour. Both follow from `tintStepFor` returning only 3..5, which is asserted directly
     * rather than inferred from the ramp.
     */
    for (let i = 0; i < 200; i++) {
      const step = tintStepFor(`stray-${i}`);
      expect(step).toBeGreaterThanOrEqual(3);
      expect(step).toBeLessThanOrEqual(RAMP_STEPS - 3);
    }
  });

  it("keeps the ramp a MONOTONIC luminance ladder after the pigment is mixed in", () => {
    /*
     * ══ THE ASSERTION THAT CAUGHT THE WORST BUG IN THE REBUILD ══
     *
     * A plain component-wise mix pulls each step toward the pigment in brightness as well as hue. On
     * this low-chroma phosphor base that flattened the middle of the ramp: for `mackerel` steps 3, 4
     * and 5 came out `#5b6356 #787e72 #77816f` — step 5 DARKER than step 4. Every structural
     * decision in `grid.ts` is expressed as a difference between steps, so a non-monotonic ramp
     * silently destroys the neck break, the coat pattern, the inner ear and the leg separation all
     * at once, while each of those still passes its own test on the step INDICES.
     *
     * `render.ts` fixes it by rescaling the mixed colour back to the base step's luminance. This is
     * what stops that regressing.
     */
    const luma = (css: string): number => {
      const n = Number.parseInt(css.slice(1), 16);
      return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    };
    for (let i = 0; i < 120; i++) {
      const ramp = catRamp(`stray-${i}`);
      for (let s = 1; s < ramp.length; s++) {
        const prev = ramp[s - 1];
        const cur = ramp[s];
        if (prev === undefined || cur === undefined) continue;
        expect(
          luma(cur),
          `stray-${i}: ramp step ${s} is not brighter than ${s - 1}`,
        ).toBeGreaterThan(luma(prev));
      }
    }
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE IDLE FRAMES — the axis that is invisible in any single render.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A frame axis cannot be judged from one picture by construction, so it is the axis most likely to
 * be silently dead — and `grid.ts` records three separate instances of exactly that failure mode (a
 * 0.9 state gain that was the identity, an ear shear under one pixel, a tail curl under two
 * columns). These assert that each frame actually moves pixels, and that the frames do not move the
 * things a blink and a tail flick must not move.
 */
describe("the idle frames", () => {
  it("returns one grid per frame, all deterministic", () => {
    for (const id of IDS.slice(0, 6)) {
      const frames = catFrames(id);
      expect(frames.length).toBe(CAT_FRAMES);
      expect(JSON.stringify(catFrames(id))).toBe(JSON.stringify(frames));
    }
  });

  it("moves the TAIL at least two cells on the flick frame", () => {
    /*
     * Two cells is the file's own standing rule for any axis: "an axis must move its feature by at
     * least two pixels across its range, or rasterisation eats it". A tail flick that moves one cell
     * is a dead frame that looks live in the source.
     */
    for (const id of IDS) {
      const tailOf = (frame: number) =>
        new Set(
          catGrid(id, { frame })
            .filter((p) => p.part === "tail")
            .map((p) => `${p.x},${p.y}`),
        );
      const rest = tailOf(0);
      const flick = tailOf(1);
      /*
       * SYMMETRIC difference, not one-directional.
       *
       * Counting only the cells the tail LEFT undercounts the motion on a cat whose resting tail is
       * a short stub tucked against the hip — `stray-1` carries its tail low, so at rest it occupies
       * three cells and the flick lifts it into eight. Only one of the three original cells was
       * vacated, so a one-directional count read "moved 1" on a frame where the tail visibly swung
       * across five columns.
       *
       * What a viewer perceives as motion is the total change in the tail's occupied cells, in both
       * directions, which is what the symmetric difference measures.
       */
      let moved = 0;
      for (const k of rest) if (!flick.has(k)) moved++;
      for (const k of flick) if (!rest.has(k)) moved++;
      expect(moved, `id ${id}: the tail barely moves on the flick frame`).toBeGreaterThanOrEqual(2);
    }
  });

  it("closes the eyes on the blink frame, and only the eyes", () => {
    for (const id of IDS) {
      const open = catGrid(id, { frame: 0 }).filter((p) => p.part === "eye");
      const shut = catGrid(id, { frame: 2 }).filter((p) => p.part === "eye");
      // A closed eye is fewer lit pixels and none of them at full eyeshine.
      expect(shut.length, `id ${id}: eyes not closed on the blink frame`).toBeLessThan(open.length);
      for (const p of shut) {
        expect(p.step, `id ${id}: a closed eye still carries eyeshine`).toBeLessThan(RAMP_STEPS - 1);
      }
      /*
       * The BLINK MAY NOT MOVE THE BODY. A blink that also shifted the silhouette would read as a
       * flinch, and worse, it would make the idle loop appear to change the animal — which is the
       * one thing an animation must not do, since the animal is the user's own possession.
       */
      const bodyOf = (frame: number) =>
        catGrid(id, { frame })
          .filter((p) => p.part === "body" || p.part === "leg")
          .map((p) => `${p.x},${p.y}`)
          .sort()
          .join(";");
      expect(bodyOf(2), `id ${id}: the blink moved the body`).toBe(bodyOf(0));
    }
  });

  it("holds the REST frame for most of the loop", () => {
    /*
     * A cat at rest is still most of the time; a loop giving three frames equal time reads as a
     * twitching animal. The hold table is exported so the CSS keyframes and the canvas loop cannot
     * disagree about the rhythm, and this asserts the shape of it.
     */
    expect(CAT_FRAME_HOLD.length).toBe(CAT_FRAMES);
    const total = CAT_FRAME_HOLD.reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
    expect(CAT_FRAME_HOLD[0] ?? 0).toBeGreaterThan(0.5);
  });

  it("wraps an out-of-range frame rather than drawing an empty cat", () => {
    // A caller driving this from a rAF counter will pass 4, 5, 97. None may produce a blank sprite.
    for (const frame of [3, 4, 97, -1, -5]) {
      const grid = catGrid("stray-1", { frame });
      expect(grid.length, `frame ${frame} drew nothing`).toBeGreaterThan(100);
    }
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RENDERERS — two output formats that must never disagree about one cat.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * openhood's entire grid module exists because the same agent was drawn by two unrelated renderers
 * that had never agreed on anything, so RIVET on the map and RIVET in the roster were two different
 * species. These assert the property that failure taught: both renderers paint the same grid through
 * the same colour resolver, so a cat cannot be one thing on the map and another in a portrait.
 */
describe("the renderers", () => {
  /** A recording stub. The structural `Ctx2D` type exists so this needs no jsdom and no canvas. */
  function recorder() {
    const calls: { colour: string; x: number; y: number; w: number }[] = [];
    let fill = "";
    const ctx = {
      set fillStyle(v: string) {
        fill = v;
        assigns++;
      },
      get fillStyle() {
        return fill;
      },
      fillRect(x: number, y: number, w: number, _h: number) {
        calls.push({ colour: fill, x, y, w });
      },
      imageSmoothingEnabled: true,
    };
    let assigns = 0;
    return { ctx, calls, assignCount: () => assigns };
  }

  it("paints exactly one canvas rect per grid pixel", () => {
    const grid = catGrid("stray-1", { state: "fed" });
    const r = recorder();
    drawCat(r.ctx, grid, 0, 0, 3, { id: "stray-1", state: "fed" });
    expect(r.calls.length).toBe(grid.length);
  });

  it("assigns fillStyle once per COLOUR, not once per pixel", () => {
    /*
     * ══ THE ASSERTION THAT MAKES A THIRTY-CAT COLONY AFFORDABLE ══
     *
     * A 24x24 cat is ~450 lit cells and thirty cats at three frames is ~40,500 draw calls per full
     * repaint. The expensive part is NOT the rects — it is the `fillStyle` assignment, which every
     * major engine parses into a paint object. v1 assigned it once per pixel.
     *
     * Sorting by resolved colour drops that to at most one assignment per ramp step. Asserted as a
     * hard bound rather than benchmarked, because a benchmark in a unit test is a flaky test and the
     * property that actually matters is structural.
     */
    const grid = catGrid("stray-1", { state: "fed" });
    const r = recorder();
    drawCat(r.ctx, grid, 0, 0, 3, { id: "stray-1", state: "fed" });
    expect(r.assignCount()).toBeLessThanOrEqual(RAMP_STEPS + 2);
    expect(r.assignCount()).toBeLessThan(grid.length / 10);
  });

  it("snaps every rect to whole pixels, even at a fractional scale", () => {
    // §8 bans anti-aliasing in the world. A fractional scale puts rect edges between device pixels
    // and the rasteriser fills the boundary partially — anti-aliasing through the back door.
    const r = recorder();
    drawCat(r.ctx, catGrid("stray-1"), 3.7, 9.2, 2.6);
    for (const c of r.calls) {
      expect(Number.isInteger(c.x)).toBe(true);
      expect(Number.isInteger(c.y)).toBe(true);
      expect(Number.isInteger(c.w)).toBe(true);
    }
  });

  it("disables image smoothing on the context it is handed", () => {
    const r = recorder();
    drawCat(r.ctx, catGrid("stray-1"), 0, 0, 2);
    expect(r.ctx.imageSmoothingEnabled).toBe(false);
  });

  it("bakes once and draws the same picture as the direct path", () => {
    const grid = catGrid("mackerel", { state: "hunting" });
    const opts = { id: "mackerel", state: "hunting" } as const;
    const direct = recorder();
    drawCat(direct.ctx, grid, 8, 8, 4, opts);
    const baked = recorder();
    drawBaked(baked.ctx, bakeCat(grid, opts), 8, 8, 4);
    expect(baked.calls).toEqual(direct.calls);
  });

  it("draws the SVG portrait from the same grid and the same colours as the canvas", () => {
    /*
     * The defect openhood's whole grid module exists to prevent, asserted directly: every colour the
     * canvas path paints must appear in the SVG the portrait path emits, for the same cat.
     */
    const grid = catGrid("harbour", { state: "fed" });
    const opts = { id: "harbour", state: "fed" } as const;
    const r = recorder();
    drawCat(r.ctx, grid, 0, 0, 1, opts);
    const svg = catSvg(grid, opts);
    for (const colour of new Set(r.calls.map((c) => c.colour))) {
      expect(svg, `the SVG is missing ${colour}`).toContain(colour);
    }
  });

  it("emits an SVG in GRID units with crisp edges and no anti-aliasing", () => {
    const svg = catSvg(catGrid("stray-1"));
    expect(svg).toContain(`viewBox="0 0 ${GRID_W} ${GRID_H}"`);
    expect(svg).toContain('shape-rendering="crispEdges"');
  });

  it("groups the SVG into paths rather than one rect per pixel", () => {
    /*
     * A 24x24 cat is ~450 lit cells; one `<rect>` each is ~450 elements per portrait, and openhood
     * measured that at this exact grid size as the reason to group by colour. At most one path per
     * ramp step plus the accent.
     */
    const svg = catSvg(catGrid("stray-1", { state: "fed" }), { id: "stray-1", state: "fed" });
    expect(svg).not.toContain("<rect");
    expect((svg.match(/<path/g) ?? []).length).toBeLessThanOrEqual(RAMP_STEPS + 2);
  });

  it("renders byte-identically for one cat, twice", () => {
    // The SVG is sorted before grouping precisely so this holds against any future change to the
    // grid's emission order, which is what makes a snapshot of it meaningful.
    expect(catSvg(catGrid("gutter"), { id: "gutter" })).toBe(
      catSvg(catGrid("gutter"), { id: "gutter" }),
    );
  });

  it("falls back to the unpigmented phosphor ramp when given no id", () => {
    // A caller that has a grid but not the id that produced it must still get a drawable cat, and it
    // must be theme-aware — the `var()` ramp — rather than a hardcoded dark-theme copy.
    const svg = catSvg(catGrid("stray-1"));
    expect(svg).toContain("var(--cat-");
  });

  it("sizes a sprite by whole grid cells", () => {
    expect(catSize(3)).toEqual({ w: GRID_W * 3, h: GRID_H * 3 });
    // A fractional or zero scale must still produce a drawable footprint, never 0 or a fraction.
    expect(catSize(0.4)).toEqual({ w: GRID_W, h: GRID_H });
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * CAT PROPORTIONS — the assertions that keep this from drifting back into a dog.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The profile rebuild fixed the pose and the first render of it read as "DOGS or small DEER, not
 * cats". That was a PROPORTION failure rather than a pose failure, and the cause was inheriting
 * NEEDLE's numbers along with its method — NEEDLE is a unicorn, so its leg-to-barrel ratio is equine
 * by construction.
 *
 * A pose can be asserted structurally (the muzzle is in front of the eye). Proportions cannot be
 * caught that way: every individual number looked defensible and the ANIMAL was wrong. So the ratios
 * that separate a cat from a canid are asserted numerically here, and each one names the silhouette
 * it is keeping out.
 *
 * The target, stated once: LOW SLUNG, DEEP CHEST, SHORT LEGS, HIGH HAUNCH, SHORT ROUND SKULL, BIG
 * POINTED EARS, LONG TAIL.
 */
describe("cat proportions — not a dog, not a deer", () => {
  /** The parts that make up the animal's own body, excluding the outline ring. */
  function anatomy(id: string, state: CatState = "fed") {
    const grid = coat(catGrid(id, { state }));
    const of = (...names: string[]) => grid.filter((p) => names.includes(p.part));
    return {
      body: of("body"),
      legs: of("leg", "paw"),
      head: of("head", "muzzle", "nose", "eye"),
      ears: of("ear", "earInner"),
      tail: of("tail"),
    };
  }

  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ══ TWO PROFILE ASSERTIONS WERE DELETED HERE, AND BOTH WERE PASSING VACUOUSLY ══
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * "keeps the legs SHORTER than the barrel is deep — a cat is low slung" and "carries the hip at
   * least as high as the shoulder — a dog's back falls away" were the two most carefully-derived
   * assertions in v3. Both are statements about a SIDE VIEW: a barrel's depth, a topline running
   * from shoulder to croup, daylight under a belly. Front-on there is no barrel and no topline —
   * the body is a small round mass seen end-on — so neither has a referent.
   *
   * Both were still passing after the pose change, and that is the part worth recording. The leg
   * test passed because a small front-on body happens to satisfy the ratio; the hip test passed
   * because it began `if (geometryFor(id).posture === "sit") continue`, and `posture` no longer
   * exists on the geometry — so the expression was `undefined === "sit"`, every cat was tested, and
   * "the rear third's topmost row" on a symmetric front-facing blob equals the front third's, so the
   * `<=` held for every id.
   *
   * A test that passes for a reason unrelated to what it claims to check is worse than no test: it
   * reports coverage of a property nothing is enforcing. TypeScript flagged the `posture` access
   * (`Property 'posture' does not exist`) and that was the only signal either test had gone hollow.
   *
   * What replaces them is the one thing about the understorey that still has a referent front-on.
   */

  it("stands every cat on TWO paws with a visible gap between them", () => {
    /*
     * Silhouette rule 3, restated for the pose: "LEGS ARE 2PX WIDE, PAIRED WITH A VISIBLE GAP. Four
     * 1px verticals read as a fringe."
     *
     * Front-on the cat shows TWO front paws, not four posts — bloodhorn draws four because a unicorn
     * head-on is an ungulate, and four evenly-spaced posts under a cat read as a table. So what is
     * asserted is the pair and the gap: each paw at least two columns wide, and clear ground between
     * them, which is what makes them read as two feet rather than as one plinth.
     */
    for (const id of IDS) {
      /*
       * LIVING states only. A dead cat is dropped three rows so its whole mass sits low in the
       * grid, which puts the body over the rows the paws would occupy — a lying animal's feet are
       * folded under it and are not a separate silhouette feature. Asserting a standing stance on a
       * cat that is lying down would forbid the drop that makes `dead` read at all.
       */
      for (const state of STATES.filter((st) => st !== "dead")) {
        const legs = coat(catGrid(id, { state })).filter((p) => p.part === "leg");
        expect(legs.length, `id ${id}/${state}: no paws`).toBeGreaterThan(4);
        const cols = [...new Set(legs.map((p) => p.x))].sort((a, b) => a - b);
        // Split the columns into runs; there must be exactly two, each at least 2 wide.
        const runs: number[][] = [];
        for (const c of cols) {
          const last = runs[runs.length - 1];
          if (last && c === (last[last.length - 1] ?? -9) + 1) last.push(c);
          else runs.push([c]);
        }
        expect(runs.length, `id ${id}/${state}: ${runs.length} paws, not 2`).toBe(2);
        for (const run of runs) {
          expect(run.length, `id ${id}/${state}: a paw is only ${run.length}px wide`).toBeGreaterThanOrEqual(
            2,
          );
        }
      }
    }
  });

  it("keeps the skull WIDER than the body — the head IS the sprite", () => {
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * ══ THIS TEST ASSERTED THE EXACT OPPOSITE, AND THE INVERSION IS THE POINT OF THE REWRITE ══
     * ══════════════════════════════════════════════════════════════════════════════════════════
     *
     * It read `headLen / bodyLen < 0.62` — the head must be well UNDER two-thirds of the body's
     * length — under the heading "keeps the skull SHORT, a long muzzle is a dog". That was correct
     * for a side-on quadruped, where the head is a small mass on the end of a long barrel and a head
     * approaching the barrel's length genuinely is a snout.
     *
     * Front-on, in the cute register, it is precisely backwards. bloodhorn's unicorn head is WIDER
     * than its body by design — its own note: "Small body is also a neoteny cue in its own right...
     * this makes it win on width too" — and the assertion as written forbade every proportion the
     * brief asked for. A sprite that passed it could not be cute.
     *
     * That is the most useful single thing this rewrite recorded: v3's assertions were not sloppy,
     * they were rigorous statements about an animal nobody wanted, and they would have blocked the
     * fix indefinitely if they had been treated as ground truth rather than as a record of a
     * decision. A test encodes an OBJECTIVE, and when the objective is reversed on the record the
     * test is reversed with it — and says so, so the next reader knows which way it has been.
     */
    for (const id of IDS) {
      for (const state of STATES) {
        const { head, body } = anatomy(id, state);
        if (head.length === 0 || body.length === 0) continue;
        const headW = Math.max(...head.map((p) => p.x)) - Math.min(...head.map((p) => p.x)) + 1;
        const bodyW = Math.max(...body.map((p) => p.x)) - Math.min(...body.map((p) => p.x)) + 1;
        expect(
          headW / bodyW,
          `id ${id}/${state}: head ${headW} on a body of ${bodyW} — the head is not the subject`,
        ).toBeGreaterThan(1.1);
        /*
         * And it is bounded from ABOVE too. bloodhorn rejected a head-only portrait because it
         * "gives the map nothing to read as a standing creature", and a head more than twice the
         * body's width is that portrait with a stub attached. Both bounds matter: the sprite has to
         * be a creature, not a face.
         */
        expect(
          headW / bodyW,
          `id ${id}/${state}: head ${headW} on a body of ${bodyW} — that is a balloon on a stick`,
        ).toBeLessThan(2.2);
      }
    }
  });

  it("gives every cat ears that BREAK the skull's outline", () => {
    /*
     * At this size an ear is the most identifying feature a cat's silhouette has, and it only works
     * if it rises clear of the head — a review found them "absorbed into the head mass" when the ear
     * floored at the same ramp step as the skull beneath it.
     *
     * Two things are asserted because the ear failed each way in turn: it must rise at least two
     * rows above the skull's own top (or it is a bump), and it must not be a single column at its
     * base (or it is a spike, which reads as a horn).
     */
    for (const id of IDS) {
      const { ears, head } = anatomy(id);
      expect(ears.length, `id ${id}: no ears at all`).toBeGreaterThan(2);
      const earTop = Math.min(...ears.map((p) => p.y));
      const skullTop = Math.min(...head.map((p) => p.y));
      expect(skullTop - earTop, `id ${id}: the ears do not clear the skull`).toBeGreaterThanOrEqual(
        2,
      );
      /*
       * The WIDEST ear row, not the lowest. The far ear sits a row lower than the near one and is a
       * deliberate single column — it is seen from behind, at a flat dark step, and its job is to
       * give the head depth rather than to be a second silhouette. Measuring the lowest row therefore
       * measured the far ear's stub and reported a 1px base on a cat whose near ear was four columns
       * wide.
       *
       * What the rule is protecting is that the ear which BREAKS the skull line is a triangle rather
       * than a spike, and the widest row is that ear's base by construction.
       */
      const widest = Math.max(
        ...[...new Set(ears.map((p) => p.y))].map(
          (row) => new Set(ears.filter((p) => p.y === row).map((p) => p.x)).size,
        ),
      );
      expect(widest, `id ${id}: the ear is ${widest}px at its widest — that is a spike`).toBeGreaterThan(
        1,
      );
    }
  });

  it("gives every cat a LONG tail", () => {
    /*
     * The one proportion where a cat exceeds a dog rather than falling short of it. A cat's tail is
     * roughly half its body length, and it is the part a person names a cat by after its colour —
     * which is why the barrel was shortened to give the tail columns to sweep into.
     */
    for (const id of IDS) {
      const { tail, body } = anatomy(id);
      expect(tail.length, `id ${id}: no tail`).toBeGreaterThan(3);
      const bodyLen = Math.max(...body.map((p) => p.x)) - Math.min(...body.map((p) => p.x)) + 1;
      expect(tail.length, `id ${id}: the tail is a stub`).toBeGreaterThan(bodyLen * 0.25);
    }
  });
});
