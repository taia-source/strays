/**
 * THE HARD FILTER. Which letscash tokens a stray is permitted to hunt at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ RULE 1 IS THE PRODUCT (RESEARCH.md §3c, DESIGN.md §6) ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * **A stray may hunt `taxPct === 1` tokens and nothing else.** This is not a tuning preference;
 * it is the difference between a strategy that can win and one that provably cannot. From the
 * measured round trips in RESEARCH §3b, the move a position needs merely to BREAK EVEN:
 *
 *    1% tax  ->   231.4 bps round trip  ->  needs  +2.32%   <- the only tier we take
 *    3% tax  ->   624.2 bps             ->  needs  +6.24%
 *    5% tax  ->  1007.6 bps             ->  needs +10.08%
 *   10% tax  ->  1938.3 bps             ->  needs +19.38%
 *
 * Against a measured mean absolute 24h move of 7.7% across live launches, a 10%-tax token must
 * post a 2.5-sigma-scale move just to return the capital. RESEARCH §0 states it in one line: this
 * single filter "is the difference between a product and a money incinerator".
 *
 * It costs us nothing in opportunity. RESEARCH §3e measured the tier distribution across the
 * newest 48 launches: 1% = 33%, 3% = 13%, 5% = 23%, 10% = 31%. **~33% of the pad is huntable**,
 * which against 3,063 launched tokens is ~1,000 candidates and growing. Refusing two thirds of
 * the pad is affordable precisely because the pad is large.
 *
 * The comparison is `=== 1`, strictly, not `<= 1`. A `taxPct` of 0 is not a better deal, it is a
 * failed read: every launch on this pad carries a tax, the hook is the fee engine, and a zero
 * would mean `/api/tokens/{addr}` returned a missing field coerced to a number. RESEARCH §5 says
 * to treat the API as unofficial and unstable, so a suspicious value is refused rather than
 * treated as the most attractive token on the venue.
 *
 * ══ WHY THE OTHER FILTERS ARE FLOORS, NOT SCORES ══
 *
 * Everything below returns a REASON string, and the reason goes in `/logs` (DESIGN §8: the logs
 * page is "load-bearing, not a nicety" and must show why a decision went the way it did). A
 * refusal with no reason beside it is an assertion; "refused: tax 10% (231bps at 1%, 1938bps
 * here)" is a finding somebody can check.
 *
 * The floors are deliberately few. Each one below traces to a measurement or to a recorded
 * failure; there is no "quality score" here, because a weighted score of unmeasured factors is a
 * curve fit wearing a filter's clothes, and `@taia/backtest`'s MinBTL guard exists to make that
 * mistake loud.
 */

/** What `/api/tokens/{addr}` gives us, narrowed to the fields the filter actually reads. */
export type TokenSnapshot = {
  /** The token address. Never resolve by symbol — RESEARCH §1b found verified CASHCAT impostors. */
  readonly address: string;
  /** Integer percent, exactly as the pad reports it: 1, 3, 5 or 10. */
  readonly taxPct: number;
  /** Pool liquidity / market cap in wei of ETH, from `marketCapEth`. */
  readonly marketCapWei: bigint;
  /** Distinct holder count, from `holders`. */
  readonly holders: number;
  /** All-time traded volume in wei of ETH, from `volumeEth.allTime`. */
  readonly volumeAllTimeWei: bigint;
  /** Seconds since launch. Supplied by the caller from a clock — this module reads no clock. */
  readonly ageSeconds: number;
  /** v4 tick spacing. Varies per launch and must be read per token — RESEARCH §2. */
  readonly tickSpacing: number;
};

export type EligibilityConfig = {
  /**
   * The ONLY permitted tax tier. Configurable so a test can prove that changing it changes the
   * outcome, NOT so an operator can raise it — `assertHuntableTax` refuses anything but 1 and is
   * called on every config.
   */
  readonly requiredTaxPct: number;

  /**
   * Minimum market cap, in wei of ETH.
   *
   * DERIVATION: the position is $5 (DESIGN §2) ~= 0.0026 ETH at the measured ETH price of
   * $1927.27. RESEARCH §3b measured swap cost as `2 x tax` to within 1 bps at $5, i.e. price
   * impact was BELOW MEASUREMENT RESOLUTION — but that was measured against live pools, and the
   * property is a statement about the ratio of position to depth, not about $5 in the abstract.
   *
   * 1 ETH (~$1927) is ~385x a $5 position. At that ratio a $5 trade is ~0.26% of the pool, which
   * is the regime the negligible-impact measurement was actually taken in. Below it the whole
   * cost model — which carries NO impact term precisely because impact was unmeasurable — starts
   * describing a trade we are not making. This floor is what keeps `cost.ts` honest, and it is
   * set at the edge of where cost.ts was verified rather than at a round number that sounded safe.
   */
  readonly minMarketCapWei: bigint;

  /**
   * Minimum distinct holders.
   *
   * DERIVATION: a token whose entire holder set is its deployer has no counterparty, so its
   * "price" is one address's mark and any move in it is that address moving it. 25 is the floor
   * at which a price is at least a plural opinion. It is a LIVENESS floor, not a quality signal —
   * it does not claim 25 holders are good, only that fewer than 25 means the price series the
   * signal reads is not a market's.
   *
   * This is the one threshold here with no direct measurement behind it, and it is labelled as
   * such rather than dressed up. It is set low on purpose: a high holder floor would be a
   * popularity filter, and RESEARCH offers no evidence that popularity predicts return.
   */
  readonly minHolders: number;

  /**
   * Minimum all-time volume, in wei of ETH.
   *
   * DERIVATION: RESEARCH §3d measured that only 29 of the newest 48 launches had a NON-ZERO 24h
   * move — 40% of the pad does not trade at all. A momentum signal on a series that never printed
   * a trade reads a flat line and correctly finds nothing, so this floor exists to stop us
   * spending RPC and LLM budget on tokens that structurally cannot produce a signal. Set at
   * 10x the position (0.026 ETH): a pool that has not traded ten times our own size cannot have
   * produced a price series worth reading.
   */
  readonly minVolumeAllTimeWei: bigint;

  /**
   * Minimum age in seconds.
   *
   * DERIVATION: the signal needs a price history to measure a move over (see `signal.ts`, whose
   * horizon is 60 minutes). A token younger than the signal horizon cannot supply one, so
   * entering it means entering on no signal at all. 3600s = the signal horizon exactly. Tying
   * this to the horizon rather than picking a "feels new enough" number means that if the horizon
   * ever changes, this floor is wrong in a way a test will catch — `eligible.test.ts` asserts the
   * two agree.
   */
  readonly minAgeSeconds: number;

  /**
   * Maximum age in seconds.
   *
   * DERIVATION: RESEARCH §3d measures the pad's move distribution over 24h on the NEWEST 48
   * launches, and §3e measures the tax mix on the same newest-48 window. Every economic figure we
   * have is therefore a statement about recent launches. 7 days (604800s) is the boundary past
   * which we would be extrapolating our own measurements onto a population we never sampled.
   * A stale token is not refused because it is bad; it is refused because we have no measurement
   * that covers it, which is a different and more honest reason.
   */
  readonly maxAgeSeconds: number;
};

/**
 * The shipped configuration. Each number is derived in the field doc above it.
 *
 * ETH = $1927.27 and the position is $5 (RESEARCH header, DESIGN §2), so $5 ~= 0.0025943 ETH.
 * The wei figures below are stated against that.
 */
export const DEFAULT_ELIGIBILITY: EligibilityConfig = {
  requiredTaxPct: 1,
  // 1 ETH — ~385x a $5 position, the depth regime the negligible-impact measurement holds in.
  minMarketCapWei: 1_000_000_000_000_000_000n,
  minHolders: 25,
  // 0.026 ETH — 10x the $5 position.
  minVolumeAllTimeWei: 26_000_000_000_000_000n,
  // 3600s — exactly `signal.ts`'s LOOKBACK_MINUTES. Asserted equal by test.
  minAgeSeconds: 3600,
  // 604800s — 7 days, the edge of the newest-48 window every measurement was taken in.
  maxAgeSeconds: 604_800,
};

/**
 * The only tax tier a stray may hunt. RESEARCH §3c Rule 1.
 *
 * Exported as a constant rather than left implicit in the config so that a config which tries to
 * raise it is refused by `assertHuntableTax` below, and so that a test can point at the number
 * the rule is about.
 */
export const HUNTABLE_TAX_PCT = 1;

export type Eligibility = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Refuse a config that permits any tax tier but 1%.
 *
 * `requiredTaxPct` is configurable so a test can demonstrate the filter binds, but a config is not
 * a place to overrule arithmetic. openhood's `AUTOMATIC_EXECUTION_WIRED = true` (RESEARCH §7g)
 * is the failure this guards against in miniature: a setting whose value contradicts what the
 * system actually may do. Called from `isEligible`, so there is no path that skips it.
 */
export function assertHuntableTax(cfg: EligibilityConfig): void {
  if (cfg.requiredTaxPct !== HUNTABLE_TAX_PCT) {
    throw new Error(
      `refusing an eligibility config with requiredTaxPct=${String(cfg.requiredTaxPct)}. ` +
        `Only ${String(HUNTABLE_TAX_PCT)}% is huntable: measured round trips are 231.4bps at 1% ` +
        "and 1938.3bps at 10%, so a 10%-tax position needs a +19.38% move to break even against " +
        "a measured mean absolute 24h move of 7.7%. This is arithmetic, not configuration",
    );
  }
}

/**
 * Is this token huntable? Returns a REASON on refusal, and the reason goes in the log.
 *
 * PURE: no clock, no network. `ageSeconds` arrives as data so the caller owns the clock — the same
 * property `decide` has, and for the same reason (a function that reads a clock cannot be tested
 * deterministically, and an untestable filter on the money path is not a filter).
 *
 * Checks are ordered cheapest-and-most-decisive first. The tax check runs before everything
 * because it refuses two thirds of the pad on one integer comparison.
 */
export function isEligible(token: TokenSnapshot, cfg: EligibilityConfig): Eligibility {
  assertHuntableTax(cfg);

  /*
   * ══ RULE 1. THE FILTER THE PRODUCT IS BUILT ON ══
   *
   * Strict equality. `<= cfg.requiredTaxPct` would admit taxPct 0, which is a failed API read
   * rather than a free lunch — every pool on this pad routes through the hook that charges the
   * tax, so 0 cannot be real. RESEARCH §5: treat the API as unofficial and unstable.
   */
  if (!Number.isInteger(token.taxPct)) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: taxPct is ${String(token.taxPct)}, not an integer percent. ` +
        "The pad reports 1, 3, 5 or 10; anything else is a failed read of an unofficial API",
    };
  }
  if (token.taxPct !== cfg.requiredTaxPct) {
    const breakevenBps = 2 * token.taxPct * 100 + 32;
    return {
      ok: false,
      reason:
        `refused ${token.address}: taxPct ${String(token.taxPct)}% != ${String(cfg.requiredTaxPct)}%. ` +
        `Round trip is ~${String(breakevenBps)}bps here vs 231bps at 1%, so this position needs ` +
        `a +${(breakevenBps / 100).toFixed(2)}% move merely to break even against a measured mean ` +
        "absolute 24h move of 7.7% (RESEARCH §3b/§3c Rule 1)",
    };
  }

  if (token.marketCapWei < cfg.minMarketCapWei) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: marketCap ${token.marketCapWei.toString()} wei < floor ` +
        `${cfg.minMarketCapWei.toString()} wei. Below this depth the cost model's omission of a ` +
        "price-impact term stops being justified — impact was unmeasurable at $5 against live " +
        "pools, and that is a statement about position-to-depth ratio, not about $5 (RESEARCH §3b)",
    };
  }

  if (!Number.isInteger(token.holders) || token.holders < cfg.minHolders) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: ${String(token.holders)} holders < floor ` +
        `${String(cfg.minHolders)}. Below this a price is one address's mark rather than a ` +
        "market's, so any move the signal reads is that address moving it",
    };
  }

  if (token.volumeAllTimeWei < cfg.minVolumeAllTimeWei) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: all-time volume ${token.volumeAllTimeWei.toString()} wei < ` +
        `floor ${cfg.minVolumeAllTimeWei.toString()} wei (10x our position). RESEARCH §3d ` +
        "measured that only 29 of the newest 48 launches moved at all; a pool that has not " +
        "traded ten times our own size cannot have produced a price series worth reading",
    };
  }

  if (!Number.isFinite(token.ageSeconds) || token.ageSeconds < 0) {
    return {
      ok: false,
      reason: `refused ${token.address}: ageSeconds is ${String(token.ageSeconds)} — not a real age`,
    };
  }
  if (token.ageSeconds < cfg.minAgeSeconds) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: age ${String(token.ageSeconds)}s < ${String(cfg.minAgeSeconds)}s. ` +
        "A token younger than the signal horizon cannot supply the price history the signal " +
        "measures a move over, so entering it would be entering on no signal at all",
    };
  }
  if (token.ageSeconds > cfg.maxAgeSeconds) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: age ${String(token.ageSeconds)}s > ${String(cfg.maxAgeSeconds)}s. ` +
        "Every economic figure we hold — the move distribution (§3d) and the tax mix (§3e) — was " +
        "measured on the newest 48 launches. Past this we would be extrapolating onto a " +
        "population we never sampled",
    };
  }

  /*
   * `tickSpacing` is not a quality filter — it is a correctness precondition. RESEARCH §2 proved
   * the PoolKey reconstruction and recorded that tickSpacing "varies per launch config and MUST
   * be read per token. It is not a constant." A missing or zero value means we cannot build the
   * PoolKey, so we cannot address the pool, so there is nothing to trade even if we wanted to.
   */
  if (!Number.isInteger(token.tickSpacing) || token.tickSpacing <= 0) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: tickSpacing is ${String(token.tickSpacing)}. It varies per ` +
        "launch and must be read per token (RESEARCH §2); without it the v4 PoolKey cannot be " +
        "reconstructed, so the pool cannot be addressed at all",
    };
  }

  return { ok: true };
}
