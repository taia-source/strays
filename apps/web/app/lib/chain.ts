/**
 * Reading colony state from chain.
 *
 * ══ THE RULE THIS FILE EXISTS TO OBEY ══
 *
 * **No invented data in shipped source.** `BUILD-A-PROJECT.md` calls a table of hand-typed
 * addresses with plausible balances "the single most dangerous defect an agent produces: a blank
 * table reads as broken, a fake one reads as fine."
 *
 * So there is no seed array here, no demo fallback, and no example row. If nothing has been
 * adopted, `listStrays` returns an empty list and the page says the colony is empty. That is the
 * honest rendering of an empty colony.
 *
 * The landing page's example portraits are the one exception, and they are labelled "portraits —
 * drawn from an id, not live strays" and carry NO balances, because a portrait of the artwork is
 * not a claim about the world.
 *
 * ══ EVERY FIGURE IS STAMPED ══
 *
 * `listStrays` returns the block it read at alongside the data. ART-DIRECTION referent rule 2: a
 * trap that shows an animal without a timestamp is useless, so nothing here floats free of when it
 * was measured. Pages render that stamp; they do not have the option not to, because the block is
 * part of the return type.
 */
import { createPublicClient, http, parseAbi, formatEther } from "viem";
import { CHAIN_ID, RPC_URL, VAULT_ADDRESS, VAULT_DEPLOY_BLOCK } from "./config";

export type StrayRow = {
  readonly id: `0x${string}`;
  readonly owner: `0x${string}`;
  readonly stakeEth: number;
  readonly principalEth: number;
  /** Realised profit against principal. Negative is a real, displayed outcome. */
  readonly pnlEth: number;
  readonly holding: `0x${string}` | null;
  readonly state: "fed" | "hunting" | "starving" | "dead";
};

export type ColonyRead = {
  readonly strays: readonly StrayRow[];
  readonly block: bigint;
  /** Unix ms of the read, for the stamp. The BLOCK is the authoritative one. */
  readonly at: number;
};

const VAULT_ABI = parseAbi([
  "function strays(bytes32) view returns (address owner, uint128 stake, uint128 principal, address holding, int24 tickSpacing, uint128 costBasis)",
  "event Adopted(bytes32 indexed strayId, address indexed owner, uint256 stake, uint256 energyFee)",
]);

const client = createPublicClient({
  transport: http(RPC_URL),
  chain: {
    id: CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  },
});

/**
 * Classify a stray for rendering.
 *
 * `starving` is a real state with a real threshold, not decoration: a cat below 80% of what it
 * started with is losing, and DESIGN §2 requires that be drawn honestly rather than softened.
 */
function classify(stake: bigint, principal: bigint, holding: `0x${string}` | null): StrayRow["state"] {
  if (stake === 0n && holding === null) return "dead";
  if (holding !== null) return "hunting";
  if (principal > 0n && stake * 100n < principal * 80n) return "starving";
  if (stake > principal) return "fed";
  return "hunting";
}

/**
 * Read every stray that has ever been adopted, and its current state.
 *
 * Strays are discovered from `Adopted` logs rather than from a list the contract does not keep.
 * Events are keyed on the log's own identity, and a re-read is idempotent — `@taia/indexer`'s rule
 * is to key on BLOCK HASH rather than number, because a reorg reuses the number with different
 * content. Here we re-read state fresh each time rather than accumulating, which sidesteps the
 * problem entirely: nothing is incremented, so nothing can double-count.
 */
export async function listStrays(): Promise<ColonyRead> {
  const at = Date.now();
  let block: bigint;
  try {
    block = await client.getBlockNumber();
  } catch {
    // A fetch failure is a failure mode, not a conclusion. Never render "0 strays" because the RPC
    // was unreachable — that reads identically to a genuinely empty colony and is a lie.
    throw new Error("chain unreachable — cannot read the colony");
  }

  // NEVER scan from block 0. The vault did not exist before VAULT_DEPLOY_BLOCK, so every block
  // before it is a guaranteed-empty range — and on a chain at ~30M blocks that is a multi-second
  // request that times out under `networkidle`. Measured: the first version of this page hung the
  // screenshot harness for 30s per load. @taia/deploy's `checkStartBlockOnChain` exists for this.
  const logs = await client.getLogs({
    address: VAULT_ADDRESS,
    event: VAULT_ABI[1],
    fromBlock: VAULT_DEPLOY_BLOCK,
    toBlock: block,
  });

  const ids = [...new Set(logs.map((l) => l.args.strayId as `0x${string}`))];
  if (ids.length === 0) return { strays: [], block, at };

  const rows = await Promise.all(
    ids.map(async (id) => {
      const [owner, stake, principal, holding] = await client.readContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "strays",
        args: [id],
      });
      const held = holding === "0x0000000000000000000000000000000000000000" ? null : holding;
      return {
        id,
        owner,
        stakeEth: Number(formatEther(stake)),
        principalEth: Number(formatEther(principal)),
        pnlEth: Number(formatEther(stake)) - Number(formatEther(principal)),
        holding: held,
        state: classify(stake, principal, held),
      } satisfies StrayRow;
    }),
  );

  return { strays: rows, block, at };
}
