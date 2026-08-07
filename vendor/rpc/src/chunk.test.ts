/**
 * Chunker unit tests — pure, no network.
 *
 * The failure modes here are the ones that produce infinite loops or silent stalls in
 * production, so they are tested explicitly rather than inferred from a live run.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHUNK, initialChunk, onFailure, onSuccess } from "./chunk.js";

/** Shapes the real errors observed on chain 4663, 2026-07-27. */
const countLimitError = {
  code: -32000,
  message: "logs matched by query exceeds limit of 10000",
};
const rateLimitError = { code: 429, message: "Too Many Requests" };

describe("initialChunk", () => {
  it("starts at the configured size", () => {
    expect(initialChunk().blocks).toBe(DEFAULT_CHUNK.initialBlocks);
    expect(initialChunk().pinned).toBeUndefined();
  });

  it("never starts above the hard max", () => {
    const state = initialChunk({ ...DEFAULT_CHUNK, initialBlocks: 1_000_000n, maxBlocks: 500n });
    expect(state.blocks).toBe(500n);
  });
});

describe("onSuccess — density targeting", () => {
  /**
   * The measured case: ~100 logs/block on 4663. Targeting 5,000 logs should land near
   * 50 blocks, NOT creep upward by 5% from wherever it happened to be.
   */
  it("converges toward the target log count in one step", () => {
    const next = onSuccess(initialChunk(), 500n, 50_000);
    expect(next.blocks).toBe(50n);
  });

  it("grows into a sparse region instead of crawling", () => {
    const state = { blocks: 100n, pinned: undefined };
    const next = onSuccess(state, 100n, 100); // 1 log/block — very sparse
    // Target 5000 logs at 1 log/block = 5000 blocks, capped at 10x growth = 1000.
    expect(next.blocks).toBe(1_000n);
  });

  it("grows by the cap when a range returned no logs at all", () => {
    const next = onSuccess({ blocks: 100n, pinned: undefined }, 100n, 0);
    expect(next.blocks).toBe(1_000n);
  });

  it("never exceeds maxBlocks", () => {
    const next = onSuccess({ blocks: 40_000n, pinned: undefined }, 40_000n, 0);
    expect(next.blocks).toBe(DEFAULT_CHUNK.maxBlocks);
  });

  /** A provider-declared cap is a real limit, not a density artifact. Do not grow past it. */
  it("refuses to grow once a range has been pinned", () => {
    const pinned = { blocks: 1_000n, pinned: 1_000n };
    expect(onSuccess(pinned, 1_000n, 0).blocks).toBe(1_000n);
  });
});

describe("onFailure — classification", () => {
  it("shrinks on a real range/size error", () => {
    const result = onFailure({ blocks: 10_000n, pinned: undefined }, 0n, 9_999n, countLimitError);
    expect(result.kind).toBe("retry");
    if (result.kind !== "retry") return;
    expect(result.state.blocks).toBeLessThan(10_000n);
  });

  /**
   * The distinction that matters most. A 429 is not a size complaint — shrinking toward
   * 1 block raises the request count and makes rate limiting worse, not better.
   * viem already retries 429 with backoff internally.
   */
  it("does NOT treat a rate limit as a range problem", () => {
    const result = onFailure({ blocks: 1_000n, pinned: undefined }, 0n, 999n, rateLimitError);
    expect(result.kind).toBe("unrelated");
  });

  it("reports a single unsplittable block rather than looping forever", () => {
    const result = onFailure({ blocks: 1n, pinned: undefined }, 500n, 500n, countLimitError);
    expect(result.kind).toBe("unsplittable");
  });

  it("ignores errors that are not about ranges", () => {
    const result = onFailure(
      { blocks: 1_000n, pinned: undefined },
      0n,
      999n,
      new Error("unauthorized: invalid api key"),
    );
    expect(result.kind).toBe("unrelated");
  });
});

describe("onFailure — the ambiguous shouldRetry:false case", () => {
  /**
   * Regression: an early fix mapped every `shouldRetry: false` on a single-block range
   * to "unsplittable". That is wrong for a rate limit, which is not a range problem at
   * any size. The classifier must look at the error, not only the range width.
   */
  it("still reports a rate limit as unrelated even on a single block", () => {
    const result = onFailure({ blocks: 1n, pinned: undefined }, 500n, 500n, rateLimitError);
    expect(result.kind).toBe("unrelated");
  });

  it("reports a single-block size error as unsplittable", () => {
    const result = onFailure({ blocks: 1n, pinned: undefined }, 500n, 500n, countLimitError);
    expect(result.kind).toBe("unsplittable");
  });
});

describe("onFailure — the infinite-loop guard", () => {
  /**
   * If the helper ever hands back exactly the range it was given, naive retrying spins
   * forever. Ponder carries this same guard. Exercised here with a provider-suggested
   * range that matches the input, which is the shape that triggers it.
   */
  const echoRangeError = {
    code: -32602,
    message: "query returned more than 10000 results. Try with this block range [0x0, 0x1].",
  };

  it("does not return the same range it was handed", () => {
    const result = onFailure({ blocks: 2n, pinned: undefined }, 0n, 1n, echoRangeError);
    if (result.kind === "retry") {
      const same = result.state.blocks === 2n && result.state.pinned === undefined;
      expect(same).toBe(false);
    } else {
      expect(["unsplittable", "unrelated"]).toContain(result.kind);
    }
  });

  it("pins a provider-suggested range so growth stops", () => {
    const suggested = {
      code: -32602,
      message: "query returned more than 10000 results. Try with this block range [0x0, 0x63].",
    };
    const result = onFailure({ blocks: 10_000n, pinned: undefined }, 0n, 9_999n, suggested);
    expect(result.kind).toBe("retry");
    if (result.kind !== "retry") return;
    expect(result.state.pinned).toBeDefined();
    // Pinned state must survive a subsequent success without growing.
    const grown = onSuccess(result.state, result.state.blocks, 0);
    expect(grown.blocks).toBe(result.state.blocks);
  });
});

describe("onFailure — viem's client-side response-size guard", () => {
  /**
   * Found by a live 2,000-block sweep, not by unit tests: viem throws
   * `ResponseBodyTooLargeError` at 10 MiB before any provider error exists. It is a range
   * signal — @ponder/utils cannot classify it, because it is not a provider error at all.
   * Seen on 4663: a 500-block range returned 10,502,144 bytes against a 10,485,760 cap.
   */
  const tooLarge = Object.assign(new Error("Response body is too large. Max: 10485760 bytes"), {
    name: "ResponseBodyTooLargeError",
  });

  it("halves the range instead of giving up", () => {
    const result = onFailure({ blocks: 500n, pinned: undefined }, 0n, 499n, tooLarge);
    expect(result.kind).toBe("retry");
    if (result.kind !== "retry") return;
    expect(result.state.blocks).toBe(250n);
  });

  it("reports unsplittable when a single block is already too large", () => {
    const result = onFailure({ blocks: 1n, pinned: undefined }, 7n, 7n, tooLarge);
    expect(result.kind).toBe("unsplittable");
  });
});
