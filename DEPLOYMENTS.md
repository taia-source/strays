# STRAYS — deployments and live-fire record

Almost everything here is a transaction that landed on **Robinhood Chain mainnet, chain id 4663**,
with real ETH. Nothing in this file is a simulation or a fork.

**The one exception is the first section, and it is labelled as such.** StrayVault V2 is built,
tested and ready, and it has NOT been deployed — the deploy needs a private key and a value
transfer that the building session was correctly not permitted to use. It is at the top because it
is the next thing that should happen, not because it happened.

---

## StrayVault V2 — BUILT AND TESTED, **NOT YET DEPLOYED**

**Status: ready to deploy, blocked on a human-approved key use.** Stated plainly and up top rather
than buried, because the rest of this file is a record of transactions that landed and this is not
one of them.

V2 supports **multiple concurrent positions (8)** and a **per-trade hook**, neither of which the
deployed V1 can express. Both changes are forced by measurement, not preference:

| | V1 (deployed) | V2 (built) |
|---|---|---|
| positions per stray | 1 | 8 |
| hook | one immutable | per-trade, allowlisted to the two real ones |
| exit | −235bps hard stop + take-profit | 50% trailing stop off a per-position watermark |
| reachable pad | 67 of 111 tokens | **111 of 111** |

### Why it is not deployed

The deploy needs `STRAYS_DEPLOYER_PRIVATE_KEY` and a top-up transfer from the house wallet. The
agent session that built and tested V2 was **blocked by its permission system** from reading
`/root/.env` and from sending value — which is the correct outcome. A private key and an outbound
transfer are exactly the two things a human should approve, and the session did not attempt to
route around the block.

Everything up to that point is done. The deploy is captured as one reviewed command:

```bash
cd packages/contracts
./script/deploy-v2.sh            # dry run: preflight, both hooks' code, full test suite, gas
./script/deploy-v2.sh --send     # fund deployer (only if short), deploy, read config back, verify
```

### Measured cost, against the live chain

```
deploy gas       1,989,300 units     (cast estimate --create, not a guess)
gas price       ~31,346,000 wei
cost @2x        ~1.25e14 wei = 0.000125 ETH ~= $0.24
code size        8,751 bytes         (V1 was 6,500)

deployer balance  1,914,318,000,000 wei  -- SHORT by ~1.23e14, so step 0 tops it up
house balance    31,141,315,100,185,036 wei
```

Against the $10 policy cap, `$8.96` of which DEPLOYMENTS already records as spent: this is ~$0.24,
leaving the cap intact at roughly $9.20. **The vault will not be funded and the keeper stays
stopped** — that is Ibrahim's standing instruction and this deploy does not change it.

### Constructor arguments the script uses

```
house         0x1E5A3c8b0120E28Ca3FC554e6a7B7957975ad492
keeper        0xf4b89Bd912Cdcd7C88b9293cd036C79F4E9F957c
router        0x8876789976dEcBfCbBbe364623C63652db8C0904   (UniversalRouter)
permit2       0x000000000022D473030F116dDEE9F6B43aC78BA3
hookA         0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC   (67 tokens, 5194 Xi/24h)
hookB         0xEfe669814e5Eec33406Bd50ffa8331618D076aEc   (44 tokens, 1359 Xi/24h)
poolManager   0x8366a39CC670B4001A1121B8F6A443A643e40951   (Uniswap v4 singleton)

PROFIT_RAKE_BPS    1000    MAX_POSITION_WEI   1e16   (per position)
ENERGY_FEE_BPS     2000    MIN_ADOPT_WEI      1e15
MAX_POSITIONS         8
```

All seven addresses are `immutable` with no setter. `test_SABOTAGE_hooksHaveNoSetter` and
`test_SABOTAGE_houseAndKeeperHaveNoSetter` probe the ABI to prove it.

The script re-reads **every** immutable off the deployed bytecode after deploying, rather than
echoing what it sent — `@taia/deploy`'s rule that an address written down is not an address
deployed. It also asserts `isKnownHook(0x…dEaD) == false` on the live contract.

### Test evidence behind it

```
forge test --no-match-contract ForkSwap      58 passed, 0 failed, 0 skipped
forge test --match-contract ForkSwap --fork-url $ROBINHOOD_RPC_URL
                                              9 passed, 0 failed, 0 skipped
```

**LEVCAT round-trips at 199bps on hook B against live liquidity — a token the deployed V1 cannot
trade at all.** `test_fork_hookBTokensWereUnreachableInV1` proves the point directly: on the same
fork at the same block, the V1 PoolKey for LEVCAT reverts and the V2 PoolKey succeeds.

**19 sabotages applied to the source; all 19 caught.** One (`S22`) survived its first check and the
check was fixed rather than the sabotage — see `packages/contracts/SABOTAGE.md`.

---

## StrayVault V1 — DEPLOYED (superseded by V2 above)

| | |
|---|---|
| **Address** | `0xD4233cae4804A2A9b7Db2e0a2362FD2Fc5279E33` |
| **Deploy tx** | `0x042caaa3837db2ef189dc2fb6360c4f41dc1a71e0fb004700c6a9ce9eead133b` |
| **Explorer** | <https://robinhoodchain.blockscout.com/address/0xD4233cae4804A2A9b7Db2e0a2362FD2Fc5279E33> |
| **Source** | **VERIFIED** on Blockscout (`Pass - Verified`), solc 0.8.28, 200 runs |
| **Code size** | 6,500 bytes |

### Constructor config — READ BACK FROM THE DEPLOYED BYTECODE

Not from what we sent. `@taia/deploy`'s rule is that an address written down is not an address
deployed, so every field below was re-read from chain after deployment:

```
house         0x1E5A3c8b0120E28Ca3FC554e6a7B7957975ad492
keeper        0xf4b89Bd912Cdcd7C88b9293cd036C79F4E9F957c
router        0x8876789976dEcBfCbBbe364623C63652db8C0904   (UniversalRouter)
permit2       0x000000000022D473030F116dDEE9F6B43aC78BA3
hook          0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC   (letscash fee hook)
poolManager   0x8366a39CC670B4001A1121B8F6A443A643e40951   (Uniswap v4 singleton)

PROFIT_RAKE_BPS    1000    (10% of PROFIT only)
ENERGY_FEE_BPS     2000    (20%, taken at adopt)
MAX_POSITION_WEI   1e16    (0.01 ETH)
MIN_ADOPT_WEI      1e15    (0.001 ETH)
```

All six addresses are `immutable` and there is no setter for any of them —
`test_SABOTAGE_houseAndKeeperHaveNoSetter` probes the ABI to prove it.

---

## Keys — deliberately isolated from the shared house wallet

| Role | Address |
|---|---|
| Deployer | `0x0d3E845D1E6ac5A4B9871d6bb3B343D8aAdad933` |
| Keeper | `0xf4b89Bd912Cdcd7C88b9293cd036C79F4E9F957c` |

Generated fresh with `cast wallet new` and recorded in `/root/.env`. **They do not share
`HOUSE_ADDRESS`'s nonce**, and that is not a stylistic choice: `.env` already records that
`HOUSE_ADDRESS`'s *"balance moved BOTH directions and its nonce advanced 980 → 992 during a session
in which CUSTODIAN sent nothing."* Two autonomous signers on one nonce is a race, and openhood and
custodian each hit it before this project existed.

**A consequence worth stating: a spend cap cannot be enforced by watching the house balance.**
Reconciliation is against tx hashes from the two addresses above only.

Funding, from the house wallet:

```
fund deployer   0x65a65a4225fff6937d41224eacc60a2c3d5ab76359874d061b0acfd45dfa8dbe   0.003  ETH
fund keeper     0x405623ad9394d2186577255d3c166affdb210e34497dc5daab4d3229c6216e59   0.0008 ETH
```

The keeper holds gas money only. It never custodies user funds — it can call `hunt`/`flee` and
nothing else.

---

## LIVE FIRE — the full user path, on mainnet, with real money

Stray id `0x61ee5c447d6b48a9d7ed1e3a62042edcee86fa3d63dd4b670e724388f1ddf846`.
Token hunted: **Yourcoin** `0x29E2430F97430e3cCeF7119872E27659d78A4acc`, 1% tax, tickSpacing 200.

| Step | tx | gas | result |
|---|---|---|---|
| **1. adopt** (0.002 ETH) | `0x4d27260574f1573dca02099fb9cbf84486455f9ca3e66c74f5d34b43d58216d2` | 86,819 | stake 0.0016 ETH, 20% fee to house |
| **2. hunt** (buy 0.0012 ETH) | `0x4f1f629c53c62bfb45cdc200ac6bf3f87c59ee69f5756bad251bdbe9950d72ea` | 220,943 | **561,427,711,187,993,685,936,805 units, in the vault** |
| **3. flee** (sell all) | `0x5b737469d96d8d80b595ba18dadd90e9c78293107b40a2d1992bf8ca22ed1b08` | 182,657 | flat, stake 0.00157612 ETH |
| **4. withdraw** | `0x18f275baeb0952e6bd2416351123fe85e9dc6382c50151b7ebd1e09ef80919c9` | 42,735 | user paid out, **rake 0** |

### What this proves, and how

**The round trip cost 199.0 bps** — `1,600,000,000,000,000 → 1,576,120,000,000,000 wei`, a cost of
`23,880,000,000,000 wei` against a `0.0012 ETH` position.

That is the **third independent measurement of the same number**, and all three agree:

| Method | 1% tax round trip |
|---|---|
| Standalone viem probe, anvil fork (`probe/rt5.mjs`) | 199.0 bps |
| The contract itself, anvil fork (`ForkSwap.t.sol`) | 199 bps |
| **The contract, mainnet, real ETH** | **199.0 bps** |

**The rake is zero on a loss.** `quoteWithdraw` returned `(1576120000000000, 0)` and the house
balance was **byte-identical before and after** the withdrawal: `33641612886269577` → `33641612886269577`,
a delta of exactly **0 wei**. The round trip lost money to the pad's tax, so the house took nothing.
`DESIGN.md` §4's claim that the rake never touches principal is now an on-chain fact rather than an
assertion.

**The vault reconciles to zero.** After the withdrawal, `stakeOf` is 0 and the contract's ETH balance
is 0. No dust stranded, no rounding residue.

**Custody held.** Tokens landed in the vault at step 2 and never touched the keeper or the house.

---

## Spend — FINAL, at the cap

**$8.96 of the $10 policy cap is irrecoverably spent. All spending has stopped.**

```
house at session start   40,199,933,880,953,577 wei  ($77.48)
house now                34,784,608,982,586,682 wei  ($67.04)
net out                   5,415,324,898,366,895 wei  ($10.44)
  of which recoverable      764,249,521,006,000 wei  ($1.47, keeper gas — kept so it CAN run)
  IRRECOVERABLE                                       ($8.96)
```

Everything else swept back. **The vault holds 0** — every stray withdrawn, no user funds stranded,
verified on chain. What the $8.96 bought: a deployed and verified contract, a live-fire round trip,
two fully autonomous round trips (one take-profit, one stop-loss), and the price history that made
the backtest possible.

## Spend — earlier reconciliation, superseded

Swept back on completion, per the instruction that everything returns to `HOUSE_ADDRESS`.
Sweep tx: `0x86e437a4298ef56e6ee8caf203b7e504073050c01da99f5c9e740ec6f9b286d5`.

```
house at session start   40199933880953577 wei
house after sweep        36166873534659577 wei
net spent                 4033060346294000 wei  =  0.004033 ETH  =  $7.77
```

Of that, still recoverable:

| | wei | USD |
|---|---|---|
| keeper gas balance — **kept deliberately, it must be able to run** | 787,961,152,774,000 | $1.52 |
| deployer dust | 1,266,048,000,000 | $0.0024 |

**Irrecoverably spent: 3,243,833,145,520,000 wei = $6.25.** That is deploy gas, four live-fire
transactions, and the ~199bps trading loss on the round trip.

**Against the $10 cap: 63%.** The house wallet held $77.48 at session start, so the cap was enforced
by discipline and by code — **never by the balance**, which could not have enforced it. `.env` records
why: `HOUSE_ADDRESS` is shared, and its nonce advanced 980 → 992 during a session in which another
project sent nothing.

**The vault holds 0.** No user funds are stranded in it, verified on chain after the live-fire
withdrawal.

---

---

## AUTONOMOUS TRADING — two complete round trips, no human in the loop

The keeper chose the tokens, sized the positions from the stray's own compartment, entered, priced
its own exits, and closed both. Stray `0x4e4ccd7e…`.

| # | outcome | detail |
|---|---|---|
| 1 | **TAKE PROFIT** | bought 57,092,283,279,985,038,768,190 units for 0.00104 ETH (blk 30448514), sold for 0.001046819814464775 ETH (blk 30452877) — **+66 bps net of a 199bps round-trip tax** |
| 2 | **STOP LOSS** | re-entered at blk 30453776, price fell to **−926 bps** from entry, breached the −235bps hard stop, and the cat exited itself |

```
principal  2,080,000,000,000,000 wei   ($4.01)
stake now  1,990,193,484,509,105 wei   ($3.84)
net           −89,806,515,490,895 wei  (−$0.17, −4.3%)
```

**The loss is the more valuable of the two.** A take-profit proves the happy path; a stop that fires
on a real −926bps move and executes on chain proves the risk control is wired to something. Both
paths are now exercised against live money rather than asserted.

**What this is NOT.** Two trades is not evidence the strategy works — openhood's own record calls one
winning trade over 15 days *"worth nothing"*, and that judgement applies here with equal force. It is
evidence the MACHINERY works end to end: discovery, screening, the sell simulation, sizing, the cost
bar, execution, position valuation, the stop, and the durable ledger.

## Not done

- **No external audit.** Stated in `/docs` in the product. The 12-sabotage suite and the fork tests
  are what stands in for one, and they are not a substitute.
- **The pad's `hook` and `revenueSplitter` remain UNVERIFIED on Blockscout.** Every swap routes
  through them. Unmitigable by us; bounded by `MAX_POSITION_WEI`.
- **`TEST` token not yet deployed.** Ibrahim asked for one throwaway launch to prove the
  launch-and-trade path; it is not required by the product and is tracked separately.
