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
  type SpendLedger,
  assertDurableLedger,
  createMemorySpendLedger,
  decide as strategyDecide,
} from "@strays/hunt";
import { createStore, type Store } from "./ledger.js";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fetchCandidates } from "./discovery.js";
import { historyFor, quoteBuy, recordPrice } from "./quote.js";
import { TICK_MS, runTick, type DecisionRecord, type StrayState, type TickDeps } from "./tick.js";

const RPC_URL = process.env.STRAYS_RPC_URL ?? "";
const VAULT = (process.env.STRAYS_VAULT_ADDRESS ?? "") as `0x${string}`;
const CHAIN_ID = Number(process.env.STRAYS_CHAIN_ID ?? 4663);
const KEEPER_KEY = process.env.STRAYS_KEEPER_PRIVATE_KEY ?? "";
const LIVE = process.env.STRAYS_LIVE_TRADING === "true";

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
        fromBlock: block > 100_000n ? block - 100_000n : 0n,
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
          return {
            id,
            stakeWei: stake,
            holding: holding === "0x0000000000000000000000000000000000000000" ? null : holding,
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
            rationale: r.rationale,
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
      const huntCandidates = [];
      for (const c of candidates) {
        // priceEth is a float from the API and is used ONLY to record history, never to size a
        // trade — the trade size comes from the quoter below, in bigint.
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
        if (quotedOut === null) continue; // unquotable is untradeable. Never estimated.

        huntCandidates.push({
          token: {
            address: c.address,
            taxPct: c.taxPct,
            marketCapWei: BigInt(Math.round(c.marketCapEth * 1e18)),
            holders: c.holders,
            volumeAllTimeWei: BigInt(Math.round(c.volume24hEth * 1e18)),
            ageSeconds: Math.max(0, nowSeconds - Math.floor(c.launchedAt / 1000)),
            tickSpacing: c.tickSpacing,
          },
          // Durable history when Postgres is up, in-memory otherwise. A restart no longer blanks
          // every stray's window.
          history:
            store !== null
              ? await store.historyFor(c.address, 4 * 60 * 60, nowSeconds)
              : historyFor(c.address),
          quotedOut,
        });
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
          ledger,
          slippageBps: 500n,
          idempotencyKey: `${stray.id}:${block.toString()}`,
          approvalsNeeded: true,
        },
      );
      if (d.kind === "enter") {
        // `tickSpacing` is NOT part of a Decision, and deliberately so: the strategy reasons about
        // prices and sizes, and the pool's geometry is an execution detail. It is looked up from
        // the candidate we are entering — and it is FATAL if absent, because a guessed tickSpacing
        // builds a PoolKey for a pool that does not exist (RESEARCH §2).
        const chosen = candidates.find((c) => c.address.toLowerCase() === d.token.toLowerCase());
        if (chosen === undefined) {
          return {
            kind: "hold",
            reason: `strategy chose ${d.token} but it is no longer among this tick's candidates`,
          };
        }
        return {
          kind: "enter",
          token: d.token as `0x${string}`,
          amountWei: d.sizeWei,
          minOut: d.minOut,
          tickSpacing: chosen.tickSpacing,
          reason: d.reason,
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
    try {
      const written = await runTick(deps);
      if (written.length > 0) console.log(`tick: ${written.length} decisions`);
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
