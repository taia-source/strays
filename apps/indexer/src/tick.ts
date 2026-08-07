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
 *
 * ══ THE FOURTH: A WATERMARK THAT LIVES IN THIS PROCESS IS THE §7f BUG IN A NEW COSTUME ══
 *
 * The exit is now a 50% trailing stop from each position's running peak (RESULTS §10.3), which is a
 * STATEFUL rule: it cannot be evaluated from price, only from price relative to the highest price
 * seen since entry. That state has to live somewhere, and where it lives is a correctness question.
 *
 * RESEARCH §7f is meridian's daily cap that *"only reset on process restart, so the 'daily' cap was
 * really 'spend since last boot'"*. A peak watermark kept in a `Map` here is the same bug and it
 * fails strictly worse. A reset cap is too permissive about spending. A reset watermark re-anchors
 * the stop to whatever the price is at boot:
 *
 *     entry 100 → peak 500 → stop at 250        (50% trail, armed and correct)
 *     redeploy; watermark lost; price now 260
 *     peak re-seeds 260 → stop at 130           (the stop just widened by 48%)
 *
 * and it widens again on every deploy. On Railway a push redeploys. §10.3 measured that with this
 * exit 0 of 72 held-out positions needed marking to market and without it 100% were unresolved — so
 * a lost watermark does not degrade the strategy, it **disarms the only exit the strategy has**,
 * and invisibly: a cat that never sells is indistinguishable from a cat whose stop has not fired.
 *
 * So the watermark is stored TWICE and this process holds neither authoritative copy. The chain has
 * it in `Position.peakPriceWei` (raised by the keeper-only monotone `mark()`), Postgres mirrors it,
 * and every tick reconciles by taking the maximum — which is a convergent merge rather than a
 * tie-break precisely because all three implementations of the rule are monotone. See the
 * reconciliation block in `runTick`.
 *
 * ══ AND THE FIFTH: EIGHT SLOTS MEANS EIGHT OF EVERYTHING ══
 *
 * A stray holds up to 8 concurrent positions (RESULTS §10.5: 1 slot takes 17 of 72 opportunities at
 * Welch t 1.16, not significant; 8 slots take 71 of 72 at t 2.38–2.72, same per-ticket edge). Every
 * position is quoted in its own pool, valued at its own price, and evaluated against its own
 * watermark. A single failed price read must never stop the other seven stops being evaluated.
 *
 * ══ WHAT IS ESTABLISHED, AND WHAT IS NOT ══
 *
 * `assessOverfitting` at 183 cumulative trials returns **`credible: false`** (RESULTS §10.6). The
 * held-out result is positive and the trailing exit beat matched random on 20/20 seeds, but n = 72
 * is short of the 98 needed for t > 3, the held-out window has a 1.74-day median span, and the cost
 * model omits slippage, reverts and our own price impact — **every omission biasing optimistic**.
 * This is an out-of-sample-positive hypothesis, not a proven strategy, and the plumbing in this file
 * is not evidence either way.
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

/**
 * ONE open position, as the keeper sees it. Mirrors `StrayVault.Position` field for field.
 *
 * The single most important field is `slot`, and it is carried explicitly rather than inferred from
 * an array index. `flee(strayId, slot, minOut)` and `mark(strayId, slot, priceWei)` both NAME a
 * slot, and `StrayVault.flee` reads the token, hook and tickSpacing back OUT of the slot it is
 * given — so a wrong slot index sells a different position at this one's `minOut`. An index that
 * means "wherever this element landed in whatever array the caller built" silently renumbers the
 * moment a list is filtered or sorted, and what it renumbers into is another token's money.
 */
export type PositionState = {
  readonly slot: number;
  readonly token: `0x${string}`;
  readonly units: bigint;
  readonly costBasisWei: bigint;
  /** v4 tick spacing for this position's pool. Per-token, never a constant — RESEARCH §2. */
  readonly tickSpacing: number;
  /**
   * The hook this position was ENTERED through, read back from the chain's `Position.hook`.
   *
   * The exit must address the same pool the entry did. Re-deriving it at exit time would be a
   * second chance to derive it differently, and RESEARCH §7d's failure mode for addressing the
   * wrong pool is an empty inner revert that reads like an RPC blip.
   */
  readonly hook: string;
  /**
   * THE PEAK PRICE WATERMARK as the CHAIN holds it. ETH-per-token, scaled 1e18.
   *
   * This is the authoritative copy — `reconcilePeaks` takes the higher of this and Postgres, and
   * `raisePeak`'s monotonicity is what makes "take the higher" a convergent rule rather than a
   * coin flip. See the reconciliation block in `runTick` for why this must never come from process
   * memory.
   */
  readonly peakPriceWei: bigint;
  /**
   * The tax tier of the token actually held, as an integer percent. `null` when unreadable.
   *
   * Carried on the POSITION because a stray may now hold eight tokens at eight different tiers —
   * tax is a cost term, not a filter. Costing an exit against a config default rather than the
   * position's own tier understates a 10%-tax exit by ~1700bps. `@strays/hunt`'s `OpenPosition`
   * requires it per position for exactly this reason.
   */
  readonly taxPct: number | null;
  readonly openedAtSeconds: number;
};

export type StrayState = {
  readonly id: `0x${string}`;
  readonly stakeWei: bigint;
  /**
   * THE OPEN POSITIONS, in slot order. Up to `MAX_POSITIONS` (8) of them.
   *
   * This replaces the single `holding`/`holdingUnits`/`costBasisWei`/`holdingTaxPct` quartet, and
   * the replacement is RESULTS §10.5 expressed in the type system rather than a refactor for
   * tidiness. A field that can hold one position takes 17 of 72 held-out opportunities and posts a
   * Welch t of 1.16 — not significant. Eight slots take 71 of 72 at t 2.38–2.72 on 20 of 20 seeds,
   * with an IDENTICAL per-ticket median (~+4,410bps). **What changed was n, not the edge**, and no
   * amount of keeper cleverness gives a single `holding` address a second value.
   *
   * Empty slots are ABSENT rather than represented by a hole, matching both `StrayVault` (whose one
   * emptiness test is `token == address(0)`) and `@strays/hunt`'s `StrayState.positions`. A second
   * representation of emptiness is a second thing that can disagree.
   */
  readonly positions: readonly PositionState[];
  readonly entryBlock: bigint;
};

/** Everything the tick needs from the outside, so `runTick` itself is pure-ish and testable. */
export type TickDeps = {
  readonly listStrays: () => Promise<readonly StrayState[]>;
  readonly discover: () => Promise<readonly Candidate[]>;
  readonly currentBlock: () => Promise<bigint>;
  readonly gasPriceWei: () => Promise<bigint>;
  /**
   * Enter a position. Returns the tx hash and **the SLOT the contract actually used**.
   *
   * MUST throw on revert rather than returning a falsy value.
   *
   * ══ WHY THE SLOT COMES BACK FROM THE CHAIN RATHER THAN BEING ASSUMED ══
   *
   * `hunt` returns `uint256 slot` because the contract picks it, by scanning for the lowest free
   * index. The keeper predicts the same index (`firstFreeSlot` implements the identical
   * lowest-first rule) but a prediction is not an observation: between deciding and landing, an
   * earlier slot can be freed by a `flee` that landed first, or the contract's scan can differ from
   * ours after any future edit to either.
   *
   * The consequence of believing a wrong prediction is specific and expensive: the watermark for
   * the new position would be filed under a slot that holds a DIFFERENT token, so the trailing stop
   * for both would be computed from the other one's peak. The returned value is the chain's answer
   * and it is what gets persisted.
   */
  readonly executeHunt: (
    strayId: `0x${string}`,
    token: `0x${string}`,
    hook: string,
    amountWei: bigint,
    minOut: bigint,
    tickSpacing: number,
  ) => Promise<{ txHash: `0x${string}`; gasUsed: bigint; slot: number }>;
  /** Exit ONE slot. The slot is named because `flee(strayId, slot, minOut)` names it. */
  readonly executeFlee: (
    strayId: `0x${string}`,
    slot: number,
    minOut: bigint,
  ) => Promise<{ txHash: `0x${string}`; gasUsed: bigint }>;
  /**
   * RAISE THE ON-CHAIN PEAK WATERMARK for one slot. Returns the effective peak after the call.
   *
   * ⚠ **THIS IS A STATE-CHANGING ON-CHAIN CALL AND IT IS GATED BY THE SAME THREE SWITCHES AS
   * `hunt` AND `flee`.** It moves no value — `StrayVault.mark` is keeper-only, monotone, and
   * nothing in the contract reads `peakPriceWei` to gate anything — but "moves no value" is not the
   * test. The test is whether an observe-mode keeper touches the chain, and meridian's recorded
   * failure is precisely a master switch that did not stop all on-chain activity: its LP guard "ran
   * EVEN WITH AGENT_LIVE_TRADING=false".
   *
   * A `mark` call still signs a transaction with the keeper key, still spends gas, and still writes
   * to contract storage. An operator who has not set all three switches has not consented to any of
   * that. So in observe mode this is a function that THROWS, exactly like the other two, and
   * `safety.test.ts` asserts it.
   *
   * The tick treats a failure here as non-fatal (see `runTick`): the Postgres copy is still written
   * and the local stop is still evaluated, so a failed `mark` degrades durability from two copies
   * to one rather than skipping the stop.
   */
  readonly executeMark: (
    strayId: `0x${string}`,
    slot: number,
    priceWei: bigint,
  ) => Promise<{ txHash: `0x${string}`; peakPriceWei: bigint }>;
  /**
   * Quote the current value of ONE holding, for exit decisions.
   *
   * Takes the hook, because valuing a position means quoting the pool it actually sits in.
   */
  readonly quoteExitWei: (
    token: `0x${string}`,
    units: bigint,
    tickSpacing: number,
    hook: string,
  ) => Promise<bigint>;
  /**
   * Read the DURABLE local copy of a stray's watermarks, keyed by slot. Absent when there is no
   * store (observe mode without a DATABASE_URL), in which case the chain is the only copy.
   */
  readonly loadPeaks?:
    | ((strayId: `0x${string}`) => Promise<ReadonlyMap<number, { token: string; peakPriceWei: bigint }>>)
    | undefined;
  /** Persist a raised watermark locally. Absent when there is no store. */
  readonly savePeak?:
    | ((args: {
        strayId: `0x${string}`;
        slot: number;
        token: string;
        peakPriceWei: bigint;
      }) => Promise<void>)
    | undefined;
  /** Forget a closed slot's watermark, so it cannot attach to the slot's next occupant. */
  readonly clearPeak?: ((strayId: `0x${string}`, slot: number) => Promise<void>) | undefined;
  readonly record: (r: DecisionRecord) => Promise<void>;
  readonly decide: (input: DecideInput) => Decision | Promise<Decision>;
  readonly now: () => number;
};

/** One position valued this tick: its mark, and the watermark the stop is measured against. */
export type PositionMark = {
  readonly slot: number;
  readonly token: `0x${string}`;
  /** ETH-per-token, scaled 1e18. `null` when the pool could not be quoted this tick. */
  readonly markPriceWei: bigint | null;
  /** Total proceeds the whole position would fetch, in wei. `null` when unreadable. */
  readonly valueWei: bigint | null;
  /** The reconciled peak: the highest of chain, Postgres and this tick's mark. */
  readonly peakPriceWei: bigint;
};

export type DecideInput = {
  readonly stray: StrayState;
  readonly candidates: readonly Candidate[];
  readonly gasPriceWei: bigint;
  /**
   * Every open position's mark and reconciled watermark, by slot. **Not one price — up to eight.**
   *
   * With eight concurrent positions a single mark price is not merely insufficient, it is
   * dangerous: whichever position the loop happened to be looking at would be valued at another
   * token's price, and the trailing stop would fire — or fail to fire — on a number belonging to
   * something else entirely.
   */
  readonly marks: readonly PositionMark[];
  /** Total mark-to-market value of all open positions, in wei. The equity term. */
  readonly totalValueWei: bigint;
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
      /** The pool's hook, carried from the screened candidate so the traded pool is the screened one. */
      readonly hook: string;
      readonly reason: string;
    }
  | {
      readonly kind: "exit";
      /** WHICH SLOT to sell. `flee` names one, and a wrong index sells the wrong position. */
      readonly slot: number;
      readonly token: `0x${string}`;
      readonly minOut: bigint;
      readonly reason: string;
    };

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
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════
       * VALUE **EVERY** OPEN POSITION, AND MAINTAIN **EVERY** WATERMARK.
       * ══════════════════════════════════════════════════════════════════════════════════════
       *
       * This loop replaces a single `quoteExitWei` call against a single holding. With eight slots
       * that single call was not merely incomplete — it valued whichever position happened to be
       * "the" holding and would have evaluated every stop against that one token's price.
       *
       * Each position is quoted in ITS OWN pool (its own tickSpacing AND its own hook — RESEARCH
       * §7d), and each failure is isolated: one unreadable pool must never stop the other seven
       * being checked against their own stops. `@strays/hunt`'s `decide` makes the same guarantee
       * on its side, and it is worth stating why it matters here too — a keeper that returns early
       * on the first failed read would, on a single flaky token, silently disarm seven live stops
       * on every tick until that one read recovered.
       */
      const marks: PositionMark[] = [];
      let totalValueWei = 0n;

      const storedPeaks =
        deps.loadPeaks !== undefined
          ? await deps.loadPeaks(stray.id).catch(() => undefined)
          : undefined;

      for (const position of [...stray.positions].sort((a, b) => a.slot - b.slot)) {
        /*
         * ── STEP 1: RECONCILE THE WATERMARK. THE CHAIN IS THE AUTHORITY. ──
         *
         * Three copies of this number can exist and they are combined by taking the MAXIMUM, which
         * is not an arbitrary tie-break — it is `raisePeak`'s monotonicity used as a merge rule.
         * Because neither side may ever lower a watermark, the higher value is by construction the
         * one that saw more of the price history, so max is the only combination that cannot lose
         * information. The same rule runs in `@strays/hunt`'s `raisePeak`, in
         * `StrayVault.mark`'s `if (priceWei <= current) return current`, and in this store's
         * `GREATEST(...)` upsert. Three implementations, one rule, converging rather than racing.
         *
         * **THIS IS THE LINE THAT SURVIVES A RESTART**, and it is the whole reason the watermark is
         * not a `Map` in this process. RESEARCH §7f is meridian's daily cap that "only reset on
         * process restart, so the 'daily' cap was really 'spend since last boot'". A peak held in
         * memory is that bug wearing different clothes and it fails strictly worse: a reset spend
         * cap is too permissive about spending, but a reset watermark RE-ANCHORS the trailing stop
         * to the current price. Entry 100, peak 500, stop 250; redeploy at price 260; the peak
         * re-seeds at 260 and the stop drops to 130. The stop has been silently widened by 48% and
         * it widens again on every deploy — and because Railway redeploys on push, that is several
         * times an hour. §10.3 measured that this exit is what resolves positions at all (0 of 72
         * held-out positions needed marking to market with it, 100% were unresolved without it), so
         * losing it does not degrade the strategy, it disarms the only exit the strategy has. And
         * it does so invisibly: a cat that never sells looks exactly like a cat whose stop has not
         * been hit.
         *
         * The stored row is used ONLY when its token still matches the slot's current occupant. A
         * slot is reused after a position closes, and a previous token's peak is not a larger
         * observation of this token's price — it is an unrelated number that would arm or disarm
         * the stop on something else's arithmetic.
         */
        const stored = storedPeaks?.get(position.slot);
        const storedUsable =
          stored !== undefined && stored.token.toLowerCase() === position.token.toLowerCase()
            ? stored.peakPriceWei
            : 0n;
        // CHAIN FIRST. `position.peakPriceWei` is read from `positionsOf` every tick, so it is the
        // authority; the local copy can only ever raise it, never replace it.
        let peakPriceWei =
          storedUsable > position.peakPriceWei ? storedUsable : position.peakPriceWei;

        /* ── STEP 2: QUOTE THE CURRENT MARK, in this position's own pool. ── */
        const valueWei =
          position.units > 0n
            ? await deps
                .quoteExitWei(position.token, position.units, position.tickSpacing, position.hook)
                .catch(() => null)
            : null;

        /*
         * A per-UNIT price, not a total. `Market.markPricesWei` is documented as ETH-per-token
         * scaled 1e18 and `quoteExitWei` returns TOTAL proceeds; passing the total compared a whole
         * position's value against a per-unit peak and reported +574,656,667bps on a position that
         * had moved +66bps (`units.test.ts` pins this). Zero or unreadable stays `null` rather than
         * becoming 0 — a zero mark reads as a 100% fall and would fire every stop at once.
         */
        const markPriceWei =
          valueWei !== null && valueWei > 0n && position.units > 0n
            ? (valueWei * 10n ** 18n) / position.units
            : null;

        if (valueWei !== null && valueWei > 0n) totalValueWei += valueWei;

        /*
         * ── STEP 3: RAISE THE WATERMARK IF THIS TICK IS A NEW HIGH — IN BOTH PLACES. ──
         *
         * Postgres FIRST, then the chain. The order is deliberate and it is the same
         * commit-before-signing rule the spend ledger follows: the durable local write is cheap,
         * cannot revert, and cannot be lost to a dropped transaction, so doing it first means a
         * crash between the two leaves the local copy AHEAD of the chain. Ahead is the safe
         * direction — the reconciliation above takes the max, so a higher local copy is preserved
         * and simply re-pushed to the chain on the next tick, whereas a chain write we failed to
         * mirror locally would be silently discarded if the chain read ever failed.
         *
         * Neither write is allowed to abort the tick. A `mark` that fails costs us the second copy
         * of the number, not the stop itself: `peakPriceWei` is already raised in memory for this
         * tick's evaluation and the local row is already written, so the stop is still computed
         * from the correct value. Throwing here would let a keeper-side RPC hiccup prevent the exit
         * evaluation of every position after it — turning a durability problem into a trading one.
         *
         * In OBSERVE mode `executeMark` throws by construction, so the chain copy is simply never
         * written and the failure is caught here. That is correct: an observe-mode keeper must not
         * sign anything, and it still maintains a full local watermark so its decisions are real.
         */
        if (markPriceWei !== null && markPriceWei > peakPriceWei) {
          const raised = markPriceWei;
          peakPriceWei = raised;

          if (deps.savePeak !== undefined) {
            await deps
              .savePeak({
                strayId: stray.id,
                slot: position.slot,
                token: position.token,
                peakPriceWei: raised,
              })
              .catch((e) =>
                console.error(
                  `peak not persisted for ${stray.id} slot ${String(position.slot)}: ${String(e)}`,
                ),
              );
          }

          await deps.executeMark(stray.id, position.slot, raised).catch((e) => {
            // Expected and unremarkable in observe mode; a real failure in live mode, logged with
            // the slot so an operator can see WHICH watermark is running on one copy.
            console.warn(
              `mark() not landed for ${stray.id} slot ${String(position.slot)} at ` +
                `${raised.toString()} wei: ${String(e)}`,
            );
            return { txHash: "0x" as `0x${string}`, peakPriceWei: raised };
          });
        }

        marks.push({
          slot: position.slot,
          token: position.token,
          markPriceWei,
          valueWei,
          peakPriceWei,
        });
      }

      const decision = await deps.decide({
        stray,
        candidates,
        gasPriceWei,
        marks,
        totalValueWei,
        block,
      });

      const base = { strayId: stray.id, block, at: deps.now() } as const;

      if (decision.kind === "hold") {
        const rec: DecisionRecord = {
          ...base,
          action: "hold",
          // The lowest-numbered open position, or null when flat. A hold is about the whole stray
          // rather than one slot, so this names something rather than inventing a choice.
          token: stray.positions[0]?.token ?? null,
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
          const { txHash, gasUsed, slot } = await deps.executeHunt(
            stray.id,
            decision.token,
            decision.hook,
            decision.amountWei,
            decision.minOut,
            decision.tickSpacing,
          );
          outcome = { kind: "landed", txHash, gasUsed };

          /*
           * ══ SEED THE WATERMARK IN THE SLOT THE CHAIN ACTUALLY USED ══
           *
           * `hunt` returns the slot it chose, and that returned value is what the watermark is
           * filed under — never the slot we predicted. The contract seeds `peakPriceWei` to the
           * measured entry price (`ethIn * 1e18 / received`, both terms its own), so the chain's
           * copy is already correct the instant this returns. What is written here is the LOCAL
           * mirror, and it is written from the same arithmetic against the amount we actually sent.
           *
           * Filing it under a predicted slot would be the specific bug this guards: a watermark
           * attached to a slot holding a different token means both positions' stops are computed
           * from the other one's peak.
           *
           * A failure to persist is logged, not thrown — the next tick reconciles from the chain,
           * which is the authority, so the durable copy self-heals.
           */
          if (deps.savePeak !== undefined && decision.minOut > 0n) {
            const entryPriceWei = (decision.amountWei * 10n ** 18n) / decision.minOut;
            await deps
              .savePeak({
                strayId: stray.id,
                slot,
                token: decision.token,
                peakPriceWei: entryPriceWei,
              })
              .catch((e) =>
                console.error(
                  `entry watermark not persisted for ${stray.id} slot ${String(slot)}: ${String(e)}`,
                ),
              );
          }
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

      // exit — ONE named slot, never "the holding".
      const closing = stray.positions.find((p) => p.slot === decision.slot);
      let outcome: DecisionOutcome;
      try {
        const { txHash, gasUsed } = await deps.executeFlee(
          stray.id,
          decision.slot,
          decision.minOut,
        );
        outcome = { kind: "landed", txHash, gasUsed };

        /*
         * The slot is now free, so its watermark must go with it. A stale row is a watermark that
         * would be handed to whatever token opens in this slot next — and a previous token's peak
         * is an unrelated number that would arm or disarm the new position's stop on arithmetic
         * belonging to something else. `peaksFor`'s token check is the second guard behind this
         * one; either alone would do, and having both means a missed delete is still safe.
         */
        if (deps.clearPeak !== undefined) {
          await deps
            .clearPeak(stray.id, decision.slot)
            .catch((e) =>
              console.error(
                `stale watermark not cleared for ${stray.id} slot ${String(decision.slot)}: ` +
                  String(e),
              ),
            );
        }
      } catch (err) {
        outcome = { kind: "failed", reason: String(err) };
      }
      const rec: DecisionRecord = {
        ...base,
        action: "flee",
        token: decision.token,
        // The UNITS being sold, from the position actually named by the slot.
        amountWei: closing?.units ?? 0n,
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
