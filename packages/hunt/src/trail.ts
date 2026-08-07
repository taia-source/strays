/**
 * THE EXIT. A 50% TRAILING STOP FROM THE RUNNING PEAK — and the watermark it is measured against.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE MEASUREMENT THAT REPLACED THE OLD EXIT, AND WHY THE OLD ONE WAS BACKWARDS ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The shipped exit was a −235bps hard stop (`STOP_LOSS_BPS`) plus a derived take-profit around
 * +471bps. Both were honestly derived from the measured hourly vol, and both were **wrong about
 * this asset in the same direction**: they close a position on the ordinary noise that precedes the
 * moves that pay for everything.
 *
 * RESULTS.md §10.7 states the arithmetic that overturned it:
 *
 *     momentum edge (held-out)      +145 bps over random
 *     round trip                    −208 bps
 *                                   ─────────
 *                                    −63 bps        <-- lose, every time, forever
 *
 *     early-entry median (held-out)  +5,609 bps
 *     round trip                       −208 bps      <-- 3.7% of the median move
 *                                   ───────────
 *                                    +5,401 bps
 *
 * *"The toll never was the binding constraint. The holding period was."* A 235bps stop on an asset
 * whose winning tickets move thousands of bps is not a risk control; it is a mechanism for
 * converting winners into losers before they resolve. §10.3 measured the same point from the other
 * side: `stopMode:"none"` on hold-to-end posted a +213bps mean at an 88.3% win rate **purely
 * because losers never closed** (§9.5's censoring artifact), whereas adding a trailing stop
 * resolved 97% of positions and RAISED the median from +3,037 to +13,577bps.
 *
 * ── WHY 50% AND NOT 30%, WHEN 30% MEASURED BETTER ──
 *
 * §10.3's TRAIN sweep, stated in full because the choice is a judgement call and hiding it would be
 * the dishonest version of this comment:
 *
 *     entry@20 trail30%    TRAIN mean +13,234    median +3,284    Welch t 4.35   <-- BETTER t
 *     entry@20 trail50%    TRAIN mean +22,363    median +5,564    Welch t 3.48   <-- CHOSEN
 *
 * **trail50% was carried to the held-out fold even though trail30% had the higher t on TRAIN**,
 * and §10.3 gives the reason: trail50% was the arm proposed BEFORE the sweep ran, and switching to
 * trail30% after seeing the TRAIN t-statistics would be choosing the reported arm by its own search
 * result. That is the specific move that turns a search into an overfit. Trail30% is recorded as a
 * lead for a fresh fold (§10.7, next experiments, item 3) rather than harvested here.
 *
 * ── WHAT IS ESTABLISHED AND WHAT IS NOT. READ THIS BEFORE TRUSTING THE NUMBERS ABOVE. ──
 *
 * `assessOverfitting` at **183 cumulative trials returns `credible: false`** (§10.6), and that is
 * recorded here rather than in a footnote:
 *
 *   - n = 72 held-out tokens is short of the 98 needed for t > 3, and the Welch t against matched
 *     random peaks at 2.69. Significant by convention; NOT significant by the standard the harness
 *     implements, which exists because convention admits too many false discoveries.
 *   - The held-out window has a 1.74-day median span.
 *   - The cost model remains INCOMPLETE — slippage, reverts and our own price impact are all
 *     omitted, and **every omission biases optimistic**.
 *
 * **This is an out-of-sample-positive hypothesis. It is not a proven strategy.** The honest claim
 * is that the trailing exit beat matched random on 20/20 seeds and that a monotone dose-response
 * across seven entry ages is hard to produce by chance — not that the money is there.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHY THE WATERMARK IS AN INPUT AND NOT SOMETHING THIS MODULE REMEMBERS ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A trailing stop is a STATEFUL exit: it cannot be evaluated from price, only from price RELATIVE
 * TO the highest price seen since entry. That state has to live somewhere, and where it lives is a
 * correctness question rather than a plumbing one.
 *
 * RESEARCH §7f is meridian's recorded bug — an in-memory daily cap that *"reset only on process
 * restart, so it was really 'spend since last boot'"*. A peak watermark held in a process is the
 * same bug wearing different clothes, and it fails WORSE: a reset watermark does not merely lose
 * information, it snaps the trailing stop back to the current price, which **widens the stop after
 * every deploy and silently disarms the only exit this strategy has.** A cat that redeploys often
 * would never sell.
 *
 * So the watermark is stored twice, deliberately, and this module holds neither copy:
 *
 *   - **On chain**, as `Position.peakPriceWei`, raised by the keeper-only monotone `mark()`. The
 *     chain is the authority, and `positionsOf` returns it so a user can read the level their cat
 *     will sell at rather than being told about it.
 *   - **In the indexer's Postgres**, so the two can be reconciled and a disagreement is visible.
 *
 * Every function here is pure and takes the prior state explicitly, which is `@taia/authority`'s
 * `bounds.ts` rule verbatim: *"the caller is forced to decide where that state durably lives, and
 * the honest answer is on chain or in a database, never in the process that is being constrained."*
 *
 * ══ AND WHY NOTHING HERE CAN REFUSE AN EXIT ══
 *
 * `trailingStopFired` returns whether the stop HAS fired. There is no function in this file that
 * returns "you may not sell", and the contract deliberately does not gate `flee` on the watermark
 * either — `StrayVault.flee`'s comment: *"a contract-side condition on selling is a condition on
 * selling."* DESIGN §6 Rule 5. The watermark decides WHEN we choose to sell; it can never decide
 * that we may not.
 */

const BPS_DENOMINATOR = 10_000n;

/**
 * The trailing stop, in bps below the running peak. 5000 = 50%.
 *
 * DERIVED FROM A HELD-OUT MEASUREMENT, not from volatility arithmetic — which is the difference
 * between this constant and the `STOP_LOSS_BPS` it replaces. `STOP_LOSS_BPS` was −1.5 sigma_1h,
 * derived correctly from a measured 157bps hourly sigma, and it was still the wrong rule because a
 * level derived from typical vol closes the position during atypical moves, and the atypical moves
 * are the entire distribution's mass (§10.4: top 10% of positions = 76.1% of all profit).
 *
 * 50% is wide enough that a token can halve from its peak and still be held. That sounds reckless
 * until it is priced against what it buys: §10.3 measured that the same entries with NO trailing
 * exit leave 100% of positions unresolved, and §10.4 measured that with this exit **0 of 72
 * held-out positions needed marking to market** — they all closed, and 73.6% of them closed
 * profitably.
 */
export const TRAIL_BPS = 5000n;

/**
 * The verdict of a trailing-stop evaluation. Carries the arithmetic, for the same reason
 * `bar.ts` does: DESIGN §8 makes `/logs` the validation surface, and "sold" with no numbers beside
 * it is an assertion rather than a finding.
 */
export type TrailingStopVerdict = {
  readonly fired: boolean;
  /** The watermark the fall was measured from, in wei. */
  readonly peakPriceWei: bigint;
  /** The mark the position was valued at this tick, in wei. */
  readonly markPriceWei: bigint;
  /** How far below the peak we are, in bps. Zero at or above the peak — never negative. */
  readonly fallFromPeakBps: bigint;
  /** The level the fall was compared against, in bps. */
  readonly trailBps: bigint;
  /** The price at which the stop fires, in wei. What a user should be shown. */
  readonly stopPriceWei: bigint;
  /** The arithmetic, rendered. Logged whether or not it fires. */
  readonly reason: string;
};

/**
 * HAS THE TRAILING STOP FIRED?
 *
 * PURE. Three numbers in, a verdict out. No clock, no chain, no config lookup — the caller supplies
 * the watermark because the caller is the one who knows where it durably lives (see the header).
 *
 * **This is the function the indexer calls each tick**, against the peak it read back from Postgres
 * or from `positionsOf`, and it is exported for exactly that reason.
 *
 * The comparison is `>=`, so a fall of exactly `trailBps` fires. A stop that needs to be exceeded
 * rather than reached is a stop that is one tick late by construction, and on an asset that can
 * halve inside a tick that difference is real money.
 *
 * Throws on a non-positive peak or mark rather than treating a failed read as a signal. RESEARCH §5
 * records the API as unofficial and unstable; `decide()` handles an unreadable mark by HOLDING and
 * saying so, because selling on a failed read is trading on no information.
 */
export function trailingStopFired(args: {
  readonly peakPriceWei: bigint;
  readonly markPriceWei: bigint;
  readonly trailBps: bigint;
}): TrailingStopVerdict {
  const { peakPriceWei, markPriceWei, trailBps } = args;

  if (peakPriceWei <= 0n) {
    throw new Error(
      `refusing to evaluate a trailing stop against a peak of ${peakPriceWei.toString()} wei. A ` +
        "zero watermark is an unset or reset one, and a reset watermark does not merely lose " +
        "information — it snaps the stop to the current price and silently disarms the only exit " +
        "this strategy has (RESEARCH §7f, meridian's 'spend since last boot' in a new costume)",
    );
  }
  if (markPriceWei <= 0n) {
    throw new Error(
      `refusing to evaluate a trailing stop against a mark of ${markPriceWei.toString()} wei — an ` +
        "unreadable pool has no price, and treating it as one manufactures a 100% fall out of a " +
        "failed read. The caller must HOLD on an unreadable mark, not sell (RESEARCH §5)",
    );
  }
  if (trailBps <= 0n || trailBps >= BPS_DENOMINATOR) {
    throw new Error(
      `refusing a trailing stop of ${trailBps.toString()}bps. At or below 0 the stop fires on every ` +
        "tick including a new high; at or above 10000 it can only fire when the token reaches zero, " +
        "which is not an exit rule but the absence of one",
    );
  }

  /*
   * The fall is clamped at zero rather than reported as a negative number. A mark ABOVE the peak
   * means the watermark has not been raised yet this tick — `raisePeak` is the caller's job and it
   * may legitimately run after this check — and reporting "−400bps below the peak" would be a
   * sentence nobody can read correctly at 3am. Above the peak, the stop has not fired; that is the
   * only fact this function needs to express.
   */
  const fallFromPeakBps =
    markPriceWei >= peakPriceWei
      ? 0n
      : ((peakPriceWei - markPriceWei) * BPS_DENOMINATOR) / peakPriceWei;

  /*
   * The stop price is computed from the peak directly rather than reconstructed from the fall, so
   * it is exact rather than a rounding of a rounding. It is in the verdict because a user should be
   * able to see the number their cat will sell at — the same argument `StrayVault` makes for
   * putting `peakPriceWei` in `positionsOf` rather than only in the keeper's database.
   */
  const stopPriceWei = (peakPriceWei * (BPS_DENOMINATOR - trailBps)) / BPS_DENOMINATOR;
  const fired = fallFromPeakBps >= trailBps;

  const reason = fired
    ? `TRAILING STOP: mark ${markPriceWei.toString()} wei is ${fallFromPeakBps.toString()}bps below ` +
      `the peak watermark ${peakPriceWei.toString()} wei, at or beyond the ` +
      `${trailBps.toString()}bps trail (stop price ${stopPriceWei.toString()} wei). Exiting now — ` +
      "this is the exit that resolved 72 of 72 held-out positions (RESULTS §10.4)"
    : `no trailing stop: mark ${markPriceWei.toString()} wei is ${fallFromPeakBps.toString()}bps ` +
      `below the peak ${peakPriceWei.toString()} wei, inside the ${trailBps.toString()}bps trail ` +
      `(stop price ${stopPriceWei.toString()} wei)`;

  return { fired, peakPriceWei, markPriceWei, fallFromPeakBps, trailBps, stopPriceWei, reason };
}

/**
 * Raise the watermark. **MONOTONE — it can never be lowered.**
 *
 * The monotonicity is the whole safety property, and it is expressed as a max rather than as an
 * `if` a future edit could invert: a watermark that can fall is a trailing stop that follows the
 * price down, which is not a trailing stop but a very slow market order.
 *
 * `StrayVault.mark()` enforces the same rule on chain (keeper-only, and it silently keeps the
 * higher of the two). Having the identical rule on both sides means a disagreement between the
 * indexer's copy and the chain's is a reconciliation signal rather than a race — whichever is
 * higher is the true one, and applying this function to both converges them.
 *
 * Refuses a non-positive incoming price rather than letting a failed read reset the peak. That is
 * the specific failure the header is about.
 */
export function raisePeak(currentPeakWei: bigint, markPriceWei: bigint): bigint {
  if (markPriceWei <= 0n) {
    throw new Error(
      `refusing to update a peak watermark from a mark of ${markPriceWei.toString()} wei — a failed ` +
        "price read must never touch the watermark, because a watermark that moves on bad data is " +
        "a stop that moves on bad data",
    );
  }
  if (currentPeakWei < 0n) {
    throw new Error(`refusing a negative peak watermark of ${currentPeakWei.toString()} wei`);
  }
  return markPriceWei > currentPeakWei ? markPriceWei : currentPeakWei;
}
