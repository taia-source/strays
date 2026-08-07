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

import { readFileSync } from "node:fs";
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
   * ══ IN PROFILE THE NECK IS A SHAPE, AND THESE ASSERTIONS CHANGED WITH THE POSE ══
   *
   * Head-on, the head sat directly on top of the body and the ONLY thing that could separate them
   * was a forced value break — the body's first row clamped two ramp steps below the head above it.
   * That clamp had three distinct bugs over its life, every one of them the same shape: the break
   * being computed somewhere the final value was not yet known.
   *
   * In profile the skull sits ABOVE and FORWARD of the barrel, joined by a neck the silhouette
   * implies. The separation is carried by the OUTLINE running into the notch between the skull's
   * back edge and the withers — geometry, not tone — so the value clamp is gone and with it all
   * three of its bugs. What is asserted now is the property the clamp was a proxy for: that a
   * viewer can tell where the head ends and the body begins.
   */

  it("puts the skull clear of the barrel, so the silhouette has a neck notch", () => {
    /*
     * The concrete form: on the row where the skull is widest there must be a column between the
     * skull's rear edge and the body's front edge that belongs to NEITHER — the notch. Without it
     * the two masses are fused and the animal is unitick's amoeba.
     *
     * Measured on the head's own rows only. Lower down they legitimately merge at the chest, which
     * is where a neck actually joins a body.
     */
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const heads = grid.filter((p) => p.part === "head" || p.part === "muzzle");
      expect(heads.length, `id ${id}: no head at all`).toBeGreaterThan(6);
      const bodies = grid.filter((p) => p.part === "body");
      expect(bodies.length, `id ${id}: no body at all`).toBeGreaterThan(20);
      // The head must sit FORWARD of the body's centre of mass — that is what "profile" means, and
      // a head-on sprite would fail it outright.
      const headX = heads.reduce((a, p) => a + p.x, 0) / heads.length;
      const bodyX = bodies.reduce((a, p) => a + p.x, 0) / bodies.length;
      expect(headX, `id ${id}: the head is not in front of the body`).toBeLessThan(bodyX);
    }
  });

  it("keeps the head ABOVE the barrel's back line, so a neck exists at all", () => {
    // In profile the skull's centre sits above the spine. If it did not, the head would be inside
    // the barrel and the two would fuse — which is exactly what the first profile draft did.
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const heads = grid.filter((p) => p.part === "head");
      const bodies = grid.filter((p) => p.part === "body");
      if (heads.length === 0 || bodies.length === 0) continue;
      const headY = heads.reduce((a, p) => a + p.y, 0) / heads.length;
      const bodyY = bodies.reduce((a, p) => a + p.y, 0) / bodies.length;
      expect(headY, `id ${id}: the head is not above the barrel`).toBeLessThan(bodyY);
    }
  });

  it("draws the muzzle IN FRONT of the eye — the single strongest cat cue", () => {
    /*
     * ══ THE ASSERTION THAT WOULD HAVE CAUGHT THE HEAD-ON POSE ══
     *
     * A face with the muzzle below and between two eyes is an OWL, and that is what the head-on
     * sprite read as no matter how its cheeks and nose were tuned. A face with the muzzle protruding
     * in FRONT of a single eye is a cat, and it is a property of the pose rather than of any tuning.
     *
     * This is the one test in the file that a head-on sprite cannot pass, which is precisely why it
     * is worth having: it pins the decision rather than the parameters.
     */
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const muzzle = grid.filter((p) => p.part === "muzzle" || p.part === "nose");
      const eyes = grid.filter((p) => p.part === "eye");
      expect(muzzle.length, `id ${id}: no muzzle`).toBeGreaterThan(0);
      expect(eyes.length, `id ${id}: no eye`).toBeGreaterThan(0);
      const muzzleFront = Math.min(...muzzle.map((p) => p.x));
      const eyeFront = Math.min(...eyes.map((p) => p.x));
      expect(muzzleFront, `id ${id}: the muzzle is not in front of the eye`).toBeLessThan(eyeFront);
    }
  });

  it("gives every cat a back line that spans most of its length", () => {
    /*
     * The back line is the top edge of the barrel and is the profile silhouette's defining feature —
     * it is what a viewer reads as "quadruped" before any detail resolves. A body whose topmost row
     * is only a few columns wide is a lump rather than a back.
     */
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const bodies = grid.filter((p) => p.part === "body");
      if (bodies.length === 0) continue;
      /*
       * ══ THE TOPLINE IS SAMPLED PER COLUMN, BECAUSE A CAT'S BACK IS NOT LEVEL ══
       *
       * This measured the width of the body's TOPMOST ROW, which was right while the topline was
       * flat. Once the croup was raised above the withers — the correction that stopped these
       * reading as dogs — only the rear few columns occupy the topmost row, so the test reported a
       * 6-column back on a 14-column body and failed a cat whose silhouette had just been improved.
       *
       * A test that fails when the thing it guards gets better is measuring the wrong quantity. What
       * "has a back line" means is that the body's top edge is CONTINUOUS across its length — every
       * column from chest to croup has a topmost body cell — which is what a viewer reads as a back,
       * whether or not that edge is level.
       */
      const byCol = new Map<number, number>();
      for (const p of bodies) {
        const cur = byCol.get(p.x);
        if (cur === undefined || p.y < cur) byCol.set(p.x, p.y);
      }
      const cols = [...byCol.keys()].sort((a, b) => a - b);
      const span = cols.length;
      expect(span, `id ${id}: the back line is only ${span} columns`).toBeGreaterThanOrEqual(9);
      // And it must be unbroken: no column between the chest and the croup may be missing.
      const first = cols[0] ?? 0;
      const last = cols[cols.length - 1] ?? 0;
      expect(last - first + 1, `id ${id}: the back line has a gap in it`).toBe(span);
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

  it("draws a front pair and a back pair, separated along the body", () => {
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const legs = grid.filter((p) => p.part === "leg" || p.part === "paw");
      expect(legs.length, `id ${id}: no legs at all`).toBeGreaterThan(3);
      const xs = [...new Set(legs.map((p) => p.x))].sort((a, b) => a - b);
      // Group the columns into runs; each run is one leg seen in profile.
      const runs: number[][] = [];
      for (const x of xs) {
        const last = runs[runs.length - 1];
        if (last && x === (last[last.length - 1] ?? -9) + 1) last.push(x);
        else runs.push([x]);
      }
      /*
       * TWO runs, front and back. A standing cat shows four legs but the near and far leg of each
       * pair occupy the same columns in strict profile — which is what profile MEANS — so the
       * silhouette has two posts, and the gap between them is the cue.
       */
      expect(runs.length, `id ${id}: ${runs.length} leg groups, expected 2`).toBe(2);
      const front = runs[0] ?? [];
      const back = runs[1] ?? [];
      const gap = (back[0] ?? 0) - (front[front.length - 1] ?? 0) - 1;
      expect(gap, `id ${id}: leg gap is only ${gap} columns`).toBeGreaterThanOrEqual(2);
    }
  });

  it("makes every leg at least 2px wide", () => {
    // A 1px leg is a hairline: it disappears at the first ramp step and leaves the cat floating.
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const legs = grid.filter((p) => p.part === "leg" || p.part === "paw");
      if (legs.length === 0) continue;
      const xs = [...new Set(legs.map((p) => p.x))].sort((a, b) => a - b);
      const runs: number[][] = [];
      for (const x of xs) {
        const last = runs[runs.length - 1];
        if (last && x === (last[last.length - 1] ?? -9) + 1) last.push(x);
        else runs.push([x]);
      }
      for (const r of runs) {
        expect(r.length, `id ${id}: a leg is ${r.length}px wide`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("stands every cat on paws, at the bottom of its legs", () => {
    for (const id of IDS) {
      const grid = catGrid(id, { state: "fed" });
      const paws = grid.filter((p) => p.part === "paw");
      const legs = grid.filter((p) => p.part === "leg");
      if (paws.length === 0) continue;
      expect(
        Math.max(...paws.map((p) => p.y)),
        `id ${id}: a paw is not below the leg above it`,
      ).toBeGreaterThanOrEqual(legs.length === 0 ? 0 : Math.max(...legs.map((p) => p.y)));
    }
  });

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

  it("draws a starving cat THINNER than a fed one", () => {
    /*
     * The specific form of the above, and the one the brief names. Total silhouette AREA, because a
     * viewer reads "thin" as less of the animal being there rather than as any one measurement.
     */
    for (const id of IDS) {
      const area = (state: CatState) => coat(catGrid(id, { state })).length;
      expect(area("starving"), `id ${id}: starving is not thinner than fed`).toBeLessThan(
        area("fed"),
      );
    }
  });

  it("pricks a hunting cat's ears forward and drops it into a crouch", () => {
    let loweredByHunting = 0;
    /*
     * `hunting` is alertness, and alertness has to read on EVERY cat regardless of what its own hash
     * gave it — a bias a hash could cancel is not a state. Both halves are forced in
     * `stateGeometry` and both are asserted here rather than trusted.
     */
    for (const id of IDS) {
      const hunting = catGrid(id, { state: "hunting" });
      const ears = hunting.filter((p) => p.part === "ear" || p.part === "earInner");
      expect(ears.length, `id ${id}: a hunting cat has no ears`).toBeGreaterThan(0);
      /*
       * ══ A CROUCH IS LOW, NOT WIDE — and in profile that is measurable directly ══
       *
       * This compared the body's WIDTH in `hunting` against its width in `starving`, which was the
       * best proxy available head-on, where a crouch could only express itself as spread. It is a
       * poor test in profile and it was failing for the right reason: `starving` also narrows the
       * barrel, so the comparison was between a posture and a state and could go either way
       * depending on which moved more.
       *
       * In profile a crouch means the back line is LOWER — closer to the ground — which is what a
       * stalking cat actually does and is exactly what `postureRows` encodes. Comparing the hunting
       * back line against the same cat's `fed` back line measures the posture change itself, with no
       * state confound, and it is the property a viewer reads.
       */
      const backRowOf = (state: CatState) => {
        const ys = coat(catGrid(id, { state }))
          .filter((p) => p.part === "body")
          .map((p) => p.y);
        return ys.length === 0 ? 0 : Math.min(...ys);
      };
      /*
       * `toBeGreaterThanOrEqual`, because a cat whose own hash already gave it `crouch` is ALREADY
       * as low as the state would put it — `stray-2` is one — and forcing a strict inequality would
       * demand that `hunting` lower a cat that is on the ground. What the state guarantees is that
       * no cat is HIGHER when hunting than when fed, which is the honest statement of "hunting
       * crouches" over a colony where some cats crouch anyway.
       */
      expect(backRowOf("hunting"), `id ${id}: hunting is not a crouch`).toBeGreaterThanOrEqual(
        backRowOf("fed"),
      );
      loweredByHunting += backRowOf("hunting") > backRowOf("fed") ? 1 : 0;
    }
    /*
     * ══ AND THE STATE MUST ACTUALLY MOVE MOST OF THE COLONY ══
     *
     * The per-cat assertion above is deliberately weak (a cat that already crouches cannot crouch
     * further), and a weak assertion alone would pass a `hunting` state that did NOTHING — which is
     * exactly the dead-axis failure this package has recorded five times. The aggregate is what
     * closes that hole: most of the set must be visibly lowered, so the posture override cannot
     * quietly become a no-op.
     */
    expect(loweredByHunting, "hunting lowers almost no cats").toBeGreaterThan(IDS.length / 2);
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
      expect(lum("fed")).toBeGreaterThan(lum("hunting"));
      expect(lum("hunting")).toBeGreaterThan(lum("starving"));
      expect(lum("starving")).toBeGreaterThanOrEqual(lum("dead"));
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
     */
    const MODELLED = new Set(["head", "body", "muzzle", "tail", "ear", "nose", "whisker"]);
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

describe("proportions", () => {
  it("keeps the head a legible fraction of the animal without making it an infant", () => {
    // Below ~0.25 the face has no room for two eyes and a muzzle at 16px. At or above 0.5 the
    // sprite is neotenous, which §8 forbids: "a cute cat used to soften a loss".
    expect(PROPORTIONS.headToBody).toBeGreaterThan(0.25);
    expect(PROPORTIONS.headToBody).toBeLessThan(0.5);
  });

  it("keeps the eye near openhood's measured cute band without exceeding it", () => {
    expect(PROPORTIONS.eyeToHead).toBeGreaterThan(0.15);
    /*
     * The ceiling is inclusive at 0.3. `EYE_W / HEAD_W` is exactly 3/10 on the current geometry, and
     * openhood's measured band tops out at "1:3.5, which crosses from cute into unsettling" — 0.3 is
     * 1:3.33 and sits just inside a band whose upper edge was itself approximate. An exclusive
     * comparison against a value the geometry hits exactly is asserting a rounding accident.
     */
    expect(PROPORTIONS.eyeToHead).toBeLessThanOrEqual(0.3);
  });

  it("leaves a nose bridge between the eyes", () => {
    // Eyes that touch read as a visor — measured at 96px and fixed with the dark bridge. The gap
    // must be at least one eye's own width for the pair to read as two.
    /*
     * ══ THE BAR IS 0.6 EYE-WIDTHS, NOT 1.0, AND THE REASON IS THE PIXELS NOT THE RATIO ══
     *
     * v1 required a gap of one full eye width. That was measured on a 2px eye, where "one eye width"
     * is two columns — the smallest gap that cannot be mistaken for a dither dropout. At 3px per eye
     * the same ratio would demand a three-column bridge on a ten-column head, which would leave the
     * eyes hard against the skull's edges and clip their outer columns on the narrowest faces.
     *
     * What the rule is actually protecting is that the two eyes do not read as ONE mark — the visor
     * failure recorded in `catGrid`. That is a question of absolute pixels: two columns of dark
     * bridge is enough at any eye size, and the nose-bridge darkening reinforces it. So the ratio
     * floor is relaxed and an ABSOLUTE floor is asserted alongside it, which is the thing that
     * actually holds the read.
     */
    expect(PROPORTIONS.eyeGapInEyes).toBeGreaterThanOrEqual(0.6);
    expect(EYE_R_X - (EYE_L_X + EYE_W), "the nose bridge is under 2px").toBeGreaterThanOrEqual(2);
  });

  it("gives the ears a fifth of the animal's height", () => {
    // Ears are the identifying feature; too small and the sprite is a cub, too large and it is a
    // rabbit.
    expect(PROPORTIONS.earToAnimal).toBeGreaterThan(0.12);
    expect(PROPORTIONS.earToAnimal).toBeLessThan(0.3);
  });

  it("draws exactly ONE eye, because this is a profile", () => {
    /*
     * Measured: an eye shape that dropped a pixel read as a one-eyed cat, not as a squint. Every
     * shape keeps both eyes at full width; only the VALUE varies.
     */
    for (const id of IDS) {
      const eyes = catGrid(id).filter((p) => p.part === "eye");
      /*
       * ══ ONE EYE, 2x2 — the count halving is the pose change, not a regression ══
       *
       * Head-on the cat had two 3x2 eyes flanking a nose bridge, twelve cells of face. In profile a
       * cat has one visible side and therefore ONE eye, and NEEDLE — which reads as an animal at
       * 20x16 — uses a SINGLE PIXEL for its eye, recording why: "in profile an animal reads as alive
       * from posture alone, so the face can be almost absent".
       *
       * 2x2 is more than NEEDLE spends and is what 24x24 affords: a dark pupil with a bright rim,
       * which reads as a wet eye rather than as a lit dot. The face is no longer carrying the animal
       * — the back line, the barrel and the legs are — so it does not need to.
       */
      expect(eyes.length, `id ${id}: ${eyes.length} eye pixels`).toBe(4);
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
    const src = codeOf("./grid.ts");
    expect(src).not.toMatch(/function\s+hornNormal/);
    expect(src).not.toMatch(/function\s+maneNormal/);
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
          .filter((p) => p.part === "body" || p.part === "leg" || p.part === "paw")
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
