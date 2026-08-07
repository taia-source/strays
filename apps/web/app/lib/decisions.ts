/**
 * The decision feed, read from the vault's own events.
 *
 * Reading EVENTS rather than a database is deliberate for this page: the events are the chain's
 * own record, so nothing here can drift from what actually happened. An indexer mirror exists for
 * speed, but the authoritative surface for "prove the cat did this" must be the chain.
 */
import { createPublicClient, http, parseAbi, formatEther } from "viem";
import { CHAIN_ID, RPC_URL, VAULT_ADDRESS, VAULT_DEPLOY_BLOCK } from "./config";

export type DecisionRow = {
  readonly strayId: `0x${string}`;
  readonly action: "hunt" | "flee" | "adopt" | "withdraw";
  readonly rationale: string;
  readonly outcome: "landed" | "failed";
  readonly txHash: `0x${string}` | null;
  readonly block: bigint;
  readonly at: number;
};

const ABI = parseAbi([
  "event Adopted(bytes32 indexed strayId, address indexed owner, uint256 stake, uint256 energyFee)",
  "event Entered(bytes32 indexed strayId, address indexed token, uint256 ethIn, uint256 tokensOut, int24 tickSpacing)",
  "event Exited(bytes32 indexed strayId, address indexed token, uint256 tokensIn, uint256 ethOut)",
  "event Withdrawn(bytes32 indexed strayId, address indexed owner, uint256 paid, uint256 rake)",
]);

const client = createPublicClient({
  transport: http(RPC_URL),
  chain: {
    id: CHAIN_ID, name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  },
});

export async function recentDecisions(limit = 100): Promise<{
  rows: readonly DecisionRow[]; block: bigint; at: number;
}> {
  const at = Date.now();
  const block = await client.getBlockNumber();
  // Same rule as chain.ts: the vault did not exist before its deploy block.
  const logs = await client.getLogs({ address: VAULT_ADDRESS, events: ABI, fromBlock: VAULT_DEPLOY_BLOCK, toBlock: block });

  const rows: DecisionRow[] = logs.map((l) => {
    const name = (l as { eventName?: string }).eventName ?? "";
    const a = (l as { args: Record<string, unknown> }).args;
    if (name === "Entered") {
      return {
        strayId: a.strayId as `0x${string}`, action: "hunt",
        rationale: `bought ${formatEther(a.tokensOut as bigint).slice(0, 10)} units for ${formatEther(a.ethIn as bigint)} ETH`,
        outcome: "landed", txHash: l.transactionHash, block: l.blockNumber ?? 0n, at,
      };
    }
    if (name === "Exited") {
      return {
        strayId: a.strayId as `0x${string}`, action: "flee",
        rationale: `sold back for ${formatEther(a.ethOut as bigint)} ETH`,
        outcome: "landed", txHash: l.transactionHash, block: l.blockNumber ?? 0n, at,
      };
    }
    if (name === "Withdrawn") {
      return {
        strayId: a.strayId as `0x${string}`, action: "withdraw",
        rationale: `owner withdrew ${formatEther(a.paid as bigint)} ETH, rake ${formatEther(a.rake as bigint)}`,
        outcome: "landed", txHash: l.transactionHash, block: l.blockNumber ?? 0n, at,
      };
    }
    return {
      strayId: a.strayId as `0x${string}`, action: "adopt",
      rationale: `adopted with ${formatEther((a.stake ?? 0n) as bigint)} ETH of stake`,
      outcome: "landed", txHash: l.transactionHash, block: l.blockNumber ?? 0n, at,
    };
  });

  rows.sort((x, y) => Number(y.block - x.block));
  return { rows: rows.slice(0, limit), block, at };
}
