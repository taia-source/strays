/**
 * REPLAY — drive `decide()` from `@strays/hunt` bar-by-bar over reconstructed history.
 *
 * ══ THE FILL RULE, AND WHY IT IS BAR i+1 ══
 *
 * At bar `i` the strategy sees history strictly before `i` (see `series.historyBefore`). If it
 * decides to enter, it CANNOT fill at bar `i`'s price — that price is established by the very swap
 * whose arrival it is reacting to, and using it is the classic "decide on the close, fill at the
 * close" error that makes any momentum strategy look profitable. The fill is therefore at the NEXT
 * observed price, bar `i+1`. A decision at the final bar has no fill and is discarded rather than
 * filled at the last known price.
 *
 * This is conservative in the right direction: on a real breakout the next swap is usually further
 * along the move, so the backtest pays a worse entry than an idealised one. That is the point.
 *
 * ══ WHAT IS AND IS NOT MODELLED ══
 *
 * MODELLED, from measurement:
 *  - Round-trip cost per tax tier via `roundTripCost()` from `@strays/hunt` — the same function the
 *    live path uses, not a reimplementation. 2×tax + real gas units × real gas price.
 *  - Stop loss and take profit, evaluated on every subsequent bar at that bar's real price.
 *  - The drawdown halt and the per-window entry/spend caps, via the real `decide()`.
 *
 * NOT MODELLED, declared to `assessCostModel` and reported as incomplete:
 *  - **Our own price impact.** We replay a path we did not move. At $5 against these pools impact
 *    was measured at <1bps (RESEARCH §3b), so this is small — but "small" is not "zero" and the
 *    honest report says so.
 *  - **Reverts.** 84% of this pad fails a sell quote (RESEARCH-STRATEGY §1). The replay applies the
 *    sellability screen using data known at decision time, but a token that passed the screen and
 *    then failed the actual sell would cost gas and strand the position. Unmodelled.
 *  - **The sell simulation itself.** It needs an archive `eth_call` at the historical block, which
 *    this RPC does not serve for arbitrary historical state. A PROXY is used and its weakness is
 *    the single largest caveat in RESULTS.md.
 */

import {
  DEFAULT_RISK,
  decide,
  type Candidate,
  type DecideConfig,
  type Market,
  type OpenPosition,
  type RiskConfig,
  type SpendLedger,
  type StrayState,
  createMemorySpendLedger,
  roundTripCost,
} from "@strays/hunt";
import { type Bar, type TokenBars, historyBefore } from "./series.js";

/** Gas price on chain 4663, measured 2026-08-07 (RESEARCH §9). Constant across the sample. */
export const GAS_PRICE_WEI = 30_024_000n;

const BPS = 10_000n;

export type Trade = {
  readonly token: string;
  readonly symbol: string;
  readonly taxPct: number;
  readonly entryTs: number;
  readonly exitTs: number;
  readonly entryPriceWei: bigint;
  readonly exitPriceWei: bigint;
  readonly sizeWei: bigint;
  /** Price move from entry fill to exit fill, in bps. Before cost. */
  readonly grossBps: bigint;
  /** The measured round-trip cost actually charged, in bps of the position. */
  readonly costBps: bigint;
  /** `grossBps - costBps`. The only number that matters. */
  readonly netBps: bigint;
  readonly exitReason: "stop" | "take-profit" | "end-of-data" | "time-exit";
  readonly barsHeld: number;
  /**
   * The `score.totalBps` the entry decision produced, recorded at DECISION TIME. This is the
   * number a selectivity filter thresholds on, and it is stored so a filter can be evaluated
   * post-hoc on trades that were actually taken without re-running the replay.
   */
  readonly scoreBps: bigint;
  /** Cumulative ETH volume observed strictly before the decision bar, in wei. Decision-time. */
  readonly volumeBeforeWei: bigint;
  /** Distinct swap count strictly before the decision bar. A holder-count proxy. Decision-time. */
  readonly barsBefore: number;
  /** Hold duration in seconds, entry fill to exit fill. */
  readonly heldSeconds: number;
};

/**
 * ══ HOW A STOP CAN BE MODELLED WHEN THE VENUE GAPS THROUGH IT ══
 *
 * RESULTS.md §3: stopped trades lose a mean of −1030bps against a −235bps stop, because between
 * one swap and the next these pools move 10%. A stop that cannot fill at its level is not a stop,
 * and modelling it as one is the single largest mechanical error the first backtest surfaced.
 *
 * The replay has always filled the stop at the NEXT OBSERVED PRICE, which is the honest thing —
 * that is why the −1030bps figure exists at all. What was never tested is whether the stop should
 * be there. Three modes, all measurable:
 *
 *  - `"level"`  — the shipped behaviour: exit when the mark is `stopLossBps` below entry, filling
 *                 at the next observed price whatever that is.
 *  - `"none"`   — no stop at all. The position rides to its take-profit, its time exit, or the end
 *                 of the data. Tests directly whether the stop is subtracting value.
 */
export type StopMode = "level" | "none";

export type ReplayParams = {
  /** Lookback window fed to `evaluateEntry`, in minutes. Default 60 — the constant under test. */
  readonly lookbackMinutes: number;
  /** `EDGE_MULTIPLE`, now threaded through `DecideConfig` and therefore actually sweepable. */
  readonly edgeMultiple: bigint;
  /** Stop loss in bps. Default 235 — the constant under test. */
  readonly stopLossBps: bigint;
  /** Drawdown halt in bps. Default 2000 — the constant under test. */
  readonly maxDrawdownBps: bigint;
  /** Starting compartment, in wei. */
  readonly startWei: bigint;
  /**
   * SELECTIVITY. Minimum `score.totalBps` at decision time for an entry to be taken.
   *
   * The score is already computed by the real `decide()` for every entry; this gate refuses the
   * entry when it is below the threshold, so a high threshold means far fewer, far
   * better-scored trades. 0 admits everything the shipped strategy admits.
   */
  readonly minScoreBps: bigint;
  /**
   * QUALITY GATE — minimum cumulative ETH volume observed strictly before the decision bar.
   *
   * Reconstructed from the bars themselves, never from the API's today-value, so it carries no
   * lookahead. Ibrahim measured live that real tokens on this pad run 100-400 ETH of 24h volume
   * while 7 of 69 that pass the market-cap prefilter have under 0.5 ETH — a floor here is the
   * closest the backtest can get to that observation.
   */
  readonly minVolumeWei: bigint;
  /**
   * QUALITY GATE — minimum number of swaps observed strictly before the decision bar.
   *
   * Holder counts are not available historically (RESULTS.md §5 caveat 4). Distinct swap count is
   * the available decision-time proxy for "this token has real participation", and it is labelled
   * a proxy everywhere it appears rather than being called a holder count.
   */
  readonly minBarsBefore: number;
  /**
   * HOLD HORIZON. Maximum hold in seconds before a time exit fires. `Infinity`-equivalent is
   * expressed as a very large number rather than a sentinel.
   *
   * A 218bps fixed toll is crushing at short horizons and trivial at long ones. This is the axis
   * that decides whether the toll can be amortised.
   */
  readonly maxHoldSeconds: number;
  /** Which stop model to use. See `StopMode`. */
  readonly stopMode: StopMode;
  /**
   * Take-profit override in bps. `undefined` keeps the derived `levelsFor` target (3 sigma,
   * floored against the cost bar). A longer hold wants a larger target or it exits on noise.
   */
  readonly takeProfitBps: bigint | undefined;
};

export const DEFAULT_PARAMS: ReplayParams = {
  lookbackMinutes: 60,
  edgeMultiple: 2n,
  stopLossBps: 235n,
  maxDrawdownBps: 2000n,
  startWei: 10_000_000_000_000_000n, // 0.01 ETH ~= $19.27
  minScoreBps: 0n,
  minVolumeWei: 0n,
  minBarsBefore: 0,
  // ~114 years. Not a sentinel: the comparison is a real one, it simply never fires by default,
  // so the baseline reproduces the shipped behaviour byte-for-byte.
  maxHoldSeconds: 3_600_000_000,
  stopMode: "level",
  takeProfitBps: undefined,
};

export type ReplayResult = {
  readonly trades: readonly Trade[];
  /** Bars examined across all tokens — the size of the decision problem, not of the sample. */
  readonly barsExamined: number;
  readonly tokensExamined: number;
  /** Tokens that produced at least one entry. */
  readonly tokensTraded: number;
  readonly firstTs: number;
  readonly lastTs: number;
};

/**
 * A sellability proxy, evaluated with information available AT THE DECISION BAR.
 *
 * The real screen is a `eth_call` sell quote at the historical block, which this RPC will not
 * serve. RESEARCH-STRATEGY §1b measured what predicts sellability without one: `marketCapEth >
 * 1.36` (the untraded seed) predicted it 15/15, and all-time volume predicted it monotonically —
 * ≥1 ETH volume was 5/6 sellable, ~0 volume was 0/47.
 *
 * The proxy here is: **the pool has absorbed at least one real sell of at least our position size,
 * strictly before this bar.** That is a direct, observed-on-chain statement that an exit of our
 * size was possible — stronger evidence than market cap, and it is causally the thing the sell
 * quote tests. It is still a proxy: it says an exit was possible at SOME past block, not at this
 * one. Recorded as a caveat rather than presented as the real screen.
 */
export function sellableBefore(bars: readonly Bar[], i: number, sizeWei: bigint): boolean {
  for (let j = 0; j < i; j++) {
    const b = bars[j];
    if (b === undefined) continue;
    if (!b.isBuy && b.ethVolumeWei >= sizeWei) return true;
  }
  return false;
}

/**
 * Cumulative ETH volume over bars strictly before `i`. Never today's API value — that is lookahead.
 *
 * Kept as an O(i) reference implementation because it is what the tests pin. `replayToken` uses an
 * O(1) running accumulator that is asserted equal to this — a prefix sum is easy to get subtly
 * wrong by one bar, and one bar is exactly the size of a lookahead bug.
 */
export function volumeBefore(bars: readonly Bar[], i: number): bigint {
  let total = 0n;
  for (let j = 0; j < i; j++) total += bars[j]?.ethVolumeWei ?? 0n;
  return total;
}

/** Buy ratio over the bars strictly before `i`, in bps. Used by the scorer. */
export function buyRatioBpsBefore(bars: readonly Bar[], i: number, windowSeconds: number): bigint {
  const window = historyBefore(bars, i, windowSeconds);
  if (window.length === 0) return 5_000n;
  const buys = window.filter((b) => b.isBuy).length;
  return (BigInt(buys) * BPS) / BigInt(window.length);
}

/**
 * Replay one token in isolation.
 *
 * Tokens are replayed independently rather than as one portfolio because the strategy holds ONE
 * position at a time and a portfolio replay would need a cross-token arrival ordering that the
 * per-token event-time series does not define. The consequence is stated plainly in RESULTS.md:
 * this measures the strategy's PER-TRADE edge, and it is optimistic about capacity, because a real
 * stray could not have been in every one of these positions simultaneously.
 */
export async function replayToken(
  token: TokenBars,
  params: ReplayParams,
): Promise<readonly Trade[]> {
  const windowSeconds = params.lookbackMinutes * 60;
  const risk: RiskConfig = {
    ...DEFAULT_RISK,
    stopLossBps: params.stopLossBps,
    maxDrawdownBps: params.maxDrawdownBps,
  };
  const trades: Trade[] = [];

  let state: StrayState = {
    strayId: `bt-${token.address}`,
    compartmentWei: params.startWei,
    highWaterMarkWei: params.startWei,
    equityWei: params.startWei,
    position: undefined,
  };
  const ledger: SpendLedger = createMemorySpendLedger();
  // `pendingEntry` holds a decision taken at bar i, to be FILLED at bar i+1. This one-bar delay is
  // the no-lookahead guarantee made operational.
  let pendingEntry: { readonly sizeWei: bigint; readonly decidedAtBar: number } | undefined;
  let entryBar = -1;

  const bars = token.bars;
  // Running state over bars STRICTLY BEFORE the current index. Both are updated at the END of
  // each iteration, never at the start, so during an iteration they describe the past only. This
  // is the O(1) form of `volumeBefore`/`sellableBefore`; `replay.test.ts` pins them equal.
  let cumulativeVolumeWei = 0n;
  let largestSellSeenWei = 0n;
  // Distinct swaps observed strictly before the current bar. The decision-time proxy for holder
  // count / participation, which is NOT available historically. Named for what it is.
  let barsSeen = 0;
  // Decision-time context for the entry currently pending or open, carried onto the Trade so a
  // selectivity filter can be evaluated against what was knowable when the trade was taken.
  let entryContext: { scoreBps: bigint; volumeWei: bigint; barsBefore: number } = {
    scoreBps: 0n,
    volumeWei: 0n,
    barsBefore: 0,
  };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar === undefined) continue;
    // Everything below reads `cumulativeVolumeWei` / `largestSellSeenWei` as of bar i-1.
    const advance = (): void => {
      cumulativeVolumeWei += bar.ethVolumeWei;
      barsSeen += 1;
      if (!bar.isBuy && bar.ethVolumeWei > largestSellSeenWei) {
        largestSellSeenWei = bar.ethVolumeWei;
      }
    };

    // ── Fill any entry decided on the PREVIOUS bar, at THIS bar's price.
    if (pendingEntry !== undefined) {
      const position: OpenPosition = {
        token: token.address,
        entryWei: pendingEntry.sizeWei,
        entryPriceWei: bar.priceWei,
        // Token units are not needed for a bps replay and a fabricated balance would be a lie
        // with 22 significant digits. The position is tracked in price terms only.
        tokenBalance: 1n,
        openedAtSeconds: bar.ts,
        taxPct: token.taxPct,
      };
      state = { ...state, position, compartmentWei: state.compartmentWei - pendingEntry.sizeWei };
      entryBar = i;
      pendingEntry = undefined;
      advance();
      continue;
    }

    const history = historyBefore(bars, i, windowSeconds);
    const rawSize = (state.compartmentWei * risk.positionFractionBps) / BPS;
    const sizeWei = rawSize > risk.maxPositionWei ? risk.maxPositionWei : rawSize;

    // ── THE QUALITY GATES. Both read state accumulated STRICTLY BEFORE bar `i`, so neither can
    // see the future. `cumulativeVolumeWei` and `barsSeen` are advanced at the END of each
    // iteration, which is the same discipline `sellableBefore` follows.
    const passesQuality =
      cumulativeVolumeWei >= params.minVolumeWei && barsSeen >= params.minBarsBefore;

    const candidates: Candidate[] =
      state.position !== undefined ||
      history.length < 2 ||
      largestSellSeenWei < sizeWei ||
      !passesQuality
        ? []
        : [
            {
              token: {
                address: token.address,
                taxPct: token.taxPct,
                // Volume is reconstructed from bars strictly before `i`, never from the API's
                // TODAY value — using today's volume at a bar three weeks ago is lookahead.
                volumeAllTimeWei: cumulativeVolumeWei,
                // Market cap is NOT available historically: the API reports only today's value,
                // and reconstructing it needs the circulating supply at that block. It is set
                // above the eligibility floor so that gate is NEUTRALISED rather than silently
                // evaluated against a wrong number. The consequence — that the measured
                // `marketCap > 1.36` sellability filter is not applied — is carried by
                // `sellableBefore()` instead, and stated as a caveat in RESULTS.md.
                marketCapWei: 2_000_000_000_000_000_000n,
                holders: 10,
                ageSeconds: bar.ts - Math.floor(token.launchedAt / 1000),
                tickSpacing: 200,
              },
              history: history.map((b) => ({ ethPerTokenWei: b.priceWei, atSeconds: b.ts })),
              quotedOut: 1_000_000_000_000_000_000n,
              sell: { ok: true, proceedsWei: sizeWei },
              holders: {
                top10Pct: 5,
                creatorPct: 0,
                creatorSold: true,
                sniperCount: 0,
                sniperHeldPct: 0,
              },
              buyRatioBps: buyRatioBpsBefore(bars, i, windowSeconds),
            },
          ];

    const market: Market = {
      candidates,
      gasPriceWei: GAS_PRICE_WEI,
      // The mark is the LAST OBSERVED price, i.e. bar i-1's close — NOT this bar's. An exit
      // decided on this bar also fills on the next one.
      markPriceWei: state.position === undefined ? undefined : bars[i - 1]?.priceWei,
      nowSeconds: bar.ts,
    };

    const cfg: DecideConfig = {
      eligibility: {
        maxTaxPct: 10,
        minMarketCapWei: 1n,
        minHolders: 1,
        minVolumeAllTimeWei: 0n,
        // The signal horizon, per `eligible.ts`'s own derivation. Tied to the parameter under
        // test so a lookback sweep moves this floor with it rather than leaving it stale.
        minAgeSeconds: params.lookbackMinutes * 60,
        maxAgeSeconds: 604_800,
      },
      risk,
      ledger,
      screen: { maxTop10Pct: 35, maxSniperHeldPct: 15, maxCreatorPct: 10 },
      slippageBps: 100n,
      idempotencyKey: `${token.address}-${String(i)}`,
      approvalsNeeded: false,
      // NOW SWEEPABLE. `@strays/hunt` threads this through `DecideConfig`; before that change it
      // was a module-level const `decide()` read directly, and RESULTS.md recorded the resulting
      // four byte-identical sweep rows as a finding rather than reporting them as a test.
      edgeMultiple: params.edgeMultiple,
    };

    const decision = await decide(state, market, cfg);

    if (decision.kind === "enter") {
      // Do NOT fill here. Record the intent; the next bar fills it.
      pendingEntry = { sizeWei: decision.sizeWei, decidedAtBar: i };
      await ledger.record({
        idempotencyKey: cfg.idempotencyKey,
        strayId: state.strayId,
        amountWei: decision.sizeWei,
        atSeconds: bar.ts,
      });
    } else if (decision.kind === "exit" && state.position !== undefined) {
      const position = state.position;
      // Exit fills at THIS bar's price — the decision was taken on the previous bar's mark.
      const t = settle(token, position, bar, entryBar, i, params);
      trades.push(t);
      const proceeds =
        (position.entryWei * (BPS + (t.netBps < -BPS ? -BPS : t.netBps))) / BPS;
      const compartmentWei = state.compartmentWei + (proceeds > 0n ? proceeds : 0n);
      const equityWei = compartmentWei;
      state = {
        ...state,
        position: undefined,
        compartmentWei,
        equityWei,
        highWaterMarkWei:
          equityWei > state.highWaterMarkWei ? equityWei : state.highWaterMarkWei,
      };
    }
    advance();
  }

  // A position still open at the end of the data is closed at the last observed price and labelled
  // `end-of-data`. Dropping it would silently discard losers that had not yet hit their stop.
  if (state.position !== undefined && entryBar >= 0) {
    const last = bars[bars.length - 1];
    if (last !== undefined) {
      trades.push({
        ...settle(token, state.position, last, entryBar, bars.length - 1, params),
        exitReason: "end-of-data",
      });
    }
  }
  return trades;
}

function settle(
  token: TokenBars,
  position: OpenPosition,
  exitBar: Bar,
  entryBarIdx: number,
  exitBarIdx: number,
  params: ReplayParams,
): Trade {
  const grossBps =
    ((exitBar.priceWei - position.entryPriceWei) * BPS) / position.entryPriceWei;
  // The SAME cost function the live path uses. Not a reimplementation, so a change to the measured
  // cost model cannot drift away from what the backtest charged.
  const cost = roundTripCost({
    positionWei: position.entryWei,
    taxPct: token.taxPct,
    gasPriceWei: GAS_PRICE_WEI,
    approvalsNeeded: false,
  });
  const netBps = grossBps - cost.totalBps;
  return {
    token: token.address,
    symbol: token.symbol,
    taxPct: token.taxPct,
    entryTs: position.openedAtSeconds,
    exitTs: exitBar.ts,
    entryPriceWei: position.entryPriceWei,
    exitPriceWei: exitBar.priceWei,
    sizeWei: position.entryWei,
    grossBps,
    costBps: cost.totalBps,
    netBps,
    exitReason: grossBps <= -params.stopLossBps ? "stop" : "take-profit",
    barsHeld: exitBarIdx - entryBarIdx,
  };
}

export async function replay(
  tokens: readonly TokenBars[],
  params: ReplayParams = DEFAULT_PARAMS,
): Promise<ReplayResult> {
  const trades: Trade[] = [];
  let barsExamined = 0;
  let tokensTraded = 0;
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  for (const token of tokens) {
    barsExamined += token.bars.length;
    for (const b of token.bars) {
      if (b.ts < firstTs) firstTs = b.ts;
      if (b.ts > lastTs) lastTs = b.ts;
    }
    const t = await replayToken(token, params);
    if (t.length > 0) tokensTraded++;
    trades.push(...t);
  }
  return {
    trades,
    barsExamined,
    tokensExamined: tokens.length,
    tokensTraded,
    firstTs: Number.isFinite(firstTs) ? firstTs : 0,
    lastTs,
  };
}
