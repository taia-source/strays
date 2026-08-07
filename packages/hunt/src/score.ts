/**
 * THE SCORING MODEL. Rank candidates by expected value NET OF THEIR OWN TAX, and take the best.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHY TAX IS A COST TERM AND NOT AN EXCLUSION ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The shipped strategy hard-refused everything but `taxPct === 1`. The objection that overturned it
 * is arithmetic: **a 5%-tax token that moves 30% is far more profitable than a 1%-tax token that
 * moves 2%.** Refusing by tier throws away the first trade to avoid the second, when the cost model
 * can simply price both.
 *
 * The measured round trips (RESEARCH.md §3b, independently re-confirmed on LIVE pools this session
 * via the quoter — RESEARCH-STRATEGY §6) give each tier its own bar:
 *
 *   tax    round trip    break-even    required at EDGE_MULTIPLE 2
 *    1%      231 bps       +2.31%            +4.63%
 *    3%      624 bps       +6.24%           +12.5%
 *    5%     1008 bps      +10.1%            +20.2%
 *   10%     1938 bps      +19.4%            +38.8%
 *
 * So a 10%-tax token is not refused by a rule. It is required to clear a +38.8% expected move, and
 * it is refused by the ARITHMETIC when it cannot. The difference is not cosmetic: when a 10%-tax
 * token genuinely is moving 40%, we can now take it. SpinningCat (10% tax) was the third
 * most-traded token in the measured sample and the old filter could not see it at all.
 *
 * **The cost term is subtracted BEFORE ranking, never after.** Ranking on gross expected move and
 * then checking cost would let a high-tax token with a big move outrank a low-tax token that is
 * actually more profitable net. That ordering bug is the entire point of this file.
 *
 * ══ AND WHY LOW TAX IS STILL PREFERRED — FOR A SECOND, MEASURED REASON ══
 *
 * Sellability by tier, measured across the newest 100 (RESEARCH-STRATEGY §6):
 *
 *   tax  1%   11/29 sellable (38%)
 *   tax  3%    2/10 sellable (20%)
 *   tax  5%    2/18 sellable (11%)
 *   tax 10%    1/43 sellable ( 2%)
 *
 * High-tax tokens fail the sell simulation far more often. That is a genuine second reason to
 * prefer low tax, INDEPENDENT of cost — and it needs no weighting here, because `screen.ts`
 * enforces it directly: every candidate must pass the sell simulation regardless of tier.
 *
 * ══ WHY A SCORE AND NOT A FILTER ══
 *
 * `decide` previously returned the FIRST candidate that passed every gate, which makes the outcome
 * depend on arrival order — an ordering the LLM was allowed to influence (DESIGN §5). With a score,
 * the model may still propose what to LOOK at, but the arithmetic picks the winner. That keeps the
 * DESIGN §5 property ("the LLM cannot size a position, cannot choose a recipient, cannot override a
 * stop") while removing the one channel where ordering silently mattered.
 *
 * ══ WHAT IS MEASURED HERE AND WHAT IS ASSUMED — STATED, NOT BURIED ══
 *
 * MEASURED on this pad: the cost per tier; that market cap above the 1.356 ETH seed predicts
 * sellability 15/15 while at-or-below predicts it 1/85; that turnover and buy-ratio correlate with
 * depth and sellability.
 *
 * ASSUMED: that buy-ratio and turnover predict FORWARD RETURN. We have not measured forward returns
 * on this pad — that needs a time series we do not hold. The literature is actively discouraging
 * about the stronger claim: Marino et al. (arXiv:2602.14860, n=655,770) found no volume-based
 * buy-and-hold strategy on pump.fun clears breakeven, and a sniper-cohort study (arXiv:2607.02795)
 * found early-buyer effects collapse from a naive +130.9% to +16.1% after propensity matching, with
 * inflow lift statistically indistinguishable from zero — **early-buyer signals are mostly
 * selection, not causation.**
 *
 * Therefore the quality terms are MULTIPLIERS IN [0,1] on an edge that must already be positive,
 * never additive bonuses that could manufacture an edge from nothing. The worst a wrong quality
 * model can do here is decline a good trade. It cannot invent one.
 */

import { requiredGainBps } from "./bar.js";
import { roundTripCost } from "./cost.js";

const BPS_DENOMINATOR = 10_000n;

/**
 * The market-cap value every untraded token on this pad reports, in wei.
 *
 * MEASURED: 84 of the newest 100 tokens sit at EXACTLY 1.356 ETH — it is the seed market cap set at
 * launch. So "market cap above the seed" means "somebody has actually bought this", and it split
 * the pad almost perfectly: `> 1.36 ETH` was sellable 15/15, `<= 1.36 ETH` was sellable 1/85.
 *
 * This is why the shipped `minMarketCapWei = 1 ETH` floor was decoration — it sat BELOW the minimum
 * value the field can take, and 100/100 tokens passed it.
 */
export const SEED_MARKET_CAP_WEI = 1_356_000_000_000_000_000n;

/** Everything the score reads about a candidate. All of it is data; nothing is fetched here. */
export type ScoreInput = {
  readonly address: string;
  /** Integer percent as the pad reports it: 1, 3, 5, 10. The COST TERM, not an exclusion. */
  readonly taxPct: number;
  /** The ETH size of the position, in wei. */
  readonly positionWei: bigint;
  /** Read from the chain this tick. No default anywhere — RESEARCH.md §7a. */
  readonly gasPriceWei: bigint;
  /**
   * The expected move, in bps, from `signal.ts`. AN ESTIMATE and treated as one: it is what the
   * cost term is subtracted from, and the bar in `bar.ts` remains sceptical of the result.
   */
  readonly expectedMoveBps: bigint;
  /** Market cap in wei. Compared against the measured seed, not an invented floor. */
  readonly marketCapWei: bigint;
  /** All-time traded volume in wei of ETH. */
  readonly volumeAllTimeWei: bigint;
  /** Buys as a fraction of all trades, in bps. 5000 = balanced. Measured range 3300..7300. */
  readonly buyRatioBps: bigint;
  /** Distinct holders. A weak liveness proxy — see `eligible.ts` for why it is not a rug check. */
  readonly holders: number;
};

export type Score = {
  readonly address: string;
  /** Expected move MINUS this token's own measured round-trip cost, in bps. May be negative. */
  readonly netEdgeBps: bigint;
  /** The token's own round-trip cost in bps — the number the tax tier actually implies. */
  readonly costBps: bigint;
  /** The gain this token must show to clear EDGE_MULTIPLE x its own cost. */
  readonly requiredBps: bigint;
  /** Depth quality in [0,10000]. Measured: market cap above the seed predicts sellability. */
  readonly depthBps: bigint;
  /** Momentum quality in [0,10000]. ASSUMED to predict return; correlates with depth. */
  readonly momentumBps: bigint;
  /** `netEdgeBps` scaled by the quality multipliers. THE RANKING NUMBER. */
  readonly totalBps: bigint;
  /** The arithmetic, rendered. Logged for losers as well as the winner. */
  readonly arithmetic: string;
};

/**
 * Clamp a bigint into [0, 10000]. Quality terms are multipliers, so they may never exceed 1.0 —
 * a term above 1 would let a quality signal INFLATE an edge rather than discount it, which is the
 * failure mode the header rules out.
 */
function clampBps(v: bigint): bigint {
  if (v < 0n) return 0n;
  return v > BPS_DENOMINATOR ? BPS_DENOMINATOR : v;
}

/**
 * DEPTH quality, in bps.
 *
 * MEASURED (RESEARCH-STRATEGY §1b): market cap above the 1.356 ETH seed predicted sellability
 * 15/15, at-or-below predicted it 1/85. Volume tells the same story monotonically:
 *
 *   all-time volume ~0        0/47 sellable
 *   0 .. 0.02 ETH             1/18
 *   0.02 .. 0.1 ETH           3/15
 *   0.1 .. 1 ETH              7/14  (50%)
 *   >= 1 ETH                  5/6   (83%)
 *
 * So depth is scored from BOTH, and a token at the seed with no volume scores zero — which is the
 * correct answer for 46% of the pad, since it has never traded at all.
 */
export function depthQualityBps(args: {
  readonly marketCapWei: bigint;
  readonly volumeAllTimeWei: bigint;
  readonly positionWei: bigint;
}): bigint {
  if (args.positionWei <= 0n) return 0n;

  // Market cap above the measured seed. At the seed exactly this is 0; it saturates at ~2x seed,
  // which is where the measured sellable set actually lives (1.36 .. 13.6 ETH).
  const excess = args.marketCapWei > SEED_MARKET_CAP_WEI ? args.marketCapWei - SEED_MARKET_CAP_WEI : 0n;
  const capTerm = clampBps((excess * BPS_DENOMINATOR) / SEED_MARKET_CAP_WEI);

  // Volume relative to our own position. 1 ETH of all-time volume against a $5 position is ~385x,
  // the regime the measured 83%-sellable cohort sits in. Saturates there.
  const volTerm = clampBps((args.volumeAllTimeWei * BPS_DENOMINATOR) / (args.positionWei * 385n));

  // The WEAKER of the two binds. A token with volume but no market cap movement, or market cap
  // without volume, is not confirmed by two independent measurements and should not score as if
  // it were. Taking the minimum is the conservative direction and it is deliberate.
  return capTerm < volTerm ? capTerm : volTerm;
}

/**
 * MOMENTUM quality, in bps. **ASSUMED to predict return — see the header.**
 *
 * Measured on the alive set: buy-ratio spans 0.33..0.73, and the strongest (CASHDOG 0.65,
 * CatDay 0.71, WEALTH 0.73) are all sellable with real depth. What is MEASURED is the correlation
 * with depth and sellability; what is ASSUMED is forward return.
 *
 * Below 50% buys (net selling) this returns 0 — we do not rank a token being distributed. Above
 * that it scales linearly to 1.0 at 75% buys, which is just past the measured maximum of 73%.
 */
export function momentumQualityBps(args: { readonly buyRatioBps: bigint }): bigint {
  const r = args.buyRatioBps;
  if (r <= 5000n) return 0n;
  // 5000 -> 0, 7500 -> 10000. Integer arithmetic throughout; no floats reach a threshold.
  return clampBps(((r - 5000n) * BPS_DENOMINATOR) / 2500n);
}

/**
 * Score one candidate. Pure arithmetic; every input arrives as data.
 *
 * The order is the argument: cost is subtracted FIRST so ranking happens on NET edge, then quality
 * multipliers only ever discount what remains. A candidate whose expected move does not cover its
 * own tax has a negative `netEdgeBps` and cannot be rescued by any quality term, because multiplying
 * a negative by a number in [0,1] leaves it negative.
 */
export function scoreCandidate(input: ScoreInput): Score {
  const cost = roundTripCost({
    positionWei: input.positionWei,
    taxPct: input.taxPct,
    gasPriceWei: input.gasPriceWei,
  });
  const costBps = cost.totalBps;
  const requiredBps = requiredGainBps({
    costWei: cost.totalWei,
    positionWei: input.positionWei,
  });

  // ══ TAX AS A COST TERM. The line this whole file exists for. ══
  const netEdgeBps = input.expectedMoveBps - costBps;

  const depthBps = depthQualityBps({
    marketCapWei: input.marketCapWei,
    volumeAllTimeWei: input.volumeAllTimeWei,
    positionWei: input.positionWei,
  });
  const momentumBps = momentumQualityBps({ buyRatioBps: input.buyRatioBps });

  /*
   * Quality multipliers apply ONLY to a positive edge. A negative net edge is passed through
   * untouched so that ranking still orders the losers sensibly (−50bps is better than −500bps) and
   * so no multiplier can ever move a negative edge toward zero and flatter it.
   */
  const totalBps =
    netEdgeBps > 0n
      ? (netEdgeBps * depthBps * momentumBps) / (BPS_DENOMINATOR * BPS_DENOMINATOR)
      : netEdgeBps;

  const arithmetic =
    `${input.address}: expected ${input.expectedMoveBps.toString()}bps − cost ` +
    `${costBps.toString()}bps (tax ${input.taxPct.toString()}%) = net ${netEdgeBps.toString()}bps; ` +
    `x depth ${depthBps.toString()}bps x momentum ${momentumBps.toString()}bps = ` +
    `${totalBps.toString()}bps. Bar for this tier: ${requiredBps.toString()}bps`;

  return { address: input.address, netEdgeBps, costBps, requiredBps, depthBps, momentumBps, totalBps, arithmetic };
}

/**
 * Rank candidates best-first. Ties break on ADDRESS, never on input order.
 *
 * The tiebreak is not cosmetic. Sorting is only a total order if ties are broken deterministically;
 * otherwise the winner depends on the arrival order of `candidates`, which is the very channel the
 * LLM can influence (DESIGN §5). A deterministic tiebreak means the model can propose what to look
 * at and still cannot decide what gets bought.
 */
export function rankCandidates(scores: readonly Score[]): readonly Score[] {
  return [...scores].sort((a, b) => {
    if (a.totalBps !== b.totalBps) return a.totalBps > b.totalBps ? -1 : 1;
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  });
}
