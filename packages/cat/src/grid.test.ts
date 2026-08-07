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
  catGrid,
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

  it("stays inside the 16x16 grid", () => {
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
      const ears = grid.filter((p) => p.part === "ear");
      expect(ears.length).toBeGreaterThan(0);
      // The ear's own lowest row per column must have a head pixel one row below it.
      const lowestByCol = new Map<number, number>();
      for (const e of ears) {
        const cur = lowestByCol.get(e.x);
        if (cur === undefined || e.y > cur) lowestByCol.set(e.x, e.y);
      }
      for (const [x, y] of lowestByCol) {
        const below = at.get((y + 1) * GRID_W + x);
        expect(
          below !== undefined && below.part !== "outline",
          `id ${id}: ear column ${x} has no body pixel beneath row ${y}`,
        ).toBe(true);
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
      const touching = tail.some((t) =>
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => at.get((t.y + (dy ?? 0)) * GRID_W + t.x + (dx ?? 0))?.part === "body"),
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

describe("silhouette rule 2 — a shaded separator between head and body", () => {
  /**
   * NEEDLE: "HEAD AND BODY WERE ONE MASS. Both were `i` with no separation, so the silhouette was
   * an amoeba. There is now a shaded neck line between them, which is what makes a quadruped read
   * as having a head at all."
   */

  it("draws the neck row at least NECK_STEP_DROP steps below the head above it", () => {
    for (const id of IDS) {
      const at = index(catGrid(id));
      const headRow = ROWS.head[1] - 1;
      for (let x = 0; x < GRID_W; x++) {
        const neck = at.get(NECK_ROW * GRID_W + x);
        const head = at.get(headRow * GRID_W + x);
        if (neck?.part !== "body") continue;
        if (head === undefined || head.part === "outline") continue;
        expect(
          head.step - neck.step,
          `id ${id}: column ${x} has no neck break (head ${head.step}, neck ${neck.step})`,
        ).toBeGreaterThanOrEqual(NECK_STEP_DROP);
      }
    }
  });

  it("keeps the neck row darker than the body below it too", () => {
    // A separator that is darker than the head but the same as the body is not a separator, it is
    // just the top of the body. It has to be a local MINIMUM to read as a break.
    for (const id of IDS) {
      const at = index(catGrid(id));
      for (let x = 0; x < GRID_W; x++) {
        const neck = at.get(NECK_ROW * GRID_W + x);
        const below = at.get((NECK_ROW + 1) * GRID_W + x);
        if (neck?.part !== "body" || below?.part !== "body") continue;
        expect(neck.step, `id ${id}: column ${x} neck not darker than body`).toBeLessThan(
          below.step,
        );
      }
    }
  });

  it("pinches the silhouette at the neck as well as shading it", () => {
    /*
     * The value break needs a SHAPE to reinforce — this was measured. When the head was exactly as
     * wide as the haunch, the break rendered as a stripe across a slab rather than as a neck. The
     * neck row must therefore be narrower than the widest row of the body below it.
     */
    for (const id of IDS) {
      const grid = catGrid(id);
      const width = (row: number): number => {
        const xs = grid.filter((p) => p.y === row && p.part !== "outline").map((p) => p.x);
        return xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs) + 1;
      };
      const haunch = width(ROWS.legs[0] - 1);
      expect(width(NECK_ROW), `id ${id}: no pinch at the neck`).toBeLessThan(haunch);
    }
  });
});

describe("silhouette rule 3 — legs 2px wide, paired with a visible gap", () => {
  /**
   * NEEDLE: "THE LEGS WERE AMBIGUOUS. Four 1px verticals at even spacing read as a fringe. They
   * are now 2px wide, paired front and back with a visible gap."
   */

  it("makes every leg exactly 2px wide on every leg row", () => {
    for (const id of IDS) {
      const grid = catGrid(id);
      for (let y = ROWS.legs[0]; y < ROWS.legs[1]; y++) {
        const xs = grid
          .filter((p) => p.part === "leg" && p.y === y)
          .map((p) => p.x)
          .sort((a, b) => a - b);
        expect(xs.length, `id ${id}: row ${y} has ${xs.length} leg pixels`).toBe(4);
        // Two runs of exactly two.
        const runs: number[][] = [];
        for (const x of xs) {
          const last = runs[runs.length - 1];
          if (last && x === (last[last.length - 1] ?? -9) + 1) last.push(x);
          else runs.push([x]);
        }
        expect(runs.length, `id ${id}: row ${y} does not have two leg runs`).toBe(2);
        for (const r of runs) expect(r.length, `id ${id}: a leg is ${r.length}px wide`).toBe(2);
      }
    }
  });

  it("leaves a visible gap between the two legs", () => {
    // A gap of one pixel is a dither dropout. It has to be at least two to read as a gap.
    for (const id of IDS) {
      const grid = catGrid(id);
      const xs = grid
        .filter((p) => p.part === "leg" && p.y === ROWS.legs[0])
        .map((p) => p.x)
        .sort((a, b) => a - b);
      const left = xs[1] ?? 0;
      const right = xs[2] ?? 0;
      expect(right - left - 1, `id ${id}: leg gap too narrow`).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps the legs a different value from the body above them", () => {
    // 2px posts that are the same step as the haunch are not legs, they are the bottom of the
    // body. The rule is about legibility, and legibility here is value as much as width.
    for (const id of IDS) {
      const at = index(catGrid(id));
      const leg = [...at.values()].find((p) => p.part === "leg");
      const body = [...at.values()].find((p) => p.part === "body" && p.y === ROWS.legs[0] - 1);
      expect(leg).toBeDefined();
      expect(body).toBeDefined();
      if (!leg || !body) continue;
      expect(leg.step, `id ${id}: legs do not separate from the haunch`).not.toBe(body.step);
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

  it("changes the SILHOUETTE not at all between states", () => {
    /*
     * The other half of the ban. State may change values; it may not change the animal. If a
     * starving cat had a different outline from a fed one, the sprite would be encoding state in
     * geometry — and §8 bans invented geometry as firmly as it bans colour.
     */
    for (const id of IDS) {
      const shapeOf = (state: CatState) =>
        catGrid(id, { state })
          .map((p) => `${p.x},${p.y},${p.part}`)
          .sort()
          .join(";");
      const base = shapeOf("fed");
      for (const state of STATES) expect(shapeOf(state)).toBe(base);
    }
  });

  it("dims the coat monotonically from fed to dead", () => {
    // The state has to be readable at a glance, which means the ordering must hold in total
    // luminance and not merely per-pixel.
    for (const id of IDS) {
      const lum = (state: CatState) =>
        coat(catGrid(id, { state }))
          .filter((p) => p.part !== "eye")
          .reduce((a, p) => a + p.step, 0);
      expect(lum("fed")).toBeGreaterThan(lum("hunting"));
      expect(lum("hunting")).toBeGreaterThan(lum("starving"));
      expect(lum("starving")).toBeGreaterThan(lum("dead"));
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
    expect(PROPORTIONS.eyeToHead).toBeLessThan(0.3);
  });

  it("leaves a nose bridge between the eyes", () => {
    // Eyes that touch read as a visor — measured at 96px and fixed with the dark bridge. The gap
    // must be at least one eye's own width for the pair to read as two.
    expect(PROPORTIONS.eyeGapInEyes).toBeGreaterThanOrEqual(1);
  });

  it("gives the ears a fifth of the animal's height", () => {
    // Ears are the identifying feature; too small and the sprite is a cub, too large and it is a
    // rabbit.
    expect(PROPORTIONS.earToAnimal).toBeGreaterThan(0.12);
    expect(PROPORTIONS.earToAnimal).toBeLessThan(0.3);
  });

  it("draws exactly two eyes of EYE_W pixels each in every shape", () => {
    /*
     * Measured: an eye shape that dropped a pixel read as a one-eyed cat, not as a squint. Every
     * shape keeps both eyes at full width; only the VALUE varies.
     */
    for (const id of IDS) {
      const eyes = catGrid(id).filter((p) => p.part === "eye");
      expect(eyes.length, `id ${id}: ${eyes.length} eye pixels`).toBe(EYE_W * 2);
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
    const src = readFileSync(fileURLToPath(new URL("./grid.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/Math\s*\.\s*random/);
  });

  it("contains no Math.random in the renderer either", () => {
    const src = readFileSync(fileURLToPath(new URL("./render.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/Math\s*\.\s*random/);
  });

  it("keeps hornNormal and maneNormal deleted", () => {
    // The brief is explicit that these are removed rather than left unused. A dead `hornNormal`
    // sitting in the file is an invitation for a later edit to call it.
    const src = readFileSync(fileURLToPath(new URL("./grid.ts", import.meta.url)), "utf8");
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
