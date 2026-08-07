# STRAYS — RESEARCH

Written **before** any application code, per `~/work/taia/CLAUDE.md` and `BUILD-A-PROJECT.md` step 4.
Every claim below is marked **VERIFIED** with the command or URL that proved it, or **UNKNOWN** with
what was tried. Where docs and the chain disagree, **the chain wins**.

Measured 2026-08-07. ETH = $1927.27 (`api.letscash.fun/api/config` → `ethUsd`).

---

## 0. The one-line summary

A stray must hunt **1%-tax tokens only**. That single filter is the difference between a product
and a money incinerator, and it is derived from measurement, not preference — §3.

---

## 1. The venue

**VERIFIED — letscash.fun runs on Robinhood Chain, id 4663, EVM (Arbitrum Orbit L2, gas in ETH).**

```
$ cast chain-id --rpc-url https://rpc.mainnet.chain.robinhood.com
4663
$ curl -s https://api.letscash.fun/api/config | jq .chainId
4663
```

Same chain openhood/bloodhorn traded on, so its measured chain constants transfer — but see §7,
where one of them very nearly caused a catastrophic error.

### 1a. There is NO bonding curve — VERIFIED, and it overturns the brief

The brief assumed a bonding curve with buy/sell functions and a graduation event. **There is none.**
One transaction deploys the token, seeds a **Uniswap v4** pool with the entire supply, and
permanently locks the liquidity. Tokens trade on stock v4 rails from block one.

Source: <https://www.letscash.fun/docs> —

> "Tokens trade on standard Uniswap v4 rails: any terminal, aggregator, or bot on the chain can
> trade them with zero integration, and the tax applies identically wherever the trade comes from."

**Why this matters more than it looks.** Meridian's `MeridianLaunchFactory.sol:15-23` records the
opposite situation on a *different* pad and it killed that product outright:

> "The launchpad already deployed on this chain uses a bonding curve that graduates to a real pool
> at roughly 5 ETH of cumulative buying. Measured against 82 live launches, the closest token had
> reached 0.70 ETH and 91% were under 0.1 ETH. **Nothing graduates, so nothing ever gets a pool, so
> there is never any liquidity to make markets in.**"

letscash has no graduation gate, so this failure mode cannot occur here. Every launched token has a
live pool immediately. **This is the single biggest structural advantage this project has over both
its predecessors**, and it was verified rather than assumed.

### 1b. Contract map — VERIFIED from `/api/config`, cross-checked on Blockscout

| Role | Address | Verified source? |
|---|---|---|
| launchpadFactory (ERC1967 proxy) | `0x5bd1Fbe78a78fe8236fa00CF48fbEBA74ae34661` | yes |
| ↳ implementation `CashCatFactoryVNext` | `0x3dFd73A63E15920aDd4B6c5C6a4b1b4B768b2c1A` | yes, solc 0.8.28 |
| **hook** (the fee engine) | `0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC` | **NO — unverified** |
| **revenueSplitter** | `0x6D3d822F6e625c59804F47cf2Cc1d53B8301016F` | **NO — unverified** |
| selfBurner `CashCatSelfBurnerV2` | `0x47b846F7111919C652026ea750DDBD247Bf79d21` | yes |
| poolManager (Uniswap v4) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | yes |
| **universalRouter** ← our swap entrypoint | `0x8876789976dEcBfCbBbe364623C63652db8C0904` | yes |
| v4Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` | yes |
| stateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` | yes |
| permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | canonical |
| CASHCAT token | `0x020bfC650A365f8BB26819deAAbF3E21291018b4` | yes |

**RISK, recorded and NOT resolved:** the two contracts governing fee logic and the liquidity lock —
`hook` and `revenueSplitter` — are **unverified on Blockscout**. Their behaviour is documented and
observable, but not auditable. We trade *through* them on every single swap. This is the main
integration risk of the project and it cannot be mitigated by us; it can only be bounded by
position size.

**CASHCAT impostor risk — VERIFIED.** Blockscout search for "CASHCAT" returns 12+ tokens including
several *verified* fakes (`0xa8A7Ba87…`, `0xD89a2E0e…`, `0x6678C1EE…`). **Never resolve by symbol.**
Hardcode the address above.

---

## 2. The PoolKey — DERIVED AND PROVEN, not guessed

A v4 `poolId` is `keccak256(abi.encode(PoolKey))`. We reconstructed it for a live token and matched
the pad's own API value on the **first attempt**, which pins every field including the hook.

`probe/poolkey.mjs`, run against CatDay `0x8Cbab44d…4ccc`:

```
token CatDay  tax 1%  tickSpacing 200  pool(API) 0xc95d132b8f55f468aaa39c3a58f641af52f76b39248abb32ea193c549eef5ad8

*** MATCH *** fee=0 (0x0)  poolId=0xc95d132b8f55f468aaa39c3a58f641af52f76b39248abb32ea193c549eef5ad8

all candidates:
  fee=       0 -> 0xc95d132b8f55f468aaa39c3a58f641af52f76b39248abb32ea193c549eef5ad8   <- MATCH
  fee=     100 -> 0x97ee0ed8e099f7d9708fb7e01356091047cbc5d9d7a46d2e43183f9ac3f375fc
  fee=     500 -> 0x39793ac5482e5f547bb611f2d33b46ea31e73a2cd511c7342f64d895d646a541
  fee=    3000 -> 0x9711fe1b286efa25e5dfa561f86770bcf583c67be99d0e54ed989a93255aa544
  fee=   10000 -> 0x7c9bfb1178e0e2f77cf0b0e9e09229065aa5b86f7dde2c4b4a7468fab5ded854
  fee= 8388608 -> 0x2b5482db48553c5eafb3dd75d25a1ffb8c3d77179f43f9dfcbd05e1005aa7373
```

So, **VERIFIED**:

```
PoolKey = (
  currency0   = 0x0000000000000000000000000000000000000000   // native ETH sorts first
  currency1   = <the token>
  fee         = 0                                            // ZERO — see below
  tickSpacing = <from /api/tokens/{addr}.tickSpacing, 200 observed>
  hooks       = 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC
)
```

**`fee = 0` is a real finding.** The pool charges no LP fee whatsoever; the hook takes the entire
tax. openhood's cost model carried a pool-fee term (5bps/30bps/100bps tiers) — **that term is zero
here** and must not be copied across, or the model over-states cost and under-trades.

`tickSpacing` varies per launch config and MUST be read per token from the API or the
`TokenLaunched` event. It is not a constant.

---

## 3. THE ECONOMICS — the measurement that defines the product

### 3a. Method

`probe/rt5.mjs`. Against an **anvil fork of mainnet 4663** at block 30,255,810: buy $5 of the token
with native ETH through the UniversalRouter, grant the two Permit2 approvals, then sell **exactly
the tokens the buy returned**, and diff the account's ETH. Gas *units* come from the fork (they
transfer); the gas *price* is read from **mainnet**, never from the fork — see §7.

State is snapshotted and reverted around every measurement, so the fork is not polluted between
runs.

### 3b. Result — MEASURED on four live pools, one per tax tier, all at $5

| Token | Tax | Swap cost (tax×2 + impact) | Gas | **TOTAL round trip** |
|---|---|---|---|---|
| CatDay | **1%** | 199.0 bps | 32.5 bps | **231.4 bps** |
| BTC65000 | 3% | 591.0 bps | 33.2 bps | **624.2 bps** |
| BOWMAN | 5% | 975.0 bps | 32.6 bps | **1007.6 bps** |
| fomocat | 10% | 1900.0 bps | 38.3 bps | **1938.3 bps** |

Measured swap cost is `2 × tax` to within 1 bps at every tier, so **price impact at $5 is
negligible** and tax is essentially the entire cost. Gas is a flat ~$0.016 per round trip.

### 3c. What follows from it — the hard rules

**RULE 1 — a stray may only hunt 1%-tax tokens.** At 10% tax a position must gain **19.4%** just to
break even. At 1% it needs **2.32%**. This is not a tuning preference; it is the difference between
a strategy that can win and one that provably cannot.

**RULE 2 — position size does not change the bar.** Cost is flat in bps from $5 to $50 because tax
is proportional and gas is negligible. This is a genuinely different regime from openhood, whose
cost was **U-shaped** ($1→166bps, $50→18bps minimum, $1000→82bps, `openhood/probe/roundtrip.mjs`)
because gas dominated there. Do not port that curve or the sizing logic built on it.

**RULE 3 — gas is not the enemy here, and the instinct to optimise it is a trap.** $0.016 per round
trip is 0.3% of a $5 position. openhood's entire strategy was contorted around a 219bps gas cost
that does not exist on this venue at this size.

### 3d. Signal supply — the thing openhood measured itself to be missing

`api.letscash.fun/api/stats`, 2026-08-07:

```json
{"tokensLaunched":3063,"volume24hEth":3068.19,"volumeTotalEth":23992.11,"traders":38977}
```

Across the newest 48 launches, **mean absolute 24h move = 7.7%**, range −17.1% to +38.8%, and 29 of
48 had a non-zero move.

**Signal-to-cost ratio, the number that decides whether this product is possible:**

| Project | Typical move | Round-trip cost | Ratio |
|---|---|---|---|
| **openhood** (tokenized NVDA) | ~42 bps/hour | 219 bps | **0.19×** — foreclosed |
| **strays** (1%-tax memecoin) | ~770 bps/24h | 231 bps | **3.3×** — viable |

openhood's own postmortem (`openhood/TRADING.md:1069-1072`) concluded:

> "**The binding constraint was never the cost bar.** … the breakout fired 6 times in 341 hours,
> the cost bar refused none of them … **Signal supply is the constraint.**"

And `openhood/apps/indexer/src/trading/signal.ts:37-43` measured autocorrelation across 7 lags on
the RWA series: 95% band ±0.1027, only lag 12 (+0.1041) barely crosses — **"There is no exploitable
serial dependence in this series."** RWA equity pools mean-revert to an off-chain NAV. Memecoins
have no NAV anchor, are reflexive, and the pad supplies ~1,000 fresh 1%-tax listings.

**This is why the same engine that was boring on openhood can work here. The engine was never the
problem; the asset was.** Do NOT port openhood's 1440-minute lookback, its 2σ breakout, or its 24h
horizon — those constants are artifacts of the wrong asset class.

### 3e-bis. THE TAX DISTRIBUTION WAS MEASURED ON TOO SMALL A SAMPLE — corrected

The table below was taken from the **newest 48** launches and reported 33% at 1% tax. Against the
backtest corpus — **461 tokens with 394,635 real on-chain swaps over 28 days** — the true
distribution is:

| tax | count | share |
|---|---|---|
| **1%** | **369** | **80%** |
| 3% | 27 | 6% |
| 5% | 32 | 7% |
| 10% | 30 | 7% |
| other (0/2/4) | 3 | <1% |

**80%, not 33%.** The newest-48 window is not a random sample of the pad — it is a sample of what
launched in the last hour, and launch behaviour at the moment of sampling is not the population.

The direction of the error is worth noting: it made the original `taxPct === 1` filter look far more
costly than it was (I believed it discarded two thirds of the pad; it discarded one fifth). That did
not save the filter — Ibrahim was still right that tax belongs in the cost model rather than in a
gate — but it means **the sample size, not the reasoning, was the weakest part of §3e.**

### 3e. Tax tier distribution — measured on the newest 48 launches (SUPERSEDED, see 3e-bis)

| tax | count | share |
|---|---|---|
| 1% | 16 | 33% |
| 3% | 6 | 13% |
| 5% | 11 | 23% |
| 10% | 15 | 31% |

**~33% of the pad is huntable.** Against 3,063 tokens launched that is ~1,000 candidates, and the
pad adds more continuously. Signal supply is not a constraint at this scale.

---

## 4. The swap path — PROVEN EXECUTABLE

### 4a. Simulation against a live mainnet pool

`probe/simbuy.mjs`, `eth_call` against **mainnet** (no fork), CatDay, $5:

```
*** eth_call SUCCEEDED — the router accepts our encoding ***
gas estimate: 153740
gas price: 0.029474 gwei -> cost 0.00000453133276 ETH = $0.00873
```

### 4b. Full round trip on a fork — both legs landed

```
BUY  0.0026 ETH -> 1298451422972480224401102 units   gas 148750
SELL 1298451422972480224401102 units                 gas 136349   status success
```

### 4c. The encoding — inherited from openhood, byte-verified

`openhood/apps/indexer/src/trading/venue.ts` contains an encoder whose output was diffed
**byte-for-byte** against a real landed swap on this exact router and chain. Its constants:

```
UNIVERSAL_ROUTER = 0x8876789976decbfcbbbe364623c63652db8c0904
V4_ACTIONS       = 0x060c0f    // SWAP_EXACT_IN_SINGLE / SETTLE_ALL / TAKE_ALL
COMMAND_V4_SWAP  = 0x10
```

That file records a defect worth inheriting the fix for: an earlier draft hand-concatenated 32-byte
words and was silently wrong, because `ExactInputSingleParams` contains a `bytes` member which makes
the struct **dynamic**, needing a head offset word a fixed-layout encoder does not emit. Every word
from index 17 on was shifted by one. **Use viem's `encodeAbiParameters`, never manual concatenation.**

### 4d. `TAKE_ALL` has no recipient field — the custody property, for free

This is the most important security property available to us and it comes from the encoding itself:

```
meridian draft:  TAKE      (0x0e) — params (currency, RECIPIENT, amount)
PROVEN on chain: TAKE_ALL  (0x0f) — params (currency, minAmount)
```

`meridian/contracts/CUSTODY.md` documents the trap: in v4 the payout recipient is a parameter buried
in triply-nested dynamic data, so **scoping a key to `router.execute` does NOT stop it swapping
funds out to an attacker**. Meridian shipped that hole knowingly and its own doc says so.

`TAKE_ALL` settles to the router's **caller**. There is no recipient parameter for anything to
abuse. The property is enforced by the *shape of the calldata* rather than by a check that can be
forgotten. **Our encoder must never grow a recipient argument, and a test must assert it cannot.**

### 4e. Approvals — the buy/sell asymmetry

Buying spends native ETH: no approval, one transaction. Selling spends an ERC-20 pulled through
Permit2: **two approvals first** (token→Permit2, then Permit2→router), one-time per (token,spender).
Measured on 4663 by openhood at 63,877 + 47,794 gas. At $0.016/round-trip these are immaterial here,
but they must be *sent* or the sell reverts.

---

## 5. Discovery

**VERIFIED — the public API is unauthenticated, CORS `*`, rate limit 240 req / 60s** (from response
headers `ratelimit: limit=240, remaining=239, reset=60`).

```
GET /api/tokens?sort=newest&limit=48   → {tokens[], total, page, pages}
GET /api/tokens/{addr}                 → taxPct, tickSpacing, pool, priceEth, marketCapEth,
                                          holders, volumeEth{allTime,day}, circulatingSupply, socials
GET /api/config                        → contracts, launchFeeWei, ethUsd
GET /api/stats                         → tokensLaunched, volume24hEth, traders
```

Every field the strategy needs — **`taxPct`, `tickSpacing`, `priceEth`, `marketCapEth`, `holders`,
`volumeEth`** — is exposed. No scraping required.

**No websocket exists — VERIFIED.** All 12 JS chunks grepped for `wss?://`, `new WebSocket`,
`socket.io`, `EventSource`: zero hits. The site itself polls REST. For lower latency, subscribe to
`TokenLaunched` logs on the factory, topic0
`0x17091df68f499cf4e20dcfc5d42f064dd22359e785b77691c4c4ed0322608897`.

**UNKNOWN:** no official API docs, no OpenAPI spec, no GitHub org. `/openapi.json`, `/docs` and
`/health` on the API host all return 403. Routes were recovered from the JS bundle. **Treat the API
as unofficial and unstable — it can change without notice, so the indexer must degrade to on-chain
reads rather than hard-fail.**

**Bot posture is explicitly welcoming — VERIFIED** (<https://www.letscash.fun/docs>): a section
titled *"we're hiring keeper bots"* states *"nothing here needs an allowlist, a key or our
permission"* and *"The site is one client. Everything it does, your script or bot can do directly
against the contracts."*

---

## 6. Permissionless bounties — a house revenue stream unrelated to trading skill

**VERIFIED** on-chain and in docs. Three permissionless functions each pay a **1% bounty**:

```
selfBurner.burn(bytes32 poolId)          BOUNTY_BPS() confirmed on the verified contract
revenueSplitter.buyAndBurn()
revenueSplitter.buyForCashcatTreasury()
```

Live evidence: `/api/buybacks` returns `bountyWei ≈ 1% of ethSpentWei`. `hook.pending(poolId)` tells
you when accumulated fuel exceeds gas cost. The operators state their own keeper deliberately delays
to let independent keepers go first.

`hook.sweep(poolId)` is also public but pays **nothing** — do not call it expecting a bounty.

**Relevance:** this is a house-side income stream with no directional risk, which supports the
"house never funds agents, house makes a little profit" constraint independently of whether any
stray is profitable. Recorded here; whether it is built is a scope decision, not a research one.

---

## 7. Traps — each already cost a previous project real money or time

**7a. Anvil's gas price is NOT the chain's.** openhood hardcoded a fork-measured cost and concluded
a round trip cost 52.5% of a position, which would have shipped a strategy that could only decline.
Anvil's default base fee is ~1.019 gwei; chain 4663 charges **0.0295 gwei — ~35× less**. **Gas UNITS
transfer from a fork; gas PRICES do not.** Every measurement in §3 prices gas from mainnet for this
reason, and `roundTripCost` must take `gasPriceWei` as a required parameter with no default.

**7b. This bit us during this very session.** Three successive attempts to measure the round trip by
ETH balance delta on the fork produced absurd figures (−9999 ETH, 38,461,538 bps). Causes: anvil
pre-funds accounts with 10,000 ETH; `eth_sendTransaction` ignored the `from` we passed; and a
snapshot revert fired before the final balance read. The swaps had been succeeding the entire time.
**Recorded because the failure mode was a plausible-looking number, not an error** — exactly the
"silent wrongness" CLAUDE.md names as the enemy. The fix was to stop measuring ETH balances and
measure the token flow directly.

**7c. `amountOutMinimum = 0` is a free MEV sandwich.** The proven mainnet transaction openhood
decoded carried zeros in both slippage slots. The *encoding* is safe to reuse; **those two
parameters are not.** Our encoder must refuse a zero floor in both `amountOutMinimum` and
`TAKE_ALL.minAmount`.

**7d. Full-precision `bigint` for any "sell everything" path.** A real 18-decimal balance needs ~22
significant digits, beyond float64's ~15–17. Round-tripping through `number` reconstructs a wei
amount that does not match the balance and reverts with `TRANSFER_FROM_FAILED` (meridian
`uniswapV4.ts:283-291`).

**7e. An in-process mutex is not a custody control.** meridian `signer.ts:34-42`: two processes each
holding the same key *"can each decide to re-center, withdraw, or collect — a real double-spend on
live capital, and one that stays invisible while the wallet is empty."* Any multi-worker design
needs a distributed lock or per-agent key isolation from day one.

**7f. An in-memory daily cap is not a daily cap.** meridian's reset only on process restart, so it
was really "spend since last boot": long uptime falsely blocked, frequent redeploys never enforced
(`risk.ts:7-11`). The spend ledger must be durable.

**7g. A flag saying "automatic" is not automation.** openhood's `AUTOMATIC_EXECUTION_WIRED` was
`true` while `engine.ts` never called `evaluateOnce` — *"The flag said automatic; the system was
operator-initiated"* (`trading/tick.ts:8-12`). Any such claim in this repo must be backed by a test
that fails if the call is removed.

**7h. Verify that your verifier compiles what you changed.** unitick's acceptance suite claimed in
its own header to build before serving and never did — it tested whatever bundle was on disk.
Reintroducing a real live defect produced **19/19 green** (`taia/ARCHIVE.md` footnote).

**7i. A green gate is not a good page.** openhood shipped an oklch palette *"never referenced by the
renderer. Not once"* alongside "136 KB gzipped, 59.9 FPS on mobile, gate 25/25". It took **zero**
mobile-width screenshots and drew **nine** mobile complaints. Render at 390px and 1440px and
describe both in prose.

**7i-bis. A TRAILING `|| true` MADE EVERY FAILED BUILD REPORT SUCCESS.** Found on Railway, and it
is the worst defect in this build because it disguises every other defect. `apps/web`'s build script
ended:

```
next build && cp -r .next/static ... && cp -r public ... 2>/dev/null || true
```

The `|| true` was written to tolerate a missing `public/` directory. Shell precedence applies it to
the **entire `&&` chain**, so a failing `next build` exited **0**. Railway reported `SUCCESS`, the
container had no `.next/standalone` at all, and every route served **502**.

Two things make this worth recording rather than just fixing:

1. **The first fix did not work and only a sabotage revealed that.** Adding `set -e` to the parent
   script felt sufficient and changed nothing — the child script still exited 0. Appending an
   unresolvable import to `page.tsx` and re-running is what proved it: exit 0 before, exit 1 after
   the real fix (scoping the `|| true` with braces). Without that check a second non-fix would have
   been pushed and another green SUCCESS read off a broken deploy.
2. **It is the same shape as a finding already in this corpus.** meridian recorded that *"piping a
   git command into `tail` hides its exit code — `git pull --rebase | tail && git push` will push
   even when the rebase failed."* Same class, different operator. **Any construct that can swallow a
   non-zero exit belongs nowhere near a build or a deploy.**

**7i-ter. RAILWAY USES RAILPACK, NOT NIXPACKS, AND `SUCCESS` MEANS BUILT.** Two deploys failed with
`No start command detected` while `NIXPACKS_BUILD_CMD`/`NIXPACKS_START_CMD` were set and silently
ignored — Railpack resolves the start command from the root `package.json` first. A third built
cleanly and **CRASHED** on `MODULE_NOT_FOUND`, because without `outputFileTracingRoot` pinned, Next
infers the workspace root from whichever lockfile it finds and nests `standalone/` differently on
Railway than locally. `@taia/railway`'s rule stated plainly: **deploy-then-VERIFY — SUCCESS means
the build shipped, not that anything serves.** Only `curl` settles it.

**7j. 576 DOM divs per creature is a mobile perf hazard.** openhood renders its pixel creatures as
one `<div>` per lit pixel. With a colony of cats on screen this will not hold. Render to `<canvas>`
or a single inline SVG.

---

## 7b. BLOODHORN'S MOTION MODEL — measured from source, because both guesses were wrong

Ibrahim: *"bloodhorn mascots they don't move around, they teleport to different places."* I had
built continuous Reynolds wander. Reading
`openhood/apps/web/components/game/engine/agents.ts` settles it, and it is **neither**:

1. **Agents have a HOME derived from the fixed BLOCK they occupy.** The world is laid-out slots,
   not free space. An agent does not roam.
2. **`const WALK_MS = 1400`.** When a tick moves an agent to a different block it WALKS a path over
   1400ms and then stops. So: mostly still, occasionally a deliberate traversal.
3. **The life between ticks is BREATHING IN PLACE**, and the file's own header calls it *"the most
   important animation in the project"*:

   > "Ticks are five minutes apart. Without a continuous idle the city is a diagram that changes
   > twice an hour; with it, twenty sprites read as alive in the gaps. Every agent gets its own
   > phase AND its own rate from its id, so they never breathe in unison — **synchronised breathing
   > reads as one animation played twenty times, which is the single most life-killing artifact
   > possible in a crowd scene.**"

4. **A three-part body keeps a lit sprite legible**: a dark SHADOW ellipse on the ground (*"without
   it the machine floats"*), AURA+HALO additive glow at decorrelated rates, and the SPRITE drawn
   LAST so it sits on top of its own light. *"Additive glow with no dark backing produces mush."*

**The transferable point:** "alive" came from a per-entity idle with decorrelated phase AND rate,
not from movement. Wander is what an entity does when nothing has been designed for it to do.

## 7d. THERE ARE TWO HOOKS. THE VAULT CAN ONLY REACH ONE OF THEM.

**MEASURED 2026-08-07, and this is the most consequential finding in the file.** `RESEARCH §1b`
records a single fee hook, `0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC`, taken from
`/api/config`. It is hardcoded as an `immutable` in `StrayVault.sol` and assumed everywhere.

**There is a second one.** Reading the PoolManager's own `Initialize` events for each token's
`poolId`:

```
hook                                          tokens   24h volume
0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC      65      5194 Ξ
0xEfe669814e5Eec33406Bd50ffa8331618D076aEc      44      1359 Ξ
```

**40% of the pad, and 1,359Ξ of daily volume, is on a hook the deployed vault physically cannot
trade** — its `_encodeSwap` builds every PoolKey with the one immutable hook, so a swap against the
other addresses a pool that does not exist.

**And the second hook holds the best tokens.** LEVCAT, INTERN and Seriouscat — three of the four
highest-volume names on the pad, the ones Ibrahim pointed at directly — are all on
`0xEfe6…6aEc`. CASHBIRD is on the known hook, which is why it alone reconstructed correctly and
masked the problem.

**How it hid for the whole build.** Every PoolKey check ever run started from a token that happened
to be on the first hook: §2 derived the key from CatDay and matched on the first attempt, the fork
tests used CatDay, and the live-fire trades used Yourcoin and CASHDOG. A single-sample verification
of a two-valued field cannot fail. The reconstruction matched *because the sample was homogeneous*,
not because the derivation was right.

**How it surfaced.** Not from a test. A live sell-simulation probe reported "no buy" for LEVCAT at
328Ξ of daily volume — a number that cannot be true — and the implausibility of the *number* is what
prompted unwrapping the revert. `UnexpectedRevertBytes` (`0x6190b2b0`) had been swallowing an empty
inner revert, which is what an uninitialised pool returns.

**The fix is not a constant.** The hook must be read per token from the `Initialize` event (or from
a verified pad field), carried through discovery, and passed into `hunt`/`flee` as part of the
PoolKey — which means `StrayVault`'s immutable `hook` is wrong by design and the contract needs
redeploying with the hook as a per-trade argument. That is a contract change, and it is the single
highest-value fix available: it roughly doubles the reachable market and adds the most liquid names
on the pad.

## 7c. THE SAME BUG TWICE, IN TWO COMPONENTS — and only a user caught the second one

`sort=newest` was fixed in the KEEPER (§7b's neighbouring finding: the scanner and the strategy were
looking at disjoint sets, so every candidate was refused "age < 3600s"). It was **not** fixed in the
WEB app, which fetches its quarry from the same API in `apps/web/app/lib/quarry.ts`.

The consequence was visible on the deployed page and I did not see it. Ibrahim did:

> *"how can the strategy say the 14 huntable targets are viable? they are all dead tokens that
> rugged?"*

He was right. Measured on the live pad, merging `sort=mcap` + `sort=trending` + `sort=newest` and
applying the seed-cap prefilter gives 69 tokens, and the real ones are unmistakable:

```
Seriouscat   382Ξ 24h vol    513 holders   +1406%
LEVCAT       308Ξ           1178 holders
CASHBIRD     219Ξ            767 holders    +659%
INTERN       172Ξ           1252 holders
```

while **7 of 69 have under 0.5Ξ of 24h volume** — effectively dead. The world was showing the
newborns and calling them "huntable"; the strategy was scanning the mature ones. **Two components
reading the same API through different queries and disagreeing about reality.**

**The transferable lesson is not "fix it in both places".** It is that a shared data source deserves
a shared accessor: `discovery.ts` and `quarry.ts` each implemented their own fetch against the same
endpoint, so fixing one could not fix the other and nothing failed when they diverged. A duplicated
query is a duplicated bug with independent lifetimes.

And the detection lesson: **no test caught this and no test could have.** Both components were
internally consistent and both rendered plausible output. What caught it was a person looking at the
page and asking whether the names on it were real — which is the same class of failure as the
"green gate, dead palette" one already recorded at §7i.

## 8. Creature generation — the method to port from openhood

`openhood/apps/web/lib/creature-grid.ts` (847 lines). The method, not the artwork:

- **Hash:** FNV-1a 32-bit from `@taia/ui` — offset basis `2166136261`, prime `16777619`.
  `Math.imul` is load-bearing, being the only way to get correct 32-bit multiplication in JS.
- **Per-axis salting:** each independent trait is `fnv1a(`${id}:${SALT.trait}`)` so features are
  decorrelated rather than sliced from one integer. **`Math.random()` is banned in rendering.**
- **Grid:** 24×24 = 576 cells.
- **Shading:** each body part has a `*Normal(px,py)` returning a surface normal or `null`. Normal ×
  light vector → Lambert term → quantised into a discrete ramp. This is *not* sprite lookup.

**To port for cats:** keep `fnv1a` + salting, the 24×24 grid, and the normal-per-part + quantised
ramp. Keep `head/muzzle/eye/body/leg`. **Delete `hornNormal` and `maneNormal`.** Add `earNormal`
(two triangles, inner surface shading darker), `tailNormal` (a hash-swept curve), and whiskers
(1px lines, no normal). **Bias the hash budget toward ear angle and tail curl** — those carry far
more silhouette identity for a cat than a horn did for a unicorn.

Dithering is **not** in openhood's file — it quantises with no Bayer matrix. The 4×4 Bayer + 8-step
ramp referenced in the corpus is ponsball's. If we dither, we are adding it, not porting it.

---

## 9. House wallet — state at session start

```
$ cast balance 0x1E5A3c8b0120E28Ca3FC554e6a7B7957975ad492 --rpc-url https://rpc.mainnet.chain.robinhood.com
40199933880953577          # 0.04020 ETH = $77.48 at $1927.27
$ cast gas-price --rpc-url https://rpc.mainnet.chain.robinhood.com
30024000                   # 0.030024 gwei
$ cast block-number --rpc-url https://rpc.mainnet.chain.robinhood.com
30254195
```

Budget stated in the brief is **$10** ≈ 0.00519 ETH. The wallet holds 7.7× that, so the budget is a
*policy* limit and must be enforced in code — the balance will not enforce it.

**HOUSE_ADDRESS is shared across projects.** `.env` records that its *"balance moved BOTH directions
and its nonce advanced 980 → 992 during a session in which CUSTODIAN sent nothing."* Therefore
**a spend cap CANNOT be enforced by watching this balance.** Reconcile against tx hashes from our
own sends only.

---

## 10. Still open — carried into CLARIFICATIONS.md / PLAN.md

1. **Custody design.** Answered in direction ("fully automatic, 1-2 clicks, no user interaction")
   but the mechanism is a design decision with real money at stake. §4d gives the structural
   property to build on; the vault shape is decided in PLAN.md.
2. **hook / revenueSplitter unverified** (§1b). Unresolvable by us. Bounded by position size only.
3. **API instability** (§5). Mitigation: degrade to on-chain reads, never hard-fail on the API.
4. **Live-fire limits.** Nothing has been sent on mainnet from this project yet. Every figure in
   this document is a read or a fork simulation. **No live order has been placed.**
