# STRAYS — operations

What is deployed, how to turn it on, how to turn it off, and what to do when something breaks.

---

## The addresses

| | |
|---|---|
| **StrayVault** | `0xD4233cae4804A2A9b7Db2e0a2362FD2Fc5279E33` — [verified](https://robinhoodchain.blockscout.com/address/0xD4233cae4804A2A9b7Db2e0a2362FD2Fc5279E33) |
| House (fees + rake) | `0x1E5A3c8b0120E28Ca3FC554e6a7B7957975ad492` |
| Keeper (trades only) | `0xf4b89Bd912Cdcd7C88b9293cd036C79F4E9F957c` |
| Deployer | `0x0d3E845D1E6ac5A4B9871d6bb3B343D8aAdad933` |
| Chain | Robinhood Chain **4663** |

All six constructor addresses are `immutable`. **There is no setter for any of them** — that is
asserted by `test_SABOTAGE_houseAndKeeperHaveNoSetter`, which probes the ABI rather than reading the
source. If a role needs to move, the contract is redeployed; it cannot be reconfigured.

## Railway

| | |
|---|---|
| Project | `strays` — `55c2aeb2-bd93-4959-8333-61aa2c7bcdda` |
| Environment | `production` — `a77756b7-486d-4e78-8973-e4b7f8a9f062` |
| `web` | `79f179bd-0b21-4379-b8d7-ee8f9bef75e3` → **LIVE** <https://web-production-19a12.up.railway.app> |
| `keeper` | `db601f9a-6283-4530-bfd2-8f8602ebe97d` → **LIVE (observe)** <https://keeper-production-de42.up.railway.app/health> |
| Postgres | deployed from template; `DATABASE_URL` referenced into `keeper` |
| Repo | <https://github.com/taia-source/strays> |

### The 502 that took five theories to fix

Worth keeping, because four of the five theories found a REAL bug and none of them was the cause.

The final cause: **Next's standalone server binds to the CONTAINER HOSTNAME by default.** The logs
read `Ready in 0ms` / `Local: http://b95ccc0ad6c1:3000` — healthy, listening, and on an interface
Railway's edge proxy cannot reach. **A server that is up and unreachable looks identical to a
crashed one from outside.** Fixed with `HOSTNAME=0.0.0.0`, set both in the start script and as a
service variable so it survives a config reset.

The four real bugs found along the way, each of which had to be fixed anyway:

1. `NIXPACKS_*` variables silently ignored — Railway uses Railpack.
2. `outputFileTracingRoot` unpinned, so `standalone/` nested differently on Railway than locally.
3. A trailing `|| true` that made every failed build exit 0 (see RESEARCH §7i-bis).
4. The standalone bundle shipping with an empty `static/`, so every page 404'd its own CSS.

**Railway uses RAILPACK, not Nixpacks.** `NIXPACKS_*` variables are silently ignored — the first
build failed on exactly that. Build config lives in `railway.web.json` / `railway.keeper.json`,
selected per service by `RAILWAY_CONFIG_PATH`.

---

## Turning trading ON

**The keeper ships in OBSERVE mode and does not spend.** It discovers, decides and records against
real market data with `STRAYS_LIVE_TRADING=false`, which is a genuinely useful state — `/logs` fills
with real decisions and nothing is at risk.

Three switches must **all** be on before a single wei moves:

```
STRAYS_LIVE_TRADING=true
STRAYS_KEEPER_PRIVATE_KEY=<the keeper key from /root/.env>
STRAYS_RPC_URL=https://rpc.mainnet.chain.robinhood.com
```

This is meridian's rule, and its reasoning is worth keeping: *"setting an RPC URL for read access
should never silently start spending real money."*

### Turning it on — the exact steps

Everything else is done. **Two values must be pasted into the Railway dashboard by hand** (both are
secrets, and two attempts to set the key through tooling were correctly blocked by a safety
classifier — that block was not worked around):

1. **`STRAYS_KEEPER_PRIVATE_KEY`** — copy from `/root/.env`. This is the keeper wallet. It can make
   bad trades; it cannot move money anywhere except back into the vault, because `hunt`/`flee` take
   no recipient and v4's `TAKE_ALL` has no recipient field.
2. **`STRAYS_RPC_URL`** — replace the public endpoint with `ROBINHOOD_RPC_URL` from `/root/.env`.
   **MEASURED: the public `rpc.mainnet.chain.robinhood.com` returns a Cloudflare 403 challenge
   under sustained load**, and a keeper on a 2-minute tick is sustained load. The alternate carries
   an API key in its path, which is why it is not committed.
3. Then set **`STRAYS_LIVE_TRADING=true`** and redeploy.

The keeper wallet holds ~0.00079 ETH of gas. Top it up from `HOUSE_ADDRESS` before a long run; it
pays gas only and never custodies user funds.

**Verified locally before writing this**: the same binary, with all three switches on and the
durable Postgres ledger, boots with `KEEPER: LIVE. All three switches are on — this process WILL
spend real ETH.` and completes a tick in ~9s, correctly declining every candidate with a stated
reason (e.g. *"move -381bps over 61min (21 samples) is DOWNWARD. Long only — this venue has no
borrow, so a fall is information the strategy cannot act on"*).

### Turning it OFF

Set `STRAYS_LIVE_TRADING=false` and redeploy. **This genuinely stops all on-chain activity**, which
is not true of every system: meridian's own docs record that its LP guard ran *even with* live
trading off, so "off" did not mean nothing moved. Here there is exactly one execution path and in
observe mode both executors throw.

**Users can always withdraw regardless.** `withdraw()` is owner-only and gated by nothing — not by
the keeper, not by a pause, not by any risk control, not by a stray being mid-position. Turning the
keeper off does not trap anybody's money.

---

## Spend controls

| Control | Value | Where |
|---|---|---|
| Max per position | **0.01 ETH** | `MAX_POSITION_WEI`, on chain, immutable |
| Min adoption | 0.001 ETH | `MIN_ADOPT_WEI`, on chain |
| Tick interval | 5 min | `STRAYS_TICK_MS` |
| Only huntable tax tier | **1%** | `@strays/hunt` `eligible.ts` |

**A spend cap cannot be enforced by watching the house balance.** `/root/.env` records that
`HOUSE_ADDRESS`'s *"balance moved BOTH directions and its nonce advanced 980 → 992 during a session
in which CUSTODIAN sent nothing"* — it is shared across projects. Reconcile against tx hashes from
the deployer and keeper addresses only.

---

## What to check when something looks wrong

**"The colony is empty."** Distinguish *no strays* from *cannot read*. `listStrays` throws on an
unreachable RPC rather than returning an empty list, precisely so the two never look identical. If
the page renders "No strays yet", that is a real read of a real empty vault.

**"A trade did not happen."** `/logs` separates **decided** from **landed**. A decision recorded
with a `failed` outcome means the strategy fired and the transaction did not — check the revert. A
`skipped` outcome means the cost bar refused it, which is the system working.

**"The keeper is quiet."** Check `/health` on the keeper service — it reports `mode: observe|live`
and the tick interval. A keeper in observe mode is *supposed* to be quiet on chain.

**NEVER RUN TWO KEEPERS ON ONE KEY — and check, do not assume.** During this build I restarted the
live keeper without stopping the previous one and had **two processes signing from the same wallet**
for several minutes. `.env` documents exactly this hazard for other projects on this machine
(*"two autonomous signers on one nonce is a race"*), and I walked into it anyway because launching
the new one felt like replacing the old one.

Nothing was lost — the `inFlight` guard is per-process and would not have helped, but the vault's
own per-stray accounting and the durable ledger's UNIQUE idempotency key are what actually stand
between this and a double-spend. **Confirm with `ps aux | grep dist/main.js` before and after every
restart.** On Railway a redeploy replaces the container, so this is a local-operator hazard, not a
production one.

**RPC rate limiting — MEASURED, 2026-08-07.** The public endpoint
`https://rpc.mainnet.chain.robinhood.com` is fronted by Cloudflare and **starts returning a 403
managed challenge** under sustained load. It surfaced mid-session as an HTML challenge page in
place of a JSON-RPC response, which `cast` reports as a wall of HTML rather than as a rate limit.

Two consequences worth knowing:

- **A keeper on a 5-minute tick with N strays makes ~6 calls per candidate.** That is fine at this
  scale and is exactly why the candidate pipeline is prefiltered and capped at 6 concurrent — but
  the ceiling is real and it is not documented anywhere by the chain.
- **`ROBINHOOD_RPC_URL` in `/root/.env` is a working alternate endpoint** and should be preferred
  for anything sustained. `@taia/rpc` exists for this: concurrency caps and a fallback transport
  rather than a single hardcoded URL.

**Discovery failures.** The pad's API is unofficial, has no OpenAPI spec, and its routes were
reverse-engineered from the site bundle. It can change without notice. The indexer logs
`discovery failed (recoverable|FATAL)` and returns nothing to hunt for that cycle — it never treats
a fetch failure as "the market is empty".

Three measured API behaviours that will bite anyone extending this:
- the **list** endpoint omits `tickSpacing` and `volumeEth`; both are detail-endpoint only, and
  `tickSpacing` is fatal because a guessed PoolKey addresses a pool that does not exist
- the API **403s on Python's default User-Agent** but serves `curl` fine
- rate limit is **240 requests / 60s**, from the `ratelimit` response header

---

## Running the checks

```bash
# contracts — unit tests against mocks
cd packages/contracts && forge test

# contracts — against LIVE letscash pools. The two real bugs in this project were
# found here and by an encoding diff, not by unit tests.
forge test --match-contract ForkSwap --fork-url https://rpc.mainnet.chain.robinhood.com

# the strategy
cd packages/hunt && npx vitest run

# the keeper
cd apps/indexer && npx vitest run

# screenshots at 320/390/768/1440 in BOTH themes, which is the only thing that
# catches a theme nobody has opened
node scripts/shoot.mjs <output-dir>
```

**Start anvil before the full gate** — `/root/.foundry/bin/anvil --silent &`. Without it ~40
`@taia/e2e` tests fail with confusing assertion errors rather than a clear "no node".

---

## Known-not-done

- **No external audit** of the vault. Stated on `/` and in `/docs`.
- **The pad's `hook` and `revenueSplitter` are unverified on Blockscout.** Every trade routes
  through them. Unmitigable; bounded by `MAX_POSITION_WEI`.
- **The spend ledger and price history are IN MEMORY.** `@strays/hunt` exports
  `assertDurableLedger`, which throws on an in-memory one so this cannot go live by accident.
  Postgres is provisioned and referenced into the keeper but not yet used. **This blocks live
  trading** and is the next piece of work.
- **`quoteExitWei` returns 0**, so exit decisions cannot yet be priced. Same pass as above.
- **No `TEST` token launched yet.**
- **`quoteExitWei` returns 0**, so exit decisions cannot price a position. The buy-side quoter works
  and is verified against a real fill to within 0.01%; the sell side is the same call with the
  direction flipped and is not wired.
- **No wallet has ever connected to the adoption flow.** It renders correctly and its selector is
  derived from the ABI (after a hardcoded one was found wrong), but the signing path is untested.
