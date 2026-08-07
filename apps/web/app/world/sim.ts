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
  /**
   * How much of each edge the HUD covers, in CSS px.
   *
   * The canvas is the whole viewport but the HUD panels are opaque, so the PLAYABLE field is
   * smaller than the canvas. The renderer measures the real panel rectangles and writes them here;
   * `step` keeps cats inside the remainder and `syncTokens` places quarry inside it. Without this
   * the world happily puts cats and tokens in pixels nobody can see.
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
): { x: number; y: number } {
  // Placed within the PLAYABLE field, not the raw canvas — otherwise on a phone (where the adopt
  // panel and roster stack along the bottom) the den sits under a panel and every returning cat
  // walks off-screen to reach it.
  const w = Math.max(1, width - insets.left - insets.right);
  const h = Math.max(1, height - insets.top - insets.bottom);
  return { x: insets.left + w * 0.13, y: insets.top + h * 0.8 };
}

export function resizeSim(sim: Sim, width: number, height: number): void {
  const sx = width / Math.max(1, sim.width);
  const sy = height / Math.max(1, sim.height);
  sim.width = width;
  sim.height = height;
  sim.den = denFor(width, height, sim.insets);
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
  // Tokens are LAID OUT rather than scaled: their arrangement is a function of the field, so a
  // resize should recompute it rather than stretch the old one into a squashed ellipse.
  layoutTokens(sim);
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
  sim.insets = insets;
  sim.den = denFor(sim.width, sim.height, insets);
  if (changed) layoutTokens(sim);
}

/**
 * ══ PULL TOKENS OUT FROM UNDER THE HUD ══
 *
 * Tokens are placed once, when they first appear. The insets are not known until the renderer has
 * measured the HUD (250ms after mount) — so the FIRST placement always happens against the raw
 * canvas, and on a 1440px field that put several tokens squarely behind the roster panel.
 *
 * That is worse than a hidden token. A cat holding one of them still stalks toward it, so the
 * observable behaviour was a cat walking into the side of the roster and pressing against it —
 * which reads as the cats being broken rather than as the tokens being misplaced.
 *
 * Clamping (rather than re-randomising) is deliberate: a token that jumps to a new position on
 * every measure would make the field twitch, and any cat mid-stalk would have its target yanked.
 * A clamp moves only what is actually out of bounds, and only as far as it must.
 */
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
 *      ring into a diagonal streak through the centre of the field.
 *
 * The shared mistake: both tried to REPAIR positions computed against the wrong rectangle. The
 * positions are not repairable, because the information that would make them right — the shape of
 * the playable field — was not available when they were computed.
 *
 * So this LAYS OUT the whole set against the field that actually exists, by index. Deterministic
 * from the token's position in the (already sorted) list, so a re-layout after a resize or a HUD
 * measurement puts everything back in the same relative arrangement rather than reshuffling the
 * field under the user. Cats mid-stalk follow their token because `step` reads its live position
 * every tick.
 */
function layoutTokens(sim: Sim): void {
  const fw = Math.max(1, sim.width - sim.insets.left - sim.insets.right);
  const fh = Math.max(1, sim.height - sim.insets.top - sim.insets.bottom);
  const cx = sim.insets.left + fw / 2;
  const cy = sim.insets.top + fh / 2;

  const tokens = [...sim.tokens.values()];
  const n = Math.max(1, tokens.length);

  tokens.forEach((t, i) => {
    /*
     * A jittered ring, indexed by position.
     *
     * Pure random placement CLUSTERS — on a 390px field, two of fourteen tokens landing on top of
     * each other is not unlikely, it is expected, and two overlapping labels is the difference
     * between "the tickers are legible" and this whole feature failing. Indexing by position gives
     * a guaranteed minimum angular separation; the deterministic jitter (derived from the index,
     * not from `random()`, so a re-layout does not move anything) stops it reading as a clock face.
     */
    /*
     * ══ A JITTERED GRID, NOT A RING ══
     *
     * Three ring versions were tried and all three left most of the field empty. The reason is
     * structural rather than a matter of tuning the radii: a ring puts every token on the BOUNDARY
     * of an ellipse and nothing in its interior, so the middle of the field is empty by
     * construction. Worse, the ellipse is centred on the playable field — and because the HUD's
     * insets are asymmetric (a tall roster on the right, nothing on the left), that centre sits
     * well right of the screen's centre, so the ring rendered as a crescent hugging the right edge
     * with the entire left half of a 1440px viewport blank.
     *
     * A grid fills a rectangle, which is the shape the field actually is. Columns are derived from
     * the aspect ratio so the cells stay roughly square at every width — 320px gets a tall narrow
     * grid, 1440px a wide flat one — and each token is offset within its own cell by a
     * deterministic jitter, which breaks the lattice without ever letting two tokens collide (the
     * jitter is bounded to well inside the cell).
     *
     * Deterministic, from the index: a re-layout after a resize or a HUD measurement reproduces the
     * same arrangement rather than reshuffling the field under the viewer.
     */
    /*
     * ══ COLUMNS ARE CHOSEN SO THE GRID FILLS THE FIELD, NOT SO THE CELLS ARE SQUARE ══
     *
     * `round(sqrt(n * aspect))` is the standard "keep the cells square" formula and it is the wrong
     * objective here. Measured on the 1440px field: 14 tokens in a ~950x700 playable area gives
     * `sqrt(14 * 1.36) ≈ 4.4 → 4` columns and 4 rows — a 4x4 block sitting in the middle of the
     * field with square cells and most of the width unused. Square cells are a property of the
     * CELLS; filling the field is a property of the GRID, and only the second one is visible.
     *
     * `ceil` rather than `round` on the same expression, plus a floor of 3 on any field wide enough
     * to hold three labels, biases toward more columns — which is what spreads the set across the
     * width. Cells end up wider than they are tall on a landscape field, which is correct: the
     * jitter then has more horizontal room, and horizontal room is what a ticker label needs.
     */
    const cols = Math.max(
      fw > 420 ? 3 : 2,
      Math.min(n, Math.ceil(Math.sqrt(n * (fw / Math.max(1, fh))) * 1.35)),
    );
    const rows = Math.max(1, Math.ceil(n / cols));
    const col = i % cols;
    const row = Math.floor(i / cols);
    const pad = t.radius + 14;
    const usableW = Math.max(1, fw - pad * 2);
    // The label hangs BELOW the diamond, so the vertical budget must clear it too — otherwise the
    // ticker, the entire point of the layer, is the part that lands under a panel.
    const usableH = Math.max(1, fh - pad * 2 - 16);
    const cellW = usableW / cols;
    const cellH = usableH / rows;
    // Bounded to ±30% of a cell, so jitter never lets two neighbours reach each other.
    const jx = Math.sin(i * 12.9898) * 0.3;
    const jy = Math.cos(i * 78.233) * 0.3;
    const originX = cx - fw / 2 + pad;
    const originY = cy - fh / 2 + pad;
    t.x = originX + (col + 0.5 + jx) * cellW;
    t.y = originY + (row + 0.5 + jy) * cellH;
  });
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
  if (!Number.isFinite(stakeEth) || stakeEth <= 0) return MIN_CAT_RADIUS;
  /*
   * ══ CALIBRATED TO OUR STAKES, NOT SILVERTONGUE'S ══
   *
   * The coefficient was 90, inherited from silvertongue whose agents hold WHOLE ETH. A stray holds
   * thousandths: the intended $5 adoption is 0.0026 ETH.
   *
   * MEASURED with the old formula: 0.00208 -> r 20.1, and since the sprite scale is
   * `floor(2r / 24)`, that is scale 1 — a 24px cat. Every realistic stake from $4 to $19 collapsed
   * to the SAME minimum sprite, so the size channel carried no information at all and the cat was
   * a speck next to its own quarry.
   *
   * 620 puts the product's real range across the useful scales:
   *   0.0021 ETH ($4)  -> r 44  -> scale 3
   *   0.0083 ETH ($16) -> r 72  -> scale 6
   * A richer stray is now visibly a bigger animal, which is the whole point of encoding it.
   */
  return Math.max(MIN_CAT_RADIUS, Math.min(MAX_CAT_RADIUS, MIN_CAT_RADIUS + Math.sqrt(stakeEth) * 620));
}

/**
 * ══ THE FLOOR AND CEILING WERE RAISED AFTER LOOKING AT THE RENDERED FIELD ══
 *
 * silvertongue's numbers are 9 and 26, and they are right FOR SILVERTONGUE — its agents are drawn
 * as filled circles, and a 9px circle is a perfectly solid mark.
 *
 * A cat is not a circle. The sprite is a 16x16 grid, so `scale = floor(2r / 16)`: at r=9 that is
 * `floor(18/16) = 1`, a **16px cat**, and at r=26 it is `floor(52/16) = 3`, a 48px cat. Measured on
 * the rendered 1440px field with five cats and fourteen tokens: the smallest cats were smaller than
 * the token diamonds they were supposed to be hunting, so the predator read as the prey. A 16px cat
 * also loses its ears and tail to the pixel grid — the two axes ART-DIRECTION §5b says carry a
 * cat's identity — leaving an unrecognisable blob.
 *
 * The floor of 16 gives `floor(32/16) = 2`, a 32px cat: every geometry axis survives, and it is
 * comfortably larger than the 7-17px token diamonds. The ceiling of 40 gives a 80px cat for a whale.
 *
 * The generalisable lesson, and the reason this is a comment rather than two changed numbers: a
 * size constant inherited from a project with a DIFFERENT sprite is a number with no meaning here.
 * The quantisation (`floor(2r/16)`) is the thing that actually decides what a cat looks like, and
 * it only has four usable values in this range — so the floor has to be chosen against the
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
  /*
   * Insert new tokens at the field centre, then lay the whole set out.
   *
   * The position assigned here is a placeholder that `layoutTokens` immediately overwrites — the
   * ring position depends on how many tokens there ARE and on where each sits in the list, neither
   * of which is known while iterating. Doing the arithmetic twice (once here, once in the layout)
   * is how the two earlier versions of this drifted out of agreement.
   */
  for (const t of tokens) {
    const existing = sim.tokens.get(t.address);
    const radius = radiusForCap(t.marketCapEth);
    if (existing !== undefined) {
      existing.radius = radius;
      continue;
    }
    sim.tokens.set(t.address, {
      address: t.address,
      symbol: t.symbol,
      x: sim.width / 2,
      y: sim.height / 2,
      phase: sim.random() * Math.PI * 2,
      radius,
      huntable: t.huntable,
    });
  }

  layoutTokens(sim);
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
/**
 * ══ THE STALK SPEED IS SET BY HOW LONG THE HUNT SHOULD TAKE, NOT BY WHAT LOOKS RIGHT ALONE ══
 *
 * Measured on the real field before this was raised: at 2.6px/tick a cat took **282 ticks — 9.4
 * seconds** to cross a 1440px field and reach its token. Nine seconds of a cat walking in a
 * straight line is not a hunt, it is a progress bar, and a visitor arriving from a screenshot
 * (DESIGN §7 step 1) has left before it lands.
 *
 * 5.4px/tick puts a worst-case crossing at ~4.5s and a typical one under 3s, which is inside the
 * window where a viewer will still be watching the cat they started watching. It is also still
 * visibly SLOWER than the pounce, which is what keeps the two beats distinct — a stalk that moves
 * at pounce speed erases the pounce.
 */
const STALK_SPEED = 5.4;
/** The pounce is FAST. This is the only speed in the file tuned for a beat rather than a path. */
const POUNCE_SPEED = 7.5;
const DRAG_SPEED = 2.4;
const SLINK_SPEED = 1.5;

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

    /*
     * ══ A HARD CEILING ON WHAT ONE TICK MAY MOVE — the anti-teleport guarantee ══
     *
     * Every mode sets its own speed, but `separate` ADDS to `vx`/`vy` after the fact, and the soft
     * containment below adds again on the next tick. Measured before this clamp: a pounce whose
     * nominal ceiling is 7.5px/tick produced a **9.03px** single-tick step — the separation force
     * stacking on top of an already-saturated seek velocity.
     *
     * 9px in one tick is not visually a teleport, so this was invisible in a screenshot and only
     * showed up because the headless harness measured the maximum per-tick displacement. But the
     * brief's requirement is "cats must not teleport", and a speed cap that any other force can
     * quietly exceed is not a cap — it is a suggestion. This makes the invariant hold no matter
     * what else pushes on the body, which is the difference between a bound and a hope.
     *
     * The ceiling is the pounce speed, the fastest legitimate motion in the file. Nothing may
     * exceed the fastest thing a cat is supposed to be able to do.
     */
    clampSpeed(body, POUNCE_SPEED);

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

    /*
     * ══ SOFT CONTAINMENT, AGAINST THE PLAYABLE FIELD RATHER THAN THE CANVAS ══
     *
     * The canvas is the full viewport, but a large part of it is under opaque HUD panels — the
     * roster on the right, the stat block top-left, the adopt panel bottom-left. Measured on the
     * rendered field: three of five hunting cats were completely INVISIBLE, sitting behind the
     * roster, and one had drifted into the strip under the top bar. A cat nobody can see is
     * indistinguishable from a cat that is not there, which undoes the entire feature.
     *
     * `insets` is the margin the HUD actually occupies, supplied by the renderer from the same
     * measured rectangles the label placer uses. Cats are pushed out of it. This is NOT a hard
     * wall — the push is a gentle acceleration like every other containment force here, so a cat
     * that a resize strands under a panel walks out rather than snapping.
     */
    const margin = body.radius + 12;
    const left = sim.insets.left + margin;
    const right = sim.width - sim.insets.right - margin;
    const top = sim.insets.top + margin;
    const bottom = sim.height - sim.insets.bottom - margin;
    if (body.x < left) body.vx += 0.14;
    if (body.x > right) body.vx -= 0.14;
    if (body.y < top) body.vy += 0.14;
    if (body.y > bottom) body.vy -= 0.14;
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

/** How much clear space separation tries to keep between two prowling cats. */
const SEPARATION_GAP = 40;

/**
 * Cell size for the separation grid — DERIVED, not a magic number.
 *
 * Separation only acts within `a.radius + b.radius + SEPARATION_GAP`. For the 3x3 neighbourhood
 * scan below to be EXACT rather than approximate, the cell must be at least the largest possible
 * interaction distance: two maximum-radius bodies plus the gap. Anything smaller silently MISSES
 * pairs, which presents as large cats overlapping and is very hard to attribute back to here.
 *
 * This was a hardcoded 128 whose comment justified it against a max radius of 26. Raising the
 * radius cap to 40 (see `MAX_CAT_RADIUS`) made `40+40+40 = 120` — still under 128, so it happened
 * to survive. That is the exact shape of a latent bug: correct by luck, with a comment asserting
 * an invariant that no longer held. Deriving it means the next radius change cannot break it.
 */
const SEPARATION_CELL = MAX_CAT_RADIUS * 2 + SEPARATION_GAP;

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
    const min = a.radius + b.radius + SEPARATION_GAP;
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
