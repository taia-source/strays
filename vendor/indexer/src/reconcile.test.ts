/**
 * Reconciliation tests, including a LIVE cross-check of the node's log index.
 */
import { robinhoodNitro, rpcUrl } from "@taia/chains";
import { createTaiaClient } from "@taia/rpc";
import { describe, expect, it } from "vitest";
import { checkEventCounts, reconcileBlock, reconcileRange } from "./reconcile.js";

const client = createTaiaClient({
  chain: robinhoodNitro,
  urls: [rpcUrl(robinhoodNitro.id)],
  limits: { expensive: 1, cheap: 4 },
});

describe("checkEventCounts", () => {
  it("passes when every expected event produced rows", () => {
    expect(checkEventCounts({ counts: { Transfer: 12, Sold: 3 } }).ok).toBe(true);
  });

  /**
   * A silent zero is the signature of a handler wired to the wrong signature. Nothing
   * errors; the table is simply always empty.
   */
  it("flags an event that never produced a single row", () => {
    const result = checkEventCounts({ counts: { Transfer: 12, MarketMakerDeployed: 0 } });
    expect(result.ok).toBe(false);
    expect(result.silent).toEqual(["MarketMakerDeployed"]);
  });

  it("allows a zero that was explicitly justified", () => {
    const result = checkEventCounts({
      counts: { Transfer: 12, Paused: 0 },
      allowedZero: { Paused: "never fired in production; operator action only" },
    });
    expect(result.ok).toBe(true);
  });
});

describe("reconcileRange", () => {
  it("reports missing rows when the indexer stored fewer than the chain emitted", async () => {
    const report = await reconcileRange({
      client,
      fromBlock: 1n,
      toBlock: 1n,
      countIndexed: async () => 0,
    });
    expect(report.missing).toBe(report.onChain);
    expect(report.extra).toBe(0);
  });

  /** Extra rows mean duplicates, or rows orphaned by a reorg that were never deleted. */
  it("reports extra rows, which an upsert-only strategy cannot fix", async () => {
    const report = await reconcileRange({
      client,
      fromBlock: 1n,
      toBlock: 1n,
      countIndexed: async () => 99_999,
    });
    expect(report.extra).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });
});

describe("live — the node's log index tells the truth", () => {
  /**
   * `eth_getLogs` can silently return fewer logs than a block contains: on Polygon a block
   * returned 848 via getLogs against 856 real logs, because state-sync logs are absent
   * from `logsBloom`. Receipts come from execution, not the bloom index, so they are the
   * independent check.
   *
   * Clean on 4663 as of 2026-07-27 (121/121, 25/25, 47/47) — asserted, not assumed,
   * because it is a property of the node and can regress.
   */
  it("getLogs agrees with the sum of receipts", { timeout: 120_000 }, async () => {
    const head = await client.getBlockNumber();

    for (let offset = 3n; offset <= 5n; offset += 1n) {
      // Pace against the public RPC. Measured: it meters cumulative compute, so a
      // sequential sweep throttles even at low concurrency — and a gate that fails
      // randomly is a gate people learn to ignore.
      if (offset > 3n) await new Promise((r) => setTimeout(r, 2_000));
      const result = await reconcileBlock(client, head - offset);
      expect(
        result.ok,
        `block ${result.blockNumber}: getLogs=${result.viaGetLogs} receipts=${result.viaReceipts}`,
      ).toBe(true);
      expect(result.missingFromLogIndex).toBe(0);
    }
  });
});
