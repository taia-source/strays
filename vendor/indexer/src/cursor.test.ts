/**
 * Cursor tests — the transactional invariant, asserted rather than assumed.
 *
 * If a commit can partially apply, every guarantee this package makes is void: a crash
 * leaves either a gap (rows missing, cursor advanced past them) or double-counting (rows
 * written, cursor not advanced, range re-scanned non-idempotently).
 */
import { describe, expect, it } from "vitest";
import { decideStart, EMPTY_CURSOR, MemoryCursorStore } from "./cursor.js";

const HASH_A = `0x${"a".repeat(64)}` as const;
const HASH_B = `0x${"b".repeat(64)}` as const;

describe("decideStart", () => {
  it("starts at the configured block on a fresh database", () => {
    const d = decideStart(EMPTY_CURSOR, 100n, "fp");
    expect(d).toEqual({ kind: "resume", from: 100n });
  });

  it("resumes from the block after the cursor in the normal case", () => {
    const d = decideStart(
      { block: 500n, blockHash: HASH_A, scannedFrom: 100n, decodeFingerprint: "fp" },
      100n,
      "fp",
    );
    expect(d).toEqual({ kind: "resume", from: 501n });
  });

  /**
   * The wiped-database trap. The cursor resumes above the contracts, the gap beneath is
   * invisible, and every health check reports green while the data is incomplete.
   */
  it("detects a hole beneath the cursor that forward-only scanning cannot fill", () => {
    const d = decideStart(
      { block: 900n, blockHash: HASH_A, scannedFrom: 800n, decodeFingerprint: "fp" },
      100n,
      "fp",
    );
    expect(d.kind).toBe("repair-gap");
    if (d.kind !== "repair-gap") return;
    expect(d.from).toBe(100n);
    expect(d.reason).toMatch(/never read|cannot go back/);
  });

  /** Adding an event does not retroactively index it — history must be re-read. */
  it("rewinds when the decode surface changed", () => {
    const d = decideStart(
      { block: 900n, blockHash: HASH_A, scannedFrom: 100n, decodeFingerprint: "old" },
      100n,
      "new",
    );
    expect(d.kind).toBe("rewind-decoders");
    if (d.kind !== "rewind-decoders") return;
    expect(d.from).toBe(100n);
  });

  it("prioritises repairing a gap over a decoder rewind", () => {
    // Both conditions hold; the gap is the more serious one and must win.
    const d = decideStart(
      { block: 900n, blockHash: HASH_A, scannedFrom: 800n, decodeFingerprint: "old" },
      100n,
      "new",
    );
    expect(d.kind).toBe("repair-gap");
  });
});

describe("MemoryCursorStore — the atomicity invariant", () => {
  it("advances the cursor and writes rows together", async () => {
    const store = new MemoryCursorStore<string>();
    await store.commit({
      fromBlock: 10n,
      toBlock: 20n,
      toBlockHash: HASH_A,
      rows: ["a", "b"],
      decodeFingerprint: "fp",
    });

    const cursor = await store.read();
    expect(cursor.block).toBe(20n);
    expect(cursor.blockHash).toBe(HASH_A);
    expect(cursor.scannedFrom).toBe(10n);
    expect(store.rows()).toEqual(["a", "b"]);
  });

  /**
   * THE test. A crash part-way through a commit must leave the store completely
   * untouched — no rows, no cursor movement. Anything else is a gap or a double-count.
   */
  it("leaves nothing behind when a commit crashes part-way", async () => {
    const store = new MemoryCursorStore<string>();
    store.failAfterRows = 2;

    await expect(
      store.commit({
        fromBlock: 10n,
        toBlock: 20n,
        toBlockHash: HASH_A,
        rows: ["a", "b", "c", "d"],
        decodeFingerprint: "fp",
      }),
    ).rejects.toThrow(/simulated crash/);

    const cursor = await store.read();
    expect(cursor.block, "cursor must not advance past unwritten data").toBe(0n);
    expect(store.rows(), "no rows may survive a failed commit").toEqual([]);
  });

  it("can resume cleanly after a failed commit", async () => {
    const store = new MemoryCursorStore<string>();
    store.failAfterRows = 1;
    await store
      .commit({
        fromBlock: 10n,
        toBlock: 20n,
        toBlockHash: HASH_A,
        rows: ["a", "b"],
        decodeFingerprint: "fp",
      })
      .catch(() => undefined);

    store.failAfterRows = undefined;
    await store.commit({
      fromBlock: 10n,
      toBlock: 20n,
      toBlockHash: HASH_A,
      rows: ["a", "b"],
      decodeFingerprint: "fp",
    });

    expect(store.rows()).toEqual(["a", "b"]);
    expect((await store.read()).block).toBe(20n);
  });

  it("tracks the lowest block ever scanned, not the most recent range", async () => {
    const store = new MemoryCursorStore<string>();
    await store.commit({
      fromBlock: 500n,
      toBlock: 600n,
      toBlockHash: HASH_A,
      rows: [],
      decodeFingerprint: "fp",
    });
    await store.commit({
      fromBlock: 100n,
      toBlock: 200n,
      toBlockHash: HASH_B,
      rows: [],
      decodeFingerprint: "fp",
    });
    expect((await store.read()).scannedFrom).toBe(100n);
  });

  /** A reorg removes events. Upserting cannot express deletion — rows must go. */
  it("deletes orphaned rows on rollback", async () => {
    const store = new MemoryCursorStore<string>();
    await store.commit({
      fromBlock: 1n,
      toBlock: 10n,
      toBlockHash: HASH_A,
      rows: ["keep"],
      decodeFingerprint: "fp",
    });
    await store.commit({
      fromBlock: 11n,
      toBlock: 20n,
      toBlockHash: HASH_B,
      rows: ["orphan"],
      decodeFingerprint: "fp",
    });

    await store.rollback(10n, HASH_A);

    expect(store.rows()).toEqual(["keep"]);
    expect((await store.read()).block).toBe(10n);
  });

  it("rewinds without deleting, for a widened decode surface", async () => {
    const store = new MemoryCursorStore<string>();
    await store.commit({
      fromBlock: 1n,
      toBlock: 50n,
      toBlockHash: HASH_A,
      rows: ["row"],
      decodeFingerprint: "old",
    });

    await store.rewind(0n, "new");

    const cursor = await store.read();
    expect(cursor.block).toBe(0n);
    expect(cursor.decodeFingerprint).toBe("new");
    // Existing rows survive; re-scanning upserts over them.
    expect(store.rows()).toEqual(["row"]);
  });
});
