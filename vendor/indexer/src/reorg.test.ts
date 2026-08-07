/**
 * Reorg tests.
 *
 * Unit tests drive a synthetic chain so a reorg can actually be *caused* — you cannot
 * wait for one on a centralized sequencer. The live tests then confirm the primitives the
 * detector depends on really exist on the target chain.
 */
import { robinhoodNitro, rpcUrl } from "@taia/chains";
import { createTaiaClient } from "@taia/rpc";
import { describe, expect, it } from "vitest";
import { type BlockRef, BlockWindow, detectReorg, readBlockRef } from "./reorg.js";

const h = (n: number, fork = "a") =>
  `0x${fork.repeat(1)}${n.toString(16).padStart(63, "0")}` as `0x${string}`;

/** A synthetic chain that can be forked at will. */
function chain(length: number, fork = "a"): BlockRef[] {
  return Array.from({ length }, (_, i) => ({
    number: BigInt(i),
    hash: h(i, fork),
    parentHash: i === 0 ? h(0, fork) : h(i - 1, fork),
  }));
}

/** Client stub serving a given chain by block number. */
function stubClient(blocks: BlockRef[]) {
  return {
    uid: `reorg-${Math.random()}`,
    cacheTime: 0,
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method !== "eth_getBlockByNumber") throw new Error(`unexpected ${method}`);
      const raw = (params?.[0] ?? "0x0") as string;
      const n = BigInt(raw);
      const block = blocks.find((b) => b.number === n);
      if (!block) throw new Error(`no block ${n}`);
      return {
        number: `0x${block.number.toString(16)}`,
        hash: block.hash,
        parentHash: block.parentHash,
        transactions: [],
      };
    },
  } as never;
}

describe("BlockWindow", () => {
  it("rejects a nonsensical capacity", () => {
    expect(() => new BlockWindow(0)).toThrow();
    expect(() => new BlockWindow(-1)).toThrow();
  });

  it("keeps only the most recent blocks", () => {
    const w = new BlockWindow(3);
    for (const b of chain(10)) w.push(b);
    expect(w.size).toBe(3);
    expect(w.tip?.number).toBe(9n);
    expect(w.find(0n)).toBeUndefined();
  });

  /**
   * A window that stores an inconsistent chain cannot detect a reorg later — it would be
   * comparing against ancestry that never existed.
   */
  it("refuses a block that does not descend from the tip", () => {
    const w = new BlockWindow(5);
    w.push({ number: 1n, hash: h(1), parentHash: h(0) });
    expect(() => w.push({ number: 2n, hash: h(2), parentHash: h(99) })).toThrow(/does not descend/);
  });

  it("drops everything above a rollback point", () => {
    const w = new BlockWindow(10);
    for (const b of chain(6)) w.push(b);
    w.rollbackTo(3n);
    expect(w.tip?.number).toBe(3n);
    expect(w.find(4n)).toBeUndefined();
  });
});

describe("detectReorg", () => {
  it("reports ok on an empty window", async () => {
    const result = await detectReorg(stubClient(chain(5)), new BlockWindow(5));
    expect(result.kind).toBe("ok");
  });

  it("reports ok when the stored chain still matches", async () => {
    const blocks = chain(10);
    const w = new BlockWindow(5);
    for (const b of blocks.slice(5)) w.push(b);
    const result = await detectReorg(stubClient(blocks), w);
    expect(result.kind).toBe("ok");
  });

  /**
   * The case that matters. Blocks 8-9 were re-mined on a different fork, so rows written
   * for them are orphaned. Upserting cannot fix this — a reorg can REMOVE events, and an
   * upsert has no way to express deletion. The indexer must delete above the ancestor.
   */
  it("finds the common ancestor after a shallow reorg", async () => {
    const original = chain(10, "a");
    const w = new BlockWindow(5);
    for (const b of original.slice(5)) w.push(b);

    // Chain re-mined from block 8 onwards.
    const reorged = original.map((b) =>
      b.number >= 8n
        ? {
            ...b,
            hash: h(Number(b.number), "b"),
            parentHash: b.number === 8n ? h(7, "a") : h(Number(b.number) - 1, "b"),
          }
        : b,
    );

    const result = await detectReorg(stubClient(reorged), w);
    expect(result.kind).toBe("reorg");
    if (result.kind !== "reorg") return;
    expect(result.commonAncestor).toBe(7n);
    expect(result.depth).toBe(2);
  });

  /**
   * A reorg deeper than the tracked window. We cannot locate an ancestor, so we do not
   * know how far the damage goes — this must be loud, not silently truncated.
   */
  it("reports beyond-window when nothing in the window is canonical", async () => {
    const w = new BlockWindow(3);
    for (const b of chain(10, "a").slice(7)) w.push(b);

    const different = chain(10, "c");
    const result = await detectReorg(stubClient(different), w);
    expect(result.kind).toBe("beyond-window");
    if (result.kind !== "beyond-window") return;
    expect(result.checked).toBe(3);
  });
});

describe("live chain — the primitives detection depends on", () => {
  const client = createTaiaClient({
    chain: robinhoodNitro,
    urls: [rpcUrl(robinhoodNitro.id)],
    limits: { expensive: 1, cheap: 4 },
  });

  it("exposes hash and parentHash, and the chain links correctly", async () => {
    const head = await client.getBlockNumber();
    const [tip, parent] = await Promise.all([
      readBlockRef(client, head - 1n),
      readBlockRef(client, head - 2n),
    ]);

    expect(tip.hash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(tip.parentHash).toBe(parent.hash);
  });

  /**
   * Measured 2026-07-27: hashes at 1, 5, 20, 100 and 200 blocks behind the tip were all
   * stable across 45s while the head advanced 458 blocks — expected for a centralized
   * sequencer. This asserts the window builds cleanly; it does NOT assert reorgs are
   * impossible, which is why detection stays in.
   */
  it("builds a consistent window from live blocks", async () => {
    const head = await client.getBlockNumber();
    const window = new BlockWindow(5);
    for (let i = 4n; i >= 0n; i -= 1n) {
      window.push(await readBlockRef(client, head - i - 1n));
    }
    expect(window.size).toBe(5);
    const check = await detectReorg(client, window);
    expect(check.kind).toBe("ok");
  });
});
