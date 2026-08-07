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
  assertKnownHook,
  createMemorySpendLedger,
  decide as strategyDecide,
} from "@strays/hunt";
import { createStore, type Store } from "./ledger.js";
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SEED_MARKET_CAP_ETH,
  type Candidate as PadCandidate,
  fetchBuyRatioBps,
  fetchCandidates,
  fetchHolders,
} from "./discovery.js";
import { historyFor, quoteBuy, recordPrice, simulateSell } from "./quote.js";
import {
  TICK_MS,
  runTick,
  type DecisionRecord,
  type PositionState,
  type StrayState,
  type TickDeps,
} from "./tick.js";

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

/**
 * ══ THE V2 ABI. EVERY SIGNATURE ON IT CHANGED, AND THE SHAPE CHANGE IS THE POINT ══
 *
 * `strays()` no longer returns a position. A stray is now (owner, stake, principal) and its
 * positions live in a separate 8-element array read via `positionsOf` — RESULTS §10.5 measured that
 * one slot takes 17 of 72 held-out opportunities at a Welch t of 1.16 (not significant) while eight
 * take 71 of 72 at t 2.38–2.72, with the SAME per-ticket median. The constraint was never about
 * diversification; it was destroying the sample size the claim needed.
 *
 * `hunt` gained a HOOK argument and RETURNS the slot it used. `flee` and `mark` NAME a slot.
 * RESEARCH §7d: there are two hooks on this pad and the v1 immutable could reach only one of them,
 * which excluded 44 of 111 tokens including three of the four highest-volume names.
 *
 * The `Position` tuple is spelled out inline because `parseAbi` needs the struct shape to decode
 * `positionsOf`'s fixed array. Field ORDER is load-bearing — it is decoded positionally — and it
 * matches `StrayVault.Position` exactly: token, tickSpacing, hook, costBasis, peakPriceWei,
 * openedAt.
 */
const VAULT_ABI = parseAbi([
  "struct Position { address token; int24 tickSpacing; address hook; uint128 costBasis; uint128 peakPriceWei; uint64 openedAt; }",
  "function strays(bytes32) view returns (address owner, uint128 stake, uint128 principal)",
  "function hunt(bytes32 strayId, address token, address hook, uint256 ethIn, uint256 minOut, int24 tickSpacing) returns (uint256 slot)",
  "function flee(bytes32 strayId, uint256 slot, uint256 minOut)",
  "function mark(bytes32 strayId, uint256 slot, uint256 priceWei) returns (uint256)",
  "function positionsOf(bytes32) view returns (Position[8])",
  "function positionAt(bytes32, uint256 slot) view returns (Position)",
  "function holdingOf(bytes32 strayId, uint256 slot) view returns (address token, uint256 balance)",
  "function openPositionCount(bytes32) view returns (uint256)",
  "function isKnownHook(address) view returns (bool)",
  "function stakeOf(bytes32) view returns (uint256)",
  "function quoteWithdraw(bytes32) view returns (uint256 payout, uint256 rake)",
  "event Entered(bytes32 indexed strayId, address indexed token, uint256 slot, uint256 ethIn, uint256 tokensOut, int24 tickSpacing, address hook, uint256 entryPriceWei)",
  "event Exited(bytes32 indexed strayId, address indexed token, uint256 slot, uint256 tokensIn, uint256 ethOut, uint256 peakPriceWei)",
  "event PeakRaised(bytes32 indexed strayId, uint256 indexed slot, uint256 oldPeak, uint256 newPeak)",
  "event Adopted(bytes32 indexed strayId, address indexed owner, uint256 stake, uint256 energyFee)",
]);

/** Must equal `StrayVault.MAX_POSITIONS` and `@strays/hunt`'s `MAX_POSITIONS`. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The `Adopted` event, resolved BY NAME.
 *
 * It was `VAULT_ABI[3]`. Adding `holdingOf` to the ABI shifted that index and silently pointed the
 * log filter at a function instead of an event — a positional reference into an ABI is a bug with
 * a delay on it.
 */
const ADOPTED_EVENT = VAULT_ABI.find(
  (e) => e.type === "event" && e.name === "Adopted",
) as Extract<(typeof VAULT_ABI)[number], { type: "event" }>;

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
        event: ADOPTED_EVENT,
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
          /*
           * ══ ONE CALL FOR THE STRAY, ONE FOR ALL EIGHT SLOTS ══
           *
           * `positionsOf` returns the whole fixed array in a single `eth_call` rather than eight
           * `positionAt` reads. That is not only cheaper: the eight slots come from ONE block, so
           * they are mutually consistent. Eight separate reads could straddle a block in which a
           * `flee` landed, producing a view in which one position appears twice or vanishes — and
           * the watermark reconciliation downstream keys on (slot, token), so an inconsistent view
           * is one that files a peak against the wrong occupant.
           */
          const [[, stake], slots] = await Promise.all([
            pub.readContract({
              address: VAULT,
              abi: VAULT_ABI,
              functionName: "strays",
              args: [id],
            }),
            pub.readContract({
              address: VAULT,
              abi: VAULT_ABI,
              functionName: "positionsOf",
              args: [id],
            }),
          ]);

          /*
           * A slot is EMPTY exactly when `token == address(0)`, which is the contract's own and
           * only emptiness test. Using the same one here means the keeper and the chain cannot
           * disagree about which slots are occupied — a second definition of "empty" is a second
           * thing that can be wrong, and being wrong here means naming the wrong slot in `flee`.
           */
          const open = slots
            .map((p, index) => ({ p, slot: index }))
            .filter(({ p }) => p.token !== ZERO_ADDRESS);

          const positions = await Promise.all(
            open.map(async ({ p, slot }) => {
              /*
               * The tax tier of the token in THIS slot, read fresh and per position.
               *
               * The strategy rebuild found a live bug this closes: exits were costed against the
               * CONFIG's tax rather than the position's own tier, so a 10%-tax position could be
               * sold into a "profit" that did not cover the ~1900bps it actually costs to round
               * trip. With eight slots a stray can hold eight different tiers at once, so a single
               * per-stray tax figure is not merely imprecise — it is a number that belongs to a
               * different position.
               */
              const taxPct = (await padTaxPct(p.token)) ?? 10;
              /*
               * The REAL token balance, read from chain, full precision.
               *
               * Never a number: an 18-decimal balance needs ~22 significant digits and float64
               * holds ~15–17 (RESEARCH §7d). Valuing zero units returns zero, which reads as an
               * unreadable mark, which means HOLD forever — that was half of the original "cats can
               * enter but never exit" bug.
               */
              const [, balance] = await pub.readContract({
                address: VAULT,
                abi: VAULT_ABI,
                functionName: "holdingOf",
                args: [id, BigInt(slot)],
              });
              return {
                slot,
                token: p.token,
                units: balance,
                costBasisWei: p.costBasis,
                tickSpacing: p.tickSpacing,
                hook: p.hook,
                /*
                 * THE AUTHORITATIVE WATERMARK, straight off the chain, every tick.
                 *
                 * Read here rather than trusted from Postgres because the chain is the authority:
                 * `tick.ts` reconciles the two by taking the maximum, and a keeper that never read
                 * the chain's copy could not notice its local one had fallen behind. This is the
                 * value that survived the restart.
                 */
                peakPriceWei: p.peakPriceWei,
                taxPct,
                openedAtSeconds: Number(p.openedAt),
              } satisfies PositionState;
            }),
          );

          return {
            id,
            stakeWei: stake,
            positions,
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
      ? async (strayId, token, hook, amountWei, minOut, tickSpacing) => {
          if (!wallet) throw new Error("unreachable: live without a wallet");
          /*
           * The hook is refused HERE as well as on chain. `StrayVault._requireKnownHook` reverts on
           * an unknown one, but a revert is a wasted transaction with real gas attached, while this
           * refusal costs a log line. `hook.ts`'s header makes the case for both layers existing:
           * they fail differently — a keeper bug is caught by the contract, and a contract we have
           * not yet redeployed is protected by the keeper — and neither is allowed to be the only
           * one.
           */
          assertKnownHook(hook);
          /*
           * ══ SIMULATE FIRST, TO LEARN THE SLOT ══
           *
           * `hunt` RETURNS the slot it picked, but a `writeContract` receipt does not carry return
           * data — only logs and gas. `simulateContract` runs the same call against the same state
           * and hands back the return value, and it is what viem recommends before a write anyway:
           * a call that would revert is caught here, for free, before gas is spent.
           *
           * The slot is then confirmed against the `Entered` event in the receipt, because a
           * simulation is a prediction about a state that can change before the transaction lands.
           * The EVENT is the observation.
           */
          const { request, result: predictedSlot } = await pub.simulateContract({
            account: wallet.account,
            address: VAULT,
            abi: VAULT_ABI,
            functionName: "hunt",
            args: [strayId, token, hook as `0x${string}`, amountWei, minOut, tickSpacing],
          });
          const hash = await wallet.writeContract(request);
          const r = await pub.waitForTransactionReceipt({ hash });
          if (r.status !== "success") throw new Error(`hunt reverted: ${hash}`);

          /*
           * THE SLOT THE CHAIN ACTUALLY USED, from the `Entered` event rather than the simulation.
           *
           * If a `flee` landed between the simulation and this transaction, the contract's
           * lowest-free scan can legitimately choose a different index than the one predicted. The
           * watermark is filed under this number, and filing it under a stale prediction would
           * attach this position's peak to a slot holding a different token — computing both
           * positions' trailing stops from the other one's price.
           */
          const entered = parseEventLogs({
            abi: VAULT_ABI,
            eventName: "Entered",
            logs: r.logs,
          }).find((l) => l.args.strayId.toLowerCase() === strayId.toLowerCase());
          const slot = entered !== undefined ? Number(entered.args.slot) : Number(predictedSlot);
          return { txHash: hash, gasUsed: r.gasUsed, slot };
        }
      : (refuse("hunt") as TickDeps["executeHunt"]),

    executeFlee: live
      ? async (strayId, slot, minOut) => {
          if (!wallet) throw new Error("unreachable: live without a wallet");
          const hash = await wallet.writeContract({
            address: VAULT,
            abi: VAULT_ABI,
            functionName: "flee",
            args: [strayId, BigInt(slot), minOut],
          });
          const r = await pub.waitForTransactionReceipt({ hash });
          if (r.status !== "success") throw new Error(`flee reverted: ${hash}`);
          return { txHash: hash, gasUsed: r.gasUsed };
        }
      : (refuse("flee") as TickDeps["executeFlee"]),

    /**
     * RAISE THE ON-CHAIN WATERMARK. **Gated by the same three switches as `hunt` and `flee`.**
     *
     * ⚠ `mark` is NOT exempt from the kill switch and that is a deliberate decision, not an
     * oversight. It moves no value — the contract's own header notes that nothing reads
     * `peakPriceWei` to gate anything, so a wrong value cannot block an exit or a withdrawal — but
     * "moves no value" is the wrong test. It signs a transaction with the keeper key, spends gas
     * from the keeper's balance, and writes to contract storage.
     *
     * meridian's recorded failure is EXACTLY the exemption this refuses to make: its LP guard "runs
     * EVEN WITH AGENT_LIVE_TRADING=false", so its master switch did not stop all on-chain activity
     * and an operator who turned it off was still transacting. An operator who has not set all
     * three switches has not consented to any transaction, including a cheap one.
     *
     * So in observe mode this THROWS, exactly like the other two, and the keeper maintains only its
     * local watermark — which is enough to make its decisions real, since it executes nothing.
     */
    executeMark: live
      ? async (strayId, slot, priceWei) => {
          if (!wallet) throw new Error("unreachable: live without a wallet");
          const hash = await wallet.writeContract({
            address: VAULT,
            abi: VAULT_ABI,
            functionName: "mark",
            args: [strayId, BigInt(slot), priceWei],
          });
          const r = await pub.waitForTransactionReceipt({ hash });
          if (r.status !== "success") throw new Error(`mark reverted: ${hash}`);
          return { txHash: hash, peakPriceWei: priceWei };
        }
      : (refuse("mark") as TickDeps["executeMark"]),

    /*
     * The DURABLE local mirror of the watermark. Absent entirely when there is no store, which is
     * only tolerable in observe mode — `assertDurableLedger` already refuses to boot a live keeper
     * without Postgres, and the same store holds both.
     */
    loadPeaks:
      store !== null
        ? async (strayId) => {
            const rows = await store.peaksFor(strayId);
            const out = new Map<number, { token: string; peakPriceWei: bigint }>();
            for (const [slot, row] of rows) {
              out.set(slot, { token: row.token, peakPriceWei: row.peakPriceWei });
            }
            return out;
          }
        : undefined,

    savePeak:
      store !== null
        ? async ({ strayId, slot, token, peakPriceWei }) => {
            await store.raisePeak({
              strayId,
              slot,
              token,
              peakPriceWei,
              atSeconds: Math.floor(Date.now() / 1000),
            });
          }
        : undefined,

    clearPeak: store !== null ? (strayId, slot) => store.clearPeak(strayId, slot) : undefined,

    /**
     * ══ WHAT IS THE OPEN POSITION WORTH RIGHT NOW? ══
     *
     * This was `async () => 0n` — a stub — and the consequence was not that exits were slightly
     * wrong, it was that they were IMPOSSIBLE. `decide()` reads the mark to evaluate the stop and
     * the take-profit; a zero mark reads as "unreadable", and its (correct) response to an
     * unreadable mark is to HOLD, because selling on a failed price read is a trade on no
     * information.
     *
     * So the first cat to enter a position could never leave it. Caught the moment a real trade
     * landed: the very next tick logged *"holding 0x5235709f…: mark price unreadable this tick"*.
     *
     * The fix is the sell simulation we already run before every ENTRY, pointed at the position we
     * already hold. `eth_call` only, so valuing a position costs nothing and risks nothing.
     */
    quoteExitWei: async (token, units, tickSpacing, hook) => {
      if (units <= 0n) return 0n;
      const sell = await simulateSell({
        client: pub,
        token,
        tickSpacing,
        // The hook the position was ENTERED through, read back from the chain's `Position.hook`.
        // Quoting against the other one prices a pool this position is not in (RESEARCH §7d).
        hook,
        amountInTokens: units,
      });
      // A failed quote returns 0, which `decide()` reads as "unreadable" and answers by HOLDING.
      // That is the honest outcome: we could not price it, so we do not act on a price.
      return sell.ok ? sell.proceedsWei : 0n;
    },

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
    decide: async ({ stray, candidates, gasPriceWei, marks, totalValueWei, block }) => {
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
          // Resolved by reconstructing the poolId against both candidates and matching the pad's
          // own `pool` field — RESEARCH §7d. Never the old hardcoded constant, which could not
          // address 44 of 111 tokens including LEVCAT, INTERN and Seriouscat.
          hook: c.hook,
          amountInWei: sizeProbeWei,
        });
        if (quotedOut === null) return null; // unquotable is untradeable. Never estimated.

        // CAN WE GET OUT? Simulate the exit BEFORE committing to the entry.
        const sell = await simulateSell({
          client: pub,
          token: c.address,
          tickSpacing: c.tickSpacing,
          hook: c.hook,
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
            /*
             * THE ENTRY GATE'S INPUT. Realised swaps, not seconds.
             *
             * `age.ts` indexes the measured dose-response by swap number because that is the unit
             * §10.4 measured in — RESEARCH §3d found 40% of this pad has never traded at all, so a
             * token can be a day old and sit at swap 0. Age says how long a token has EXISTED;
             * this says how much it has been TRADED, and only the second one predicted anything.
             *
             * `discovery.ts` documents the measured limitation honestly: the pad's `/trades`
             * endpoint caps at 100 rows with no total and no pagination, so this is
             * `min(true count, 100)` and is EXACT inside the [20, 50] entry window. A failed read
             * arrives as -1, which `withinEntryWindow` refuses outright — never as 0, which is the
             * earliest and most attractive dose on the curve.
             */
            swapCount: c.swapCount,
            // Resolved per token by poolId reconstruction. `isEligible` re-checks it against the
            // two-entry allowlist, so an unknown hook is refused before a quoter call is spent.
            hook: c.hook,
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

      /*
       * ══ THE MARK PRICES, ONE PER OPEN POSITION, KEYED BY TOKEN ══
       *
       * `Market.markPricesWei` is a MAP now, not a single price, and the reason is not tidiness:
       * with eight concurrent positions a lone mark would value whichever position the loop
       * happened to reach at ANOTHER token's price, and the trailing stop would fire — or fail to
       * fire — on a number belonging to something else entirely.
       *
       * Only READABLE marks are inserted. A missing key is not an error and is not a sell signal:
       * `decide` holds that position, says so, and keeps evaluating the other seven against their
       * own stops. Inserting a 0 for a failed read would instead manufacture a 100% fall out of an
       * RPC blip and close a healthy position.
       *
       * Each value is already a PER-UNIT price — `tick.ts` divides total proceeds by units held.
       * `units.test.ts` pins why: passing the total compared a whole-position value against a
       * per-unit peak and reported +574,656,667bps on a position that had moved +66bps.
       */
      const markPricesWei = new Map<string, bigint>();
      for (const m of marks) {
        if (m.markPriceWei !== null && m.markPriceWei > 0n) {
          markPricesWei.set(m.token, m.markPriceWei);
        }
      }
      /** The reconciled watermark for each slot, so the peak handed to the strategy is the durable one. */
      const peakBySlot = new Map(marks.map((m) => [m.slot, m.peakPriceWei]));

      const equityWei = stray.stakeWei + totalValueWei;

      const d = await strategyDecide(
        {
          strayId: stray.id,
          compartmentWei: stray.stakeWei,
          highWaterMarkWei: equityWei,
          equityWei,
          /*
           * ══ EVERY OPEN POSITION, NOT ONE ══
           *
           * RESULTS §10.5: a single-position field takes 17 of 72 held-out opportunities at a Welch
           * t of 1.16 (not significant); eight slots take 71 of 72 at t 2.38–2.72 with an identical
           * per-ticket median. The edge per ticket never changed — only n did, and n was what the
           * claim needed.
           */
          positions: stray.positions.map((p) => ({
            token: p.token,
            slot: p.slot,
            entryWei: p.costBasisWei,
            /*
             * ══ DERIVED FROM WHAT THE VAULT ACTUALLY SPENT AND RECEIVED ══
             *
             * Entry price is costBasis/units, scaled 1e18 to match the mark's units. bigint
             * throughout — RESEARCH §7d, where a value round-tripped through float64 loses the ~22
             * significant digits an 18-decimal amount needs.
             */
            entryPriceWei:
              p.units > 0n ? (p.costBasisWei * 10n ** 18n) / p.units : 0n,
            /*
             * ══ THE RECONCILED PEAK WATERMARK — THE ONE NUMBER THE EXIT IS COMPUTED FROM ══
             *
             * Taken from `marks`, where `tick.ts` merged the chain's copy (the authority), the
             * Postgres mirror and this tick's mark by taking the maximum. It falls back to the
             * chain's raw value only if this slot somehow produced no mark entry.
             *
             * `trailingStopFired` THROWS on a non-positive peak rather than treating it as a
             * signal, which is the correct refusal: a zero watermark is an unset or RESET one, and
             * a reset watermark re-anchors the stop to the current price and silently disarms the
             * only exit this strategy has (RESEARCH §7f — meridian's "spend since last boot" in a
             * new costume). The contract seeds it to the measured entry price at `hunt`, so a live
             * position always has one.
             */
            peakPriceWei: peakBySlot.get(p.slot) ?? p.peakPriceWei,
            /*
             * The hook this position was entered through, carried so the exit addresses the SAME
             * pool the entry did. Re-deriving it would be a second chance to derive it differently.
             */
            hook: p.hook,
            // Full precision, never a number (RESEARCH §7d).
            tokenBalance: p.units,
            openedAtSeconds: p.openedAtSeconds,
            // Defaults to the WORST tier when unknown. An unknown cost must never be assumed
            // cheap — that is the direction that loses money.
            taxPct: p.taxPct ?? 10,
          })),
        },
        {
          // Built in the tick body below, because each one needs a real quoter call and a real
          // price history — neither of which a `map` over the API rows can produce.
          candidates: huntCandidates,
          gasPriceWei,
          markPricesWei,
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
                hook: chosen.hook,
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
          /*
           * The hook comes from the DECISION, which carried it off the candidate that was screened
           * — so the pool that was screened is the pool that is traded. A keeper that re-derived it
           * here could re-derive it differently, and RESEARCH §7d's failure mode for addressing the
           * wrong pool is an empty inner revert that reads like an RPC problem rather than a bug.
           */
          hook: d.hook,
          reason: `${d.reason} | minOut re-quoted at the real size: ${scaledMinOut}`,
        };
      }
      if (d.kind === "exit") {
        /*
         * ══ THE FLOOR IS DERIVED FROM **THIS SLOT'S** MARK, NOT FROM A PORTFOLIO TOTAL ══
         *
         * The strategy's exit carries no minOut, and that is correct: a floor computed at decision
         * time is stale by the time the transaction lands. It is derived here from the value quoted
         * for the position actually being sold — found by SLOT, which is the field `flee` names.
         *
         * Using the portfolio's total value here would be the multi-slot version of the units bug
         * `units.test.ts` pins: a floor scaled to eight positions applied to a sale of one would be
         * wildly above what the pool can deliver, and every exit would revert with
         * `V4TooLittleReceived` — which is to say the trailing stop would be armed and unable to
         * fire, the single worst outcome available here.
         *
         * Never zero: a zero floor is an unbounded MEV sandwich (RESEARCH §7c). When the mark is
         * unreadable this falls back to 1 wei, which is a real floor rather than an absent one —
         * and `decide` does not reach this branch on an unreadable mark anyway, because it holds.
         */
        const closing = marks.find((m) => m.slot === d.slot);
        const valueWei = closing?.valueWei ?? 0n;
        const minOut = valueWei !== null && valueWei > 0n ? (valueWei * 9500n) / 10_000n : 1n;
        return {
          kind: "exit",
          slot: d.slot,
          token: d.token as `0x${string}`,
          minOut,
          reason: d.reason,
        };
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
