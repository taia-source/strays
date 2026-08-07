/**
 * Idempotency tests — guarding the one failure mode with confirmed financial loss.
 */
import { describe, expect, it } from "vitest";
import {
  dedupe,
  type EventIdentity,
  eventKey,
  findDuplicates,
  findUnsafeIncrements,
} from "./idempotent.js";

const HASH_FORK_A = `0x${"a".repeat(64)}` as const;
const HASH_FORK_B = `0x${"b".repeat(64)}` as const;

const id = (hash: `0x${string}`, logIndex: number): EventIdentity => ({
  chainId: 4663,
  blockHash: hash,
  logIndex,
});

describe("eventKey", () => {
  /**
   * The reorg-safety property. Two forks produce the SAME block number with different
   * content — so a number-keyed identity collides across forks and a hash-keyed one
   * cannot. This is why the key is blockHash.
   */
  it("distinguishes the same log index on two competing forks", () => {
    expect(eventKey(id(HASH_FORK_A, 3))).not.toBe(eventKey(id(HASH_FORK_B, 3)));
  });

  it("is stable for the same event", () => {
    expect(eventKey(id(HASH_FORK_A, 3))).toBe(eventKey(id(HASH_FORK_A, 3)));
  });
});

describe("findDuplicates", () => {
  /**
   * ON CONFLICT only guards against ALREADY-COMMITTED rows. Duplicates inside one
   * statement still error — which is exactly what reorg recovery produces when it
   * re-fetches overlapping ranges.
   */
  it("finds a duplicate that would break a single INSERT", () => {
    expect(findDuplicates([id(HASH_FORK_A, 1), id(HASH_FORK_A, 1)])).toHaveLength(1);
  });

  it("passes a clean batch", () => {
    expect(findDuplicates([id(HASH_FORK_A, 1), id(HASH_FORK_A, 2)])).toEqual([]);
  });

  it("does not treat the same index on different forks as a duplicate", () => {
    expect(findDuplicates([id(HASH_FORK_A, 1), id(HASH_FORK_B, 1)])).toEqual([]);
  });
});

describe("dedupe", () => {
  it("keeps the first occurrence and preserves order", () => {
    const rows = [
      { identity: id(HASH_FORK_A, 1), value: "first" },
      { identity: id(HASH_FORK_A, 2), value: "second" },
      { identity: id(HASH_FORK_A, 1), value: "replay" },
    ];
    expect(dedupe(rows).map((r) => r.value)).toEqual(["first", "second"]);
  });
});

describe("findUnsafeIncrements", () => {
  /**
   * The exact bug from Ponder #1671: the detail row upserted correctly, but
   * `totalScaledSupply` was incremented directly and a reorg replay applied it 4×.
   */
  it("catches a compound increment", () => {
    const findings = findUnsafeIncrements("totals.scaledSupply += amount;");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(1);
  });

  it("catches a self-referential assignment", () => {
    expect(findUnsafeIncrements("total = total + amount;")).toHaveLength(1);
    expect(findUnsafeIncrements("state.burned = state.burned - amount;")).toHaveLength(1);
  });

  it("catches SQL that increments in place", () => {
    expect(
      findUnsafeIncrements("UPDATE token SET total_burned = total_burned + $1 WHERE id = $2"),
    ).toHaveLength(1);
  });

  it("allows deriving a value rather than incrementing it", () => {
    expect(findUnsafeIncrements("const total = sumBurns(rows);")).toEqual([]);
    expect(findUnsafeIncrements("total = base + amount;")).toEqual([]);
  });

  it("allows a reviewed exception", () => {
    expect(findUnsafeIncrements("counter += 1; // idempotent-ok: in-memory loop counter")).toEqual(
      [],
    );
  });

  it("reports the line number so the gate can point at it", () => {
    const source = ["const a = 1;", "", "supply += delta;"].join("\n");
    expect(findUnsafeIncrements(source)[0]?.line).toBe(3);
  });
});
