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

**87 / 87 caught** after six fixes. Six sabotages escaped on a first run; all six are recorded
in full below, with what was wrong and what changed.

S1–S37 are the original suite (two escapes, S5 and S12). **S54–S55 were added when `edgeMultiple`
became configuration** — see the note under the table. **S38–S53 were added by the REBUILD** —
the sell simulation, the concentration screen, the scoring model, and the two real bugs the rebuild
uncovered. One of those escaped (S47) and the check it exposed as decoration was fixed.

**S56–S87 were added by the MEASURED-STRATEGY rewrite** (RESULTS.md §10): eight concurrent
positions, entry by a token's age in swaps, exit on a 50% trailing stop from a peak watermark, and
the two-hook allowlist. One escape, S51, and it is the most interesting result in this file — see
below.

### S51 ESCAPED A SECOND TIME, AND THIS TIME THE CHECK HAD GONE DEAD

S51 replaces `if (score.netEdgeBps <= 0n)` with `if (false)`. It was CAUGHT before the rewrite and
PASSED after it, with **no test change in between** — the sabotage found a check that the rewrite
had silently turned into dead code.

The cause is that the two gates stopped being independent. Break-even asks `move > costBps`; the
cost bar asks `move >= multiple x costBps` with `multiple >= 1`. Under the OLD design they were fed
DIFFERENT quantities — the bar got `signal.ts`'s momentum take-profit projection, break-even got the
observed move — so either could fire alone. The rewrite feeds both from the same measured held-out
median, which makes the bar strictly stronger and break-even unreachable.

This is PLAN.md §3's unitick rule (*"when two mechanisms can independently reject the same input, at
least one test must construct an input that only ONE of them rejects"*) in its worst form: the
weaker mechanism had stopped being able to reject anything at all, and it still read as a safety
check in review.

**The fix is the ORDER, not a deletion.** Break-even is the weaker and more fundamental condition,
so it now runs first and fires with the more specific message on candidates the bar would also have
refused. Two new tests in `decide.test.ts` construct an input each gate rejects ALONE: a 10%-tax
token at 900 gwei (round trip 3,282bps — net edge +1,128bps clears break-even, but 4,410 < 2×3,282
so only the BAR refuses) and the same token at 2 gwei (round trip 4,850bps — net edge is negative,
so only BREAK-EVEN refuses).

Nothing about this was visible in coverage, which was 98%+ throughout.

Note that S1, S2 and S27 were **rewritten**, not merely re-run: they targeted the `taxPct === 1`
hard filter, which no longer exists. Tax is now a cost term (`score.ts`), so those sabotages now
target the checks that replaced it. A sabotage whose pattern no longer matches reports
`PATTERN NOT FOUND` rather than passing silently — which is how the staleness was caught.

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

### The rebuild — S38–S53

| # | File | Sabotage | First run | Now |
|---|---|---|---|---|
| S38 | `screen.ts` | **DELETE THE SELL SIMULATION.** 84/100 live tokens become buyable | CAUGHT (6) | CAUGHT (6) |
| S39 | `screen.ts` | Accept a sell that quotes but returns ZERO wei | CAUGHT (2) | CAUGHT (2) |
| S40 | `screen.ts` | Remove the sniper/bundle ceiling | CAUGHT (4) | CAUGHT (4) |
| S41 | `screen.ts` | Remove the top-10 concentration ceiling | CAUGHT (2) | CAUGHT (2) |
| S42 | `screen.ts` | Remove the creator-holdings ceiling | CAUGHT (2) | CAUGHT (2) |
| S43 | `screen.ts` | Read a NaN sniper figure as 0% concentration | CAUGHT (1) | CAUGHT (1) |
| S44 | `screen.ts` | Check top-10 BEFORE snipers (bundling hides behind top-10) | CAUGHT (4) | CAUGHT (4) |
| S45 | `decide.ts` | **Skip the screen inside `decide`** — module correct, never called | CAUGHT (5) | CAUGHT (5) |
| S46 | `score.ts` | **STOP SUBTRACTING TAX.** Rank on the gross move | CAUGHT (12) | CAUGHT (12) |
| S47 | `score.ts` | Scale a NEGATIVE edge by quality | **ESCAPED** | **CAUGHT (1)** |
| S48 | `score.ts` | Remove the quality clamp, letting a term exceed 1.0 | CAUGHT (4) | CAUGHT (4) |
| S49 | `score.ts` | Drop the deterministic tiebreak (arrival order decides) | CAUGHT (2) | CAUGHT (2) |
| S50 | `decide.ts` | Enter the FIRST survivor, not the best-ranked | CAUGHT (2) | CAUGHT (2) |
| S51 | `decide.ts` | Buy the least-bad token when none has a positive edge | CAUGHT (5) | **ESCAPED, then CAUGHT (2)** — see above |
| S52 | `decide.ts` | **REGRESSION:** cost the exit against config, not the position's tier | CAUGHT (1) | CAUGHT (1) |
| S53 | `signal.ts` | **REGRESSION:** re-truncate the take-profit cost floor downward | CAUGHT (2) | CAUGHT (4) |
| S54 | `decide.ts` | Ignore the configured `edgeMultiple`, fall back to the constant | **ESCAPED** | **CAUGHT (3)** |
| S55 | `decide.ts` | Let the entry BAR and the take-profit FLOOR read different multiples | **ESCAPED** | **CAUGHT (3)** |
| S56 | `risk.ts` | **REINSTATE THE ONE-POSITION RULE** — §10.5's 17-of-72, t=1.16 constraint | — | CAUGHT (12) |
| S57 | `risk.ts` | Let a NINTH position through the contract's fixed 8-slot array | — | CAUGHT (3) |
| S58 | `risk.ts` | Ignore the configured slot count, so a $10 stray acts like a $20 one | — | CAUGHT (2) |
| S59 | `risk.ts` | Size against FREE cash only, so the fraction compounds down and caps the portfolio at ~3 | — | CAUGHT (3) |
| S60 | `risk.ts` | Let a position size exceed free cash, funding a slot from deployed capital | — | CAUGHT (2) |
| S61 | `risk.ts` | Scan slots highest-first, disagreeing with `StrayVault.hunt` | — | CAUGHT (3) |
| S62 | `risk.ts` | Allow the SAME token in two slots | — | CAUGHT (2) |
| S63 | `trail.ts` | **Make the peak watermark NON-MONOTONE**, so the stop follows the price down | — | CAUGHT (5) |
| S64 | `trail.ts` | Let a failed price read reset the watermark (RESEARCH §7f, new costume) | — | CAUGHT (2) |
| S65 | `trail.ts` | Accept a ZERO peak, re-anchoring the stop to the current price | — | CAUGHT (2) |
| S66 | `trail.ts` | Treat an unreadable mark as a 100% fall — one blip sells everything | — | CAUGHT (3) |
| S67 | `trail.ts` | Make the trail exclusive, so it is one tick late by construction | — | CAUGHT (3) |
| S68 | `trail.ts` | Measure the fall from ENTRY rather than the PEAK — the refuted level stop | — | CAUGHT (4) |
| S69 | `trail.ts` | Narrow the 50% trail back to the refuted −235bps | — | CAUGHT (8) |
| S70 | `decide.ts` | SKIP the entry-age gate — `age.ts` correct but never consulted (§7g) | — | CAUGHT (3) |
| S71 | `age.ts` | Remove the entry-window FLOOR (the sellability kill condition) | — | CAUGHT (3) |
| S72 | `age.ts` | Remove the entry-window CEILING, entering at negative-median doses | — | CAUGHT (5) |
| S73 | `age.ts` | Treat a failed `swapCount` read as swap 0 — the most attractive dose | — | CAUGHT (2) |
| S74 | `age.ts` | Move the entry dose past where the measured median crosses zero | — | CAUGHT (55) |
| S75 | `age.ts` | Price every candidate at the BEST dose regardless of its real age | — | CAUGHT (10) |
| S76 | `age.ts` | **Drop the `credible:false` caveat**, reporting +4,410bps as a promise | — | CAUGHT (2) |
| S77 | `hook.ts` | **ACCEPT AN ARBITRARY HOOK** — an attacker's contract inside the swap | — | CAUGHT (9) |
| S78 | `hook.ts` | Drop the SECOND hook, reproducing v1's blindness to 44 of 111 tokens | — | CAUGHT (10) |
| S79 | `hook.ts` | Make the allowlist case-SENSITIVE, refusing legitimate lowercase reads | — | CAUGHT (5) |
| S80 | `hook.ts` | Let `canonicalHook` launder an unknown address into a canonical one | — | CAUGHT (2) |
| S81 | `eligible.ts` | Skip the per-token hook check, so a hostile pool reaches the router | — | CAUGHT (4) |
| S82 | `decide.ts` | RETURN on the first unreadable mark — one blip disarms seven live stops | — | CAUGHT (2) |
| S83 | `decide.ts` | Return HOLD after the exit scan — the one-position rule at the decision layer | — | CAUGHT (3) |
| S84 | `decide.ts` | **Report the wrong SLOT on an exit** — `flee` then sells a different position | — | CAUGHT (5) |
| S85 | `decide.ts` | Match mark prices case-SENSITIVELY, silently disarming a stop | — | CAUGHT (1) |
| S86 | `decide.ts` | Feed the bar the refuted momentum projection again | — | CAUGHT (4) |
| S87 | `decide.ts` | Restore the momentum BREAKOUT gate — re-buying the −5,999bps quintile | — | CAUGHT (3) |

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

## S47 — ESCAPED. The check was decoration. **The check was fixed.**

### What was sabotaged

`scoreCandidate` passes a NEGATIVE net edge through untouched. The sabotage scaled it by the depth
quality instead:

```ts
   const totalBps =
     netEdgeBps > 0n
       ? (netEdgeBps * depthBps * momentumBps) / (BPS * BPS)
-      : netEdgeBps;
+      : (netEdgeBps * depthBps) / BPS;
```

### Why the suite did not notice

The test that existed — *"cost is subtracted BEFORE the quality multipliers"* — built its candidate
with **perfect quality on both axes** (`depthBps = 10000`, `momentumBps = 10000`). Multiplying by
10000/10000 is the identity, so the sabotage changed nothing the assertion could see. The test was
correct about the property it named and blind to the one it was standing in for.

This is the same shape as S12: a guard that appears tested because a *different* path produces the
same observable value.

### Why it matters — it is not cosmetic

Ranking orders losers as well as winners. A loss scaled toward zero sorts **above** an unscaled
smaller loss, so the ordering inverts for exactly the candidates we most want to avoid: a deep,
liquid, actively-bought token that cannot cover its tax would outrank a shallow one that also
cannot. Combined with S51's removal, that is the precise path to buying the worst available token.

### The fix

Two tests added to `score.test.ts`:

1. **`a negative edge is passed through UNSCALED`** — uses *partial* quality on both axes
   (`depthBps` and `momentumBps` strictly between 0 and 10000, asserted so the test cannot silently
   revert to the identity case) and asserts `totalBps === netEdgeBps` exactly.
2. **`ranks two unprofitable candidates by TRUE loss, not by quality`** — the behavioural
   consequence, asserting the better-quality bigger loser sorts below the smaller loser.

The first fails on the sabotage. The lesson recorded: **a multiplier test must never use 1.0 as its
multiplier.**

---

## Two REAL BUGS the rebuild found, now pinned by S52 and S53

Neither was introduced by a sabotage. Both were live defects that the `taxPct === 1` filter had been
concealing, and both are now regression sabotages so they cannot come back.

**1. The exit was costed against the CONFIG's tax, not the position's own tier** (`decide.ts`).
`roundTripCost({ taxPct: cfg.eligibility.requiredTaxPct })` was correct only while every position
was guaranteed to be 1%-tax. The moment any tier became holdable, a 10%-tax exit was costed as a
1%-tax one — understating the round trip by ~1700bps and setting the take-profit at ~471bps instead
of ~4068bps. The stray would have **sold into a "profit" that did not cover the tax.** Fixed by
carrying `taxPct` on `OpenPosition`. Pinned by **S52**.

**2. `levelsFor` truncated the take-profit cost floor DOWNWARD** (`signal.ts`). Integer division
truncates, so the floor came out up to one bp below the true `cost x multiple`, and the expected
gain derived from it landed *fractionally under* the bar in `bar.ts` — which then refused the trade.
Measured on a 10%-tax position: 1016750000000000 wei of gain against 1016806015852000 wei required,
short by 56015852000 wei.

The function's entire promise is that a take-profit "can always pay its own way", and it was
emitting one that provably could not. **The bug is tiny in magnitude and total in effect:** it
silently refused every trade whose take-profit was cost-bound rather than vol-bound — which at 1%
tax is none of them (the 471bps vol level dominates a 462bps cost floor) and at 10% tax is all of
them. It was invisible for exactly as long as only 1%-tax tokens were tradeable. Fixed by rounding
up. Pinned by **S53**.

Both are the same class as RESEARCH §7b's warning: **a plausible-looking number rather than an
error.** Neither would have thrown, logged, or failed a type check.

---

## Sabotages deliberately NOT attempted

Honesty about scope:

- **Contract-level sabotages** (keeper check on `hunt`, owner check on `withdraw`, compartment
  isolation, reentrancy, CEI-without-`nonReentrant`) belong to `packages/contracts` and its Foundry
  suite. `PLAN.md` §3 lists all eight. None are in scope for this package.
- **Encoder sabotages** (`amountOutMinimum = 0` reaching calldata, `TAKE_ALL` growing a recipient
  argument) belong to the venue/encoder module. This package guarantees `minOut > 0` at its own
  boundary (S12, S31, S32) but does not build calldata, so it cannot prove what is encoded.
- **The concentration ceilings are not proven to bind on today's data.** S40–S42 prove the checks
  are wired and load-bearing *in the suite*, using values above the ceilings. But the ceilings
  (top-10 35%, snipers 15%, creator 10%) sit **outside the measured range of this pad** (measured
  maxima 23.92%, 8.82%, 3.36%), so on the current distribution they refuse nothing. They are
  insurance against a distribution shift, and `screen.ts` says so in its header rather than
  implying they are active filters. Concentration does real work today through *ranking*, not
  refusal.
- **That the sell simulation predicts sell-ability at EXECUTION time.** It is an `eth_call` at
  decision time; the pool can change between the quote and the trade. The 84/100 measurement says
  the check has enormous discriminating power, not that it is a guarantee. A honeypot with
  time-delayed activation would pass it — Check Point documented exactly that pattern (the M3 token
  whose tax was set to 99 *after* scanners reviewed it). On this pad the tax is charged by one
  shared hook contract identical for every token, so per-token tax mutation is not the reachable
  attack it is on a general EVM chain — a structural argument, not a proof, and the hook is
  **unverified on Blockscout** (RESEARCH §1b).
- **The reflexivity premise.** `signal.ts` uses momentum on the argument that memecoins have no NAV
  anchor while openhood's RWAs did. No sabotage can test that, because it is a claim about the
  world rather than about the code. RESEARCH §3d measured the move *distribution*, not the
  autocorrelation, and `signal.ts` says so in its header. **It is the largest unverified assumption
  in this package.** The design limits the exposure — a breakout only requires volatility
  clustering, not directional momentum, and the cost bar refuses anything that cannot pay — but the
  honest statement is that it is argued, not measured.


---

## S54 and S55 — added when `EDGE_MULTIPLE` became configuration, and both escaped

`@strays/backtest` reported that `EDGE_MULTIPLE` could not be swept: `decide()` read the
module-level constant directly rather than taking it from `DecideConfig`, so a backtest had no way
to vary it without editing this package. It is now `DecideConfig.edgeMultiple`, optional and
defaulting to the derived `EDGE_MULTIPLE` so every existing caller is unchanged.

A new option needs new checks, and **the first run proved there were none**: both sabotages
escaped a suite that was otherwise catching 53 of 53.

- **S54** replaces `cfg.edgeMultiple ?? EDGE_MULTIPLE` with the bare constant. The option is still
  accepted by the type system and silently ignored. Nothing failed, because no test had ever set
  it to a non-default value and then asserted on the result.
- **S55** is the subtler one. `decide()` uses the multiple TWICE — once for the entry bar
  (`clearsBar`) and once for the take-profit floor (`levelsFor`). S55 lets them disagree. The
  result is a trade that fires against a target which does not cover `multiple × cost`, which is
  precisely the condition the bar exists to prevent, and it is invisible unless a test asserts the
  two are the same number.

Four tests in `decide.test.ts` now pin this: the default is unchanged when the option is omitted,
the configured value reaches `bar.multiple` and `bar.requiredWei`, the bar and the target agree at
every multiple tested (`expectedGainWei >= requiredWei`), and a multiple below 1 is refused.

**The finding this exposed is worth more than the fix.** With the option threaded and sweepable,
`@strays/backtest` swept it and every row was still identical — because `levelsFor` floors the
take-profit at `cost × multiple / position` while `evaluateEntry` defines
`expectedGain = position × takeProfitBps`. The gain the bar tests IS the requirement it tests
against, so **the cost bar cannot refuse a long signal at any tax tier, position size or
multiple** — 0 refusals in 72 combinations, pinned by test in `replay.test.ts`. `EDGE_MULTIPLE`
moves the exit target; it is not, and never was, a selectivity control.
