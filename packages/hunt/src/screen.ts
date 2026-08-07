/**
 * RUG / HONEYPOT SCREENING. The checks that decide whether a token is SAFE to touch at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE MEASUREMENT THIS FILE EXISTS FOR: 84 OF 100 LIVE TOKENS CANNOT BE SOLD ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * RESEARCH-STRATEGY.md §1. For each of the newest 100 tokens on the pad we quoted a $5 buy through
 * the v4 quoter, then quoted a sell of EXACTLY the tokens the buy returned:
 *
 *   N = 100    buy-quote failures = 0    SELL-QUOTE FAILURES = 84    sellable = 16
 *
 * **Every token quotes a BUY. 84 of them cannot be quoted for a SELL.** The shipped strategy
 * checked only `quotedOut` — the buy side — so it would have bought all 84 and discovered the
 * problem while holding.
 *
 * A position you cannot exit is not a position; it is a donation. This is the highest-value check
 * available to us, it costs one extra `eth_call`, and it did not previously exist.
 *
 * ══ WHY THIS IS NOT CALLED "HONEYPOT DETECTION", AND WHY THE DISTINCTION IS LOAD-BEARING ══
 *
 * The first reading of "84%" was "84% of the pad is a honeypot". That was WRONG, and the correction
 * is recorded here rather than quietly applied because a plausible-looking false number is exactly
 * the failure RESEARCH.md §7b names as the enemy.
 *
 * The quoter wraps inner reverts in `UnexpectedRevertBytes(bytes)` (0x6190b2b0). Unwrapping gives
 * exactly TWO inner selectors across all 84 failures:
 *
 *   0x90bfb865   hook-level refusal        46 tokens — ALL 46 HAVE ZERO TRADES
 *   0x7a5ed734   NotEnoughLiquidity        38 tokens — 1..24 trades, a real DEPTH refusal
 *
 * The first bucket is perfectly correlated with never having traded (46/46): it is an un-warmed
 * pool, not malice. The second is genuine thinness.
 *
 * **The action is identical either way, which is why this module keys on the OUTCOME, not the
 * cause: if the sell leg does not quote, we do not buy.** We do not need to know whether a door is
 * locked maliciously or merely stuck to know we should not walk through it. The selector is carried
 * into the reason string so `/logs` can still show which one fired.
 *
 * ══ WHY A SIMULATION AND NOT A STATIC RULE ══
 *
 * The published tooling agrees the simulate-buy-then-sell round trip is the core technique:
 * honeypot.is "attempts to simulate buying and selling against detected liquidity pairs" and derives
 * `buyTax`/`sellTax` from the delta between expected and actual output
 * (https://docs.honeypot.is/ishoneypot). GoPlus takes the complementary STATIC route and returns raw
 * flags — `is_honeypot`, `cannot_sell_all`, `slippage_modifiable` — with no thresholds attached
 * (https://docs.gopluslabs.io/reference/response-details).
 *
 * The honest limitation, recorded because simulation cannot see it: a contract whose tax is
 * UPDATABLE can pass a simulation now and trap later. Check Point documented the M3 token deployed
 * with a benign `_setTaxFee` that was changed to 99 AFTER scanners reviewed it
 * (https://research.checkpoint.com/2022/scammers-are-creating-new-fraudulent-crypto-tokens-and-misconfiguring-smart-contracts-to-steal-funds/).
 * On this pad the tax is charged by ONE shared hook contract, identical for every token
 * (RESEARCH.md §1b), so per-token tax mutation is not the reachable attack it is on a general EVM
 * chain. That is a structural argument, not a proof — the hook itself is UNVERIFIED on Blockscout
 * (RESEARCH.md §1b) and this risk is bounded by position size only.
 */

/**
 * The result of quoting a SELL of exactly what a buy returned.
 *
 * Supplied by the caller (the indexer owns the network; this package stays pure). `ok: false`
 * carries the revert selector so the log can distinguish a thin pool from a hook refusal.
 */
export type SellSimulation =
  | {
      readonly ok: true;
      /** Wei of ETH the quoter says selling the whole position back returns. */
      readonly proceedsWei: bigint;
    }
  | {
      readonly ok: false;
      /**
       * The INNER revert selector, unwrapped from `UnexpectedRevertBytes`. Measured values:
       * `0x7a5ed734` = NotEnoughLiquidity, `0x90bfb865` = hook refusal on an unwarmed pool.
       * `null` when the call failed without a decodable selector (RPC error, timeout).
       */
      readonly selector: string | null;
    };

/**
 * Measured inner revert selectors, for log lines that explain rather than assert.
 *
 * Exported so a test can pin them and so `/logs` can render "thin pool" instead of a hex string.
 */
export const SELL_REVERT_NOT_ENOUGH_LIQUIDITY = "0x7a5ed734";
export const SELL_REVERT_HOOK_REFUSAL = "0x90bfb865";

/** Human-readable cause for a measured selector. Unknown selectors are reported verbatim. */
export function explainSellRevert(selector: string | null): string {
  if (selector === SELL_REVERT_NOT_ENOUGH_LIQUIDITY) {
    return "NotEnoughLiquidity — the pool cannot absorb an exit of this size (38/100 measured)";
  }
  if (selector === SELL_REVERT_HOOK_REFUSAL) {
    return "hook refused the sell — measured on 46/100 tokens, ALL of which had zero trades ever";
  }
  return selector === null
    ? "the sell quote failed with no decodable revert selector (RPC error, or an unknown cause)"
    : `the sell quote reverted with an unrecognised selector ${selector}`;
}

/**
 * Holder-distribution facts from `GET /api/tokens/{addr}/holders`.
 *
 * RESEARCH-STRATEGY §4. This endpoint was undocumented in RESEARCH.md and exposes precisely the
 * fields the rug literature says matter — including `snipers`, which is bundle detection the pad
 * computes for us and which we could not compute ourselves.
 */
export type HolderDistribution = {
  /** Top-10 holder concentration in percent, EXCLUDING the pool contract. */
  readonly top10Pct: number;
  /** The creator's remaining holding, in percent. */
  readonly creatorPct: number;
  /** Whether the creator has already sold. Measured true on 34/100. */
  readonly creatorSold: boolean;
  /** Wallets the pad identified as snipers/bundlers. */
  readonly sniperCount: number;
  /**
   * Percent of supply still held by those sniper wallets.
   *
   * THE IMPORTANT ONE. The strongest empirical finding on concentration is that naive top-10
   * understates risk because bundled wallets hide behind it — resolving bundles raises measured
   * top-10 concentration by a median 24 POINTS for high-risk tokens vs 6 for low-risk
   * (MemeTrans, arXiv:2602.13480, 41,470 migrated memecoins). We cannot cluster wallets ourselves;
   * the pad publishes the answer.
   */
  readonly sniperHeldPct: number;
};

/**
 * Concentration ceilings.
 *
 * ══ THESE ARE SET OUTSIDE THE MEASURED RANGE, ON PURPOSE, AND THAT IS A LIMITATION ══
 *
 * Measured across the newest 100 tokens (RESEARCH-STRATEGY §4):
 *
 *   top10Pct       max 23.92%   (median where non-zero: 6.45%)
 *   sniperHeldPct  max  8.82%
 *   creatorPct     max  3.36%
 *
 * The thresholds below sit ABOVE every observed value. On today's sample they therefore refuse
 * NOTHING, and calling them active rug filters would be a lie. They are insurance against a
 * distribution shift, and concentration still influences RANKING through `score.ts` below the
 * refusal line — which is where it does real work today.
 *
 * The alternative — tightening them until they bind on 100 observations — is fitting thresholds to
 * a sample that small, which is exactly what `@taia/backtest`'s MinBTL guard exists to make loud.
 *
 * The retail thresholds one finds published ("top-10 >25% dangerous", "dev >5% red flag") are NOT
 * empirically validated: live RugCheck queries returned an EMPTY risks[] array for a token at 56.5%
 * top-10 with a 34.8% single holder, and GoPlus deliberately returns raw values with no cutoffs at
 * all (https://docs.gopluslabs.io/reference/response-details). Importing those numbers would be
 * borrowing false precision.
 */
export type ScreenConfig = {
  /** Refuse above this top-10 concentration, in percent. Measured max on this pad: 23.92. */
  readonly maxTop10Pct: number;
  /** Refuse above this sniper/bundle holding, in percent. Measured max: 8.82. */
  readonly maxSniperHeldPct: number;
  /** Refuse above this creator holding, in percent. Measured max: 3.36. */
  readonly maxCreatorPct: number;
};

export const DEFAULT_SCREEN: ScreenConfig = {
  maxTop10Pct: 35,
  maxSniperHeldPct: 15,
  maxCreatorPct: 10,
};

export type ScreenVerdict =
  | { readonly safe: true; readonly proceedsWei: bigint; readonly notes: string }
  | { readonly safe: false; readonly reason: string };

/**
 * May we touch this token at all?
 *
 * PURE — the caller performs the network I/O and passes the results in, so every branch is testable
 * without a chain. Ordered with the SELL SIMULATION FIRST because it is the most decisive check we
 * have: it refused 84% of the pad in measurement, and no amount of good concentration data makes an
 * unsellable token tradeable.
 */
export function screenToken(args: {
  readonly address: string;
  readonly sell: SellSimulation;
  readonly holders: HolderDistribution;
  readonly cfg: ScreenConfig;
}): ScreenVerdict {
  const { address, sell, holders, cfg } = args;

  /* ══ 1. CAN WE ACTUALLY SELL IT? ══
   *
   * Nothing below matters if this fails. A token that cannot be exited is not an investment with
   * bad odds; it is a transfer to whoever wrote the contract.
   */
  if (!sell.ok) {
    return {
      safe: false,
      reason:
        `refused ${address}: SELL SIMULATION FAILED — ${explainSellRevert(sell.selector)}. ` +
        "We quote a sell of exactly what the buy returns BEFORE buying, because 84 of the newest " +
        "100 tokens on this pad quote a buy fine and cannot be sold at all. A position that " +
        "cannot be exited is a donation",
    };
  }
  if (sell.proceedsWei <= 0n) {
    return {
      safe: false,
      reason:
        `refused ${address}: the sell quote succeeded but returns ${sell.proceedsWei.toString()} ` +
        "wei. A sell that yields nothing is a honeypot that reverts politely",
    };
  }

  /* ══ 2. CONCENTRATION ══
   *
   * Sniper/bundle holdings are checked BEFORE top-10, because top-10 is the figure that bundling
   * is known to hide behind (MemeTrans: a median 24-point understatement on high-risk tokens).
   * Checking the weaker signal first would let a bundled token pass on a flattering top-10.
   */
  if (!Number.isFinite(holders.sniperHeldPct) || holders.sniperHeldPct < 0) {
    return {
      safe: false,
      reason:
        `refused ${address}: sniperHeldPct is ${String(holders.sniperHeldPct)} — a failed read of ` +
        "an unofficial API (RESEARCH.md §5), not a measurement of zero concentration",
    };
  }
  if (holders.sniperHeldPct > cfg.maxSniperHeldPct) {
    return {
      safe: false,
      reason:
        `refused ${address}: sniper/bundle wallets hold ${holders.sniperHeldPct.toFixed(2)}% > ` +
        `${String(cfg.maxSniperHeldPct)}% ceiling (${String(holders.sniperCount)} wallets). ` +
        "Bundled supply is the concentration that naive top-10 hides — resolving bundles raises " +
        "measured top-10 by a median 24 points on high-risk tokens (arXiv:2602.13480)",
    };
  }

  if (!Number.isFinite(holders.top10Pct) || holders.top10Pct < 0) {
    return {
      safe: false,
      reason: `refused ${address}: top10Pct is ${String(holders.top10Pct)} — a failed API read`,
    };
  }
  if (holders.top10Pct > cfg.maxTop10Pct) {
    return {
      safe: false,
      reason:
        `refused ${address}: top-10 holders hold ${holders.top10Pct.toFixed(2)}% > ` +
        `${String(cfg.maxTop10Pct)}% ceiling. Measured max across the newest 100 on this pad was ` +
        "23.92%, so this token is outside the observed distribution entirely",
    };
  }

  if (!Number.isFinite(holders.creatorPct) || holders.creatorPct < 0) {
    return {
      safe: false,
      reason: `refused ${address}: creatorPct is ${String(holders.creatorPct)} — a failed API read`,
    };
  }
  if (holders.creatorPct > cfg.maxCreatorPct) {
    return {
      safe: false,
      reason:
        `refused ${address}: the creator still holds ${holders.creatorPct.toFixed(2)}% > ` +
        `${String(cfg.maxCreatorPct)}% ceiling. Measured max on this pad was 3.36%. A dev holding ` +
        "this much is the supply that dumps on us",
    };
  }

  return {
    safe: true,
    proceedsWei: sell.proceedsWei,
    notes:
      `sell simulation PASSED (${sell.proceedsWei.toString()} wei back), top10 ` +
      `${holders.top10Pct.toFixed(2)}%, snipers ${String(holders.sniperCount)} holding ` +
      `${holders.sniperHeldPct.toFixed(2)}%, creator ${holders.creatorPct.toFixed(2)}%` +
      (holders.creatorSold ? " (already sold)" : ""),
  };
}

/**
 * Round-trip loss implied by the sell simulation, in bps of the position.
 *
 * This is the ONLY cost figure on the money path derived from the actual chain rather than from a
 * model: buy `positionWei`, the quoter says selling it all back returns `proceedsWei`, so the
 * difference is what the round trip really costs INCLUDING tax, impact and pool state.
 *
 * `cost.ts` models this as `2 x tax + gas` and the live quotes reproduce that to within ~35bps at
 * every tier (RESEARCH-STRATEGY §6). Keeping both and comparing them is deliberate: if the model
 * and the chain ever diverge, that divergence is itself the signal that something about the pool
 * has changed, and `decide` refuses the trade rather than trusting the cheaper number.
 */
export function simulatedRoundTripBps(args: {
  readonly positionWei: bigint;
  readonly proceedsWei: bigint;
}): bigint {
  if (args.positionWei <= 0n) {
    throw new Error(
      "refusing to express a simulated round trip against a non-positive position — it divides " +
        "by zero, and a cost of Infinity bps would refuse every trade for the wrong reason",
    );
  }
  return ((args.positionWei - args.proceedsWei) * 10_000n) / args.positionWei;
}
