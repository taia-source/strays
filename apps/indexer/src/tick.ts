/**
 * The keeper tick. This is the file that makes a stray autonomous, and it is the file most likely
 * to be a lie.
 *
 * ══ THE RECORDED FAILURE THIS MODULE EXISTS TO NOT REPEAT ══
 *
 * openhood shipped a constant called `AUTOMATIC_EXECUTION_WIRED = true` while `engine.ts` never
 * called `evaluateOnce`. Its own docstring, written after the fact:
 *
 *     "`AUTOMATIC_EXECUTION_WIRED` has been `true` since 2026-08-06, and until this file existed it
 *      was A CLAIM RATHER THAN A BEHAVIOUR: `engine.ts` never called `evaluateOnce`, so nothing
 *      traded unless an operator ran it by hand. **The flag said automatic; the system was
 *      operator-initiated.**"
 *
 * So there is no boolean in this file asserting that it works. What there is instead:
 * `runTick` is exported and `tick.test.ts` asserts that a full cycle actually reaches the executor
 * — with a test that FAILS if the call is removed. A flag can be set by hand; a test that observes
 * the call cannot.
 *
 * ══ THE SECOND FAILURE: A DECIDED TRADE IS NOT A LANDED TRADE ══
 *
 * meridian records that a live monitor must distinguish "the agent decided to trade" from "the
 * trade actually landed on chain", because risk caps and reverts can block the former from becoming
 * the latter — "and previously that distinction was silent". Every decision here emits a record
 * with an explicit `outcome`, and `/logs` renders both states differently.
 *
 * ══ THE THIRD: RE-ENTRANCY OF THE LOOP ITSELF ══
 *
 * openhood's loop needed an `inFlight` guard because "a live trade (approvals + swap + receipt
 * waits) can outlast the think interval; without this guard two ticks execute concurrently and can
 * both spend before either records against the risk cap." Same guard here, same reason.
 */

import type { Candidate } from "./discovery.js";

/** What a tick decided, and whether it actually happened. The two are never conflated. */
export type DecisionOutcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "decided-not-executed"; readonly reason: string }
  | { readonly kind: "landed"; readonly txHash: `0x${string}`; readonly gasUsed: bigint }
  | { readonly kind: "reverted"; readonly txHash: `0x${string}`; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export type DecisionRecord = {
  readonly strayId: `0x${string}`;
  readonly action: "hunt" | "flee" | "hold";
  readonly token: `0x${string}` | null;
  readonly amountWei: bigint;
  /** Why, in words a user can read on /logs. Never a code. */
  readonly rationale: string;
  readonly outcome: DecisionOutcome;
  /** Stamped by the CHAIN, not by Date.now() at render. ART-DIRECTION rule 2. */
  readonly block: bigint;
  readonly at: number;
};

export type StrayState = {
  readonly id: `0x${string}`;
  readonly stakeWei: bigint;
  readonly holding: `0x${string}` | null;
  readonly holdingUnits: bigint;
  readonly costBasisWei: bigint;
  /**
   * The tax tier of the token actually held, as an integer percent. `null` when flat.
   *
   * Carried on the state because a stray may now hold ANY tier — tax is a cost term, not a filter.
   * Costing an exit against a config default rather than the real tier understates a 10%-tax exit
   * by ~1700bps and sets the take-profit far too low, i.e. sells into a "gain" that does not cover
   * the tax. `@strays/hunt`'s OpenPosition requires it for exactly this reason.
   */
  readonly holdingTaxPct: number | null;
  readonly entryBlock: bigint;
};

/** Everything the tick needs from the outside, so `runTick` itself is pure-ish and testable. */
export type TickDeps = {
  readonly listStrays: () => Promise<readonly StrayState[]>;
  readonly discover: () => Promise<readonly Candidate[]>;
  readonly currentBlock: () => Promise<bigint>;
  readonly gasPriceWei: () => Promise<bigint>;
  /** Returns the tx hash. MUST throw on revert rather than returning a falsy value. */
  readonly executeHunt: (
    strayId: `0x${string}`,
    token: `0x${string}`,
    amountWei: bigint,
    minOut: bigint,
    tickSpacing: number,
  ) => Promise<{ txHash: `0x${string}`; gasUsed: bigint }>;
  readonly executeFlee: (
    strayId: `0x${string}`,
    minOut: bigint,
  ) => Promise<{ txHash: `0x${string}`; gasUsed: bigint }>;
  /** Quote the current value of a holding, for exit decisions. */
  readonly quoteExitWei: (token: `0x${string}`, units: bigint, tickSpacing: number) => Promise<bigint>;
  readonly record: (r: DecisionRecord) => Promise<void>;
  readonly decide: (input: DecideInput) => Decision | Promise<Decision>;
  readonly now: () => number;
};

export type DecideInput = {
  readonly stray: StrayState;
  readonly candidates: readonly Candidate[];
  readonly gasPriceWei: bigint;
  readonly currentValueWei: bigint | null;
  readonly block: bigint;
};

export type Decision =
  | { readonly kind: "hold"; readonly reason: string }
  | {
      readonly kind: "enter";
      readonly token: `0x${string}`;
      readonly amountWei: bigint;
      readonly minOut: bigint;
      readonly tickSpacing: number;
      readonly reason: string;
    }
  | { readonly kind: "exit"; readonly minOut: bigint; readonly reason: string };

let inFlight = false;

/** Exposed so a test can prove the guard exists rather than trusting a comment. */
export function isInFlight(): boolean {
  return inFlight;
}

/**
 * Run one cycle over every stray.
 *
 * Returns the records it wrote, so a caller (and a test) can observe exactly what happened rather
 * than inferring it from logs.
 */
export async function runTick(deps: TickDeps): Promise<readonly DecisionRecord[]> {
  if (inFlight) {
    // Not an error. A tick that overlaps the previous one is the concurrency bug openhood hit, and
    // skipping is the correct response — the next tick will pick it up.
    return [];
  }
  inFlight = true;
  const written: DecisionRecord[] = [];
  try {
    const [strays, block, gasPriceWei] = await Promise.all([
      deps.listStrays(),
      deps.currentBlock(),
      deps.gasPriceWei(),
    ]);

    // Discovery runs ONCE per tick, not once per stray. At 240 req/60s a per-stray scan would
    // exhaust the budget with a handful of cats, and every stray sees the same market anyway.
    const candidates = await deps.discover();

    for (const stray of strays) {
      const currentValueWei =
        stray.holding !== null && stray.holdingUnits > 0n
          ? await deps
              .quoteExitWei(stray.holding, stray.holdingUnits, 200)
              .catch(() => null)
          : null;

      const decision = await deps.decide({ stray, candidates, gasPriceWei, currentValueWei, block });

      const base = { strayId: stray.id, block, at: deps.now() } as const;

      if (decision.kind === "hold") {
        const rec: DecisionRecord = {
          ...base,
          action: "hold",
          token: stray.holding,
          amountWei: 0n,
          rationale: decision.reason,
          outcome: { kind: "skipped", reason: decision.reason },
        };
        await deps.record(rec);
        written.push(rec);
        continue;
      }

      if (decision.kind === "enter") {
        let outcome: DecisionOutcome;
        try {
          const { txHash, gasUsed } = await deps.executeHunt(
            stray.id,
            decision.token,
            decision.amountWei,
            decision.minOut,
            decision.tickSpacing,
          );
          outcome = { kind: "landed", txHash, gasUsed };
        } catch (err) {
          // DECIDED but NOT LANDED. This is the distinction meridian says was silent, and the two
          // must never be merged: a revert here is information, not a non-event.
          outcome = { kind: "failed", reason: String(err) };
        }
        const rec: DecisionRecord = {
          ...base,
          action: "hunt",
          token: decision.token,
          amountWei: decision.amountWei,
          rationale: decision.reason,
          outcome,
        };
        await deps.record(rec);
        written.push(rec);
        continue;
      }

      // exit
      let outcome: DecisionOutcome;
      try {
        const { txHash, gasUsed } = await deps.executeFlee(stray.id, decision.minOut);
        outcome = { kind: "landed", txHash, gasUsed };
      } catch (err) {
        outcome = { kind: "failed", reason: String(err) };
      }
      const rec: DecisionRecord = {
        ...base,
        action: "flee",
        token: stray.holding,
        amountWei: stray.holdingUnits,
        rationale: decision.reason,
        outcome,
      };
      await deps.record(rec);
      written.push(rec);
    }
  } finally {
    inFlight = false;
  }
  return written;
}

/**
 * The interval.
 *
 * ══ WHY MINUTES AND NOT SECONDS ══
 *
 * meridian built a 20-second directional loop, lost 2.8% on a NVDA→AAPL→NVDA round trip in two
 * hours, and RETIRED the strategy: "15-minute signals decay faster than the fees they incur."
 *
 * Our cost bar is a measured 199bps round trip against a measured ~770bps mean daily move
 * (RESEARCH §3b, §3d). That ratio supports a cycle measured in minutes, and refuses one measured in
 * seconds: at 5 minutes a stray sees 288 opportunities a day and pays 199bps for each one it takes,
 * so the bar — not the clock — is what must gate a trade.
 *
 * The tick is FAST so the cat can react; the BAR is what stops it from churning. Those are two
 * different controls and conflating them is how meridian's loop lost money.
 */
export const TICK_MS = Number(process.env.STRAYS_TICK_MS ?? 5 * 60 * 1000);
