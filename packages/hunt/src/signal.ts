/**
 * THE ENTRY SIGNAL. A short-horizon momentum breakout, sized to the cost bar.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHY THERE IS A DIRECTIONAL SIGNAL HERE AT ALL, WHEN OPENHOOD PROVED THERE WASN'T ONE ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * openhood measured autocorrelation across 7 lags of hourly log returns on the ETH/NVDA pool
 * (n = 364, 95% band ±0.1027): lag1 −0.0737, lag2 +0.0404, lag3 +0.0099, lag4 −0.0637,
 * lag6 −0.0124, lag12 +0.1041, lag24 −0.0167. One marginal exceedance across seven lags is
 * exactly what chance produces at α = 0.05. Its conclusion, quoted in RESEARCH §3d:
 *
 *   **"There is no exploitable serial dependence in this series."**
 *
 * That finding is about **tokenized NVDA**, and it is not a fact about markets — it is a fact
 * about that asset class. An RWA equity pool is arbitraged against an off-chain NAV: when the pool
 * price leaves NAV, someone is paid to push it back, and that mechanism is precisely what destroys
 * serial dependence. A memecoin has **no NAV anchor**. There is nothing to revert to and nothing
 * paid to revert it; price is set by flow, and flow is reflexive — buying begets buying.
 *
 * RESEARCH §3d states the consequence directly: *"This is why the same engine that was boring on
 * openhood can work here. The engine was never the problem; the asset was."*
 *
 * **So this file uses momentum, and openhood's file explicitly could not.** That is a genuine
 * difference in the underlying asset, not a difference of opinion about the same data. The honest
 * caveat, recorded rather than buried: we have NOT measured memecoin autocorrelation lag by lag
 * the way openhood measured NVDA's. What RESEARCH §3d measured is the move DISTRIBUTION (mean
 * absolute 24h move 7.7%, range −17.1% to +38.8%, 29 of 48 non-zero). Reflexivity is an argument
 * from mechanism, not a measured lag-1 coefficient. The design below is built so that this matters
 * as little as possible — see "why a breakout survives being wrong about momentum".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE HORIZON: 60 MINUTES. NOT OPENHOOD'S 1440. ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * openhood's `LOOKBACK_MINUTES = 1440n` is derived in its own file, and the derivation is correct
 * FOR ITS ASSET AND ITS COSTS:
 *
 *   "EDGE_MULTIPLE = 2 on a 219bps round trip demands ~438bps of expected gain. At the measured
 *    sigma_1h of 53bps, a 1-sigma drift of 438bps takes (438/53)^2 = 68 HOURS."
 *
 * The PRINCIPLE it teaches — **match the signal horizon to the cost horizon** — is what we inherit.
 * The NUMBER is an artifact of a 53bps hourly sigma on an equity pool. Running the identical
 * arithmetic on OUR measurements:
 *
 *   RESEARCH §3d: mean absolute 24h move = 7.7% = 770 bps.
 *   Treating that as a ~1-sigma daily scale, sigma_1h = 770 / sqrt(24) = **157 bps**.
 *   (openhood's was 53 bps. Memecoins run ~3x the hourly vol of a tokenized equity. That single
 *    ratio is why every horizon constant differs.)
 *
 *   The bar (bar.ts): 231bps round trip x EDGE_MULTIPLE 2 = **463 bps** of required gain.
 *   Time for a 1-sigma drift to cover 463bps:  (463 / 157)^2 = 8.7 hours.
 *
 * By openhood's own method the answer here is ~9 hours, not 68. That is already a 7.5x difference
 * driven entirely by the asset. **We then go shorter still, to 60 minutes, and the reason is a
 * different one that openhood's asset never faced:**
 *
 *   The 60-minute window is the LOOKBACK — how far back we look to detect that a move has already
 *   happened. It is NOT the holding period and it is NOT the profit horizon. openhood conflated
 *   the two deliberately (its comment: "the signal horizon and the profit horizon finally agree"),
 *   which is right for a series with no serial dependence, where the only honest claim is a drift
 *   over the full horizon. With reflexivity it is wrong: the thing we are detecting is a move
 *   IN PROGRESS, and a 24-hour lookback would report a move that finished 23 hours ago as though
 *   it were happening now.
 *
 * DESIGN §6 Rule 6 sets the other boundary, and it is a measured one: meridian built a 20-second
 * rotation loop, lost 2.8% on a NVDA→AAPL→NVDA round trip in two hours and **retired the strategy
 * entirely** — *"15-minute signals decay faster than the fees they incur."* Rule 6 concludes:
 * *"the honest cycle is minutes-to-hours, not seconds."*
 *
 *   floor:   > 15 minutes    (meridian's measured decay failure)
 *   ceiling: ~ 9 hours       (openhood's method applied to our sigma)
 *   chosen:  60 minutes      — the smallest round horizon clear of the measured failure, and
 *                              the unit our own volatility figure is expressed in
 *
 * 60 is the shortest horizon we can defend rather than the one that trades most. It is a judgement
 * inside a measured interval, and it is recorded as one. **It was NOT searched over a return
 * series** — there is no fitted value here, because fitting a horizon across a 48-launch sample is
 * exactly the trial-count inflation `@taia/backtest`'s MinBTL guard is built to make loud.
 *
 * ══ WHY A BREAKOUT SURVIVES BEING WRONG ABOUT MOMENTUM ══
 *
 * A breakout asks only whether a move large enough to matter **has actually happened** — which is
 * measured, not predicted. It does not require the move to continue in order to be honest; it
 * requires only that a market which just moved k-sigma is more likely to move again than one that
 * has not. That is volatility clustering, which is a far weaker and far better-attested claim than
 * directional momentum. If the reflexivity argument above is wrong, this signal degrades to
 * "trade only things that are moving", and the cost bar still refuses everything that cannot pay.
 * The bar does the real work. This file only decides what is worth showing it.
 *
 * ══ THE THRESHOLD: 2 SIGMA OVER THE WINDOW ══
 *
 * Conventional two-standard-deviations, taken rather than searched — for the reason above. At
 * sigma_1h = 157bps, a 60-minute window has sigma_window = 157bps and the breakout threshold is
 * **314 bps**. Note this sits BELOW the 463bps cost bar, and that ordering is deliberate and
 * important: the signal is the cheaper, noisier filter and the bar is the binding one. If the
 * threshold exceeded the bar, the bar would be decoration.
 *
 * ══ TAKE-PROFIT AND STOP-LOSS ══
 *
 * TAKE_PROFIT = +3 sigma_1h = +471 bps. Floored by `levelsFor` against the cost bar so a target
 *               that cannot pay for its own round trip is impossible to express.
 * STOP_LOSS   = −1.5 sigma_1h = −235 bps. See `risk.ts` for why the asymmetry is 2:1 and why a
 *               stop exists at all when meridian shipped none.
 *
 * Asymmetric 2:1 deliberately: a strategy paying a fixed 231bps round trip cannot afford symmetric
 * targets, because the cost term eats the expectation unless wins are larger than losses.
 */

/**
 * Measured hourly volatility scale, in basis points.
 *
 * DERIVED, not assumed: RESEARCH §3d measured mean absolute 24h move = 7.7% = 770bps across the
 * newest 48 live launches. Under a random walk, scale goes as sqrt(t), so
 * sigma_1h = 770 / sqrt(24) = 157.2 bps.
 *
 * This is a SCALE, not a standard deviation of log returns — mean absolute deviation and standard
 * deviation differ by ~1.25x for a normal. Using MAD directly is the conservative direction (it
 * understates sigma, so the derived thresholds are if anything slightly tight) and it is the
 * statistic we actually measured. Inventing the 1.25x correction would be dressing an
 * approximation up as a measurement.
 *
 * openhood's equivalent was 53bps on tokenized NVDA. The ~3x ratio is the whole reason this file's
 * constants differ from that one's, and it is the memecoin/RWA distinction made numeric.
 */
export const SIGMA_1H_BPS = 157n;

/**
 * The lookback window, in MINUTES. Derived at length in the header.
 *
 * ══ IN MINUTES, NEVER IN SAMPLES ══
 *
 * openhood's file records the bug this naming prevents: a lookback counted in SAMPLES silently
 * changes meaning when the sampling rate changes. Its window was mislabelled by 12x — a 12-point
 * window spanning 55 minutes was called "11h" and the threshold scaled by sqrt(11) instead of
 * sqrt(0.917), a 3.5x overstatement that compounded as the series filled, so **every hour of
 * operation made a trade less likely** and it took zero trades in a full day of ticks.
 *
 * `evaluateEntry` below therefore measures the window from the timestamps on the price points and
 * never from `history.length`. A test asserts that two histories with the same sample count but
 * different spans produce different thresholds.
 */
export const LOOKBACK_MINUTES = 60n;

/** How many sigma a move must be to count as a breakout. Conventional 2, not searched. */
export const BREAKOUT_SIGMA = 2n;

/** Take-profit at +3 sigma_1h = +471bps. */
export const TAKE_PROFIT_BPS = 3n * SIGMA_1H_BPS;

/**
 * Stop-loss at −1.5 sigma_1h = −235bps, expressed as a positive magnitude.
 *
 * Integer-safe: `3n * SIGMA_1H_BPS / 2n` = 235, not a float. Half of TAKE_PROFIT by construction,
 * which is the 2:1 asymmetry stated once rather than as two independently tunable numbers that
 * could drift apart.
 */
export const STOP_LOSS_BPS = (3n * SIGMA_1H_BPS) / 2n;

/** Basis points in 100%. */
const BPS_DENOMINATOR = 10_000n;
const SECONDS_PER_HOUR = 3600n;

/** A price observation. Pure data — read from the pool or the API, never invented. */
export type PricePoint = {
  /** ETH per token, scaled by 1e18. */
  readonly ethPerTokenWei: bigint;
  /** Unix seconds. The window is measured from THIS, never from the sample count. */
  readonly atSeconds: number;
};

export type Direction = "long" | "none";

export type EntrySignal = {
  readonly direction: Direction;
  /** Observed move over the window, in basis points. Signed. */
  readonly moveBps: bigint;
  /** The threshold this move was compared against, in bps. */
  readonly thresholdBps: bigint;
  /** The window actually spanned, in minutes, from the clock. */
  readonly windowMinutes: bigint;
  /** Expected gain if the move continues to take-profit, in wei. AN ESTIMATE, labelled as one. */
  readonly expectedGainWei: bigint;
  /** For the decision log. Present whether or not the signal fired. */
  readonly reasoning: string;
};

/**
 * Percentage move between two prices, in basis points. Signed, integer, exact.
 *
 * Integer math throughout. RESEARCH §7d records that a real 18-decimal balance needs ~22
 * significant digits, beyond float64's ~15–17, and that round-tripping through `number`
 * reconstructs a wei amount that reverts. `@taia/authority` records the largest single-agent loss
 * on file (~$250k, Lobstar Wilde) as a decimal error rather than an injection. No floats here.
 */
export function moveBpsBetween(from: bigint, to: bigint): bigint {
  if (from <= 0n) {
    throw new Error(
      `refusing to compute a move from a non-positive price ${from.toString()} — an unreadable ` +
        "pool has no move, and treating it as one invents a signal out of a failed read",
    );
  }
  return ((to - from) * BPS_DENOMINATOR) / from;
}

/**
 * Take-profit and stop-loss for a position, floored so the target can always pay its own way.
 *
 * A take-profit of +471bps on a position whose round trip costs more than that is not a target,
 * it is a guaranteed loss wearing a target's clothes. So the vol-derived level is RAISED, if
 * necessary, to whatever the cost bar demands.
 *
 * Which term binds depends on the gas price and the tax of the day: at the measured 231bps round
 * trip on a 1%-tax token the cost floor is 462bps and the vol-derived 471bps just wins. On a
 * 10%-tax token the cost floor would be ~3876bps and would dominate absurdly — and the absurdity
 * is VISIBLE in the number rather than hidden behind a plausible 4.7%. Both directions are tested.
 *
 * The STOP is deliberately NOT floored by cost. A stop raised to sit outside the cost bar is a
 * stop that fires later, i.e. after a larger loss, which is the opposite of what a stop is for.
 * The cost of exiting is a fact about the exit, not a reason to stay in — DESIGN §6 Rule 5.
 */
export function levelsFor(args: {
  readonly positionWei: bigint;
  readonly roundTripCostWei: bigint;
  readonly edgeMultiple: bigint;
}): { readonly takeProfitBps: bigint; readonly stopLossBps: bigint } {
  if (args.positionWei <= 0n) {
    throw new Error("refusing to derive levels for a non-positive position");
  }
  /*
   * ══ THE DIVISION ROUNDS UP, AND THAT IS LOAD-BEARING ══
   *
   * A REAL DEFECT lived here, and it was invisible while only 1%-tax tokens were tradeable.
   *
   * Integer division truncates DOWNWARD. So the cost floor this function computed was up to one
   * bp BELOW the true `cost x multiple`, and the expected gain derived from it
   * (`positionWei * takeProfitBps / 10000`) came out FRACTIONALLY UNDER the bar in `bar.ts` —
   * which then refused the trade. Measured on a 10%-tax position of 2.5e15 wei:
   *
   *   cost x 2          = 1016806015852000 wei required
   *   gain from floor   = 1016750000000000 wei   -> SHORT BY 56015852000 wei
   *
   * The function's entire promise is that a take-profit "can always pay its own way", and it was
   * emitting a target that provably could not. The bug is small in magnitude and total in effect:
   * it silently refused every trade whose take-profit was cost-bound rather than vol-bound, which
   * at 1% tax was none of them (the 471bps vol level dominates a 462bps cost floor) and at 10% tax
   * is ALL of them.
   *
   * Rounding UP costs at most one bp of extra target and makes the floor a floor.
   */
  const numerator = args.roundTripCostWei * args.edgeMultiple * BPS_DENOMINATOR;
  const costFloorBps =
    numerator / args.positionWei + (numerator % args.positionWei > 0n ? 1n : 0n);
  const takeProfitBps = TAKE_PROFIT_BPS > costFloorBps ? TAKE_PROFIT_BPS : costFloorBps;
  return { takeProfitBps, stopLossBps: STOP_LOSS_BPS };
}

/**
 * Evaluate whether to OPEN a position, from measured prices alone.
 *
 * PURE. No I/O, no clock, no chain, no model. Every rule is testable without a network, so a mock
 * cannot hide a disagreement between what the test exercises and what production runs.
 *
 * `history` is oldest-first. The caller chooses the horizon by choosing what it passes, which
 * keeps this function from having an opinion about a horizon it cannot measure — but the window is
 * then read back off the TIMESTAMPS, so a caller that passes the wrong span gets a threshold
 * scaled to what it actually passed rather than to what it meant.
 */
export function evaluateEntry(args: {
  readonly history: readonly PricePoint[];
  readonly positionWei: bigint;
  readonly takeProfitBps: bigint;
}): EntrySignal {
  const n = args.history.length;
  const none = (reasoning: string, moveBps = 0n, thresholdBps = 0n, windowMinutes = 0n) => ({
    direction: "none" as const,
    moveBps,
    thresholdBps,
    windowMinutes,
    expectedGainWei: 0n,
    reasoning,
  });

  // Two points is the minimum that defines a move. One point is a price, not a signal.
  if (n < 2) {
    return none(
      `no signal: ${String(n)} price point(s) is not enough to measure a move. A signal derived ` +
        "from a single observation is a guess with a timestamp",
    );
  }

  const first = args.history[0];
  const last = args.history[n - 1];
  // `noUncheckedIndexedAccess` makes this reachable in the type system; it is also a real defence
  // against a sparse array arriving from a partially-failed API read (RESEARCH §5).
  if (first === undefined || last === undefined) {
    return none("no signal: price history contained an undefined point");
  }

  const moveBps = moveBpsBetween(first.ethPerTokenWei, last.ethPerTokenWei);

  /*
   * ══ THE WINDOW IS MEASURED FROM THE CLOCK, NEVER COUNTED FROM THE SAMPLES ══
   *
   * This is the openhood units bug (see LOOKBACK_MINUTES) made structurally impossible: the
   * elapsed time comes off the timestamps that were already on the data, so the threshold means
   * the same thing at any sampling rate. If the tick interval changes tomorrow, this arithmetic
   * does not.
   */
  const elapsedSeconds = last.atSeconds - first.atSeconds;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return none(
      `no signal: the price window spans ${String(elapsedSeconds)}s of elapsed time, so its ` +
        "volatility is not measurable. A threshold scaled from a sample COUNT rather than the " +
        "CLOCK is the units bug this check exists to make impossible",
      moveBps,
    );
  }
  const windowMinutes = BigInt(Math.round(elapsedSeconds / 60));

  /*
   * The threshold scales with the square root of the window, because volatility does:
   * sigma over t seconds = sigma_1h * sqrt(t / 3600). Integer sqrt on a 1e6-scaled ratio keeps
   * this exact and float-free.
   */
  const scaledRatio = (BigInt(Math.floor(elapsedSeconds)) * 1_000_000n) / SECONDS_PER_HOUR;
  const sigmaOverWindowBps = (SIGMA_1H_BPS * isqrt(scaledRatio)) / 1000n;
  const thresholdBps = BREAKOUT_SIGMA * sigmaOverWindowBps;

  /*
   * Long only. A stray holds spot tokens; there is no borrow and no short on this venue, so a
   * downward breakout is information the strategy structurally cannot act on. Saying so is better
   * than silently treating a fall as no-signal — the log line distinguishes the two.
   */
  const isBreakout = moveBps >= thresholdBps && moveBps > 0n;
  const direction: Direction = isBreakout ? "long" : "none";

  // An ESTIMATE, and labelled as one everywhere it travels. The cost bar's whole job is to be
  // sceptical of it, which is why the bar lives in a different module and takes this as input.
  const expectedGainWei = isBreakout
    ? (args.positionWei * args.takeProfitBps) / BPS_DENOMINATOR
    : 0n;

  // The window is reported in MINUTES from the clock, ALONGSIDE the sample count. Both are shown
  // deliberately: "60min (13 samples)" makes a sampling-rate change or a gap in the series visible
  // in the log, where openhood's "11h" concealed one for a full day.
  const window = `${windowMinutes.toString()}min (${String(n)} samples)`;
  const reasoning = isBreakout
    ? `breakout: move +${moveBps.toString()}bps over ${window} >= threshold ` +
      `${thresholdBps.toString()}bps (${BREAKOUT_SIGMA.toString()} sigma, sigma_window ` +
      `${sigmaOverWindowBps.toString()}bps). Expected gain at take-profit ` +
      `${args.takeProfitBps.toString()}bps = ${expectedGainWei.toString()} wei — AN ESTIMATE, ` +
      "which the cost bar must still clear"
    : moveBps < 0n
      ? `no signal: move ${moveBps.toString()}bps over ${window} is DOWNWARD. Long only — this ` +
        "venue has no borrow, so a fall is information the strategy cannot act on"
      : `no breakout: move +${moveBps.toString()}bps over ${window} < threshold ` +
        `${thresholdBps.toString()}bps (${BREAKOUT_SIGMA.toString()} sigma, sigma_window ` +
        `${sigmaOverWindowBps.toString()}bps)`;

  return { direction, moveBps, thresholdBps, windowMinutes, expectedGainWei, reasoning };
}

/**
 * Integer square root, Newton's method. Exact for the scaled fixed-point use above.
 *
 * Present because `Math.sqrt` returns a float and this module refuses floats in anything that
 * reaches a threshold comparison.
 */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("refusing the square root of a negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
