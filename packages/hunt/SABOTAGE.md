# SABOTAGE — `@strays/hunt`

Per `BUILD-A-PROJECT.md` and `PLAN.md` §3: **after writing a check, break the code it guards and
confirm the check fails. If a sabotage passes, the check is decoration — fix the check, not the
sabotage.**

Happy-path coverage is the known failure mode of AI-written tests, and coverage numbers do not
detect it. This package reached **100% statements / 100% branches / 100% functions / 100% lines**
*before* any sabotage was run, and two checks were still decoration at that point. That is the
whole argument for this file.

Reproduce with `node sabotage.mjs` (optionally `node sabotage.mjs S12` for one). The harness
applies one find/replace to a source file, runs the entire suite, records whether it went red, and
restores the file. Machine-readable output lands in `sabotage-results.json`.

---

## Result

**37 / 37 caught** after two fixes. Two sabotages escaped on the first run; both are recorded in
full below, with what was wrong and what changed.

| # | File | Sabotage | First run | Now |
|---|---|---|---|---|
| S1 | `eligible.ts` | Remove the `taxPct === 1` hard filter (RULE 1) | CAUGHT (7) | CAUGHT (7) |
| S2 | `eligible.ts` | Loosen `!==` to `>`, admitting `taxPct: 0` | CAUGHT (1) | CAUGHT (1) |
| S3 | `cost.ts` | Remove the `gasPriceWei` guard | CAUGHT (5) | CAUGHT (5) |
| S4 | `cost.ts` | Charge tax on ONE leg only | CAUGHT (10) | CAUGHT (10) |
| S5 | `cost.ts` | Hardcode an anvil gas-price fallback | **ESCAPED** | **CAUGHT (5)** |
| S6 | `bar.ts` | `EDGE_MULTIPLE` 2 → 1 | CAUGHT (7) | CAUGHT (7) |
| S7 | `bar.ts` | Bar always clears | CAUGHT (9) | CAUGHT (9) |
| S8 | `bar.ts` | Remove the non-positive-gain guard (`0 >= 0`) | CAUGHT (1) | CAUGHT (1) |
| S9 | `risk.ts` | **DELETE THE STOP LOSS** (meridian's actual state) | CAUGHT (8) | CAUGHT (8) |
| S10 | `risk.ts` | Widen the stop 10x | CAUGHT (3) | CAUGHT (3) |
| S11 | `risk.ts` | Remove the drawdown halt | CAUGHT (2) | CAUGHT (2) |
| S12 | `risk.ts` | Let `minOut` return zero (MEV sandwich) | **ESCAPED** | **CAUGHT (1)** |
| S13 | `risk.ts` | Accept a non-durable ledger | CAUGHT (2) | CAUGHT (2) |
| S14 | `risk.ts` | Amnesiac ledger — restart loses spend history | CAUGHT (11) | CAUGHT (11) |
| S15 | `risk.ts` | Remove the window spend cap | CAUGHT (4) | CAUGHT (4) |
| S16 | `risk.ts` | Remove the entry count cap | CAUGHT (1) | CAUGHT (1) |
| S17 | `risk.ts` | **Make `mayExit()` return false** | CAUGHT (2) | CAUGHT (2) |
| S18 | `decide.ts` | **Gate the exit behind the drawdown halt** | CAUGHT (2) | CAUGHT (2) |
| S19 | `decide.ts` | Evaluate entry before exit | CAUGHT (1) | CAUGHT (1) |
| S20 | `signal.ts` | Window from SAMPLE COUNT, not the clock | CAUGHT (17) | CAUGHT (17) |
| S21 | `signal.ts` | Port openhood's 53bps sigma | CAUGHT (13) | CAUGHT (13) |
| S22 | `signal.ts` | Remove the long-only guard | CAUGHT (2) | CAUGHT (2) |
| S23 | `signal.ts` | Remove the take-profit cost floor | CAUGHT (1) | CAUGHT (1) |
| S24 | `eligible.ts` | Remove the liquidity floor | CAUGHT (2) | CAUGHT (2) |
| S25 | `eligible.ts` | Remove the holders floor | CAUGHT (3) | CAUGHT (3) |
| S26 | `eligible.ts` | Remove the age bounds | CAUGHT (2) | CAUGHT (2) |
| S27 | `eligible.ts` | Let config overrule the tax arithmetic | CAUGHT (1) | CAUGHT (1) |
| S28 | `decide.ts` | Skip eligibility inside `decide` | CAUGHT (1) | CAUGHT (1) |
| S29 | `decide.ts` | Force a sale on an unreadable mark price | CAUGHT (1) | CAUGHT (1) |
| S30 | `cost.ts` | Reintroduce openhood's 5bps pool fee | CAUGHT (11) | CAUGHT (11) |
| S31 | `risk.ts` | Delete the *second* `minOut` guard | added after S12 | CAUGHT (2) |
| S32 | `risk.ts` | Delete only the 100%-slippage guard | added after S12 | CAUGHT (2) |
| S33 | `eligible.ts` | Delete only the non-integer `taxPct` guard | added after S12 | CAUGHT (1) |
| S34 | `signal.ts` | Delete only the zero-elapsed-time guard | added after S12 | CAUGHT (2) |
| S35 | `signal.ts` | Delete only the `< 2 points` guard | added after S12 | CAUGHT (2) |
| S36 | `risk.ts` | Delete only the compartment-affordability clamp | added after S12 | CAUGHT (1) |
| S37 | `cost.ts` | Delete only the positive-position guard | added after S12 | CAUGHT (2) |

`(n)` is the number of tests that went red.

---

## S12 — ESCAPED. The check was decoration. **The check was fixed.**

### What was sabotaged

`minOutFor`'s explicit non-positive guard was deleted:

```ts
-  if (args.expectedOut <= 0n) { throw new Error("...free MEV sandwich (RESEARCH §7c)"); }
+  if (false) { ... }
```

RESEARCH §7c: *"`amountOutMinimum = 0` is a free MEV sandwich."* This is one of the two named
slippage slots.

### Why the suite did not notice

`minOutFor` has **two independent guards** that both reject a non-positive `expectedOut`:

1. `expectedOut <= 0n` — the explicit one, deleted by the sabotage.
2. `minOut <= 0n` — catches a floor that rounded to zero.

With guard 1 deleted, `expectedOut = 0` flows through to `minOut = 0` and **guard 2 throws
anyway**. The test asserted only:

```ts
expect(() => minOutFor({ expectedOut: 0n, slippageBps: 100n })).toThrow(/free MEV sandwich/);
```

Both guards' messages contain "free MEV sandwich", so **either guard satisfies the assertion**. The
test could not tell which mechanism fired, so deleting one of them was invisible.

This is precisely the finding `PLAN.md` §3 records unitick hitting **five times**:

> *"when two mechanisms can independently reject the same input, at least one test must construct
> an input that only ONE of them rejects."*

A CEI violation there passed 143 tests because `nonReentrant` alone defeated it. Same shape here.

### The fix — to the check, not the sabotage

Added `src/risk.test.ts` → *"SABOTAGE S12: the non-positive guard fires FIRST, distinguishably
from the rounding guard"*, which pins each guard to an input only it rejects:

- `expectedOut = 0` and `-1` must throw **`/non-positive expected output/`** (guard 1's wording).
- `expectedOut = 1, slippageBps = 9999` must throw **`/rounded to zero/`** (guard 2's wording) and
  must **not** throw guard 1's message.

Delete guard 1 now and the first assertion fails, because guard 2's different message no longer
matches. S31 was then added to sabotage the *other* half of the pair, and it is caught too — so
both mechanisms are independently pinned rather than one covering for the other.

### What it prompted

S12's escape was a signal about a **class** of defect, not one function. S31–S37 were added to
delete exactly one half of every other guard pair in the codebase. All seven are caught, so no
other check in this package is currently resting on a neighbour.

---

## S5 — ESCAPED, but the sabotage was the defect, not the check

Recorded rather than quietly deleted, because a sabotage that tests nothing is as misleading as a
test that tests nothing — and the first version of this one was a genuine no-op.

### The original sabotage

```ts
const gasUnits = args.gasUnits ?? ...;
+ args = { ...args, gasPriceWei: args.gasPriceWei > 0n ? args.gasPriceWei : 1_019_000_000n };
```

Appended **after** the guard. But the guard has already thrown for every non-positive value by
that point, so `args.gasPriceWei > 0n` is unconditionally true and the ternary can only ever take
its first branch. **The line changes nothing.** The suite was correct to stay green: nothing had
been broken.

### The corrected sabotage

Rewritten to *replace* the guard with the fallback — which is what openhood actually did:

```ts
- if (args.gasPriceWei === undefined || args.gasPriceWei === null || args.gasPriceWei <= 0n) {
+ args = { ...args, gasPriceWei: args.gasPriceWei > 0n ? args.gasPriceWei : 1_019_000_000n };
+ if (false) {
```

**CAUGHT — 5 tests fail.** No production code changed; `cost.ts` was already correct.

The distinction matters: S12 was a real hole in the tests, S5 was a hole in my sabotage. Reporting
both as "escaped" without separating them would overstate the first and hide the second.

---

## A real defect the suite found before any sabotage ran

Not a sabotage, but it belongs here. `cost.test.ts`'s *"an absent gasPriceWei cannot typecheck —
proven at runtime by the same guard"* failed on its first run with:

```
expected [Function] to throw error matching /gasPriceWei is REQUIRED/
but got 'Cannot read properties of undefined (reading 'toString')'
```

The guard itself was correct and did reject `undefined`. But the **message** it built called
`args.gasPriceWei.toString()`, which throws a bare `TypeError` on `undefined` before the real error
is ever constructed. The single most important refusal in this package — the one RESEARCH §7a says
would have stopped openhood shipping a strategy that could only decline — would have surfaced to an
operator as `Cannot read properties of undefined`.

Fixed by using `String(args.gasPriceWei)`, which renders `undefined` rather than throwing on it.
The guard was never wrong; what it *said* was, and only a test that read the message could tell.

---

## Sabotages deliberately NOT attempted

Honesty about scope:

- **Contract-level sabotages** (keeper check on `hunt`, owner check on `withdraw`, compartment
  isolation, reentrancy, CEI-without-`nonReentrant`) belong to `packages/contracts` and its Foundry
  suite. `PLAN.md` §3 lists all eight. None are in scope for this package.
- **Encoder sabotages** (`amountOutMinimum = 0` reaching calldata, `TAKE_ALL` growing a recipient
  argument) belong to the venue/encoder module. This package guarantees `minOut > 0` at its own
  boundary (S12, S31, S32) but does not build calldata, so it cannot prove what is encoded.
- **The reflexivity premise.** `signal.ts` uses momentum on the argument that memecoins have no NAV
  anchor while openhood's RWAs did. No sabotage can test that, because it is a claim about the
  world rather than about the code. RESEARCH §3d measured the move *distribution*, not the
  autocorrelation, and `signal.ts` says so in its header. **It is the largest unverified assumption
  in this package.** The design limits the exposure — a breakout only requires volatility
  clustering, not directional momentum, and the cost bar refuses anything that cannot pay — but the
  honest statement is that it is argued, not measured.
