/**
 * SERIES — turning raw on-chain swaps into the bar series `decide()` is replayed over.
 *
 * ══ THE LOOKAHEAD RULE, STATED ONCE AND ENFORCED IN TYPES ══
 *
 * A backtest engine with a lookahead bug reports fiction. The rule this module exists to make
 * structurally impossible is:
 *
 *   **A decision taken at bar `i` may see bar `i`'s OPEN and everything strictly before it.
 *    It may NOT see bar `i`'s close, high, low, or any later bar.**
 *
 * The mechanism is `historyBefore()`, which is the ONLY way the replay obtains a price history,
 * and which slices with an exclusive upper bound. There is no accessor on a `Bar` that returns a
 * future price, and `replay.ts` never indexes the bar array itself. `replay.test.ts` proves the
 * property two ways: by a golden-value test against a hand-computed series, and by a MUTATION
 * test that corrupts every future bar to an absurd value and asserts the decisions are byte-for-
 * byte unchanged — if any future data leaked in, that test fails loudly.
 *
 * ══ WHY EVENT-TIME BARS, NOT CLOCK-TIME BARS ══
 *
 * These pools are extremely sparse. A token may trade 40 times in its first hour and then not at
 * all for three days. Resampling to fixed one-minute bars would manufacture thousands of synthetic
 * "prices" by forward-filling a stale quote, and the strategy's 60-minute lookback would then be
 * measuring a move between two copies of the same number. Bars here are therefore SWAPS: one bar
 * per real trade, at its real block timestamp. Nothing is interpolated. The cost is that bar
 * spacing is irregular — which is correct, because trading opportunity on this venue is
 * irregular, and `evaluateEntry` already scales its threshold by the CLOCK (`elapsedSeconds`)
 * rather than by sample count for exactly this reason.
 */

export type Bar = {
  /** Unix seconds — the real block timestamp of the swap that made this bar. */
  readonly ts: number;
  /** ETH per token after this swap, scaled to wei (1e18). */
  readonly priceWei: bigint;
  /** Absolute ETH that moved in this swap, in wei. A liquidity/interest proxy. */
  readonly ethVolumeWei: bigint;
  /** True if ETH went INTO the pool, i.e. somebody bought the token. */
  readonly isBuy: boolean;
  readonly block: number;
};

export type TokenBars = {
  readonly address: string;
  readonly symbol: string;
  readonly taxPct: number;
  readonly launchedAt: number;
  readonly bars: readonly Bar[];
};

/** Raw shape as written by `collect.ts`. */
export type RawSeries = {
  readonly address: string;
  readonly symbol: string;
  readonly poolId: string;
  readonly taxPct: number;
  readonly launchedAt: number;
  readonly marketCapEth: number;
  readonly swaps: readonly {
    readonly block: number;
    readonly ts: number;
    readonly logIndex: number;
    readonly priceEth: string;
    readonly amount0: string;
    readonly amount1: string;
  }[];
};

const WEI = 10n ** 18n;

/**
 * Number of extra decimal places carried beyond wei.
 *
 * These pools trade at ~1e-13 ETH per token. At a plain 1e18 scale that leaves only ~5 significant
 * figures, and a 1bps move (1 part in 10,000) would be at the edge of representable — quantisation
 * alone could manufacture or erase a signal. Prices are therefore carried at 1e30, giving ~17
 * significant figures at the observed magnitudes. Every use is a RATIO (`moveBpsBetween` divides
 * two of these), so the extra scale cancels and never leaks into a wei amount.
 */
const PRICE_SCALE = 10n ** 30n;

/** Decimal ETH-per-token to a `PRICE_SCALE`-scaled bigint. */
export function toPriceWei(priceEth: string): bigint {
  const v = Number(priceEth);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(
      `refusing a non-positive or non-finite price "${priceEth}" — moveBpsBetween throws on ` +
        "these anyway, and admitting one here would turn a failed read into a fabricated bar",
    );
  }
  // Split into mantissa and exponent rather than multiplying by 1e30, which overflows float64.
  const [mantissa, exponent] = v.toExponential(15).split("e") as [string, string];
  const digits = BigInt(mantissa.replace(".", "").replace("-", ""));
  // `toExponential(15)` always yields exactly 15 fractional digits, so `digits` is mantissa * 1e15.
  const shift = BigInt(exponent) - 15n;
  const scaled =
    shift >= 0n
      ? digits * PRICE_SCALE * 10n ** shift
      : (digits * PRICE_SCALE) / 10n ** -shift;
  if (scaled <= 0n) {
    throw new Error(
      `price ${priceEth} underflows the ${PRICE_SCALE.toString()} scale to zero. A zero price ` +
        "would divide by zero in moveBpsBetween rather than being silently treated as flat",
    );
  }
  return scaled;
}

export function toBars(raw: RawSeries): TokenBars {
  const bars: Bar[] = [];
  let prevTs = -1;
  for (const s of raw.swaps) {
    // Chain order is already block-then-logIndex from the collector. Assert monotone TIME here,
    // because a non-monotone timestamp would let a "past" bar carry a future price.
    if (s.ts < prevTs) {
      throw new Error(
        `${raw.symbol}: swap at block ${String(s.block)} has timestamp ${String(s.ts)} before ` +
          `the previous bar's ${String(prevTs)}. A non-monotone series breaks the only ` +
          "guarantee the no-lookahead rule rests on",
      );
    }
    prevTs = s.ts;
    const a0 = BigInt(s.amount0);
    bars.push({
      ts: s.ts,
      priceWei: toPriceWei(s.priceEth),
      // amount0 is the pool's ETH delta. Positive = ETH into the pool = a BUY of the token.
      ethVolumeWei: a0 < 0n ? -a0 : a0,
      isBuy: a0 > 0n,
      block: s.block,
    });
  }
  return {
    address: raw.address,
    symbol: raw.symbol,
    taxPct: raw.taxPct,
    launchedAt: raw.launchedAt,
    bars,
  };
}

/**
 * The ONLY way the replay may read history. Exclusive upper bound — this is the no-lookahead rule.
 *
 * Returns the bars strictly BEFORE index `i` that fall inside `windowSeconds` of bar `i`'s
 * timestamp, plus bar `i`'s own OPEN, which for an event-time series is the previous bar's close.
 *
 * Note what is deliberately absent: bar `i`'s price. At bar `i` the strategy is deciding whether
 * to act ON that swap's arrival, and the price it would transact at is the one established by that
 * swap — which it cannot know until the swap has landed. Modelling entry at bar `i`'s price would
 * be the classic "trade at the close you used to decide" error. Entry therefore fills at bar
 * `i+1`, and `replay.ts` enforces it.
 */
export function historyBefore(
  bars: readonly Bar[],
  i: number,
  windowSeconds: number,
): readonly Bar[] {
  if (i <= 0) return [];
  const nowTs = bars[i - 1]?.ts;
  if (nowTs === undefined) return [];
  const cutoff = nowTs - windowSeconds;
  const out: Bar[] = [];
  // Walk backwards from i-1 (EXCLUSIVE of i) until the window closes.
  for (let j = i - 1; j >= 0; j--) {
    const b = bars[j];
    if (b === undefined) break;
    if (b.ts < cutoff) break;
    out.push(b);
  }
  return out.reverse();
}
