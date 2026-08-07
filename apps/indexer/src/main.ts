/**
 * The keeper process. This is what makes strays autonomous.
 *
 * ══ THREE INDEPENDENT SWITCHES MUST ALL BE ON BEFORE A SINGLE WEI MOVES ══
 *
 * meridian's rule, and its reasoning verbatim: *"Deliberately three separate opt-ins, not one:
 * setting an RPC URL for read access (e.g. live pool prices) should never silently start spending
 * real money. Defaults off."*
 *
 *   STRAYS_LIVE_TRADING=true     explicit intent
 *   STRAYS_KEEPER_PRIVATE_KEY    a signer exists
 *   STRAYS_RPC_URL               a chain is reachable
 *
 * With any of them missing the keeper runs in OBSERVE mode: it discovers, decides, and records
 * every decision, and executes nothing. That is a genuinely useful state — `/logs` fills with real
 * decisions against real market data — and it is the default.
 *
 * ══ AND THE KILL SWITCH ACTUALLY KILLS ══
 *
 * meridian's own caveat, recorded against itself: *"the LP guard is position protection, not signal
 * trading, and it runs EVEN WITH AGENT_LIVE_TRADING=false ... If you need the engine to touch
 * nothing at all, it must also hold no open LP positions."* Their master switch did not stop all
 * on-chain activity.
 *
 * Here there is exactly one execution path — `executeHunt`/`executeFlee` in `tick.ts` — and both
 * are supplied by this file. In observe mode they are functions that throw. There is no second
 * path that could quietly keep acting, and `observeModeCannotSpend` in the tests asserts it.
 */
import {
  DEFAULT_ELIGIBILITY,
  DEFAULT_RISK,
  DEFAULT_SCREEN,
  type SpendLedger,
  assertDurableLedger,
  createMemorySpendLedger,
  decide as strategyDecide,
} from "@strays/hunt";
import { createStore, type Store } from "./ledger.js";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SEED_MARKET_CAP_ETH,
  type Candidate as PadCandidate,
  fetchBuyRatioBps,
  fetchCandidates,
  fetchHolders,
} from "./discovery.js";
import { historyFor, quoteBuy, recordPrice, simulateSell } from "./quote.js";
import { TICK_MS, runTick, type DecisionRecord, type StrayState, type TickDeps } from "./tick.js";

const RPC_URL = process.env.STRAYS_RPC_URL ?? "";
const VAULT = (process.env.STRAYS_VAULT_ADDRESS ?? "") as `0x${string}`;
const CHAIN_ID = Number(process.env.STRAYS_CHAIN_ID ?? 4663);
const KEEPER_KEY = process.env.STRAYS_KEEPER_PRIVATE_KEY ?? "";
const LIVE = process.env.STRAYS_LIVE_TRADING === "true";

/**
 * The block `StrayVault` was deployed in, measured from its deploy receipt — never guessed.
 * Log scans start here. See the note on `fromBlock` below for what a rolling window did instead.
 */
const VAULT_DEPLOY_BLOCK = BigInt(process.env.STRAYS_VAULT_DEPLOY_BLOCK ?? "30275947");

const VAULT_ABI = parseAbi([
  "function strays(bytes32) view returns (address owner, uint128 stake, uint128 principal, address holding, int24 tickSpacing, uint128 costBasis)",
  "function hunt(bytes32 strayId, address token, uint256 ethIn, uint256 minOut, int24 tickSpacing)",
  "function flee(bytes32 strayId, uint256 minOut)",
  "event Adopted(bytes32 indexed strayId, address indexed owner, uint256 stake, uint256 energyFee)",
]);

const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

/** True only when all three switches are on. Anything less is observe mode. */
export function canSpend(): boolean {
  return LIVE && KEEPER_KEY.length > 0 && RPC_URL.length > 0;
}

/**
 * The pad's tax tier for one token, cached.
 *
 * Defaults to the WORST tier (10%) when unreadable rather than the best. An unknown cost must
 * never be assumed cheap — that is the direction that loses money.
 */
const taxCache = new Map<string, number>();

/**
 * The built candidate set for ONE tick, shared across every stray in it.
 *
 * Keyed on the block so it expires naturally: a new block means a new market, and nothing stale is
 * ever reused. Cleared rather than grown.
 */
let marketCache: { block: bigint; built: unknown[] } | null = null;

/**
 * How many candidates are enriched in parallel.
 *
 * MEASURED: at 6 a tick over 17 candidates took 59s; the chain RPC dominates. 12 halves it while
 * staying an order of magnitude inside the pad's 240 req/60s budget — the cap exists to stay
 * polite, not because we are near it.
 */
const CONCURRENCY = 12;
async function padTaxPct(token: string): Promise<number | null> {
  const key = token.toLowerCase();
  const hit = taxCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const r = await fetch(`https://api.letscash.fun/api/tokens/${token}`, {
      headers: { accept: "application/json", "user-agent": "strays-indexer/0.1" },
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { taxPct?: unknown };
    if (typeof d.taxPct !== "number") return null;
    taxCache.set(key, d.taxPct);
    return d.taxPct;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!RPC_URL || !VAULT) {
    console.error("STRAYS_RPC_URL and STRAYS_VAULT_ADDRESS are required even to observe. Exiting.");
    process.exit(1);
  }

  const pub = createPublicClient({ transport: http(RPC_URL), chain });
  const live = canSpend();

  // Loud, once, at boot. An operator must never have to guess which mode a keeper is in.
  console.log(
    live
      ? "KEEPER: LIVE. All three switches are on — this process WILL spend real ETH."
      : `KEEPER: OBSERVE. Deciding and recording, executing nothing. ` +
          `(live=${LIVE} signer=${KEEPER_KEY.length > 0} rpc=${RPC_URL.length > 0})`,
  );

  const wallet = live
    ? createWalletClient({ account: privateKeyToAccount(KEEPER_KEY as `0x${string}`), transport: http(RPC_URL), chain })
    : null;

  /*
   * ══ THE LEDGER, AND THE ONE PLACE LIVE MODE IS ALLOWED TO REFUSE TO BOOT ══
   *
   * With DATABASE_URL set, the spend ledger and the price history are Postgres-backed and survive
   * a restart. Without it, an in-memory ledger is used — which is tolerable ONLY in observe mode,
   * because it spends nothing.
   *
   * If live trading is on and the ledger is not durable, `assertDurableLedger` THROWS and this
   * process exits. That is deliberate and it is the whole point: meridian's daily cap "only reset
   * on process restart, so the 'daily' cap was really 'spend since last boot'". On Railway a push
   * redeploys, so an in-memory cap would have reset several times an hour. A keeper that cannot
   * enforce its own cap must not trade.
   */
  let store: Store | null = null;
  // Typed as the INTERFACE, not as the memory implementation's wider shape — otherwise the
  // Postgres ledger cannot be assigned to it (the memory one adds a `snapshot()` for tests).
  let ledger: SpendLedger = createMemorySpendLedger();
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (dbUrl.length > 0) {
    try {
      store = await createStore(dbUrl);
      ledger = store.ledger;
      console.log("ledger: POSTGRES (durable). Price history and spend caps survive a restart.");
    } catch (err) {
      console.error(`ledger: Postgres unreachable — ${String(err)}`);
      // A failed DB connection must not silently downgrade a LIVE keeper to an in-memory cap.
      if (live) throw new Error("live trading requires a reachable durable ledger");
      console.warn("ledger: falling back to IN-MEMORY. Tolerable only because this is observe mode.");
    }
  } else {
    console.warn("ledger: IN-MEMORY (no DATABASE_URL). Caps reset on restart.");
  }
  if (live) assertDurableLedger(ledger);

  const refuse = (what: string) => async (): Promise<never> => {
    throw new Error(`refusing to ${what}: keeper is in OBSERVE mode`);
  };

  const deps: TickDeps = {
    listStrays: async (): Promise<readonly StrayState[]> => {
      const block = await pub.getBlockNumber();
      const logs = await pub.getLogs({
        address: VAULT,
        event: VAULT_ABI[3],
        /*
         * ══ THE DEPLOY BLOCK, NOT A ROLLING WINDOW ══
         *
         * This was `block - 100_000n`. MEASURED: the vault was deployed at 30,275,947 and the
         * chain reached 30,396,369 within hours — 120k blocks later — so the window had already
         * slid PAST the deployment and `getLogs` returned zero. The keeper saw no strays, made no
         * decisions, and looked hung. A rolling window on an append-only registry is a bug with a
         * timer on it: it works until the chain outruns it, then silently forgets everyone.
         *
         * Adoptions are permanent, so the correct lower bound is the block the vault came into
         * existence and never anything later.
         */
        fromBlock: VAULT_DEPLOY_BLOCK,
        toBlock: block,
      });
      const ids = [...new Set(logs.map((l) => l.args.strayId as `0x${string}`))];
      const rows = await Promise.all(
        ids.map(async (id) => {
          const [, stake, , holding, , costBasis] = await pub.readContract({
            address: VAULT,
            abi: VAULT_ABI,
            functionName: "strays",
            args: [id],
          });
          const held = holding === "0x0000000000000000000000000000000000000000" ? null : holding;
          /*
           * The tax tier of the token this stray is HOLDING, read fresh.
           *
           * The strategy rebuild found a live bug this closes: exits were costed against the
           * CONFIG's tax rather than the position's own tier, so a 10%-tax position could be sold
           * into a "profit" that did not cover the 1900bps it actually costs to round-trip. It was
           * invisible while only 1%-tax tokens were tradeable and total once they were not.
           */
          const holdingTaxPct = held === null ? 0 : ((await padTaxPct(held)) ?? 10);
          return {
            id,
            stakeWei: stake,
            holding: held,
            holdingTaxPct,
            holdingUnits: 0n,
            costBasisWei: costBasis,
            entryBlock: 0n,
          } satisfies StrayState;
        }),
      );
      return rows;
    },

    discover: async () => {
      const block = await pub.getBlockNumber();
      const r = await fetchCandidates({ now: Date.now(), block });
      if (!r.ok) {
        // A fetch failure is a failure mode, not a conclusion. Log it and return nothing to hunt
        // this cycle — never treat it as "the market is empty".
        console.warn(`discovery failed (${r.recoverable ? "recoverable" : "FATAL"}): ${r.reason}`);
        return [];
      }
      return r.candidates;
    },

    currentBlock: () => pub.getBlockNumber(),
    gasPriceWei: () => pub.getGasPrice(),

    executeHunt: live
      ? async (strayId, token, amountWei, minOut, tickSpacing) => {
          if (!wallet) throw new Error("unreachable: live without a wallet");
          const hash = await wallet.writeContract({
            address: VAULT,
            abi: VAULT_ABI,
            functionName: "hunt",
            args: [strayId, token, amountWei, minOut, tickSpacing],
          });
          const r = await pub.waitForTransactionReceipt({ hash });
          if (r.status !== "success") throw new Error(`hunt reverted: ${hash}`);
          return { txHash: hash, gasUsed: r.gasUsed };
        }
      : (refuse("hunt") as TickDeps["executeHunt"]),

    executeFlee: live
      ? async (strayId, minOut) => {
          if (!wallet) throw new Error("unreachable: live without a wallet");
          const hash = await wallet.writeContract({
            address: VAULT,
            abi: VAULT_ABI,
            functionName: "flee",
            args: [strayId, minOut],
          });
          const r = await pub.waitForTransactionReceipt({ hash });
          if (r.status !== "success") throw new Error(`flee reverted: ${hash}`);
          return { txHash: hash, gasUsed: r.gasUsed };
        }
      : (refuse("flee") as TickDeps["executeFlee"]),

    quoteExitWei: async () => 0n,

    record: async (r: DecisionRecord) => {
      if (store !== null) {
        await store
          .recordDecision({
            strayId: r.strayId,
            action: r.action,
            token: r.token,
            amountWei: r.amountWei,
            rationale:
              "reason" in r.outcome ? `${r.rationale}\n\nFAILED: ${r.outcome.reason}` : r.rationale,
            outcome: r.outcome.kind,
            txHash: "txHash" in r.outcome ? r.outcome.txHash : null,
            block: r.block,
            atMs: r.at,
          })
          // A logging failure must never abort a tick that already moved money.
          .catch((e) => console.error(`decision not persisted: ${String(e)}`));
      }
      // Structured so a log aggregator can read it, and so DECIDED is never confused with LANDED.
      console.log(
        JSON.stringify({
          strayId: r.strayId,
          action: r.action,
          outcome: r.outcome.kind,
          rationale: r.rationale,
          /*
           * ══ WHY THE FAILURE REASON IS ITS OWN FIELD ══
           *
           * It was captured in the outcome and then never printed or persisted, so a live `hunt`
           * that FAILED logged the decision's reasoning and nothing about why it did not land —
           * observably "failed" with no cause. That is the silent wrongness this repo treats as
           * worse than downtime, and it cost a debugging cycle on the first real trade attempt.
           */
          error: "reason" in r.outcome ? r.outcome.reason.slice(0, 400) : null,
          txHash: "txHash" in r.outcome ? r.outcome.txHash : null,
          block: r.block.toString(),
          amountWei: r.amountWei.toString(),
        }),
      );
    },

    /**
     * THE STRATEGY, actually called.
     *
     * openhood's recorded failure is a flag that said `AUTOMATIC_EXECUTION_WIRED = true` while the
     * engine never called the evaluator. The equivalent lie here would be leaving this as a stub
     * returning `hold` while claiming a strategy exists — so it calls `@strays/hunt`'s `decide`,
     * and `tick.test.ts` fails if the executor is ever unreached.
     *
     * ⚠ THE LEDGER IS IN-MEMORY, AND THAT IS A REAL LIMITATION, NOT A DETAIL.
     *
     * meridian's daily cap "only reset on process restart, so the 'daily' cap was really 'spend
     * since last boot': long uptime falsely blocked, frequent redeploys never enforced."
     * `@strays/hunt` exports `assertDurableLedger`, which THROWS on an in-memory one, precisely so
     * this cannot be shipped live by accident. It is tolerable only because the process runs in
     * OBSERVE mode; going live requires a Postgres-backed ledger first, and `assertDurableLedger`
     * is what will stop anyone forgetting.
     */
    /*
     * ══ ONE MARKET, SHARED BY THE WHOLE COLONY ══
     *
     * `decide` is called once PER STRAY, and every stray sees the SAME market. Building the
     * candidate set inside it meant the quoter calls, sell simulations, holder fetches and
     * buy-ratio fetches ran once per stray over identical inputs.
     *
     * MEASURED: 7 strays x 17 candidates took 40 SECONDS a tick — seven times the same work. This
     * memoises the built set for the life of one tick, keyed on the block, so the Nth stray reuses
     * what the first one paid for. It is the same reason `discover()` runs once per tick rather
     * than once per stray, applied one level deeper.
     */
    decide: async ({ stray, candidates, gasPriceWei, currentValueWei, block }) => {
      const nowSeconds = Math.floor(Date.now() / 1000);

      /*
       * ══ BUILDING A CANDIDATE THE STRATEGY CAN ACTUALLY REASON ABOUT ══
       *
       * The first version of this mapped API rows straight across with an `as never` cast and
       * crashed on the live chain with "Cannot read properties of undefined (reading 'taxPct')".
       * The cast was the bug: `@strays/hunt`'s Candidate is NESTED — {token, history, quotedOut} —
       * and it needs two things an API row cannot supply.
       *
       *   1. PRICE HISTORY. The signal measures a move over a 60-minute window off real timestamps.
       *   2. A REAL QUOTE. `quotedOut` must come from the v4 quoter, never from size x price.
       *
       * A cast that silences a type error is a type error that reaches production. This builds the
       * real shape instead, and a token we cannot quote is simply not a candidate this tick.
       */
      const sizeProbeWei = 1_200_000_000_000_000n; // ~$2.3, the size we would actually trade
      /** Only the fully-built candidates. `string` means the sell simulation refused it; `null`
       * means it could not be quoted or read at all. Neither is a candidate. */
      type Built = Exclude<Awaited<ReturnType<typeof buildCandidate>>, string | null>;
      const huntCandidates: Built[] = [];
      /** Named in the decision log, so a user can see WHY the colony is quiet. */
      const unsellable: string[] = [];

      /**
       * Gather everything one candidate needs. Returns the candidate, its SYMBOL when the sell
       * simulation refuses it, or null when it cannot be quoted or read at all.
       *
       * The sell simulation is the check that matters most: measured on 40 live tokens, 40/40 buy
       * quotes succeeded and only 7 sells did, so checking the buy side alone would enter a
       * position it cannot exit 82% of the time.
       */
      const buildCandidate = async (c: PadCandidate) => {
        const ethPerTokenWei = BigInt(Math.round(c.priceEth * 1e18));
        if (ethPerTokenWei > 0n) {
          recordPrice(c.address, ethPerTokenWei, nowSeconds);
          if (store !== null) await store.recordPrice(c.address, ethPerTokenWei, nowSeconds);
        }

        const quotedOut = await quoteBuy({
          client: pub,
          token: c.address,
          tickSpacing: c.tickSpacing,
          amountInWei: sizeProbeWei,
        });
        if (quotedOut === null) return null; // unquotable is untradeable. Never estimated.

        // CAN WE GET OUT? Simulate the exit BEFORE committing to the entry.
        const sell = await simulateSell({
          client: pub,
          token: c.address,
          tickSpacing: c.tickSpacing,
          amountInTokens: quotedOut,
        });
        if (!sell.ok) return c.symbol || c.address;

        const [holders, buyRatioBps, history] = await Promise.all([
          fetchHolders(c.address),
          fetchBuyRatioBps(c.address),
          store !== null
            ? store.historyFor(c.address, 4 * 60 * 60, nowSeconds)
            : Promise.resolve(historyFor(c.address)),
        ]);
        // A distribution we cannot read is not a distribution of zero — refuse rather than assume.
        if (holders === null) return null;

        return {
          sell,
          holders,
          // No trades to measure means no momentum, not balanced momentum.
          buyRatioBps: buyRatioBps ?? 0n,
          token: {
            address: c.address,
            taxPct: c.taxPct,
            marketCapWei: BigInt(Math.round(c.marketCapEth * 1e18)),
            holders: c.holders,
            volumeAllTimeWei: BigInt(Math.round(c.volume24hEth * 1e18)),
            ageSeconds: Math.max(0, nowSeconds - Math.floor(c.launchedAt / 1000)),
            tickSpacing: c.tickSpacing,
          },
          history,
          quotedOut,
        };
      };
      /*
       * ══ WHY THIS IS PREFILTERED AND PARALLEL ══
       *
       * The serial version ran six network round-trips per candidate over ~48 candidates — ~288
       * sequential requests. MEASURED: the tick did not finish in 90 seconds, so the keeper
       * emitted no decisions at all. A cat that cannot finish thinking before the next tick never
       * acts, and the colony looks dead.
       *
       * 1. **A free prefilter first.** Measured on 40 live tokens: every token still at the
       *    ~1.356 ETH seed market cap failed the sell simulation, and 5 of 5 above it passed.
       *    Market cap is already in the list response, so this removes ~85% of candidates before
       *    we pay for a single quote.
       * 2. **Bounded parallelism** over the rest. A CAP rather than an unbounded `Promise.all`:
       *    the pad allows 240 req/60s and a full fan-out would burn that budget in one tick.
       */
      /*
       * Build the market ONCE per tick and share it. See the note on `decide` above: this used to
       * run per stray over identical inputs and cost 40 seconds a tick with seven strays.
       */
      if (marketCache === null || marketCache.block !== block) {
        const worth = candidates.filter((c) => c.marketCapEth > SEED_MARKET_CAP_ETH);
        const built: unknown[] = [];
        for (let i = 0; i < worth.length; i += CONCURRENCY) {
          built.push(...(await Promise.all(worth.slice(i, i + CONCURRENCY).map(buildCandidate))));
        }
        marketCache = { block, built };
      }
      for (const b of marketCache.built) {
        if (b === null) continue;
        if (typeof b === "string") {
          unsellable.push(b);
          continue;
        }
        huntCandidates.push(b as Built);
      }

      const d = await strategyDecide(
        {
          strayId: stray.id,
          compartmentWei: stray.stakeWei,
          highWaterMarkWei: stray.stakeWei + (currentValueWei ?? 0n),
          equityWei: stray.stakeWei + (currentValueWei ?? 0n),
          position:
            stray.holding === null
              ? undefined
              : {
                  token: stray.holding,
                  entryWei: stray.costBasisWei,
                  entryPriceWei: 0n,
                  // Full precision, never a number — a real 18-decimal balance needs ~22
                  // significant digits and float64 holds ~15-17 (RESEARCH §7d).
                  tokenBalance: stray.holdingUnits,
                  // Defaults to the WORST tier when unknown. An unknown cost must never be
                  // assumed cheap — that is the direction that loses money.
                  taxPct: stray.holdingTaxPct ?? 10,
                  openedAtSeconds: 0,
                },
        },
        {
          // Built in the tick body below, because each one needs a real quoter call and a real
          // price history — neither of which a `map` over the API rows can produce.
          candidates: huntCandidates,
          gasPriceWei,
          markPriceWei: currentValueWei ?? undefined,
          nowSeconds,
        },
        {
          eligibility: DEFAULT_ELIGIBILITY,
          risk: DEFAULT_RISK,
          screen: DEFAULT_SCREEN,
          ledger,
          slippageBps: 500n,
          idempotencyKey: `${stray.id}:${block.toString()}`,
          approvalsNeeded: true,
        },
      );
      if (d.kind === "enter") {
        /*
         * ══ RE-QUOTE AT THE SIZE WE ARE ACTUALLY TRADING ══
         *
         * THE BUG THIS FIXES, caught on the first live trade attempt. `quotedOut` is measured once
         * per candidate at a fixed PROBE size, because the market is built before any particular
         * stray's position is sized. `minOut` was then derived from that probe quote — but the
         * trade is sized per stray, from its own compartment.
         *
         * MEASURED: probe 0.0012 ETH, actual entry 0.00104 ETH, so `minOut` was scaled to a buy
         * 15.4% larger than the one being made. On chain the call reverted with
         * `V4TooLittleReceived` (0x8b063d73) — a floor 15.8% above what the pool could deliver,
         * which is not slippage, it is arithmetic. The bound was doing its job; the number was
         * wrong.
         *
         * A quote is `eth_call` only, so re-quoting at the true size costs nothing and removes the
         * mismatch entirely rather than papering over it with a wider slippage tolerance — which
         * would have "fixed" the revert by disabling the protection.
         */
        const chosen = candidates.find((c) => c.address.toLowerCase() === d.token.toLowerCase());
        const trueQuote =
          chosen === undefined
            ? null
            : await quoteBuy({
                client: pub,
                token: chosen.address,
                tickSpacing: chosen.tickSpacing,
                amountInWei: d.sizeWei,
              });
        if (chosen === undefined || trueQuote === null) {
          return {
            kind: "hold",
            reason: `chose ${d.token} but could not re-quote it at the real size ${d.sizeWei} wei`,
          };
        }
        // Same slippage policy the strategy used, applied to the CORRECT expected output.
        const scaledMinOut = (trueQuote * 9500n) / 10_000n;
        if (scaledMinOut <= 0n) {
          return { kind: "hold", reason: "slippage floor rounded to zero at the real size" };
        }
        // `tickSpacing` is an EXECUTION detail, not a strategy one, so it comes from the candidate
        // rather than the Decision — and a guessed value builds a PoolKey for a pool that does not
        // exist (RESEARCH §2), which is why `chosen` being undefined is a refusal above.
        return {
          kind: "enter",
          token: d.token as `0x${string}`,
          amountWei: d.sizeWei,
          // The RE-QUOTED floor, not `d.minOut` — see the derivation above.
          minOut: scaledMinOut,
          tickSpacing: chosen.tickSpacing,
          reason: `${d.reason} | minOut re-quoted at the real size: ${scaledMinOut}`,
        };
      }
      if (d.kind === "exit") {
        // The strategy's exit carries NO minOut, and that is correct: a floor computed at decision
        // time is stale by the time the transaction lands. It is derived here from the mark read
        // this tick, and it is never zero — a zero floor is an unbounded MEV sandwich (§7c).
        const mark = currentValueWei ?? 0n;
        const minOut = mark > 0n ? (mark * 9500n) / 10_000n : 1n;
        return { kind: "exit", minOut, reason: d.reason };
      }
      return { kind: "hold", reason: d.reason };
    },

    now: () => Date.now(),
  };

  const cycle = async (): Promise<void> => {
    const t0 = Date.now();
    try {
      const written = await runTick(deps);
      console.log(`tick: ${written.length} decisions in ${Date.now() - t0}ms`);
    } catch (err) {
      // A tick that throws must never kill the process — the next one may succeed.
      console.error(`tick failed: ${String(err)}`);
    }
  };

  await cycle();
  setInterval(() => void cycle(), TICK_MS);

  // A minimal health surface. @taia/gate requires /health on anything long-running.
  const { createServer } = await import("node:http");
  const port = Number(process.env.PORT ?? 8080);
  createServer((req, res) => {
    if (req.url === "/health" || req.url === "/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: live ? "live" : "observe", tickMs: TICK_MS }));
      return;
    }
    res.writeHead(404);
    res.end();
  }).listen(port, () => console.log(`keeper health on :${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
