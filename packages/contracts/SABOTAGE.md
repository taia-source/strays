# StrayVault — sabotage results

There is **no external audit** of this contract. Ibrahim authorised mainnet deployment once tests
are green, which means this suite is the only thing between a user and a bug. So the tests were
validated the only way that means anything: **the source was broken, and the suite had to notice.**

> "After writing a check, break the code it guards and confirm the check fails. **If a sabotage
> passes, the check is decoration. Fix the check, not the sabotage.**" — `BUILD-A-PROJECT.md`

Method: `src/StrayVault.sol` is patched to reintroduce a specific defect, `forge test` is run, and
the sabotage is restored. A sabotage is CAUGHT only if a test actually fails.

---

## Round 1 — 11 sabotages, 9 caught, **2 survived**

| # | Sabotage | Result |
|---|---|---|
| S1 | keeper check removed from `hunt` | CAUGHT |
| S2 | owner check removed from `withdraw` | CAUGHT |
| S3 | compartment isolation broken (`ethIn > s.stake` check deleted) | CAUGHT |
| S5 | zero slippage bound allowed on `hunt` | CAUGHT |
| S6 | `MAX_POSITION_WEI` cap removed | CAUGHT |
| S8 | CEI violated — pay out **before** zeroing the stake | CAUGHT |
| S9 | rake charged on principal as well as profit | CAUGHT |
| S10 | `TAKE_ALL` swapped for `TAKE` **with a recipient field** | CAUGHT |
| **S7** | **`nonReentrant` deleted from `withdraw`** | **SURVIVED** |
| **S11** | **`house` made mutable with a public setter** | **SURVIVED** |

### Why the two survived — the same shape, for the sixth time in this corpus

Both are instances of the rule that keeps catching this codebase's ancestors:

> **When two mechanisms can independently reject the same input, at least one test must construct
> an input that only ONE of them rejects.**

**S7 is the exact INVERSE of unitick's recorded bug.** There, `nonReentrant` masked a CEI violation
and 143 tests passed. Here, **CEI masks a missing reentrancy guard**: the stake is zeroed before any
ETH moves, so a re-entrant call finds nothing to take and reverts on its own with
`InsufficientStake`. The attack fails either way, so `test_SABOTAGE_reentrantWithdrawBlocked` — which
tested the *attack* — proved nothing about the *guard*.

**S11 survived because nothing ever asserted immutability.** The contract's stated property is "no
function pays a caller-supplied address", and that rests entirely on `house`, `keeper` and `router`
being immutable. Every test checked *behaviour*; none checked that the roles could not be moved.

### The fixes — observe the MECHANISM, not the outcome

`test_SABOTAGE_reentrancyGuardIsTheThingThatRejects` captures the error selector the **inner**
call reverts with and asserts it is `Reentrancy()` *specifically*. With the guard removed the inner
call reverts with `InsufficientStake()` instead, and the assertion fails on the selector mismatch.

`test_SABOTAGE_houseAndKeeperHaveNoSetter` probes the **ABI**: a setter would exist as a callable
selector, so a raw call that *succeeds* means somebody added one.

---

## Round 2 — the survivors, re-run against the new tests

| # | Sabotage | Result | What failed |
|---|---|---|---|
| S7 | `nonReentrant` removed from `withdraw` | **CAUGHT** | `the reentrant call was rejected by something OTHER than nonReentrant` — selector `0xf1bc94d2` (`InsufficientStake`) ≠ `0xab143c06` (`Reentrancy`) |
| S11 | `house` made settable | **CAUGHT** | `setHouse exists - the fee recipient can be redirected` |
| S12 | `keeper` made settable | **CAUGHT** | `setKeeper exists - the trading role can be seized` |

**12 of 12 sabotages now caught.**

---

## The bug this process actually found, before any sabotage ran

Worth recording separately, because it was a real defect in shipped-intent code rather than an
injected one, and it would have **spent real ETH on malformed calldata**.

`_encodeSwap` originally passed the `PoolKey` and the four other swap fields to `abi.encode` as
five **positional arguments**. Diffing its output against viem — the encoder whose bytes were
verified against a swap that landed on chain 4663 — showed the Solidity output was **64 bytes
short**, with every word from index 6 onward **shifted by one**:

```
 >> [ 6] viem 00000000000000000000000000000000000000000000000000000000000001e0
     [ 6] sol  00000000000000000000000000000000000000000000000000000000000001c0
 >> [ 9] viem 0000000000000000000000000000000000000000000000000000000000000020   <- the missing word
     [ 9] sol  0000000000000000000000000000000000000000000000000000000000000000
```

**Cause:** `ExactInputSingleParams` contains a `bytes` member (`hookData`), which makes the whole
struct **dynamic**. A dynamic struct is encoded as an offset word pointing at its body — the `0x20`
at word [9] — and encoding its fields positionally omits that word entirely.

openhood's `venue.ts` records the identical defect in its own first encoder, and describes it
exactly right: *"a difference no type checker and no unit test of my own arithmetic would have
caught, and which would have spent real ETH on a malformed call."*

It is now pinned by `test_encodingMatchesProvenViemBytes`, which compares against the literal viem
bytes rather than against a re-derivation, so the test cannot drift with the code it guards.

---

## Current state

```
$ forge test
Ran 3 test suites: 29 tests passed, 0 failed, 0 skipped (29 total tests)
```

**Zero skips.** A skipped test is not a pass.

---

## The SECOND real bug, found only by the fork test

Recorded because it is the exact class of defect a mock cannot reach, and because every unit test
passed while it was present.

**`receive()` accepted the router only. The PoolManager is what sends the ETH.**

v4's `take(currency, recipient, amount)` is executed by the **PoolManager singleton**, so on a sell
the native transfer arrives from `0x8366a39C…` and never from the router. Against the real venue the
entire sell executed correctly — swap, hook, tax, settle, take — and then reverted on the final line:

```
├─ PoolManager::take(0x0…0, StrayVault, 2548260000000000)
│   ├─ StrayVault::receive{value: 2548260000000000}()
│   │   └─ ← [Revert] TransferFailed()
└─ ← WrappedError(…, NativeTransferFailed())
```

25 unit tests passed throughout, because a mock router sends its own ETH. **A mock is a statement
about what you already believe.** The fix adds `poolManager` as a second immutable and allows it in
`receive()`.

---

## Fork results — the contract against LIVE letscash pools

`forge test --match-contract ForkSwap --fork-url https://rpc.mainnet.chain.robinhood.com`

```
[PASS] test_fork_buyThenSellRoundTrips
  bought (raw units): 1218005701254668367313437
  stake before: 16000000000000000
  stake after : 15948260000000000
  measured round-trip cost, bps of position: 199

[PASS] test_fork_measureCostAcrossTaxTiers
  tax  1% -> round-trip  199 bps
  tax  3% -> round-trip  591 bps
  tax  5% -> round-trip  975 bps
  tax 10% -> round-trip 1900 bps

[PASS] test_fork_proceedsLandInTheVault
[PASS] test_fork_withdrawAfterARealRoundTrip

4 passed; 0 failed; 0 skipped
```

**The contract's on-chain measurements reproduce RESEARCH §3b's independent off-chain probe to the
basis point** (199 / 591 / 975 / 1900 vs 199.0 / 591.0 / 975.0 / 1900.0). Two different methods —
a standalone viem script and the deployed contract itself — agreeing exactly is the strongest
evidence available that the cost model is right and the strategy's `taxPct == 1` filter is justified.

**Total: 33 tests, 0 failed, 0 skipped.**

---
---

# V2 — MULTIPLE POSITIONS AND A PER-TRADE HOOK

The contract above is `StrayVault` **v1**, deployed at `0xD4233cae…`. It is superseded. Two of its
design decisions could not be patched from the keeper side and required a redeploy:

1. **One position per stray.** `packages/backtest` §10.5 measured that one slot takes 17 of 72
   held-out opportunities at Welch t **1.16** (not significant), while eight take 71 of 72 at
   t **2.38–2.72 on 20/20 seeds**. The per-ticket edge is the same in both; **what changes is n**.
2. **One immutable hook.** RESEARCH §7d measured two hooks on the pad. V1 hardcodes the first, so
   44 tokens and 1,359Ξ/24h — **including LEVCAT, INTERN and Seriouscat** — are unreachable.

Both were re-verified independently before any code was written, by reconstructing each token's
poolId against both candidate hooks and matching the pad's own `pool` field:

```
0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC    67 tokens
0xEfe669814e5Eec33406Bd50ffa8331618D076aEc    44 tokens   <- LEVCAT, INTERN, Seriouscat, FLORK
UNMATCHED                                       3 tokens   (USDG, LAC, LETSBANK — quote assets)
```

## Round 3 — 19 sabotages against v2

Same method: patch `src/StrayVault.sol` to reintroduce a defect, run `forge test`, restore. A
sabotage is CAUGHT only if a test actually FAILS.

| # | Sabotage | Result | What failed |
|---|---|---|---|
| S1 | keeper check removed from `hunt` | CAUGHT | `onlyKeeperCanHunt` |
| S2 | owner check removed from `withdraw` | CAUGHT | `onlyOwnerCanWithdraw` |
| S3 | compartment isolation broken (`ethIn > s.stake` deleted) | CAUGHT | `keeperCannotSpendStrayAOnStrayB` |
| S5 | zero slippage bound allowed | CAUGHT | `zeroSlippageBoundRefused` |
| S6 | `MAX_POSITION_WEI` cap removed | CAUGHT | `positionCapEnforced` + `positionCapBindsOnEverySlot` |
| S7 | `nonReentrant` removed from `withdraw` | CAUGHT | selector `0xf1bc94d2` ≠ `0xab143c06` |
| S8 | CEI violated — pay out before zeroing the stake | CAUGHT | `CEI_stateIsZeroedBeforeValueMoves` |
| S9 | rake charged on principal as well as profit | CAUGHT | 6 tests |
| S10 | `TAKE_ALL` → `TAKE` with a hardcoded recipient | CAUGHT | `TAKE_ALL is not 2 words: 96 != 64` |
| S11 | `house` made settable | CAUGHT | `houseAndKeeperHaveNoSetter` |
| S12 | `keeper` made settable | CAUGHT | `houseAndKeeperHaveNoSetter` |
| **S13** | **hook allowlist removed** | CAUGHT | `arbitraryHookRefused` |
| **S14** | **`flee` uses `hookA` instead of the position's hook** | CAUGHT | `SELL addressed a different pool than the BUY` |
| **S15** | **duplicate-token check removed** | CAUGHT | `sameTokenCannotOccupyTwoSlots` |
| **S16** | **slot limit removed (9th position overwrites slot 0)** | CAUGHT | `ninthPositionRefusedWithMoneyToSpare` |
| **S17** | **`mark()` made non-monotone — can LOWER a watermark** | CAUGHT | `markNeverLowersTheWatermark` |
| **S18** | **watermark seeded from a constant, not the measured fill** | CAUGHT | `watermarkSeededFromTheMeasuredFill` |
| **S19** | **`mark()` keeper check removed** | CAUGHT | `onlyKeeperCanMark` |
| **S20** | **`flee` clears the slot AFTER the router call** | CAUGHT | `slotIsClearedBeforeTheRouterIsCalled` |
| **S21** | **`withdraw` gated on having no open positions** | CAUGHT | 3 tests |
| **S22** | **`withdraw` loops over positions** | **SURVIVED, then fixed** | see below |
| **S23** | **slot cleared but watermark left behind** | CAUGHT | `reusedSlotDoesNotInheritTheOldWatermark` |
| **S24** | **`hunt` does not debit the stake before the swap** | CAUGHT | 6 tests |
| **S25** | **`flee` credits proceeds to a DIFFERENT stray** | CAUGHT | `slotsAreIndependentWithinAStray` |
| **S26** | **`mark` accepts a slot index past the array (`% MAX`)** | CAUGHT | `badSlotIndexRefusedEverywhere` |

### S22 — the one that survived, and why. THE CONTROL MOVED WITH THE TREATMENT.

`withdraw` must not loop over positions: if its gas grows with the number of open slots, a keeper
can raise the price of a user's exit at will. **An exit whose price the keeper sets is an exit the
keeper can deny.**

The first version of the test compared **two different strays** — a flat one against one holding
eight positions — with a 1000-gas tolerance. It passed with the loop installed.

The reason is the failure mode this corpus keeps producing in new costumes. A loop over all 8 slots
costs more for **every** stray, the flat one included, because it reads eight mostly-empty slots
regardless. Both sides of the comparison rose — and the flat stray's rose *further*:

```
                       baseline        sabotaged
  0 positions           14,230           32,097
  8 positions           14,230           20,513
                                       ^^^^^^^^ LOWER than the control
```

So `assertLt(gasFull, gasFlat + 1000)` passed **more comfortably under the sabotage than without
it**. The measurement was not weak; it was pointing the wrong way. This is the same lesson as the
two-hook bug one level up: *a comparison in which the control is contaminated by the treatment
measures nothing, however precise the instrument.*

**The fix varies only the thing under test** — the same call, on identically funded strays, at 0
open slots and at 8 — and asserts **exact equality** rather than a tolerance, because the property
is not "roughly constant". Any per-position term at all is the bug.

```
  withdraw gas, 0 positions: 14230
  withdraw gas, 8 positions: 14230      <- exactly equal, and it must be
```

With that, S22 is CAUGHT: `20513 != 32097`.

### A harness bug worth recording, because it briefly reported a false SURVIVED

The sabotage runner classified a run as CAUGHT if the output matched `^Error: Compiler run failed`.
Forge prints `Compiler run failed` **without** the `Error: ` prefix, so S10's first variant — which
failed to compile because `_encodeSwap` is `pure` and `address(this)` is not — was reported as
**SURVIVED** when in fact nothing had been tested at all.

Two things came out of it, and the second matters more:

1. The runner now matches `Compiler run failed|Compilation failed|Compiler error`.
2. **A sabotage that does not compile is not a sabotage.** Relying on `pure` to reject a recipient
   is an accident of that refactor; a real one would use a literal address and compile cleanly. So
   S10 was re-run with a hardcoded `0xDeaDBeef` recipient, which compiles — and *that* is what the
   `TAKE_ALL is not 2 words` assertion catches on the bytes. The original variant is kept in the
   table only because it is honest about how the check was found.

## Current state — v2

```
$ forge test --no-match-contract ForkSwap
Ran 7 test suites: 58 tests passed, 0 failed, 0 skipped (58 total tests)
```

**Zero skips.** A skipped test is not a pass.

## Fork results — v2 against LIVE pools on BOTH hooks

`forge test --match-contract ForkSwap --fork-url $ROBINHOOD_RPC_URL`

```
[PASS] test_fork_roundTripOnHookA
  HOOK A / CatDay
    bought (raw units): 1182208854759772656610182
    entry price wei/token: 2199272987
    round-trip cost, bps of position: 199

[PASS] test_fork_roundTripOnHookB
  HOOK B / LEVCAT
    bought (raw units): 9704289145286000855905
    entry price wei/token: 267922767043
    round-trip cost, bps of position: 199

[PASS] test_fork_hookBTokensWereUnreachableInV1
  LEVCAT bought via hook B (raw units): 9704289145286000855905

[PASS] test_fork_concurrentPositionsAcrossBothHooks
  CatDay  entry wei/token: 2199272987
  LEVCAT  entry wei/token: 267922767043

[PASS] test_fork_measureCostAcrossTaxTiers
  tax  1% -> round-trip  199 bps
  tax  3% -> round-trip  591 bps
  tax  5% -> round-trip  975 bps
  tax 10% -> round-trip 1900 bps

[PASS] test_fork_proceedsLandInTheVaultOnBothHooks
[PASS] test_fork_watermarkTracksRealFillsAndOnlyRises
[PASS] test_fork_withdrawAfterARealRoundTrip
[PASS] test_fork_arbitraryHookRefusedOnChain

9 passed; 0 failed; 0 skipped
```

**LEVCAT round-trips at 199 bps on hook B — a token the deployed v1 cannot trade at all.** And the
tax-tier measurements still reproduce RESEARCH §3b to the basis point (199/591/975/1900), so the
per-trade hook did not disturb the encoding that three independent methods already agreed on.

`test_fork_hookBTokensWereUnreachableInV1` is the one that makes the redeploy's justification
evidence rather than prose: **on the same fork, at the same block, the v1 PoolKey for LEVCAT reverts
and the v2 PoolKey succeeds.**

**Total: 67 tests, 0 failed, 0 skipped.**
