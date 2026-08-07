# BACKTEST RESULTS — `@strays/hunt` against real letscash history

Run 2026-08-07 against 461 tokens, **394,635 real on-chain swaps**, 28.2 days of history.

---

## 0. The answer

**The strategy loses money. On the shipped constants it returns a mean of −117bps per trade over
1,723 trades, with a 46.3% win rate.** Every one of the 15 parameter variants tested also loses.
There is no setting of the lookback, the stop or the drawdown halt in the ranges swept that makes
it profitable.

**But the entry signal is not worthless, and that distinction is the whole finding.**

| | gross (before cost) | net (after measured cost) |
|---|---|---|
| **signal entries** (n=1723) | **+125 bps** | **−117 bps** |
| **random entries**, same tokens, same holding period (n=1420) | +46 bps | −294 bps |
| Welch t, signal vs random | **2.63** | 5.53 |

The signal picks entries that are worth **~79bps more** than a coin flip on the same tokens over the
same horizon, and that difference is statistically distinguishable from zero (t = 2.63, and the
gross mean is 5.17 standard errors above zero on its own). **The signal predicts forward return.**

It just does not predict *enough* of it:

```
gross edge     +125 bps
round trip     −218 bps   (measured: 2 x 1% tax + ~18bps gas at 0.030 gwei)
               ─────────
net            −117 bps  ×  1,723 trades
```

**Breakeven requires the round trip to cost ≤ 125bps. It costs 218bps.** The strategy needs costs
to fall by 43% — or the edge to nearly double — before a single trade is worth making. That is the
result, and it is not a tuning problem.

---

## 1. Data provenance

Everything below is reconstructed from what actually happened on chain. Nothing is modelled,
interpolated, or forward-filled.

| | |
|---|---|
| **Source** | Uniswap v4 `Swap` events on the PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, chain 4663 |
| **Topic0** | `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f` (`cast keccak`-verified) |
| **Filter** | `topics[1] = poolId`, one `eth_getLogs` per pool |
| **Tokens** | **461** (union of `sort=mcap` and `sort=trending`, 3 pages each) |
| **Swaps** | **394,635** — every swap those pools ever saw, from their launch block |
| **Range** | 2026-07-10T14:44:31Z .. 2026-08-07T18:59:52Z = **28.2 days (0.077 years)** |
| **Per token** | min 2, median 39, max 38,867 swaps |
| **Tax mix** | 1%: 369, 3%: 27, 5%: 32, 10%: 30, other: 3 |
| **RPC** | `ROBINHOOD_RPC_URL` (Alchemy). The public `rpc.mainnet.chain.robinhood.com` 403s under load |

### How the price series was reconstructed

Each `Swap` log carries `sqrtPriceX96` in its third word — the pool price *after* that swap. Since
native ETH (the zero address) always sorts first in a v4 `PoolKey`, currency0 = ETH and currency1 =
the token on every letscash pool, so ETH-per-token is `2^192 / sqrtPriceX96²`. Computed in
fixed-point at a 10^30 scale, never float — `(sqrt/2^96)^2` in float64 loses resolution at the
~1e-13 prices these pools trade at, and a test pins that 1bps is still representable.

Each log also carries `blockTimestamp`, so every price point sits at its **real block time** with no
separate block fetch and no inferred x-axis. The collector refuses a log without one rather than
inferring it.

**The decoder is cross-checked against an independent source.** For tx
`0x78ba2b11…22ff8b` (block 29,733,602, FLORK) the pad's own `/api/tokens/{addr}/trades` endpoint —
which decoded the same event with its own code — reports `priceEth: 5.872078413120653e-7`,
`ethWei: 402380217402050`, `tokenWei: 685233490808435054834`. This decoder reproduces all three
exactly. That test is in `replay.test.ts` and is a genuine cross-check, not a tautology.

### Why not the API's `/trades` endpoint

It returns the same data pre-decoded and agrees with the decoder, but it is **hard-capped at 100
trades with no pagination** — `page`, `offset`, `before`, `cursor` and `beforeId` were all probed
and every one returns the identical newest-100 window. For an active token that is ~10 hours. It is
used only as the cross-check above.

### Bars are swaps, not clock intervals

These pools are extremely sparse — a token may trade 40 times in an hour then not at all for three
days. Resampling to fixed one-minute bars would manufacture thousands of synthetic prices by
forward-filling a stale quote, and the 60-minute lookback would then be measuring a move between
two copies of the same number. **One bar = one real swap, at its real block timestamp.**
`evaluateEntry` already scales its threshold by the clock rather than by sample count, which is
exactly what an irregular series requires.

---

## 2. Proving the harness has no lookahead

A backtest engine with a lookahead bug reports fiction in a form that looks like a good result.
`src/replay.test.ts` — **42 tests, all passing**, 95% statements / 85% branches / 99% lines —
exists to prove this one does not have one.

**The rule.** A decision at bar `i` sees bars strictly before `i`, and nothing else.
`historyBefore()` is the only path to a price history and slices with an exclusive upper bound.

**The fill rule.** A decision at bar `i` **cannot fill at bar `i`'s price** — that price is
established by the very swap the decision is reacting to. Entries fill at bar `i+1`. This is
conservative in the right direction: on a real breakout the next swap is usually further along the
move, so the backtest pays a *worse* entry than an idealised one.

The tests that actually settle it:

1. **`historyBefore` excludes the decision bar** — asserts bar `i`'s own price appears nowhere in
   what bar `i` can see.
2. **THE MUTATION TEST** — corrupt every bar from index 25 onward to a 1000× price spike and assert
   every entry decided before index 25 is byte-for-byte identical. A strategy peeking forward would
   see a gigantic move and enter differently. It does not.
3. **The truncation test** — deleting all data after a cut does not change any trade opened before
   it.
4. **The fill test** — for every trade produced, the fill price is asserted absent from the
   deciding bar's visible history.
5. **Accumulator equivalence** — `replayToken` uses O(1) running sums instead of the O(n)
   `volumeBefore`/`sellableBefore`; a prefix sum is easy to get wrong by exactly one bar, and one
   bar is the size of a lookahead bug, so the two forms are pinned equal at every index.
6. **Non-monotone timestamps are refused** at series construction — the guarantee the whole rule
   rests on.

---

## 3. Full results

### Baseline — the shipped constants (lookback 60min, stop −235bps, drawdown halt 2000bps)

```
trades   1723        win rate  46.3%
mean net  −117 bps   median net  −218 bps
gross     +125 bps   (median 0 bps)
sd        1011 bps
```

**Net return distribution (bps) — the distribution, not just the mean:**

```
min    −3409
p10    −1344
p25     −871
MEDIAN  −218
p75     +655
p90    +1125
max    +4061
```

The median is worse than the mean: **most trades lose a little and a few win a lot.** The mean is
carried by the right tail, which is exactly the shape where a mean alone is most misleading.

**By exit reason:**

| exit | n | mean net |
|---|---|---|
| take-profit | 912 | +677 bps |
| stop | 785 | −1030 bps |
| end-of-data | 26 | −395 bps |

The stop loses **1.5×** what the take-profit wins. The −235bps stop does not hold: mean realised
loss on a stopped trade is −1030bps, because between one swap and the next these pools gap straight
through it. **A stop is not a guarantee on a venue where the next observable price can be 10%
lower.** This is the single largest mechanical problem the backtest surfaced.

**By tax tier** — the cost model's central claim, confirmed:

| tax | n | mean net |
|---|---|---|
| 1% | 1643 | −97 bps |
| 3% | 47 | −424 bps |
| 5% | 21 | −631 bps |
| 10% | 2 | −3245 bps |

Loss scales with tax almost exactly as `2 × tax` predicts. **RESEARCH.md §3c Rule 1 — "a stray may
only hunt 1%-tax tokens" — is confirmed by this data.** It does not make the strategy profitable;
it makes it lose the least.

### Parameter sweep — 15 trials, every one a loser

| variant | n | win | mean net | SR/trade |
|---|---|---|---|---|
| lookback=15 | 1865 | 48.5% | **−54** | −0.051 |
| lookback=30 | 1684 | 47.1% | −120 | −0.118 |
| **lookback=60 (shipped)** | 1723 | 46.3% | −117 | −0.116 |
| lookback=120 | 1551 | 43.5% | −158 | −0.159 |
| lookback=240 | 1334 | 43.5% | −187 | −0.188 |
| stop=100 | 1864 | 43.6% | −107 | −0.112 |
| **stop=235 (shipped)** | 1723 | 46.3% | −117 | −0.116 |
| stop=400 | 1712 | 50.1% | −115 | −0.106 |
| stop=800 | 1503 | 56.9% | −136 | −0.110 |
| stop=1600 | 1317 | 65.1% | −156 | −0.106 |
| dd=1000 | 1043 | 45.3% | −110 | −0.111 |
| **dd=2000 (shipped)** | 1723 | 46.3% | −117 | −0.116 |
| dd=4000 | 2495 | 46.8% | −115 | −0.113 |
| dd=100000 (halt off) | 3288 | 45.5% | −152 | −0.150 |

**What the sweep says about the derived constants:**

- **The 60-minute lookback is not optimal, but the difference is inside the noise.** `lookback=15`
  is the best variant at −54bps vs −117bps. That is a 63bps gap against a per-trade standard
  deviation of ~1000bps, i.e. **0.06σ**. With ~1800 trades the standard error of the mean is ~24bps,
  so the gap is ~1.9 standard errors — suggestive, not significant, and it was found by trying five
  values. **It is still a loss.** Shortening the lookback does not change the sign, so this is not
  a tuning opportunity; it is a smaller hole.
- **The −235bps stop is arbitrary and its exact value barely matters.** Every stop from 100 to 1600
  produces a mean net between −107 and −156bps. Widening the stop raises the win rate dramatically
  (43.6% → 65.1%) and moves the median from −321bps to +403bps while making the **mean slightly
  worse**. That is the classic signature of trading a high win rate for a fatter left tail. The
  win rate is a vanity metric here and the stop tuning is a wash.
- **The drawdown halt works as designed and is the only parameter that clearly helps.** Turning it
  off (dd=100000) is the *worst* variant at −152bps over 3,288 trades. It correctly stops a losing
  stray from trading more. It is a damage limiter, not an edge.
- **`EDGE_MULTIPLE = 2` COULD NOT BE TESTED.** It is a module-level `const` in `bar.ts` and
  `decide()` reads it directly rather than taking it from `DecideConfig`, so there is no way to vary
  it without editing `@strays/hunt` — which this package may not do. An earlier draft swept it
  anyway and produced **four byte-identical rows**; they were deleted rather than reported, because
  presenting four identical rows as a sweep would claim a parameter was tested when it was not.
  **This is a real finding about the strategy's testability and it should be fixed by threading
  `edgeMultiple` through `DecideConfig`.**

---

## 4. The honesty check — `@taia/backtest` MinBTL

```
trials recorded: 15
years available: 0.077

── BASELINE ──
RESULT: indistinguishable from noise
  overfitting  Sharpe -4.82 does NOT survive 1 trials: needed > 4.24 and infinite
               years of data, have 0.1. Treat this as noise.
  sample size  mean return is not positive — there is no edge to size a sample around

── BEST-OF-SWEEP (lookback=15) ──
RESULT: indistinguishable from noise
  overfitting  Sharpe -2.20 does NOT survive 15 trials: needed > 8.73 and infinite
               years of data, have 0.1. Treat this as noise.
```

MinBTL is applied to the **best** variant as well as the baseline, because applying it only to the
baseline would let the sweep escape the trial count it exists to constrain.

**In the terms openhood's own backtest used:** 1,723 trades over 28 days on 461 tokens is a far
larger sample than "one trade over 15 days", and unlike that result these trades *lost*. But the
sample is still **0.077 years**, and MinBTL says that at 15 trials a credible Sharpe would need to
exceed 8.73 over this window. **Nothing measured here — in either direction — clears that bar.**

This cuts both ways and it must be said plainly:

- **The negative result is robust.** It does not depend on a marginal statistic. The mean is
  negative, the median is negative, 14 of 15 variants are worse than −100bps, and the mechanism
  (+125bps of edge against a 218bps toll) is simple arithmetic that does not need a significance
  test.
- **The +79bps signal edge over random is NOT established to MinBTL's standard.** Welch t = 2.63 on
  a 28-day window is a real result by conventional standards and it is the most encouraging number
  in this document, but it is one comparison on a short sample and Harvey/Liu/Zhu's t > 3 bar —
  which `assessSampleSize` implements precisely because conventional t > 2 admits too many false
  discoveries — is not met. **Treat "the signal has an edge" as a promising hypothesis, not as
  measured fact.**

### Cost model completeness — declared INCOMPLETE

`assessCostModel` reports three omissions, all real:

- **Slippage is not measured from historical pool state.** It needs an archive `eth_call` at the
  trade block, which this RPC does not serve. RESEARCH §3b measured impact at <1bps for a $5
  position, so the error is small — but "small" is not "zero".
- **Reverts are not counted.** RESEARCH-STRATEGY §1 measured that **84% of the pad fails a $5 sell
  quote**. A token that passed the entry screen and then failed the actual sell would cost gas and
  strand the position. Unmodelled, and it makes these results **optimistic**.
- **Our own price impact is ignored.** We replay a path we did not move.

**Every one of these biases the result in the strategy's favour. The true performance is worse than
−117bps per trade, not better.**

---

## 5. Every other caveat

1. **Tokens are replayed independently, so this is a per-trade edge, not a portfolio result.** A
   single stray holds one position at a time and could not have been in 1,723 positions across 461
   tokens. The `sum` column (−202,072bps) and the compounded `−10000bps` total are therefore
   **arithmetic, not achievable P&L** — the compounded figure hits total ruin at trade 741 purely
   because compounding a negative mean 1,700 times does that. **The mean and median per trade are
   the honest numbers.** This assumption is *optimistic* about capacity.
2. **The sell simulation is proxied, and this is the largest single caveat.** The real screen is a
   quoter `eth_call` at the historical block. The proxy is "the pool has already absorbed at least
   one real sell of at least our position size, strictly before this bar" — a direct on-chain
   observation that an exit of our size was possible at *some* past block, not at *this* one. It is
   causally closer to the real check than a market-cap threshold, but it is not the real check.
3. **Market cap is not reconstructed historically.** The API reports only today's value, and using
   today's market cap at a bar three weeks ago would be lookahead. The `minMarketCapWei` gate is
   therefore neutralised rather than evaluated against a wrong number, and the measured
   `marketCap > 1.36 ETH` sellability filter is **not applied**. Its job is carried by the proxy in
   (2).
4. **Holder and concentration data is not historical either.** `top10Pct`, `creator.*` and
   `snipers.*` are only available as of today. The screen is fed neutral values, so the
   concentration gates are **not exercised**. RESEARCH-STRATEGY §4a already recorded that they
   refuse nothing on the current distribution, so this is unlikely to change the result — but they
   are untested here.
5. **Survivorship bias.** The universe comes from `sort=mcap` and `sort=trending`, which are lists
   of tokens that *did well enough to be listed*. Tokens that launched and died are
   under-represented. This biases the result **optimistic**.
6. **One gas price for the whole window.** 0.030024 gwei, measured 2026-08-07. Gas is ~18bps of a
   round trip at this size, so even a 2× error moves the result by <20bps.
7. **28 days is one market regime.** These 461 tokens traded in a single four-week window on a pad
   that is ~3 months old. Nothing here says anything about a different regime.
8. **The `end-of-data` bucket (n=26) closes open positions at the last observed price.** Dropping
   them would have silently discarded losers that had not yet hit their stop.

---

## 6. What would have to be true for this to win

Stated as falsifiable conditions rather than as hope, in descending order of plausibility:

1. **The round trip would have to cost ≤ 125bps instead of 218bps.** This is the whole gap. At
   cost = 0 the strategy makes +125bps/trade; at 125bps it breaks exactly even; at the measured
   218bps it loses 106bps. There is no obvious route to this: the tax is 2×1% = 200bps of it and is
   charged by the hook on every swap, and gas is already negligible. **Barring a 0%-tax tier or a
   tax rebate, this condition cannot be met on this venue.**
2. **The signal would have to roughly double its edge**, from +125bps to >218bps gross. The sweep
   found nothing in the lookback/stop/drawdown space that does this — the best variant improved the
   *net* by 63bps and remained negative. A genuinely different signal, not a retuned one, would be
   required.
3. **Entries would have to be far more selective.** 1,723 trades from 461 tokens in 28 days is
   ~1.3 trades/token. If the +125bps gross edge is concentrated in an identifiable subset, a filter
   admitting only that subset could clear 218bps. **This is the most promising untested direction**,
   and the p75/p90 of the net distribution (+655/+1125bps) says such a subset exists — what is
   unknown is whether it is identifiable *in advance*. That is the next experiment, and it must be
   run on held-out data because searching for it on this sample is precisely the curve-fit MinBTL
   catches.
4. **The gap-through-stop problem would have to be solved.** Stopped trades lose a mean of
   −1030bps against a −235bps stop. If exits could be executed nearer the stop level, the left tail
   shrinks materially. On a venue where the next observable price can be 10% away, this is a
   hard constraint, not a code fix.

**What would NOT fix it:** retuning the lookback, the stop, or the drawdown halt. All three were
swept and all three lose across their entire tested range. Reporting `lookback=15` as an
improvement would be curve-fitting a 0.06σ difference found by trying five values — which is
exactly what MinBTL exists to catch, and it is still a loss.

---

## 7. Reproducing

```bash
cd packages/backtest
ROBINHOOD_RPC_URL=... COLLECT=1 npx tsx src/collect.ts   # ~15 min, writes data/series.json (58MB)
npx tsx src/run.ts                                        # the full report above
npx vitest run --coverage                                 # 42 harness tests
```

`data/series.json` is gitignored — it is 58MB and reproducible from chain at any time.
