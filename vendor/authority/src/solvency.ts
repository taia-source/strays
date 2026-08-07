/**
 * Whether a keeper is being paid back — the failure every spend cap passes.
 *
 * ══ Three real bugs, one shape ══
 *
 * From `ponsball`'s catalogue, all three shipped and all three drained a funded wallet
 * while looking like they worked:
 *
 *   B14  the gas refund was capped at 20% of a beat's own ETH spend. On a small run a beat
 *        burns ~0.0000017 ETH so the cap was ~0.00000034 ETH, while gas cost ~0.00003 ETH.
 *        Measured live: the keeper lost **0.000082 ETH over one beat** — exactly the
 *        subsidy the refund existed to remove.
 *
 *   B15  the refund ran LAST and was capped at the contract's balance, so on a small claim
 *        it consumed the entire 45% burn share. "MM runs but burn never does", plus a
 *        steadily draining keeper.
 *
 *   B16  `executeSlice` repaid the keeper but `claimCreatorFees` — which perpetual mode runs
 *        every beat — did not. The keeper drained steadily on any actively-traded token.
 *
 * ══ Why `@taia/authority`'s spend caps cannot catch this ══
 *
 * `SpendPolicy` bounds a single transfer, a window's total, and a call count. Every one of
 * those bugs passes all three: each individual spend is small, legitimate, and well inside
 * every cap. The wallet still empties, one beat at a time.
 *
 * The missing question is not "was this spend allowed" but **"is the balance going down"**.
 * A refund that pays 1% is indistinguishable from one that works, unless something compares
 * the balance before and after.
 *
 * ══ Balance, not accounting ══
 *
 * Every check here takes an OBSERVED balance, read from chain. A keeper that tracks its own
 * expected reimbursement has the same blind spot as the bug: B14's contract believed it was
 * refunding correctly. Only the chain knows.
 */

/** A balance reading, taken from chain rather than computed. */
export type BalanceReading = {
  /** Wei held by the keeper. */
  readonly wei: bigint;
  /** When it was read. Drift is meaningless without an interval. */
  readonly atSecond: number;
};

/** What a solvency check concluded. */
export type SolvencyVerdict =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly failure: SolvencyFailure; readonly detail: string };

export type SolvencyFailure =
  /** The balance is falling across the window — the B14/B15/B16 shape. */
  | "draining"
  /** Below the floor needed to keep operating. */
  | "below-reserve"
  /** Not enough readings, or they are out of order, to conclude anything. */
  | "not-measurable";

/**
 * Whether a keeper's balance is holding.
 *
 * ══ Net-zero is the bar, not "spent less than the cap" ══
 *
 * A keeper that reimburses correctly ends a cycle roughly where it started — B15's fix was
 * verified exactly that way: "the keeper's balance is net-zero across a claim". So the
 * check is a comparison of two readings, and `tolerance` is what "roughly" means.
 *
 * Deliberately NOT a percentage of the balance: a nearly-empty keeper would then satisfy
 * any drain, which is the point at which the check matters most.
 */
export function judgeSolvency(input: {
  readonly first: BalanceReading;
  readonly latest: BalanceReading;
  /** Wei the balance may fall by before this is called draining. */
  readonly toleranceWei: bigint;
  /** Wei below which the keeper cannot operate, whatever the trend. */
  readonly reserveWei: bigint;
}): SolvencyVerdict {
  const { first, latest } = input;

  // Two readings from the same instant say nothing about a trend, and a later reading that
  // predates the earlier one means the caller mixed up its arguments.
  if (latest.atSecond <= first.atSecond) {
    return {
      ok: false,
      failure: "not-measurable",
      detail:
        `the latest reading is at ${latest.atSecond} and the first at ${first.atSecond}, so ` +
        "no interval has elapsed. A trend needs two points in order",
    };
  }

  /**
   * The reserve is checked FIRST and independently of the trend. A keeper that is already
   * too low to send a transaction is broken now, whether or not it is still falling — and a
   * flat balance at zero would otherwise read as healthy.
   */
  if (latest.wei < input.reserveWei) {
    return {
      ok: false,
      failure: "below-reserve",
      detail:
        `the keeper holds ${latest.wei} wei, below the ${input.reserveWei} wei reserve. It ` +
        "cannot pay for the transactions it exists to send, so it will fail silently rather " +
        "than loudly",
    };
  }

  const delta = latest.wei - first.wei;
  if (delta < 0n && -delta > input.toleranceWei) {
    const elapsed = latest.atSecond - first.atSecond;
    return {
      ok: false,
      failure: "draining",
      detail:
        `the keeper's balance fell by ${-delta} wei over ${elapsed}s, past a tolerance of ` +
        `${input.toleranceWei}. Measured on a real project: a gas refund capped at 20% of a ` +
        "beat's spend reimbursed about 1% of actual gas, and the keeper lost 0.000082 ETH " +
        "per beat while every spend cap passed — each individual spend was small and legal",
    };
  }

  return {
    ok: true,
    detail:
      delta >= 0n
        ? `balance held or grew by ${delta} wei`
        : `balance fell by ${-delta} wei, within tolerance`,
  };
}

/**
 * Whether a reimbursement actually covered what it was meant to.
 *
 * ══ The cap that was the wrong shape ══
 *
 * B14's refund was bounded by a fraction of the work's own value. That is wrong in
 * principle, not merely mis-tuned: gas on a small run legitimately exceeds the run's own
 * spend — a 0.0005 ETH run over 30 beats costs more in gas than it deposits — so no
 * percentage of the work can bound the gas the work cost.
 *
 * The right bound is a **price** cap, not a value cap: the fix kept only the basefee
 * multiple, because a keeper controls `tx.gasprice` but not `block.basefee`. That makes it
 * the real anti-abuse lever, and it does not shrink when the work is small.
 */
export function judgeReimbursement(input: {
  /** Gas the keeper actually paid for, in wei. */
  readonly gasSpentWei: bigint;
  /** What came back. */
  readonly refundedWei: bigint;
  /** Fraction of gas that must be covered, in basis points. 10000 = fully. */
  readonly minCoverageBps: number;
}): SolvencyVerdict {
  if (input.gasSpentWei <= 0n) {
    return { ok: true, detail: "no gas was spent, so nothing needed reimbursing" };
  }

  // Multiply before dividing: with wei-scale integers the reverse rounds every coverage
  // ratio to zero, and the check would pass for a refund of nothing.
  const coverageBps = (input.refundedWei * 10_000n) / input.gasSpentWei;

  if (coverageBps < BigInt(input.minCoverageBps)) {
    return {
      ok: false,
      failure: "draining",
      detail:
        `the refund covered ${coverageBps} bps of the ${input.gasSpentWei} wei gas spent, ` +
        `below the ${input.minCoverageBps} bps required. Measured on a real project: a cap ` +
        "set as a FRACTION OF THE WORK'S OWN VALUE reimbursed ~1%, because gas on a small " +
        "run legitimately exceeds that run's spend. Bound the refund by a PRICE cap — a " +
        "multiple of basefee, which the keeper cannot influence — not by a share of the work",
    };
  }

  return { ok: true, detail: `the refund covered ${coverageBps} bps of gas spent` };
}

/**
 * Whether a gas price is bounded by something the keeper cannot control.
 *
 * A keeper sets `tx.gasprice` and cannot set `block.basefee`, so a multiple of basefee is
 * the only cap it cannot inflate its way around. `ponsball` used 3×.
 */
export function judgeGasPriceCap(input: {
  readonly gasPriceWei: bigint;
  readonly baseFeeWei: bigint;
  readonly maxMultiple: number;
}): SolvencyVerdict {
  if (input.baseFeeWei <= 0n) {
    return {
      ok: false,
      failure: "not-measurable",
      detail: "a basefee of zero gives no bound; the cap would be unenforceable",
    };
  }

  const ceiling = input.baseFeeWei * BigInt(input.maxMultiple);
  if (input.gasPriceWei > ceiling) {
    return {
      ok: false,
      failure: "draining",
      detail:
        `gas price ${input.gasPriceWei} exceeds ${input.maxMultiple}x basefee (${ceiling}). ` +
        "A keeper controls its own gas price, so an uncapped refund at that price is a " +
        "channel for draining the contract that funds it",
    };
  }

  return { ok: true, detail: `gas price is within ${input.maxMultiple}x basefee` };
}
