/**
 * THE HARD FILTER. Which letscash tokens are worth SPENDING A QUOTER CALL ON.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHAT CHANGED, AND WHY THE OLD RULE 1 WAS WRONG ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * This file used to hard-refuse everything but `taxPct === 1`. That rule is now GONE, and the
 * reason is arithmetic rather than preference: **a 5%-tax token that moves 30% is far more
 * profitable than a 1%-tax token that moves 2%.** Refusing by tier discards the first trade in
 * order to avoid the second, when the cost model can simply price both.
 *
 * Tax is now a COST TERM in `score.ts`, subtracted from the expected move before ranking. Each
 * tier carries its own bar, from the measured round trips (RESEARCH.md §3b, re-confirmed on LIVE
 * pools this session — RESEARCH-STRATEGY §6):
 *
 *    1% tax  ->   231 bps round trip  ->  break-even +2.31%,  bar +4.63%
 *    3% tax  ->   624 bps             ->  break-even +6.24%,  bar +12.5%
 *    5% tax  ->  1008 bps             ->  break-even +10.1%,  bar +20.2%
 *   10% tax  ->  1938 bps             ->  break-even +19.4%,  bar +38.8%
 *
 * A 10%-tax token is therefore refused **by the arithmetic** when it cannot clear +38.8%, and
 * admitted when it can. SpinningCat (10% tax) was the third most-traded token in the measured
 * sample and the old rule could not see it at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ TWO SHIPPED FLOORS WERE MEASURED TO BE BROKEN. BOTH ARE RECORDED, NOT QUIETLY FIXED. ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * **1. `minMarketCapWei = 1 ETH` refused NOTHING — 100/100 tokens passed it.** The derivation
 * ("~385x a $5 position") was sound reasoning, but the pad's SEED market cap is 1.356 ETH, so a
 * 1.0 ETH floor sits BELOW the minimum value the field can take. It read like a depth control and
 * was arithmetically incapable of being one. Now set above the seed, where it separates traded
 * from untraded: `> 1.36 ETH` was sellable 15/15, `<= 1.36 ETH` was sellable 1/85.
 *
 * **2. `minHolders = 25` admitted 1 token in 100.** The full shipped filter
 * (`tax==1 && mcap>=1 && holders>=25 && vol>=0.026`) passed exactly ONE of the newest 100 tokens.
 * That is the mechanical cause of ~0.4 trades/day.
 *
 * And it did not do the job it was credited with. The objection was that 25 holders is too LOW to
 * stop a rug — the measurement agrees, and shows the instrument is simply wrong: **CASHDOG, the
 * single token that passed, carries `top10Pct = 22%`**, the second-highest concentration in the
 * sample. The holder count admitted it; concentration was never checked at all.
 *
 * Note also that the `holders` field counts the POOL CONTRACT itself, which is why 83 of 100
 * tokens report exactly 2 (pool + factory). A "25 holders" floor asks for far more real
 * participants than the number suggests.
 *
 * So the holder floor stays, at 3, as a pure LIVENESS proxy — and the protection job moves to
 * `screen.ts`, which measures the thing itself: a sell simulation, top-10 concentration, sniper
 * /bundle holdings and creator holdings.
 *
 * ══ WHAT THIS FILE IS NOW FOR ══
 *
 * It is a CHEAP PRE-FILTER, not the safety system. Its only job is to avoid spending a quoter
 * round-trip and an API call on a token that provably cannot pass — 46% of the pad has never
 * traded at all. The decisive checks are in `screen.ts` (can we sell it?) and `score.ts` (does the
 * move clear its own tax?). Every refusal returns a REASON, and the reason goes in `/logs`
 * (DESIGN §8).
 */

import { HOOK_PRIMARY, HOOK_SECONDARY, isKnownHook } from "./hook.js";

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
  /**
   * REALISED SWAPS AGAINST THIS TOKEN'S POOL. **The entry gate is indexed by this, not by time.**
   *
   * The measured dose-response in RESULTS §10.4 is indexed by swap number, and this field is the
   * unit that measurement was taken in. It is a different question from `ageSeconds`: RESEARCH §3d
   * measured that 40% of this pad has never traded at all, so a token can be a day old and sit at
   * swap 0. Age in seconds says how long a token has EXISTED; this says how much it has been
   * TRADED, and only the second one predicted anything.
   *
   * `age.ts` holds the window and the evidence. Supplied by the caller from the indexer's swap
   * table — this package performs no I/O.
   */
  readonly swapCount: number;
  /** v4 tick spacing. Varies per launch and must be read per token — RESEARCH §2. */
  readonly tickSpacing: number;
  /**
   * THE POOL'S HOOK. One of the two in `hook.ts`, and it must be read per token.
   *
   * RESEARCH §7d: there are exactly two hooks on this pad (67 tokens on `0x75A54357…`, 44 on
   * `0xEfe66981…`) and the v1 vault hardcoded the first, so it could not address the pools of
   * LEVCAT, INTERN or Seriouscat at all. A v4 PoolKey is (currency0, currency1, fee, tickSpacing,
   * HOOKS); four fifths of a key addresses nothing.
   *
   * It sits beside `tickSpacing` because it is the same class of fact — a per-launch pool parameter
   * that looked like a constant until it was measured — and it is validated by `isEligible` against
   * the two-entry allowlist, so an unknown hook is refused before a quoter call is spent on it.
   */
  readonly hook: string;
};

export type EligibilityConfig = {
  /**
   * The HIGHEST tax tier worth evaluating at all, as an integer percent.
   *
   * NOT an exclusion of the kind this file used to carry. Tax is priced in `score.ts`; this is
   * only a sanity ceiling so a malformed API read (`taxPct: 900`) cannot reach the cost model.
   * Set at 10, the highest tier the pad actually issues (RESEARCH §3e, re-measured: the newest 100
   * split 1%=29, 3%=10, 5%=18, 10%=43).
   *
   * A token at the ceiling is still required to clear its own +38.8% bar, so admitting it costs
   * nothing — the arithmetic refuses it, and does so with a number in the log rather than a rule.
   */
  readonly maxTaxPct: number;

  /**
   * Minimum market cap, in wei of ETH.
   *
   * DERIVATION — MEASURED, and it replaces a floor that refused nothing. The pad's SEED market cap
   * is **1.356 ETH**: 84 of the newest 100 tokens sit at exactly that value, because it is what a
   * launch is initialised to before anyone buys. The old 1.0 ETH floor was therefore BELOW the
   * minimum the field can take and passed 100/100 tokens.
   *
   * Above the seed means somebody has actually bought, and it separates the pad almost perfectly:
   *
   *   marketCapEth >  1.36   ->  15/15 sellable (100%)
   *   marketCapEth <= 1.36   ->   1/85 sellable (  1%)
   *
   * Set at 1.40 ETH — clear of the seed, at the edge of where the measured sellable set begins.
   */
  readonly minMarketCapWei: bigint;

  /**
   * Minimum distinct holders. A LIVENESS proxy and nothing more.
   *
   * DERIVATION: the shipped value of 25 admitted **1 token in 100** and was the mechanical cause
   * of ~0.4 trades/day. It was also credited with rug protection it never provided — the one token
   * it admitted, CASHDOG, carries the second-highest top-10 concentration in the sample (22%).
   *
   * Two facts make a high holder floor wrong on this pad specifically. The field COUNTS THE POOL
   * CONTRACT, so 83 of 100 tokens report exactly 2 (pool + factory) and "25" means far more real
   * participants than it sounds like. And RESEARCH offers no evidence that popularity predicts
   * return, so a high floor is a popularity filter wearing a safety label.
   *
   * 3 is the floor at which at least one address other than the pool and the factory holds the
   * token — i.e. a price that is not purely the seed. Rug protection lives in `screen.ts`, which
   * measures concentration directly instead of inferring it from a count.
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
   *
   * There is a real tension here worth stating rather than hiding. The strongest number in the rug
   * literature is that **93% of rug pulls occur within 24 hours of pool creation** (*Do Not Rug on
   * Me*, Mazorra/Adan/Daza, Mathematics 10(6):949, 2022, 27,588 labelled tokens), which argues for
   * waiting. The pad's economics argue the opposite way, since a memecoin's move happens early.
   *
   * We resolve it structurally rather than by picking a number: letscash **locks liquidity
   * permanently at launch** (RESEARCH §1a), so the classic liquidity-withdrawal rug — the failure
   * that 24-hour statistic is dominated by — is not reachable on this venue. What remains is the
   * sell-side trap, which `screen.ts` tests directly on every candidate at every age.
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
  // The highest tier the pad issues. A sanity ceiling, not an exclusion — `score.ts` prices tax.
  maxTaxPct: 10,
  // 1.40 ETH — above the MEASURED 1.356 ETH seed. `>1.36` was sellable 15/15, `<=1.36` was 1/85.
  minMarketCapWei: 1_400_000_000_000_000_000n,
  // 3 — one holder beyond the pool and the factory. A liveness proxy; see `screen.ts` for safety.
  minHolders: 3,
  // 0.026 ETH — 10x the $5 position. Volume ~0 was sellable 0/47.
  minVolumeAllTimeWei: 26_000_000_000_000_000n,
  // 3600s — exactly `signal.ts`'s LOOKBACK_MINUTES. Asserted equal by test.
  minAgeSeconds: 3600,
  // 604800s — 7 days, the edge of the newest-48 window every measurement was taken in.
  maxAgeSeconds: 604_800,
};

/**
 * The highest tax tier the pad actually issues, as an integer percent.
 *
 * MEASURED across the newest 100 launches: 1% = 29, 3% = 10, 5% = 18, 10% = 43. Nothing above 10
 * exists, so a `taxPct` beyond this is a failed read of an unofficial API (RESEARCH §5), not a
 * token with an unusual fee.
 *
 * Note this constant replaces `HUNTABLE_TAX_PCT = 1`. It is a CEILING on what can be evaluated,
 * not a statement that only one tier may be traded — that rule is gone, and `score.ts` explains why.
 */
export const MAX_PAD_TAX_PCT = 10;

export type Eligibility = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Refuse a config whose tax ceiling is outside what the pad can issue.
 *
 * A config is not a place to overrule arithmetic — openhood's `AUTOMATIC_EXECUTION_WIRED = true`
 * (RESEARCH §7g) is the failure this guards against in miniature: a setting whose value contradicts
 * what the system actually may do.
 *
 * The check is now a CEILING rather than an equality, and the difference matters: a ceiling above
 * 10 would let a malformed `taxPct` reach `roundTripCost` and produce a plausible-looking cost for
 * a tier that does not exist. Called from `isEligible`, so no path skips it.
 */
export function assertTaxCeiling(cfg: EligibilityConfig): void {
  if (!Number.isInteger(cfg.maxTaxPct) || cfg.maxTaxPct < 1 || cfg.maxTaxPct > MAX_PAD_TAX_PCT) {
    throw new Error(
      `refusing an eligibility config with maxTaxPct=${String(cfg.maxTaxPct)}. The pad issues ` +
        `1, 3, 5 and 10 percent only (measured across the newest 100 launches), so a ceiling ` +
        `outside 1..${String(MAX_PAD_TAX_PCT)} would let a failed API read reach the cost model ` +
        "and produce a plausible cost for a tier that does not exist. Tax is PRICED in score.ts, " +
        "not excluded here — this is a sanity bound, not a trading rule",
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
  assertTaxCeiling(cfg);

  /*
   * ══ TAX IS A SANITY BOUND HERE, AND A COST TERM IN `score.ts` ══
   *
   * A zero is still refused, and for the original reason: every pool on this pad routes through
   * the hook that charges the tax, so `taxPct: 0` cannot be real — it is a missing field coerced
   * to a number. RESEARCH §5 says treat the API as unofficial and unstable, so a suspicious value
   * is refused rather than treated as the cheapest token on the venue.
   *
   * What is NO LONGER done here is refusing 3, 5 and 10. Those clear their own bars in `score.ts`
   * (+12.5%, +20.2%, +38.8% respectively) or they do not trade.
   */
  if (!Number.isInteger(token.taxPct)) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: taxPct is ${String(token.taxPct)}, not an integer percent. ` +
        "The pad reports 1, 3, 5 or 10; anything else is a failed read of an unofficial API",
    };
  }
  if (token.taxPct <= 0) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: taxPct is ${String(token.taxPct)}. Every pool on this pad routes ` +
        "through the hook that charges the tax, so a zero is a missing field coerced to a number, " +
        "not a free lunch (RESEARCH §5)",
    };
  }
  if (token.taxPct > cfg.maxTaxPct) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: taxPct ${String(token.taxPct)}% exceeds the ` +
        `${String(cfg.maxTaxPct)}% ceiling. The pad issues 1, 3, 5 and 10 only, so this is a ` +
        "failed API read rather than an expensive token — an expensive token would be priced by " +
        "score.ts and refused by its own cost bar, not by this check",
    };
  }

  if (token.marketCapWei < cfg.minMarketCapWei) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: marketCap ${token.marketCapWei.toString()} wei < floor ` +
        `${cfg.minMarketCapWei.toString()} wei. The pad's SEED market cap is 1.356 ETH and 84 of ` +
        "the newest 100 tokens sit at exactly that value, never having been bought. Above the " +
        "seed was sellable 15/15; at or below it, 1/85 (RESEARCH-STRATEGY §1b)",
    };
  }

  if (!Number.isInteger(token.holders) || token.holders < cfg.minHolders) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: ${String(token.holders)} holders < floor ` +
        `${String(cfg.minHolders)}. The holders field counts the POOL CONTRACT, so 83 of the ` +
        "newest 100 report exactly 2 (pool + factory) and have no real participant at all. This " +
        "is a LIVENESS proxy only — concentration and rug checks live in screen.ts",
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

  /*
   * The hook, for the same reason and from the same discovery. RESEARCH §7d found TWO hooks on this
   * pad; v1 hardcoded one and silently could not trade 44 of 111 tokens, including three of the four
   * highest-volume names. The failure was an empty inner revert wrapped in `UnexpectedRevertBytes`,
   * which is indistinguishable from an RPC hiccup — which is exactly why it must be checked here,
   * where the refusal is a log line, rather than discovered at the router.
   *
   * This is also a SECURITY check and not only a correctness one: a v4 hook runs inside the swap
   * with the pool's permissions, so an arbitrary hook is an arbitrary contract in the money path.
   * `StrayVault._requireKnownHook` enforces the same two-entry allowlist on chain; see `hook.ts`
   * for why both layers exist and why neither is allowed to be the only one.
   */
  if (!isKnownHook(token.hook)) {
    return {
      ok: false,
      reason:
        `refused ${token.address}: hook ${String(token.hook)} is not one of the two known letscash ` +
        `hooks (${HOOK_PRIMARY}, ${HOOK_SECONDARY}). The PoolKey cannot be built without the right ` +
        "hook, and an arbitrary hook runs inside the swap with the pool's permissions — StrayVault " +
        "refuses the same set on chain (RESEARCH §7d)",
    };
  }

  return { ok: true };
}
