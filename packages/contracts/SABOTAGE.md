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
