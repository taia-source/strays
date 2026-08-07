# RESEARCH — how profitable on-chain trading agents actually work

> **Why this document exists.** Three rounds of backtesting (`RESULTS.md`) tested **one strategy
> family eleven times** — short-horizon momentum breakout with a tight stop — and concluded the
> venue's ~218bps toll makes it unwinnable. That conclusion is correct *about that strategy* and
> **wrong as a statement about the venue**, and `RESULTS.md` §9.4 contains the proof:
>
> ```
> LEVCAT    buy-and-hold  +2,780,347 bps    momentum strategy  −421 bps/trade
> CASHBIRD  buy-and-hold  +1,141,315 bps    momentum strategy  −553 bps/trade
> ```
>
> A token went 278× and the strategy lost money on it. **That is not a toll problem. That is a
> strategy whose exit rule structurally cannot hold a 278× move.** A −235bps stop and a +471bps
> take-profit mathematically cap the upside at +471bps; the toll then eats it. The eleven tests
> re-measured the same design decision eleven times.
>
> This document researches the strategies that were never tested, and **measures the most promising
> ones directly on our own corpus.**

**Everything below is labelled `[EVIDENCE — OURS]` (measured in `data/series.json` for this
document, reproducible), `[EVIDENCE — EXTERNAL]` (cited), or `[SPECULATION]` (reasoning, not
measured). Ibrahim has been well served by honesty and badly served by confident guesses, so the
labels are not decorative — several headline numbers below carry serious caveats stated inline.**

---

## 0. THE HEADLINE — the untested strategy is profitable on our corpus, with real caveats

The single most important measurement in this document. Entry = **the first swap after a token's
first 15 minutes of life**; exit = **fixed take-profit, hard 24h time limit, every position
force-closed**; cost = the measured `2 × tax + 30bps`:

```
maxHold=24h, 285 tokens with a full 24h of runway (NO censoring — every position closes)

  arm            n     mean net   median net   win%    exit mix
  hold 24h      285     +3,647       −180       45%    timeout:285
  trail 3000    285     +6,403       +197       54%    trail:138 timeout:147
  trail 5000    285    +12,361       +320       56%    trail:113 timeout:172
  TP 1000       285       +530       +842       78%    tp:185 timeout:100
  TP 2000       285       +901      +1,784      74%    tp:158 timeout:127
```

**`TP 1000` returns +530bps per trade with a +842bps MEDIAN and a 78% win rate, after the full
218bps toll.** `[EVIDENCE — OURS]`

The median being **positive and close to the mean** is what distinguishes this from every positive
number in `RESULTS.md`. §8.3's +234bps arm had a **−535bps median** and a 29.8% win rate — a
lottery ticket a single stray could not hold. This one wins on the typical trade.

**And it beats the coin flip that killed rounds 2 and 3.** Same tokens, same exit rule, entry at a
random time in the token's life instead of early:

```
                EARLY entry          RANDOM-time entry        diff    Welch t
  hold 24h    mean +3,647           mean −2,176              +5,823     3.65
  trail 3000  mean +6,403           mean    +88              +6,315     3.18
  TP 1000     mean   +530  med +842 mean   −359  med +800      +888     3.68
  TP 2000     mean   +901 med +1784 mean   −290  med +501    +1,191     4.31
```

**Every arm beats random entry at t > 3** — the Harvey/Liu/Zhu bar that `RESULTS.md` §4 correctly
insisted on and that §8.3's arm failed at t = 0.08. `[EVIDENCE — OURS]`

**THE CAVEATS, STATED UP FRONT AND HONESTLY:**

1. **The out-of-sample fold is too small to confirm.** Splitting by launch time at 60% puts only
   **n=24 tokens** in the held-out fold (the corpus is launch-time-skewed — most tokens launched in
   the last few days). TRAIN TP1000 = +585bps, TEST = **−68bps** on n=24. **That is not a
   refutation and it is not a confirmation; n=24 cannot decide either.** This is the single biggest
   open question and it is what a forward collection must answer.
2. **Survivorship bias is still present and is still large.** The universe is today's mcap/trending
   lists, so dead tokens are under-represented (`RESULTS.md` §5.5, §8.4). The random-entry control
   above **subtracts most of it** — random entry on the same survivorship-biased tokens *loses*
   money, so the +888bps gap is not explained by the universe drifting up. But absolute levels are
   still optimistic.
3. **The 84% sell-failure problem is not modelled.** See §6 — it is the largest execution risk and
   it makes these numbers optimistic.

**`[SPECULATION]`, clearly labelled:** my read is that the mechanism is real (it is
consistent, it beats random at t>3, it has a positive median, and it has an economic story in §2)
but the *magnitude* is inflated by the universe. I would expect a forward test to return
materially less than +530bps. I would not expect it to be negative. **That is a belief, not a
measurement.**

---

## 1. Why the old strategy lost on a 278× token — the arithmetic of the real mistake

This is worth stating precisely because it reframes all three prior rounds. `[EVIDENCE — OURS]`

The shipped design was: enter on momentum, exit at **+471bps** take-profit or **−235bps** stop.

- Maximum possible gross gain per trade: **+471bps**. Toll: **218bps**. Net ceiling: **+253bps**.
- On a token that goes +2,780,347bps, this design captures **+253bps** and then re-enters, paying
  the toll again, repeatedly — and `RESULTS.md` §3 measured that stopped trades gap through to
  **−1030bps** against a −235bps stop.
- So the payoff was **capped at +253bps and uncapped at −1030bps** on the most explosive assets in
  the corpus. Losing money on a 278× is the *predicted* outcome of that design, not an anomaly.

**The strategy's problem was never the toll. It was that its right tail was amputated by the
take-profit while its left tail was left open by gapping stops.** The toll then made a
slightly-negative expectancy clearly negative. Fixing the toll would have produced a marginal
strategy; fixing the payoff shape is what §0 does.

`RESULTS.md` §8.3 came within one step of this: it noted "widening the take-profit does not harvest
the signal — it discards it". **That was right about the momentum signal and it drew the wrong
conclusion.** The correct inference was not "no strategy works" but "the momentum signal is a
short-horizon effect worth ~145bps and is the wrong signal to pair with a wide take-profit." §0
pairs a *different entry* (early-life) with the wide exit, and that combination does beat random.

---

## 2. Buy-and-hold and the payoff shape — the thing never tested

### 2a. The distribution is a lottery, measured `[EVIDENCE — OURS]`

Buy-and-hold from the token's second swap to the end of its data, all 461 tokens:

```
mean +29,805 bps    median +389 bps    up% 57%
p25 −490   p75 +2,472   p90 +11,878   p99 +489,263
frac ≥ +10,000bps (2×):  11.3%
frac ≥ +100,000bps (11×): 3.9%
frac ≤ −5,000bps:         0.2%

CONCENTRATION:  top 1 token = 21.4% of the total
                top 3 tokens = 54.3%
                top 10 tokens = 79.4%
```

**Three tokens are half of all the money.** `[EVIDENCE — OURS]` This is the defining fact and every
strategy below is judged against it.

Note the left tail is *thin*: only 0.2% of tokens lost more than 50%. **The downside is bounded in
practice while the upside is not** — the opposite of the risk profile the tight stop was designed
for.

### 2b. What the literature says about stops and letting winners run `[EVIDENCE — EXTERNAL]`

- **Trend-following's entire documented edge is positive skew from letting winners run.**
  Greyserman & Kaminski's *Trend Following with Managed Futures* documents, on data back ~800
  years, that the strategy's positive skewness "is related to the property of adding to winners and
  cutting losers", and that trend followers posted positive returns in **70% of major equity bear
  markets since 1980**.
  ([Hedge Fund Journal](https://thehedgefundjournal.com/trend-following-with-managed-futures/),
  [CFA Institute review](https://rpc.cfainstitute.org/research/financial-analysts-journal/2015/trend-following-with-managed-futures))
- **A tight stop on a positively-skewed asset converts the payoff to negatively-skewed.** This is
  the documented failure mode of pairing Kelly-style sizing with hard stops on fat-tailed assets:
  Kelly under a normality assumption "systematically overestimates the optimal position for
  negatively skewed distributions", and practitioners treat Kelly as **a ceiling, not a target**,
  using **1/4 to 1/2 Kelly**. ([arXiv 2508.16598](https://arxiv.org/html/2508.16598v1),
  [Lototsky, USC — Kelly for Lévy processes](https://dornsife.usc.edu/sergey-lototsky/wp-content/uploads/sites/211/2023/11/Kelly-Fin-SIFIN-Final.pdf))
- **Our own data confirms the mechanism directly.** `RESULTS.md` §3's stop sweep found widening the
  stop raised the win rate 43.6% → 65.1% while the mean *worsened* — but every arm still had the
  **+471bps take-profit capping the upside**. The stop was swept; **the cap never was, in
  combination with an early entry.** That is the untested cell.

### 2c. Position sizing as the substitute for stops `[EVIDENCE — EXTERNAL]` + `[SPECULATION]`

The literature's answer to "how do you survive without tight stops" is **size, not stops**: many
small positions, each small enough that a total loss is survivable. `[EVIDENCE — EXTERNAL]`
(fractional Kelly, above).

**For us this is a hard constraint, not a choice.** A stray holds ~$5 and the position floor is
0.001 ETH. `[SPECULATION]` — a single stray cannot diversify across 30 tokens at $5 of capital;
diversification has to happen **across strays**, at the fleet level, with each stray taking one
concentrated bet. The fleet then holds the portfolio. This is an architectural conclusion and it
has not been measured.

---

## 3. What actually-profitable on-chain bots do — mechanisms, named

`[EVIDENCE — EXTERNAL]` for the mechanisms; the applicability column is `[SPECULATION]` unless
marked otherwise.

| Mechanism | How it makes money | Applicable here? |
|---|---|---|
| **Sniping (launch/LP-add)** | Buy in the first block(s) of a pool, before price discovery. Bots "scan the blockchain to spot recently created liquidity pools" ([CryptoSlate](https://cryptoslate.com/guides/rug-pull/)) | **PARTLY.** We can see launches via the pad API. But we cannot win a latency race, and §4 shows the *first* swap is not where our edge is. |
| **Copy-trading / smart-money following** | Mirror wallets with proven PnL within milliseconds ([GMGN](https://gmgn.ai/blog/how-to-track-copy-solana-smart-money/)) | **TESTABLE.** We have per-swap `amount0/amount1`, so wallets are inferable from trades. See H3. |
| **Dev/insider-wallet tracking** | Track the deployer; exit when the deployer sells | **TESTABLE** via the pad's holders endpoint. |
| **Bundle/sniper detection (as a NEGATIVE filter)** | High sniper counts at launch "could suggest it is a rug pull, pre-planned by insiders" ([Finbold](https://finbold.com/2-signals-that-a-memecoin-is-a-rug-pull-created-to-get-your-money/)) | **TESTABLE** — the pad API exposes sniper/bundle counts. See H4. |
| **Momentum scalping (2-5% targets, 1% stops)** | What the retail bot vendors sell | **REFUTED FOR US** — this is exactly the family `RESULTS.md` refuted 11 times. |

**A warning about this literature, stated plainly.** `[EVIDENCE — EXTERNAL]` Searches for
"profitable memecoin bot" return overwhelmingly **vendor marketing, not evidence** — bot-selling
blogs and Medium posts with unfalsifiable claims ("AI predicts 70% of pumps", "turned 2 SOL into
15 SOL"). None of it is peer-reviewed and none of it publishes a methodology. **I did not find a
single credible published backtest of a profitable memecoin bot.** The honest summary of the
external literature is:

> **The base rates are terrible and are the best-measured thing in this field.** Solana wallet
> data: **11.5M wallets unprofitable vs <10M profitable**, and **only 0.6% of wallets ever made
> more than $10,000**. On pump.fun in one month, **~50% of wallets lost money and ~96% either lost
> or made under $500**. Fewer than **2% of pump.fun tokens ever graduate** to a major DEX.
> ([Bitquery](https://bitquery.io/blog/easy-money-memecoin-retail-investors),
> [CCN](https://www.ccn.com/analysis/crypto/meme-coins-pump-fun-solana-platform/),
> [arXiv 2512.11850](https://arxiv.org/html/2512.11850v3))

**So: Ibrahim's friends may well be profitable — but the population base rate says the large
majority of participants are not, and survivorship in who reports their results is severe.** That
is not a reason to stop; it is a reason to trust our own measurements over anyone's claims,
including the ones in this document.

---

## 4. Entry timing — where the measurable edge actually is `[EVIDENCE — OURS]`

I measured features in a window after each token's first swap, then measured forward return from
the first swap *after* that window (no lookahead). Quintiles, 15-minute window, n=335:

```
by EARLY-WINDOW RETURN (price change during the first 15 min):
  Q1  ret [−3243 .. −358]   fwdEnd mean +7,066  median +1,568   up% 81%
  Q2  ret [ −352 .. +143]   fwdEnd mean +7,029  median   +952   up% 69%
  Q3  ret [ +153 .. +2161]  fwdEnd mean +4,499  median     +0   up% 45%
  Q4  ret [+2205 .. +10770] fwdEnd mean +3,935  median −2,014   up% 22%
  Q5  ret [+11246 .. +625k] fwdEnd mean +10,154 median −5,462   up% 22%
```

**This is the most actionable finding in the document and it is the exact opposite of the shipped
strategy.** `[EVIDENCE — OURS]`

- **Tokens that went DOWN in their first 15 minutes had an 81% chance of being up later, with a
  +1,568bps median.**
- **Tokens that already ripped (+112% or more) had a 22% chance of being up later, with a −5,462bps
  median.**
- The pattern is **monotone across all three windows tested (5min, 15min, 60min)** and monotone
  across quintiles — it is not a single lucky cell.

**The shipped strategy bought Q4/Q5 by construction.** It was a momentum-breakout entry: it fired
*because* price had risen over the lookback. It was systematically buying the quintile with a
−5,462bps median. **This, not the toll, is why it lost money on trending tokens.**

The same reversal shows in the volume/activity features (all `[EVIDENCE — OURS]`):

```
by EARLY-WINDOW SWAP COUNT (15min):
  Q1  2−4 swaps       fwdEnd mean +12,639  median +770   up% 64%
  Q5  177−2710 swaps  fwdEnd mean  +7,535  median −4,744 up% 30%
```

**Quiet launches outperform frantic ones on the median by a wide margin.** `[SPECULATION]` for the
mechanism: heavy early activity is consistent with bundled/sniped launches where insiders hold
supply and distribute into retail — which is exactly what the rug-pull literature in §3 describes.
The measurement is solid; the causal story is not proven.

**Caveat, stated honestly:** the *means* do not order as cleanly as the medians (Q5 has a high mean
because it contains some of the biggest winners). A mean-maximising strategy might still want Q5
exposure. **The medians order cleanly and monotonically, and the median is what a single $5 stray
holding one position actually experiences.**

---

## 5. Exit discipline `[EVIDENCE — OURS]`

From the §0 table, the exit-rule ranking is unambiguous and it depends on **what you are
maximising** — this is a genuine trade-off, not a single best answer:

| Objective | Best exit | Result |
|---|---|---|
| **Median / win-rate** (what one stray feels) | **TP 1000-2000, 24h cap** | median **+842 … +1,784bps**, win **74-78%** |
| **Mean / fleet aggregate** | **trailing 5000bps** | mean **+12,361bps**, median only +320 |
| Worst | naive hold to timeout | mean +3,647, median **−180** |

**Fixed TP wins the median; trailing stops win the mean.** `[EVIDENCE — OURS]` They are optimal for
different objectives, and the choice is a product decision about whether a stray should reliably
make a little or occasionally make a lot.

**The censoring check — the §9.5 trap, avoided.** `RESULTS.md` §9.5 correctly caught a fake +213bps
result caused by losers never closing. **I designed the §0 test to make that impossible: every
position is force-closed at the 24h deadline, and the universe is restricted to tokens with a full
24h of runway, so `timeout` is a real fill and not a dropped trade.** The exit mixes in §0 are
printed for exactly this reason — `TP1000` shows `tp:185 timeout:100`, i.e. all 285 positions
resolve. `[EVIDENCE — OURS]`

**Time-based exits do the heavy lifting.** The 24h cap is what makes the numbers honest and it is
also what makes them good: it forces re-deployment of capital instead of holding a dead token.

---

## 6. What kills bots — and which one dominates for US `[EVIDENCE — OURS]`

For this venue the answer is not rugs, not MEV, not fee drag. It is measured in
`packages/hunt/RESEARCH-STRATEGY.md` §1 and it is decisive:

```
N=100 newest tokens:  buy-quote failures = 0   SELL-QUOTE FAILURES = 84   sellable = 16
```

**84% of the pad cannot be sold at $5.** Critically, that document also proved this is **NOT 84%
honeypots** — decoding the reverts gives two causes: 46 are hook refusals on pools that have
**never traded** (unwarmed, not malicious), and 38 are genuine `NotEnoughLiquidity` depth refusals.

**This is the binding execution constraint on every strategy in this document**, and it interacts
badly with §4's finding: §4 says *quiet* launches have the best forward medians, but §6 says quiet
pools are exactly the ones that cannot be exited. **These two findings are in direct tension and
resolving it is the highest-priority experiment (H1 below).**

The clean pre-filter already exists and is measured:

```
marketCapEth > 1.36 :  15/15 sellable (100%)      [1.356 ETH = the untraded seed mcap]
marketCapEth ≤ 1.36 :   1/85 sellable (1%)
```

Ranked by what actually costs us money, on this venue: `[EVIDENCE — OURS]` for 1-2,
`[SPECULATION]` for 3-4.

1. **Unsellable positions (84% of the pad).** Dominant. Bounded only by the sell-quote check.
2. **Fee drag / overtrading.** Second, and quantified: `RESULTS.md` proves 218bps × high turnover
   is fatal. **The fix is fewer, longer trades — which is what §0 does** (1 trade per token per 24h
   vs 1.3 trades/token in hours).
3. **Rugs.** Real but our left tail is thin (0.2% of tokens lost >50%) — because the survivorship-
   biased universe under-represents them. **Understated in our data.**
4. **MEV/sandwiching.** Likely negligible at $5 on a low-traffic chain — not worth attacking.

---

## 7. RANKED, TESTABLE HYPOTHESES

Ranked by expected value given our constraints. Each is directly implementable by another agent
against `data/series.json` and the pad API.

---

### **H1 — [HIGHEST EV] Early-life entry + fixed take-profit + hard time cap, gated on sellability**

**(a) Mechanism.** Buy the first swap after a token's first ~15 minutes, **only if a $5 sell quote
succeeds**. Exit at **+1000-2000bps**, or force-exit at **24h**, whichever comes first. One
position at a time. 1%-tax tokens only.

**(b) Why it beats 218bps.** It does not rely on a 145bps momentum signal at all. It relies on the
measured payoff shape: median forward return from an early entry is **+842bps net at TP1000**, ~4×
the toll. It pays the toll **once per 24h** instead of ~1.3 times per few hours. `[EVIDENCE — OURS]`

**(c) What to measure to confirm or kill it.**
1. **The tension in §6 must be resolved first.** Re-run §0 restricted to tokens that would have
   passed a sellability proxy at entry time (`RESULTS.md` §5.2's "pool has absorbed a real sell of
   ≥ our size before this bar"). **If the +530bps survives that restriction, this is real. If it
   collapses, the strategy is only profitable on tokens we cannot exit, and it is dead.** This is
   the single highest-value experiment in this document.
2. Sweep TP ∈ {500, 1000, 2000, 5000} × maxHold ∈ {6, 24, 72}h. Report **median, not just mean.**
3. Random-time-entry control on the identical universe (must clear Welch t > 3; §0 gets 3.68).
4. Print the exit-reason mix under every arm (`tp:` / `timeout:`) to prove no censoring.
5. **Count these as new trials in the cumulative MinBTL counter (now 133+).**

**(d) Evidence.** §0 and §4 above, `[EVIDENCE — OURS]`; skew/trend-following literature §2b
`[EVIDENCE — EXTERNAL]`.

**Kill condition:** median net ≤ 0 after the sellability gate, or Welch t vs random < 2.

---

### **H2 — [HIGH EV] The fade: avoid tokens that already ripped**

**(a) Mechanism.** A **negative filter**, usable as an overlay on any strategy: **refuse any token
whose first-15-minute return is in the top quintile (> ~+11,000bps / +110%).** Optionally prefer
the bottom two quintiles.

**(b) Why it beats 218bps.** It does not generate return; it **removes the worst cell**. Q5 has a
−5,462bps median and a 22% up-rate. Excluding it should lift the median of any strategy by more
than the toll. **This is also a direct refutation of the shipped entry rule**, which selected *for*
Q4/Q5. `[EVIDENCE — OURS]`

**(c) What to measure.** Re-run H1 with the universe split by early-window-return quintile. Confirm
monotonicity of the median across quintiles at 5/15/60min windows (it held at all three for me).
Then test the filter as an overlay: does excluding Q5 raise the median net?

**(d) Evidence.** §4 `[EVIDENCE — OURS]` — monotone across 3 windows and 5 quintiles.

**Kill condition:** the quintile ordering is not monotone in the median out of sample.

---

### **H3 — [MEDIUM EV] Wallet-level copy-trading from our own swap corpus**

**(a) Mechanism.** Trades in `series.json` carry `amount0`/`amount1` per swap. Identify wallets
(via the pad `/trades` endpoint or by enriching logs with `tx.from`) that were **early buyers of
tokens that later 10×'d**, then test whether those wallets' *subsequent* first-buys predict
forward return.

**(b) Why it beats 218bps.** If wallet skill persists, following a skilled buyer inherits their
entry timing. Copy-trading is the most widely-deployed real mechanism in §3.

**(c) What to measure.** Split the window in time. On TRAIN, rank wallets by realised PnL. On TEST,
measure forward return of tokens those wallets buy vs random. **The critical test is
persistence:** does TRAIN-period wallet PnL predict TEST-period wallet PnL at all? If not, kill
immediately — the ranking is noise.

**(d) Evidence.** `[EVIDENCE — EXTERNAL]` mechanism is real and widely deployed
([GMGN](https://gmgn.ai/blog/how-to-track-copy-solana-smart-money/)). But note the honest
counterweight from the same literature: *"the wallets at the top of every smart-money dashboard are
almost never humans, and the ones that are humans are almost never reproducible."*
([Medium/Baldwin](https://medium.com/@nathan.baldwin_31153/copy-trading-on-solana-how-to-find-alpha-wallets-and-avoid-bots-26182d750bb2))
**Rank-3 rather than rank-1 because persistence is unproven for us.** `[SPECULATION]` that it
exists on this pad.

**Kill condition:** TRAIN wallet PnL does not correlate with TEST wallet PnL.

---

### **H4 — [MEDIUM EV] Sniper/bundle count as a negative filter**

**(a) Mechanism.** The pad's holders endpoint exposes **sniper and bundle counts**. Refuse tokens
above a threshold.

**(b) Why it beats 218bps.** Same logic as H2 — it removes losers rather than finding winners.
Independent evidence that high sniper counts mark insider-planned distribution. And §4's finding
that frantic early activity predicts a **−4,744bps median** is plausibly the same effect measured a
different way. `[EVIDENCE — OURS]` for the activity proxy.

**(c) What to measure.** These fields are **only available as of today**, so a historical backtest
is lookahead (`RESULTS.md` §5.4). Two honest options: (i) use §4's early-swap-count as a
**historical proxy** and test it properly on the corpus — this is legitimate and cheap; (ii) record
sniper counts **forward** from now for a clean prospective test.

**(d) Evidence.** §4 `[EVIDENCE — OURS]`; [Finbold](https://finbold.com/2-signals-that-a-memecoin-is-a-rug-pull-created-to-get-your-money/) `[EVIDENCE — EXTERNAL]`.

**Kill condition:** the proxy shows no median separation; or, prospectively, no separation in
forward-recorded data.

---

### **H5 — [MEDIUM EV, but ARCHITECTURAL] Fleet-level diversification instead of per-stray stops**

**(a) Mechanism.** Stop trying to make one stray's single trade safe. Let each stray take **one
concentrated, un-stopped, time-capped bet**, and get risk control from **many strays across many
tokens**.

**(b) Why it beats 218bps.** The payoff is a lottery: **3 tokens are 54% of all returns**. A
strategy that can only hold one position at a time will, with high probability, **miss all three**.
Diversification is not a nicety here; it is the only way to be exposed to the tail that carries the
entire mean. `[EVIDENCE — OURS]` for the concentration; `[EVIDENCE — EXTERNAL]` for fractional
Kelly (§2c).

**(c) What to measure.** Simulate N strays (N ∈ {1, 5, 20, 50}) each holding one position, entering
per H1, drawing tokens as they launch in real time. Report the **distribution of fleet outcomes**,
not the mean: specifically P(fleet ends up) and the 10th percentile. **The key number is how N
changes the probability of catching at least one tail token.**

**(d) Evidence.** §2a, §2c.

**Kill condition:** this one cannot really be "killed" — it is a portfolio-construction fact. But
it can be shown *insufficient* if P(fleet up) stays low even at N=50.

---

### **H6 — [LOW EV — DO NOT PRIORITISE] Trailing stops for mean maximisation**

**(a) Mechanism.** Enter per H1, exit on a **5000bps trailing stop** from the running peak.

**(b)** Highest mean measured anywhere in this document (**+12,361bps**), and it beats random at
t = 2.01. `[EVIDENCE — OURS]`

**(c) What to measure.** Same harness as H1. **Report the median prominently** — it is only +320bps
vs TP1000's +842bps.

**(d)** Ranked last **despite the highest mean** because its mean is tail-driven, its Welch t is the
weakest of the arms tested (2.01, below the t>3 bar), and `RESULTS.md` §8.3/§9.3 established that
tail-driven means on this corpus are where survivorship hides. **A single $5 stray is far more
likely to experience the median than the mean.**

---

## 8. What NOT to re-test

To stop round 4 from repeating rounds 1-3. All `[EVIDENCE — OURS]`, from `RESULTS.md`:

- **Momentum-breakout entry with a tight stop.** 11 tests, 3 rounds. Refuted. §4 now explains
  *why*: it selects the worst quintile.
- **Retuning lookback / stop width / drawdown halt / score threshold / volume floor /
  participation floor / hold horizon / edge multiple.** All eight swept, all lose across their
  entire range (§8.7, §9.7).
- **`EDGE_MULTIPLE` as a selectivity control.** Proven a tautology (§8.5) — it refuses nothing.
- **Wide take-profit on a momentum entry.** Profitable-looking, but a coin flip earns the same
  (Welch t = 0.08) and the source is survivorship (§8.3, §8.4). **Note H1 is NOT this** — it pairs
  a wide exit with a *different, early-life* entry and does beat the coin flip at t = 3.68.
- **Liquidity restriction as a route to profit.** Gross edge is flat across liquidity (§9.2).

---

## 9. The honest summary

**What changed:** the conclusion "this venue is unwinnable" was over-drawn. It was established for
**one strategy family** and stated as a fact about the venue. The corpus contains a
positive-median, coin-flip-beating result that three rounds did not find, because all three rounds
searched the same neighbourhood.

**What has NOT changed:** every caveat in `RESULTS.md` §5 still applies to the numbers above —
survivorship bias, 28 days of one regime, an incomplete cost model that biases **optimistic**, and
now a **held-out fold of only n=24** that cannot confirm the headline. The cumulative trial count
is 133+ and must keep incrementing.

**The one experiment that matters most.** §4 says quiet, faded launches have the best forward
medians. §6 says quiet pools are the ones we **cannot sell**. **If those two facts fully overlap,
H1 is an illusion and the venue conclusion stands. If they only partly overlap, H1 is a real
strategy.** That is H1(c)(1), it is cheap, and it should be run before anything else in this
document is built.

**Stated plainly for Ibrahim:** the earlier answer was too confident. There is a real, measurable
result here that the previous rounds missed, and it comes from buying quiet early tokens and
holding them for hours rather than chasing pumps for minutes. It is **not yet proven** — the
out-of-sample sample is too small and one specific experiment could still kill it. It deserves to
be tested properly rather than announced.
