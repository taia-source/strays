/**
 * Finality tests. Pure logic here; the live-chain behaviour is asserted in `live.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FINALITY,
  type FinalityProbe,
  finalizedBlock,
  lagBlocks,
  probeFinality,
} from "./finality.js";

/**
 * Stub at the JSON-RPC boundary, not at the action level.
 *
 * `viem/actions` calls `client.request({method})` — mocking `getBlock`/`getBlockNumber`
 * directly would test a shape the code never uses. Mocking `request` exercises viem's
 * real formatting path, so these tests break if the transport contract changes.
 */
let uid = 0;

function stubClient(opts: { head: bigint; tags?: Array<bigint | Error> }): {
  client: never;
  calls: () => number;
} {
  let i = 0;
  const toHex = (v: bigint) => `0x${v.toString(16)}`;
  const client = {
    // `getBlockNumber` memoises on `client.uid` (cache key `blockNumber.<uid>`) for
    // `cacheTime` ms. Without a unique uid every stub shares the key
    // `blockNumber.undefined`, and one test's head leaks into the next — which looks
    // exactly like a logic bug and is not one. `cacheTime: 0` disables it outright.
    uid: `stub-${uid++}`,
    cacheTime: 0,
    request: async ({ method }: { method: string }) => {
      if (method === "eth_blockNumber") return toHex(opts.head);
      if (method === "eth_getBlockByNumber") {
        const next = opts.tags?.[i++];
        if (next === undefined) throw new Error("safe block not found");
        if (next instanceof Error) throw next;
        return { number: toHex(next), transactions: [] };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { client: client as never, calls: () => i };
}

describe("lagBlocks", () => {
  /**
   * The reason the lag is in seconds. 900s is 9,000 blocks at 100ms but only 3,600 at
   * 250ms — copying a raw block count between chains silently changes the safety margin.
   */
  it("converts seconds to blocks using the chain's block time", () => {
    expect(lagBlocks(100, 900)).toBe(9_000n);
    expect(lagBlocks(250, 900)).toBe(3_600n);
    expect(lagBlocks(12_000, 900)).toBe(75n);
  });

  it("never returns less than one block", () => {
    expect(lagBlocks(60_000, 1)).toBe(1n);
  });

  it("rejects a non-positive block time rather than dividing by zero", () => {
    expect(() => lagBlocks(0, 900)).toThrow();
  });
});

describe("probeFinality", () => {
  it("skips probing entirely when configured to use a lag", async () => {
    const { client, calls } = stubClient({ head: 1_000n });
    const probe = await probeFinality(client, 100, { ...DEFAULT_FINALITY, prefer: "lag" });
    expect(probe.mode).toBe("lag");
    expect(calls()).toBe(0);
  });

  it("falls back when the tag is unsupported", async () => {
    const { client } = stubClient({ head: 1_000n, tags: [new Error("safe block not found")] });
    const probe = await probeFinality(client, 100, DEFAULT_FINALITY);
    expect(probe.mode).toBe("lag");
    expect(probe.reason).toContain("unsupported");
  });

  /** The cheap single-shot check: absurdly stale means stale, no need to wait a batch. */
  it("detects a badly stale tag in one round trip", async () => {
    const { client } = stubClient({ head: 10_000_000n, tags: [1n] });
    const probe = await probeFinality(client, 100, DEFAULT_FINALITY);
    expect(probe.mode).toBe("lag");
    expect(probe.reason).toContain("stale");
  });

  /**
   * The Orbit failure mode: tag responds, is within a plausible window, but never moves.
   * Real chains have shipped in this state.
   */
  it("falls back when the tag responds but does not advance", async () => {
    vi.useFakeTimers();
    const { client } = stubClient({ head: 100_000n, tags: [95_000n, 95_000n] });
    const promise = probeFinality(client, 100, { ...DEFAULT_FINALITY, probeIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(20);
    const probe = await promise;
    vi.useRealTimers();
    expect(probe.mode).toBe("lag");
    expect(probe.reason).toContain("frozen");
  });

  it("trusts the tag when it advances between samples", async () => {
    vi.useFakeTimers();
    const { client } = stubClient({ head: 100_000n, tags: [95_000n, 95_500n] });
    const promise = probeFinality(client, 100, { ...DEFAULT_FINALITY, probeIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(20);
    const probe = await promise;
    vi.useRealTimers();
    expect(probe.mode).toBe("finalized");
    expect(probe.reason).toContain("advanced");
  });
});

describe("finalizedBlock", () => {
  it("reads the tag directly when the probe trusted it", async () => {
    const { client } = stubClient({ head: 100_000n, tags: [95_000n] });
    const probe: FinalityProbe = { mode: "finalized", reason: "ok" };
    expect(await finalizedBlock(client, probe, 100)).toBe(95_000n);
  });

  it("subtracts the time-based lag in fallback mode", async () => {
    const { client } = stubClient({ head: 100_000n });
    const probe: FinalityProbe = { mode: "lag", reason: "frozen" };
    // 900s at 100ms = 9,000 blocks.
    expect(await finalizedBlock(client, probe, 100)).toBe(91_000n);
  });

  it("clamps to zero on a chain younger than the lag", async () => {
    const { client } = stubClient({ head: 10n });
    const probe: FinalityProbe = { mode: "lag", reason: "frozen" };
    expect(await finalizedBlock(client, probe, 100)).toBe(0n);
  });
});
