/**
 * Idempotency: the failure mode with confirmed financial loss.
 *
 * ══ The bug, from a real post-mortem ══
 *
 * Ponder issue #1671 (2025-04-14). One restake transaction increased `totalScaledSupply`
 * by **4× the correct amount** — 958,313,748,826,292,341 applied four times, because
 * block 22267231 was reprocessed during reorg handling.
 *
 * The subtle part: the row insert WAS idempotent, via `onConflictDoUpdate`. The aggregate
 * was not. `SET total = total + $1` applied four times is four times the value, and no
 * upsert on the detail row can save you.
 *
 * Same shape, different chain, real consequences: Nano v17.0 re-delivered old
 * transactions to Binance's node during a resync and they were **credited again** —
 * Binance suspended deposits, withdrawals and trading.
 *
 * ══ The two rules ══
 *
 *   1. Never write `x = x + n`. Derive aggregates from the event table, or key the
 *      increment by a unique event identity so a replay is a no-op.
 *   2. Key on **block HASH**, not block number. The entire point of a reorg is that the
 *      number repeats with different content. `(chainId, blockNumber, logIndex)` collides
 *      across forks; `(chainId, blockHash, logIndex)` cannot.
 *
 * This module gives the identity and the guard. Enforcement is a UNIQUE constraint in the
 * schema — application-level checks race under concurrency.
 */

/**
 * The only safe primary key for an indexed event.
 *
 * `blockHash` rather than `blockNumber` is load-bearing: two forks produce the same
 * number with different content, so a number-keyed upsert silently overwrites one fork's
 * event with the other's and a number-keyed increment double-counts.
 */
export type EventIdentity = {
  readonly chainId: number;
  readonly blockHash: `0x${string}`;
  readonly logIndex: number;
};

/** Stable string form, for use as a unique key or dedupe set member. */
export function eventKey(identity: EventIdentity): string {
  return `${identity.chainId}:${identity.blockHash}:${identity.logIndex}`;
}

/**
 * SQL that makes replay a no-op. Ship this shape in every generated schema.
 *
 * The UNIQUE constraint is what actually enforces idempotency — not application code,
 * which races. `ON CONFLICT DO NOTHING` then makes a re-scan free rather than fatal.
 */
export const IDEMPOTENT_EVENT_DDL = `
-- Every event table carries this identity. block_hash, NOT block_number:
-- a reorg reuses the number with different content.
--   chain_id     integer NOT NULL
--   block_hash   bytea   NOT NULL
--   block_number bigint  NOT NULL   -- for range queries and pruning only
--   log_index    integer NOT NULL
--   UNIQUE (chain_id, block_hash, log_index)
--
-- Writes use: INSERT ... ON CONFLICT (chain_id, block_hash, log_index) DO NOTHING
-- Aggregates are DERIVED from this table, never incremented in place.
`.trim();

/**
 * Duplicate identities within one batch.
 *
 * `ON CONFLICT` only guards against rows already committed. Duplicates *inside* a single
 * statement still error with "cannot affect row a second time" — which happens exactly
 * when reorg recovery re-fetches overlapping ranges. Deduplicate before sending.
 */
export function findDuplicates(identities: readonly EventIdentity[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const identity of identities) {
    const key = eventKey(identity);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

/** Keep the first occurrence of each identity, preserving order. */
export function dedupe<T extends { readonly identity: EventIdentity }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = eventKey(row.identity);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Static guard against non-idempotent aggregate writes.
 *
 * Catches `x = x + n` / `x -= n` and `SET col = col + …` in SQL or query-builder code.
 * Cheap, and it targets the one bug class with a confirmed four-times-overcount in
 * production. Run it over handler sources in the gate.
 *
 * Deliberately conservative: it looks for self-referential arithmetic assignment only, so
 * `total = computeTotal(rows)` and `total = other + n` pass. A comment containing
 * `idempotent-ok` suppresses a line that has been reviewed.
 */
export function findUnsafeIncrements(
  source: string,
): Array<{ readonly line: number; readonly text: string }> {
  const findings: Array<{ line: number; text: string }> = [];
  const lines = source.split("\n");

  // `foo += 1`, `foo -= 1`, or `foo = foo + 1` / `foo.bar = foo.bar - 1`
  const compound = /([A-Za-z_$][\w$.]*)\s*(?:\+=|-=)\s*[^=]/;
  const selfRef = /([A-Za-z_$][\w$.]*)\s*=\s*\1\s*[+-]\s*/;
  // SQL: `SET total = total + 1`
  const sqlSelfRef = /\bset\s+([\w".]+)\s*=\s*\1\s*[+-]/i;

  lines.forEach((text, index) => {
    if (text.includes("idempotent-ok")) return;
    if (compound.test(text) || selfRef.test(text) || sqlSelfRef.test(text)) {
      findings.push({ line: index + 1, text: text.trim() });
    }
  });

  return findings;
}
