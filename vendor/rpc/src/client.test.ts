/**
 * Client factory tests, including a LIVE end-to-end chunked `getLogs`.
 *
 * The live case is the one that matters: a span that provably fails as a single request
 * must succeed when chunked, and must return the same logs a manual sweep returns. Unit
 * tests cannot prove that — only the real endpoint can.
 */
import { robinhoodNitro, rpcUrl } from "@taia/chains";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHUNK } from "./chunk.js";
import { createTaiaClient, getLogsChunked } from "./client.js";

/** The public endpoint meters cumulative compute; pace sweeps so tests are not flaky. */
const PAUSE_MS = 400;

const url = rpcUrl(robinhoodNitro.id);

function client(limits = { expensive: 1, cheap: 8 }) {
  return createTaiaClient({ chain: robinhoodNitro, urls: [url], limits });
}

describe("createTaiaClient", () => {
  it("refuses to build without an endpoint", () => {
    expect(() => createTaiaClient({ chain: robinhoodNitro, urls: [] })).toThrow();
  });

  it("exposes the limiter for metrics", () => {
    expect(client().limiter.stats()).toEqual({ expensive: 0, cheap: 0 });
  });

  it("works with a single endpoint and with several", async () => {
    const single = createTaiaClient({ chain: robinhoodNitro, urls: [url] });
    const multi = createTaiaClient({ chain: robinhoodNitro, urls: [url, url] });
    const [a, b] = await Promise.all([single.getChainId(), multi.getChainId()]);
    expect(a).toBe(robinhoodNitro.id);
    expect(b).toBe(robinhoodNitro.id);
  });
});

describe("getLogsChunked", () => {
  it("rejects an inverted range instead of looping", async () => {
    await expect(getLogsChunked(client(), { fromBlock: 100n, toBlock: 50n })).rejects.toThrow(
      /below fromBlock/,
    );
  });

  /**
   * THE LOAD-BEARING TEST — chunking must beat a single request.
   *
   * Deliberately NOT asserting that the unchunked query fails. Measured twice on 4663,
   * hours apart: density moved from ~100 to ~45 logs/block, and a 1,000-block query
   * returning 49,159 logs SUCCEEDED despite the endpoint advertising a 10,000-log cap.
   * The cap is enforced under load, not deterministically — so "the plain query fails"
   * is a flaky premise and asserting it would make this test lie on a quiet day.
   *
   * What IS invariant: chunking retrieves the whole span, splits it into several
   * requests, and converges on a range driven by observed density rather than the span
   * it was handed.
   */
  it("retrieves a large span by splitting it into density-sized requests", {
    timeout: 120_000,
  }, async () => {
    const c = client();
    const head = await c.getBlockNumber();
    // Must exceed DEFAULT_CHUNK.initialBlocks (500) or the whole span fits in one
    // request and there is nothing to prove.
    const from = head - 2_000n;

    const result = await getLogsChunked(
      c,
      { fromBlock: from, toBlock: head },
      DEFAULT_CHUNK,
      PAUSE_MS,
    );

    expect(result.logs.length).toBeGreaterThan(10_000);
    // More than one request: the span cannot be served in a single call.
    expect(result.requests).toBeGreaterThan(1);

    /**
     * ══ Asserting the invariant, not a direction ══
     *
     * This previously asserted `finalChunk < initialBlocks`, which made the gate FLAKY:
     * it passed on an idle machine and failed under concurrent load with
     * `expected 625 to be less than 500`.
     *
     * The assertion was wrong in principle, not merely fragile. The chunker adapts to
     * observed density in BOTH directions — on a sparse stretch it correctly grows the
     * chunk past the initial guess. Measured on chain 4663 while fixing this: ~18.8 logs
     * per block over 2,000 blocks, dense enough that the direction depends on where the
     * head happens to be.
     *
     * What is actually invariant: the chunk moved off the initial guess (density was
     * consulted) and stayed inside the configured bounds.
     */
    expect(
      result.finalChunk,
      "the chunk never moved off its initial guess, so density was never consulted",
    ).not.toBe(DEFAULT_CHUNK.initialBlocks);
    expect(result.finalChunk).toBeGreaterThan(0);
    expect(result.finalChunk, "the chunk grew past the configured ceiling").toBeLessThanOrEqual(
      DEFAULT_CHUNK.maxBlocks,
    );
  });

  /** Chunking must not drop or duplicate logs at the seams between requests. */
  it("returns the same logs as an equivalent manual sweep", { timeout: 120_000 }, async () => {
    const c = client();
    const head = await c.getBlockNumber();
    const from = head - 40n;

    const chunked = await getLogsChunked(
      c,
      { fromBlock: from, toBlock: head },
      DEFAULT_CHUNK,
      PAUSE_MS,
    );

    const manual: unknown[] = [];
    for (let start = from; start <= head; start += 10n) {
      const stop = start + 9n > head ? head : start + 9n;
      manual.push(...(await c.getLogs({ fromBlock: start, toBlock: stop })));
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }

    expect(chunked.logs.length).toBe(manual.length);
  });

  it("handles a single-block range in one request", async () => {
    const c = client();
    const head = await c.getBlockNumber();
    const result = await getLogsChunked(c, { fromBlock: head - 1n, toBlock: head - 1n });
    expect(result.requests).toBe(1);
  });
});
