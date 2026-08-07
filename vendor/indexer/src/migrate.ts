/**
 * Schema and decode-surface migration WITHOUT a full re-index.
 *
 * This is the entire reason this package exists rather than Ponder. Ponder computes a
 * `build_id` from config + schema + handlers; when it changes it refuses to resume and
 * re-indexes from the start block, and that cannot be turned off. On a chain with 100ms
 * blocks and ~45–100 logs/block, "re-read from genesis" is not a migration strategy.
 *
 * Owning the indexer means owning the migration. Three kinds of change, three costs:
 *
 *   ┌────────────────────────────┬──────────────────────────────────────────────┐
 *   │ change                     │ what actually has to happen                  │
 *   ├────────────────────────────┼──────────────────────────────────────────────┤
 *   │ add a COLUMN, derived from │ ALTER TABLE + backfill from existing rows.    │
 *   │ data already stored        │ No chain reads at all.                        │
 *   ├────────────────────────────┼──────────────────────────────────────────────┤
 *   │ add an EVENT               │ Re-scan history for THAT topic0 only, writing │
 *   │                            │ only its table. Existing tables untouched.    │
 *   ├────────────────────────────┼──────────────────────────────────────────────┤
 *   │ change a handler's LOGIC   │ Re-scan the affected event's range and upsert.│
 *   │ for an event already indexed│ Idempotent writes make this safe to repeat.  │
 *   └────────────────────────────┴──────────────────────────────────────────────┘
 *
 * Only the third case touches existing rows, and it rewrites rather than deletes.
 */
import type { DecodedEvent } from "./decode.js";

/** A backfill job: one event, over one block range, into one table. */
export type BackfillPlan = {
  readonly topic0: `0x${string}`;
  readonly signature: string;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  /** Why this range needs re-reading — surfaced in logs so a long backfill is explicable. */
  readonly reason: string;
};

/**
 * Work out which events need historical backfill after a decode-surface change.
 *
 * The key property: an event present in BOTH surfaces needs no work. History was already
 * read with a decoder for it, so its rows are complete. Only genuinely new topic0s get
 * re-scanned — which is what makes this O(new events) rather than O(everything).
 */
export function planBackfill(options: {
  readonly previous: readonly DecodedEvent[];
  readonly current: readonly DecodedEvent[];
  readonly startBlock: bigint;
  readonly cursorBlock: bigint;
}): BackfillPlan[] {
  const { previous, current, startBlock, cursorBlock } = options;

  // Nothing indexed yet — the normal forward scan covers everything.
  if (cursorBlock <= startBlock) return [];

  const known = new Set(previous.map((e) => e.topic0));

  return current
    .filter((event) => !known.has(event.topic0))
    .map((event) => ({
      topic0: event.topic0,
      signature: event.signature,
      fromBlock: startBlock,
      toBlock: cursorBlock,
      reason:
        `${event.signature} was added after block ${cursorBlock} had already been scanned; ` +
        "history is blind to it until re-read",
    }));
}

/**
 * Does this change require touching rows that already exist?
 *
 * Adding events never does — new events write new rows. Changing how an already-indexed
 * event is interpreted does, and the caller should know that before starting, because it
 * is the expensive case.
 */
export function rewritesExistingRows(options: {
  readonly previous: readonly DecodedEvent[];
  readonly current: readonly DecodedEvent[];
  readonly changedHandlers?: readonly string[];
}): boolean {
  const { previous, current, changedHandlers = [] } = options;
  if (changedHandlers.length > 0) return true;

  // A topic0 that disappeared means an event is no longer decoded; its rows are now
  // stale and someone has to decide whether to drop them.
  const currentTopics = new Set(current.map((e) => e.topic0));
  return previous.some((e) => !currentTopics.has(e.topic0));
}

export type MigrationSummary = {
  readonly backfills: readonly BackfillPlan[];
  readonly rewritesExisting: boolean;
  /** Blocks to re-read, summed across jobs. The honest cost estimate. */
  readonly blocksToRescan: bigint;
};

export function planMigration(options: {
  readonly previous: readonly DecodedEvent[];
  readonly current: readonly DecodedEvent[];
  readonly startBlock: bigint;
  readonly cursorBlock: bigint;
  readonly changedHandlers?: readonly string[];
}): MigrationSummary {
  const backfills = planBackfill(options);
  const blocksToRescan = backfills.reduce(
    (total, job) => total + (job.toBlock - job.fromBlock + 1n),
    0n,
  );
  return {
    backfills,
    rewritesExisting: rewritesExistingRows(options),
    blocksToRescan,
  };
}
