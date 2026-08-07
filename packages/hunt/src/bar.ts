/**
 * THE ENTRY BAR. An expected gain must clear `EDGE_MULTIPLE x roundTripCost` before a trade fires.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ DERIVING EDGE_MULTIPLE — AND WHY IT IS 2 HERE FOR A DIFFERENT REASON THAN OPENHOOD'S ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * openhood also used 2, and its stated reason was sound: the cost term is KNOWN and the edge term
 * is an ESTIMATE, so requiring the estimate merely to exceed the known cost fires a trade whenever
 * the estimate errs high — which, for an estimate drawn from the same noisy series the trade will
 * be exposed to, is about half the time. A 2x margin means the estimate must be wrong by more than
 * 100% before the trade is a loser on costs alone.
 *
 * That argument transfers. What does NOT transfer is the arithmetic it landed in, and the check
 * that matters is whether 2 is still a bar HERE rather than a number inherited by habit.
 *
 * ── THE TEST A CANDIDATE MULTIPLE MUST PASS ──
 *
 * RESEARCH §3b: round trip on a 1%-tax token at $5 is **231.4 bps**.
 * RESEARCH §3d: mean absolute 24h move across live launches is **7.7% = 770 bps**.
 *
 *   multiple   required gain    vs the 770bps typical move
 *      1x        231 bps        0.30x  — clears on a THIRD of a typical move. Not a bar.
 *      2x        463 bps        0.60x  — refuses the typical move, admits the large one.
 *      3x        694 bps        0.90x  — needs ~a full mean-absolute move.
 *      4x        926 bps        1.20x  — needs to beat the mean absolute move outright.
 *      8x       1851 bps        2.40x  — beyond the whole measured range bar the +38.8% tail.
 *
 * The measured range of 24h moves was −17.1% to +38.8%, and 19 of the newest 48 launches did not
 * move at all. At 1x the bar is cleared by noise; at 4x and above it is asking most of the pad's
 * distribution for a single trade. **2x is the smallest multiple that refuses the median move
 * while still admitting the large one, which is the entire job of a cost-aware bar.**
 *
 * DESIGN.md, on openhood's version of this same paragraph: "A bar nothing can clear is
 * indistinguishable from a broken strategy; a bar everything clears is not a bar." That is the
 * property under test, and `bar.test.ts` asserts BOTH directions — that a sub-cost move is refused
 * AND that a supra-cost move is admitted. A suite that only proved refusal would pass just as
 * happily against a bar that refuses everything, which is precisely the state openhood shipped in
 * when its anvil gas price made every trade impossible.
 *
 * ── AND THE SIGNAL-TO-COST RATIO THAT MAKES ANY OF THIS POSSIBLE ──
 *
 * RESEARCH §3d, the table that decides whether the product exists at all:
 *
 *   openhood (tokenized NVDA)   ~42 bps/hour   vs 219 bps cost  ->  0.19x  — FORECLOSED
 *   strays  (1%-tax memecoin)   ~770 bps/24h   vs 231 bps cost  ->  3.30x  — viable
 *
 * A 3.3x signal-to-cost ratio is what leaves room for a 2x bar. At openhood's 0.19x, NO multiple
 * greater than zero was clearable — which is why that project's own postmortem concluded the cost
 * bar "refused none of them" and that "signal supply is the constraint". Here the constraint is
 * genuinely the bar, so the bar has to be right.
 *
 * ── WHY IT IS NOT FITTED ──
 *
 * 2 was not searched for over a return series. It is derived from two independently measured
 * numbers (cost and typical move) by asking which multiple sits between them, and the table above
 * is the whole search space, shown. `@taia/backtest`'s MinBTL guard exists to catch a constant
 * chosen by trying values until one traded; this one was chosen before any trade was simulated,
 * and it is recorded as a judgement call rather than a discovery.
 */

/** How many times the round-trip cost an expected gain must clear. Derived in the header. */
export const EDGE_MULTIPLE = 2n;

/** Basis points in 100%. */
const BPS_DENOMINATOR = 10_000n;

export type BarVerdict = {
  /** Whether the expected gain clears `multiple x cost`. */
  readonly clears: boolean;
  readonly expectedGainWei: bigint;
  readonly costWei: bigint;
  /** The number the gain actually had to beat: cost x multiple. */
  readonly requiredWei: bigint;
  readonly multiple: bigint;
  /** Gain as a multiple of cost, in basis points. 0 when cost is 0. For the log line. */
  readonly achievedRatioBps: bigint;
  /** The arithmetic, rendered. Logged for DECLINES as well as fires. */
  readonly arithmetic: string;
};

/**
 * THE BAR. Logged on every decision, including every decline.
 *
 * `arithmetic` exists so the decision log carries the NUMBERS rather than the conclusion. "No
 * trade" with nothing beside it is an assertion; "no trade, because 400bps < 2 x 231bps" is a
 * finding somebody can check. DESIGN §8 makes `/logs` the validation surface of the product, and
 * this string is most of what it shows. That is why this returns a struct rather than a boolean.
 *
 * A zero or negative expected gain never clears, whatever the cost — including the degenerate case
 * of zero cost, where a naive `gain >= multiple * cost` would pass on `0 >= 0` and fire a trade
 * with no expected gain at all. Checked FIRST and independently of the comparison for that reason.
 */
export function clearsBar(args: {
  readonly expectedGainWei: bigint;
  readonly costWei: bigint;
  readonly multiple?: bigint;
}): BarVerdict {
  const multiple = args.multiple ?? EDGE_MULTIPLE;
  if (multiple < 1n) {
    throw new Error(
      `refusing an edge multiple of ${multiple.toString()} — a multiple below 1 puts the bar ` +
        "BELOW the cost it exists to clear, which is not a bar at all. At 1x a 1%-tax round trip " +
        "(231bps) is cleared by 30% of a typical 770bps move, i.e. by noise",
    );
  }
  if (args.costWei < 0n) {
    throw new Error("refusing a negative round-trip cost — a trade that pays you to make it");
  }

  const requiredWei = args.costWei * multiple;
  const clears = args.expectedGainWei > 0n && args.expectedGainWei >= requiredWei;
  const achievedRatioBps =
    args.costWei > 0n ? (args.expectedGainWei * BPS_DENOMINATOR) / args.costWei : 0n;

  const arithmetic =
    `expected gain ${args.expectedGainWei.toString()} wei ` +
    `${clears ? ">=" : "<"} ${multiple.toString()} x round-trip cost ${args.costWei.toString()} wei ` +
    `= ${requiredWei.toString()} wei required ` +
    `(achieved ${achievedRatioBps.toString()}bps of cost, needed ${(multiple * BPS_DENOMINATOR).toString()}bps)`;

  return {
    clears,
    expectedGainWei: args.expectedGainWei,
    costWei: args.costWei,
    requiredWei,
    multiple,
    achievedRatioBps,
    arithmetic,
  };
}

/**
 * The bar expressed in basis points of the position — the form the signal needs.
 *
 * `signal.ts` produces a move in bps and the take-profit is set in bps, so converting the cost
 * bar into the same unit once, here, keeps the comparison in one place instead of scattering
 * `* 10_000n / positionWei` across the callers. At a 231bps round trip and EDGE_MULTIPLE = 2 this
 * returns 462–463bps, which is the number the header's table is about.
 */
export function requiredGainBps(args: {
  readonly costWei: bigint;
  readonly positionWei: bigint;
  readonly multiple?: bigint;
}): bigint {
  if (args.positionWei <= 0n) {
    throw new Error("refusing to express a bar as a fraction of a non-positive position");
  }
  const multiple = args.multiple ?? EDGE_MULTIPLE;
  return (args.costWei * multiple * BPS_DENOMINATOR) / args.positionWei;
}
