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
    const cost = roundTripCost({
      positionWei: position.entryWei,
      taxPct: cfg.eligibility.requiredTaxPct,
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

  const refusals: string[] = [];

  for (const candidate of market.candidates) {
    const eligibility = isEligible(candidate.token, cfg.eligibility);
    if (!eligibility.ok) {
      refusals.push(eligibility.reason);
      continue;
    }

    const gate = await mayEnter({
      state,
      cfg: cfg.risk,
      ledger: cfg.ledger,
      idempotencyKey: cfg.idempotencyKey,
      nowSeconds: market.nowSeconds,
    });
    if (!gate.allowed) {
      // A risk denial is about the STRAY, not the candidate, so no further candidate can pass
      // either. Stop rather than repeating the same refusal once per token.
      return {
        kind: "hold",
        reason: `no entry [${gate.reason}]: ${gate.detail}`,
      };
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

    const bar = clearsBar({ expectedGainWei: signal.expectedGainWei, costWei: cost.totalWei });
    if (!bar.clears) {
      refusals.push(
        `${candidate.token.address}: signal fired but the cost bar refused it — ${bar.arithmetic}`,
      );
      continue;
    }

    // The slippage floor. Throws rather than returning zero (RESEARCH §7c).
    const minOut = minOutFor({ expectedOut: candidate.quotedOut, slippageBps: cfg.slippageBps });

    return {
      kind: "enter",
      token: candidate.token.address,
      sizeWei: gate.sizeWei,
      minOut,
      reason:
        `ENTER ${candidate.token.address} for ${gate.sizeWei.toString()} wei. ` +
        `${signal.reasoning}. ${bar.arithmetic}. ${cost.arithmetic}. ` +
        `minOut ${minOut.toString()} at ${cfg.slippageBps.toString()}bps slippage`,
      cost,
      bar,
      signal,
    };
  }

  return {
    kind: "hold",
    reason:
      refusals.length === 0
        ? "no entry: no candidates were offered this tick"
        : `no entry: ${String(refusals.length)} candidate(s) refused — ${refusals.join(" | ")}`,
  };
}
