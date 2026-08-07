/**
 * POSITION SIZING, STOPS, THE DRAWDOWN HALT, AND A DURABLE SPEND LEDGER.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE ONE INVARIANT THIS FILE EXISTS TO PRESERVE: GETTING OUT IS ALWAYS ALLOWED ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * DESIGN §6 Rule 5, inherited from meridian's own circuit breaker, which deliberately does not
 * guard withdrawals: *"getting OUT is always allowed."* DESIGN §7 step 8 makes it a product
 * requirement: withdrawal "must be reachable at all times and must never be gated by any risk
 * control."
 *
 * Every gate in this file therefore constrains exactly one verb: **entering**. There is no
 * function here that can return "you may not sell" or "you may not withdraw", and that is enforced
 * by the TYPE — `EntryGate` is the only gating result, `mayExit()` returns a literal `true`, and
 * `risk.test.ts` trips every control simultaneously and asserts an exit is still permitted. A risk
 * control that can trap a user's capital in a falling position is not a risk control; it is the
 * risk.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ STOP LOSSES EXIST HERE BECAUSE MERIDIAN HAD NONE (DESIGN §6 Rule 4) ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * DESIGN §6 Rule 4: meridian has **no trailing stop and no drawdown halt at all**. For tokenized
 * AAPL that is survivable — an equity does not go to zero in an afternoon and there is an
 * off-chain NAV pulling the price back. For a memecoin with no NAV anchor it is not survivable,
 * and the measured distribution says so: RESEARCH §3d found 24h moves ranging **−17.1% to +38.8%**.
 * The left tail is real, it is large, and nothing arbitrages it back.
 *
 * So a stray carries two independent controls, at two different scales:
 *
 *   1. **A HARD STOP on the position** (`STOP_LOSS_BPS`, −235bps, derived in `signal.ts`).
 *      Per-trade. Fires on price alone.
 *   2. **A DRAWDOWN HALT on the stray** (`maxDrawdownBps`). Per-agent, across trades. Stops it
 *      opening anything new once cumulative equity has fallen far enough.
 *
 * Two controls rather than one because they fail differently: a stop that is never hit says
 * nothing about a stray that is bleeding out over twenty small losing round trips, each of which
 * exited above its stop. DESIGN §2 makes this visible in the product — *"a cat that is losing
 * money is drawn starving"* — and the halt is what starves it rather than letting it round-trip
 * to zero.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE SPEND LEDGER IS AN INTERFACE, NOT A MAP, BECAUSE OF RESEARCH §7f ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * RESEARCH §7f, on meridian `risk.ts:7-11`: *"An in-memory daily cap is not a daily cap. meridian's
 * reset only on process restart, so it was really 'spend since last boot': long uptime falsely
 * blocked, frequent redeploys never enforced."*
 *
 * Note both halves of that failure — it is not merely "the cap was too loose". It was
 * SIMULTANEOUSLY too loose and too tight, in a way that depended on deploy cadence rather than on
 * anything about the money. That is why the fix is not "reset it on a timer" but "put it somewhere
 * that outlives the process".
 *
 * `@taia/authority`'s `bounds.ts` makes the same argument from the Lobstar Wilde incident
 * (~$250k, a decimal error, *"a session crash reset the agent's wallet state"*) and concludes:
 * *"every function here is pure and takes the prior state explicitly — the caller is forced to
 * decide where that state durably lives, and the honest answer is on chain or in a database, never
 * in the process that is being constrained."*
 *
 * So this module defines `SpendLedger` as an ASYNC INTERFACE. Async is load-bearing: a synchronous
 * signature is one a caller can satisfy with a `Map`, and a type that permits the bug is a type
 * that will eventually get it. The in-memory implementation below exists ONLY for tests and says
 * so in its name and in a runtime-visible `durable: false` flag, which `assertDurableLedger`
 * refuses in production.
 *
 * RESEARCH §9 adds the constraint that closes the loop: HOUSE_ADDRESS is shared across projects
 * and *"its balance moved BOTH directions and its nonce advanced 980 → 992 during a session in
 * which CUSTODIAN sent nothing"*, therefore **a spend cap CANNOT be enforced by watching a
 * balance**. The ledger records our own sends, keyed by idempotency key, and reconciles against
 * tx hashes from those sends only.
 */

import { STOP_LOSS_BPS } from "./signal.js";

const BPS_DENOMINATOR = 10_000n;

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * THE DURABLE SPEND LEDGER
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** One recorded outbound spend. Keyed by idempotency key so a retry storm cannot double-count. */
export type SpendRecord = {
  /** Unique per logical action. The dedup key that defeats retry storms. */
  readonly idempotencyKey: string;
  readonly strayId: string;
  readonly amountWei: bigint;
  /** Unix seconds. Passed in by the caller — this module reads no clock. */
  readonly atSeconds: number;
};

/**
 * Where spend accounting lives. **Must outlive the process.**
 *
 * Async by design: see the header. A `Map`-backed implementation cannot honestly satisfy an
 * interface whose whole purpose is surviving a restart, and making the signature async at least
 * forces an implementor to confront that they are writing to something.
 */
export type SpendLedger = {
  /**
   * FALSE for any implementation that dies with the process. Checked by `assertDurableLedger`.
   *
   * A boolean an implementor must actively set is not a guarantee, but it converts a silent
   * failure into a declared one — the difference RESEARCH §7g is about.
   */
  readonly durable: boolean;
  /** Total spent by this stray inside the window ending at `nowSeconds`. */
  readonly spentInWindow: (
    strayId: string,
    windowSeconds: number,
    nowSeconds: number,
  ) => Promise<bigint>;
  /** Number of spends by this stray inside the window. A value cap alone misses a retry storm. */
  readonly countInWindow: (
    strayId: string,
    windowSeconds: number,
    nowSeconds: number,
  ) => Promise<number>;
  /** Has this exact key already executed? */
  readonly hasKey: (idempotencyKey: string) => Promise<boolean>;
  /**
   * Commit a spend. MUST be called BEFORE signing, never after.
   *
   * `@taia/authority`'s `STATE_COMMIT_RULE` documents the race this avoids: Privy's own docs state
   * that "aggregation values are updated AFTER a request is successfully signed, not before. This
   * means multiple concurrent requests may all pass policy evaluation before any of their values
   * are recorded" — a time-of-check/time-of-use gap that a retry storm passes straight through.
   */
  readonly record: (record: SpendRecord) => Promise<void>;
};

export const LEDGER_COMMIT_RULE =
  "commit the spend to the ledger BEFORE signing, not after. Committing afterwards leaves a " +
  "time-of-check/time-of-use gap that concurrent retries pass straight through — Privy documents " +
  "exactly this race in its own stateful policies, and RESEARCH §7e records meridian shipping an " +
  "in-process mutex that two processes holding the same key defeat entirely";

/**
 * Refuse a non-durable ledger on the money path.
 *
 * This is the RESEARCH §7g check applied to ourselves: *"A flag saying 'automatic' is not
 * automation."* A `durable: false` ledger that reaches production would reproduce meridian's
 * "spend since last boot" bug exactly, so it throws rather than warns.
 */
export function assertDurableLedger(ledger: SpendLedger): void {
  if (!ledger.durable) {
    throw new Error(
      "refusing a non-durable spend ledger on the money path. An in-memory daily cap is not a " +
        "daily cap: meridian's reset on process restart, so it was really 'spend since last " +
        "boot' — long uptime falsely blocked, frequent redeploys never enforced (RESEARCH §7f). " +
        "Back this with Postgres or on-chain state, never with a Map",
    );
  }
}

/**
 * An in-memory ledger. **FOR TESTS ONLY** — `durable` is `false` and `assertDurableLedger` throws.
 *
 * `snapshot()` / `restore()` exist so a test can simulate a process restart by round-tripping the
 * records through a serialisable form, which is the closest an in-memory fake can honestly get to
 * proving the durability property. `risk.test.ts` uses exactly that to prove the cap survives.
 */
export function createMemorySpendLedger(seed: readonly SpendRecord[] = []): SpendLedger & {
  readonly snapshot: () => readonly SpendRecord[];
} {
  const records: SpendRecord[] = [...seed];
  const inWindow = (strayId: string, windowSeconds: number, nowSeconds: number) =>
    records.filter((r) => r.strayId === strayId && nowSeconds - r.atSeconds < windowSeconds);

  return {
    durable: false,
    spentInWindow: (strayId, windowSeconds, nowSeconds) =>
      Promise.resolve(
        inWindow(strayId, windowSeconds, nowSeconds).reduce((sum, r) => sum + r.amountWei, 0n),
      ),
    countInWindow: (strayId, windowSeconds, nowSeconds) =>
      Promise.resolve(inWindow(strayId, windowSeconds, nowSeconds).length),
    hasKey: (key) => Promise.resolve(records.some((r) => r.idempotencyKey === key)),
    record: (record) => {
      if (!records.some((r) => r.idempotencyKey === record.idempotencyKey)) records.push(record);
      return Promise.resolve();
    },
    snapshot: () => [...records],
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * SIZING, STOPS AND THE DRAWDOWN HALT
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

export type RiskConfig = {
  /**
   * The ETH a stray puts into one position, in wei.
   *
   * DERIVATION: DESIGN §2 fixes the stake at **$5 of ETH** and RESEARCH §3c Rule 2 removes the
   * usual reason to vary it — *"position size does not change the bar. Cost is flat in bps from $5
   * to $50 because tax is proportional and gas is negligible."* This is a genuinely different
   * regime from openhood, whose cost was U-shaped in size ($1 → 166bps, $50 → 18bps minimum,
   * $1000 → 82bps) because gas dominated there. **The sizing logic built on that U-curve is not
   * ported**, because the curve it optimised against does not exist here.
   *
   * So size is a flat fraction of the compartment rather than an optimisation. See `sizePosition`.
   */
  readonly positionFractionBps: bigint;

  /** Never stake more than this in one position, whatever the fraction works out to. */
  readonly maxPositionWei: bigint;

  /**
   * Never open a position smaller than this.
   *
   * DERIVATION: gas is a FLAT ~$0.016 per round trip (RESEARCH §3b), so its share in bps rises as
   * 1/size. At $5 gas is ~32bps of 231bps total. At $1 the same gas is ~160bps and the round trip
   * is ~360bps, which pushes the required gain past 720bps — most of a full mean-absolute 24h
   * move, for a trade whose absolute profit would be pennies. This floor is where the cost model
   * stops describing a trade worth making.
   */
  readonly minPositionWei: bigint;

  /** Hard per-position stop, in bps of the entry. Defaults to `signal.ts`'s derived level. */
  readonly stopLossBps: bigint;

  /**
   * Per-stray drawdown halt, in bps below the stray's high-water mark.
   *
   * DERIVATION: at a 231bps round trip and a −235bps stop, a stray that enters, is stopped out,
   * and pays the round trip loses ~466bps of the position per full losing cycle. At the default
   * `positionFractionBps` of 5000 (half the compartment per trade) that is ~233bps of TOTAL equity
   * per losing cycle. 2000bps (−20%) is therefore ~8–9 consecutive full losing cycles.
   *
   * Why not tighter: fewer than ~5 cycles and the halt fires on ordinary variance rather than on
   * evidence, and DESIGN §2 wants a cat that is genuinely losing to starve — not one that had a
   * bad afternoon. Why not looser: RESEARCH §3d's measured left tail is −17.1% over 24h, so a halt
   * set beyond ~2500bps could be jumped clean over by a single day's move and would never bind.
   * 2000bps sits inside that tail with room to actually fire.
   */
  readonly maxDrawdownBps: bigint;

  /** Spend window for the daily cap, in seconds. 86400 = one day. */
  readonly spendWindowSeconds: number;

  /**
   * Max ETH a stray may commit to NEW positions inside the window.
   *
   * DERIVATION: RESEARCH §9 records the budget as a **policy** limit, not a balance limit — the
   * house wallet holds 7.7x the stated $10 budget and is shared across projects, so *"a spend cap
   * CANNOT be enforced by watching this balance."* It has to be counted, durably, here.
   */
  readonly maxSpendPerWindowWei: bigint;

  /**
   * Max NEW positions inside the window, as a count.
   *
   * Distinct from the value cap for the reason `@taia/authority` gives: Zodiac Roles v2 models
   * `WithinAllowance` (value) and `CallWithinAllowance` (count) separately because *"a retry storm
   * can stay under every value cap while making hundreds of calls, and only a count catches it."*
   * It is also DESIGN §6 Rule 6's brake: meridian's 20-second rotation loop lost 2.8% in two hours
   * and the strategy was retired. At a 60-minute signal horizon, 6 entries a day is already more
   * turnover than the horizon justifies.
   */
  readonly maxEntriesPerWindow: number;
};

export const DEFAULT_RISK: RiskConfig = {
  positionFractionBps: 5000n, // half the compartment per position
  maxPositionWei: 5_000_000_000_000_000n, // 0.005 ETH ~= $9.64 — above the $5 stake, below the $10 budget
  minPositionWei: 1_000_000_000_000_000n, // 0.001 ETH ~= $1.93 — below this gas dominates
  stopLossBps: STOP_LOSS_BPS, // −235bps, derived in signal.ts
  maxDrawdownBps: 2000n, // −20%
  spendWindowSeconds: 86_400,
  maxSpendPerWindowWei: 10_000_000_000_000_000n, // 0.01 ETH ~= $19.27
  maxEntriesPerWindow: 6,
};

/** A stray's durable state. Supplied by the caller; this module holds nothing. */
export type StrayState = {
  readonly strayId: string;
  /** Free ETH in the stray's compartment, in wei. */
  readonly compartmentWei: bigint;
  /** Highest total equity this stray has ever reached, in wei. The drawdown reference. */
  readonly highWaterMarkWei: bigint;
  /** Current total equity: free ETH plus the mark-to-market value of any open position. */
  readonly equityWei: bigint;
  /** The open position, if any. */
  readonly position: OpenPosition | undefined;
};

export type OpenPosition = {
  readonly token: string;
  /** ETH committed at entry, in wei. */
  readonly entryWei: bigint;
  /** ETH price per token at entry, scaled 1e18. */
  readonly entryPriceWei: bigint;
  /** Full-precision token balance. NEVER a number — RESEARCH §7d. */
  readonly tokenBalance: bigint;
  readonly openedAtSeconds: number;
};

/**
 * The size of a new position, in wei. Returns 0 when no position may be opened.
 *
 * A flat fraction of the compartment, clamped to [min, max]. Deliberately NOT an optimiser:
 * RESEARCH §3c Rule 2 measured cost as flat in bps across the whole size range we can reach, so
 * there is no curve to optimise against and any sizing rule fancier than this would be fitting a
 * shape that does not exist.
 */
export function sizePosition(state: StrayState, cfg: RiskConfig): bigint {
  if (state.compartmentWei <= 0n) return 0n;
  const raw = (state.compartmentWei * cfg.positionFractionBps) / BPS_DENOMINATOR;
  const capped = raw > cfg.maxPositionWei ? cfg.maxPositionWei : raw;
  // Never size ABOVE what is actually in the compartment, whatever the caps say.
  const affordable = capped > state.compartmentWei ? state.compartmentWei : capped;
  return affordable < cfg.minPositionWei ? 0n : affordable;
}

/**
 * The minimum acceptable output for a swap, in the swap's output units.
 *
 * RESEARCH §7c: *"`amountOutMinimum = 0` is a free MEV sandwich."* The proven mainnet transaction
 * openhood decoded carried zeros in both slippage slots — the ENCODING is safe to reuse, those two
 * parameters are not. This function therefore **cannot return zero**: it throws instead, because a
 * zero returned from a function named `minOut` is indistinguishable at the call site from a
 * deliberate "no floor".
 */
export function minOutFor(args: {
  readonly expectedOut: bigint;
  readonly slippageBps: bigint;
}): bigint {
  if (args.expectedOut <= 0n) {
    throw new Error(
      "refusing to compute a slippage floor from a non-positive expected output — a zero floor " +
        "is a free MEV sandwich (RESEARCH §7c)",
    );
  }
  if (args.slippageBps < 0n || args.slippageBps >= BPS_DENOMINATOR) {
    throw new Error(
      `refusing a slippage tolerance of ${args.slippageBps.toString()}bps — at or above 100% the ` +
        "floor collapses to zero, which is the sandwich this function exists to prevent",
    );
  }
  const minOut = (args.expectedOut * (BPS_DENOMINATOR - args.slippageBps)) / BPS_DENOMINATOR;
  if (minOut <= 0n) {
    throw new Error(
      "slippage floor rounded to zero. A zero floor in amountOutMinimum or TAKE_ALL.minAmount is " +
        "a free MEV sandwich and must never be encoded (RESEARCH §7c)",
    );
  }
  return minOut;
}

/** Current drawdown from the high-water mark, in bps. 0 when at or above the mark. */
export function drawdownBps(state: StrayState): bigint {
  if (state.highWaterMarkWei <= 0n) return 0n;
  if (state.equityWei >= state.highWaterMarkWei) return 0n;
  return ((state.highWaterMarkWei - state.equityWei) * BPS_DENOMINATOR) / state.highWaterMarkWei;
}

/**
 * Has the HARD STOP fired on an open position?
 *
 * Price-only and unconditional. It does not consult the drawdown halt, the spend ledger, or the
 * cost of exiting — a stop that could be talked out of firing by another control is not a stop.
 * DESIGN §6 Rule 4 exists because meridian had none of this at all.
 */
export function stopFired(args: {
  readonly position: OpenPosition;
  readonly markPriceWei: bigint;
  readonly stopLossBps: bigint;
}): { readonly fired: boolean; readonly moveBps: bigint; readonly reason: string } {
  if (args.position.entryPriceWei <= 0n) {
    throw new Error("refusing to evaluate a stop against a non-positive entry price");
  }
  const moveBps =
    ((args.markPriceWei - args.position.entryPriceWei) * BPS_DENOMINATOR) /
    args.position.entryPriceWei;
  const fired = moveBps <= -args.stopLossBps;
  return {
    fired,
    moveBps,
    reason: fired
      ? `STOP: ${args.position.token} is ${moveBps.toString()}bps from entry, at or beyond the ` +
        `-${args.stopLossBps.toString()}bps hard stop. Exiting now`
      : `no stop: ${moveBps.toString()}bps from entry, stop at -${args.stopLossBps.toString()}bps`,
  };
}

/** Why an ENTRY was refused. Note there is no exit reason type — exits are never refused. */
export type EntryDenialReason =
  | "drawdown-halt"
  | "position-open"
  | "size-below-floor"
  | "window-spend-cap"
  | "window-count-cap"
  | "duplicate-key"
  | "no-compartment";

export type EntryGate =
  | { readonly allowed: true; readonly sizeWei: bigint }
  | { readonly allowed: false; readonly reason: EntryDenialReason; readonly detail: string };

/**
 * May this stray open a NEW position, and for how much?
 *
 * Async because the durable ledger is. **This function gates entries and nothing else** — there is
 * no code path from here to a refusal to sell. See `mayExit`.
 *
 * Every check is evaluated even after one fails, and the FIRST failure is reported with the count
 * of others, so a caller correcting one denial does not discover the next on a retry — the retry
 * storm `@taia/authority` bounds.
 */
export async function mayEnter(args: {
  readonly state: StrayState;
  readonly cfg: RiskConfig;
  readonly ledger: SpendLedger;
  readonly idempotencyKey: string;
  readonly nowSeconds: number;
}): Promise<EntryGate> {
  const { state, cfg, ledger, nowSeconds } = args;

  if (state.position !== undefined) {
    return {
      allowed: false,
      reason: "position-open",
      detail:
        `${state.strayId} already holds ${state.position.token}. One position at a time: a stray ` +
        "with $5 cannot diversify, and pretending otherwise just multiplies the round-trip cost",
    };
  }

  const dd = drawdownBps(state);
  if (dd >= cfg.maxDrawdownBps) {
    return {
      allowed: false,
      reason: "drawdown-halt",
      detail:
        `${state.strayId} is ${dd.toString()}bps below its high-water mark of ` +
        `${state.highWaterMarkWei.toString()} wei, at or past the ${cfg.maxDrawdownBps.toString()}bps ` +
        "halt. It stops hunting and starves rather than round-tripping to zero (DESIGN §6 Rule 4). " +
        "Its owner may still withdraw everything, right now — the halt gates entries only",
    };
  }

  if (state.compartmentWei <= 0n) {
    return {
      allowed: false,
      reason: "no-compartment",
      detail: `${state.strayId} has no free ETH to stake`,
    };
  }

  if (await ledger.hasKey(args.idempotencyKey)) {
    return {
      allowed: false,
      reason: "duplicate-key",
      detail:
        `idempotency key ${args.idempotencyKey} has already executed. This is a repeat, not a ` +
        "new entry — without this check a retry loop re-executes the same buy",
    };
  }

  const sizeWei = sizePosition(state, cfg);
  if (sizeWei <= 0n) {
    return {
      allowed: false,
      reason: "size-below-floor",
      detail:
        `sized position from ${state.compartmentWei.toString()} wei falls below the ` +
        `${cfg.minPositionWei.toString()} wei floor. Below it the flat ~$0.016 gas is a large ` +
        "enough share of the position that the required gain exceeds a typical daily move",
    };
  }

  const spent = await ledger.spentInWindow(state.strayId, cfg.spendWindowSeconds, nowSeconds);
  if (spent + sizeWei > cfg.maxSpendPerWindowWei) {
    return {
      allowed: false,
      reason: "window-spend-cap",
      detail:
        `${spent.toString()} wei already committed in this ${String(cfg.spendWindowSeconds)}s ` +
        `window; ${sizeWei.toString()} more would exceed the ${cfg.maxSpendPerWindowWei.toString()} ` +
        "wei cap. This is counted from a DURABLE ledger — an in-memory one resets on restart and " +
        "is really 'spend since last boot' (RESEARCH §7f)",
    };
  }

  const count = await ledger.countInWindow(state.strayId, cfg.spendWindowSeconds, nowSeconds);
  if (count + 1 > cfg.maxEntriesPerWindow) {
    return {
      allowed: false,
      reason: "window-count-cap",
      detail:
        `${String(count)} entries already this window, limit ${String(cfg.maxEntriesPerWindow)}. ` +
        "A count cap catches a retry storm that stays under every value cap, and it is the brake " +
        "on the 20-second rotation loop that lost meridian 2.8% in two hours (DESIGN §6 Rule 6)",
    };
  }

  return { allowed: true, sizeWei };
}

/**
 * MAY THIS STRAY EXIT? **Always yes.** Returns the literal `true`, not a boolean.
 *
 * The return type is `true` rather than `boolean` on purpose: it makes "no risk control may block
 * an exit" a compile-time property rather than a convention somebody could later amend by adding
 * a condition. Any future edit that tries to return `false` here fails to typecheck.
 *
 * DESIGN §6 Rule 5 and §7 step 8. meridian's circuit breaker deliberately does not guard
 * withdrawals — *"getting OUT is always allowed"* — and a stray's owner must be able to reach
 * their capital while the drawdown halt is tripped, the spend cap is exhausted, and the stray is
 * starving. `risk.test.ts` trips all of those at once and asserts this still returns true.
 */
export function mayExit(): true {
  return true;
}
