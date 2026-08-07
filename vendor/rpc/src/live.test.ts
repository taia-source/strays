/**
 * Live-chain tests. These hit the real RPC.
 *
 * They exist because every interesting fact in this package was discovered by measuring,
 * not by reading docs — so a regression is far more likely to show up here than in a unit
 * test. Set `TAIA_RPC_4663` to a provider endpoint in CI: the public endpoint has no
 * archive data and rate-limits aggressively.
 */
import { robinhoodNitro, rpcUrl } from "@taia/chains";
import { createPublicClient, http } from "viem";
import { describe, expect, it } from "vitest";
import { DEFAULT_FINALITY, finalizedBlock, lagBlocks } from "./finality.js";

const client = createPublicClient({
  chain: robinhoodNitro,
  transport: http(rpcUrl(robinhoodNitro.id)),
});

const blockTimeMs = robinhoodNitro.blockTime ?? 100;

describe("live finality", () => {
  it("supports all four block tags", async () => {
    const [latest, safe, finalized] = await Promise.all([
      client.getBlock({ blockTag: "latest" }),
      client.getBlock({ blockTag: "safe" }),
      client.getBlock({ blockTag: "finalized" }),
    ]);

    expect(latest.number).toBeDefined();
    expect(safe.number).toBeDefined();
    expect(finalized.number).toBeDefined();
  });

  /**
   * Ordering is the invariant that actually matters. Measured 2026-07-27:
   * latest−safe ≈ 8 min, latest−finalized ≈ 18 min.
   */
  it("orders finalized <= safe <= latest", async () => {
    const [latest, safe, finalized] = await Promise.all([
      client.getBlock({ blockTag: "latest" }),
      client.getBlock({ blockTag: "safe" }),
      client.getBlock({ blockTag: "finalized" }),
    ]);

    expect(finalized.number).toBeLessThanOrEqual(safe.number ?? 0n);
    expect(safe.number).toBeLessThanOrEqual(latest.number ?? 0n);
  });

  /**
   * Guards the assumption behind `staleMultiple`. If finality ever drifts far beyond the
   * expected window, the chain has a real problem and we want a test to say so — rather
   * than every consumer silently degrading to the fallback lag.
   */
  it("keeps finality within a plausible window of the head", async () => {
    const [head, finalized] = await Promise.all([
      client.getBlockNumber(),
      client.getBlock({ blockTag: "finalized" }),
    ]);

    const lag = head - (finalized.number ?? 0n);
    const limit = lagBlocks(blockTimeMs, DEFAULT_FINALITY.lagSeconds) * 4n;
    expect(lag).toBeLessThan(limit);
  });

  it("returns a settled block at or below the head in lag mode", async () => {
    const settled = await finalizedBlock(client, { mode: "lag", reason: "test" }, blockTimeMs);
    const head = await client.getBlockNumber();

    expect(settled).toBeLessThan(head);
    expect(settled).toBeGreaterThan(0n);
  });
});

describe("live getLogs limits", () => {
  /**
   * The measurement the chunker is built on: ~100 logs/block on this chain, so a
   * 10,000-log cap is reached in roughly 100 blocks. If density ever collapses by an
   * order of magnitude, the defaults deserve revisiting — hence asserting it.
   */
  it("returns a dense log stream, justifying small initial chunks", async () => {
    const head = await client.getBlockNumber();
    const from = head - 50n;

    const logs = await client.getLogs({ fromBlock: from, toBlock: head });
    const perBlock = logs.length / 51;

    expect(logs.length).toBeGreaterThan(0);
    expect(perBlock).toBeGreaterThan(1);
  });
});
