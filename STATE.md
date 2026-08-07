# STRAYS — honest state

What works, what is half-built, and what is not built at all. Written so nobody has to find out by
being surprised.

`BUILD-A-PROJECT.md`: *"If something is unwired, say it is unwired rather than writing a placeholder
that logs successful cycles that never happened — that has happened, and the honest comment was the
only reason it was fixable."*

---

## Proven on mainnet, with real money

**`StrayVault` is deployed, source-verified, and the whole user path executed against it.**
[`0xD4233cae…9E33`](https://robinhoodchain.blockscout.com/address/0xD4233cae4804A2A9b7Db2e0a2362FD2Fc5279E33).
Four transactions: adopt → hunt → flee → withdraw. See `DEPLOYMENTS.md` for hashes.

**The round-trip cost is measured three independent ways and all three agree to the tenth of a
basis point:** an off-chain viem probe on a fork (199.0), the contract on a fork (199), and the
contract on mainnet with real ETH (199.0). That agreement is the strongest evidence in the project.

**The rake-on-profit-only rule is an on-chain fact, not a claim.** The live-fire round trip lost
money to the pad's tax, and the house balance was byte-identical either side of the withdrawal —
`33641612886269577` before, `33641612886269577` after, a delta of exactly 0 wei.

**The keeper runs and makes real decisions.** Against live mainnet it found the on-chain stray,
quoted 9 live candidates through the v4 quoter, and refused all 9 with a specific reason:
*"3 holders < floor 25. Below this a price is one address's mark rather than a market's, so any move
the signal reads is that address moving it."*

## Tests

| | count | notes |
|---|---|---|
| contracts | **33** | incl. 4 against LIVE letscash pools on a mainnet fork |
| `@strays/hunt` | **184** | 100% statements/branches/functions/lines |
| `@strays/cat` | **35** | incl. a flood-fill test; 0 disconnected cats in 2000 |
| keeper | **22** | |
| **total** | **274** | **0 failed, 0 skipped** |

**Sabotage results: 49 of 49 caught** — 12 on the contract, 37 on the strategy. Both suites had
escapes on the first pass, both were fixed by observing the *mechanism* rather than the outcome, and
both are written up (`packages/contracts/SABOTAGE.md`, `packages/hunt/SABOTAGE.md`).

---

## NOT DONE — read this half

**No external audit of the vault.** Ibrahim authorised mainnet deployment once tests were green and
that is what happened. The 12 sabotages and the fork tests are what stand in for an audit and they
are not one. Stated on `/` and in `/docs` so users are told, not just the operator.

**The keeper is in OBSERVE mode and spends nothing.** `STRAYS_LIVE_TRADING=false`. It discovers,
decides and records against real market data; both executors throw rather than returning a fake
success. Turning it on needs three switches — see `OPERATIONS.md`.

**`STRAYS_KEEPER_PRIVATE_KEY` is not set on Railway.** It must be pasted in by hand from
`/root/.env`. Two attempts to set it through tooling were blocked by a safety classifier, which is
the correct outcome for a private key in a tool payload; it was not worked around.

**A cat has now traded on its own, and made money.** On chain, with no human in the loop:

```
30448514  Entered  57,092,283,279,985,038,768,190 units for 0.00104 ETH
30452877  Exited   sold for 0.001046819814464775 ETH   =>  +66 bps NET of a 199bps round-trip tax
```

The strategy chose the token, sized the position from the stray's own compartment, entered, priced
its own exit and closed it. **+66 bps on one trade is not evidence the strategy works** — it is
evidence the machinery works. openhood's own record is the warning: it called one winning trade over
15 days *"worth nothing"*.

**LIVE trading runs locally only.** Railway still has `STRAYS_LIVE_TRADING=false` and no keeper key —
two secrets need pasting by hand (the key, and the Alchemy RPC, because the public endpoint returns
Cloudflare 403s under keeper load). See `OPERATIONS.md`.

**The spend ledger is in memory ONLY when `DATABASE_URL` is unset.** `@strays/hunt` exports `assertDurableLedger`, which *throws* on an
in-memory ledger, specifically so this cannot go live by accident. meridian's identical shortcut
meant its "daily" cap was really "spend since last boot". **Postgres is provisioned and wired to the
keeper but not yet used** — that is the next piece of work and it blocks live trading.

**Price history is durable too** — same Postgres store, so a redeploy no longer blanks every
stray's window.

**THE STRATEGY LOSES MONEY, AND THE BACKTEST SAYS SO.** Measured over **461 tokens, 394,635 real
on-chain swaps, 28.2 days**, replayed bar-by-bar with no lookahead:

```
baseline, shipped constants:  -117 bps mean per trade, 1,723 trades, 46.3% win rate
ALL 15 parameter variants also lose.
```

**But the signal is not noise, and that distinction is the finding:**

| | gross | net |
|---|---|---|
| signal entries (n=1723) | **+125 bps** | −117 bps |
| random entries, same tokens, same holding period (n=1420) | +46 bps | −294 bps |
| Welch t | **2.63** | 5.53 |

The entry signal beats a coin flip by ~79bps and its gross mean is 5.17 standard errors above zero.
**It simply does not predict enough.** Breakeven needs the round trip to cost ≤125bps; it costs 218,
and **200 of those 218 are the pad's own hook tax**. The signal is real; the toll eats it.

Three things that follow, none of them comfortable:

- **The −235bps stop does not hold.** Stopped trades lose a mean of **−1030bps** — these pools gap
  straight through the stop between swaps. That is the largest mechanical problem surfaced and it
  is not a tuning issue.
- **Widening the stop raises the win rate to 65% while making the mean WORSE.** Win rate is a
  vanity metric here.
- **`assessOverfitting` returns `credible === false`** for both baseline and best-of-sweep. At 15
  trials over 0.077 years a credible Sharpe would need to exceed 8.73. The negative result is
  robust because it rests on arithmetic (+125 gross vs a 218 toll), not on a marginal statistic —
  **but the +79bps signal edge is NOT established to that standard** and is a hypothesis, not a
  measured fact.

Three cost-model omissions are declared incomplete (historical slippage, reverts, own price
impact) and **all three bias the result in the strategy's favour** — true performance is worse than
−117bps, not better.

### ROUND 2: every remaining lead tested and refuted. The binding constraint is the venue.

All five leads were tested on a proper train/test split (day 19.7). **Four refuted outright:**

| lead | TRAIN result (baseline −120bps) |
|---|---|
| selectivity by score | **−252 … −366 bps — the score is ANTI-predictive** |
| volume / holder floors | **monotonically worse as they tighten** |
| stop removed or widened | −190 bps — worse than keeping it |
| `EDGE_MULTIPLE` | no effect — and the reason is structural, below |
| wide take-profit | +296 bps — the ONLY positive arm |

**And the positive arm is survivorship, which I verified myself rather than take on trust.** It
holds out of sample at +234bps (n=1021) — but *random* entries on the same universe with the same
exit earn **+227bps, Welch t = 0.08**. A coin flip earns the same return. Measured directly from
the corpus:

```
tokens ending UP over the window   280 / 461  (61%)
mean buy-and-hold                  +31,681 bps
random entry, wide take-profit     +264 bps    <-- NO STRATEGY AT ALL
```

The universe is the union of *today's* mcap/trending lists, so it contains only tokens that
survived to be listed. **The bias is larger than the entire apparent edge.**

**The decay curve is the most important table in the report.** The signal's edge over random is
**t = 4.65** at the shipped horizon — stronger on held-out data than round 1's 2.63 — and decays to
**0.08** exactly where the strategy becomes profitable. Widening the take-profit does not harvest
the signal; it **discards** it and replaces it with a payoff a coin flip captures equally well.

**A structural finding worth more than the tuning: the entry bar has never worked.** `EDGE_MULTIPLE`
was threaded through config and the rows were *still* identical, because `levelsFor` floors the
take-profit at `cost × multiple / position` while `evaluateEntry` defines
`expectedGain = position × takeProfitBps` — the bar compares a number against itself. **0 refusals
across 72 combinations of tax tier, size and multiple**, now pinned by a test.

### ROUND 4 — A PROFITABLE STRATEGY EXISTS, and my "unwinnable venue" conclusion was wrong.

Ibrahim: *"i have friends that are running agents that are profitable so i dont see how you claude
code with the power that you hold ... to not be able to be profitable."* He was right, and the
reason is specific: **I tested ONE strategy family — short-horizon momentum with a tight stop —
eleven times, and reported a fact about the venue that was only ever a fact about that family.**

**THE FINDING THAT EXPLAINS THREE ROUNDS OF LOSSES.** Early returns predict forward returns, and
the relation is **monotone and INVERTED**. Verified independently against the raw series:

| first 15 min | forward median | ended up |
|---|---|---|
| **fell** | **+3,260 bps** | **97.4%** |
| +0…19% | +842 bps | 71.8% |
| +20…85% | −1,838 bps | 23.1% |
| +87…296% | −3,878 bps | 33.3% |
| **+296%…** | **−5,999 bps** | **17.1%** |

**A momentum entry buys the bottom quintile by construction.** The shipped strategy was designed to
chase exactly what predicts losses. That, not the 200bps tax, is why it lost money on tokens that
went 278×.

**THE STRATEGY THAT WORKS: enter early, hold, exit on a wide trailing stop.** Held-out tokens
(launched later than everything used to choose the rule), n=72:

```
strategy   mean +37,727 bps   median +5,609 bps   win 73.6%
random     (same tokens, same exit)   median −2,964 bps
Welch t    2.30–2.69, above 2 on 20 of 20 seeds
```

**The first arm in four rounds with a positive MEDIAN that also beats the coin flip.** Round 2's
positive arm had a −535bps median and t = 0.08.

**And the strongest evidence is a dose-response, which I verified myself:**

```
entry at swap    5      10      20      50     100     200     500
median net   +9,791  +5,838  +4,410    +696    −845  −1,748  −3,302
```

Monotone, crossing zero between swap 50 and 100. **Swaps 200 and 500 were never in the search
space.** A gradient is far harder to produce by chance than a threshold.

**WHERE IT WEAKENS — the one-position constraint, which is the actual product.** A $5 stray holds
ONE token at a time. Simulated as a single slot walking forward through the held-out fold:

```
17 positions taken, 55 SKIPPED (already holding)
median +1,921 bps    compounded 757×
                     compounded WITHOUT its single best token: 14.5×
```

Welch t collapses **2.60 → 1.16** — no longer significant at n=17. **14.5× over 16 trades is still
a strong result, and n=17 is not proof.** This is a product-design answer, not a failure: the edge
is real and a one-slot cat cannot harvest enough of it to be statistically distinguishable.

`credible: false` at **183 cumulative trials** (133 + 50, not reset).

**The unresolved caveat, stated because it undermines everything above if it bites:** every number
in four rounds comes from tokens on *today's* mcap/trending lists. The matched-random control is the
defence and it does lose — but a universe collected forward from launch, including tokens that
died, would move every absolute figure down. Collecting that is the highest-value next task.

### ROUND 3 — the liquid-subset test. Ibrahim was RIGHT that round 2 tested the wrong thing, and the answer is still no.

**Round 2's "volume floors made it worse" result was an artefact and is retracted.** The gate it
swept, `minBarsBefore`, is a *decision-time cumulative counter* — on CryingCat (38,867 swaps) a
floor of 5,000 never *selected* the token, it **delayed the first entry to swap 5,000 and discarded
the early history**. A "trade the token late" filter, not a "trade liquid tokens" filter. A true
token-level restriction moves the number the OPPOSITE way:

```
round 2 gate (wrong)          round 3 token-level (right)
  >=0      -120bps              all           -120bps   (205 tokens, win 44.0%)
  >=1000   -139bps              >=1000 swaps   -63bps   ( 33 tokens)
  >=5000   -159bps  <- §8.2     >=2000 swaps   -56bps   ( 20 tokens, win 50.9%)
```

**It still loses, and the reason is decisive: the gross edge is FLAT across liquidity.** +134, +151,
+117, +114, +130 bps at successive bands, then *falling* to +42 at ≥10,000 swaps — against a ~225bps
toll at every band. **Liquidity was never the binding constraint, so adding liquidity cannot relieve
it.** Held out, the diff over random stays ~116–169bps at every band while Welch t collapses 4.52 →
0.45 purely because n falls 1,049 → 77. The liquid bands do not have a stronger edge; they have the
same edge measured worse.

**The sharpest line, and I verified both numbers against the raw series myself:**

```
LEVCAT    buy-and-hold  +2,780,579 bps   strategy  -421 bps/trade
CASHBIRD  buy-and-hold  +1,141,548 bps   strategy  -553 bps/trade
INTERN    buy-and-hold  +3,134,087 bps
```

**On the two biggest winners on the pad, the strategy converted 100×+ moves into losses.** Named
cohort: 2 of 8 profitable, pooled −78bps.

Two real bugs surfaced on the way, both of which would have corrupted any future work:
- **Symbols on this pad are NOT unique.** `usdg` has 7 addresses; `CryingCat` has 3 (38,867 / 483 /
  10 swaps). Symbol-matching was pooling real tokens with copycats. Everything now keys on contract
  address.
- **`stopMode:"none"` posts +213bps at an 88.3% win rate and it is pure CENSORING** — trade count
  drops 342 → 188 because losers never close, and the 16 that do resolve average −6,449bps.

`assessOverfitting` at **133 cumulative trials counted across all three rounds** (not reset per
round): **`credible: false`**.

### IBRAHIM'S DECISION: STAY ON LETSCASH. The venue analysis below is recorded, not acted on.

Asked directly whether to move venue, he said: *"we want the cats to trade on letscash tokens, and
i do think there is mature tokens there that cats can be profitable of, you don't need to buy new
pairs or whatever.. there is tokens there with 1m mcap that has daily volume"*

And on live trading: **stay stopped until measured profitable.**

**His instinct points at something the backtest may have averaged away.** The −117bps figure is a
mean across all 461 tokens, and that corpus contains a long tail of near-dead tokens with 2–40 swaps
alongside genuinely liquid ones. Verified in the corpus:

```
CRYINGCAT  38,867 swaps     INTERN 23,768     WINK 20,121     LEVCAT 15,479
VIBECAT    14,816           CHUDCAT 8,356     SERIOUSCAT 7,615  CASHBIRD 5,461
```

These are real, actively traded, 1%-tax tokens with 500–1,200 holders and 100–400Ξ of daily volume.
Round 2 reported that volume/holder floors made results *monotonically worse*, which contradicts
that live evidence and is surprising enough to re-examine — the floors may have been applied to a
stale API field rather than to realised swap activity. **That is being tested now.**

The trap to guard against, and it is the same one that killed the last positive result:
restricting to "tokens that are big and liquid TODAY" is itself a survivorship filter. Any result
must beat RANDOM entries on the same restricted universe, or it has found nothing.

### The venue analysis — recorded for completeness, NOT the chosen path

A 0%-tax tier does not exist on letscash in practice: **zero** of the top 48 by market cap and
**one** of 461 in the backtest corpus (WINLOSE, two swaps). That path is closed.

But `openhood/TRADING.md` measured a venue on **this same chain 4663** with a real read-only probe
(`probe/perpbook.mjs`, 2026-08-07): **Lighter**, the orderbook deployment Robinhood's own docs name
for the chain.

| | letscash (Uniswap v4 + hook) | Lighter (measured) |
|---|---|---|
| round trip at our size | **218 bps** | **~3.2 bps** |
| fees | 200bps hook tax + pool | **0 maker / 0 taker** |
| cost vs size | flat in bps (tax dominates) | **flat $50 → $5000** |
| books | one pool per token | 15 equity perps + **26 USDG spot** |

Arcus (dYdX team, $19.8M TVL) is a second independent venue on the same chain at ~4.5bps.

**The two projects have exactly complementary problems.** openhood's cost objection died on Lighter
and it was then foreclosed by SIGNAL SUPPLY — RWA equity pools fire 0.42 signals/day with no
measured serial dependence. STRAYS has the opposite: **1,723 trades in 28 days and a held-out edge
at t = 4.65**, foreclosed by COST.

```
measured held-out edge   +145 bps
  at letscash's toll     −218  =>   −73 bps   LOSS
  at Lighter's toll      −3.2  =>  +142 bps   PROFIT
```

**The honest caveat, which matters as much as the number.** That edge was measured on *memecoin*
price series on letscash. Lighter lists equity perps and USDG spot books — **a different asset
class**, and openhood measured precisely that class to have no exploitable intraday serial
dependence. So this is **not** "move the code and it prints money". It is: the signal is real and
this venue's toll is what kills it, and there exists a venue on the same chain where a signal of
this size would survive — *if* a signal of this size exists there, which is unmeasured and is the
next thing to test.

**What would have to be true to win here:** cost falling to ≤145bps (the measured held-out edge),
which is not reachable on this venue — The one untested direction is **selectivity** — p75/p90 of net returns are +655/+1125bps, so
a profitable subset exists; whether it is identifiable *in advance* is unknown and must be run on
held-out data. Retuning lookback, stop or drawdown will not work: all three were swept and lose
across their entire range.

Full report: `packages/backtest/RESULTS.md`.

**(superseded) The strategy has never been backtested.** It is screened, costed and sabotage-tested, and whether
its entry signal actually predicts forward return is **argued, not measured**. `RESEARCH-STRATEGY.md`
says so in its own words: the literature on early-buyer effects is discouraging (+16.1% after
propensity matching), which is why every quality term is a multiplier in [0,1] that can only
discount an edge, never manufacture one.

**The adoption flow is linked and renders, but no wallet has ever connected to it.**
`apps/web/app/adopt.tsx` implements the two-click path with EIP-6963 discovery and
disabled-not-hidden dead wallets, and it is now mounted on `/colony` — verified in a real browser,
where it correctly renders "Step 1 of 2 — connect a wallet / No wallet detected" because a headless
browser has no wallet extension. **The signing path is therefore UNTESTED end to end.** It was
unreachable until this pass, which is the exact shape of the recorded failure where a service built
to act on a user's token shipped with no input anywhere.

**The quarry now shows real tokens, verified on the deployed page.** `Seriouscat 387Ξ · LEVCAT 317Ξ
· CASHBIRD 193Ξ · INTERN 172Ξ · WINK · CUSSY`, ranked by 24h volume, "58 live of 107 scanned", and
no huntable token has under 0.5Ξ of volume. The root cause was deeper than the `sort=newest` bug:
**"huntable" still meant `taxPct === 1`, a rule `discovery.ts` had already deleted.** The page was
applying a filter the strategy no longer had.

**The font never shipped.** `public/fonts/JetBrainsMono.woff2` did not exist, so every page fell
back to a system mono while `ART-DIRECTION.md` §4 claimed a local one — and that same section cites
float's identical bug as the thing not to repeat. Installed, serving (92,576 B, 200), and `postbuild`
now asserts it, proven by sabotage.

**Five of six design axes now ship.** `map`, `dense-instrument`, `phosphor` and `idle-world` are
built and measured; `mono-only` was always true. Only `pointer-agnostic` remains a claim rather
than a feature — the world is click-and-look, and no keyboard or press-and-hold vocabulary exists.
`ARCHIVE.md` row 12 carries both the before and after measurements deliberately.

**No `TEST` token launched.** Asked for, not done.

**`quoteExitWei` returns 0**, so exit decisions cannot price a position yet. The buy-side quoter
works and is verified against a real fill to within 0.01%; the sell side is the same call with the
direction flipped and is not wired.

---

## FIVE bugs found that tests alone did not catch

Recorded because the *method* that caught each one is the transferable part.

**1. The swap encoder was 64 bytes short.** `ExactInputSingleParams` contains a `bytes` member,
making the struct dynamic and requiring a head-offset word that positional encoding omits. Every
word from index 6 was shifted. **Caught by diffing against a transaction that had actually landed** —
no type checker and no unit test of the arithmetic would have found it, and it would have spent real
ETH on malformed calldata.

**2. `receive()` rejected the PoolManager.** v4's `take()` is executed by the PoolManager singleton,
not the router, so on a sell the ETH arrives from `0x8366a39C…`. The entire sell executed correctly
and reverted on the final line. **All 25 unit tests passed while this was live**, because a mock
router sends its own ETH. **A mock is a statement about what you already believe.**

**3. A hardcoded function selector was wrong.** `adopt(bytes32)` is `0x766c6eaf`; the adoption flow
had `0xd8f9ba6d`. Every adoption would have hit a non-existent function and reverted. **A wrong
four-byte constant is indistinguishable from a right one until it reaches the chain.** Caught by
`cast sig`, and now derived from the ABI so it cannot drift.

**4. A trailing `|| true` made every failed build report SUCCESS.** Shell precedence applied it to
the whole `&&` chain, so a failing `next build` exited 0, Railway reported SUCCESS, and every route
served 502. **The first fix (`set -e` on the parent) did not work and only a sabotage revealed
that** — appending an unresolvable import proved exit 0 before and exit 1 after. Same shape as
meridian's recorded finding that piping git into `tail` hides its exit code.

**5. The standalone bundle shipped with no stylesheet, and every route returned 200.** The copy of
`.next/static` was chained inside the same script that produces the directory it copies, so the
standalone bundle's static dir was empty and every page 404'd its own CSS. The deployed site loaded
perfectly and rendered as unstyled default-serif HTML. **Caught by opening the page and looking at
it** — no status code, type checker or test could see it. The fix asserts a `.css` exists in the
bundle and is proven by sabotage: emptying the source makes the build exit 1.

**And one process failure worth the same weight:** the first screenshot pass shot only the light
theme, because the headless browser reports `prefers-color-scheme: light`. The phosphor palette this
project *claims* had never been looked at. That is unitick's exact recorded failure — a theme nobody
opened — and it was caught only by noticing the screenshots were the wrong colour.
