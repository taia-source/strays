/**
 * The cursor, and the invariant the whole indexer rests on.
 *
 * THE INVARIANT: a range's rows and its cursor advance commit in ONE transaction. A crash
 * mid-range rolls back both, so the cursor can never point past unwritten data. That is
 * what makes "always resume from the cursor, never re-index from the start block" safe —
 * and it is the concrete reason this package exists rather than Ponder, whose `build_id`
 * forces a full re-index on any handler or schema change.
 *
 * Storage is injected rather than assumed. Postgres is the production target, but the
 * logic is pure, so crash-safety can be tested against an in-memory store by killing it
 * at an arbitrary point — no database required in unit tests.
 */

export type CursorState = {
  /** Highest block whose events are fully committed. */
  readonly block: bigint;
  /** Hash of `block`, for reorg detection. Null before anything is scanned. */
  readonly blockHash: `0x${string}` | null;
  /**
   * LOWEST block this database has actually scanned.
   *
   * `block` alone cannot express coverage: it only moves forward, so a database wiped
   * after the contracts were deployed resumes ABOVE them and can never go back. The gap
   * is invisible — every surface reports healthy while the data is silently incomplete.
   * Comparing this against the configured start block is what detects that hole.
   */
  readonly scannedFrom: bigint | null;
  /**
   * Fingerprint of the event decode surface that wrote this data.
   *
   * Adding an event does NOT retroactively index it — the cursor has already passed those
   * blocks, so history stays blind to it. Storing the surface makes the rewind automatic
   * instead of depending on someone remembering. This is the targeted alternative to
   * Ponder's all-or-nothing re-index.
   */
  readonly decodeFingerprint: string | null;
};

export const EMPTY_CURSOR: CursorState = {
  block: 0n,
  blockHash: null,
  scannedFrom: null,
  decodeFingerprint: null,
};

/** A committed range: the rows it produced, and where the cursor lands afterwards. */
export type RangeCommit<Row> = {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly toBlockHash: `0x${string}`;
  readonly rows: readonly Row[];
  readonly decodeFingerprint: string;
};

/**
 * Storage the cursor needs. Implement once for Postgres; the in-memory version exists so
 * the crash-safety property can be tested directly.
 */
export type CursorStore<Row> = {
  read(): Promise<CursorState>;
  /**
   * Persist rows AND the cursor atomically. MUST be a single transaction: if this can
   * partially apply, the invariant is broken and every guarantee above is void.
   */
  commit(commit: RangeCommit<Row>): Promise<void>;
  /** Delete rows above `blockNumber` and move the cursor back. Used after a reorg. */
  rollback(blockNumber: bigint, blockHash: `0x${string}` | null): Promise<void>;
  /** Move the cursor back without deleting, to re-scan for a widened decode surface. */
  rewind(toBlock: bigint, fingerprint: string): Promise<void>;
};

export type StartDecision =
  | { readonly kind: "resume"; readonly from: bigint }
  /** A hole below the cursor — rewind once, then scan forward normally. */
  | { readonly kind: "repair-gap"; readonly from: bigint; readonly reason: string }
  /** The decode surface widened; re-read history with the new decoders. */
  | { readonly kind: "rewind-decoders"; readonly from: bigint; readonly reason: string };

/**
 * Where the next scan should begin.
 *
 * Three cases, and the two non-obvious ones are the reason this is a function rather than
 * `cursor.block + 1`:
 *
 *   1. normal resume
 *   2. a hole beneath the cursor (wiped DB, changed start block) — a forward-only cursor
 *      can never fill it, so it must be rewound explicitly
 *   3. the decode surface changed — history is blind to the new events until re-read
 */
export function decideStart(
  cursor: CursorState,
  startBlock: bigint,
  fingerprint: string,
): StartDecision {
  if (cursor.scannedFrom === null || cursor.block === 0n) {
    return { kind: "resume", from: startBlock };
  }

  if (cursor.scannedFrom > startBlock) {
    return {
      kind: "repair-gap",
      from: startBlock,
      reason:
        `scanned_from ${cursor.scannedFrom} is above the configured start block ${startBlock} — ` +
        "blocks beneath the cursor were never read and a forward-only cursor cannot go back",
    };
  }

  if (cursor.decodeFingerprint !== null && cursor.decodeFingerprint !== fingerprint) {
    return {
      kind: "rewind-decoders",
      from: startBlock,
      reason:
        "the event decode surface changed since this data was written — " +
        "history was not indexed with the current decoders",
    };
  }

  return { kind: "resume", from: cursor.block + 1n };
}

/**
 * In-memory `CursorStore`, used to test the atomicity guarantee itself.
 *
 * `failAfterRows` simulates a crash PART-WAY through a commit. A correct implementation
 * leaves the store untouched; a broken one leaves rows without a cursor advance (gap on
 * restart) or a cursor advance without rows (silent data loss).
 */
export class MemoryCursorStore<Row> implements CursorStore<Row> {
  #cursor: CursorState = EMPTY_CURSOR;
  #rows: Array<{ block: bigint; row: Row }> = [];
  failAfterRows: number | undefined;

  async read(): Promise<CursorState> {
    return this.#cursor;
  }

  async commit(commit: RangeCommit<Row>): Promise<void> {
    // Stage everything, then swap — the in-memory analogue of a transaction.
    const staged = [...this.#rows];
    let written = 0;
    for (const row of commit.rows) {
      if (this.failAfterRows !== undefined && written >= this.failAfterRows) {
        throw new Error("simulated crash mid-commit");
      }
      staged.push({ block: commit.toBlock, row });
      written += 1;
    }

    this.#rows = staged;
    this.#cursor = {
      block: commit.toBlock,
      blockHash: commit.toBlockHash,
      scannedFrom:
        this.#cursor.scannedFrom === null
          ? commit.fromBlock
          : min(this.#cursor.scannedFrom, commit.fromBlock),
      decodeFingerprint: commit.decodeFingerprint,
    };
  }

  async rollback(blockNumber: bigint, blockHash: `0x${string}` | null): Promise<void> {
    this.#rows = this.#rows.filter((r) => r.block <= blockNumber);
    this.#cursor = { ...this.#cursor, block: blockNumber, blockHash };
  }

  async rewind(toBlock: bigint, fingerprint: string): Promise<void> {
    this.#cursor = { ...this.#cursor, block: toBlock, decodeFingerprint: fingerprint };
  }

  rows(): readonly Row[] {
    return this.#rows.map((r) => r.row);
  }
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
