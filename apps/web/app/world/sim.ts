/**
 * THE WORLD SIMULATION — pure, deterministic-under-injected-random, renderer-free.
 *
 * Ported in METHOD from `silvertongue/apps/web/app/world/sim.ts`, whose two load-bearing decisions
 * are inherited verbatim because both were measured rather than chosen:
 *
 * ══ 1. FIXED TIMESTEP + RENDER INTERPOLATION ══
 *
 * The sim ticks at a fixed 30 Hz; the renderer interpolates between the previous and current tick
 * at display rate. AI Town ships this as history-buffer interpolation and the primary canvas
 * benchmark gives 2-3x headroom from it. It also makes motion IDENTICAL on a 60 Hz laptop and a
 * 144 Hz monitor, which a `dt`-scaled variable step does not.
 *
 * ══ 2. REYNOLDS WANDER WITH RETAINED STEERING STATE ══
 *
 * Each body keeps a `wanderAngle` that DRIFTS a little per tick rather than being resampled.
 * silvertongue's finding, quoted: *"a fresh random force per frame is measurably twitchy — the
 * retained angle is what makes roaming read as intent rather than noise."* This is the single
 * difference between a cat that is walking somewhere and a cat vibrating in place.
 *
 * ══ WHAT THIS FILE ADDS THAT SILVERTONGUE'S DOES NOT HAVE ══
 *
 * Silvertongue's bodies negotiate: two agents approach a midpoint and talk. A stray HUNTS, and a
 * hunt is not symmetric — there is a predator and there is a quarry, and the quarry does not walk
 * to meet the cat. So the mode set is a predation cycle rather than a meeting:
 *
 *   PROWL   → no position. Reynolds wander. The ambient state, and the one most cats are in.
 *   STALK   → the cat has entered a position and is closing on that token. Low and fast.
 *   POUNCE  → the last few pixels, at speed, with an arrival ease. The beat that reads as a KILL.
 *   HOLD    → the cat is in the position. It orbits its token and does not leave it.
 *   DRAG    → exited at a PROFIT. It walks its kill back to the den, which is what "brings back
 *             what it kills" looks like as motion.
 *   SLINK   → exited at a LOSS. Back to the den too, but slower and by a wider arc.
 *
 * The state a body is in is DERIVED from chain (`holding !== null` ⇒ stalk/hold) and from the
 * decision log (an `Exited` event ⇒ drag or slink). Nothing here invents a hunt: a cat with no
 * holding and no recent exit prowls, forever, and that is the honest rendering of an idle colony.
 *
 * Everything is a plain function over plain data so it unit-tests without a canvas or a browser.
 */

const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

export type SimMode = "prowl" | "stalk" | "pounce" | "hold" | "drag" | "slink";

export type SimBody = {
  readonly id: string;
  x: number;
  y: number;
  /** Previous-tick position — the interpolation source. Never read by the sim itself. */
  px: number;
  py: number;
  vx: number;
  vy: number;
  /** The RETAINED steering angle. See the header: this is what makes roaming read as intent. */
  wanderAngle: number;
  radius: number;
  mode: SimMode;
  /** Seek target: the quarry's position while hunting, the den while returning. */
  tx: number | null;
  ty: number | null;
  /** The token address this body is hunting or holding, so the renderer can draw the tether. */
  quarry: string | null;
  /** Which way the sprite faces. Latched, so a cat does not flip on sub-pixel jitter. */
  facing: 1 | -1;
  /** Ticks spent in the current mode — drives the pounce timeout and the drag's arrival. */
  modeTicks: number;
  /** 0..1, eases up during a pounce and decays after. The renderer scales the sprite by it. */
  lunge: number;
};

/** A token in the field. It does not move under its own power — quarry is scenery that can die. */
export type SimToken = {
  readonly address: string;
  readonly symbol: string;
  x: number;
  y: number;
  /** Slow bob, so the field is never fully static even with zero cats. */
  phase: number;
  radius: number;
  readonly huntable: boolean;
};

export type Sim = {
  width: number;
  height: number;
  readonly bodies: Map<string, SimBody>;
  readonly tokens: Map<string, SimToken>;
  readonly random: () => number;
  /** Where a cat drags its kill back to. Recomputed on resize; never null after `resizeSim`. */
  den: { x: number; y: number };
};

export function createSim(width: number, height: number, random: () => number): Sim {
  return {
    width,
    height,
    bodies: new Map(),
    tokens: new Map(),
    random,
    den: denFor(width, height),
  };
}

/**
 * THE DEN — bottom-left, inset by a fraction rather than a constant.
 *
 * A fixed pixel inset would put the den off-screen on a 320px phone and in the middle of nowhere on
 * a 1440px desktop. Fractions of the field keep it in the same PLACE in the composition at every
 * width, which is what makes "it went home" legible without a label.
 */
function denFor(width: number, height: number): { x: number; y: number } {
  return { x: width * 0.13, y: height * 0.8 };
}

export function resizeSim(sim: Sim, width: number, height: number): void {
  const sx = width / Math.max(1, sim.width);
  const sy = height / Math.max(1, sim.height);
  sim.width = width;
  sim.height = height;
  sim.den = denFor(width, height);
  /*
   * SCALE existing positions rather than leaving them.
   *
   * On an orientation change or a desktop window drag, every body keeps absolute coordinates that
   * may now be off-field. The soft containment in `step` would eventually walk them back, but
   * "eventually" is several seconds of cats stuck against an edge — and on a shrink it is cats
   * that are simply GONE from the visible field, which reads as the world being empty. Scaling is
   * instant and preserves the relative composition.
   */
  for (const b of sim.bodies.values()) {
    b.x *= sx;
    b.y *= sy;
    b.px *= sx;
    b.py *= sy;
    if (b.tx !== null) b.tx *= sx;
    if (b.ty !== null) b.ty *= sy;
  }
  for (const t of sim.tokens.values()) {
    t.x *= sx;
    t.y *= sy;
  }
}

/**
 * RADIUS CARRIES STAKE — silvertongue's rule, in its own words: *"a richer agent is visibly a
 * bigger prize."* Same curve, same floor.
 *
 * `sqrt` rather than linear because stake spans orders of magnitude and a linear map makes every
 * cat below the top one the same minimum dot. The 9px floor exists so a broke cat still reads as a
 * deliberate mark rather than as a stray pixel; the 26px ceiling stops one whale owning the field.
 */
export function radiusForStake(stakeEth: number): number {
  if (!Number.isFinite(stakeEth) || stakeEth <= 0) return 9;
  return Math.max(9, Math.min(26, 9 + Math.sqrt(stakeEth) * 90));
}

/** Market cap sizes a token the same way stake sizes a cat: a fatter target is a bigger shape. */
export function radiusForCap(marketCapEth: number): number {
  if (!Number.isFinite(marketCapEth) || marketCapEth <= 0) return 7;
  return Math.max(7, Math.min(17, 7 + Math.sqrt(marketCapEth) * 3.4));
}

export type AgentInput = {
  readonly id: string;
  readonly stakeEth: number;
  /** The token address this cat currently holds, straight from the vault. Null ⇒ not in a position. */
  readonly holding: string | null;
};

export type TokenInput = {
  readonly address: string;
  readonly symbol: string;
  readonly marketCapEth: number;
  readonly huntable: boolean;
};

/**
 * Sync the token field with what the API actually returned.
 *
 * Tokens that fall off the list LEAVE the field. Nothing is retained to keep the world looking
 * busy — a world padded with tokens that are no longer candidates is a world lying about what the
 * keeper is scanning.
 */
export function syncTokens(sim: Sim, tokens: readonly TokenInput[]): void {
  const live = new Set(tokens.map((t) => t.address));
  for (const key of [...sim.tokens.keys()]) {
    if (!live.has(key)) sim.tokens.delete(key);
  }

  /*
   * Tokens are placed on a JITTERED RING rather than at random.
   *
   * Pure random placement clusters — on a 390px field two of fourteen tokens landing on top of
   * each other is not unlikely, it is expected, and two overlapping labels is the difference
   * between "the tickers are legible" and the whole point of this feature failing. A ring indexed
   * by position gives a guaranteed minimum angular separation; the jitter stops it reading as a
   * clock face.
   */
  const n = Math.max(1, tokens.length);
  tokens.forEach((t, i) => {
    const existing = sim.tokens.get(t.address);
    const radius = radiusForCap(t.marketCapEth);
    if (existing !== undefined) {
      existing.radius = radius;
      return;
    }
    const angle = (i / n) * Math.PI * 2 + (sim.random() - 0.5) * (Math.PI / n);
    // Two rings on a wide field, one on a narrow one — a single ring on 1440px leaves the middle
    // empty and the edges crowded.
    const ringBias = sim.width > 900 && i % 2 === 1 ? 0.62 : 0.86;
    const rx = (sim.width / 2) * 0.78 * ringBias;
    const ry = (sim.height / 2) * 0.66 * ringBias;
    sim.tokens.set(t.address, {
      address: t.address,
      symbol: t.symbol,
      x: sim.width / 2 + Math.cos(angle) * rx,
      y: sim.height / 2 + Math.sin(angle) * ry,
      phase: sim.random() * Math.PI * 2,
      radius,
      huntable: t.huntable,
    });
  });
}

/**
 * Sync the cat set with the real stray list, and set each cat's mode from its real holding.
 *
 * A stray that leaves the chain leaves the field. NOBODY IS INVENTED TO FILL SPACE — an empty
 * colony renders as an empty field with the quarry still moving in it, and the HUD says so in
 * words. That is the honest picture, and it is the one Ibrahim will see today, because the vault
 * has exactly one adopted stray and its stake is zero.
 */
export function syncBodies(sim: Sim, agents: readonly AgentInput[]): void {
  const live = new Set(agents.map((a) => a.id));
  for (const key of [...sim.bodies.keys()]) {
    if (!live.has(key)) sim.bodies.delete(key);
  }

  for (const agent of agents) {
    const radius = radiusForStake(agent.stakeEth);
    const existing = sim.bodies.get(agent.id);
    if (existing === undefined) {
      const margin = 70;
      const x = margin + sim.random() * Math.max(1, sim.width - margin * 2);
      const y = margin + sim.random() * Math.max(1, sim.height - margin * 2);
      sim.bodies.set(agent.id, {
        id: agent.id,
        x,
        y,
        px: x,
        py: y,
        vx: (sim.random() - 0.5) * 0.6,
        vy: (sim.random() - 0.5) * 0.6,
        wanderAngle: sim.random() * Math.PI * 2,
        radius,
        mode: agent.holding === null ? "prowl" : "stalk",
        tx: null,
        ty: null,
        quarry: agent.holding,
        facing: 1,
        modeTicks: 0,
        lunge: 0,
      });
      continue;
    }

    existing.radius = radius;

    /*
     * ══ THE ONE TRANSITION THAT MUST NOT BE SMOOTHED OVER ══
     *
     * When the vault says a cat has ENTERED a position, it must be seen to GO THERE. The tempting
     * shortcut is to set `mode = "hold"` and let the renderer draw it beside the token — the cat
     * would teleport, which is the exact defect the brief names ("cats must not teleport"). So an
     * entry always starts at STALK, and only `step` can promote it to hold, by walking.
     *
     * The guard is `existing.quarry !== agent.holding`: re-entering the SAME token on a later poll
     * must not restart the stalk of a cat that is already holding it.
     */
    if (agent.holding !== null && existing.quarry !== agent.holding) {
      existing.quarry = agent.holding;
      setMode(existing, "stalk");
    } else if (agent.holding === null && existing.quarry !== null) {
      // Exited. The caller decides drag-vs-slink from realised PnL; default is the honest one for
      // an unknown outcome — go home, unremarkably.
      existing.quarry = null;
      if (existing.mode === "hold" || existing.mode === "stalk" || existing.mode === "pounce") {
        setMode(existing, "slink");
      }
    }
  }
}

/** Change mode and reset the mode clock. The ONLY way `mode` should ever be written. */
export function setMode(body: SimBody, mode: SimMode): void {
  if (body.mode === mode) return;
  body.mode = mode;
  body.modeTicks = 0;
}

/**
 * Mark a cat's exit as a WIN — it drags its kill home rather than slinking.
 *
 * Separate from `syncBodies` because the vault's stray struct does not carry "how did the last
 * trade go"; that comes from the `Exited`/`Withdrawn` decision feed. Keeping it a separate call
 * means the sim never has to guess an outcome from a balance delta that could equally be a deposit.
 */
export function markExit(sim: Sim, id: string, profitable: boolean): void {
  const body = sim.bodies.get(id);
  if (body === undefined) return;
  body.quarry = null;
  setMode(body, profitable ? "drag" : "slink");
}

const PROWL_SPEED = 0.55;
const STALK_SPEED = 2.6;
/** The pounce is FAST. This is the only speed in the file tuned for a beat rather than a path. */
const POUNCE_SPEED = 7.5;
const DRAG_SPEED = 1.5;
const SLINK_SPEED = 0.9;

/** Within this many px of the quarry, a stalk becomes a pounce. */
const POUNCE_RANGE = 96;
/** A pounce that has not landed in this many ticks (≈1.3s) gives up and re-stalks — a cat that
 * cannot reach its quarry (because the token left the field mid-pounce) must not fly forever. */
const POUNCE_TIMEOUT_TICKS = 40;

/** ONE FIXED TICK. */
export function step(sim: Sim): void {
  const bodies = [...sim.bodies.values()];

  for (const t of sim.tokens.values()) {
    // Quarry bobs. Ambient motion that costs nothing and means the field is never dead even when
    // the colony is empty — which, today, it is.
    t.phase += 0.021;
  }

  for (const body of bodies) {
    body.px = body.x;
    body.py = body.y;
    body.modeTicks += 1;

    const quarry = body.quarry === null ? null : (sim.tokens.get(body.quarry) ?? null);

    switch (body.mode) {
      case "prowl": {
        // Reynolds wander: DRIFT the retained angle, do not resample it. See the header.
        body.wanderAngle += (sim.random() - 0.5) * 0.45;
        body.vx += Math.cos(body.wanderAngle) * 0.05;
        body.vy += Math.sin(body.wanderAngle) * 0.05;
        clampSpeed(body, PROWL_SPEED);
        break;
      }

      case "stalk": {
        /*
         * A cat whose quarry is not in the field still stalks — toward the den.
         *
         * This happens for real: the vault says the cat holds token X, and X has aged off the
         * newest-launches list the world renders. Freezing the cat would look like a bug and
         * teleporting it to a phantom token would be inventing a position. Walking home is the
         * honest third option, and `quarry === null` in the render means no tether is drawn.
         */
        const target = quarry ?? sim.den;
        seek(body, target.x, target.y, STALK_SPEED, 120);
        if (quarry !== null && dist(body, quarry) < POUNCE_RANGE) setMode(body, "pounce");
        break;
      }

      case "pounce": {
        if (quarry === null || body.modeTicks > POUNCE_TIMEOUT_TICKS) {
          setMode(body, quarry === null ? "prowl" : "stalk");
          break;
        }
        // Ease in over the last 40px so the landing settles rather than overshooting and orbiting.
        seek(body, quarry.x, quarry.y, POUNCE_SPEED, 40);
        // `lunge` eases up across the pounce and the renderer stretches the sprite by it. Capped
        // well below 1 per tick so a 4-tick pounce still has a visible ramp.
        body.lunge = Math.min(1, body.lunge + 0.16);
        if (dist(body, quarry) < body.radius + quarry.radius + 6) setMode(body, "hold");
        break;
      }

      case "hold": {
        if (quarry === null) {
          setMode(body, "slink");
          break;
        }
        /*
         * ORBIT, don't stand.
         *
         * A cat parked at a fixed offset from its token reads as a UI element pinned to another UI
         * element. A slow orbit at a held radius reads as an animal guarding something. Same
         * retained-angle trick as the wander — the angle advances, it is not resampled.
         */
        body.wanderAngle += 0.026;
        const orbit = quarry.radius + body.radius + 12;
        const ox = quarry.x + Math.cos(body.wanderAngle) * orbit;
        const oy = quarry.y + Math.sin(body.wanderAngle) * orbit * 0.62;
        body.vx = (ox - body.x) * 0.16;
        body.vy = (oy - body.y) * 0.16;
        break;
      }

      case "drag":
      case "slink": {
        const speed = body.mode === "drag" ? DRAG_SPEED : SLINK_SPEED;
        seek(body, sim.den.x, sim.den.y, speed, 70);
        // Arrived home. Back to the ambient state, which is where most of a cat's life is spent.
        if (Math.hypot(sim.den.x - body.x, sim.den.y - body.y) < 26) setMode(body, "prowl");
        break;
      }
    }

    // The lunge decays outside a pounce, so the stretch relaxes rather than snapping back.
    if (body.mode !== "pounce") body.lunge *= 0.9;

    body.x += body.vx;
    body.y += body.vy;

    /*
     * Facing is latched on a DEADBAND, not on the sign of vx.
     *
     * A cat orbiting a token crosses vx=0 twice per orbit, and flipping the sprite on the raw sign
     * makes it strobe at the turnaround. Only a decisive horizontal move re-latches it.
     */
    if (body.vx > 0.12) body.facing = 1;
    else if (body.vx < -0.12) body.facing = -1;

    // Soft containment — drift back rather than sticking to a wall.
    const margin = body.radius + 24;
    if (body.x < margin) body.vx += 0.14;
    if (body.x > sim.width - margin) body.vx -= 0.14;
    if (body.y < margin) body.vy += 0.14;
    if (body.y > sim.height - margin) body.vy -= 0.14;
  }

  separate(bodies);
}

function dist(body: SimBody, t: { x: number; y: number }): number {
  return Math.hypot(t.x - body.x, t.y - body.y);
}

/** Arrival behaviour: full speed far out, easing in over the last `ease` px. */
function seek(body: SimBody, tx: number, ty: number, speed: number, ease: number): void {
  body.tx = tx;
  body.ty = ty;
  const dx = tx - body.x;
  const dy = ty - body.y;
  const d = Math.hypot(dx, dy);
  if (d <= 1) return;
  const desired = Math.min(speed, (d / ease) * speed + 0.2);
  body.vx = (dx / d) * desired;
  body.vy = (dy / d) * desired;
}

/**
 * Cell size for the separation grid.
 *
 * Separation only acts within `a.radius + b.radius + 40`, and `radiusForStake` caps at 26 — so
 * `26 + 26 + 40 = 92 < 128` guarantees every interacting pair lands in the same cell or an
 * adjacent one, which is what makes the 3x3 neighbourhood scan EXACT rather than approximate.
 * A smaller cell would MISS pairs. This constant is coupled to that cap; changing either without
 * the other silently breaks separation for the largest bodies.
 */
const SEPARATION_CELL = 128;

/**
 * Push prowling cats apart — via a spatial hash, not every pair.
 *
 * Inherited wholesale from silvertongue, including its measurement. Its nested-pair version was
 * O(n²) inside a 30 Hz accumulator and survived thirteen sessions because the arena had 22 agents.
 * At scale, measured on a 390x844 field:
 *
 *   agents   2 → 24fps      40 →  6fps
 *   agents  12 → 15fps     100 →  3fps
 *   agents 200 → the renderer CRASHED ("Target crashed")
 *
 * The grid makes cost O(n) in population and O(k) in local density. STRAYS has one stray today, so
 * this is provably unnecessary right now — it is here because the version of this file that gets
 * written when the colony is 200 cats is the version written under deadline, and this one is
 * already correct.
 *
 * Only PROWLING cats separate. A holding cat is supposed to be next to its token and near any
 * other cat holding the same one; excluding them here rather than inside the inner loop keeps them
 * out of the grid entirely.
 */
export function separate(bodies: readonly SimBody[]): void {
  const roamers = bodies.filter((b) => b.mode === "prowl");
  if (roamers.length < 2) return;

  const grid = new Map<string, SimBody[]>();
  const keyFor = (cx: number, cy: number): string => `${cx},${cy}`;

  for (const b of roamers) {
    const k = keyFor(Math.floor(b.x / SEPARATION_CELL), Math.floor(b.y / SEPARATION_CELL));
    const cell = grid.get(k);
    if (cell === undefined) grid.set(k, [b]);
    else cell.push(b);
  }

  const push = (a: SimBody, b: SimBody): void => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    const min = a.radius + b.radius + 40;
    if (d > 0.001 && d < min) {
      const force = ((min - d) / min) * 0.32;
      a.vx -= (dx / d) * force;
      a.vy -= (dy / d) * force;
      b.vx += (dx / d) * force;
      b.vy += (dy / d) * force;
    }
  };

  /*
   * HALF the neighbourhood, so each unordered pair is visited exactly once.
   *
   * Scanning all 9 neighbours would compare every cross-cell pair TWICE and double the separation
   * force — a behaviour change disguised as an optimisation. These four offsets plus the in-cell
   * pass cover each pair once.
   */
  const NEIGHBOURS = [
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ] as const;

  for (const [k, cell] of grid) {
    for (let i = 0; i < cell.length; i++) {
      for (let j = i + 1; j < cell.length; j++) {
        const a = cell[i];
        const b = cell[j];
        if (a !== undefined && b !== undefined) push(a, b);
      }
    }
    const parts = k.split(",");
    const cx = Number(parts[0]);
    const cy = Number(parts[1]);
    for (const [ox, oy] of NEIGHBOURS) {
      const other = grid.get(keyFor(cx + ox, cy + oy));
      if (other === undefined) continue;
      for (const a of cell) {
        for (const b of other) push(a, b);
      }
    }
  }
}

function clampSpeed(body: SimBody, max: number): void {
  const speed = Math.hypot(body.vx, body.vy);
  if (speed > max) {
    body.vx = (body.vx / speed) * max;
    body.vy = (body.vy / speed) * max;
  }
}

/** Render position at interpolation factor `alpha` in [0,1] between the last two ticks. */
export function lerpBody(body: SimBody, alpha: number): { x: number; y: number } {
  return {
    x: body.px + (body.x - body.px) * alpha,
    y: body.py + (body.y - body.py) * alpha,
  };
}

/**
 * SETTLE the world for `prefers-reduced-motion`.
 *
 * The brief requires the sim be SUPPRESSED and the world rendered settled — not merely slowed.
 * "Settled" has to mean something specific or it means "wherever the random placement happened to
 * put things", so: every cat is parked where its real state says it belongs. A holding cat sits at
 * its token, a returning cat sits at the den, a prowling cat stays where it spawned. That is a
 * still frame of a true world, which is exactly what a reduced-motion user should get.
 */
export function settle(sim: Sim): void {
  for (const body of sim.bodies.values()) {
    const quarry = body.quarry === null ? null : sim.tokens.get(body.quarry);
    if (quarry !== undefined && quarry !== null) {
      body.x = quarry.x + quarry.radius + body.radius + 10;
      body.y = quarry.y;
      body.mode = "hold";
    } else if (body.mode === "drag" || body.mode === "slink") {
      body.x = sim.den.x;
      body.y = sim.den.y;
    }
    body.px = body.x;
    body.py = body.y;
    body.vx = 0;
    body.vy = 0;
    body.lunge = 0;
  }
}
