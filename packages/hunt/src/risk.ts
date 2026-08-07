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
 * ══ EIGHT SLOTS, NOT ONE — THE MEASUREMENT THAT RESCUED THE STRATEGY ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * This module used to refuse every entry with `reason: "position-open"` while a stray held
 * anything, and the refusal carried a confident justification: *"One position at a time: a stray
 * with $5 cannot diversify, and pretending otherwise just multiplies the round-trip cost."* That
 * sentence is arithmetically fine and it was the single most expensive line in the package,
 * because the constraint it defends is not about diversification at all — **it is about sample
 * size**, and RESULTS §10.5 measured what it costs on held-out data:
 *
 *     slots   usd   taken/72   skipped   median bps
 *       1     $ 5      17         55      +1,921     <- Welch t 1.16, NOT significant
 *       4     $10      48         24      +4,263
 *       6     $15      66          6      +4,410
 *       8     $20      71          1      +4,410     <- Welch t 2.38 … 2.72 on 20/20 seeds
 *
 * **The per-ticket edge is identical across the ladder. What changes is n.** A single slot is
 * occupied for hours or days by the first eligible token and refuses the other 55, so seventeen
 * observations have to carry the whole claim and they cannot. More capital does not improve the
 * edge; it lets the cat TAKE the trades it was already identifying. Ibrahim raised user funding to
 * $10–20, which at the 0.001 ETH position floor is 4–8 concurrent slots.
 *
 * `MAX_POSITIONS` is 8 here and 8 in `StrayVault.sol`, and they are not allowed to disagree — the
 * contract's slot array is fixed at 8 so `withdraw`'s gas cannot be inflated by a keeper, and a
 * keeper that believed in 9 would simply get `NoFreeSlot` on the ninth every time. `risk.test.ts`
 * pins the constant against the contract source.
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
 *   1. **A TRAILING STOP on each position** (`TRAIL_BPS`, 50% from the running peak, derived in
 *      `trail.ts`). Per-trade. Fires on price relative to the position's own watermark.
 *   2. **A DRAWDOWN HALT on the stray** (`maxDrawdownBps`). Per-agent, across trades. Stops it
 *      opening anything new once cumulative equity has fallen far enough.
 *
 * Two controls rather than one because they fail differently: a stop that is never hit says
 * nothing about a stray that is bleeding out over twenty small losing round trips, each of which
 * exited above its stop. DESIGN §2 makes this visible in the product — *"a cat that is losing
 * money is drawn starving"* — and the halt is what starves it rather than letting it round-trip
 * to zero.
 *
 * **`stopFired` — the −235bps hard level stop — is NO LONGER ON THE DECISION PATH.** It remains
 * exported and tested because `@strays/backtest` replays the old family against it and a refuted
 * hypothesis you can no longer run is a refutation you have to take on trust. RESULTS §10 measured
 * that a level stop derived from typical volatility closes exactly the positions that pay for
 * everything; `trail.ts`'s header has the arithmetic.
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
import { TRAIL_BPS } from "./trail.js";

const BPS_DENOMINATOR = 10_000n;

/**
 * How many positions one stray may hold at once. **Eight, and it must equal
 * `StrayVault.MAX_POSITIONS`.**
 *
 * DERIVED FROM A MEASUREMENT, not from a preference — the ladder in the header. At 8 slots the
 * strategy takes 71 of 72 held-out opportunities and the Welch t against matched random is
 * 2.38–2.72 on 20 of 20 seeds; at 1 slot it takes 17 and the t collapses to 1.16, which is not
 * significant. The edge per ticket is the same number in both rows.
 *
 * Why not 16: the contract bounds every loop — including the one inside `withdraw` — at this
 * constant, so it is also the bound on how expensive a keeper can make a user's exit. §10.5's
 * ladder is already flat between 6 and 8 slots (both +4,410bps median, 66 and 71 of 72 taken), so
 * a larger array buys ~1 extra opportunity at the cost of doubling the gas a user must pay to get
 * out. **An exit whose cost the keeper controls is an exit the keeper can deny**, and that trade is
 * not worth one ticket.
 *
 * Why not 4: $10 of funding buys 4 slots and takes 48 of 72, which is most of the way there. 8 is
 * the top of the funding range Ibrahim actually raised to, and the contract has to be built for the
 * largest stray it will hold rather than the median one.
 */
export const MAX_POSITIONS = 8;

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
   *
   * ══ RETUNED FOR EIGHT SLOTS: 1250bps, WHICH IS 10000/8 ══
   *
   * It was 5000bps — half the compartment per position — which was the right number for a stray
   * that could hold exactly one thing and is the wrong number for one that holds eight. At 5000bps
   * a stray puts half its money in its FIRST idea and is out of capital after two, so it would own
   * a 2-slot portfolio while paying for an 8-slot contract: the §10.5 ladder's whole finding
   * (17 → 71 of 72 opportunities taken) would be silently unavailable.
   *
   * 1250bps = 10000/8 is the fraction that lets the eighth slot be funded from the same compartment
   * the first one was, so a stray divides its compartment ACROSS its slots rather than concentrating
   * it in one. Note this is deliberately expressed against the WHOLE compartment rather than against
   * "free capital / free slots": a rule that re-divides the remainder each time sizes the first
   * position at 1/8, the second at 1/8 of 7/8, and so on, which gives the earliest and least
   * informed idea the largest stake. Flat is the honest rule for a cost curve that is flat, and
   * §10.5 measured no per-ticket edge difference between slots.
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

  /**
   * The TRAILING stop, in bps below each position's running peak. **The live exit rule.**
   *
   * Derived in `trail.ts` from held-out measurement: 5000bps = 50% from the watermark. Config
   * rather than a constant `decide()` reads directly, for the reason `edgeMultiple` is config —
   * `@strays/backtest` recorded that a parameter it cannot sweep is a parameter nobody can show to
   * be the right one, having swept one and got four byte-identical rows.
   */
  readonly trailBps: bigint;

  /**
   * The old HARD level stop, in bps of the entry. **No longer on the decision path.**
   *
   * Retained on the config so `@strays/backtest` can replay the refuted family it belongs to
   * (`stopFired` is still exported for the same reason). RESULTS §10 measured that a level stop
   * derived from typical volatility is precisely backwards on this asset: it closes the positions
   * that pay for everything. `decide()` does not read this field.
   */
  readonly stopLossBps: bigint;

  /**
   * How many positions this stray may hold at once. Capped at `MAX_POSITIONS` by `mayEnter`.
   *
   * Config rather than the constant directly because the funding ladder is a REAL product variable
   * — §10.5 measured 1/4/6/8 slots at $5/$10/$15/$20 — and a $10 stray genuinely has four slots,
   * not eight. `mayEnter` clamps it to `MAX_POSITIONS` regardless, because the contract's array is
   * fixed at 8 and a ninth entry would revert `NoFreeSlot` after we had already committed the spend
   * to the ledger.
   */
  readonly maxPositions: number;

  /**
   * Per-stray drawdown halt, in bps below the stray's high-water mark.
   *
   * DERIVATION, RE-RUN FOR THE NEW EXIT AND THE NEW SIZING — the old one is stated first because
   * the number did not change and that could otherwise look like inattention.
   *
   * It was: at a 231bps round trip and a −235bps hard stop, a full losing cycle costs ~466bps of
   * the position; at `positionFractionBps` 5000 that is ~233bps of total equity, so 2000bps is
   * ~8–9 consecutive losing cycles.
   *
   * It is now: the exit is a 50% trailing stop, so a full losing cycle costs up to ~5000bps of the
   * position plus the ~208bps round trip. But `positionFractionBps` is now 1250 rather than 5000,
   * so a single losing position costs ~(5000+208) x 0.125 = ~651bps of total equity. 2000bps is
   * therefore ~3 fully-lost positions out of eight — and note the halt is now reached by BREADTH as
   * well as depth, which is the genuinely new shape: eight positions each down 20% trips it too.
   *
   * Three is fewer cycles than the old derivation's eight, and that is the correct direction for a
   * strategy whose measured win rate is 73.6% (§10.4): three total losses out of eight concurrent
   * tickets is far outside what that rate produces by chance, whereas eight would only fire after
   * the stray had lost most of the money. Why not tighter than 2000bps: §10.4's p10 is −2,446bps
   * per ticket, so a halt much below this fires on the ordinary left tail of a winning strategy.
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
   *
   * ══ RETUNED FOR A TRADE RATE THE PAD CAN ACTUALLY SUPPORT ══
   *
   * The shipped pairing was 6 entries per 86400s — 6/day. Combined with an eligibility filter that
   * admitted 1 token in 100, the observed rate was ~0.4/day. The stated aim is **a few trades per
   * hour when signals are genuinely good**.
   *
   * The window is ONE HOUR, so this is a per-hour ceiling rather than a per-day one. It is a
   * CEILING, not a target: a trade still has to pass the sell simulation, clear its own tax bar,
   * sit inside the entry-swap window and win the ranking, so the realised rate is bounded by
   * opportunity. The measured supply says that is the binding constraint — only 16 of the newest
   * 100 tokens are sellable at all.
   *
   * ══ RAISED FROM 3 TO 8, BECAUSE AT 3 IT WOULD HAVE SILENTLY UNDONE THE SLOT LADDER ══
   *
   * 3/hour was derived against a ONE-SLOT stray with a 60-minute momentum horizon, where a fourth
   * entry in an hour meant churning a position that had not resolved yet. Under the new strategy
   * neither half of that holds: positions are held for hours-to-days on a trailing exit, and a
   * stray that is allowed 8 concurrent slots but only 3 new entries per hour cannot fill its own
   * portfolio in under three hours. §10.5's whole finding is about how many of the 72 available
   * opportunities get TAKEN (17 vs 71), and a 3/hour count cap is a second, undocumented way of
   * skipping them.
   *
   * 8 = `MAX_POSITIONS`, so the cap is "you may fill every slot you have, once per hour" and never
   * less. It still binds against the failure a count cap exists for — `@taia/authority` on Zodiac
   * Roles v2: *"a retry storm can stay under every value cap while making hundreds of calls, and
   * only a count catches it"* — because a retry storm produces far more than 8 in an hour, and
   * DESIGN §6 Rule 6's measured failure (meridian's 20-second rotation loop, 2.8% lost in two
   * hours) is a rotation rate this cannot reach: 8 entries/hour against positions held for hours
   * is not rotation, it is filling a portfolio once.
   */
  readonly maxEntriesPerWindow: number;
};

export const DEFAULT_RISK: RiskConfig = {
  // 1250bps = 10000/8: the compartment divided ACROSS the slots, not concentrated in the first idea.
  positionFractionBps: 1250n,
  maxPositionWei: 5_000_000_000_000_000n, // 0.005 ETH ~= $9.64 — above the $5 stake, below the $10 budget
  minPositionWei: 1_000_000_000_000_000n, // 0.001 ETH ~= $1.93 — below this gas dominates
  trailBps: TRAIL_BPS, // 50% from the running peak, derived in trail.ts from held-out measurement
  stopLossBps: STOP_LOSS_BPS, // −235bps, derived in signal.ts. RETAINED FOR REPLAY; not on the path
  maxPositions: MAX_POSITIONS, // 8 — and the contract's array is 8, so it cannot usefully be higher
  maxDrawdownBps: 2000n, // −20%
  // ONE HOUR. The cap below is therefore a per-hour ceiling, not a per-day one — see the field doc.
  spendWindowSeconds: 3600,
  maxSpendPerWindowWei: 10_000_000_000_000_000n, // 0.01 ETH ~= $19.27
  maxEntriesPerWindow: MAX_POSITIONS, // fill every slot once an hour, and no more
};

/** A stray's durable state. Supplied by the caller; this module holds nothing. */
export type StrayState = {
  readonly strayId: string;
  /** Free ETH in the stray's compartment, in wei. */
  readonly compartmentWei: bigint;
  /** Highest total equity this stray has ever reached, in wei. The drawdown reference. */
  readonly highWaterMarkWei: bigint;
  /** Current total equity: free ETH plus the mark-to-market value of any open positions. */
  readonly equityWei: bigint;
  /**
   * THE OPEN POSITIONS. Up to `MAX_POSITIONS` of them, in slot order.
   *
   * An ARRAY, replacing the single `position: OpenPosition | undefined` this type used to carry —
   * and the replacement is the §10.5 finding expressed in the type system. A field that can hold
   * one position is a field that skips 55 of 72 opportunities, and no amount of keeper cleverness
   * gives it a second value. `StrayVault` makes the same change for the same reason, from a
   * `holding` address to `Position[MAX_POSITIONS]`.
   *
   * Mirrors the contract's slot array: index i here is slot i there, which is what lets the keeper
   * name a slot in `flee` and `mark`. Empty slots are simply absent rather than represented by an
   * `undefined` hole — the contract uses `token == address(0)` as its one emptiness test and a
   * second representation of emptiness is a second thing that can disagree.
   */
  readonly positions: readonly OpenPosition[];
};

export type OpenPosition = {
  readonly token: string;
  /**
   * Which contract slot holds this position, 0..MAX_POSITIONS-1.
   *
   * Carried explicitly rather than inferred from the array index, because the keeper has to name a
   * slot in `flee(strayId, slot, minOut)` and `mark(strayId, slot, priceWei)`. An index that means
   * "position of this element in whatever array the caller built" is an index that silently
   * renumbers when a filtered or sorted list is passed, and the object it renumbers into is a
   * different token's money. `StrayVault.flee` reads the token, hook and tickSpacing back FROM the
   * slot, so naming the wrong one sells a different position at this one's `minOut`.
   */
  readonly slot: number;
  /** ETH committed at entry, in wei. */
  readonly entryWei: bigint;
  /** ETH price per token at entry, scaled 1e18. */
  readonly entryPriceWei: bigint;
  /**
   * THE PEAK PRICE WATERMARK. ETH-per-token, scaled 1e18. **The exit is computed from this.**
   *
   * Set to the entry price at entry and raised — never lowered — as the mark climbs. It is on the
   * POSITION because the trailing exit is stateful: `trail.ts` can evaluate it from price relative
   * to the highest price seen since entry, and from nothing else.
   *
   * Supplied by the CALLER, which is the whole point. The chain holds the authoritative copy in
   * `Position.peakPriceWei` (raised by the keeper-only monotone `mark()`), the indexer persists a
   * second copy in Postgres, and this package holds none — a watermark that lived in this process
   * would reset on redeploy, which does not merely lose information but re-anchors the stop to the
   * current price and silently disarms it (RESEARCH §7f, meridian's 'spend since last boot').
   */
  readonly peakPriceWei: bigint;
  /**
   * The hook of the pool this position was entered through.
   *
   * ON THE POSITION rather than re-derived at exit, mirroring `StrayVault.Position.hook` and for
   * the same reason: a sell must address the SAME pool the buy addressed. RESEARCH §7d found two
   * hooks on this pad, and building the exit PoolKey with the other one addresses a pool that
   * either does not exist (a revert) or exists with different liquidity (a real, silent loss).
   */
  readonly hook: string;
  /** Full-precision token balance. NEVER a number — RESEARCH §7d. */
  readonly tokenBalance: bigint;
  readonly openedAtSeconds: number;
  /**
   * The tax tier of the token actually held, as an integer percent.
   *
   * Carried ON THE POSITION rather than read from config, because a stray may now hold any tier.
   * Costing a 10%-tax exit against a config that says 1% understates the round trip by ~1700bps
   * and sets the take-profit far too low — the position must know what it costs to leave.
   */
  readonly taxPct: number;
};

/**
 * How much of this stray's money is committed to open positions, in wei.
 *
 * At COST BASIS, deliberately, not at mark. The number this feeds is the sizing denominator, and
 * sizing off marked-to-market value would make every new position larger while the portfolio is
 * winning and smaller while it is losing — a momentum bet on our own book, added silently to a
 * strategy that already has a directional thesis. Cost basis is the number that does not move.
 */
export function committedWei(state: StrayState): bigint {
  return state.positions.reduce((sum, p) => sum + p.entryWei, 0n);
}

/**
 * The size of a new position, in wei. Returns 0 when no position may be opened.
 *
 * A flat fraction of the stray's TRADING CAPITAL, clamped to [min, max]. Deliberately NOT an
 * optimiser: RESEARCH §3c Rule 2 measured cost as flat in bps across the whole size range we can
 * reach, so there is no curve to optimise against and any sizing rule fancier than this would be
 * fitting a shape that does not exist.
 *
 * ══ WHY THE DENOMINATOR IS free + committed AND NOT free ══
 *
 * This is the multi-slot change, and it is the difference between owning eight positions and
 * owning two.
 *
 * `positionFractionBps` is 1250 = 1/8. Applied to the FREE compartment it compounds downward:
 * a 0.008 ETH stray sizes its first position at 0.001, its second at 1/8 of the remaining 0.007,
 * its third at 1/8 of 0.006125, and by slot 4 it is under the 0.001 ETH floor and refuses to
 * trade — a stray with eight slots and money in the bank would report `size-below-floor` while
 * §10.5's ladder says it should be taking 71 of 72 opportunities.
 *
 * Applied to free + committed it is flat: every slot is sized against the same denominator the
 * first one was, so eight equal positions exactly consume the compartment. That is what "a stray
 * divides its compartment across its slots" means arithmetically, and it is why the fraction is
 * 10000/MAX_POSITIONS rather than a number that felt prudent.
 *
 * The `affordable` clamp below is still what stops it overspending: the fraction says what a slot
 * SHOULD be, and the free compartment says what can actually be paid. A stray whose positions have
 * lost value cannot conjure the difference.
 */
export function sizePosition(state: StrayState, cfg: RiskConfig): bigint {
  if (state.compartmentWei <= 0n) return 0n;
  const tradingCapitalWei = state.compartmentWei + committedWei(state);
  const raw = (tradingCapitalWei * cfg.positionFractionBps) / BPS_DENOMINATOR;
  const capped = raw > cfg.maxPositionWei ? cfg.maxPositionWei : raw;
  // Never size ABOVE what is actually FREE in the compartment, whatever the fraction works out to.
  // Committed capital is already spent; it sets the target size, it cannot pay for a new one.
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
 * Has the HARD LEVEL STOP fired on an open position? **NOT THE LIVE EXIT RULE.**
 *
 * The live exit is `trail.ts`'s `trailingStopFired` — a 50% trail from the position's own peak
 * watermark. This function evaluates the −235bps level stop that used to be the exit, and RESULTS
 * §10 measured that rule to be backwards on this asset: a level derived from typical volatility
 * closes exactly the positions that produce the returns (§10.4: the top 10% of positions carry
 * 76.1% of all profit, and a −235bps stop is inside the noise of every one of them).
 *
 * It is kept, exported and tested because `@strays/backtest` replays the refuted family against it.
 * A refutation you can no longer run is a refutation taken on trust, and this corpus keeps
 * recording what that costs. `decide()` does not call it.
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

/**
 * Why an ENTRY was refused. Note there is no exit reason type — exits are never refused.
 *
 * `"position-open"` is gone and `"slots-full"` has replaced it. The rename is not cosmetic: the old
 * reason asserted that holding ANYTHING disqualified a stray, which §10.5 measured as the single
 * most expensive rule in the package (17 of 72 opportunities taken, Welch t 1.16). The new reason
 * can only fire when all `maxPositions` slots are genuinely occupied.
 */
export type EntryDenialReason =
  | "drawdown-halt"
  | "slots-full"
  | "duplicate-token"
  | "size-below-floor"
  | "window-spend-cap"
  | "window-count-cap"
  | "duplicate-key"
  | "no-compartment";

export type EntryGate =
  | {
      readonly allowed: true;
      readonly sizeWei: bigint;
      /** The contract slot this entry should occupy: the lowest free index. */
      readonly slot: number;
      /** How many slots remain free AFTER this entry. For `/logs`. */
      readonly freeSlotsAfter: number;
    }
  | { readonly allowed: false; readonly reason: EntryDenialReason; readonly detail: string };

/**
 * The lowest free slot index, or `undefined` when every slot is occupied.
 *
 * LOWEST-FIRST, matching `StrayVault.hunt`'s own scan (`if (held == address(0) && slot ==
 * MAX_POSITIONS) slot = i`). The two have to agree: the keeper tells the indexer which slot it
 * expects to have filled, and if this function said "slot 5" while the contract chose 2, the
 * indexer's watermark and the chain's would be attached to different positions — and the trailing
 * stop would then be computed for one token from another token's peak.
 */
export function firstFreeSlot(
  state: StrayState,
  maxPositions: number = MAX_POSITIONS,
): number | undefined {
  const bound = maxPositions < MAX_POSITIONS ? maxPositions : MAX_POSITIONS;
  const taken = new Set(state.positions.map((p) => p.slot));
  for (let i = 0; i < bound; i++) {
    if (!taken.has(i)) return i;
  }
  return undefined;
}

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
  /**
   * The token this entry is FOR, when the caller knows it.
   *
   * Optional so the gate can still be asked the stray-level question ("could this stray enter
   * anything at all?") before a winner has been chosen — which is exactly how `decide()` uses it,
   * once per tick rather than once per candidate. When supplied, it additionally refuses a token
   * the stray is already holding in another slot.
   */
  readonly token?: string;
}): Promise<EntryGate> {
  const { state, cfg, ledger, nowSeconds } = args;

  /*
   * ══ THE SLOT CHECK, WHICH USED TO BE `state.position !== undefined` ══
   *
   * The old refusal fired whenever a stray held anything and carried this justification: "One
   * position at a time: a stray with $5 cannot diversify." §10.5 measured what that costs — 17 of
   * 72 held-out opportunities taken, 55 skipped, Welch t 1.16 (not significant) — against 71 of 72
   * and t 2.38–2.72 at eight slots, with an IDENTICAL per-ticket median. The constraint was never
   * about diversification; it was destroying the sample size the claim needed.
   */
  const configuredSlots =
    cfg.maxPositions < MAX_POSITIONS ? cfg.maxPositions : MAX_POSITIONS;
  const slot = firstFreeSlot(state, configuredSlots);
  if (slot === undefined) {
    return {
      allowed: false,
      reason: "slots-full",
      detail:
        `${state.strayId} holds ${String(state.positions.length)} positions and all ` +
        `${String(configuredSlots)} slots are occupied (${state.positions
          .map((p) => `${String(p.slot)}:${p.token}`)
          .join(", ")}). It hunts again as soon as one exits. Note the slot count is CAPITAL, not ` +
        "conviction: §10.5 measured the same per-ticket edge at 1, 4, 6 and 8 slots and only the " +
        "number of opportunities taken changed (17 -> 71 of 72)",
    };
  }

  /*
   * A stray does not open the SAME token twice. Eight slots is eight ideas, not one idea eight
   * times: doubling into a token multiplies the exposure without adding an observation, which is
   * the opposite of the reason the slots exist. The contract does not enforce this — nothing about
   * a second position in the same token is unsafe — so it is a strategy rule, made here.
   */
  if (args.token !== undefined) {
    const already = state.positions.find(
      (p) => p.token.toLowerCase() === args.token?.toLowerCase(),
    );
    if (already !== undefined) {
      return {
        allowed: false,
        reason: "duplicate-token",
        detail:
          `${state.strayId} already holds ${already.token} in slot ${String(already.slot)}. Eight ` +
          "slots is eight ideas, not one idea eight times — a second position in the same token " +
          "doubles the exposure without adding an observation, and §10.5's finding is entirely " +
          "about the number of DISTINCT opportunities taken",
      };
    }
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

  return {
    allowed: true,
    sizeWei,
    slot,
    freeSlotsAfter: configuredSlots - state.positions.length - 1,
  };
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
