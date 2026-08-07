/**
 * Tests for the mechanism kit.
 *
 * Two things are under test. First the maths: a wave must actually propagate, a hash must
 * actually be stable, dithering must actually reduce banding. Second — and this is the one
 * that matters for why the kit exists — RANGE: the same function must produce visibly
 * different character from different parameters. If it does not, it is a template with
 * arguments, and every project built on it will look like every other.
 */

import { describe, expect, it } from "vitest";
import {
  BAYER_4,
  bayer4,
  chase,
  clamp,
  curlNoise,
  damp,
  fnv1a,
  hash2,
  incommensurate,
  lerp,
  metaballDensity,
  quantise,
  rampAt,
  ratchetedProgress,
  shadeSphere,
  smoothstep,
  stableValue,
  travellingWave,
  valueNoise,
  widthProfile,
} from "./mechanisms.js";

describe("fnv1a — stable identity", () => {
  it("returns the same value for the same input, forever", () => {
    expect(fnv1a("token-42")).toBe(fnv1a("token-42"));
  });

  it("separates inputs that differ by one character", () => {
    expect(fnv1a("token-42")).not.toBe(fnv1a("token-43"));
  });

  it("stays inside uint32", () => {
    for (const s of ["", "a", "a much longer identifier than the others", "0x9553161e"]) {
      const h = fnv1a(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it("uses 32-bit wraparound, which is why Math.imul is required", () => {
    // Without Math.imul, JS floats lose the low bits on the multiply and long strings collapse
    // toward a handful of values. A spread this wide over similar inputs proves the wraparound.
    const values = new Set(Array.from({ length: 200 }, (_, i) => fnv1a(`item-${i}`) % 1000));
    expect(values.size).toBeGreaterThan(150);
  });

  it("spreads similar ids across the whole output range", () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 1000; i++) {
      const bucket = Math.floor((fnv1a(`0xabc${i}`) / 0x100000000) * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    // Every tenth of the range gets used. A weak hash leaves gaps.
    expect(buckets.every((b) => b > 0)).toBe(true);
  });
});

describe("stableValue — the scrapbook tilt", () => {
  it("is stable across calls, which Math.random() is not", () => {
    expect(stableValue("card-7", -2.6, 2.6)).toBe(stableValue("card-7", -2.6, 2.6));
  });

  it("stays inside the requested range", () => {
    for (let i = 0; i < 500; i++) {
      const v = stableValue(`card-${i}`, -2.6, 2.6);
      expect(v).toBeGreaterThanOrEqual(-2.6);
      expect(v).toBeLessThanOrEqual(2.6);
    }
  });

  it("gives different items different values", () => {
    const values = new Set(
      Array.from({ length: 50 }, (_, i) => stableValue(`card-${i}`, -2.6, 2.6)),
    );
    expect(values.size).toBeGreaterThan(45);
  });

  it("serves any range — a hue as readily as a tilt", () => {
    const hue = stableValue("user-1", 0, 360);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThanOrEqual(360);
  });
});

describe("noise", () => {
  it("hash2 is deterministic and bounded", () => {
    expect(hash2(3, 7)).toBe(hash2(3, 7));
    for (let i = 0; i < 100; i++) {
      const v = hash2(i * 0.37, i * 1.11);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("valueNoise is continuous — neighbours do not jump", () => {
    // The property that makes it noise rather than static. A large jump over a small step
    // would mean the interpolation is broken and the field would look like TV snow.
    let maxJump = 0;
    for (let x = 0; x < 20; x += 0.05) {
      maxJump = Math.max(maxJump, Math.abs(valueNoise(x, 4) - valueNoise(x + 0.05, 4)));
    }
    expect(maxJump).toBeLessThan(0.25);
  });

  it("valueNoise still varies over distance", () => {
    const samples = Array.from({ length: 50 }, (_, i) => valueNoise(i * 0.7, 2.3));
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.3);
  });

  it("curlNoise is divergence-free, which is why particles swirl and never clump", () => {
    // Numerically: ∂x/∂x + ∂y/∂y ≈ 0. This is the whole reason to prefer curl over an angle
    // field — if this fails, particles will pool in sinks and the effect dies.
    const e = 0.01;
    let worst = 0;
    for (const [x, y] of [
      [1.5, 2.5],
      [10.2, 4.8],
      [0.3, 9.1],
    ] as const) {
      const [ax] = curlNoise(x + e, y);
      const [bx] = curlNoise(x - e, y);
      const [, ay] = curlNoise(x, y + e);
      const [, by] = curlNoise(x, y - e);
      worst = Math.max(worst, Math.abs((ax - bx) / (2 * e) + (ay - by) / (2 * e)));
    }
    expect(worst).toBeLessThan(0.5);
  });
});

describe("motion primitives", () => {
  it("chase converges toward the target", () => {
    let v = 0;
    for (let i = 0; i < 100; i++) v = chase(v, 10, 0.1);
    expect(v).toBeCloseTo(10, 1);
  });

  it("chase never overshoots with a sane rate", () => {
    let v = 0;
    for (let i = 0; i < 200; i++) {
      v = chase(v, 10, 0.3);
      expect(v).toBeLessThanOrEqual(10.0001);
    }
  });

  it("chase with deltaSeconds is frame-rate independent", () => {
    // One second of motion must land in the same place whether delivered as 60 frames or 30.
    let a = 0;
    for (let i = 0; i < 60; i++) a = chase(a, 100, 0.1, 1 / 60);
    let b = 0;
    for (let i = 0; i < 30; i++) b = chase(b, 100, 0.1, 1 / 30);
    expect(Math.abs(a - b)).toBeLessThan(0.5);
  });

  it("damp is frame-rate independent too", () => {
    let a = 100;
    for (let i = 0; i < 60; i++) a = damp(a, 0.94, 1 / 60);
    let b = 100;
    for (let i = 0; i < 120; i++) b = damp(b, 0.94, 1 / 120);
    expect(Math.abs(a - b)).toBeLessThan(0.5);
  });

  it("incommensurate periods do not re-sync on a short cycle", () => {
    const [a, b, c] = incommensurate(4, 3) as [number, number, number];
    // If any pair had a small integer ratio the motion would visibly repeat.
    for (const pair of [
      [a, b],
      [b, c],
      [a, c],
    ] as const) {
      const ratio = pair[1] / pair[0];
      expect(Math.abs(ratio - Math.round(ratio))).toBeGreaterThan(0.15);
    }
  });
});

describe("travellingWave — and its RANGE", () => {
  const head = { x: 100, y: 100, angle: 0 };

  it("builds the requested number of joints, connected at the right spacing", () => {
    const joints = travellingWave({
      segments: 12,
      segmentLength: 18,
      head,
      time: 1,
      amplitude: 0.25,
      speed: 2.5,
      phaseLag: 0.5,
    });
    expect(joints).toHaveLength(12);
    for (let i = 1; i < joints.length; i++) {
      const a = joints[i - 1];
      const b = joints[i];
      if (!a || !b) throw new Error("joint missing");
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(18, 5);
    }
  });

  it("propagates — the tail lags the head rather than moving with it", () => {
    // This is the property that makes it swim. Without the phase lag every joint would share
    // one angle offset and the chain would wave as a rigid stick.
    const joints = travellingWave({
      segments: 12,
      segmentLength: 18,
      head,
      time: 0.4,
      amplitude: 0.4,
      speed: 2.5,
      phaseLag: 0.5,
    });
    const offsets = joints.slice(1).map((j, i) => j.angle - (joints[i]?.angle ?? 0));
    // Some joints bend one way while others bend the other — a wave in the body, not a swing.
    expect(Math.max(...offsets)).toBeGreaterThan(0);
    expect(Math.min(...offsets)).toBeLessThan(0);
  });

  it("keeps the head stiffer than the tail", () => {
    const joints = travellingWave({
      segments: 20,
      segmentLength: 10,
      head,
      time: 0.9,
      amplitude: 0.5,
      speed: 3,
      phaseLag: 0.35,
    });
    const bend = (i: number) => {
      const here = joints[i];
      const prev = joints[i - 1];
      if (here === undefined || prev === undefined) throw new Error(`joint ${i} missing`);
      return Math.abs(here.angle - prev.angle);
    };
    const nearHead = (bend(1) + bend(2) + bend(3)) / 3;
    const nearTail = (bend(17) + bend(18) + bend(19)) / 3;
    expect(nearTail).toBeGreaterThan(nearHead);
  });

  it("RANGE: a koi and a ribbon are the same function with different arguments", () => {
    // The claim the whole kit rests on. If these two produced similar shapes, the kit would be
    // a template and every project built on it would look related.
    const koi = travellingWave({
      segments: 12,
      segmentLength: 18,
      head,
      time: 1.3,
      amplitude: 0.25,
      speed: 2.5,
      phaseLag: 0.5,
    });
    const ribbon = travellingWave({
      segments: 4,
      segmentLength: 60,
      head,
      time: 1.3,
      amplitude: 0.9,
      speed: 0.7,
      phaseLag: 1.6,
    });
    expect(koi).toHaveLength(12);
    expect(ribbon).toHaveLength(4);
    const spread = (j: typeof koi) => Math.max(...j.map((p) => Math.abs(p.y - 100)));
    // Different silhouettes, not a rescaled version of one shape.
    expect(Math.abs(spread(koi) - spread(ribbon))).toBeGreaterThan(10);
  });

  it("handles a single-segment chain without inventing joints", () => {
    const joints = travellingWave({
      segments: 1,
      segmentLength: 10,
      head,
      time: 0,
      amplitude: 0.3,
      speed: 1,
      phaseLag: 0.5,
    });
    expect(joints).toEqual([head]);
  });
});

describe("widthProfile", () => {
  it("peaks where asked and never drops below the floor", () => {
    const at = (ratio: number) =>
      widthProfile({ ratio, max: 30, peak: 0.25, spread: 0.3, floor: 4.5 });
    expect(at(0.25)).toBeCloseTo(30, 5);
    expect(at(0.25)).toBeGreaterThan(at(0.6));
    expect(at(1)).toBeGreaterThanOrEqual(4.5);
  });

  it("RANGE: moving the peak changes the creature", () => {
    const fish = widthProfile({ ratio: 0.25, max: 30, peak: 0.25, spread: 0.3, floor: 4 });
    const leaf = widthProfile({ ratio: 0.25, max: 30, peak: 0.5, spread: 0.3, floor: 4 });
    expect(fish).toBeGreaterThan(leaf);
  });
});

describe("dithering and quantisation", () => {
  it("the Bayer matrix is the canonical 4x4 — every value 0..15 exactly once", () => {
    const flat = BAYER_4.flat().sort((a, b) => a - b);
    expect(flat).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it("bayer4 is centred on zero, so dithering brightens as often as it darkens", () => {
    let sum = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) sum += bayer4(x, y);
    expect(Math.abs(sum)).toBeLessThan(1e-9);
  });

  it("bayer4 tiles every 4px", () => {
    expect(bayer4(1, 2)).toBe(bayer4(5, 6));
    expect(bayer4(0, 0)).toBe(bayer4(4, 4));
  });

  it("quantise returns an index inside the ramp, always", () => {
    for (const v of [-1, 0, 0.5, 1, 2]) {
      for (let x = 0; x < 4; x++) {
        const i = quantise({ value: v, steps: 8, x, y: 1 });
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThanOrEqual(7);
        expect(Number.isInteger(i)).toBe(true);
      }
    }
  });

  it("dithering breaks banding: one luminance maps to more than one index across a tile", () => {
    // The entire point. Without the Bayer offset a flat value would produce one index
    // everywhere, which is the banding this exists to remove.
    const indices = new Set<number>();
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) indices.add(quantise({ value: 0.5, steps: 6, x, y }));
    }
    expect(indices.size).toBeGreaterThan(1);
  });

  it("strength 0 disables dithering, so a caller can opt out", () => {
    const indices = new Set<number>();
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        indices.add(quantise({ value: 0.5, steps: 6, x, y, strength: 0 }));
      }
    }
    expect(indices.size).toBe(1);
  });
});

describe("shadeSphere — and its RANGE", () => {
  const light = [0.5, -0.5, Math.SQRT1_2] as const;

  it("returns null outside the circle, distinguishing 'no surface' from 'black'", () => {
    expect(shadeSphere({ nx: 1.2, ny: 0, light })).toBeNull();
    expect(shadeSphere({ nx: 0.9, ny: 0.9, light })).toBeNull();
  });

  it("returns a 0..1 luminance everywhere inside", () => {
    for (let ny = -0.95; ny <= 0.95; ny += 0.1) {
      for (let nx = -0.95; nx <= 0.95; nx += 0.1) {
        const l = shadeSphere({ nx, ny, light });
        if (l === null) continue;
        expect(l).toBeGreaterThanOrEqual(0);
        expect(l).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is brighter toward the light than away from it", () => {
    const lit = shadeSphere({ nx: 0.4, ny: -0.4, light });
    const away = shadeSphere({ nx: -0.4, ny: 0.4, light });
    expect(lit).not.toBeNull();
    expect(away).not.toBeNull();
    expect(lit as number).toBeGreaterThan(away as number);
  });

  it("wrapped diffuse lifts the dark side — the snow-vs-billiard-ball difference", () => {
    const dark = { nx: -0.5, ny: 0.5, light };
    const plain = shadeSphere({ ...dark, wrap: 0 });
    const wrapped = shadeSphere({ ...dark, wrap: 0.8 });
    expect(wrapped as number).toBeGreaterThan(plain as number);
  });

  it("RANGE: a chalk ball and a glass bead differ under the same geometry", () => {
    const p = { nx: 0.35, ny: -0.35, light } as const;
    const chalk = shadeSphere({ ...p, specularPower: 2, ambient: 0.45, wrap: 0.9 });
    const glass = shadeSphere({ ...p, specularPower: 120, ambient: 0.05, wrap: 0 });
    expect(Math.abs((chalk as number) - (glass as number))).toBeGreaterThan(0.15);
  });

  it("does NOT saturate most of the sphere to flat white", () => {
    /**
     * Regression for a real bug this suite caught. The specular term used an un-normalised
     * half-vector, so raising it to a power reached 4047 and clipped 43% of the surface to 1.
     * Over that region ambient, wrap and specularPower had NO effect — a parameterised shader
     * whose parameters do nothing. Normalising the half-vector bounds the term to 0..1.
     */
    let saturated = 0;
    let total = 0;
    for (let ny = -0.95; ny <= 0.95; ny += 0.05) {
      for (let nx = -0.95; nx <= 0.95; nx += 0.05) {
        const l = shadeSphere({ nx, ny, light });
        if (l === null) continue;
        total++;
        if (l >= 1) saturated++;
      }
    }
    expect(saturated / total).toBeLessThan(0.05);
  });

  it("every parameter still moves the result — otherwise the kit is a template", () => {
    const p = { nx: 0.3, ny: -0.3, light } as const;
    const base = shadeSphere(p) as number;
    expect(shadeSphere({ ...p, ambient: 0.8 }) as number).not.toBeCloseTo(base, 3);
    expect(shadeSphere({ ...p, wrap: 0 }) as number).not.toBeCloseTo(base, 3);
    expect(shadeSphere({ ...p, specularPower: 2 }) as number).not.toBeCloseTo(base, 3);
  });

  it("composes with quantise into a stepped ramp index", () => {
    const l = shadeSphere({ nx: 0.2, ny: -0.2, light });
    const i = quantise({ value: l as number, steps: 8, x: 3, y: 5 });
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThanOrEqual(7);
  });
});

describe("metaballDensity", () => {
  it("is highest at a centre and zero far away", () => {
    const balls = [{ x: 0, y: 0, radius: 10 }];
    expect(metaballDensity(0, 0, balls)).toBeCloseTo(1, 5);
    expect(metaballDensity(50, 50, balls)).toBe(0);
  });

  it("sums where fields overlap, which is how blobs merge", () => {
    const balls = [
      { x: -4, y: 0, radius: 10 },
      { x: 4, y: 0, radius: 10 },
    ];
    // Between two centres the summed density exceeds either alone — the merge.
    expect(metaballDensity(0, 0, balls)).toBeGreaterThan(
      metaballDensity(0, 0, [{ x: -4, y: 0, radius: 10 }]),
    );
  });

  it("falls off squared — tighter cores than a linear field", () => {
    /**
     * My first version of this test asserted the falloff was convex across 2->5->8 and it
     * failed: (1 - d^2/r^2)^2 is steepest in the MIDDLE of the radius, not at the centre.
     * The code was right and the assertion was wrong. The property that actually
     * distinguishes squared from linear is that it stays HIGHER near the core and drops
     * to zero faster at the rim.
     */
    const balls = [{ x: 0, y: 0, radius: 10 }];
    const squared = (d: number) => metaballDensity(d, 0, balls);
    const linear = (d: number) => Math.max(0, 1 - d / 10);
    expect(squared(2)).toBeGreaterThan(linear(2));
    expect(squared(9)).toBeLessThan(linear(9));
  });

  it("handles an empty field", () => {
    expect(metaballDensity(0, 0, [])).toBe(0);
  });
});

describe("ratchetedProgress", () => {
  it("never goes backwards even when real progress does", () => {
    const a = ratchetedProgress({ actual: 0.6, elapsedSeconds: 1, expectedSeconds: 4 });
    const b = ratchetedProgress({
      actual: 0.3,
      elapsedSeconds: 1.1,
      expectedSeconds: 4,
      previous: a,
    });
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("creeps forward on time alone, so it never looks stalled", () => {
    const early = ratchetedProgress({ actual: 0, elapsedSeconds: 0.5, expectedSeconds: 4 });
    const later = ratchetedProgress({ actual: 0, elapsedSeconds: 2, expectedSeconds: 4 });
    expect(later).toBeGreaterThan(early);
  });

  it("time alone can NEVER reach 1 — the bar finishes only when the work does", () => {
    // The cardinal sin this exists to prevent is a bar that completes while the app is still
    // loading. If this ever passes 1 on time alone, the mechanism is broken.
    for (const elapsed of [10, 100, 10000]) {
      const v = ratchetedProgress({ actual: 0, elapsedSeconds: elapsed, expectedSeconds: 4 });
      expect(v).toBeLessThanOrEqual(0.92);
      expect(v).toBeLessThan(1);
    }
  });

  it("real progress overrides the floor when it is ahead", () => {
    expect(
      ratchetedProgress({ actual: 0.99, elapsedSeconds: 0.1, expectedSeconds: 10 }),
    ).toBeCloseTo(0.99, 5);
  });

  it("survives a zero expected duration without dividing by zero", () => {
    const v = ratchetedProgress({ actual: 0, elapsedSeconds: 1, expectedSeconds: 0 });
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe("rampAt — the float-valued theme", () => {
  const ramp = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ];

  it("returns exact stops at integer positions", () => {
    expect(rampAt(ramp, 0)).toEqual([255, 0, 0]);
    expect(rampAt(ramp, 1)).toEqual([0, 255, 0]);
    expect(rampAt(ramp, 2)).toEqual([0, 0, 255]);
  });

  it("blends between stops — the reason stage is a float and not an enum", () => {
    expect(rampAt(ramp, 0.5)).toEqual([127.5, 127.5, 0]);
  });

  it("clamps outside the ramp instead of wrapping or throwing", () => {
    expect(rampAt(ramp, -5)).toEqual([255, 0, 0]);
    expect(rampAt(ramp, 99)).toEqual([0, 0, 255]);
  });

  it("handles an empty ramp", () => {
    expect(rampAt([], 0.5)).toEqual([]);
  });

  it("works for any tuple width, not just RGB", () => {
    expect(rampAt([[0], [10]], 0.25)).toEqual([2.5]);
  });
});

describe("small helpers", () => {
  it("clamp holds the range", () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(2)).toBe(1);
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("lerp hits both ends", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it("smoothstep is flat at both edges — that is what makes it smooth", () => {
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 1)).toBe(1);
    // Derivative near the edges is smaller than in the middle.
    const nearEdge = smoothstep(0, 1, 0.05) - smoothstep(0, 1, 0);
    const middle = smoothstep(0, 1, 0.55) - smoothstep(0, 1, 0.5);
    expect(middle).toBeGreaterThan(nearEdge);
  });

  it("smoothstep survives a zero-width range", () => {
    expect(smoothstep(1, 1, 0)).toBe(0);
    expect(smoothstep(1, 1, 2)).toBe(1);
  });
});
