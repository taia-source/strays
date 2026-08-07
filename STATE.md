# STRAYS — honest state

What works, what is half-built, and what is not built at all. Written so nobody has to find out by
being surprised.

`BUILD-A-PROJECT.md`: *"If something is unwired, say it is unwired rather than writing a placeholder
that logs successful cycles that never happened — that has happened, and the honest comment was the
only reason it was fixable."*

---

## Proven on mainnet, with real money

**`StrayVault` is deployed, source-verified, and the whole user path executed against it.**
[`0xD4233cae…9E33`](https://robinhoodchain.blockscout.com/address/0xD4233cae4804A2A9b7Db2e0a2362FD2Fc5279E33).
Four transactions: adopt → hunt → flee → withdraw. See `DEPLOYMENTS.md` for hashes.

**The round-trip cost is measured three independent ways and all three agree to the tenth of a
basis point:** an off-chain viem probe on a fork (199.0), the contract on a fork (199), and the
contract on mainnet with real ETH (199.0). That agreement is the strongest evidence in the project.

**The rake-on-profit-only rule is an on-chain fact, not a claim.** The live-fire round trip lost
money to the pad's tax, and the house balance was byte-identical either side of the withdrawal —
`33641612886269577` before, `33641612886269577` after, a delta of exactly 0 wei.

**The keeper runs and makes real decisions.** Against live mainnet it found the on-chain stray,
quoted 9 live candidates through the v4 quoter, and refused all 9 with a specific reason:
*"3 holders < floor 25. Below this a price is one address's mark rather than a market's, so any move
the signal reads is that address moving it."*

## Tests

| | count | notes |
|---|---|---|
| contracts | **33** | incl. 4 against LIVE letscash pools on a mainnet fork |
| `@strays/hunt` | **184** | 100% statements/branches/functions/lines |
| `@strays/cat` | **35** | incl. a flood-fill test; 0 disconnected cats in 2000 |
| keeper | **22** | |
| **total** | **274** | **0 failed, 0 skipped** |

**Sabotage results: 49 of 49 caught** — 12 on the contract, 37 on the strategy. Both suites had
escapes on the first pass, both were fixed by observing the *mechanism* rather than the outcome, and
both are written up (`packages/contracts/SABOTAGE.md`, `packages/hunt/SABOTAGE.md`).

---

## NOT DONE — read this half

**No external audit of the vault.** Ibrahim authorised mainnet deployment once tests were green and
that is what happened. The 12 sabotages and the fork tests are what stand in for an audit and they
are not one. Stated on `/` and in `/docs` so users are told, not just the operator.

**The keeper is in OBSERVE mode and spends nothing.** `STRAYS_LIVE_TRADING=false`. It discovers,
decides and records against real market data; both executors throw rather than returning a fake
success. Turning it on needs three switches — see `OPERATIONS.md`.

**`STRAYS_KEEPER_PRIVATE_KEY` is not set on Railway.** It must be pasted in by hand from
`/root/.env`. Two attempts to set it through tooling were blocked by a safety classifier, which is
the correct outcome for a private key in a tool payload; it was not worked around.

**The spend ledger is in memory.** `@strays/hunt` exports `assertDurableLedger`, which *throws* on an
in-memory ledger, specifically so this cannot go live by accident. meridian's identical shortcut
meant its "daily" cap was really "spend since last boot". **Postgres is provisioned and wired to the
keeper but not yet used** — that is the next piece of work and it blocks live trading.

**Price history is in memory too.** After a redeploy every stray holds until the 60-minute window
refills. It fails *safe* (a cold history means hold, never a spurious trade), which is why it is
tolerable in observe mode and not in live.

**The adoption flow is linked and renders, but no wallet has ever connected to it.**
`apps/web/app/adopt.tsx` implements the two-click path with EIP-6963 discovery and
disabled-not-hidden dead wallets, and it is now mounted on `/colony` — verified in a real browser,
where it correctly renders "Step 1 of 2 — connect a wallet / No wallet detected" because a headless
browser has no wallet extension. **The signing path is therefore UNTESTED end to end.** It was
unreachable until this pass, which is the exact shape of the recorded failure where a service built
to act on a user's token shipped with no input anywhere.

**Four of the six claimed design axes did not ship.** `map`, `dense-instrument`, `idle-world` and
`pointer-agnostic` were derived at length in `ART-DIRECTION.md` and never rendered. The colony is a
CSS grid of portraits, not the canvas map with IR falloff. `ARCHIVE.md` row 12 records the measured
values and footnote 14 explains the gap.

**No `TEST` token launched.** Asked for, not done.

**`quoteExitWei` returns 0**, so exit decisions cannot price a position yet. The buy-side quoter
works and is verified against a real fill to within 0.01%; the sell side is the same call with the
direction flipped and is not wired.

---

## FIVE bugs found that tests alone did not catch

Recorded because the *method* that caught each one is the transferable part.

**1. The swap encoder was 64 bytes short.** `ExactInputSingleParams` contains a `bytes` member,
making the struct dynamic and requiring a head-offset word that positional encoding omits. Every
word from index 6 was shifted. **Caught by diffing against a transaction that had actually landed** —
no type checker and no unit test of the arithmetic would have found it, and it would have spent real
ETH on malformed calldata.

**2. `receive()` rejected the PoolManager.** v4's `take()` is executed by the PoolManager singleton,
not the router, so on a sell the ETH arrives from `0x8366a39C…`. The entire sell executed correctly
and reverted on the final line. **All 25 unit tests passed while this was live**, because a mock
router sends its own ETH. **A mock is a statement about what you already believe.**

**3. A hardcoded function selector was wrong.** `adopt(bytes32)` is `0x766c6eaf`; the adoption flow
had `0xd8f9ba6d`. Every adoption would have hit a non-existent function and reverted. **A wrong
four-byte constant is indistinguishable from a right one until it reaches the chain.** Caught by
`cast sig`, and now derived from the ABI so it cannot drift.

**4. A trailing `|| true` made every failed build report SUCCESS.** Shell precedence applied it to
the whole `&&` chain, so a failing `next build` exited 0, Railway reported SUCCESS, and every route
served 502. **The first fix (`set -e` on the parent) did not work and only a sabotage revealed
that** — appending an unresolvable import proved exit 0 before and exit 1 after. Same shape as
meridian's recorded finding that piping git into `tail` hides its exit code.

**5. The standalone bundle shipped with no stylesheet, and every route returned 200.** The copy of
`.next/static` was chained inside the same script that produces the directory it copies, so the
standalone bundle's static dir was empty and every page 404'd its own CSS. The deployed site loaded
perfectly and rendered as unstyled default-serif HTML. **Caught by opening the page and looking at
it** — no status code, type checker or test could see it. The fix asserts a `.css` exists in the
bundle and is proven by sabotage: emptying the source makes the build exit 1.

**And one process failure worth the same weight:** the first screenshot pass shot only the light
theme, because the headless browser reports `prefers-color-scheme: light`. The phosphor palette this
project *claims* had never been looked at. That is unitick's exact recorded failure — a theme nobody
opened — and it was caught only by noticing the screenshots were the wrong colour.
