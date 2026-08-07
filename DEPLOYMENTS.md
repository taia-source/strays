# STRAYS — deployments and live-fire record

Everything here is a transaction that landed on **Robinhood Chain mainnet, chain id 4663**, with
real ETH. Nothing in this file is a simulation or a fork.

---

## StrayVault

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

## Spend to date

| | ETH | ~USD @ $1927 |
|---|---|---|
| Fund deployer | 0.003 | $5.78 |
| Fund keeper | 0.0008 | $1.54 |
| Gas + trading loss (net, live fire) | ~0.0005 | ~$0.96 |
| **Recoverable** | deployer + keeper balances sweep back to house | |

Against the **$10 policy cap**. The house wallet held $77.48 at session start, so the cap is enforced
in code and by discipline — **not by the balance**, which would not enforce it.

---

## Not done

- **No external audit.** Stated in `/docs` in the product. The 12-sabotage suite and the fork tests
  are what stands in for one, and they are not a substitute.
- **The pad's `hook` and `revenueSplitter` remain UNVERIFIED on Blockscout.** Every swap routes
  through them. Unmitigable by us; bounded by `MAX_POSITION_WEI`.
- **`TEST` token not yet deployed.** Ibrahim asked for one throwaway launch to prove the
  launch-and-trade path; it is not required by the product and is tracked separately.
