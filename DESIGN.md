# STRAYS — DESIGN

`ART-DIRECTION.md` governs **execution**. This file governs the **proposition**: what this is, who
it is for, what it costs, and what it refuses to pretend.

---

## 1. The one-sentence idea

> **Feed a stray. It hunts letscash. It brings back what it kills.**

Every choice below answers to that sentence. If a choice cannot be traced to it, it is decoration
and should be cut.

**Who it is for:** men 18–30, crypto-native, X / Padre / Axiom users. They arrive from a screenshot.
They are held by **attachment to a character** and **unfinished stories** — never by pressure,
streaks or urgency.

---

## 2. What it actually is

You fund a cat with **$5 of ETH**. It prowls new letscash launches, picks its targets, trades, and
drops the proceeds at your door. It keeps a cut. Cats that stop eating starve out and disappear from
the colony.

The starvation mechanic is the risk drama and the leaderboard in one, **and it is honest about
losses instead of hiding them.** A cat that is losing money is drawn starving. This is the single
most important product decision in the file: the cute rendering is not there to soften the outcome,
and a losing cat must never look fine.

---

## 3. The custody model — stated plainly, because it holds money

**A stray's ETH lives in a per-stray compartment inside `StrayVault.sol`. Only the owner can
withdraw it. The house keeper can make it trade, and can do nothing else.**

The property that makes this true is structural rather than a check that could be forgotten. From
`RESEARCH.md` §4d: the Uniswap v4 `TAKE_ALL` action **has no recipient field** — proceeds settle to
the router's caller. If the caller *is* the vault, proceeds return to the vault by the shape of the
calldata, and there is no parameter for anyone to abuse.

This is strictly stronger than both predecessors, and both of their gaps are on record:

- **meridian** scoped a session key to `router.execute` and its own `CUSTODY.md` says that
  *"does not stop it from swapping the vault's funds out to an attacker"*, because the recipient is
  buried in triply-nested dynamic data that Zodiac Roles cannot match. It shipped that hole
  knowingly.
- **openhood** put the swap in an **EOA executor**, and `OpenhoodCustody.sol`'s own header admits
  *"the executor is a wallet, not a contract, so it CAN in principle keep what it borrows … This is
  the one property this design does not achieve structurally."*

**We do the thing openhood said it could not: the swap happens inside the contract.** openhood could
not, because its router integration was unaudited. We can, because the encoder is byte-verified
against a landed mainnet swap and every path is tested against a fork of the live chain.

**What this design does NOT protect against, stated rather than glossed:**
- A bug in our own contract. It is tested adversarially (§PLAN sabotage suite) but **not externally
  audited**, and Ibrahim has accepted that in writing. Users have not, so the landing page says it.
- The pad's `hook` and `revenueSplitter` are **unverified on Blockscout** (RESEARCH §1b) and every
  swap routes through them. This is unmitigable by us and is bounded only by position size.
- A losing strategy. Nothing here protects a user from the cat simply being wrong.

---

## 4. The money — who pays whom

Answered directly by Ibrahim: **upfront energy + rake on profit only.**

| | |
|---|---|
| **Adoption** | user pays a fixed **energy fee** in ETH, on top of the $5 the cat trades with |
| **Energy covers** | that cat's LLM decisions, RPC, and gas headroom for its life |
| **House rake** | **10% of PROFIT only**, taken at withdrawal, never on principal |
| **On a loss** | house takes **nothing**. The user's loss is their own; the house is not made whole |

**The house is cash-positive at adoption**, which is what makes "the house never funds an agent"
true by construction rather than by hope. The alternative — rake on every winning trade with no
upfront fee — was rejected because a cat that trades often and loses overall still burns house LLM
and RPC money with no offset, so the house *can* go net-negative. That violates the stated
constraint on some paths, so it is not built.

**Rake never touches principal.** A user who deposits $5 and withdraws $4 pays zero rake.

---

## 5. What the cat actually decides — and why it is mostly not an LLM

**Deterministic rules own the money. The LLM only picks which token to look at.**

This is meridian's measured answer to keeping LLM cost low, and it is the correct one:
`opportunities.ts:1-7` — *"the grounded 'find the best opportunities' layer, built on top of constant
deterministic monitoring rather than an always-on LLM."* Meridian calls **no model at all** in its
trading path.

The split here:

| Decision | Owner | Why |
|---|---|---|
| Which tokens are eligible | **deterministic** | `taxPct == 1` is a hard filter (RESEARCH §3c) |
| Which eligible token to hunt | **LLM, cheaply** | narrative judgement on name/socials/holders |
| Entry price, size, stop, exit | **deterministic** | non-deterministic money movement is untestable |
| Whether to trade at all | **deterministic** | the cost bar is arithmetic |

**The LLM cannot size a position, cannot choose a recipient, and cannot override a stop.** openhood's
parser treated a bare number in any model output as a hard reject — *"no verb takes an amount."* We
inherit the principle with the necessary amendment: **amounts come from the subsystem, never from
the model.**

**Cost control** (meridian's cadence-splitting, which is the strongest idea in that repo):
- Cheap model (Haiku-class), hard `max_tokens`, prompt budget capped by construction.
- **Cadence split:** an expensive broad "what is new and interesting" pass runs rarely; a cheap
  targeted "is this still worth holding" pass runs often. Running discovery-grade work on every
  wake multiplies cost for no benefit.
- **Batched across the colony, not per-cat.** One call ranks candidates for every cat that needs a
  target, rather than N calls. This is the difference between the LLM being a rounding error and
  being the product's main cost.

---

## 6. The trading rules — each one derived, not tuned

From `RESEARCH.md` §3, measured on live pools:

**RULE 1 — hunt `taxPct == 1` only.** Round trip is 231 bps there and 1938 bps at 10%. A 10%-tax
token needs a 19.4% move to break even. This is arithmetic, not preference.

**RULE 2 — the bar is a measured cost, not a constant.** `roundTripCost` takes `gasPriceWei` as a
required parameter read from the chain. openhood hardcoded a fork-measured cost and concluded a
round trip cost 52.5% of a position, which would have shipped a strategy that could only decline.

**RULE 3 — never encode `amountOutMinimum = 0`.** That is a free MEV sandwich. The encoder refuses
a zero floor in both slippage slots.

**RULE 4 — stop losses exist.** meridian has **none** — no trailing stop, no drawdown halt. For
tokenized AAPL that is survivable; for memecoins it is not. A stray has a hard stop and a
per-cat drawdown halt that starves it rather than letting it round-trip to zero.

**RULE 5 — getting OUT is always allowed.** meridian's circuit breaker deliberately does not guard
withdrawals: *"getting OUT is always allowed."* No risk limit may ever trap a user's capital in a
position.

**RULE 6 — do not build a 20-second rotation loop.** meridian built one, lost 2.8% on a
NVDA→AAPL→NVDA round trip in two hours, and **retired the strategy entirely**: *"15-minute signals
decay faster than the fees they incur."* Our cost bar is ~232 bps against a ~770 bps daily move; the
honest cycle is minutes-to-hours, not seconds, and the cadence is derived from the cost bar rather
than from what sounds exciting.

---

## 7. The user's path — written down before any function

This is required by `BUILD-A-PROJECT.md` step 3, and the reason is a real shipped defect: a project
built to act on a user's token shipped with **no text input anywhere**, passing 747 tests and 24
browser checks. Nobody omitted the input deliberately — the path was never written down, so nothing
could notice it was gone.

1. **Arrives** at `/` from a screenshot on X. Sees a colony of cats hunting, live.
2. **Understands** in one sentence what this is, what it costs, and what can go wrong.
3. **Connects** a wallet. *(click 1)*
4. **Funds and spawns** — one transaction: energy fee + the cat's $5. *(click 2)*
5. **Sees their cat arrive** in the colony, named and drawn from its own id.
6. **Leaves.** Nothing more is required, ever.
7. **Comes back** to a cat that is fatter or thinner, with a log of every trade it made and a link
   to each on the explorer.
8. **Withdraws** whenever they want — principal plus profit minus 10% of profit only.

**Steps 3 and 4 are the only interactions.** Everything after is a read. Step 8 must be reachable
at all times and must never be gated by any risk control (§6 Rule 5).

---

## 8. Routes

| Route | What it is |
|---|---|
| `/` | **Landing.** Name, one sentence, what it costs, what can go wrong, the way in. Not the app. |
| `/colony` | The map. Every live stray, fat or starving. The social loop. |
| `/stray/[id]` | One cat: its portrait, its holdings, its full trade history, each tx linked. |
| `/leaderboard` | Which cats are eating. Ranked by realised profit, honest about losses. |
| `/logs` | Every agent decision and every on-chain execution, with block stamps. The validation surface. |
| `/docs` | How it works, the fee split, the custody model, and what is not audited. |

**`/` is a landing page, not the app.** A deployed service once served its control panel at `/` with
388 characters of visible text, every one a label or a number, and a visitor could not tell what the
product was.

**`/logs` is load-bearing, not a nicety.** It is where "the cat actually did this" is provable, and
it must distinguish **decided** from **landed** — meridian records that a live monitor must tell
*"the agent decided to trade"* apart from *"the trade actually landed on-chain"*, because risk caps
and reverts can block the former from becoming the latter, *"and previously that distinction was
silent."*

---

## 9. What this refuses to say

- **Not "investing", "yield", "returns", "APY", or "earn".** This is a speculative agent trading
  memecoins with a real chance of total loss.
- **No projected returns. No backtested equity curve presented as expectation.** openhood's own
  backtest asserted `credible === false` on one winning trade over 15 days: *"One trade over 15 days
  is not evidence. It won, and that is worth nothing."*
- **No hidden losses.** The leaderboard shows the starving cats too.
- **No claim of an audit that has not happened.** The docs page says the contract is unaudited.

---

## 10. The token

**$STRAY is not launched in this build.** Ibrahim's instruction was explicit: deploy only a **`test`
/ `TEST`** contract to prove the launch-and-trade path end-to-end on mainnet 4663, sweep back to
`HOUSE_ADDRESS`, and never surface it in the product. Nothing in the shipped UI references a
project token, and per the brief **no contract name or ticker routes back to the project.**

Slots are paid in ETH. A token with no product is the recorded failure mode, and the product is the
thing being built.
