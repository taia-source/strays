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
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fetchCandidates } from "./discovery.js";
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

    // The strategy is supplied by @strays/hunt. Wired in the next pass; until then the keeper
    // observes and holds, which is stated rather than dressed up as a working strategy.
    decide: () => ({ kind: "hold", reason: "strategy not yet wired to the keeper" }),

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
