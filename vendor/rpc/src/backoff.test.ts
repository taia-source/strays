/**
 * Rate-limit backoff tests for the chunked sweep.
 *
 * Found by a live 2,000-block sweep: the 4663 public RPC sustains a 20-way burst of
 * `getLogs` yet still throttles a long SEQUENTIAL sweep — it meters cumulative compute
 * over a window, not instantaneous parallelism. Shrinking the range on a 429 would raise
 * the request count and make it worse, so the sweep backs off in time and keeps the range.
 */
import { describe, expect, it, vi } from "vitest";
import { isResponseTooLarge } from "./chunk.js";
import { getLogsChunked, isRateLimited } from "./client.js";

describe("isRateLimited", () => {
  it("recognises the shapes providers actually return", () => {
    expect(isRateLimited(new Error("HTTP request failed. Details: Too Many Requests"))).toBe(true);
    expect(isRateLimited({ code: 429, message: "Too Many Requests" })).toBe(true);
    expect(isRateLimited(new Error("rate limit exceeded"))).toBe(true);
    expect(isRateLimited({ code: -32005, message: "limit exceeded" })).toBe(true);
  });

  it("does not mistake other failures for throttling", () => {
    expect(isRateLimited(new Error("unauthorized: invalid api key"))).toBe(false);
    expect(isRateLimited(new Error("execution reverted"))).toBe(false);
  });
});

describe("isResponseTooLarge", () => {
  it("matches viem's client-side guard by name and by message", () => {
    expect(
      isResponseTooLarge(Object.assign(new Error("x"), { name: "ResponseBodyTooLargeError" })),
    ).toBe(true);
    expect(isResponseTooLarge(new Error("Response body is too large. Max: 10485760 bytes"))).toBe(
      true,
    );
  });

  it("ignores unrelated errors", () => {
    expect(isResponseTooLarge(new Error("Too Many Requests"))).toBe(false);
  });
});

/** A client stub that fails a fixed number of times, then succeeds. */
function flakyClient(failures: number, error: unknown) {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      uid: `flaky-${Math.random()}`,
      cacheTime: 0,
      request: async ({ method }: { method: string }) => {
        if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
        calls += 1;
        if (calls <= failures) throw error;
        return [];
      },
    } as never,
  };
}

describe("getLogsChunked — rate limit handling", () => {
  it("retries after a transient 429 rather than failing the sweep", async () => {
    vi.useFakeTimers();
    const rateLimit = new Error("HTTP request failed. Details: Too Many Requests");
    const { client, calls } = flakyClient(2, rateLimit);

    const promise = getLogsChunked(client, { fromBlock: 0n, toBlock: 10n });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await promise;
    vi.useRealTimers();

    expect(calls()).toBe(3); // two throttled, one success
    expect(result.logs).toEqual([]);
  });

  it("gives up after repeated throttling instead of looping forever", async () => {
    vi.useFakeTimers();
    const rateLimit = new Error("Too Many Requests");
    const { client } = flakyClient(Number.MAX_SAFE_INTEGER, rateLimit);

    const promise = getLogsChunked(client, { fromBlock: 0n, toBlock: 10n });
    const assertion = expect(promise).rejects.toThrow(/Too Many Requests/);
    await vi.advanceTimersByTimeAsync(600_000);
    await assertion;
    vi.useRealTimers();
  });

  it("propagates a non-throttling error immediately", async () => {
    const { client, calls } = flakyClient(1, new Error("unauthorized: invalid api key"));
    await expect(getLogsChunked(client, { fromBlock: 0n, toBlock: 10n })).rejects.toThrow(
      /unauthorized/,
    );
    expect(calls()).toBe(1);
  });
});
