/**
 * Reconciliation: proving the indexer actually ingested what the chain emitted.
 *
 * "The indexer ran fine and ingested nothing" is invisible to a green test suite — the
 * deploy succeeds, lag reads 0, and a table is quietly empty or short. That was a dashboard
 * bug when a human read the number. It is a financial bug once an autonomous agent trades
 * on it, which is the direction every project here is heading.
 *
 * ══ Why `eth_getLogs` alone is not trustworthy ══
 *
 * `eth_getLogs` can return an INCOMPLETE result with no error. Documented case: a Polygon
 * block where `eth_getLogs` returned 848 logs while the block genuinely contained 856 —
 * the eight missing ones were state-sync logs absent from `logsBloom`, so the node's log
 * index never saw them. No error, no warning, eight events gone.
 *
 * Transaction receipts are derived from execution rather than from the bloom index, so
 * they are the independent source of truth. Cross-checking the two is the only way to
 * catch a node whose log index is lying.
 *
 * Measured on 4663, 2026-07-27 — clean, but that is a property of this chain today and
 * exactly why it is asserted rather than assumed:
 *
 *   block 20932122: getLogs=121  receipts=121  MATCH
 *   block 20932121: getLogs=25   receipts=25   MATCH
 *   block 20932120: getLogs=47   receipts=47   MATCH
 */
import type { BlockReader } from "@taia/rpc";
import { getBlock, getLogs, getTransactionReceipt } from "viem/actions";

export type BlockReconciliation = {
  readonly blockNumber: bigint;
  readonly viaGetLogs: number;
  readonly viaReceipts: number;
  readonly ok: boolean;
  /** Logs the receipts reported that `eth_getLogs` did not. Non-empty means node bug. */
  readonly missingFromLogIndex: number;
};

/**
 * Compare `eth_getLogs` against the sum of the block's receipts.
 *
 * Queries by **blockHash**, not by number: a hash cannot silently point at different
 * content, whereas a block number can be re-mined underneath you between two calls —
 * which would make a reorg look like a node bug.
 */
export async function reconcileBlock(
  client: BlockReader,
  blockNumber: bigint,
): Promise<BlockReconciliation> {
  const block = await getBlock(client, { blockNumber, includeTransactions: true });
  if (block.hash === null) throw new Error(`block ${blockNumber} has no hash`);

  const logs = await getLogs(client, { blockHash: block.hash });

  let viaReceipts = 0;
  for (const tx of block.transactions) {
    const hash = typeof tx === "string" ? tx : tx.hash;
    const receipt = await getTransactionReceipt(client, { hash });
    viaReceipts += receipt.logs.length;
  }

  return {
    blockNumber,
    viaGetLogs: logs.length,
    viaReceipts,
    ok: logs.length === viaReceipts,
    missingFromLogIndex: Math.max(0, viaReceipts - logs.length),
  };
}

export type CoverageReport = {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  /** What the chain says happened. */
  readonly onChain: number;
  /** What we stored. */
  readonly indexed: number;
  readonly ok: boolean;
  readonly missing: number;
  /** More rows than events — duplicates, a non-idempotent write, or a stale reorg row. */
  readonly extra: number;
};

/**
 * Compare stored row count against the chain over a range.
 *
 * ⚠ THIS IS A REGRESSION CHECK, NOT A COMPLETENESS PROOF. It compares our storage
 * against `eth_getLogs` — the same source that can silently under-report (see the header).
 * Equality proves we agree with the RPC, not that either is right. Catches OUR bugs;
 * cannot catch the RPC's. Use `reconcileBlock` (receipts) when completeness must be proven.
 *
 * `countIndexed` is injected so this works against any storage. Both directions matter:
 * missing rows are lost events; EXTRA rows mean duplicates or rows orphaned by a reorg
 * that were never deleted — the exact failure an upsert-only strategy cannot fix.
 */
export async function reconcileRange(options: {
  readonly client: BlockReader;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly address?: `0x${string}` | readonly `0x${string}`[];
  readonly countIndexed: (from: bigint, to: bigint) => Promise<number>;
}): Promise<CoverageReport> {
  const { client, fromBlock, toBlock, address, countIndexed } = options;

  const logs = await getLogs(client, {
    fromBlock,
    toBlock,
    ...(address ? { address: address as never } : {}),
  });
  const indexed = await countIndexed(fromBlock, toBlock);

  return {
    fromBlock,
    toBlock,
    onChain: logs.length,
    indexed,
    ok: indexed === logs.length,
    missing: Math.max(0, logs.length - indexed),
    extra: Math.max(0, indexed - logs.length),
  };
}

/**
 * Assert every expected event type produced at least one row.
 *
 * A zero count is the signature of a handler wired to the wrong signature: it indexes
 * nothing, forever, without erroring. `MarketMakerDeployed` sat at zero from day one
 * while the deploy stayed green and the vault sat funded and idle.
 *
 * Any event legitimately absent must be listed in `allowedZero` WITH A REASON, so the
 * omission is a decision rather than an accident.
 */
export function checkEventCounts(options: {
  readonly counts: Readonly<Record<string, number>>;
  readonly allowedZero?: Readonly<Record<string, string>>;
}): { readonly ok: boolean; readonly silent: readonly string[] } {
  const { counts, allowedZero = {} } = options;
  const silent = Object.entries(counts)
    .filter(([name, count]) => count === 0 && !allowedZero[name])
    .map(([name]) => name);
  return { ok: silent.length === 0, silent };
}
