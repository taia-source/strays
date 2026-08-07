# STRAYS — PLAN

Per `BUILD-A-PROJECT.md` step 7. States the user's path as ordered steps, which packages compose to
what, what is written from scratch, what is still open, and the order of work.

Ibrahim's instruction on scope: *"plan first then build but do not stop to approve by me, i've
already approved u"* and *"fully tested and deployed contracts on mainnet once tests are green"*.
So this plan is written and then executed without a stop, with `AskUserQuestion` reserved for a
genuine unknown.

---

## 1. The user's path (from DESIGN §7) → the capability each step requires

| # | Step | Required capability | Where it lives |
|---|---|---|---|
| 1 | arrives at `/` | landing page that explains the product | `apps/web/app/page.tsx` |
| 2 | understands cost + risk | fee split + unaudited disclosure in prose | same |
| 3 | connects wallet | EIP-6963 discovery, chain 4663 switch, dead-wallet handling | `@taia/wallet` |
| 4 | funds + spawns, ONE tx | `adopt()` payable — energy fee + stake in one call | `StrayVault.sol` |
| 5 | sees their cat arrive | deterministic sprite from id, colony map | `packages/cat`, `apps/web` |
| 6 | leaves | — (nothing required) | — |
| 7 | returns to a changed cat | indexed trades, per-cat history, tx links | `apps/indexer`, Postgres |
| 8 | withdraws | `withdraw()` callable by owner, ungated, always | `StrayVault.sol` |

**Step 4 is one transaction and step 8 is always reachable.** Both are acceptance-checked.

---

## 2. Package composition — what is borrowed vs written

**Vendored from `~/work/taia` (19 owned packages; these apply):**

| Package | Used for |
|---|---|
| `@taia/chains` | chain 4663 definition, stack assertion from `web3_clientVersion` |
| `@taia/rpc` | concurrency caps, adaptive `getLogs`, finality probing |
| `@taia/indexer` | cursor, reorg detection (**key on block hash, never number**), idempotency |
| `@taia/wallet` | EIP-6963, verified chain switching, dead-wallet disable-not-hide |
| `@taia/authority` | spend caps, rate limits, delay-window kill switch |
| `@taia/contracts` | invariant-test vacuity detection |
| `@taia/swap` | exact approvals, Permit2 semantics |
| `@taia/deploy` | placeholder + wrong-network address detection |
| `@taia/backtest` | MinBTL overfitting honesty |
| `@taia/e2e` | contrast, layout, perceivability, rendering, cross-engine, liveness |
| `@taia/ui` | **the mechanism kit** — `fnv1a`, `bayer4`, `quantise`, `chase`, `damp`, `incommensurate` |
| `@taia/gate` | secrets, provenance, contract security, licences, env/config |
| `@taia/acceptance` | did the artifact do what was **asked**; invented-data detection |
| `@taia/railway` | deploy-then-VERIFY (SUCCESS means built, not that anything serves) |
| `@taia/tsconfig`, `@taia/tools` | strict TS base, vitest plumbing, fail-on-skip |

**Not used:** `@taia/payments` (no x402 surface in this product — meridian's x402 is a *revenue*
mechanism for selling signals, not relevant here), `@taia/launch` (we are not launching a product
token; the one `TEST` deploy is a throwaway probe).

**Written from scratch (~the 15%):**

| Module | What | Why it cannot be borrowed |
|---|---|---|
| `packages/contracts/src/StrayVault.sol` | per-stray custody + **in-contract swap** | openhood's is EOA-executor; this is the strictly stronger design |
| `packages/hunt/` | eligibility filter, cost bar, signal, sizing, stops | openhood's constants are artifacts of the wrong asset class |
| `packages/cat/` | 16×16 deterministic cat sprite | openhood's is a unicorn with horn + mane |
| `apps/indexer/` | letscash discovery, tick loop, decision log | venue-specific |
| `apps/web/` | landing, colony map, stray, leaderboard, logs, docs | — |

---

## 3. The contract — `StrayVault.sol`

**The one property that makes this design worth the extra work:** the swap executes **inside** the
contract, so `TAKE_ALL` (which has no recipient field) settles proceeds back to the vault itself.
Funds cannot structurally leave except by the owner's `withdraw()`.

```
adopt(bytes32 strayId) payable        owner-only-by-construction; splits msg.value into
                                      energy (to house, immediately) + stake (compartment)
hunt(bytes32 strayId, TradeIntent)    KEEPER ONLY. takes INTENT (token, amountIn, minOut),
                                      never a recipient. builds the router call itself.
withdraw(bytes32 strayId)             OWNER ONLY. ungated by any risk control. always callable.
```

**Auth patterns inherited from `OpenhoodCustody.sol`, which is deployed and working on this chain:**
- **No function takes an address it could pay.** The keeper is `immutable`; the owner is recorded at
  adopt.
- **Isolation is the mapping, not a check** — `mapping(bytes32 => Compartment)`, proven by a
  sabotage test that tries to spend stray A's balance on stray B.
- **A hard per-release cap.** Bounds the unverified-hook risk (RESEARCH §1b).
- **No withdrawal pause, no proxy, no `delegatecall`, no admin sweep.**

**Sabotage suite — the tests are the only thing standing between users and a bug, since there is no
external audit.** Per `BUILD-A-PROJECT.md`: after writing a check, **break the code it guards and
confirm the check fails.** If a sabotage passes, the check is decoration — fix the check, not the
sabotage.

Specific sabotages, each targeting a defect that actually shipped somewhere in this corpus:
1. delete the keeper check on `hunt` → must fail
2. delete the owner check on `withdraw` → must fail
3. spend stray A's compartment on stray B → must fail
4. make `hunt` accept a recipient → must not compile / must fail
5. encode `amountOutMinimum = 0` → must be refused
6. remove the per-release cap → must fail
7. reentrancy on `withdraw` via a malicious receiver → must fail
8. **CEI ordering with `nonReentrant` REMOVED** — unitick's five-time finding: *"when two mechanisms
   can independently reject the same input, at least one test must construct an input that only ONE
   of them rejects."* A CEI violation passed 143 tests because `nonReentrant` alone defeated it.

---

## 4. Order of work

**Phase 1 — contracts.** `StrayVault.sol`, Foundry suite incl. all 8 sabotages, fork tests against
live letscash pools proving a real in-contract swap lands. **Mainnet deploy + verify.**

**Phase 2 — the hunt engine.** Eligibility (`taxPct==1`), cost bar with `gasPriceWei` required,
signal, sizing, stops, drawdown halt. Durable spend ledger (an in-memory cap is not a cap).
Backtest with MinBTL honesty — and if it says not credible, **that is reported, not hidden**.

**Phase 3 — indexer + keeper.** Discovery from `/api/tokens` with on-chain fallback, `TokenLaunched`
log subscription, tick loop, decision log distinguishing **decided** from **landed**. Postgres on
Railway.

**Phase 4 — the cat.** `packages/cat` 16×16 from `fnv1a`, 6-step ramp + Bayer, rendered to PNG and
**looked at** before being called done.

**Phase 5 — web.** Landing, colony (canvas map), stray detail, leaderboard, logs, docs. Screenshots
at **320 / 390 / 768 / 1440**, every one opened and described in prose.

**Phase 6 — gate + deploy.** `pnpm gate` green with zero skips. Railway deploy-then-VERIFY.
Acceptance suite that **actually builds what it serves** (unitick's harness tested a stale bundle
and produced 19/19 green on a live defect).

**Phase 7 — live fire.** `TEST` token deploy, real trade on mainnet, **sweep everything back to
`HOUSE_ADDRESS`**, ARCHIVE.md row appended.

---

## 5. Budget and money discipline

- Total spend cap: **$10** (≈0.00519 ETH at $1927). The house wallet holds **$77.48**, so the cap is
  a *policy* limit enforced in code — the balance will not enforce it.
- **`HOUSE_ADDRESS` is shared across projects.** Its nonce advanced 980→992 during a session in
  which another project sent nothing. **A spend cap cannot be enforced by watching its balance;**
  reconcile against tx hashes from our own sends only.
- A **dedicated deployer key** is generated for this project rather than sharing the house nonce —
  two autonomous signers on one nonce is a race, which is why openhood and custodian both have
  their own.
- Everything sweeps back to `HOUSE_ADDRESS` at the end.

---

## 6. Still open

1. **`hook` / `revenueSplitter` unverified** (RESEARCH §1b). Unmitigable; bounded by position size
   and stated in `/docs`.
2. **API instability** (RESEARCH §5) — no OpenAPI, routes reverse-engineered. Indexer must degrade
   to on-chain reads rather than hard-fail.
3. **Whether the strategy is actually profitable.** Unknown and will be reported honestly. The
   measured 3.3× signal-to-cost ratio says it is *possible*, which is not the same as *proven*.
   MinBTL will likely say a short live sample is not credible, and that will be said out loud.
4. **The permissionless 1% bounties** (RESEARCH §6) are a house revenue stream with no directional
   risk. Not in scope for phase 1–7; recorded as the obvious next step.
