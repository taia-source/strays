# RESEARCH-STRATEGY — rebuilding `@strays/hunt` as a memecoin trader

Measured 2026-08-07 against live mainnet 4663 and `api.letscash.fun`. Every claim below is marked
**MEASURED** (with the command that produced it), **CITED** (with a URL), or **ASSUMED** (and then
labelled as such wherever it reaches the code). Where a source and the chain disagree, the chain
wins.

This document exists because two of the shipped strategy's load-bearing constants turned out to be
**measurably wrong**, and one check that would have prevented the largest available loss was
**entirely absent**. Both are recorded below in full rather than quietly fixed.

---

## 0. The one-line summary

The old filter asked *"is this token 1%-tax, and does it have 25 holders?"* — a question that admits
**1 token in 100** and does not detect the failure that actually destroys capital. The new question
is *"can I actually sell this, and does its expected move clear its own tax bar?"* — which is
answerable, was measured, and ranks the pad instead of merely refusing it.

---

## 1. THE FINDING THAT MATTERS MOST: 84% of the pad cannot be sold

**MEASURED.** For each of the newest 100 tokens: quote a $5 buy through the v4 quoter
(`0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`), then quote a sell of **exactly the tokens the buy
returned**, back to ETH. Both legs are `eth_call` — free, and risking nothing.

```
N=100   buy-quote failures = 0   SELL-QUOTE FAILURES = 84   sellable = 16
```

**Every single one of the 100 tokens quotes a BUY successfully. 84 of them cannot be quoted for a
SELL.** A strategy that checks only that it can buy — which is what the shipped code did, via
`Candidate.quotedOut` — is buying into a position it has not established it can leave.

This is the single highest-value check available to us, it costs one extra `eth_call`, and it did
not exist in the codebase.

### 1a. But "84% honeypot" is WRONG, and the distinction is the whole design

The first read of that number was "84% of the pad is a honeypot". Decoding the revert proved
otherwise, and the correction matters because it changes what the check is *for*.

The quoter wraps inner reverts in `UnexpectedRevertBytes(bytes)` (`0x6190b2b0`, confirmed by
`keccak256("UnexpectedRevertBytes(bytes)")`). Unwrapping the payload gives **exactly two** distinct
inner selectors across all 84 failures:

| Inner selector | Meaning | Count | Trade counts of those tokens |
|---|---|---|---|
| `0x90bfb865` | hook-level refusal, references the hook address | **46** | **all 46 have ZERO trades** |
| `0x7a5ed734` | `NotEnoughLiquidity(bytes32)` (keccak-confirmed) | **38** | 1–24 trades |
| — | sellable | **16** | 1–100 trades |

The `0x90bfb865` bucket is **perfectly correlated with never having traded** — 46 out of 46. This is
not malice; it is the un-warmed state of a pool nobody has bought into yet. Calling it a honeypot
would have been a plausible-looking number that was false, which is precisely the "silent wrongness"
failure `RESEARCH.md` §7b is about.

The `0x7a5ed734` bucket is a genuine **depth** refusal: these pools have traded, but cannot absorb a
$5 exit.

**The design consequence is the same either way, and that is why the check is built on the outcome
rather than the cause: if the sell leg does not quote, we do not buy.** We do not need to know
whether the cause is malice or thinness to know we must not enter. The reason string records which
selector fired so `/logs` shows the difference.

### 1b. What predicts sellability — a clean pre-filter

**MEASURED**, same 100 tokens:

| Cohort | n | sellable | rate |
|---|---|---|---|
| `marketCapEth > 1.36` | 15 | 15 | **100%** |
| `marketCapEth <= 1.36` | 85 | 1 | **1%** |

| all-time volume (ETH) | n | sellable |
|---|---|---|
| ~0 | 47 | 0 (0%) |
| 0–0.02 | 18 | 1 (6%) |
| 0.02–0.1 | 15 | 3 (20%) |
| 0.1–1 | 14 | 7 (50%) |
| ≥ 1 | 6 | 5 (83%) |

**1.356 ETH is the untraded seed market cap** — 84 of 100 tokens sit at exactly that value. So
"market cap above the seed" is really "somebody has actually bought this", and it separates the pad
almost perfectly. This is used as a cheap pre-filter to avoid spending a quoter round-trip on tokens
that provably cannot pass, **never as a substitute for the sell simulation itself.**

---

## 2. The shipped `minMarketCapWei = 1 ETH` floor was decoration

**MEASURED: 100 / 100 tokens pass it.**

```
mcap min=1.356  median=1.356  max=13.608   (ETH)
```

The floor was derived as "~385× a $5 position", which is sound reasoning — but the pad's *seed*
market cap is 1.356 ETH, so a 1.0 ETH floor sits **below the minimum value the field can take**. It
refuses nothing. It reads like a depth control and is arithmetically incapable of being one.

Replaced with a floor at **1.40 ETH**, above the 1.356 seed, which is the value that actually
separates traded from untraded (§1b).

---

## 3. `minHolders = 25` admitted 1 token in 100 — and does not detect rugs

**MEASURED**, newest 100:

| holders ≥ | count |
|---|---|
| 2 | 100 (83 are *exactly* 2) |
| 5 | 8 |
| 10 | 3 |
| **25 (shipped floor)** | **1** |

The full shipped filter (`tax==1 && mcap>=1 && holders>=25 && vol>=0.026`) admits **exactly one
token out of 100**: CASHDOG. That is the mechanical cause of the observed ~0.4 trades/day.

Ibrahim's objection was that 25 holders is *too low to protect against a rug*, and the measurement
confirms he is right that it is the wrong instrument entirely — **CASHDOG, the single token that
passes, carries `top10Pct = 22%`**, the second-highest concentration in the sample. The holder count
admitted it; the concentration was never checked. A holder floor is a **liveness** proxy, and a
weak one — it is retained at a much lower value (3) for that purpose only, and the *protection* job
is moved to the checks in §4 and §5, which measure the thing itself.

Note the holder field also counts the **pool contract itself** as a holder, which is why 83 tokens
report exactly 2 (pool + factory). A "25 holders" floor on this pad is therefore asking for far more
real participants than the number suggests.

---

## 4. Rug and concentration screening — what the API actually gives us

**MEASURED.** `GET /api/tokens/{addr}/holders` was undocumented in `RESEARCH.md` and turns out to
expose precisely the fields the literature says matter:

```json
{"holders":[{"address":"0x8366…","balance":"997989854181629221928473939","pct":99.99,"tags":["pool"]}],
 "count":2, "top10Pct":0,
 "creator":{"pct":0,"sold":true,"buys":1,"sells":1},
 "snipers":{"count":0,"heldPct":0}}
```

Four independently useful signals, all free:

- **`top10Pct`** — top-10 concentration, excluding the pool (the pool is `tags:["pool"]`).
- **`creator.pct`** / **`creator.sold`** — dev holdings and whether the dev has already dumped.
- **`snipers.count`** / **`snipers.heldPct`** — **the pad computes bundle/sniper detection for us.**
- **`count`** — holder count.

`snipers.heldPct` is the important one. The strongest empirical finding I found on concentration is
that **naive top-10 concentration systematically understates risk because bundled wallets hide
behind it** — after resolving bundles into beneficial owners, top-10 concentration rises a median
**24 points** for high-risk tokens vs 9 for medium and 6 for low
([MemeTrans, arXiv:2602.13480](https://arxiv.org/html/2602.13480v1), 41,470 migrated memecoins,
>200M transactions). We would have had no way to compute that ourselves; the pad publishes it.

**MEASURED distribution across the newest 100:**

```
tokens with snipers detected : 30/100
tokens with sniperHeld > 0   :  8/100   max = 8.82%
top10Pct where non-zero      : n=17, min 0.01, median 6.45, max 23.92
creator.pct > 0              :  9/100   max = 3.36%
creator.sold == true         : 34/100
```

### 4a. Thresholds — and honesty about which are measured

The widely-repeated retail thresholds ("top-10 >25% is dangerous", "dev >5% is a red flag") are
**CITED but NOT empirically validated** — I could not trace any of them to a measurement, and a
sub-agent's live queries against the RugCheck API found tokens at **56.5% top-10 with a 34.8%
single holder returning an empty `risks[]` array**, directly contradicting the blog figures
([solanatracker.io](https://www.solanatracker.io/rugcheck),
[docs.gopluslabs.io](https://docs.gopluslabs.io/reference/response-details) — GoPlus returns raw
values and **defines no cutoffs at all**, leaving the threshold to the caller).

So the thresholds here are set against **this pad's own measured distribution**, not imported:

| Check | Threshold | Basis |
|---|---|---|
| `top10Pct` | refuse > 35% | measured max on this pad is 23.92%; 35% is clear of the entire observed range, so it fires only on genuinely anomalous concentration |
| `snipers.heldPct` | refuse > 15% | measured max is 8.82%; ~1.7× the observed maximum |
| `creator.pct` | refuse > 10% | measured max is 3.36% |

These are **deliberately set outside the measured range**. That is a real limitation, stated plainly:
on the current sample they refuse nothing, so they are **insurance against a distribution shift, not
active filters today**. Setting them tight enough to bind on today's data would be fitting to 100
observations. They are scored (§7) rather than only gated, so concentration still influences ranking
below the refusal line.

### 4b. Why the 24-hour window drives the age bound

**CITED, and the strongest single number in the rug literature:** **93% of rug pulls occur within 24
hours of pool creation** — *Do Not Rug on Me*, Mazorra, Adan & Daza, *Mathematics* 10(6):949, 2022
([ar5iv](https://ar5iv.labs.arxiv.org/html/2201.07220),
[DOI](https://doi.org/10.3390/math10060949)); 27,588 labelled tokens, XGBoost accuracy 0.9936,
precision 0.9838, recall 0.9540. The same paper reports **78.2% of inactive pools** saw complete
liquidity withdrawal, and — worth recording because it contradicts common advice — **90% of
Unicrypt-LP-locked tokens still rugged**, so an LP lock is weak evidence of safety.

Corroborating: *Trade or Trick* (Xia et al., SIGMETRICS 2021,
[arXiv:2109.00229](https://arxiv.org/abs/2109.00229)) found ~50% of Uniswap-listed tokens are scams
(Random Forest precision 96.45%, recall 96.79%), and noted the behavioural tell that **scam tokens'
trade volume often exceeds their liquidity** — a volume/liquidity ratio signal, which is why §6
carries a turnover *ceiling* as well as a floor.

`letscash` locks liquidity permanently at launch (`RESEARCH.md` §1a), so the classic
liquidity-withdrawal rug is **structurally unavailable here**. What remains reachable is the
sell-side trap and the dump — which is what §1 and §4 screen for.

---

## 5. Momentum and liveness signals — measured on this pad

**MEASURED**, newest 100:

```
zero trades ever      : 46/100
<= 2 trades           : 65/100
>= 10 trades ("alive") : 17/100
```

Volume/market-cap **turnover** on the alive set ranges 0.009 → 1.86. The tokens that are actually
sellable cluster at the top of it: the five highest-turnover tokens are all sellable, and all six
tokens with all-time volume ≥ 1 ETH are sellable bar one.

Buy-ratio (`buys / (buys+sells)`) on the alive set spans 0.33 → 0.73. CASHDOG (0.65), CatDay (0.71)
and WEALTH (0.73) are the strongest, and all three are sellable with healthy depth.

**ASSUMED, and labelled as such in the code:** that a high buy-ratio and rising turnover *predict*
forward return. I have **not** measured forward returns on this pad — that requires a time series we
do not yet hold. What is measured is that these signals correlate with *sellability and depth*,
which is a weaker but genuinely useful claim, and it is the only one the code asserts. The academic
evidence is actively discouraging about stronger claims: Marino et al.
([arXiv:2602.14860](https://arxiv.org/html/2602.14860v1), n=655,770) found that on pump.fun **no
buy-and-hold strategy based on volume alone clears breakeven**, and a sniper-cohort study
([arXiv:2607.02795](https://arxiv.org/pdf/2607.02795)) found early-buyer-count effects shrink from a
naive +130.9% to **+16.1%** after propensity matching, with SOL-inflow lift statistically
indistinguishable from zero. **Early-buyer signals are mostly selection, not causation.** They are
therefore weighted modestly in the score and never allowed to override the cost bar.

---

## 6. Tax as a COST TERM, not an exclusion — the direct answer to the challenge

The shipped rule was `taxPct === 1`, refusing everything else outright. The objection: *a 5%-tax
token that moves 30% beats a 1%-tax token that moves 2%*. That is arithmetically correct, and the
measured round trips (`RESEARCH.md` §3b, re-confirmed live below) give the exact bar each tier must
clear:

| tax | measured round trip | break-even move | required at EDGE_MULTIPLE 2 |
|---|---|---|---|
| 1% | 231 bps | +2.31% | +4.63% |
| 3% | 624 bps | +6.24% | +12.5% |
| 5% | 1008 bps | +10.1% | +20.2% |
| 10% | 1938 bps | +19.4% | +38.8% |

**MEASURED live via the quoter, this session** — round-trip loss on a real $5 buy-then-sell quote:

```
CatDay      tax  1%   227 bps      (2*tax = 200)
CASHDOG     tax  1%   210 bps
Yourcoin    tax  1%   228 bps
WEALTH      tax  1%   231 bps
HTZ         tax  1%   234 bps
LAUNCH      tax  3%   625 bps      (2*tax = 600)
SpinningCat tax 10%  1925 bps      (2*tax = 2000)
```

This independently reproduces `RESEARCH.md` §3b on live pools rather than a fork, and confirms
**cost ≈ 2 × tax + ~30bps gas** at every tier. The cost model is correct; only its use as a hard
exclusion was wrong.

So tax becomes an input to expected value. A 10%-tax token is not refused — it is required to clear
a **38.8%** expected move, which is a bar it will almost never clear, so it is refused *by the
arithmetic* rather than by a rule. The difference matters because when a 10%-tax token genuinely is
moving 40%+, we can now take it. SpinningCat (10% tax) was the third-most-traded token in the sample
and the old filter could not see it.

**But the tax tiers are not equally safe, and that is measured too:**

| tax tier | sellable |
|---|---|
| 1% | 11/29 (38%) |
| 3% | 2/10 (20%) |
| 5% | 2/18 (11%) |
| 10% | 1/43 (2%) |

High-tax tokens are **far** more likely to fail the sell simulation. This is a genuine second reason
to prefer low tax, independent of cost — and it is enforced by the sell check itself, which every
candidate must pass regardless of tier.

---

## 7. The scoring model

Ranking, not first-past-the-post. The old `decide` returned the **first** candidate that passed
every gate; the pad supplies many candidates and the best one should win.

Score is **expected value in basis points, net of that token's own measured cost**:

```
netEdgeBps = expectedMoveBps - roundTripCostBps(taxPct, gasPrice)
```

then multiplied by quality multipliers in [0,1] derived from the measurements above — depth
(§1b), concentration (§4), momentum/turnover (§5). A candidate is only *eligible* to be scored if it
passes the hard gates (sell simulation, tax-cost bar, concentration ceilings). **Scoring never
resurrects a token a hard gate refused**, and the cost bar is applied to the *net* figure, so a
high-tax token must genuinely out-move its own tax to outrank a low-tax one.

### Target trade rate

Ibrahim's stated aim is **a few trades per hour when signals are genuinely good** — not 15/hour
churn, not 0.4/day. The binding constraint is the measured supply of tradeable tokens: **16 of the
newest 100 are sellable at all**, and 9 of those have ≥10 trades. The count cap is raised from 6/day
to a per-hour cap so the rate is bounded by opportunity rather than by an arbitrary daily number,
while `meridian`'s recorded failure (a 20-second rotation loop that lost 2.8% in two hours and was
retired — `DESIGN.md` §6 Rule 6) keeps a hard ceiling in place.

---

## 8. What is measured vs assumed — the honest ledger

**MEASURED (this session, reproducible):**
- 84/100 tokens fail a $5 sell-back quote; 0/100 fail the buy quote.
- The failure splits 46 hook-refusal (all zero-trade) / 38 `NotEnoughLiquidity`.
- `marketCapEth > 1.36` predicts sellability 15/15; `<= 1.36` predicts 1/85.
- Round-trip cost ≈ 2×tax + ~30bps, live, at 1%/3%/10%.
- Tax mix of newest 100: 1%=29, 3%=10, 5%=18, 10%=43.
- Sellability by tier: 38%/20%/11%/2%.
- `holders>=25` admits 1/100; `mcap>=1 ETH` admits 100/100.
- `/holders` exposes `top10Pct`, `creator.{pct,sold}`, `snipers.{count,heldPct}`.
- Concentration ranges on this pad: top10 ≤ 23.92%, sniperHeld ≤ 8.82%, creator ≤ 3.36%.

**CITED (external, not verified by me on this pad):**
- 93% of rugs occur within 24h of pool creation; 90% of locked-LP tokens still rugged.
- Bundling hides a median 24 points of top-10 concentration in high-risk tokens.
- Early-buyer-count effects shrink to +16.1% after propensity matching.
- No volume-only buy-and-hold strategy cleared breakeven on pump.fun.

**ASSUMED (labelled in code, not measured):**
- That buy-ratio and turnover predict *forward return* on this pad. Only their correlation with
  depth and sellability is measured. Weighted modestly for this reason.
- The concentration refusal thresholds (35%/15%/10%) sit outside the observed range and are
  insurance against distribution shift, not active filters on today's data.
- `sigma_1h = 157bps`, inherited from `RESEARCH.md` §3d's 7.7% mean-absolute 24h move. Still not
  measured lag-by-lag on this pad.

**UNKNOWN:**
- Forward returns conditional on any of these signals — needs a time series we do not yet have.
- Whether `0x90bfb865` is a hook guard on unwarmed pools or something else; only its perfect
  correlation with zero trades is established.
- Whether the pad's `snipers` detection matches the co-occurrence-graph method in the literature.
  Its algorithm is not published.

---

## 9. Reproducing the measurements

```bash
# tax mix, holders, concentration, trades across the newest 100
curl -s -A "strays-research/0.1" "https://api.letscash.fun/api/tokens?sort=newest&limit=100"
curl -s -A "strays-research/0.1" "https://api.letscash.fun/api/tokens/<addr>/holders"
curl -s -A "strays-research/0.1" "https://api.letscash.fun/api/tokens/<addr>/trades?limit=200"

# the sell simulation, per token: quote ETH->token, then token->ETH with the exact output
# v4Quoter 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94, hook 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC
# fee = 0, tickSpacing from /api/tokens/{addr}
```

The API 403s Python's default User-Agent (Cloudflare) but serves `curl` and Node `fetch` with an
explicit UA. Rate limit 240 req/60s.
