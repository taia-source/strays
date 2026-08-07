/**
 * THE ENTRY GATE. **A token's AGE IN SWAPS, not a pattern in its price.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ THIS REPLACES A REFUTED STRATEGY FAMILY, AND THE REFUTATION IS THE POINT ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The shipped entry was a 2-sigma momentum breakout on 60 minutes of price history (`signal.ts`,
 * whose derivation was careful and whose conclusion was wrong). It was tested eleven times across
 * three backtest rounds and the family is refuted. RESULTS.md §10.7 has the arithmetic:
 *
 *     momentum edge (held-out)      +145 bps over random
 *     round trip                    −208 bps
 *                                   ─────────
 *                                    −63 bps
 *
 * And STATE.md records WHY it lost, which is worse than "it did not work" — it was buying the
 * bottom quintile on purpose. Forward net by how far a token had ALREADY run when the momentum
 * entry fired:
 *
 *     already fallen      +3,260 bps forward    97.4% win
 *     +0…19%                +842 bps            71.8%
 *     +20…85%             −1,838 bps            23.1%
 *     +87…296%            −3,878 bps            33.3%
 *     +296%…              −5,999 bps            17.1%
 *
 * **A momentum entry buys the top quintile of run-up by construction, and the top quintile is where
 * the forward returns are worst.** The signal was not weak; it was inverted. That is the failure
 * this module prevents, and it is why the replacement is not "a better price pattern" — it is a
 * different KIND of fact about a token.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE EVIDENCE: A MONOTONE DOSE-RESPONSE ON HELD-OUT DATA ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * §10.4's strongest result. Median net, by the swap index at which the position was opened, on
 * tokens that launched later than every token used to choose the rule:
 *
 *     entry at swap    5      10      20      50     100     200     500
 *     median net   +9,791  +5,838  +4,410    +696    −845  −1,748  −3,302
 *
 * Monotone across all seven doses, crossing zero between swap 50 and swap 100. **Swaps 200 and 500
 * were never in the search space at all**, so two of the seven points are pure out-of-sample
 * confirmation of the ordering rather than of a level.
 *
 * A single threshold that works is what a search over five values produces by chance. **A monotone
 * gradient is different, because chance does not usually produce an ordering** — and this is a
 * gradient, not a threshold. That distinction is the single strongest piece of evidence in four
 * rounds of backtesting and it is the reason this rule was shipped over the one it replaces.
 *
 * ── WHY 20 AND NOT 5, WHEN 5 MEASURED BETTER ──
 *
 * The curve says enter as early as possible: swap 5 has a +9,791bps median against swap 20's
 * +4,410. Three reasons the gate sits at 20 anyway, and none of them is that 20 measured best:
 *
 *   1. **Sellability.** §10.4 applied `sellableBefore` — *the pool has absorbed a real sell of at
 *      least our size, strictly before the entry bar* — and 68 of 72 tokens pass it AT SWAP 20.
 *      Earlier, fewer pools have absorbed a sell of our size at all, and
 *      `RESEARCH-PROFITABLE-AGENTS.md` §9 names exactly this as the kill condition: quiet early
 *      launches have the best forward medians and quiet pools are the ones a $5 position cannot
 *      sell. At swap 20 the sets provably do not overlap; at swap 5 that has not been measured.
 *   2. **The TRAIN sweep chose 20**, and §10.3's discipline is that the arm carried to the held-out
 *      fold is the one proposed before the results were seen. Moving to swap 5 after reading the
 *      dose-response is selecting the reported arm by its own search result.
 *   3. **20 swaps is where a price series exists at all.** The trailing exit needs a peak watermark
 *      and the screen needs a sell simulation; both are computed from history that a 5-swap token
 *      has barely begun to produce.
 *
 * Stated plainly: **swap 5 is a lead, not the shipped rule.** §10.7's next-experiments list carries
 * it, alongside `entry@20 trail30%`, for a fresh fold.
 *
 * ── AND THE HONESTY LINE, WHICH MUST NOT BE SOFTENED ──
 *
 * §10.6: `assessOverfitting` at **183 cumulative trials returns `credible: false`**. n=72, a
 * 1.74-day median held-out span, and a cost model that is INCOMPLETE in the optimistic direction
 * (slippage, reverts, own price impact). The Welch t against matched random is 2.30–2.69 and
 * clears t>3 on **zero** of 20 seeds.
 *
 * **This rule is out-of-sample positive. It is not proven.** Everything above is a reason to
 * prefer it to the refuted family it replaces, not a reason to believe the medians will be
 * realised.
 */

/**
 * The swap index at which a token becomes huntable. Derived at length in the header.
 *
 * Held-out median at this dose: **+4,410 bps**, against a −208bps round trip — the toll is 4.7% of
 * the median move, which is the sentence §10.7 makes the whole round about.
 */
export const ENTRY_SWAP_INDEX = 20;

/**
 * The swap index past which a token is too old to enter, from the same curve.
 *
 * The median crosses zero between swap 50 (+696bps) and swap 100 (−845bps), so the ceiling sits at
 * **50**: the last dose measured with a positive median. It is deliberately NOT set at 100, where
 * the measurement says we would be entering trades with a negative expected median.
 *
 * This ceiling is what makes the rule a WINDOW rather than a floor, and the window is the honest
 * shape of the finding — "enter early" is a statement about a gradient, and a gradient with a sign
 * change in it has two edges.
 */
export const MAX_ENTRY_SWAP_INDEX = 50;

/**
 * The held-out median net, in bps, at each measured entry dose (§10.4 / STATE.md ROUND 4).
 *
 * Kept as DATA rather than prose so a test can assert the ordering the argument rests on. If a
 * future edit retunes `ENTRY_SWAP_INDEX` to a dose whose median is negative, `age.test.ts` fails —
 * the constant cannot drift away from the evidence that justifies it without something going red.
 */
export const MEASURED_MEDIAN_NET_BPS: readonly (readonly [number, bigint])[] = [
  [5, 9791n],
  [10, 5838n],
  [20, 4410n],
  [50, 696n],
  [100, -845n],
  [200, -1748n],
  [500, -3302n],
];

/**
 * The held-out median net at the dose nearest to (and not later than) `swapCount`, in bps.
 *
 * **This is what the cost bar is fed**, replacing the momentum signal's take-profit projection. The
 * difference is the difference between an estimate derived from this token's last hour of price —
 * a pattern §10.7 refuted and STATE.md showed to be inverted — and a number measured across 72
 * held-out tokens.
 *
 * ── HOW A DOSE IS PICKED, AND WHY IT ROUNDS DOWN ──
 *
 * The curve is measured at seven points, not continuously, so a token at swap 34 has to be assigned
 * one of them. It takes the NEAREST MEASURED DOSE AT OR BELOW its swap count — swap 34 is priced at
 * swap 20's +4,410bps rather than at swap 50's +696. Rounding down is the conservative direction on
 * a decreasing curve... no: it is the OPTIMISTIC one, and that is worth being explicit about rather
 * than dressing up. It is chosen anyway because the alternative is worse: rounding up prices a
 * swap-21 token at the swap-50 dose, an 84% haircut for one extra swap, which would make the bar
 * discontinuous in a way the measurement does not support. The window ceiling
 * (`maxEntrySwapIndex`) is what actually bounds the optimism — no token past swap 50 is entered at
 * all, so the largest possible error is one dose-step inside a window whose every dose has a
 * positive median.
 *
 * Anything below the earliest measured dose is priced at that dose. Anything at or above the last
 * is priced at the last, which is negative and will fail the bar — correctly, though in practice
 * `withinEntryWindow` has already refused it.
 *
 * A MEDIAN, never the mean. The mean at swap 20 is +37,727bps and the top 1% of positions carry
 * 31.9% of all profit (§10.4); sizing a bar against that would be sizing it against a tail we have
 * no reason to expect on any particular ticket.
 */
export function measuredMedianNetBps(swapCount: number, cfg: AgeConfig = DEFAULT_AGE): bigint {
  void cfg;
  let chosen = MEASURED_MEDIAN_NET_BPS[0];
  if (chosen === undefined) {
    throw new Error("unreachable: the measured dose-response table is empty");
  }
  for (const entry of MEASURED_MEDIAN_NET_BPS) {
    if (entry[0] <= swapCount) chosen = entry;
  }
  return chosen[1];
}

export type AgeConfig = {
  /** The earliest swap index we will enter at. Below this, the pool may not be sellable yet. */
  readonly entrySwapIndex: number;
  /** The latest swap index we will enter at. Past this the measured median is negative. */
  readonly maxEntrySwapIndex: number;
};

/** The shipped window: swaps 20 through 50. Both bounds derived in the header. */
export const DEFAULT_AGE: AgeConfig = {
  entrySwapIndex: ENTRY_SWAP_INDEX,
  maxEntrySwapIndex: MAX_ENTRY_SWAP_INDEX,
};

export type AgeVerdict = {
  /** Whether this token is inside the entry window. */
  readonly inWindow: boolean;
  /** The token's realised swap count, as supplied. */
  readonly swapCount: number;
  /** The arithmetic and the evidence, rendered for `/logs` (DESIGN §8). */
  readonly reason: string;
};

/**
 * Is this token at the right point in its life to enter?
 *
 * PURE, and it reads a COUNT rather than a clock — which is the substantive change from the rule it
 * replaces. `eligible.ts`'s `minAgeSeconds` asks how long a token has EXISTED; this asks how much it
 * has been TRADED, and on this pad those are very different questions: RESEARCH §3d measured that
 * 40% of the pad has never traded at all, so a token can be hours old and sit at swap 0.
 *
 * The dose-response in §10.4 is indexed by swap, not by seconds, so this gate is indexed by swap
 * too. Measuring the gate in a unit the evidence was not collected in is the openhood units bug
 * (`signal.ts`, LOOKBACK_MINUTES) in a new place, and it is avoided the same way: the code uses the
 * unit the measurement used.
 */
export function withinEntryWindow(swapCount: number, cfg: AgeConfig = DEFAULT_AGE): AgeVerdict {
  if (!Number.isInteger(cfg.entrySwapIndex) || cfg.entrySwapIndex < 0) {
    throw new Error(
      `refusing an entry swap index of ${String(cfg.entrySwapIndex)} — it is a count of realised ` +
        "swaps, so it must be a non-negative integer",
    );
  }
  if (
    !Number.isInteger(cfg.maxEntrySwapIndex) ||
    cfg.maxEntrySwapIndex < cfg.entrySwapIndex
  ) {
    throw new Error(
      `refusing an entry window of [${String(cfg.entrySwapIndex)}, ` +
        `${String(cfg.maxEntrySwapIndex)}] swaps — the ceiling sits below the floor, so the window ` +
        "is empty and no token could ever be entered. A gate nothing can pass is indistinguishable " +
        "from a broken strategy",
    );
  }

  if (!Number.isInteger(swapCount) || swapCount < 0) {
    return {
      inWindow: false,
      swapCount,
      reason:
        `refused: swapCount is ${String(swapCount)}, not a count of realised swaps. The entry gate ` +
        "is indexed by swap because the measured dose-response is (RESULTS §10.4); a failed read " +
        "must not be treated as swap 0, which is the earliest and most attractive dose",
    };
  }

  if (swapCount < cfg.entrySwapIndex) {
    return {
      inWindow: false,
      swapCount,
      reason:
        `refused: ${String(swapCount)} realised swaps < the ${String(cfg.entrySwapIndex)}-swap entry ` +
        "point. Earlier doses measured BETTER (+9,791bps median at swap 5 vs +4,410 at swap 20), " +
        "but 68 of 72 held-out tokens pass the sell-simulation gate at swap 20 and that has not " +
        "been measured earlier — a pool too quiet to have absorbed a sell of our size is a position " +
        "we cannot exit (RESEARCH-PROFITABLE-AGENTS §9)",
    };
  }

  if (swapCount > cfg.maxEntrySwapIndex) {
    return {
      inWindow: false,
      swapCount,
      reason:
        `refused: ${String(swapCount)} realised swaps > the ${String(cfg.maxEntrySwapIndex)}-swap ` +
        "ceiling. The held-out median decays monotonically with entry age and crosses zero between " +
        "swap 50 (+696bps) and swap 100 (−845bps), so entering here is entering a trade whose " +
        "measured median is negative. This is a GRADIENT, not a threshold (RESULTS §10.4)",
    };
  }

  return {
    inWindow: true,
    swapCount,
    reason:
      `early entry: ${String(swapCount)} realised swaps, inside the [${String(cfg.entrySwapIndex)}, ` +
      `${String(cfg.maxEntrySwapIndex)}] window. Held-out median at swap 20 is +4,410bps against a ` +
      "−208bps round trip. OUT-OF-SAMPLE POSITIVE, NOT PROVEN: assessOverfitting returns " +
      "credible:false at 183 cumulative trials, n=72, and the cost model is incomplete in the " +
      "optimistic direction (RESULTS §10.6)",
  };
}
