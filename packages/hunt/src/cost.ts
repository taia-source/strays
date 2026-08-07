/**
 * The measured cost of a round trip on letscash.fun, in wei and in basis points.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE MEASUREMENT THIS MODULE IS BUILT FROM (RESEARCH.md §3b) ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `probe/rt5.mjs`, against an anvil fork of mainnet 4663 at block 30,255,810: buy $5 of the token
 * with native ETH through the UniversalRouter, then sell EXACTLY the tokens the buy returned.
 * Gas UNITS come from the fork; the gas PRICE is read from mainnet (see §7a and the required
 * parameter below). Four live pools, one per tax tier, all at $5:
 *
 *   Token      Tax    swap cost (tax x2 + impact)   gas       TOTAL round trip
 *   CatDay      1%      199.0 bps                   32.5 bps    231.4 bps
 *   BTC65000    3%      591.0 bps                   33.2 bps    624.2 bps
 *   BOWMAN      5%      975.0 bps                   32.6 bps   1007.6 bps
 *   fomocat    10%     1900.0 bps                   38.3 bps   1938.3 bps
 *
 * Two findings drive every line of this file:
 *
 *  1. **Measured swap cost is `2 x tax` to within 1 bps at every tier.** Price impact at $5 is
 *     therefore negligible and TAX IS ESSENTIALLY THE ENTIRE COST. This module models the swap
 *     leg as exactly `2 x taxPct` and says so, rather than carrying an impact term it cannot
 *     measure. Note the honest boundary: that holds AT $5. It is not asserted at $500.
 *
 *  2. **There is NO pool fee.** RESEARCH §2 proved the PoolKey has `fee = 0` — the hook takes the
 *     entire tax and the pool charges no LP fee whatsoever. openhood's cost model carried a
 *     5bps/30bps/100bps pool-fee term; **that term is zero here** and is deliberately absent.
 *     Copying it across would over-state cost and under-trade.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHY `gasPriceWei` IS REQUIRED AND HAS NO DEFAULT (RESEARCH.md §7a) ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * openhood hardcoded a gas price measured on an ANVIL FORK and concluded a round trip cost 52.5%
 * of a position — which made every trade impossible and would have shipped a strategy that could
 * only ever decline.
 *
 *   anvil default base fee   ~1.019 gwei
 *   chain 4663               ~0.0295 gwei      -> ~35x less
 *
 * **Gas UNITS transfer from a fork; gas PRICES do not.** So there is no gas price constant
 * anywhere in this file, `gasPriceWei` is a required argument, and a caller that omits it or
 * passes zero is REFUSED rather than quietly defaulted. A default here would be indistinguishable
 * at the call site from a real chain read, which is exactly how openhood's error survived review.
 *
 * A zero gas price is refused too, not merely a missing one: on this chain gas is never free, so a
 * zero is a failed read (`eth_gasPrice` returning null, an unset env var coerced to 0) wearing the
 * clothes of a measurement. Accepting it produces a plausible-looking cost that is ~32 bps too
 * low — the "silent wrongness" failure mode RESEARCH §7b records.
 *
 * ══ WHAT DOES *NOT* CARRY OVER FROM openhood, AND WHY ══
 *
 * openhood's cost was **U-shaped** in size ($1 -> 166bps, $50 -> 18bps minimum, $1000 -> 82bps)
 * because gas dominated there. Here gas is a flat ~$0.016, which is 0.3% of a $5 position and
 * ~32 bps of it. Cost is essentially FLAT in bps from $5 to $50 because tax is proportional.
 * RESEARCH §3c Rule 2: **position size does not change the bar.** Any sizing logic built on
 * openhood's U-curve is an artifact of a different chain-cost regime and is not ported.
 */

/**
 * Gas UNITS for each leg, MEASURED on the fork run recorded in RESEARCH.md §4b:
 *
 *   BUY  0.0026 ETH -> 1298451422972480224401102 units   gas 148750
 *   SELL 1298451422972480224401102 units                 gas 136349   status success
 *
 * Units, not wei, because the price of gas moves and the units do not. Multiplied by a gas price
 * read from the chain at decision time.
 */
export const GAS_BUY_UNITS = 148_750n;
export const GAS_SELL_UNITS = 136_349n;

/**
 * The two one-time Permit2 approvals the SELL leg needs (RESEARCH §4e).
 *
 * Buying spends native ETH: no approval, one transaction. Selling spends an ERC-20 pulled through
 * Permit2, which needs token->Permit2 then Permit2->router first. Measured on 4663 by openhood at
 * 63,877 + 47,794 gas. They are one-time per (token, spender) pair, so they are a FLAG rather than
 * an unconditional term — charging a position for approvals it will not pay is as dishonest as
 * omitting ones it will. At $0.016 per round trip these are immaterial in bps, but they must be
 * SENT or the sell reverts, so they are modelled rather than waved away.
 */
export const GAS_ERC20_APPROVE_UNITS = 63_877n;
export const GAS_PERMIT2_APPROVE_UNITS = 47_794n;

/**
 * The tax is paid on BOTH legs. RESEARCH §3b measured total swap cost at `2 x tax` to within
 * 1 bps at all four tiers, so this factor is the measurement, not an assumption about the hook.
 */
const TAX_LEGS = 2n;

/** Basis points in 100%. */
const BPS_DENOMINATOR = 10_000n;

/** Percent -> basis points. `taxPct` arrives as the API's integer percent (1, 3, 5, 10). */
const BPS_PER_PERCENT = 100n;

export type RoundTripCost = {
  /** Tax paid on the buy leg, in wei. */
  readonly entryTaxWei: bigint;
  /** Tax paid on the sell leg, in wei. */
  readonly exitTaxWei: bigint;
  /** Gas for the buy, in wei. */
  readonly entryGasWei: bigint;
  /** Gas for the sell INCLUDING any approvals it must pay for, in wei. */
  readonly exitGasWei: bigint;
  /** Everything above. The number an expected gain must clear a multiple of. */
  readonly totalWei: bigint;
  /** `totalWei` as a fraction of the position, in basis points. */
  readonly totalBps: bigint;
  /** The gas units actually charged, so a log line can show the arithmetic. */
  readonly gasUnits: bigint;
  /** The arithmetic, rendered. Logged on declines as well as fires. */
  readonly arithmetic: string;
};

export type RoundTripCostArgs = {
  /** The ETH size of the position, in wei. */
  readonly positionWei: bigint;
  /** The token's tax tier as an integer percent, exactly as `/api/tokens/{addr}` reports it. */
  readonly taxPct: number;
  /**
   * READ FROM THE CHAIN AT DECISION TIME. Required, no default, zero refused. See the header —
   * this parameter is the entire reason this module exists in the shape it does.
   */
  readonly gasPriceWei: bigint;
  /**
   * Total gas units for the round trip. Defaults to the MEASURED buy + sell from RESEARCH §4b.
   *
   * Defaultable where the gas PRICE is not, and the asymmetry is the point: units were measured
   * on our own fork and transfer across chains, prices do not.
   */
  readonly gasUnits?: bigint;
  /** Whether the exit must also pay for the two one-time Permit2 approvals. */
  readonly approvalsNeeded?: boolean;
};

/**
 * The full cost of opening AND closing a position of `positionWei` in a token taxed `taxPct`.
 *
 * Both legs, always. A cost model that charges only the entry is the most common way a trading
 * report flatters itself; `cost.test.ts` sabotages exactly that omission.
 */
export function roundTripCost(args: RoundTripCostArgs): RoundTripCost {
  if (args.positionWei <= 0n) {
    throw new Error(
      `refusing to cost a position of ${args.positionWei.toString()} wei — a cost model that ` +
        "accepts a non-positive notional divides by zero when it computes a bps figure",
    );
  }

  /*
   * ══ THE CHECK RESEARCH §7a EXISTS TO FORCE ══
   *
   * Not `?? DEFAULT`, not `|| SOME_GWEI`. A throw. openhood's fork-measured constant produced a
   * 52.5%-of-position round trip that no trade could ever clear, and the number LOOKED like a
   * measurement because it was one — just of the wrong chain. The only defence that survives a
   * careless call site is refusing to produce an answer at all.
   */
  if (!Number.isFinite(Number(args.gasPriceWei)) || args.gasPriceWei <= 0n) {
    throw new Error(
      `refusing to cost a trade at a gas price of ${args.gasPriceWei.toString()} wei. ` +
        "gasPriceWei is REQUIRED and must be read from the chain at decision time — it has no " +
        "default and zero is not a valid reading. openhood hardcoded a fork-measured gas price " +
        "(anvil ~1.019 gwei vs chain 4663 ~0.0295 gwei, ~35x) and concluded a round trip cost " +
        "52.5% of a position, which would have shipped a strategy that could only decline. " +
        "Gas UNITS transfer from a fork; gas PRICES do not.",
    );
  }

  if (!Number.isInteger(args.taxPct) || args.taxPct < 0) {
    throw new Error(
      `refusing to cost a trade at a tax of ${String(args.taxPct)}% — taxPct is the integer ` +
        "percent the pad reports (1, 3, 5, 10). A fractional or negative tax is a failed read",
    );
  }

  const gasUnits = args.gasUnits ?? GAS_BUY_UNITS + sellGasUnits(args.approvalsNeeded ?? false);
  if (gasUnits < 0n) {
    throw new Error("refusing to cost a trade at negative gas units");
  }

  const taxBps = BigInt(args.taxPct) * BPS_PER_PERCENT;

  // Tax on each leg, charged on the position notional. RESEARCH §3b: impact at $5 is negligible,
  // so `2 x tax` IS the measured swap cost and no impact term is invented here.
  const entryTaxWei = (args.positionWei * taxBps) / BPS_DENOMINATOR;
  // The exit tax is charged on the way out, on roughly the same notional. Using the entry notional
  // is a deliberate approximation and it errs SMALL only if the position fell — which is the
  // direction that matters least, since a fallen position is exiting on a stop, not on a bar.
  const exitTaxWei = (args.positionWei * taxBps) / BPS_DENOMINATOR;

  const buyUnits = args.gasUnits === undefined ? GAS_BUY_UNITS : gasUnits / TAX_LEGS;
  const sellUnits = gasUnits - buyUnits;
  const entryGasWei = buyUnits * args.gasPriceWei;
  const exitGasWei = sellUnits * args.gasPriceWei;

  const totalWei = entryTaxWei + exitTaxWei + entryGasWei + exitGasWei;
  const totalBps = (totalWei * BPS_DENOMINATOR) / args.positionWei;

  const swapBps = TAX_LEGS * taxBps;
  const gasBps = ((entryGasWei + exitGasWei) * BPS_DENOMINATOR) / args.positionWei;
  const arithmetic =
    `round trip on a ${args.taxPct.toString()}% tax token at ${args.positionWei.toString()} wei: ` +
    `tax ${TAX_LEGS.toString()} x ${taxBps.toString()}bps = ${swapBps.toString()}bps ` +
    `(${(entryTaxWei + exitTaxWei).toString()} wei) + gas ${gasUnits.toString()} units x ` +
    `${args.gasPriceWei.toString()} wei/gas = ${gasBps.toString()}bps ` +
    `(${(entryGasWei + exitGasWei).toString()} wei) => TOTAL ${totalBps.toString()}bps`;

  return {
    entryTaxWei,
    exitTaxWei,
    entryGasWei,
    exitGasWei,
    totalWei,
    totalBps,
    gasUnits,
    arithmetic,
  };
}

/**
 * Gas units the SELL leg will burn, with or without the one-time Permit2 approvals.
 *
 * Separated so an EXIT decision can ask "what does it cost me to get out FROM HERE" — the only
 * cost still avoidable once a position is open. The entry cost is sunk and must not appear in an
 * exit decision, though it must still appear in the P&L. Different questions, kept apart.
 */
export function sellGasUnits(approvalsNeeded: boolean): bigint {
  return approvalsNeeded
    ? GAS_ERC20_APPROVE_UNITS + GAS_PERMIT2_APPROVE_UNITS + GAS_SELL_UNITS
    : GAS_SELL_UNITS;
}

/**
 * The cost of getting OUT of a position, in wei. Exit tax plus exit gas, nothing else.
 *
 * Used by the exit path so that a stop-loss can be honest about what closing actually costs.
 * It is NOT used to gate an exit — RESEARCH/DESIGN §6 Rule 5: getting out is always allowed, so
 * this number is reported, never compared against a threshold that could block a sale.
 */
export function exitCostWei(args: {
  readonly proceedsWei: bigint;
  readonly taxPct: number;
  readonly gasPriceWei: bigint;
  readonly approvalsNeeded?: boolean;
}): bigint {
  if (args.gasPriceWei <= 0n) {
    throw new Error(
      "refusing to cost an exit at a non-positive gas price — see roundTripCost, same rule",
    );
  }
  const taxBps = BigInt(args.taxPct) * BPS_PER_PERCENT;
  const tax = (args.proceedsWei * taxBps) / BPS_DENOMINATOR;
  return tax + sellGasUnits(args.approvalsNeeded ?? false) * args.gasPriceWei;
}
