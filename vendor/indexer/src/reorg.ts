/**
 * Reorg detection.
 *
 * The seed implementation this package is extracted from relied entirely on idempotent
 * upserts: re-scan the unfinalised tail, overwrite to canonical, no rollback logic. That
 * is correct for a *shallow* reorg where the same rows get rewritten — and it is silent
 * and wrong for a deep one, where a block's events vanish entirely. Overwriting never
 * deletes, so an orphaned event stays in the table forever.
 *
 * That distinction stops being academic once agents act on indexed data: a stale row is
 * no longer a wrong dashboard number, it is a trade placed on an event that never
 * happened.
 *
 * ══ What the target chain actually does ══
 *
 * Measured on 4663 (Arbitrum Orbit, centralized sequencer), 2026-07-27: block hashes at
 * 1, 5, 20, 100 and 200 blocks behind the tip were all stable across a 45-second window
 * in which the head advanced 458 blocks. Zero hash changes.
 *
 * That is expected for a centralized sequencer, and it is NOT a guarantee. A sequencer
 * can be reconfigured, and an L1 reorg can in principle change the L2's view of posted
 * batches. "We did not observe a reorg in 45 seconds" is not "reorgs cannot happen", so
 * detection stays in.
 *
 * ══ The two primitives, both verified present on 4663 ══
 *
 *   1. `parentHash` chaining — block N+1's parentHash must equal block N's hash.
 *   2. `eth_getLogs` by `blockHash` — verified SUPPORTED (returned 68 logs). This is the
 *      reorg-SAFE query form: a hash cannot silently point at different content, whereas
 *      a block *number* can be re-mined underneath you between two calls.
 */
import type { BlockReader } from "@taia/rpc";
import { getBlock } from "viem/actions";

export type BlockRef = {
  readonly number: bigint;
  readonly hash: `0x${string}`;
  readonly parentHash: `0x${string}`;
};

/** What a reorg check concluded. `depth` is how many blocks must be rolled back. */
export type ReorgCheck =
  | { readonly kind: "ok" }
  /** The stored tip is no longer canonical. Roll back to `commonAncestor`, then re-scan. */
  | { readonly kind: "reorg"; readonly commonAncestor: bigint; readonly depth: number }
  /**
   * A reorg deeper than the tracked window. Cannot locate a common ancestor, so we do not
   * know how far back the damage goes. Loud by design — this must page a human, not
   * silently truncate.
   */
  | { readonly kind: "beyond-window"; readonly checked: number };

/**
 * A bounded ring of recent block refs.
 *
 * Only the unfinalised tail can reorg, so the window only needs to span finality. Keeping
 * every block since genesis would make the check O(chain).
 */
export class BlockWindow {
  readonly #capacity: number;
  #refs: BlockRef[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`block window needs capacity >= 1, got ${capacity}`);
    }
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#refs.length;
  }

  get tip(): BlockRef | undefined {
    return this.#refs.at(-1);
  }

  /** Blocks in ascending order. */
  entries(): readonly BlockRef[] {
    return this.#refs;
  }

  /**
   * Append a block, enforcing that it descends from the current tip.
   *
   * Throws on a parentHash mismatch rather than storing an inconsistent chain: a window
   * that lies about ancestry cannot detect a reorg later.
   */
  push(ref: BlockRef): void {
    const tip = this.tip;
    if (tip && ref.number === tip.number + 1n && ref.parentHash !== tip.hash) {
      throw new Error(
        `block ${ref.number} does not descend from stored tip ${tip.number}: ` +
          `parentHash ${ref.parentHash} != ${tip.hash}`,
      );
    }
    this.#refs.push(ref);
    if (this.#refs.length > this.#capacity) {
      this.#refs = this.#refs.slice(this.#refs.length - this.#capacity);
    }
  }

  /** Drop everything above `blockNumber`, inclusive of nothing below it. */
  rollbackTo(blockNumber: bigint): void {
    this.#refs = this.#refs.filter((r) => r.number <= blockNumber);
  }

  find(blockNumber: bigint): BlockRef | undefined {
    return this.#refs.find((r) => r.number === blockNumber);
  }
}

export async function readBlockRef(client: BlockReader, blockNumber: bigint): Promise<BlockRef> {
  const block = await getBlock(client, { blockNumber });
  if (block.number === null || block.hash === null) {
    throw new Error(`block ${blockNumber} has no number or hash — is it pending?`);
  }
  return { number: block.number, hash: block.hash, parentHash: block.parentHash };
}

/**
 * Walk backwards from the stored tip until a stored hash matches the chain.
 *
 * Returns the highest block still canonical. Everything above it must be deleted and
 * re-scanned — NOT merely upserted, because a reorg can remove events entirely and an
 * upsert has no way to express deletion.
 */
export async function detectReorg(client: BlockReader, window: BlockWindow): Promise<ReorgCheck> {
  const refs = window.entries();
  if (refs.length === 0) return { kind: "ok" };

  let checked = 0;
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    const stored = refs[i];
    if (stored === undefined) continue;
    checked += 1;

    const onChain = await readBlockRef(client, stored.number);
    if (onChain.hash === stored.hash) {
      // Found the fork point. Anything above it is orphaned.
      const depth = refs.length - 1 - i;
      return depth === 0 ? { kind: "ok" } : { kind: "reorg", commonAncestor: stored.number, depth };
    }
  }

  // Every tracked block disagrees with the chain — the reorg is deeper than we can see.
  return { kind: "beyond-window", checked };
}
