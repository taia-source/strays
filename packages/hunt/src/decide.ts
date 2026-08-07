/**
 * THE DECISION. One pure function combining eligibility, cost, bar, signal and risk.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ PURE AND FULLY DETERMINISTIC — WHICH IS A SECURITY PROPERTY, NOT A STYLE PREFERENCE ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * No LLM. No clock read. No network. No `Math.random`. Time arrives as `nowSeconds` and any
 * randomness would arrive as a parameter, so the same inputs always produce the same Decision and
 * a test can pin every branch without a mock.
 *
 * DESIGN §5 sets the split and it is the whole argument for this file's shape:
 *
 *   | Which tokens are eligible        | deterministic | taxPct == 1 is a hard filter    |
 *   | Which eligible token to hunt     | LLM, cheaply  | narrative judgement             |
 *   | Entry price, size, stop, exit    | deterministic | non-deterministic money movement is untestable |
 *   | Whether to trade at all          | deterministic | the cost bar is arithmetic      |
 *
 * *"The LLM cannot size a position, cannot choose a recipient, and cannot override a stop."* The
 * model's only reachable influence on this function is the ORDER of `market.candidates` — it may
 * suggest what to look at, and nothing else. openhood's parser treated a bare number in any model
 * output as a hard reject, *"no verb takes an amount"*; the amendment DESIGN §5 makes is that
 * **amounts come from the subsystem, never from the model**, which is enforced here by the model
 * having no channel into this function that carries a number at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE STRATEGY THIS FUNCTION NOW IMPLEMENTS, AND THE ONE IT REPLACES ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * **Enter early in a token's life. Hold up to eight at once. Exit on a wide trailing stop.**
 *
 *   ENTRY   `age.ts`   — the token's swap count is inside [20, 50]. NOT a price pattern.
 *   EXIT    `trail.ts` — the mark is 50% or more below that position's own peak watermark.
 *   SLOTS   `risk.ts`  — up to MAX_POSITIONS = 8 concurrent, sized 1/8 of trading capital each.
 *
 * Every one of those three replaces something this file used to do, and each replacement is a
 * measurement rather than a preference. RESULTS.md §10:
 *
 *   - The old entry was a 2-sigma momentum breakout on 60 minutes of price history. That family was
 *     tested eleven times across three rounds and is **refuted**: +145bps of held-out edge against
 *     a −208bps round trip. Worse, STATE.md's quintile table shows it was inverted — a momentum
 *     entry buys the most-run-up quintile by construction, and that quintile's forward net is
 *     −5,999bps. The replacement is a monotone dose-response on entry AGE: median net +9,791 →
 *     +5,838 → +4,410 → +696 → −845 → −1,748 → −3,302bps as entry moves swap 5 → 500.
 *   - The old exit was a −235bps hard stop and a derived take-profit. §10 measured that this shakes
 *     the strategy out of exactly the moves that make the money; a 50% trail resolved 72 of 72
 *     held-out positions with a +5,609bps median.
 *   - The old slot count was one. §10.5: one slot takes 17 of 72 opportunities (Welch t 1.16, not
 *     significant); eight take 71 of 72 (t 2.38–2.72 on 20/20 seeds) at the same per-ticket edge.
 *
 * **HONESTY, IN THE PLACE IT IS HARDEST TO IGNORE.** `assessOverfitting` at 183 cumulative trials
 * returns `credible: false` (§10.6): n=72, a 1.74-day median held-out span, and a cost model that
 * is INCOMPLETE in the optimistic direction. The Welch t clears 3 on zero of 20 seeds. This
 * function implements a hypothesis that is **out-of-sample positive and not proven**, and no
 * comment in this package is allowed to describe it as more than that.
 *
 * ══ WHY EXIT IS EVALUATED BEFORE ENTRY, AND BEFORE EVERY RISK CONTROL ══
 *
 * DESIGN §6 Rule 5: getting OUT is always allowed. So the exit branch is FIRST, and it is reached
 * without consulting the drawdown halt, the spend ledger, the spend caps, or the cost bar. A
 * control that could delay an exit by even one tick is a control that can trap capital in a
 * falling position, and RESEARCH's whole left tail (−17.1% over 24h) is what that costs.
 *
 * With eight slots this ordering gains a second edge that a single position did not have: **a full
 * portfolio must not gate its own exits.** `mayEnter` now refuses with `slots-full`, and if that
 * refusal were reached before the exit scan, a stray holding eight positions could never sell any
 * of them — the failure would present as a cat that stopped trading rather than as a bug. The exit
 * scan runs over EVERY position before the entry branch is entered at all.
 *
 * This ordering is asserted by test: `decide.test.ts` trips every risk control simultaneously,
 * fills every slot, puts a position past its trailing stop, and requires an `exit`.
 *
 * ══ WHY IT RETURNS A REASON ON EVERY BRANCH, INCLUDING `hold` ══
 *
 * DESIGN §8 makes `/logs` *"load-bearing, not a nicety"* and requires it to distinguish
 * **decided** from **landed**, because *"risk caps and reverts can block the former from becoming
 * the latter, and previously that distinction was silent."* This function produces the DECIDED
 * half, and a `hold` with no arithmetic beside it is an assertion rather than a finding. Every
 * Decision therefore carries the numbers that produced it.
 */

import {
  type AgeConfig,
  type AgeVerdict,
  DEFAULT_AGE,
  measuredMedianNetBps,
  withinEntryWindow,
} from "./age.js";
import { clearsBar, EDGE_MULTIPLE, type BarVerdict } from "./bar.js";
import { roundTripCost, type RoundTripCost } from "./cost.js";
import { type EligibilityConfig, isEligible, type TokenSnapshot } from "./eligible.js";
import { canonicalHook } from "./hook.js";
import { trailingStopFired, type TrailingStopVerdict } from "./trail.js";
import {
  type HolderDistribution,
  type ScreenConfig,
  screenToken,
  type SellSimulation,
} from "./screen.js";
import { rankCandidates, type Score, scoreCandidate } from "./score.js";
import { evaluateEntry, levelsFor, type EntrySignal, type PricePoint } from "./signal.js";
import {
  drawdownBps,
  mayEnter,
  mayExit,
  minOutFor,
  type RiskConfig,
  type SpendLedger,
  type StrayState,
} from "./risk.js";

/** A candidate the caller (or the LLM's ranking) has put in front of us. */
export type Candidate = {
  readonly token: TokenSnapshot;
  /**
   * Oldest-first price history. The window is measured off these timestamps.
   *
   * NO LONGER THE ENTRY GATE. It is retained because the entry decision still reports a signal for
   * `/logs` and because `@strays/backtest` replays the refuted momentum family through this same
   * type — but `evaluateEntry`'s verdict no longer decides anything (see `decide`'s header and
   * `age.ts`). The gate is `token.swapCount`.
   */
  readonly history: readonly PricePoint[];
  /**
   * Tokens expected out for `sizeWei` in, from the v4 quoter. Drives `minOut`.
   *
   * From a QUOTER, never from a model and never from a price multiplication — RESEARCH §7d
   * records that round-tripping an 18-decimal amount through `number` reverts with
   * TRANSFER_FROM_FAILED. bigint end to end.
   */
  readonly quotedOut: bigint;
  /**
   * THE SELL SIMULATION. Quote selling `quotedOut` back to ETH, BEFORE buying.
   *
   * The highest-value check available to us: 84 of the newest 100 tokens quote a BUY successfully
   * and **cannot be quoted for a SELL at all** (RESEARCH-STRATEGY §1). The shipped strategy checked
   * only `quotedOut` — the buy side — so it would have bought all 84.
   *
   * Supplied by the caller because this package performs no I/O. `screen.ts` decides on it.
   */
  readonly sell: SellSimulation;
  /**
   * Holder concentration from `GET /api/tokens/{addr}/holders` — top-10, creator and, most
   * importantly, the pad's own sniper/bundle detection. See `screen.ts`.
   */
  readonly holders: HolderDistribution;
  /**
   * Buys as a fraction of all trades, in bps. 5000 = balanced. Measured range on live tokens:
   * 3300..7300. Feeds the momentum term of the score, which is a MULTIPLIER and cannot invent edge.
   */
  readonly buyRatioBps: bigint;
};

/** Everything about the outside world this decision reads. All of it is data. */
export type Market = {
  readonly candidates: readonly Candidate[];
  /**
   * READ FROM THE CHAIN THIS TICK. No default anywhere in the stack — RESEARCH §7a.
   */
  readonly gasPriceWei: bigint;
  /**
   * Current ETH-per-token price for EACH open position, scaled 1e18, keyed by token address.
   *
   * A MAP, replacing the single `markPriceWei` this type used to carry. With eight concurrent
   * positions a lone mark price is not merely insufficient, it is dangerous: whichever position the
   * loop happened to be looking at would be valued at another token's price, and the trailing stop
   * would fire — or fail to fire — on a number belonging to something else entirely.
   *
   * A MISSING entry is not an error and is not a sell signal. `decide` holds that position and says
   * so, and keeps evaluating the others: RESEARCH §5 records the API as unofficial and unstable, so
   * one failed read must not stop the other seven positions being checked against their own stops.
   *
   * Keys are compared case-insensitively against `position.token`, because the pad's API and the
   * RPC disagree about EIP-55 casing and a map lookup that misses is indistinguishable from a
   * failed price read.
   */
  readonly markPricesWei: ReadonlyMap<string, bigint>;
  /** Unix seconds. Passed in; never read from a clock inside this call. */
  readonly nowSeconds: number;
};

export type DecideConfig = {
  readonly eligibility: EligibilityConfig;
  readonly risk: RiskConfig;
  readonly ledger: SpendLedger;
  /**
   * The entry window in SWAPS. Defaults to `DEFAULT_AGE` — swaps 20 through 50.
   *
   * Config rather than a constant `decide()` reads directly, and for the reason `edgeMultiple` is
   * config: `@strays/backtest` recorded that a constant this function reads cannot be swept without
   * editing this package, and *"a parameter that cannot be swept cannot be shown to be the right
   * one."* The dose-response in §10.4 is precisely such a sweep, and re-running it against the real
   * `decide()` — which §10.1 records as impossible for the old harness — requires this to be an
   * input.
   */
  readonly age?: AgeConfig;
  /** Rug/honeypot ceilings. See `screen.ts` for why they sit outside the measured range. */
  readonly screen: ScreenConfig;
  /** Slippage tolerance for `minOut`, in bps. Never 0 on the output side — RESEARCH §7c. */
  readonly slippageBps: bigint;
  /** Idempotency key for this tick's potential entry. Supplied, not generated — purity. */
  readonly idempotencyKey: string;
  /** Whether the two one-time Permit2 approvals are still outstanding for the exit leg. */
  readonly approvalsNeeded: boolean;
  /**
   * THE COST BAR MULTIPLE. An expected gain must clear `edgeMultiple x roundTripCost` before a
   * trade fires, and the same multiple floors the take-profit target in `levelsFor`.
   *
   * Optional, defaulting to the derived `EDGE_MULTIPLE = 2` in `bar.ts`, so every existing caller
   * keeps its behaviour byte-for-byte. It is CONFIG rather than a module constant because a
   * constant `decide()` reads directly cannot be varied by a backtest without editing this package
   * — `@strays/backtest` recorded exactly that as a finding, having swept it and got four
   * byte-identical rows. A parameter that cannot be swept cannot be shown to be the right one.
   */
  readonly edgeMultiple?: bigint;
};

export type Decision =
  | { readonly kind: "hold"; readonly reason: string }
  | {
      readonly kind: "enter";
      readonly token: string;
      readonly sizeWei: bigint;
      /** NEVER zero. `minOutFor` throws rather than returning one (RESEARCH §7c). */
      readonly minOut: bigint;
      /**
       * The pool's hook, carried through to `hunt(strayId, token, tickSpacing, HOOK, ethIn, minOut)`.
       *
       * On the DECISION rather than looked up again by the keeper, so the hook that was screened is
       * the hook that is traded. A keeper that re-derived it could re-derive it differently — and
       * RESEARCH §7d's failure mode is that addressing the wrong pool reverts with empty bytes,
       * which reads like an RPC problem rather than like a bug.
       */
      readonly hook: string;
      /** v4 tick spacing for the pool. Per-token, never a constant — RESEARCH §2. */
      readonly tickSpacing: number;
      /** The contract slot this entry should occupy: the lowest free index, matching `hunt`'s scan. */
      readonly slot: number;
      readonly reason: string;
      readonly cost: RoundTripCost;
      readonly bar: BarVerdict;
      readonly signal: EntrySignal;
      /** Why THIS token won the ranking, with the arithmetic. */
      readonly score: Score;
    }
  | {
      readonly kind: "exit";
      readonly token: string;
      /**
       * WHICH SLOT to sell. Required, because `flee(strayId, slot, minOut)` names one.
       *
       * The single most dangerous field on this type: `StrayVault.flee` reads the token, hook and
       * tickSpacing back out of the slot it is given, so a wrong slot sells a DIFFERENT position at
       * this one's `minOut`. It is copied straight off the position rather than recomputed.
       */
      readonly slot: number;
      readonly reason: string;
      /** The trailing-stop arithmetic, for `/logs`. Absent when the exit came from another rule. */
      readonly trail?: TrailingStopVerdict;
    };

/**
 * Decide what this stray does this tick.
 *
 * PURE. Deterministic given (state, market, cfg). Async only because the spend ledger is durable
 * and durable storage is not synchronous — no other I/O happens here, and the ledger is only
 * consulted on the ENTRY path, never the exit path.
 */
export async function decide(
  state: StrayState,
  market: Market,
  cfg: DecideConfig,
): Promise<Decision> {
  // Resolve the cost-bar multiple ONCE, here, so the entry bar and the take-profit floor can
  // never disagree about it. `?? EDGE_MULTIPLE` keeps the derived default for every caller that
  // does not set it. `clearsBar` still validates it and throws below 1.
  const edgeMultiple = cfg.edgeMultiple ?? EDGE_MULTIPLE;
  const ageCfg = cfg.age ?? DEFAULT_AGE;

  /*
   * What every OPEN position did this tick, accumulated by the exit scan and appended to whatever
   * `hold` the entry branch produces. DESIGN §8 makes `/logs` the validation surface of the
   * product and requires it to distinguish DECIDED from LANDED; with eight slots a log line that
   * only mentions the one token we did or did not buy hides the seven we are still holding, and a
   * position whose stop is quietly not being evaluated would be invisible.
   */
  const holdNotes: string[] = [];

  /* ════════════════════════════════════════════════════════════════════════════════════════
   * 1. EXIT. FIRST, ALWAYS, GATED BY NOTHING, AND OVER **EVERY** POSITION.
   *
   * DESIGN §6 Rule 5. `mayExit()` returns the literal `true` and is called here so that the
   * invariant is exercised on the real path rather than only asserted in a test — RESEARCH §7g
   * is about exactly the gap between a claim and the code that would have to run for it.
   *
   * ══ WHY THE LOOP RUNS TO COMPLETION RATHER THAN RETURNING ON THE FIRST FAILED READ ══
   *
   * With one position, "mark unreadable → hold" was the whole story. With eight it is a trap: a
   * single token missing from `markPricesWei` — one API blip, on the least important holding —
   * would otherwise return `hold` before the other seven were checked against their own stops, and
   * would keep doing so on every tick until that one read recovered. **One unreadable price must
   * never be able to disarm seven live stops.** So an unreadable mark is recorded as a note against
   * that position and the scan continues.
   *
   * ══ AND WHY THE FIRST FIRED STOP WINS, RATHER THAN THE WORST ONE ══
   *
   * A tick emits at most one action, because the caller lands at most one transaction. Ordering by
   * slot is arbitrary but DETERMINISTIC, which is the property that matters (this function must be
   * replayable). Choosing "the worst drawdown first" would be a ranking rule on the exit path, and
   * a ranking rule is a place where a future edit can express a preference for NOT selling
   * something. The others fire on the next tick; the trailing stop is not time-critical to the
   * minute, having a 50% band.
   * ════════════════════════════════════════════════════════════════════════════════════════ */
  if (state.positions.length > 0) {
    // Case-insensitive mark lookup: the pad's API and the RPC disagree about EIP-55 casing, and a
    // map miss is indistinguishable from a failed read — which would silently disarm a stop.
    const markFor = (token: string): bigint | undefined => {
      const direct = market.markPricesWei.get(token);
      if (direct !== undefined) return direct;
      const wanted = token.toLowerCase();
      for (const [key, value] of market.markPricesWei) {
        if (key.toLowerCase() === wanted) return value;
      }
      return undefined;
    };

    const notes: string[] = [];
    // Slot order, explicitly sorted rather than trusting the caller's array order — the caller may
    // hand us a filtered or re-sorted list and the decision must not depend on which.
    const bySlot = [...state.positions].sort((a, b) => a.slot - b.slot);

    for (const position of bySlot) {
      const markPriceWei = markFor(position.token);
      if (markPriceWei === undefined || markPriceWei <= 0n) {
        // An unreadable mark is NOT a reason to force an exit — selling on a failed price read is
        // selling on no information, and RESEARCH §5 warns the API is unstable. The owner's
        // withdrawal is unaffected; it does not route through this function.
        notes.push(
          `slot ${String(position.slot)} ${position.token}: mark price unreadable this tick, so ` +
            "its trailing stop could not be evaluated. A forced sale on a failed read is a trade " +
            "on no information (RESEARCH §5). The owner's withdrawal is not gated by this and " +
            "never is",
        );
        continue;
      }

      /*
       * ══ THE EXIT RULE. A 50% TRAIL FROM THIS POSITION'S OWN PEAK WATERMARK. ══
       *
       * The peak comes off the POSITION, supplied by the caller, because it is state that must
       * survive a restart — the chain holds it in `Position.peakPriceWei` and the indexer mirrors
       * it in Postgres. `trail.ts`'s header has the argument; the short version is that a watermark
       * living in this process would reset on redeploy, and a reset watermark does not lose
       * information so much as re-anchor the stop to the current price and disarm it.
       *
       * Note what is NOT here any more: `stopFired` (the −235bps level stop) and `levelsFor`'s
       * take-profit. RESULTS §10 measured both to be backwards on this asset — they close exactly
       * the positions that produce the returns, and §10.4 measured that the top 10% of positions
       * carry 76.1% of all profit.
       */
      const trail = trailingStopFired({
        peakPriceWei: position.peakPriceWei,
        markPriceWei,
        trailBps: cfg.risk.trailBps,
      });
      if (trail.fired) {
        // `mayExit()` is `true` by type. Calling it keeps the invariant on the executed path.
        const _allowed: true = mayExit();
        void _allowed;

        /*
         * The exit is costed against the OPEN POSITION'S OWN tax tier, carried on the position
         * itself — a stray may hold any tier, and costing a 10%-tax exit against a config that says
         * 1% understates the round trip by ~1700bps. The cost is REPORTED, never consulted: DESIGN
         * §6 Rule 5 makes the cost of leaving a fact about the exit and not a reason to stay.
         */
        const cost = roundTripCost({
          positionWei: position.entryWei,
          taxPct: position.taxPct,
          gasPriceWei: market.gasPriceWei,
          approvalsNeeded: cfg.approvalsNeeded,
        });
        return {
          kind: "exit",
          token: position.token,
          slot: position.slot,
          trail,
          reason:
            `${trail.reason}. Slot ${String(position.slot)}, entered at ` +
            `${position.entryPriceWei.toString()} wei for ${position.entryWei.toString()} wei. ` +
            `Exit costs ${cost.totalBps.toString()}bps at this token's own ` +
            `${String(position.taxPct)}% tax — REPORTED, not consulted: the cost of leaving is a ` +
            "fact about the exit, never a reason to stay (DESIGN §6 Rule 5)",
        };
      }

      notes.push(`slot ${String(position.slot)} ${position.token}: ${trail.reason}`);
    }

    /*
     * Nothing fired. Fall THROUGH to the entry branch rather than returning `hold` — this is the
     * multi-slot change and it is the one that makes the eight slots real. The old code returned
     * `hold` here because a stray holding anything could not enter anything; a stray holding three
     * positions with five free slots must still be able to hunt, and §10.5's whole finding (17 vs
     * 71 of 72 opportunities taken) is about exactly this fall-through existing.
     *
     * The notes are carried into whatever the entry branch decides, so `/logs` shows the state of
     * every held position on every tick even when the interesting news is about a new one.
     */
    holdNotes.push(...notes);
  }

  /* ════════════════════════════════════════════════════════════════════════════════════════
   * 2. ENTRY. Every gate below applies to this branch only.
   * ════════════════════════════════════════════════════════════════════════════════════════ */

  /*
   * Every `hold` below carries the state of the open positions alongside its own reason, so a
   * `/logs` line is never silent about seven things in order to be loud about one.
   */
  const held = holdNotes.length === 0 ? "" : ` | holding: ${holdNotes.join(" | ")}`;

  // The drawdown halt is checked before anything is even evaluated, so a halted stray does no
  // work — but note it was ALREADY BYPASSED by the exit branch above. That ordering is the rule,
  // and with eight slots it is load-bearing rather than tidy: a halted stray must still sell.
  const dd = drawdownBps(state);
  if (dd >= cfg.risk.maxDrawdownBps) {
    return {
      kind: "hold",
      reason:
        `${state.strayId} is halted: ${dd.toString()}bps below its high-water mark, at or past ` +
        `the ${cfg.risk.maxDrawdownBps.toString()}bps drawdown halt. It starves rather than ` +
        "round-tripping to zero (DESIGN §6 Rule 4). Withdrawal remains available at all times, and " +
        `so is every trailing stop above${held}`,
    };
  }

  if (market.candidates.length === 0) {
    return { kind: "hold", reason: `no entry: no candidates were offered this tick${held}` };
  }

  /*
   * The risk gate is about the STRAY, not about any candidate, so it is evaluated ONCE before the
   * loop rather than once per token. Previously it sat inside the loop, which meant a stray that
   * was out of budget produced its denial only if at least one candidate had already passed
   * eligibility — the same denial, reported or not depending on unrelated data.
   *
   * The `token` argument is deliberately NOT passed here: at this point no candidate has won, and
   * the question being asked is the stray-level one ("has it a free slot, budget and no duplicate
   * key?"). The per-token duplicate check happens inside the candidate loop, where the token is
   * known.
   */
  const gate = await mayEnter({
    state,
    cfg: cfg.risk,
    ledger: cfg.ledger,
    idempotencyKey: cfg.idempotencyKey,
    nowSeconds: market.nowSeconds,
  });
  if (!gate.allowed) {
    return { kind: "hold", reason: `no entry [${gate.reason}]: ${gate.detail}${held}` };
  }

  /** Tokens this stray already holds, for the duplicate check inside the loop. */
  const heldTokens = new Set(state.positions.map((p) => p.token.toLowerCase()));

  const refusals: string[] = [];
  const survivors: {
    readonly candidate: Candidate;
    readonly score: Score;
    readonly cost: RoundTripCost;
    readonly bar: BarVerdict;
    /** The momentum reading. RECORDED for `/logs` and for `score`, and it gates nothing. */
    readonly signal: EntrySignal;
    /** The entry-window verdict — the gate that actually decided this candidate was huntable. */
    readonly age: AgeVerdict;
  }[] = [];

  /* ════════════════════════════════════════════════════════════════════════════════════════
   * 3. SCREEN AND SCORE EVERY CANDIDATE. No early return — the BEST wins, not the first.
   *
   * The old loop returned the FIRST candidate that passed every gate, which made the outcome
   * depend on arrival order — an ordering the LLM is allowed to influence (DESIGN §5). Now every
   * survivor is scored and `rankCandidates` picks the winner deterministically, so the model may
   * still propose what to LOOK at and the arithmetic decides what gets bought.
   * ════════════════════════════════════════════════════════════════════════════════════════ */
  for (const candidate of market.candidates) {
    const eligibility = isEligible(candidate.token, cfg.eligibility);
    if (!eligibility.ok) {
      refusals.push(eligibility.reason);
      continue;
    }

    /*
     * ══ THE ENTRY GATE: HOW OLD IS THIS TOKEN, IN SWAPS? ══
     *
     * The rule the whole strategy turns on, and the one that replaces the refuted momentum
     * breakout. It runs EARLY — right after eligibility and before the sell simulation, the cost
     * model and the score — because it is the cheapest decisive check we have: an integer
     * comparison against a count the indexer already holds, refusing every token outside a
     * 30-swap window.
     *
     * `age.ts` carries the dose-response and the honesty caveat. The short form: median net decays
     * monotonically from +9,791bps at swap 5 to −3,302bps at swap 500, crossing zero between 50
     * and 100, measured on held-out tokens at seven doses of which two were never in the search
     * space. Out-of-sample positive; `credible: false` at 183 trials; not proven.
     */
    const age = withinEntryWindow(candidate.token.swapCount, ageCfg);
    if (!age.inWindow) {
      refusals.push(`${candidate.token.address}: ${age.reason}`);
      continue;
    }

    /*
     * A token already held in another slot is refused here rather than in `mayEnter`, because this
     * is where the token is known. Eight slots is eight ideas, not one idea eight times.
     */
    if (heldTokens.has(candidate.token.address.toLowerCase())) {
      refusals.push(
        `${candidate.token.address}: already held in another slot. Eight slots is eight ideas, not ` +
          "one idea eight times — doubling into a token multiplies exposure without adding an " +
          "observation, and §10.5's finding is about the number of DISTINCT opportunities taken",
      );
      continue;
    }

    /*
     * ══ THE SELL SIMULATION, BEFORE ANYTHING ELSE IS COMPUTED ══
     *
     * 84 of the newest 100 tokens quote a buy fine and cannot be sold. Nothing below this line
     * matters if we cannot get out, so it runs before the cost model, the signal and the score.
     */
    const screened = screenToken({
      address: candidate.token.address,
      sell: candidate.sell,
      holders: candidate.holders,
      cfg: cfg.screen,
    });
    if (!screened.safe) {
      refusals.push(screened.reason);
      continue;
    }

    const cost = roundTripCost({
      positionWei: gate.sizeWei,
      taxPct: candidate.token.taxPct,
      gasPriceWei: market.gasPriceWei,
      approvalsNeeded: cfg.approvalsNeeded,
    });

    const levels = levelsFor({
      positionWei: gate.sizeWei,
      roundTripCostWei: cost.totalWei,
      edgeMultiple,
    });

    /*
     * ══ THE MOMENTUM SIGNAL IS STILL COMPUTED, AND IT NO LONGER DECIDES ANYTHING ══
     *
     * It used to be the gate: `if (signal.direction !== "long") continue`. That line is gone,
     * because the family is refuted (§10.7) and — worse — STATE.md's quintile table shows it was
     * INVERTED. Forward net by how far a token had already run when the breakout fired: already
     * fallen +3,260bps, +0…19% +842, +20…85% −1,838, +87…296% −3,878, +296%… −5,999. A momentum
     * entry buys the last row by construction.
     *
     * It is still EVALUATED and still reported, for two reasons that are not sentiment. It feeds
     * `expectedMoveBps` into `score.ts`, where it acts as a quality MULTIPLIER in [0,1] on an edge
     * that must already be positive and therefore cannot manufacture one. And a refuted hypothesis
     * that is still measured on every live tick is a refutation that keeps being tested — if the
     * momentum reading turned out to predict the trailing-exit outcome after all, the log would
     * show it. `signal.direction` being "none" is now a note, not a refusal.
     */
    const signal = evaluateEntry({
      history: candidate.history,
      positionWei: gate.sizeWei,
      takeProfitBps: levels.takeProfitBps,
    });

    /*
     * ══ WHAT THE COST BAR IS NOW FED, AND WHY IT IS NOT THE SIGNAL'S ESTIMATE ══
     *
     * The bar's job is unchanged: an expected gain must clear `edgeMultiple x roundTripCost` or the
     * trade cannot pay for itself. What changed is where the expected gain comes from.
     *
     * It used to be the momentum signal's take-profit projection — an estimate derived from the
     * very price pattern that turned out to be inverted. It is now the **measured held-out median
     * net at this entry dose**, from `age.ts`'s `MEASURED_MEDIAN_NET_BPS`: +4,410bps at swap 20.
     * That is a number that came from 72 held-out tokens rather than from this token's last hour,
     * and it is the honest input to a bar whose whole purpose is scepticism.
     *
     * Two consequences worth stating plainly. **The bar is now much easier to clear** — a 4,410bps
     * expectation against a ~208bps round trip clears 2x cost by a factor of ten, so at 1% tax the
     * bar refuses nothing and it is the ENTRY WINDOW that binds. That is not the bar going soft; it
     * is §10.7's finding ("the toll never was the binding constraint") arriving in the code. And
     * **the bar still binds at high tax**: a 10%-tax token needs ~3,876bps to clear 2x its own
     * round trip, which the 4,410bps median only just beats, so the tier arithmetic in `score.ts`
     * remains the thing that refuses expensive tokens.
     *
     * It is a MEDIAN and it is labelled as one everywhere it travels. The mean at this dose is
     * +37,727bps and using it would be sizing a bar against a distribution whose top 1% carries
     * 31.9% of all profit (§10.4).
     */
    const expectedGainWei = (gate.sizeWei * measuredMedianNetBps(age.swapCount, ageCfg)) / 10_000n;

    /*
     * `expectedMoveBps` is the measured median too, not `signal.moveBps`. Feeding the momentum
     * reading here would put the refuted quantity back on the ranking path through the side door:
     * `score.ts` subtracts the token's own tax from `expectedMoveBps` and refuses a non-positive
     * result, so a token with a flat or falling last hour would be refused for having no edge —
     * which is the momentum gate, re-implemented one module further down. The quality multipliers
     * (depth, buy ratio) still differentiate candidates, and they are multipliers in [0,1] on an
     * edge that must already be positive, so they can decline a trade and cannot invent one.
     */
    const score = scoreCandidate({
      address: candidate.token.address,
      taxPct: candidate.token.taxPct,
      positionWei: gate.sizeWei,
      gasPriceWei: market.gasPriceWei,
      expectedMoveBps: measuredMedianNetBps(age.swapCount, ageCfg),
      marketCapWei: candidate.token.marketCapWei,
      volumeAllTimeWei: candidate.token.volumeAllTimeWei,
      buyRatioBps: candidate.buyRatioBps,
      holders: candidate.token.holders,
    });

    /*
     * ══ BREAK-EVEN FIRST, THEN THE BAR. THE ORDER CHANGED, AND A SABOTAGE RUN IS WHY. ══
     *
     * These two checks used to run bar-then-net-edge, and under the OLD expected-gain source they
     * were genuinely independent: the bar was fed the momentum signal's take-profit projection
     * while `score.netEdgeBps` was computed from the observed move, so either could fire alone.
     *
     * Feeding both from the same measured median made them nest. `netEdgeBps = move − costBps`
     * and the bar demands `move ≥ multiple × costBps` with `multiple ≥ 1`, so **anything that
     * clears the bar has already cleared break-even** and the net-edge check became unreachable.
     * `sabotage.mjs` S51 caught it: replacing the check with `if (false)` changed nothing and no
     * test went red. Dead code that looks like a safety check is worse than no check, because it
     * reads as one in review.
     *
     * The fix is the order, not a deletion. Break-even is the weaker, more fundamental condition
     * ("does the expected move cover the tax at all?") and it now runs first, so it fires on
     * candidates the bar would also have refused, with the more specific message. The bar remains
     * the binding gate for everything that gets past it. Both are reachable; S51 and S46 both go
     * red when broken.
     *
     * The unitick rule PLAN.md §3 records, having seen it five times: *"when two mechanisms can
     * independently reject the same input, at least one test must construct an input that only
     * ONE of them rejects."* Here the weaker one had stopped being able to reject anything at all.
     */
    if (score.netEdgeBps <= 0n) {
      refusals.push(
        `${candidate.token.address}: expected move does not cover its own tax — ${score.arithmetic}`,
      );
      continue;
    }

    /*
     * The cost bar, per candidate, against ITS OWN tax tier. This is where a 10%-tax token is
     * refused — by arithmetic (it must clear +38.8%), not by a rule that never let it be seen.
     */
    const bar = clearsBar({
      expectedGainWei,
      costWei: cost.totalWei,
      multiple: edgeMultiple,
    });
    if (!bar.clears) {
      refusals.push(
        `${candidate.token.address}: inside the entry window but the cost bar refused it — ` +
          `${bar.arithmetic}`,
      );
      continue;
    }

    survivors.push({ candidate, score, cost, bar, signal, age });
  }

  if (survivors.length === 0) {
    return {
      kind: "hold",
      reason:
        `no entry: ${String(refusals.length)} candidate(s) refused — ${refusals.join(" | ")}${held}`,
    };
  }

  /* ══ 4. THE BEST ONE WINS. Ties break on address, never on arrival order. ══ */
  const ranked = rankCandidates(survivors.map((s) => s.score));
  const winningScore = ranked[0];
  if (winningScore === undefined) {
    return { kind: "hold", reason: `no entry: ranking produced no winner${held}` };
  }
  const winner = survivors.find((s) => s.score.address === winningScore.address);
  if (winner === undefined) {
    return { kind: "hold", reason: `no entry: the ranked winner had no candidate behind it${held}` };
  }

  // The slippage floor. Throws rather than returning zero (RESEARCH §7c).
  const minOut = minOutFor({
    expectedOut: winner.candidate.quotedOut,
    slippageBps: cfg.slippageBps,
  });

  /*
   * The hook is canonicalised rather than passed through raw. `isEligible` has already refused
   * anything outside the two-entry allowlist, so this cannot widen what is tradeable — what it does
   * is make the string on the Decision compare `===` against the one stored on the position at
   * exit, so an EIP-55-cased read and a lowercase read of the same hook are one value rather than
   * two. `canonicalHook` re-asserts the allowlist on the way through, so the check exists on the
   * path that actually encodes a swap and not only on the path that screened it (RESEARCH §7g).
   */
  const hook = canonicalHook(winner.candidate.token.hook);

  const runnersUp = ranked
    .slice(1)
    .map((s) => `${s.address} @ ${s.totalBps.toString()}bps`)
    .join(", ");

  return {
    kind: "enter",
    token: winner.candidate.token.address,
    sizeWei: gate.sizeWei,
    minOut,
    hook,
    tickSpacing: winner.candidate.token.tickSpacing,
    slot: gate.slot,
    reason:
      `ENTER ${winner.candidate.token.address} for ${gate.sizeWei.toString()} wei into slot ` +
      `${String(gate.slot)} (${String(gate.freeSlotsAfter)} free after) — BEST OF ` +
      `${String(survivors.length)} scored candidate(s). ${winner.age.reason}. ` +
      `${winner.score.arithmetic}. ${winner.bar.arithmetic}. ${winner.cost.arithmetic}. ` +
      `minOut ${minOut.toString()} at ${cfg.slippageBps.toString()}bps slippage. hook ${hook}, ` +
      `tickSpacing ${String(winner.candidate.token.tickSpacing)}. ` +
      `Momentum reading, RECORDED NOT ACTED ON: ${winner.signal.reasoning}` +
      (runnersUp === "" ? "" : `. Runners-up: ${runnersUp}`) +
      held,
    cost: winner.cost,
    bar: winner.bar,
    signal: winner.signal,
    score: winner.score,
  };
}
