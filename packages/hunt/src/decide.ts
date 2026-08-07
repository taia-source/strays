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
 * ══ WHY EXIT IS EVALUATED BEFORE ENTRY, AND BEFORE EVERY RISK CONTROL ══
 *
 * DESIGN §6 Rule 5: getting OUT is always allowed. So the exit branch is FIRST, and it is reached
 * without consulting the drawdown halt, the spend ledger, the spend caps, or the cost bar. A
 * control that could delay an exit by even one tick is a control that can trap capital in a
 * falling position, and RESEARCH's whole left tail (−17.1% over 24h) is what that costs.
 *
 * This ordering is asserted by test: `decide.test.ts` trips every risk control simultaneously,
 * puts a position past its stop, and requires an `exit`.
 *
 * ══ WHY IT RETURNS A REASON ON EVERY BRANCH, INCLUDING `hold` ══
 *
 * DESIGN §8 makes `/logs` *"load-bearing, not a nicety"* and requires it to distinguish
 * **decided** from **landed**, because *"risk caps and reverts can block the former from becoming
 * the latter, and previously that distinction was silent."* This function produces the DECIDED
 * half, and a `hold` with no arithmetic beside it is an assertion rather than a finding. Every
 * Decision therefore carries the numbers that produced it.
 */

import { clearsBar, EDGE_MULTIPLE, type BarVerdict } from "./bar.js";
import { roundTripCost, type RoundTripCost } from "./cost.js";
import { type EligibilityConfig, isEligible, type TokenSnapshot } from "./eligible.js";
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
  stopFired,
} from "./risk.js";

/** A candidate the caller (or the LLM's ranking) has put in front of us. */
export type Candidate = {
  readonly token: TokenSnapshot;
  /** Oldest-first price history. The window is measured off these timestamps. */
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
  /** Current ETH-per-token price for the OPEN position, scaled 1e18. Undefined when flat. */
  readonly markPriceWei: bigint | undefined;
  /** Unix seconds. Passed in; never read from a clock inside this call. */
  readonly nowSeconds: number;
};

export type DecideConfig = {
  readonly eligibility: EligibilityConfig;
  readonly risk: RiskConfig;
  readonly ledger: SpendLedger;
  /** Rug/honeypot ceilings. See `screen.ts` for why they sit outside the measured range. */
  readonly screen: ScreenConfig;
  /** Slippage tolerance for `minOut`, in bps. Never 0 on the output side — RESEARCH §7c. */
  readonly slippageBps: bigint;
  /** Idempotency key for this tick's potential entry. Supplied, not generated — purity. */
  readonly idempotencyKey: string;
  /** Whether the two one-time Permit2 approvals are still outstanding for the exit leg. */
  readonly approvalsNeeded: boolean;
};

export type Decision =
  | { readonly kind: "hold"; readonly reason: string }
  | {
      readonly kind: "enter";
      readonly token: string;
      readonly sizeWei: bigint;
      /** NEVER zero. `minOutFor` throws rather than returning one (RESEARCH §7c). */
      readonly minOut: bigint;
      readonly reason: string;
      readonly cost: RoundTripCost;
      readonly bar: BarVerdict;
      readonly signal: EntrySignal;
      /** Why THIS token won the ranking, with the arithmetic. */
      readonly score: Score;
    }
  | { readonly kind: "exit"; readonly token: string; readonly reason: string };

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
  /* ════════════════════════════════════════════════════════════════════════════════════════
   * 1. EXIT. FIRST, ALWAYS, AND GATED BY NOTHING.
   *
   * DESIGN §6 Rule 5. `mayExit()` returns the literal `true` and is called here so that the
   * invariant is exercised on the real path rather than only asserted in a test — RESEARCH §7g
   * is about exactly the gap between a claim and the code that would have to run for it.
   * ════════════════════════════════════════════════════════════════════════════════════════ */
  if (state.position !== undefined) {
    const position = state.position;

    if (market.markPriceWei === undefined || market.markPriceWei <= 0n) {
      // An unreadable mark is NOT a reason to force an exit — selling on a failed price read is
      // selling on no information, and RESEARCH §5 warns the API is unstable. We hold and say so.
      // The owner's withdrawal is unaffected; it does not route through this function.
      return {
        kind: "hold",
        reason:
          `holding ${position.token}: mark price unreadable this tick, so the stop cannot be ` +
          "evaluated. A forced sale on a failed read is a trade on no information (RESEARCH §5). " +
          "The owner's withdrawal is not gated by this and never is",
      };
    }

    const stop = stopFired({
      position,
      markPriceWei: market.markPriceWei,
      stopLossBps: cfg.risk.stopLossBps,
    });
    if (stop.fired) {
      // `mayExit()` is `true` by type. Calling it keeps the invariant on the executed path.
      const _allowed: true = mayExit();
      void _allowed;
      return { kind: "exit", token: position.token, reason: stop.reason };
    }

    // Take-profit. Derived from the same measured vol as the stop, floored against the cost bar
    // so a target that cannot pay for its own round trip cannot be expressed.
    /*
     * The exit is costed against the OPEN POSITION'S OWN tax tier, carried on the position itself.
     * Previously this read `cfg.eligibility.requiredTaxPct` — correct only while every position was
     * guaranteed to be 1%-tax. Now that any tier may be held, reading the config would mis-state a
     * 10%-tax exit as a 1%-tax one and set the take-profit ~1700bps too low.
     */
    const cost = roundTripCost({
      positionWei: position.entryWei,
      taxPct: position.taxPct,
      gasPriceWei: market.gasPriceWei,
      approvalsNeeded: cfg.approvalsNeeded,
    });
    const levels = levelsFor({
      positionWei: position.entryWei,
      roundTripCostWei: cost.totalWei,
      edgeMultiple: EDGE_MULTIPLE,
    });
    const moveBps =
      ((market.markPriceWei - position.entryPriceWei) * 10_000n) / position.entryPriceWei;
    if (moveBps >= levels.takeProfitBps) {
      const _allowed: true = mayExit();
      void _allowed;
      return {
        kind: "exit",
        token: position.token,
        reason:
          `TAKE PROFIT: ${position.token} is +${moveBps.toString()}bps from entry, at or beyond ` +
          `the ${levels.takeProfitBps.toString()}bps target (floored against a ` +
          `${cost.totalBps.toString()}bps round trip). ${cost.arithmetic}`,
      };
    }

    return {
      kind: "hold",
      reason:
        `holding ${position.token}: ${moveBps.toString()}bps from entry — inside the band ` +
        `[-${cfg.risk.stopLossBps.toString()}, +${levels.takeProfitBps.toString()}]bps. ` +
        `${stop.reason}`,
    };
  }

  /* ════════════════════════════════════════════════════════════════════════════════════════
   * 2. ENTRY. Every gate below applies to this branch only.
   * ════════════════════════════════════════════════════════════════════════════════════════ */

  // The drawdown halt is checked before anything is even evaluated, so a halted stray does no
  // work — but note it was ALREADY BYPASSED by the exit branch above. That ordering is the rule.
  const dd = drawdownBps(state);
  if (dd >= cfg.risk.maxDrawdownBps) {
    return {
      kind: "hold",
      reason:
        `${state.strayId} is halted: ${dd.toString()}bps below its high-water mark, at or past ` +
        `the ${cfg.risk.maxDrawdownBps.toString()}bps drawdown halt. It starves rather than ` +
        "round-tripping to zero (DESIGN §6 Rule 4). Withdrawal remains available at all times",
    };
  }

  if (market.candidates.length === 0) {
    return { kind: "hold", reason: "no entry: no candidates were offered this tick" };
  }

  /*
   * The risk gate is about the STRAY, not about any candidate, so it is evaluated ONCE before the
   * loop rather than once per token. Previously it sat inside the loop, which meant a stray that
   * was out of budget produced its denial only if at least one candidate had already passed
   * eligibility — the same denial, reported or not depending on unrelated data.
   */
  const gate = await mayEnter({
    state,
    cfg: cfg.risk,
    ledger: cfg.ledger,
    idempotencyKey: cfg.idempotencyKey,
    nowSeconds: market.nowSeconds,
  });
  if (!gate.allowed) {
    return { kind: "hold", reason: `no entry [${gate.reason}]: ${gate.detail}` };
  }

  const refusals: string[] = [];
  const survivors: {
    readonly candidate: Candidate;
    readonly score: Score;
    readonly cost: RoundTripCost;
    readonly bar: BarVerdict;
    readonly signal: EntrySignal;
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
      edgeMultiple: EDGE_MULTIPLE,
    });

    const signal = evaluateEntry({
      history: candidate.history,
      positionWei: gate.sizeWei,
      takeProfitBps: levels.takeProfitBps,
    });
    if (signal.direction !== "long") {
      refusals.push(`${candidate.token.address}: ${signal.reasoning}`);
      continue;
    }

    /*
     * The cost bar, per candidate, against ITS OWN tax tier. This is where a 10%-tax token is
     * refused — by arithmetic (it must clear +38.8%), not by a rule that never let it be seen.
     */
    const bar = clearsBar({ expectedGainWei: signal.expectedGainWei, costWei: cost.totalWei });
    if (!bar.clears) {
      refusals.push(
        `${candidate.token.address}: signal fired but the cost bar refused it — ${bar.arithmetic}`,
      );
      continue;
    }

    const score = scoreCandidate({
      address: candidate.token.address,
      taxPct: candidate.token.taxPct,
      positionWei: gate.sizeWei,
      gasPriceWei: market.gasPriceWei,
      expectedMoveBps: signal.moveBps,
      marketCapWei: candidate.token.marketCapWei,
      volumeAllTimeWei: candidate.token.volumeAllTimeWei,
      buyRatioBps: candidate.buyRatioBps,
      holders: candidate.token.holders,
    });

    /*
     * A candidate whose expected move does not cover its own tax is refused HERE rather than being
     * ranked last, so a tick where every survivor is unprofitable holds instead of buying the least
     * bad one. Ranking is for choosing among trades worth making, never for choosing a loser.
     */
    if (score.netEdgeBps <= 0n) {
      refusals.push(
        `${candidate.token.address}: expected move does not cover its own tax — ${score.arithmetic}`,
      );
      continue;
    }

    survivors.push({ candidate, score, cost, bar, signal });
  }

  if (survivors.length === 0) {
    return {
      kind: "hold",
      reason: `no entry: ${String(refusals.length)} candidate(s) refused — ${refusals.join(" | ")}`,
    };
  }

  /* ══ 4. THE BEST ONE WINS. Ties break on address, never on arrival order. ══ */
  const ranked = rankCandidates(survivors.map((s) => s.score));
  const winningScore = ranked[0];
  if (winningScore === undefined) {
    return { kind: "hold", reason: "no entry: ranking produced no winner" };
  }
  const winner = survivors.find((s) => s.score.address === winningScore.address);
  if (winner === undefined) {
    return { kind: "hold", reason: "no entry: the ranked winner had no candidate behind it" };
  }

  // The slippage floor. Throws rather than returning zero (RESEARCH §7c).
  const minOut = minOutFor({
    expectedOut: winner.candidate.quotedOut,
    slippageBps: cfg.slippageBps,
  });

  const runnersUp = ranked
    .slice(1)
    .map((s) => `${s.address} @ ${s.totalBps.toString()}bps`)
    .join(", ");

  return {
    kind: "enter",
    token: winner.candidate.token.address,
    sizeWei: gate.sizeWei,
    minOut,
    reason:
      `ENTER ${winner.candidate.token.address} for ${gate.sizeWei.toString()} wei — BEST OF ` +
      `${String(survivors.length)} scored candidate(s). ${winner.score.arithmetic}. ` +
      `${winner.signal.reasoning}. ${winner.bar.arithmetic}. ${winner.cost.arithmetic}. ` +
      `minOut ${minOut.toString()} at ${cfg.slippageBps.toString()}bps slippage` +
      (runnersUp === "" ? "" : `. Runners-up: ${runnersUp}`),
    cost: winner.cost,
    bar: winner.bar,
    signal: winner.signal,
    score: winner.score,
  };
}
