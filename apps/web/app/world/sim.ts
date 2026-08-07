/**
 * THE WORLD SIMULATION — pure, deterministic, renderer-free.
 *
 * ══ WHAT THIS FILE USED TO BE, AND WHY IT WAS REPLACED WHOLESALE ══
 *
 * The previous version was a Reynolds steering sim: every cat kept a retained `wanderAngle` that
 * drifted a little per tick, and was integrated through `vx`/`vy` into free space at 30Hz. Its own
 * header defended that choice at length — "the retained angle is what makes roaming read as intent
 * rather than noise" — and the claim is TRUE as far as it goes. A retained angle really does beat a
 * resampled one.
 *
 * It is an answer to the wrong question. Ibrahim's words, on the rendered page: *"why is the cat
 * hovering around in the map?"* A wander is a body with no destination, and a body with no
 * destination reads as HOVERING no matter how well its heading is filtered. Smoothing the noise
 * does not give the motion a reason; it only makes the aimlessness look deliberate.
 *
 * ══ THE MODEL THAT REPLACES IT, READ OUT OF BLOODHORN'S SOURCE ══
 *
 * Bloodhorn is the named standard, and its motion model is neither continuous wander NOR literal
 * teleport. `components/game/engine/agents.ts` is the specification, and it works like this:
 *
 *   1. Every agent has a HOME derived from the block it occupies. Blocks are FIXED SLOTS in a
 *      laid-out world, not free space. `AgentActor.setHome` moves the home; the body follows.
 *   2. An agent SITS at its home. `WALK_MS = 1400` — when a tick moves it to a different block it
 *      interpolates a path over 1400ms and then STOPS. It does not roam between moves.
 *   3. The life between moves comes from BREATHING IN PLACE. Bloodhorn's header calls this "the
 *      most important animation in the project", because the world only changes on a slow tick and
 *      without a continuous idle it is "a diagram that changes twice an hour".
 *
 * So a cat here is a body at a SLOT. It is still, breathing, until its real state changes; then it
 * walks — visibly, over 1400ms, along a path — to the slot its new state puts it in, and is still
 * again. Position is a FUNCTION OF STATE rather than an integration of forces, which is why a cat
 * can no longer drift anywhere its data did not send it.
 *
 * ══ WHAT SURVIVES FROM THE OLD FILE, AND WHY ══
 *
 * The six-mode predation cycle survives, because the modes were never the defect — they are the
 * product's own vocabulary (a cat stalks, pounces, holds, drags home). What changed is that a mode
 * is now expressed as WHICH SLOT the cat occupies plus a state flag, rather than as a speed fed to
 * a steering integrator:
 *
 *   PROWL   → the cat sits at its DEN SLOT. Idle, breathing, going nowhere. Most cats, most days.
 *   STALK   → walking to the token it holds. This is the 1400ms walk, and it is the only travel.
 *   POUNCE  → the arrival beat, at the end of the walk. A short lunge, then it lands.
 *   HOLD    → sitting at its token's HUNT SLOT. Still. Breathing. Not orbiting.
 *   DRAG    → walking home at a profit, carrying the kill.
 *   SLINK   → walking home at a loss.
 *
 * The fixed 30Hz timestep survives too: it is what makes the walk identical on a 60Hz laptop and a
 * 144Hz monitor. What is gone is everything that moved a body without being asked — the wander, the
 * separation forces, the soft containment, the orbit. A cat at a slot needs none of them, because
 * the SLOTS are laid out not to collide in the first place.
 *
 * Everything is a plain function over plain data so it unit-tests without a canvas or a browser.
 */

import { fnv1a } from "@taia/ui/mechanisms";

const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

/**
 * How long a walk between two slots takes, in ms.
 *
 * ══ 1400, TAKEN FROM BLOODHORN RATHER THAN RE-DERIVED ══
 *
 * `agents.ts`: `const WALK_MS = 1400`. It is inherited as a number AND as a reason: 1400ms is long
 * enough that the eye tracks the body across the gap (so the move is a journey and not a cut), and
 * short enough that the world has visibly settled again before the viewer's attention moves on.
 *
 * The old file's speeds — 5.4px/tick for a stalk, 7.5 for a pounce — were tuned against a DISTANCE
 * ("a 1440px crossing should take ~4.5s"). That is the wrong invariant: it makes a short hop
 * instant and a long one interminable, so the same event reads as a different beat depending on
 * where the two things happened to be. Fixing the DURATION instead makes every move the same beat,
 * which is what lets a viewer learn what a move looks like.
 */
export const WALK_MS = 1400;

/** Ticks in one walk. The path is interpolated across exactly this many. */
const WALK_TICKS = Math.round(WALK_MS / TICK_MS);

export type SimMode = "prowl" | "stalk" | "pounce" | "hold" | "drag" | "slink";

/** A point in the field. Slots and path vertices are both this. */
export type Vec = { x: number; y: number };

export type SimBody = {
  readonly id: string;
  /** Where the body IS. Between walks this is exactly `homeX`/`homeY` — a cat does not drift. */
  x: number;
  y: number;
  /** Previous-tick position — the interpolation source for the renderer. */
  px: number;
  py: number;
  /**
   * THE SLOT. Where this cat belongs given its current state, and where it returns to rest.
   *
   * Bloodhorn's `homeX`/`homeY`. This is the whole model: a body is not somewhere because forces
   * put it there, it is somewhere because its state says that is its place.
   */
  homeX: number;
  homeY: number;
  /**
   * The walk in progress, as a list of vertices. Empty when the cat is at rest, which is the
   * overwhelmingly common case — `walking` is false and the renderer draws a still, breathing cat.
   */
  path: Vec[];
  /** 0..1 progress along the whole path. Advanced by exactly `1 / WALK_TICKS` per tick. */
  pathT: number;
  radius: number;
  mode: SimMode;
  /** The token address this body is hunting or holding, so the renderer can draw the tether. */
  quarry: string | null;
  /** Which way the sprite faces. Latched on the walk direction, never on sub-pixel jitter. */
  facing: 1 | -1;
  /** Ticks spent in the current mode — drives the pounce beat and the arrival. */
  modeTicks: number;
  /** 0..1, eases up over the pounce and decays after. The renderer stretches the sprite by it. */
  lunge: number;
  /**
   * Per-body oscillator constants, derived ONCE from the id.
   *
   * ══ THIS IS THE SINGLE MOST IMPORTANT FIELD IN THE STRUCT ══
   *
   * Bloodhorn's `juice.ts` is unusually blunt about why, and it is worth quoting because the
   * failure it names is invisible until you have seen it: *"synchronised breathing reads as one
   * animation played twenty times, which is the single most life-killing artifact possible in a
   * crowd scene."*
   *
   * So every cat gets its own PHASE and its own RATE. Not just a phase offset — a phase offset
   * alone still has every body completing its cycle in the same period, so the crowd re-syncs into
   * a visible wave. Two cats with different rates drift apart forever and never re-align.
   *
   * From `fnv1a` of the id rather than from an index, because an index changes when the colony is
   * re-sorted on a poll and every cat's rhythm would jump. And never from `Math.random()`, which
   * would make a cat breathe differently across a reload and make a screenshot untestable.
   */
  readonly phase: number;
  readonly rate: number;
  /** Idle personality: a rare, sharp turn on a long per-cat timer. Milliseconds until the next. */
  twitchAt: number;
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
  /** Where a cat rests when it is not hunting. Recomputed on resize; never null after `resizeSim`. */
  den: Vec;
  /**
   * How much of each edge the HUD covers, in CSS px.
   *
   * The canvas is the whole viewport but the HUD panels are opaque, so the PLAYABLE field is
   * smaller than the canvas. The renderer measures the real panel rectangles and writes them here;
   * every slot is derived inside the remainder. Without this the world happily puts cats and tokens
   * in pixels nobody can see.
   */
  insets: { top: number; right: number; bottom: number; left: number };
};

export function createSim(width: number, height: number, random: () => number): Sim {
  return {
    width,
    height,
    bodies: new Map(),
    tokens: new Map(),
    random,
    den: denFor(width, height),
    // Zero until the renderer measures the HUD. A world that has not measured yet uses its whole
    // canvas, which is the correct behaviour for the first frame and for a HUD-less embedding.
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

/**
 * THE DEN — bottom-left, inset by a fraction rather than a constant.
 *
 * A fixed pixel inset would put the den off-screen on a 320px phone and in the middle of nowhere on
 * a 1440px desktop. Fractions of the field keep it in the same PLACE in the composition at every
 * width, which is what makes "it went home" legible without a label.
 */
function denFor(
  width: number,
  height: number,
  insets: { top: number; right: number; bottom: number; left: number } = { top: 0, right: 0, bottom: 0, left: 0 },
): Vec {
  // Placed within the PLAYABLE field, not the raw canvas — otherwise on a phone (where the adopt
  // panel and roster stack along the bottom) the den sits under a panel and every returning cat
  // walks off-screen to reach it.
  const w = Math.max(1, width - insets.left - insets.right);
  const h = Math.max(1, height - insets.top - insets.bottom);
  return { x: insets.left + w * 0.13, y: insets.top + h * 0.78 };
}

/**
 * ══ THE SLOT SYSTEM — the replacement for free space ══
 *
 * Bloodhorn's agents stand on BLOCKS: a small, fixed set of hand-laid positions that exist whether
 * or not anybody is standing on them, and an agent's position is always one of them. That is what
 * makes its world read as a place rather than as a field of drifting sprites, and it is why moving
 * between two of them is an EVENT — you can see that a thing left one named location for another.
 *
 * Free space has no such structure. Any position is as good as any other, so no position means
 * anything, so a body at rest anywhere looks like a body that has stopped for no reason.
 *
 * Two families of slot exist here, and both are derived rather than authored, because the layout
 * has to survive a resize and an arbitrary number of real tokens:
 *
 *   HUNT SLOTS — one per quarry token, offset from the token itself. A cat holding a token sits in
 *                that token's hunt slot: beside its kill, visibly attending to that specific thing.
 *   DEN SLOTS  — a small arc around the den mark. An idle cat sits in one. They are ARRANGED, not
 *                random: an arc reads as cats gathered at a place, where a scatter reads as cats
 *                that happened to stop near each other.
 *
 * Every slot is a pure function of (field, index), so it is stable across polls and reproducible in
 * a screenshot test — the same cat is in the same pixel on every reload until its STATE changes.
 */

/**
 * The den slot for the nth idle cat.
 *
 * ══ AN ARC, AND THE RADIUS GROWS WITH THE COUNT ══
 *
 * A fixed ring would overlap the moment the colony outgrew it. The radius steps outward every
 * `PER_RING` cats, so a colony of 3 and a colony of 30 are both legible — the first as a small
 * huddle, the second as a camp — without any position ever being chosen at random.
 *
 * The arc opens to the RIGHT (−60°..+60° around the den), toward the field, because the den sits at
 * the left edge of the composition and an arc opening left would put half the colony off-canvas.
 */
export function denSlot(sim: Sim, index: number, radius: number): Vec {
  const PER_RING = 5;
  const ring = Math.floor(index / PER_RING);
  const withinRing = index % PER_RING;
  // Ring 0 sits just clear of the den mark; each further ring clears the largest possible cat.
  const r = 46 + ring * (radius + 34);
  /*
   * Spread across a 120° arc.
   *
   * The slot's position within the arc is `(withinRing + 0.5) / PER_RING` rather than
   * `withinRing / (PER_RING - 1)`. The difference matters for the colony we actually have: the
   * second form puts cat 0 at the arc's extreme END, so a colony of ONE — which is the real state
   * of the vault today — renders a single cat pinned to the top edge of the arc, reading as a
   * colony of five with four missing. Cell-centred placement puts a lone cat in the middle of the
   * space it occupies, which is what "one cat resting at the den" should look like.
   */
  const spread = Math.PI * (2 / 3);
  const angle = -spread / 2 + ((withinRing + 0.5) / PER_RING) * spread;
  return clampToField(sim, { x: sim.den.x + Math.cos(angle) * r, y: sim.den.y + Math.sin(angle) * r }, radius);
}

/**
 * The hunt slot beside a token — where a cat that holds it sits.
 *
 * Offset to the LOWER-LEFT of the diamond rather than centred on it, for two reasons that are both
 * about legibility rather than taste: a cat centred on its token occludes the thing it is supposed
 * to be attending to, and the token's ticker label hangs BELOW it, so a cat directly under the
 * diamond would sit on the one piece of text that says which token this is.
 *
 * `nth` separates two cats holding the SAME token: they alternate sides instead of overlapping.
 * This is the only place two cats can legitimately want the same slot, which is why it is the only
 * place that needs a tie-break — and a deterministic alternation is a better answer than a
 * separation force, because it is exact and costs nothing.
 */
export function huntSlot(sim: Sim, token: SimToken, radius: number, nth: number): Vec {
  const side = nth % 2 === 0 ? -1 : 1;
  const tier = Math.floor(nth / 2);
  const gap = token.radius + radius * 0.72 + 12 + tier * (radius + 10);
  return clampToField(sim, { x: token.x + side * gap, y: token.y + radius * 0.34 }, radius);
}

/**
 * Keep a slot inside the PLAYABLE field — the canvas minus whatever the HUD covers.
 *
 * A clamp is the right tool HERE, where it would have been the wrong one for laying out the token
 * grid (the old file records why: clamping a whole set piles it onto one edge line). A single slot
 * being pulled back inside the visible area moves only that slot, and only as far as it must.
 */
function clampToField(sim: Sim, p: Vec, radius: number): Vec {
  const margin = radius * 0.6 + 10;
  const left = sim.insets.left + margin;
  const right = sim.width - sim.insets.right - margin;
  const top = sim.insets.top + margin;
  const bottom = sim.height - sim.insets.bottom - margin;
  return {
    x: right < left ? (left + right) / 2 : Math.max(left, Math.min(right, p.x)),
    y: bottom < top ? (top + bottom) / 2 : Math.max(top, Math.min(bottom, p.y)),
  };
}

/**
 * Recompute every cat's slot from its current state, and WALK anyone whose slot changed.
 *
 * ══ THIS FUNCTION IS THE MOTION MODEL ══
 *
 * Everything else in this file is bookkeeping. This is the part that decides where a cat belongs
 * and, crucially, decides it from STATE alone — the cat's mode and its real holding — so a cat can
 * never be somewhere its data does not put it. Nothing accumulates; nothing integrates; there is no
 * position error to drift.
 *
 * It is called after every sync and after every resize, and it is IDEMPOTENT: calling it when
 * nothing has changed assigns each cat the slot it already occupies and starts no walk. That
 * property is what lets it run on every frame's sync without the world twitching.
 */
export function reslot(sim: Sim): void {
  // Stable order, so `nth` within a group does not reshuffle when the Map's insertion order
  // changes on a poll. Sorting by id is arbitrary but FIXED, which is the only thing that matters.
  const bodies = [...sim.bodies.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // How many cats already claimed each token's hunt slot, and how many are at the den.
  const perToken = new Map<string, number>();
  let denIndex = 0;

  for (const body of bodies) {
    const token = body.quarry === null ? undefined : sim.tokens.get(body.quarry);
    let slot: Vec;

    if (token !== undefined && (body.mode === "stalk" || body.mode === "pounce" || body.mode === "hold")) {
      const nth = perToken.get(token.address) ?? 0;
      perToken.set(token.address, nth + 1);
      slot = huntSlot(sim, token, body.radius, nth);
    } else {
      slot = denSlot(sim, denIndex++, body.radius);
      /*
       * ══ AN IDLE CAT DOES NOT SIT ON TOP OF A TOKEN ══
       *
       * Measured at 390px, where the playable field is a ~390x450 strip holding fourteen diamonds:
       * the den slot landed squarely on a token, so the cat was drawn over the diamond and its
       * ticker, and the composite read as one broken sprite rather than as two things.
       *
       * A cat AT its quarry is meaningful — that is what a hunt slot is for. A cat standing on an
       * unrelated token is noise, and worse, it looks like the same thing. So an idle slot that
       * collides with any token is nudged clear along the vector away from it.
       *
       * This is deliberately NOT a separation force. It resolves once, deterministically, at
       * slot-assignment time, so the cat still has a single fixed home it returns to and rests at.
       * A force would reintroduce exactly the continuous drift this rewrite removed.
       */
      slot = clearOfTokens(sim, slot, body.radius);
    }

    setHome(body, slot);
  }
}

/**
 * Nudge a slot clear of any token it overlaps.
 *
 * Bounded to a few passes rather than looped to convergence: on a field crowded enough that no
 * clear spot exists within a few steps, the honest outcome is a slightly overlapping cat, and an
 * unbounded search would be a frame-time cliff on exactly the small screens that can least afford
 * one. Cats are drawn AFTER tokens, so a residual overlap still leaves the animal legible on top.
 */
function clearOfTokens(sim: Sim, slot: Vec, radius: number): Vec {
  let out = slot;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const t of sim.tokens.values()) {
      const dx = out.x - t.x;
      const dy = out.y - t.y;
      const d = Math.hypot(dx, dy);
      // The cat's drawn half-width is roughly its radius; add the token's own extent and a margin
      // wide enough to clear the ticker plate that hangs under the diamond.
      const min = radius * 0.7 + t.radius + 22;
      if (d >= min) continue;
      // Degenerate case: exactly co-located. Push right, which is toward the open field from a den
      // that sits at the left edge of the composition.
      const ux = d < 0.001 ? 1 : dx / d;
      const uy = d < 0.001 ? 0 : dy / d;
      out = clampToField(sim, { x: t.x + ux * min, y: t.y + uy * min }, radius);
      moved = true;
    }
    if (!moved) break;
  }
  return out;
}

/**
 * Move a body's slot, and start a walk if it is a real move.
 *
 * Bloodhorn's `AgentActor.setHome`, including its one subtlety: if the body is not already walking
 * and the new slot is only a WHISKER away, it settles straight there rather than starting a walk.
 * That distinguishes a RE-SLOT (the window resized, the layout shifted two pixels) from a MOVE (the
 * cat's state changed and it must be seen to travel). Animating a re-slot would make every resize
 * look like the whole colony decided to go for a walk.
 */
function setHome(body: SimBody, slot: Vec): void {
  const moved = Math.hypot(slot.x - body.homeX, slot.y - body.homeY);
  body.homeX = slot.x;
  body.homeY = slot.y;

  // Already walking: the walk's own destination is `home`, so it will arrive at the new slot. Do
  // not restart the path — that would make a cat stutter every time a poll landed mid-walk.
  if (body.path.length >= 2) return;

  /*
   * ══ THE RE-SLOT THRESHOLD ══
   *
   * Under this, the body is placed. Over it, the body WALKS.
   *
   * 3px is comfortably above the sub-pixel churn a resize or a HUD re-measure produces, and far
   * below any distance a state change implies — the nearest two slots in the layout are tens of
   * pixels apart by construction. So the two cases cannot be confused.
   */
  if (moved <= 3) {
    body.x = slot.x;
    body.y = slot.y;
    body.px = slot.x;
    body.py = slot.y;
    return;
  }

  walkTo(body, slot);
}

/**
 * Start a walk from where the body is to where it now belongs.
 *
 * ══ THE PATH BOWS, AND THAT IS NOT DECORATION ══
 *
 * A straight line between two points is the path of something being MOVED — a UI element sliding
 * to a new position. A slight lateral bow is the path of something CHOOSING to go somewhere, and it
 * is the cheapest possible difference between the two readings.
 *
 * The bow's direction and depth come from the cat's own hash, so two cats leaving the same slot for
 * the same target take visibly different routes rather than marching in a column — and each cat
 * takes the SAME route every time, which is what makes it read as that animal's habit.
 */
function walkTo(body: SimBody, target: Vec): void {
  const dx = target.x - body.x;
  const dy = target.y - body.y;
  const d = Math.hypot(dx, dy);

  if (d < 1) {
    body.x = target.x;
    body.y = target.y;
    body.path = [];
    body.pathT = 0;
    return;
  }

  // Perpendicular unit vector, for the bow.
  const nx = -dy / d;
  const ny = dx / d;
  // ±8..18% of the distance, capped so a long crossing does not become a semicircle.
  const bow = ((body.phase / (Math.PI * 2)) * 2 - 1) * Math.min(d * 0.18, 64);

  body.path = [
    { x: body.x, y: body.y },
    { x: body.x + dx * 0.5 + nx * bow, y: body.y + dy * 0.5 + ny * bow },
    { x: target.x, y: target.y },
  ];
  body.pathT = 0;
  body.facing = dx < 0 ? -1 : 1;
}

/** True while this cat is between slots. The renderer uses it to suppress the idle breath. */
export function walking(body: SimBody): boolean {
  return body.path.length >= 2;
}

export function resizeSim(sim: Sim, width: number, height: number): void {
  sim.width = width;
  sim.height = height;
  sim.den = denFor(width, height, sim.insets);
  /*
   * Tokens and slots are LAID OUT rather than scaled.
   *
   * The old file scaled every body's absolute coordinates by the size ratio, because under a
   * steering model a body's position was state that would otherwise be lost. Under a slot model
   * position is DERIVED, so there is nothing to preserve: re-laying the tokens and re-slotting the
   * cats reproduces the correct arrangement for the new field exactly, with no accumulated error.
   */
  layoutTokens(sim);
  reslot(sim);
}

/**
 * Tell the sim which parts of the canvas the HUD is covering.
 *
 * Called by the renderer from the same measured rectangles the label placer uses, so there is ONE
 * source of truth for "where is the chrome" rather than a CSS value duplicated into a constant that
 * drifts the first time a panel's width changes.
 */
export function setInsets(
  sim: Sim,
  insets: { top: number; right: number; bottom: number; left: number },
): void {
  const changed =
    sim.insets.top !== insets.top ||
    sim.insets.right !== insets.right ||
    sim.insets.bottom !== insets.bottom ||
    sim.insets.left !== insets.left;
  if (!changed) return;
  sim.insets = insets;
  sim.den = denFor(sim.width, sim.height, insets);
  layoutTokens(sim);
  reslot(sim);
}

/**
 * ══ LAY THE QUARRY OUT ACROSS THE PLAYABLE FIELD ══
 *
 * Two earlier attempts at this are worth recording, because both were locally reasonable and both
 * produced a worse field than the bug they fixed:
 *
 *   1. CLAMP each out-of-bounds token to the nearest legal edge. Correct per token, wrong in
 *      aggregate: with a ~420px roster on the right, every token placed in the right third piled up
 *      on the SAME edge line and their labels stacked into an unreadable vertical column.
 *   2. RE-PROJECT each token inward along its own angle from the field centre. This preserved each
 *      token's angle but pulled them all toward the middle by different amounts, collapsing the
 *      arrangement into a diagonal streak through the centre of the field.
 *
 * The shared mistake: both tried to REPAIR positions computed against the wrong rectangle. The
 * positions are not repairable, because the information that would make them right — the shape of
 * the playable field — was not available when they were computed.
 *
 * So this LAYS OUT the whole set against the field that actually exists, by index. Deterministic
 * from the token's position in the (already sorted) list, so a re-layout after a resize or a HUD
 * measurement puts everything back in the same relative arrangement rather than reshuffling the
 * field under the user.
 *
 * ══ A JITTERED GRID, NOT A RING ══
 *
 * Three ring versions were tried and all three left most of the field empty. The reason is
 * structural rather than a matter of tuning the radii: a ring puts every token on the BOUNDARY of
 * an ellipse and nothing in its interior, so the middle of the field is empty by construction.
 * Worse, the ellipse is centred on the playable field — and because the HUD's insets are asymmetric
 * (a tall roster on the right, nothing on the left), that centre sits well right of the screen's
 * centre, so the ring rendered as a crescent hugging the right edge with the entire left half of a
 * 1440px viewport blank.
 *
 * A grid fills a rectangle, which is the shape the field actually is.
 */
function layoutTokens(sim: Sim): void {
  const fw = Math.max(1, sim.width - sim.insets.left - sim.insets.right);
  const fh = Math.max(1, sim.height - sim.insets.top - sim.insets.bottom);

  const tokens = [...sim.tokens.values()];
  const n = Math.max(1, tokens.length);

  /*
   * ══ COLUMNS ARE CHOSEN SO THE GRID FILLS THE FIELD, NOT SO THE CELLS ARE SQUARE ══
   *
   * `round(sqrt(n * aspect))` is the standard "keep the cells square" formula and it is the wrong
   * objective here. Measured on the 1440px field: 14 tokens in a ~950x700 playable area gives
   * `sqrt(14 * 1.36) ≈ 4.4 → 4` columns and 4 rows — a 4x4 block sitting in the middle of the field
   * with square cells and most of the width unused. Square cells are a property of the CELLS;
   * filling the field is a property of the GRID, and only the second one is visible.
   */
  const cols = Math.max(
    fw > 420 ? 3 : 2,
    Math.min(n, Math.ceil(Math.sqrt(n * (fw / Math.max(1, fh))) * 1.35)),
  );
  const rows = Math.max(1, Math.ceil(n / cols));

  tokens.forEach((t, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Padding must clear the token AND the hunt slot beside it, or a cat holding an edge token
    // would be clamped on top of its own quarry.
    const pad = t.radius + 46;
    const usableW = Math.max(1, fw - pad * 2);
    // The label hangs BELOW the diamond, so the vertical budget must clear it too — otherwise the
    // ticker, the entire point of the layer, is the part that lands under a panel.
    const usableH = Math.max(1, fh - pad * 2 - 16);
    const cellW = usableW / cols;
    const cellH = usableH / rows;
    // Bounded to ±26% of a cell, so jitter never lets two neighbours reach each other.
    const jx = Math.sin(i * 12.9898) * 0.26;
    const jy = Math.cos(i * 78.233) * 0.26;
    const originX = sim.insets.left + pad;
    const originY = sim.insets.top + pad;
    t.x = originX + (col + 0.5 + jx) * cellW;
    t.y = originY + (row + 0.5 + jy) * cellH;
  });
}

/**
 * RADIUS CARRIES STAKE — silvertongue's rule, in its own words: *"a richer agent is visibly a
 * bigger prize."* Same curve, same floor.
 *
 * `sqrt` rather than linear because stake spans orders of magnitude and a linear map makes every
 * cat below the top one the same minimum dot.
 *
 * ══ CALIBRATED TO OUR STAKES, NOT SILVERTONGUE'S ══
 *
 * The coefficient was 90, inherited from silvertongue whose agents hold WHOLE ETH. A stray holds
 * thousandths: the intended $5 adoption is 0.0026 ETH.
 *
 * MEASURED with the old formula: 0.00208 → r 20.1, and since the sprite scale is `floor(2r / 24)`,
 * that is scale 1 — a 24px cat. Every realistic stake from $4 to $19 collapsed to the SAME minimum
 * sprite, so the size channel carried no information at all and the cat was a speck next to its own
 * quarry.
 *
 * 620 puts the product's real range across the useful scales:
 *   0.0021 ETH ($4)  → r 44  → scale 3
 *   0.0083 ETH ($16) → r 72  → scale 6
 */
export function radiusForStake(stakeEth: number): number {
  if (!Number.isFinite(stakeEth) || stakeEth <= 0) return MIN_CAT_RADIUS;
  return Math.max(MIN_CAT_RADIUS, Math.min(MAX_CAT_RADIUS, MIN_CAT_RADIUS + Math.sqrt(stakeEth) * 620));
}

/**
 * ══ THE FLOOR AND CEILING WERE RAISED AFTER LOOKING AT THE RENDERED FIELD ══
 *
 * silvertongue's numbers are 9 and 26, and they are right FOR SILVERTONGUE — its agents are drawn
 * as filled circles, and a 9px circle is a perfectly solid mark.
 *
 * A cat is not a circle. The sprite is a 24x24 grid, so `scale = floor(2r / 24)`: at r=9 that is
 * `floor(18/24) = 0`, an invisible cat. Measured on the rendered 1440px field before this was
 * raised: the smallest cats were smaller than the token diamonds they were supposed to be hunting,
 * so the predator read as the prey.
 *
 * The generalisable lesson, and the reason this is a comment rather than two changed numbers: a
 * size constant inherited from a project with a DIFFERENT sprite is a number with no meaning here.
 * The quantisation (`floor(2r/24)`) is the thing that actually decides what a cat looks like, and
 * it only has a few usable values in this range — so the floor has to be chosen against the
 * quantised output, not against the continuous radius.
 */
const MIN_CAT_RADIUS = 24;
const MAX_CAT_RADIUS = 84;

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
 *
 * Returns true when the SET changed, so the caller can skip a re-layout on the overwhelmingly
 * common poll where the same fourteen tokens came back.
 */
export function syncTokens(sim: Sim, tokens: readonly TokenInput[]): boolean {
  let changed = false;
  const live = new Set(tokens.map((t) => t.address));
  for (const key of [...sim.tokens.keys()]) {
    if (!live.has(key)) {
      sim.tokens.delete(key);
      changed = true;
    }
  }

  for (const t of tokens) {
    const existing = sim.tokens.get(t.address);
    const radius = radiusForCap(t.marketCapEth);
    if (existing !== undefined) {
      existing.radius = radius;
      continue;
    }
    /*
     * Insert at the field centre, then lay the whole set out.
     *
     * The position assigned here is a placeholder that `layoutTokens` immediately overwrites — the
     * grid position depends on how many tokens there ARE and on where each sits in the list,
     * neither of which is known while iterating. Doing the arithmetic twice (once here, once in the
     * layout) is how two earlier versions of this drifted out of agreement.
     */
    sim.tokens.set(t.address, {
      address: t.address,
      symbol: t.symbol,
      x: sim.width / 2,
      y: sim.height / 2,
      // A stable per-token phase, from its own address. `random()` here would make the field's
      // ambient rhythm differ across reloads and defeat any screenshot comparison.
      phase: (fnv1a(t.address) % 6283) / 1000,
      radius,
      huntable: t.huntable,
    });
    changed = true;
  }

  if (changed) layoutTokens(sim);
  return changed;
}

/**
 * Sync the cat set with the real stray list, and set each cat's mode from its real holding.
 *
 * A stray that leaves the chain leaves the field. NOBODY IS INVENTED TO FILL SPACE — an empty
 * colony renders as an empty field with the quarry still there, and the HUD says so in words.
 *
 * Returns true when anything that affects SLOTTING changed, so the caller only re-slots on a real
 * change rather than on all sixty frames a second.
 */
export function syncBodies(sim: Sim, agents: readonly AgentInput[]): boolean {
  let changed = false;
  const live = new Set(agents.map((a) => a.id));
  for (const key of [...sim.bodies.keys()]) {
    if (!live.has(key)) {
      sim.bodies.delete(key);
      changed = true;
    }
  }

  for (const agent of agents) {
    const radius = radiusForStake(agent.stakeEth);
    const existing = sim.bodies.get(agent.id);

    if (existing === undefined) {
      /*
       * ══ A NEW CAT IS BORN AT ITS SLOT, NOT AT A RANDOM POINT ══
       *
       * The old file spawned every body at `margin + random() * (width - margin*2)` and let the
       * steering walk it somewhere sensible. Under a slot model that would be a cat appearing in an
       * arbitrary spot and then sliding to its place — which is exactly the "teleport, then drift"
       * reading this rewrite exists to remove. `reslot` places it; `setHome` sees a body that has
       * never had a slot and settles it there without a walk.
       */
      const h = fnv1a(agent.id);
      sim.bodies.set(agent.id, {
        id: agent.id,
        x: sim.den.x,
        y: sim.den.y,
        px: sim.den.x,
        py: sim.den.y,
        homeX: sim.den.x,
        homeY: sim.den.y,
        path: [],
        pathT: 0,
        radius,
        mode: agent.holding === null ? "prowl" : "stalk",
        quarry: agent.holding,
        facing: 1,
        modeTicks: 0,
        lunge: 0,
        // Own phase AND own rate. See the note on `SimBody.phase` — this pair is the reason a
        // colony reads as a crowd rather than as one animation played N times.
        phase: ((h % 10000) / 10000) * Math.PI * 2,
        rate: 0.88 + ((Math.floor(h / 10000) % 10000) / 10000) * 0.24,
        // 12-30s between twitches, per cat. A scheduled twitch reads as a metronome.
        twitchAt: 12000 + (h % 18000),
      });
      changed = true;
      continue;
    }

    if (existing.radius !== radius) {
      existing.radius = radius;
      changed = true;
    }

    /*
     * ══ THE ONE TRANSITION THAT MUST NOT BE SMOOTHED OVER ══
     *
     * When the vault says a cat has ENTERED a position, it must be SEEN to go there. The tempting
     * shortcut is to set `mode = "hold"` and let the renderer draw it beside the token — the cat
     * would teleport, which is the exact defect the brief names. So an entry always starts at
     * STALK, and `step` only promotes it to hold once the walk has actually finished.
     *
     * This is the one place where the slot model and the "no teleport" rule could quietly conflict,
     * and it is worth being precise about why they do not: `reslot` moves the cat's HOME to the
     * token's hunt slot, and `setHome` sees a move of more than 3px and starts a 1400ms walk. The
     * cat's position is still interpolated along that path every tick. A slot model is not a
     * teleport model — the slot says where a body BELONGS, and the walk is how it gets there.
     *
     * The guard is `existing.quarry !== agent.holding`: re-reading the SAME holding on a later poll
     * must not restart the stalk of a cat that has already arrived.
     */
    if (agent.holding !== null && existing.quarry !== agent.holding) {
      existing.quarry = agent.holding;
      setMode(existing, "stalk");
      changed = true;
    } else if (agent.holding === null && existing.quarry !== null) {
      // Exited. The caller decides drag-vs-slink from realised PnL; the default is the honest one
      // for an unknown outcome — go home, unremarkably.
      existing.quarry = null;
      if (existing.mode === "hold" || existing.mode === "stalk" || existing.mode === "pounce") {
        setMode(existing, "slink");
      }
      changed = true;
    }
  }

  return changed;
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
  reslot(sim);
}

/**
 * ONE FIXED TICK.
 *
 * ══ WHAT A TICK NO LONGER DOES ══
 *
 * It does not integrate velocity, because there is none. It does not apply separation, containment
 * or arrival forces, because a body is never anywhere it has to be pushed out of. The entire
 * function is: advance the walk if there is one, run the mode clock, and let the predation cycle
 * advance its own state. A cat with no walk in progress does not move at all, which is the point.
 */
export function step(sim: Sim): void {
  for (const t of sim.tokens.values()) {
    // Quarry bobs. Ambient motion that costs nothing and means the field is never dead even when
    // the colony is empty — which, today, it is.
    t.phase += 0.021;
  }

  for (const body of sim.bodies.values()) {
    body.px = body.x;
    body.py = body.y;
    body.modeTicks += 1;

    // ── THE WALK ──────────────────────────────────────────────────────────────────────────
    if (body.path.length >= 2) {
      body.pathT += 1 / WALK_TICKS;
      const p = Math.min(1, body.pathT);
      /*
       * EASED, not linear.
       *
       * A body that starts and stops at full speed reads as a UI element being tweened. A smooth
       * acceleration out of rest and a deceleration into it reads as a body deciding to go and then
       * arriving. Bloodhorn gets this from its own `easeOut`; the same S-curve is `smoothstep`'s.
       */
      const e = p * p * (3 - 2 * p);
      const segs = body.path.length - 1;
      const at = e * segs;
      const i = Math.min(segs - 1, Math.floor(at));
      const f = at - i;
      const a = body.path[i];
      const b = body.path[i + 1];
      if (a !== undefined && b !== undefined) {
        const nx = a.x + (b.x - a.x) * f;
        const ny = a.y + (b.y - a.y) * f;
        // Latch facing on a DEADBAND. A path's bow crosses dx=0 once, and flipping the sprite on
        // the raw sign makes it strobe at that crossing.
        if (nx - body.x > 0.2) body.facing = 1;
        else if (nx - body.x < -0.2) body.facing = -1;
        body.x = nx;
        body.y = ny;
      }
      if (p >= 1) {
        // ARRIVED. Snap to the slot exactly and stop. The snap is not cosmetic: an interpolated
        // endpoint lands a fraction of a pixel off, and a body resting at x.0001 forever is what
        // makes a "still" sprite shimmer against the pixel grid.
        body.path = [];
        body.pathT = 0;
        body.x = body.homeX;
        body.y = body.homeY;
      }
    }

    // ── THE PREDATION CYCLE, AS STATE RATHER THAN AS STEERING ─────────────────────────────
    const quarry = body.quarry === null ? null : (sim.tokens.get(body.quarry) ?? null);

    switch (body.mode) {
      case "stalk": {
        /*
         * A cat whose quarry left the field goes home.
         *
         * This happens for real: the vault says the cat holds token X, and X has aged off the
         * newest-launches list the world renders. Freezing the cat would look like a bug and
         * drawing it beside a phantom token would be inventing a position. Walking home is the
         * honest third option, and `reslot` sends it to a den slot on the next sync.
         */
        if (quarry === null) {
          setMode(body, "slink");
          break;
        }
        // The pounce is the LAST BEAT OF THE WALK, not a separate journey. It fires once the walk
        // is most of the way in, so the arrival has a visible accent instead of just stopping.
        if (body.pathT >= POUNCE_AT || body.path.length < 2) setMode(body, "pounce");
        break;
      }

      case "pounce": {
        if (quarry === null) {
          setMode(body, "slink");
          break;
        }
        // `lunge` eases up across the pounce and the renderer stretches the sprite by it.
        body.lunge = Math.min(1, body.lunge + 0.16);
        // Landed: the walk is over and the cat is at its slot.
        if (body.path.length < 2) setMode(body, "hold");
        break;
      }

      case "hold": {
        // A held position with no token left is an exit nobody reported. Go home.
        if (quarry === null) setMode(body, "slink");
        break;
      }

      case "drag":
      case "slink": {
        // Home is a den slot by now (`reslot` put it there). Arriving means the walk finished.
        if (body.path.length < 2 && body.modeTicks > 2) setMode(body, "prowl");
        break;
      }

      case "prowl":
        // THE AMBIENT STATE, AND IT IS DELIBERATELY EMPTY.
        //
        // This is the case that used to hold the Reynolds wander, and its emptiness is the entire
        // change. A cat with nothing to hunt sits at its den slot and breathes. It does not roam,
        // because there is nowhere for it to roam TO — and a body moving with no destination is
        // precisely what "hovering around in the map" described.
        break;
    }

    // The lunge decays outside a pounce, so the stretch relaxes rather than snapping back.
    if (body.mode !== "pounce") body.lunge *= 0.9;
  }
}

/**
 * How far into the walk the stalk becomes a pounce.
 *
 * 0.72 puts the accent in the last ~390ms of a 1400ms walk. Measured against the alternative of
 * firing it on DISTANCE (the old `POUNCE_RANGE = 96`): a distance trigger makes the pounce's length
 * depend on how far the cat happened to be from its token, so a short hop was entirely pounce and a
 * long crossing had a pounce too brief to see. A fraction of the walk makes the beat the same
 * length every time, which is what lets it be recognised as a beat.
 */
const POUNCE_AT = 0.72;

/** Render position at interpolation factor `alpha` in [0,1] between the last two ticks. */
export function lerpBody(body: SimBody, alpha: number): Vec {
  return {
    x: body.px + (body.x - body.px) * alpha,
    y: body.py + (body.y - body.py) * alpha,
  };
}

/**
 * SETTLE the world for `prefers-reduced-motion`.
 *
 * The brief requires the sim be SUPPRESSED and the world rendered settled — not merely slowed.
 * Under the slot model this is almost trivial, and that is a good sign about the model: "settled"
 * means every cat is AT ITS SLOT, which is the thing the sim was converging on anyway. There is no
 * separate still-life to construct and no chance of the reduced-motion world disagreeing with the
 * moving one, because they have the same definition of where a cat belongs.
 */
export function settle(sim: Sim): void {
  reslot(sim);
  for (const body of sim.bodies.values()) {
    // Cancel any walk outright and place the body. A reduced-motion user must never see the
    // remainder of a walk that was in flight when they flipped the setting.
    body.path = [];
    body.pathT = 0;
    body.x = body.homeX;
    body.y = body.homeY;
    body.px = body.x;
    body.py = body.y;
    body.lunge = 0;
    if (body.mode === "stalk" || body.mode === "pounce") body.mode = body.quarry === null ? "prowl" : "hold";
    if (body.mode === "drag" || body.mode === "slink") body.mode = "prowl";
  }
}
