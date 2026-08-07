# BACKTEST RESULTS — `@strays/hunt` against real letscash history

> **ROUND 4 (2026-08-07, LATEST): "this venue is unwinnable" is SUPERSEDED. Read §10 first.**
> Rounds 1-3 tested ONE strategy family — momentum breakout with a tight stop — eleven times, and
> generalised its failure into a claim about the venue. That generalisation does not follow.
> Round 4 tested four families the harness could not previously express. **Entering early in a
> token's life and exiting on a wide trailing stop returns a +5,609bps MEDIAN on held-out tokens
> and beats matched random entries on 20/20 seeds** — the first arm in four rounds with a positive
> median that also beats the coin flip. The effect is a monotone dose-response in entry index, it
> survives the sellability gate, and 0% of its positions are censored.
> **It is NOT proven**: `credible: false` at 183 cumulative trials, n=72, and under the real
> one-position product constraint its Welch t falls to 1.16. Classic trend following is refuted.
> **§10 supersedes the "unwinnable venue" conclusion in §8.7 and §9.7.**
>
> **ROUND 3 (2026-08-07, earlier): the MATURE-AND-LIQUID subset was tested and it is NOT profitable
> — but §8.2 was measuring the wrong filter and is CORRECTED.**
> Restricting the universe to genuinely liquid tokens (token-level, on realised swap counts) *does*
> improve the strategy, from −120bps to −56bps, which is the opposite of what §8.2 reported. It
> does not reach profit, because **the gross edge is FLAT across liquidity (+114 … +151bps at every
> band) while the round trip is ~225bps everywhere.** Liquidity was never the binding constraint.
> Read **§9 at the bottom first**; it supersedes §8.2's quality-gate rows.
>
> **ROUND 2 (2026-08-07, earlier): the selectivity hypothesis was tested and it FAILED.**
> The profitable subset is real but it is **not identifiable in advance**, and the one arm that
> looked profitable turns out to be measurable survivorship bias that a coin flip collects
> equally. **The strategy is not profitable and this venue's 200bps hook tax is why.**
> The full round-2 result is in **§8** — read that before the older material,
> which §8 supersedes on three specific points.


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

---
---

# 8. ROUND 2 — THE SELECTIVITY HYPOTHESIS, TESTED AND REJECTED

§6 named selectivity *"the most promising untested direction"* and set the condition: the
profitable subset must be **identifiable in advance**, and it must be verified on **held-out
data**. Both were done. The hypothesis fails.

This section supersedes three claims made above and says so explicitly where it does.

## 8.0 The answer

**The strategy is not profitable, and no arm tested here makes it profitable.** One arm — a very
wide take-profit — produces a positive mean on held-out data (+234bps, n=1021). It is reported here
in full and then **rejected**, because:

```
signal entries, wide take-profit, HELD-OUT:   +234 bps   (n = 1021)
RANDOM entries, same universe, same exit:     +227 bps   (n = 1952)
                                              ─────────
Welch t                                          0.08
```

**A coin flip earns the same return.** The number is not the strategy's. Its source is measured in
§8.4 and it is survivorship bias in the token universe.

`assessOverfitting` at the full 76-trial count: **`credible: false`**.

## 8.1 Method

- **TRAIN/TEST SPLIT IN TIME.** Cut at 70% of the observed window (day 19.7). TRAIN = 205 tokens /
  165k bars / 19.7 days. TEST = 450 tokens / 230k bars / 8.5 days. Every threshold below was chosen
  on TRAIN; every number reported as a result is from TEST.
- **The cut is at 0.7 rather than the midpoint, and that is forced by the data, not chosen for the
  answer.** The universe is not uniform in time: it is the union of *today's* `sort=mcap` and
  `sort=trending` lists, so 183 of 461 tokens first trade on day 18 and 216 in the last four days.
  A midpoint cut puts **19 tokens** in TRAIN. 0.7 is the earliest cut with a usable universe on
  both sides, and it was picked from the bar-count histogram **before any return was measured on
  either fold**.
- **Trials counted: 76.** Deliberately over-counted rather than under-counted.
- The baseline reproduces the round-1 figure exactly: **−117bps over 1723 trades**.

## 8.2 What was tested, and what each result was

All fitted on TRAIN. Baseline on TRAIN is −120bps.

| lead | arm | TRAIN mean net | verdict |
|---|---|---|---|
| **1. Selectivity** | `minScoreBps` 1 → 2000 | **−252 … −366** | **WORSE than no filter at every threshold** |
| **2. Hold longer** | 1h → 168h at fixed take-profit | −139 … −129 | no effect beyond ~4h |
| **2b. Wider take-profit** | tp 471 → 10000 | −139 → **+296** | **the only positive arm** |
| **3. Volume floor** | ≥1 … ≥200 ETH | −114 … −284 | **monotonically worse** |
| **3b. Participation floor** | ≥50 … ≥5000 swaps | −119 … −159 | **monotonically worse** |
| **4. Stop widened** | 1000, 3000bps | −215, −330 | worse |
| **4b. Stop removed** | `stopMode: none` | −190 | **worse than keeping it** |
| **5. `edgeMultiple`** | 1 … 8 | −120 (identical) | **no effect — see §8.5** |

**Leads 1, 3 and 4 are refuted outright.** The score is *anti*-predictive: filtering to the
highest-scored decile takes the mean from −120bps to −252bps. The quality gates get monotonically
worse as they tighten — the opposite of the hypothesis. And removing the stop, despite stopped
trades losing −1030bps, makes things worse, because the trades it would have stopped keep falling.

## 8.3 The one positive arm, and why it is not an edge

Only the take-profit width produced a positive mean, and it survives out of sample as a *number*:

| take-profit | TRAIN mean | TEST mean | TEST median |
|---|---|---|---|
| 471 (shipped) | −139 | −104 | −204 |
| 2000 | +69 | −1 | −502 |
| 4000 | +192 | +53 | −542 |
| 10000 | +296 | **+234** | **−535** |

Two things kill it.

**First, the median is −535bps and gets WORSE as the mean improves.** Win rate falls to 29.8%. The
mean is carried by a handful of trades: on TEST, the **top 10 of 1021 trades (1%) are 49% of all
profit**, and the top 3 *tokens* are 50% of it. Drop the top 10 trades and the mean falls from
+234bps to +122bps. This is a lottery-ticket payoff, and §5 caveat 1 already established that a
single stray holding one position at a time could not have held these in parallel.

**Second, and decisively — it does not beat a coin flip.** Random entries on the same universe with
the same exit rule and the same measured cost:

| take-profit | signal mean | random mean | diff | Welch t |
|---|---|---|---|---|
| 471 | −104 | −249 | **+145** | **4.65** |
| 1000 | −45 | −98 | +53 | 1.39 |
| 2000 | −1 | +58 | −60 | −1.20 |
| 4000 | +53 | +167 | −114 | −1.69 |
| 6000 | +171 | +189 | −17 | −0.21 |
| 10000 | +234 | +227 | +8 | **0.08** |

**THE SHAPE OF THIS TABLE IS THE WHOLE RESULT.** The signal's edge over random is largest exactly
where the strategy loses money (t = 4.65 at the shipped take-profit) and decays to nothing exactly
where it starts to make money. Widening the take-profit does not harvest the signal — it **discards**
it, and replaces it with a payoff shape that a coin flip captures equally well.

This *confirms* §0's finding that the signal is real (it is now t = 4.65 on held-out data, stronger
than round 1's 2.63) while removing any way to profit from it. **The signal is real, short-horizon,
and worth less than 218bps.**

## 8.4 Where the +234bps actually comes from: survivorship, measured

```
random entry, all 461 tokens, tp=471:    mean −141 bps
random entry, all 461 tokens, tp=10000:  mean +264 bps      <-- no strategy at all
BUY AND HOLD, first bar to last:         mean +31,251 bps, median +547 bps
                                         291/461 (63%) of tokens ended UP
```

**63% of this universe rose, and buy-and-hold returns a mean of +31,251bps.** That is not a market
property; it is a property of a universe drawn from *today's* mcap and trending lists, which by
construction cannot contain the tokens that launched and died. §5 caveat 5 flagged this bias as
present. **§8 measures it, and it is larger than the entire apparent edge.**

A wide take-profit is simply a longer exposure to that upward drift. It is the survivorship bias
read through a wider window — which is why a coin flip collects it too.

## 8.5 `EDGE_MULTIPLE` is a TAUTOLOGY — this SUPERSEDES §3

§3 recorded that `EDGE_MULTIPLE` *"COULD NOT BE TESTED"* because `decide()` read a module-level
constant, and inferred that the four byte-identical sweep rows were a plumbing problem. **The
plumbing was fixed and the rows are still identical. The diagnosis was wrong.**

`edgeMultiple` is now threaded through `DecideConfig` (optional, defaulting to `EDGE_MULTIPLE`, so
no existing caller changes). Sweeping it 1 → 64 still changes **nothing about which trades fire**:

- `levelsFor` floors the take-profit at `cost × multiple / position`.
- `evaluateEntry` defines `expectedGain = position × takeProfitBps`.
- So the gain the bar tests **is** the requirement the bar tests it against.

**The cost bar cannot refuse a long signal — 0 refusals across 72 combinations of tax tier,
position size and multiple**, pinned by test in `replay.test.ts`. `EDGE_MULTIPLE` moves the *exit
target*; it is not, and never was, a selectivity control. The strategy has no working entry bar,
and it never did.

## 8.6 The honesty check

```
── BEST HELD-OUT ARM (tp=10000), 76 trials ──
RESULT: indistinguishable from noise

  overfitting  Sharpe 2.83 does NOT survive 76 trials: needed > 19.34 and 1.1 years
               of data, have 0.0. Treat this as noise.
  sample size  1021 trades is short of the 1145 needed for t > 3
  cost model   INCOMPLETE (slippage, reverts, own price impact — all bias OPTIMISTIC)

CREDIBLE: false
mean 234bps   MEDIAN −535bps   n=1021   win 29.8%
Welch t vs random entry, same exit rule: 0.08
```

**`credible: false`.** And the Welch test is the stronger objection: even if the sample were large
enough, the return is not attributable to the signal.

## 8.7 The conclusion, stated plainly

**Ibrahim asked for profitable with no loss. The honest answer is that this venue's 200bps hook tax
makes short-horizon trading on it unwinnable, and this round tested the last idea that could have
changed that.**

The arithmetic has not moved:

```
signal edge (held-out, shipped horizon)   +145 bps over random
round trip                                −218 bps  (200 of it the hook tax)
                                          ─────────
                                           −73 bps
```

The edge is real and it is **67% of the toll**. Every route to closing that gap was tested:

- **Fewer, better trades** — the score is anti-predictive; selectivity makes it worse.
- **Longer holds** — no effect beyond ~4 hours; these moves resolve in minutes.
- **Quality gates** — monotonically worse as they tighten.
- **Fixing the stop** — removing it is worse than keeping it.
- **A harder cost bar** — it is a tautology and refuses nothing.
- **A wider take-profit** — profitable-looking, but a coin flip earns the same, and the source is
  survivorship bias measured at +264bps.

### What WOULD work, as falsifiable conditions

1. **A 0%-tax tier, or a tax rebate/exemption.** The single binding constraint. At zero tax the
   round trip is ~18bps of gas and the measured +145bps held-out edge is profitable immediately.
   This is a venue term, not a code change, and it is the only condition here that is both
   sufficient and within reach of a negotiation.
2. **A venue with materially lower round-trip cost.** The signal is a general short-horizon
   momentum effect; nothing about it is specific to letscash. Anywhere the round trip costs under
   ~145bps, the same code is worth testing.
3. **Not this.** Holding tokens for days on this pad has a positive mean, but it is survivorship
   bias, its median is −535bps, and it is indistinguishable from buying at random. Anyone reporting
   it as a strategy result is reporting the coin flip.

### What would NOT work

Retuning the lookback, the stop, the drawdown halt, the score threshold, the volume floor, the
participation floor, the hold horizon, or the edge multiple. **All eight have now been swept and
all eight lose across their entire tested range** — the first three in round 1, the other five here.

## 8.8 Reproducing round 2

```bash
cd packages/backtest
npx tsx src/explore.ts    # the search, on TRAIN only — 56 trials
npx tsx src/confirm.ts    # the held-out verification + honesty check
npx vitest run --coverage # 50 harness tests
```

`src/explore.ts` searches and never reports; `src/confirm.ts` is the only file that reports a
number on held-out data. That separation is deliberate.

---

# 9. ROUND 3 — the mature-and-liquid subset, tested directly

> **Ibrahim's direction: stay on letscash, do not move venue. "There is tokens there with 1m mcap
> that has daily volume."** This round tests whether a mature-and-liquid subset is profitable where
> the whole pad is not, and re-examines §8.2's surprising claim that quality gates got
> *monotonically worse* as they tightened.

## 9.0 The answer

**The liquid subset is NOT profitable, but §8.2's finding was measuring the wrong thing and is
corrected here.** Two separate results:

1. **§8.2's "quality gates get monotonically worse" was an artifact of the filter's semantics, not
   a property of liquid tokens.** The round-2 gate (`minBarsBefore`) is a *decision-time cumulative
   counter* that delays entry on a token already in the universe; it never selected liquid tokens.
   A true **token-level** universe filter moves results the OTHER way — the direction Ibrahim
   expected. §9.2.
2. **But the liquid subset still loses, because the gross edge does not grow with liquidity.**
   Restricting to liquid tokens improves net return from −99bps to about −111bps … −81bps — it does
   not cross zero. The reason is decisive and is the core finding of this round:

```
                       GROSS edge   round trip   NET      (held-out fold)
all 450 tokens            +134bps      232bps    −99bps
>=100 swaps               +151bps      232bps    −81bps
>=1000 swaps              +117bps      232bps   −115bps
>=2000 swaps              +114bps      225bps   −111bps
>=5000 swaps              +130bps      217bps    −87bps
>=10000 swaps              +42bps      217bps   −176bps
```

**The gross edge is FLAT across liquidity — it does not strengthen as liquidity rises.** It hovers
around +114 … +151bps at every band and *falls* to +42bps at the most liquid. The toll is ~225bps
at every band. Liquidity does not close the gap because **the gap was never a liquidity problem.**

**Every arm was compared against random entries on the same restricted universe. None beats the
coin flip at conventional significance once liquidity is high.** `assessOverfitting` at 133
cumulative trials: **`credible: false`**.

## 9.1 What was actually wrong with §8.2 — the correction

§8.2 reported the participation floor getting monotonically worse and called it a refutation of the
liquidity hypothesis. **That inference was wrong, and the reason is that the two filters are not
the same filter:**

| | what it does | on CryingCat (38,867 swaps) |
|---|---|---|
| `minBarsBefore` (round 2) | **decision-time cumulative counter** — refuses entry until *n* swaps have been seen on that token | does NOT select the token; **delays** its first entry to swap 5,000, discarding early history |
| `restrictTo` (round 3) | **token-level universe filter** — decides which tokens are tradeable at all | selects the token, trades its whole history |

Run side by side on TRAIN, they point in **opposite directions**:

```
A1. minBarsBefore (decision-time gate)      A2. token-level universe restriction
  >=0      net −120bps                        all            net −120bps  (205 tokens)
  >=50     net −119bps                        >=100 swaps    net  −99bps  ( 95 tokens)
  >=200    net −145bps                        >=1000 swaps   net  −63bps  ( 33 tokens)
  >=1000   net −139bps                        >=2000 swaps   net  −56bps  ( 20 tokens)
  >=5000   net −159bps  ← §8.2's finding      >=5000 swaps   net  −56bps  (  7 tokens)
```

**The token-level filter improves net return by 64bps and lifts the win rate from 44.0% to 50.9%
— Ibrahim's intuition was directionally right and §8.2 did not test it.** §8.2's monotone
degradation is a real property of *delaying entry*, not of *trading liquid tokens*. This section
supersedes §8.2's third and fourth rows and the "quality gates" bullet in §8.7.

## 9.2 Does the edge survive as liquidity rises? — held-out, each band vs its own coin flip

```
  band                  tokens      n   signal    random     diff  Welch t      B&H mean  up%
  all                    450   1154      -99      -214      116     3.46         13051   56
  >=100 swaps            131   1049      -81      -250      169     4.52         44812   78
  >=500 swaps             78    882      -95      -236      141     3.26         74157   87
  >=1000 swaps            46    623     -115      -253      138     2.61        123263   89
  >=2000 swaps            31    493     -111      -264      153     2.40        172787   87
  >=5000 swaps            11    209      -87      -222      135     1.35        414642   73
  >=10000 swaps            5     77     -176      -242       66     0.45        568982   60
  >=60/hr sustained       14    274      -63      -219      156     1.87        362131   93
  >=100/hr sustained       6    100       21       -31       52     0.44        767931  100
```

Three things to read off this table:

**1. The signal's edge over random is real and roughly CONSTANT (+116 … +169bps) at every band.**
It does not strengthen with liquidity. This is the same +145bps §8.3 measured pad-wide, and it is
still smaller than the 225bps toll at every band.

**2. The Welch t COLLAPSES as liquidity rises — from 4.52 to 0.45 — purely because n falls.** The
diff stays ~135-156bps while the sample shrinks from 1,049 trades to 77. Only the first five rows
are significant, and those are the *less* restricted ones. **The liquid bands do not have a
stronger edge; they have the same edge measured worse.**

**3. The one positive number is a survivorship readout, not a result.** `>=100/hr sustained` posts
**+21bps** — the only non-negative cell in the table. It is 6 tokens, 100 trades, **Welch t =
0.44**, and its buy-and-hold is **+767,931bps with 100% of tokens ending UP.** That is the §8.4
trap exactly: those 6 tokens are on today's trending list *because* they went up. A coin flip on
them earns −31bps and the difference is not significant. **+21bps net on a universe that returned
+767,931bps buy-and-hold is not a strategy — it is a very expensive way to underperform holding.**

Note the `up%` column tracks liquidity almost perfectly (56% → 100%). **The restriction is a
survivorship filter, measured.**

## 9.3 Long holds on liquid tokens — held-out

Swept to 720 hours (30 days), far beyond round 2's 168h, with take-profits wide enough that the
HORIZON binds rather than the target:

```
  arm                       n   signal    random     diff  Welch t   median
  hold=1h tp=471          556      -84      -264      180     2.91      -81
  hold=6h tp=2000         499        1      -105      106     1.05     -596
  hold=24h tp=2000        516       33      -105      139     1.37     -594
  hold=72h tp=5000        350      141       -69      210     1.31     -687
  hold=168h tp=5000       350      141       -69      210     1.31     -687
  hold=336h tp=20000      216      577       167      411     0.96     -730
  hold=720h tp=20000      216      577       167      411     0.96     -730
```

**This reproduces §8.3's shape exactly, on the liquid universe.** The mean rises with the horizon
(−84 → +577bps) and the Welch t falls with it (2.91 → 0.96). The **median goes the other way**:
−81bps at 1h down to **−730bps** at 30 days. Win rate at the best arm is **7.9%**.

**Longer holds do not amortise the toll. They buy more exposure to a universe that drifted up**, and
the random arm collects it too — the random mean rises from −264bps to +167bps over the same sweep.
The only arm that beats a coin flip significantly (t=2.91) is the *1-hour* one, and it loses money.

Horizons past 72h are byte-identical to 72h: the held-out fold is only 8.5 days long, so a 30-day
horizon cannot bind. **The long-hold question cannot be answered further on 28 days of data**, and
saying so is more honest than reporting the 720h row as though it were a 30-day test.

## 9.4 The named cohort, per token — held-out

Ibrahim named eight tokens. **All eight are in the corpus, all eight are 1% tax, and all eight
appear in the held-out fold.** Reported per token because a pooled mean over 8 names can be carried
by one of them:

```
  token            n   meanNet   medNet    win%      sumBps   swaps/hr        B&H
  Seriouscat      55      +161     +323      58       +8879        115    +529548
  VIBECAT         25       +55     -316      48       +1375         63       -733
  WINK            23       -67     +257      52       -1552         93     +45372
  CryingCat       12      -370     -506      25       -4434         54      -5132
  LEVCAT          10      -421     -592      40       -4206        277   +2780347
  CASHBIRD         8      -553     -550       0       -4420        224   +1141315
  CHUDCAT          8      -312     -632      38       -2497         25     +19092
  INTERN           7      -673     -665       0       -4714         69     +25057

  COHORT POOLED: n=148  mean −78bps  median −428bps  win 44.6%
  RANDOM on the same 8 names, same exit: mean −301bps
  Welch t: 2.29
```

**Two of eight are profitable; six lose. The cohort as a whole loses −78bps per trade.** It does
beat random by +223bps at t=2.29 — the signal is real here too — but **the edge is again smaller
than the toll**, which is the same arithmetic as every other section.

The per-token column that matters most is the last one. **LEVCAT returned +2,780,347bps
buy-and-hold and the strategy lost −421bps per trade on it. CASHBIRD returned +1,141,315bps and the
strategy lost −553bps per trade.** On the two biggest winners in the cohort, **the strategy
converted a 100x+ move into a loss.** That is the clearest statement available of what a 225bps
round trip does to a fast in-and-out strategy on a trending token.

**A methodological note that changed these numbers: symbols on this pad are NOT unique.** `usdg`
has 7 distinct addresses, `cashdog` and `cashcat` 6 each, `seriouscat` 5, and **`CryingCat` has 3 —
one with 38,867 swaps and two with 483 and 10.** Matching the cohort by symbol pooled the real
token with its copycats. The cohort is now pinned to **contract addresses**, resolved once on the
full sample so train and test cannot resolve to different contracts. Any earlier per-name figure
computed by symbol match should be discarded.

## 9.5 The stop-removal result is CENSORING, and the diagnostic is now printed

On the liquid TRAIN universe `stopMode: "none"` posts a **+213bps mean at an 88.3% win rate** — the
most profitable-looking cell produced in three rounds. **It is an artifact and it must not be
reported as a result.**

```
  stop=level   n=342  win 48.5%  net  −56bps
      take-profit  n=183  meanNet   +793bps
      stop         n=159  meanNet  −1033bps

  stop=none    n=188  win 88.3%  net +213bps
      take-profit  n=170  meanNet   +856bps
      end-of-data  n= 16  meanNet  −6449bps   ← the losers that never resolved
      stop         n=  2  meanNet  −1139bps
```

**The trade count falls from 342 to 188.** Without a stop, a losing position is never closed — it
stays open until the data runs out. The winners resolve and are counted; **154 of the losers never
resolve at all.** The 16 that do are booked at −6,449bps. The 88% win rate is survivorship *inside
the trade list*, and it is the same error in miniature as the survivorship bias in the token
universe. `liquid.ts` now prints the exit-reason mix under every stop arm so this cannot be read
off as an improvement again.

## 9.6 The honesty check

```
── BEST HELD-OUT ARM (liquid universe, hold=336h tp=20000), 133 cumulative trials ──
RESULT: indistinguishable from noise

  overfitting  Sharpe 1.54 does NOT survive 133 trials: needed > 20.55 and 4.1 years
               of data, have 0.0. Treat this as noise.
  sample size  216 trades is short of the 816 needed for t > 3
  cost model   INCOMPLETE (slippage, reverts, own price impact — all bias OPTIMISTIC)

CREDIBLE: false
mean 577bps   MEDIAN −730bps   n=216   win 7.9%
Welch t vs random entry on the SAME liquid universe: 0.96
```

**Trials are counted CUMULATIVELY across all three rounds (76 + 45 + 12 = 133).** The same data has
now been interrogated 133 times. Resetting the counter each round is the most common way a
multi-round search launders an overfit into a result, and it is not done here.

## 9.7 The conclusion, stated plainly

**Ibrahim's premise was right about the tokens and wrong about the consequence.** The mature, liquid
tokens he named are genuinely there, they genuinely trade — CryingCat at 831 swaps/hour, LEVCAT at
277 — and restricting to them genuinely improves the strategy. **It improves it from −120bps to
−56bps. It does not make it positive.**

The reason is one number:

```
gross edge, liquid tokens, held-out    +114 … +151 bps   (FLAT across every liquidity band)
round trip on a 1% token                     −225 bps
                                       ─────────────────
                                             −74 … −111 bps
```

**Liquidity was never the binding constraint, so adding liquidity does not relieve it.** The edge is
a short-horizon momentum effect worth ~145bps and the round trip costs ~225bps. That arithmetic is
identical at 40 swaps and at 38,867 swaps.

### What round 3 adds that rounds 1 and 2 did not have

- **§8.2's quality-gate finding is corrected.** Token-level liquidity restriction helps; it was
  never tested. The round-2 gate measured something else.
- **The gross edge is flat in liquidity.** This is new and it is the reason the hypothesis fails.
  A liquidity story would require the gross edge to *rise* with liquidity. It does not.
- **The liquid universe is a survivorship filter, quantified.** `up%` rises 56% → 100% and
  buy-and-hold rises +13,051 → +767,931bps as the bands tighten.
- **On the two biggest cohort winners (LEVCAT +2.78M bps, CASHBIRD +1.14M bps) the strategy lost
  money.** Holding beat trading by six orders of magnitude.

### What this does NOT rule out

Stated so the next round does not re-run this one:

1. **A lower-cost path on the same venue.** Every conclusion here is arithmetic against 225bps. At
   a 0% tax tier the measured gross edge (+114 … +151bps) is profitable at every liquidity band
   immediately. **This remains the single binding constraint and it is a venue term, not code.**
2. **A longer sample.** 28 days cannot test a 30-day horizon; the 336h and 720h arms are identical
   to 72h for that reason. A 6-month collection could answer the long-hold question properly.
3. **A survivorship-free universe.** Every number in three rounds is computed on tokens that are on
   *today's* mcap/trending lists. A universe collected forward from launch — including the tokens
   that died — would move every absolute return DOWN and is the honest way to measure this.

## 9.8 Reproducing round 3

```bash
cd packages/backtest
npx tsx src/liquid.ts          # the search, TRAIN only — 45 trials
npx tsx src/liquid-confirm.ts  # the held-out verification + honesty check
npx vitest run --coverage      # 69 harness tests (50 replay + 19 liquidity)
```

`src/liquidity.ts` holds the universe filters and the matched-random control; `src/liquid.ts`
searches and never reports a held-out number; `src/liquid-confirm.ts` is the only file that does.
That separation is the same one rounds 1 and 2 used.

---
---

# 10. ROUND 4 — THE UNTESTED FAMILIES. A POSITIVE-MEDIAN RESULT THAT BEATS THE COIN FLIP

> **The conclusion of rounds 1-3 — "this venue's 200bps hook tax makes trading unwinnable" — was
> over-drawn, and this round shows why.** It was established for ONE strategy family (short-horizon
> momentum breakout with a tight stop, tested eleven times) and stated as a fact about the venue.
> §9.4 contained the refutation in its own table and it was not read as one: **LEVCAT returned
> +2,780,347bps buy-and-hold while the strategy lost −421bps per trade on it.** A 208bps round trip
> is 2% — irrelevant against a 278x move, and fatal only to a strategy that round-trips constantly.
>
> This round tests the families that do NOT round trip. One of them is positive, on held-out
> tokens, with a positive MEDIAN, and it beats matched random entries on 20/20 seeds.

## 10.0 The answer

**Enter early in a token's life and exit on a wide trailing stop.** On held-out tokens — tokens
that launched later than every token used to choose the rule:

```
ENTRY at swap 20, exit on a 50% trailing stop from the running peak
  n = 72 tokens      mean +37,727 bps      MEDIAN +5,609 bps      win 73.6%

RANDOM entries, same tokens, same exit rule, same cost, 20 seeds:
                     mean −447 bps (median seed)   MEDIAN −2,964 bps
  Welch t            min 2.30   median 2.60   max 2.69     (t>2 on 20/20 seeds)
```

**This is the first arm in four rounds with a positive median that also beats random.** Round 2's
positive arm had a +234bps mean against a **−535bps median** and a Welch t of **0.08**; it was
rejected for exactly that. This one inverts both numbers.

**But `assessOverfitting` at 183 cumulative trials still returns `credible: false`, and that is
reported as prominently as the result.** The reasons are in §10.6 and they are real: n=72, a
held-out window of 1.74 median days, and a cost model that remains INCOMPLETE in the optimistic
direction. **This is a promising, out-of-sample-positive hypothesis. It is not a proven strategy.**

## 10.1 What is new, and why `replay.ts` could not test it

`replay.ts` drives the real `decide()`, which is one strategy: momentum breakout, level stop,
derived take-profit. It has **no trailing stop, no moving average, and no notion of "enter at swap
N of a token's life"** — so none of the four families below could be expressed in it at all. That
is the mechanical reason three rounds never tested them, and it is worth stating plainly: the
search space was bounded by the harness, not by the evidence.

`src/positions.ts` is a new simulator that keeps every guarantee `replay.ts` earned:

| guarantee | how it is enforced | the failure it prevents |
|---|---|---|
| **no lookahead** | entry rules read bars strictly `< i`; fill at `i+1` | pinned by the MUTATION TEST from `replay.test.ts`, re-run against **every** entry rule: corrupt all bars past a cut to a 1000× spike, assert entry decisions are byte-identical |
| **no censoring** | every opened position is closed; unresolved ones are **marked to market** at the last bar and booked `end-of-data` | §9.5's artifact — `stopMode:"none"` posted +213bps at an 88.3% win rate purely because losers never closed |
| **real costs** | `2 × tax + gas`, per the token's **own** tier | pinned by **exact equality** against `roundTripCost` from `@strays/hunt` |

### A cost error this round found and corrected

Rounds 1-3's prose used "**2 × tax + ~30bps gas**". The real gas component from `roundTripCost` at
the 0.01 ETH position size and the measured 0.030024 gwei price is **8bps, not 32** — the shorthand
was ~4x too high. The round trip on a 1% token is **208bps, not 232**.

This was found because `positions.test.ts` asserts equality against `roundTripCost` **exactly**
rather than within a tolerance; an earlier draft of that test used a ±20bps tolerance and the
error passed straight through it. The direction was conservative (every position was overcharged),
so no earlier conclusion is overturned — but the authority is the function the live path uses, and
the constant now matches it.

## 10.2 Method — and a DIFFERENT train/test split, with the reason

**The split for this family is by TOKEN LAUNCH TIME, not by calendar time**, and the difference is
structural rather than a preference.

`load.ts`'s `splitAt` cuts the calendar at day 19.7 and truncates each token's bars there. That is
correct for a strategy that round-trips inside a token's life. It is **wrong for a hold**: a token
that launched on day 5 would have its position amputated at the cut in TRAIN, and its *middle*
handed to TEST with no entry ever taken. The unit of observation for this family is the **token**,
so the split is by token: the earliest-launching 60% are TRAIN, the rest are TEST, each carrying
its full history.

```
Universe: 178 tokens with >=100 realised swaps   (filter applied BEFORE the split, so both
                                                  folds get the same effective filter)
TRAIN = 106 tokens, launched earliest, median observed span 9.61 days
TEST  =  72 tokens, launched latest,   median observed span  1.74 days
```

**The span asymmetry is severe and it is reported first, before any mean**, because it is the
obvious way this result could have been fake: if a 50% trailing stop cannot fire in 1.74 days, the
"result" would be unclosed positions marked to market. §10.4 shows it is not.

## 10.3 What was tested — the four families, on TRAIN

All fitted on TRAIN. Every arm is shown against random entries on the same tokens with the same
exit rule.

| family | arm | TRAIN mean | median | Welch t | verdict |
|---|---|---|---|---|---|
| **4 + 1. Early entry × trailing stop** | entry@20 trail30% | +13,234 | +3,284 | **4.35** | **the strongest t** |
| | entry@20 trail50% | +22,363 | +5,564 | **3.48** | **chosen — see below** |
| | entry@5 trail50% | +44,773 | +8,193 | 2.73 | higher mean, weaker t |
| | entry@100 trail50% | +4,608 | −852 | 3.07 | median goes negative |
| **1. Buy and hold** | first-bar, hold to end | +80,453 | +3,037 | 2.75 | **100% unresolved — censored** |
| | first-bar, trail50% | +54,735 | +13,577 | 3.08 | best median anywhere |
| | first-bar, hold 7d | +89,178 | +1,817 | 2.96 | 23% unresolved |
| **3. Trend following** | donchian-50 trail30% | +4,231 | +215 | 3.44 | weak |
| | donchian-200 trail50% | +71 | −2,787 | 0.78 | **refuted** |
| | ma-20/100 trail50% | +1,341 | −1,836 | 2.09 | **refuted** |
| | ma-50/200 trail50% | −602 | −3,143 | 0.23 | **refuted** |

**Family 3 (classic trend following) is refuted.** Donchian channels and MA crossovers both produce
negative medians and Welch t below 2 at long lookbacks. These are slow signals and 28 days of data
on tokens that live for hours does not contain them.

**Family 1 (buy and hold) works but only with a trailing exit.** Hold-to-end has the highest mean
in the table (+80,453) and is **100% unresolved** — it is the §9.5 artifact in pure form and is
reported only to be dismissed. Adding a trailing stop resolves 97% of positions and *raises* the
median from +3,037 to +13,577.

**`entry@20 trail50%` was carried to TEST, not `entry@20 trail30%`, despite trail30% having the
higher Welch t (4.35 vs 3.48).** Stated plainly because it is a judgement call: trail50% was the
arm proposed before the sweep ran, and switching to trail30% after seeing the TRAIN t-statistics
would be choosing the reported arm by its own search result. Trail30% is the better arm on TRAIN
and it is left as a lead for a future round rather than harvested here.

## 10.4 The held-out result, and the four tests it had to survive

### Test 1 — does it beat the coin flip? **YES, on 20/20 seeds.**

The control is run across **20 seeds, not one**, because a single-seed control on 72 tokens is
itself a coin flip: the random arm's *mean* swings from −1,692 to +3,411bps depending only on which
bars the draws land on. The Welch t is far more stable than the mean, and its range is what is
reported.

```
WELCH t   min 2.30   median 2.60   max 2.69      t>2 on 20/20 seeds,  t>3 on 0/20
```

**The t does not clear the Harvey/Liu/Zhu t > 3 bar on any seed**, and §10.6 counts that against the
result rather than around it.

### Test 2 — is the mean one ticket? **No, but the tail is still doing most of the work.**

```
mean +37,727    MEDIAN +5,609    sd 124,357
p10 −2,446      p90 +58,441      max +879,677
win 73.6%       lost >90% of stake: 0.0%

top 1%  of positions = 31.9% of all profit;  mean without them +25,869
top 10% of positions = 76.1% of all profit;  mean without them  +9,462
```

**The median is the number to read, and it is +5,609bps — 27× the 208bps round trip.** Removing the
best 10% of positions still leaves a +9,462bps mean. This is a genuinely different shape from round
2's positive arm, whose median was −535bps and whose top 1% carried 49% of profit.

### Test 3 — did the positions close? **All 72 of them.**

```
trailing-stop   n=72   mean +37,727 bps
UNRESOLVED (marked to market): 0 of 72 = 0.0%
```

**The censoring worry raised by the 1.74-day span was wrong, and measurably so.** These tokens trade
fast enough that a 50% trail fires within hours — several of the one-slot positions in §10.5 are
held for minutes. No position in the held-out fold needed marking to market.

### Test 4 — the sellability gate, which the research agent called decisive. **It passes.**

`RESEARCH-PROFITABLE-AGENTS.md` §9 names one experiment as the one that matters most: its §4 found
quiet early launches have the best forward medians, while its §6 found quiet pools are exactly the
ones a $5 position cannot **sell**. If those sets fully overlap, the strategy is an illusion.

Applying `sellableBefore` from `replay.ts` unchanged — *the pool has absorbed a real sell of at
least our size, strictly before the entry bar*:

```
  arm                     n      mean    median   win%
  UNGATED                72    +37,727   +5,609    74%
  SELLABLE-GATED         68    +39,816   +5,723    74%

  Tokens passing the gate at swap 20: 68/72
```

**The gate removes 4 tokens and slightly IMPROVES both mean and median. H1(c)(1)'s kill condition is
not met.** The reason is that the `>=100 swaps` universe filter has already excluded the dead pools,
so "quiet enough to be cheap" and "too quiet to exit" do not overlap on this universe.

### The dose-response curve — the strongest evidence here

A single threshold that works is what a search over five values produces by chance. A **monotone
dose-response** is different, because chance does not usually produce an ordering. Measured on
held-out tokens, at seven doses — two of which (200, 500) were **never in the TRAIN sweep at all**:

```
  entry@      n      mean    median   medianWelchT
      5      72    +60,580    +9,714       2.31
     10      72    +47,357    +7,027       2.33
     20      72    +37,727    +5,609       2.60
     50      72    +21,346    +1,058       2.21
    100      72     +9,487    −1,137       2.21
    200      59     +5,895    −1,539       1.57
    500      48     +2,174    −2,983       1.23
```

**Both the mean and the median decay monotonically as entry moves later into a token's life, and
the median crosses zero between swap 50 and swap 100.** The random control enters at a median index
of ~297, so the comparison throughout is "enter early" against "enter anywhere". **The effect is a
gradient, not a threshold.**

## 10.5 THE ONE-POSITION CONSTRAINT — where this weakens badly

A stray holds ~$5 with a 0.001 ETH floor. **It can hold ONE position.** Every mean above is a
per-ticket edge on a basket held in parallel, which no stray can do — §5 caveat 1 made this point
about rounds 1-3 and it applies with far more force to a family that occupies the only slot for
hours or days.

`oneAtATime` takes the first eligible entry in chronological order and refuses every other token
until it closes. No ranking and no foresight, because a ranking rule would need to know which token
was about to run.

```
basket (infinite capital):   n=72   mean +37,727   median +5,609
ONE SLOT, chronological:     n=12   mean +51,135   median +4,502
entries the slot was too busy to take: 60      slot utilisation: 80.5%

ONE-SLOT RANDOM (20 seeds, same construction):  mean −733 bps
WELCH t, one-slot signal vs one-slot random:  min 0.98  median 1.16  max 1.21
```

**The Welch t collapses from 2.60 to 1.16 and the result stops being significant.** The reason is
purely n: the slot takes 12 of 72 available entries and skips 60. The per-ticket edge does not
change — the median is still +4,502bps — but **12 observations cannot establish it.**

And the compounded figure must not be read as a headline. The sequence one wallet could have traded
compounds to **+21,382,518bps**, and that number is **one position**:

```
  CASHBIRD    net +544,653 bps   held 9.3h     <-- 54x, on its own
  FEFI        net  +26,546 bps   held 27.4h
  MONKEYS     net  +20,385 bps   held 1.2h
  CASHDOG     net  +12,985 bps   held 0.1h
  Catalyst    net   +5,540 bps   held 147.1h
  ...  4 losers, worst −4,065 bps
```

**Remove CASHBIRD and the sequence compounds to roughly 38x instead of 2,000x.** A single $5 stray
is far more likely to experience the median than the mean, and the honest statement of the one-slot
result is: **a positive median of +4,502bps over 12 positions, not statistically distinguishable
from random at this sample size.**

## 10.6 The honesty check

```
── entry@swap-20 + 50% trailing stop, HELD-OUT, 183 cumulative trials ──
RESULT: indistinguishable from noise

  overfitting  Sharpe 2.57 does NOT survive 183 trials: needed > 46.74 and 1.6 years
               of data, have 0.0. Treat this as noise.
  sample size  72 trades is short of the 98 needed for t > 3
  cost model   INCOMPLETE (slippage, reverts, own price impact — all bias OPTIMISTIC)

CREDIBLE: false
mean +37,727bps   MEDIAN +5,609bps   n=72   win 73.6%
Welch t vs random, 20 seeds: 2.30 … 2.69   (t>3 on 0/20)
```

**Trials are counted cumulatively across all four rounds: 133 + 35 (the `hold.ts` sweep) + 5
(span-truncation and seed-stability probes) + 10 (the arms in `hold-confirm.ts`) = 183.** Resetting
the counter each round is the most common way a multi-round search launders an overfit into a
result, and rounds 2 and 3 both refused to do it. So does this one.

**What `credible: false` does and does not mean here.** MinBTL's bar (Sharpe > 46.74) is
unreachable on 1.74 days of held-out data by any strategy whatsoever; it is not a bar this result
could have cleared. The meaningful objections are the two beneath it:

- **n=72 is short of the 98 needed for t > 3**, and the Welch t against random peaks at 2.69. By
  conventional standards this is significant; by the standard `assessSampleSize` implements — which
  exists precisely because conventional t > 2 admits too many false discoveries — it is not.
- **The cost model is still INCOMPLETE and every omission biases OPTIMISTIC.** Reverts in
  particular: RESEARCH-STRATEGY §1 measured that 84% of the pad fails a $5 sell quote. §10.4's gate
  addresses this at *entry*, not at *exit*.

## 10.7 The conclusion, stated plainly

**Rounds 1-3 asked "can this strategy be tuned into profit?" and answered no, correctly. They then
generalised that to "this venue is unwinnable", and that generalisation does not follow.** The
tuning space was eleven variants of one family, bounded by a harness that could not express any
other. This round tested four different families and one of them is positive out of sample.

The arithmetic that made the old conclusion look inevitable:

```
momentum edge (held-out)      +145 bps over random
round trip                    −208 bps
                              ─────────
                               −63 bps        <-- lose, every time, forever
```

The arithmetic of the new family:

```
early-entry median (held-out)  +5,609 bps
round trip                       −208 bps      <-- 3.7% of the median move
                               ───────────
                                +5,401 bps
```

**The toll never was the binding constraint. The holding period was.** A 208bps round trip is fatal
to a strategy that pays it every few minutes for a 145bps edge, and nearly irrelevant to one that
pays it once for a move measured in thousands of bps. §9.4 said this in its own data and it was
read as a footnote: on LEVCAT and CASHBIRD, holding beat trading by six orders of magnitude.

### What is established, and what is not

**Established:**
- Early entry beats late entry on held-out tokens, **monotonically**, across seven doses including
  two never used in the search. The median crosses zero between swap 50 and swap 100.
- The result beats matched random on 20/20 seeds and survives the sellability gate that
  `RESEARCH-PROFITABLE-AGENTS.md` named as its kill condition.
- Positions genuinely close: 0% unresolved. This is not the §9.5 censoring artifact.
- Classic trend following (Donchian, MA crossover) is **refuted** on this corpus.

**NOT established:**
- **That a single $5 stray can capture it.** Under the one-position constraint the Welch t falls to
  1.16 and the compounded return is carried by one 54x token. **This is the finding that matters
  most for the product and it is negative-to-inconclusive.**
- **That it clears a t > 3 bar.** It does not, on any seed.
- **That it survives a survivorship-free universe.** Every number in four rounds is computed on
  tokens drawn from *today's* mcap and trending lists. §8.4 measured that bias at +264bps for a
  coin flip and it is larger here, because holds have longer exposure to it. The random control is
  the defence against it and the control does lose — but a universe collected forward from launch,
  including the tokens that died, would move every absolute number DOWN.

### The next experiments, in order

1. **Collect a survivorship-free universe.** Every remaining doubt routes through this. A forward
   collection from launch — including tokens that died — is the single highest-value data task, and
   it is a collection problem, not a modelling one.
2. **Resolve the one-position constraint.** Either measure a fleet of strays as a portfolio (§H5 in
   `RESEARCH-PROFITABLE-AGENTS.md`), or find a selection rule better than "first eligible" that a
   single slot can execute without foresight.
3. **`entry@20 trail30%`** is the better TRAIN arm (t=4.35) and was deliberately not harvested here.
   It should be carried to a fresh fold rather than re-measured on this one.

## 10.8 Reproducing round 4

```bash
cd packages/backtest
HOLD_SEARCH=1 npx tsx src/hold.ts   # the search, TRAIN only — 35 arms, reports nothing held-out
npx tsx src/hold-confirm.ts         # the held-out verification + honesty check
npx vitest run                      # 102 tests (50 replay + 19 liquidity + 33 positions)
```

`src/positions.ts` holds the simulator, the entry rules and the matched-random control;
`src/hold.ts` searches and never reports a held-out number; `src/hold-confirm.ts` is the only file
that does. That separation is the one rounds 2 and 3 used.
