/**
 * The client factory every generated project uses.
 *
 * Composes the three things a raw viem client lacks on a rate-limited chain:
 *
 *   1. a client-side concurrency cap, split by call cost (viem has none — it only
 *      *reacts* to 429s after paying for them)
 *   2. fallback across endpoints, with ranking off by default
 *   3. `getLogs` that chunks adaptively instead of failing on dense ranges
 *
 * What is deliberately NOT here: a retry layer. viem already retries HTTP 429, honours
 * `Retry-After`, and backs off exponentially — verified in its source. Wrapping that in
 * `p-retry` multiplies the request budget by `(retryCount+1) × transports` and turns a
 * transient rate limit into sustained hammering.
 */
import type { Chain } from "viem";
import { createPublicClient, fallback, http } from "viem";
import { getLogs } from "viem/actions";
import { type ChunkConfig, DEFAULT_CHUNK, initialChunk, onFailure, onSuccess } from "./chunk.js";
import {
  createLimiter,
  DEFAULT_LIMITS,
  type Limiter,
  type LimiterConfig,
  limitedFetch,
} from "./limiter.js";

export type ClientOptions = {
  readonly chain: Chain;
  /** One or more endpoints, tried in order. The first should be the most trusted. */
  readonly urls: readonly string[];
  readonly limits?: LimiterConfig;
  readonly chunk?: ChunkConfig;
  /** Per-request timeout. Default 10s, matching viem. */
  readonly timeoutMs?: number;
  /**
   * Pause between sequential chunked requests, in ms.
   *
   * Measured on the 4663 public RPC: a burst of 20 concurrent `getLogs` succeeds, but a
   * SUSTAINED sequential sweep still earns 429s even at 2-way concurrency — the endpoint
   * meters cumulative compute over a window, not just instantaneous parallelism. A small
   * inter-request pause is what keeps a long backfill under that budget. Set to 0 for a
   * paid endpoint.
   */
  readonly pauseMs?: number;
};

export type TaiaClient = ReturnType<typeof createPublicClient> & {
  readonly limiter: Limiter;
};

/**
 * Build a rate-limited, failover-capable public client.
 *
 * One limiter is shared across every transport on purpose: the cap models OUR outbound
 * concurrency, and giving each endpoint its own budget would multiply real load by the
 * number of endpoints — exactly what we are trying to prevent.
 */
export function createTaiaClient(options: ClientOptions): TaiaClient {
  const { chain, urls, timeoutMs = 10_000 } = options;
  if (urls.length === 0) throw new Error("at least one RPC url is required");

  const limiter = createLimiter(options.limits ?? DEFAULT_LIMITS);
  const fetchFn = limitedFetch(limiter);

  const transports = urls.map((url) =>
    http(url, {
      timeout: timeoutMs,
      fetchFn,
      // Left unset deliberately: `fallback` injects `retryCount: 0` into its children so
      // it can try every endpoint before retrying. Setting it here defeats that and
      // multiplies the total request budget.
    }),
  );

  const transport =
    transports.length === 1 && transports[0] !== undefined
      ? transports[0]
      : fallback(transports, {
          // Ranking pings every endpoint on a timer, forever, with no stop handle. On a
          // 100ms-block chain the derived poll interval is aggressive enough to matter
          // against a rate-limited public RPC. Order the urls by preference instead.
          rank: false,
        });

  const client = createPublicClient({ chain, transport });
  return Object.assign(client, { limiter });
}

export type GetLogsRange = {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly address?: `0x${string}` | readonly `0x${string}`[];
  readonly events?: readonly unknown[];
};

export type ChunkedLogsResult = {
  readonly logs: unknown[];
  /** Requests actually issued, including retries. Useful for cost accounting. */
  readonly requests: number;
  /** Range size the loop converged on — the empirical density signal for this chain. */
  readonly finalChunk: bigint;
};

/**
 * `getLogs` over an arbitrary span, adapting the range size as it goes.
 *
 * Measured on 4663: ~100 logs/block, so a 10,000-log cap is hit in ~100 blocks — while a
 * quiet chain serves 50,000. A fixed range is wrong on one of them, always. The loop
 * converges from observed density rather than creeping by a fixed factor.
 *
 * Throws on a single block that still exceeds the provider's limit: that range cannot be
 * split further, and retrying would spin forever.
 */
export async function getLogsChunked(
  client: TaiaClient,
  range: GetLogsRange,
  config: ChunkConfig = DEFAULT_CHUNK,
  pauseMs = 0,
): Promise<ChunkedLogsResult> {
  if (range.toBlock < range.fromBlock) {
    throw new Error(`toBlock ${range.toBlock} is below fromBlock ${range.fromBlock}`);
  }

  const collected: unknown[] = [];
  let state = initialChunk(config);
  let cursor = range.fromBlock;
  let requests = 0;
  let rateLimitRetries = 0;
  const maxRateLimitRetries = 6;

  while (cursor <= range.toBlock) {
    const span = state.blocks > 0n ? state.blocks - 1n : 0n;
    const to = min(cursor + span, range.toBlock);

    try {
      requests += 1;
      const logs = await getLogs(client, {
        fromBlock: cursor,
        toBlock: to,
        ...(range.address ? { address: range.address as never } : {}),
      });

      collected.push(...logs);
      rateLimitRetries = 0;
      state = onSuccess(state, to - cursor + 1n, logs.length, config);
      cursor = to + 1n;
      if (pauseMs > 0 && cursor <= range.toBlock) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    } catch (error) {
      const outcome = onFailure(state, cursor, to, error, config);

      if (outcome.kind === "retry") {
        state = outcome.state;
        continue;
      }
      if (outcome.kind === "unsplittable") {
        throw new Error(
          `block ${cursor} exceeds the provider's log limit and cannot be split further`,
          { cause: error },
        );
      }
      // Not a range problem — a 429, auth failure or transport error.
      //
      // viem has already retried with exponential backoff. A 429 surviving that means the
      // endpoint is metering CUMULATIVE compute over a window, not instantaneous
      // parallelism: the public 4663 RPC sustains a 20-way burst yet still throttles a
      // long sequential sweep. Shrinking the range would only raise the request count and
      // make it worse, so back off in TIME and keep the range.
      if (isRateLimited(error) && rateLimitRetries < maxRateLimitRetries) {
        rateLimitRetries += 1;
        const backoff =
          pauseMs > 0 ? pauseMs * 2 ** rateLimitRetries : 1_000 * 2 ** rateLimitRetries;
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      throw error;
    }
  }

  return { logs: collected, requests, finalChunk: state.blocks };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Does this error represent throttling rather than a malformed request? */
export function isRateLimited(error: unknown): boolean {
  // Serialise BOTH shapes. Providers return throttling either as an Error (viem wraps
  // HTTP 429) or as a bare JSON-RPC object like `{code: 429}` — Alchemy's batch mode
  // returns HTTP 200 with the code in the body. Using an Error's own property names for
  // a plain object yields "{}", which silently matches nothing.
  const own = error instanceof Error ? Object.getOwnPropertyNames(error) : undefined;
  let text = "";
  try {
    text = JSON.stringify(error, own) ?? "";
  } catch {
    text = "";
  }
  const message = error instanceof Error ? error.message : String(error);
  const haystack = `${text} ${message}`.toLowerCase();
  return (
    haystack.includes("too many requests") ||
    haystack.includes("429") ||
    haystack.includes("rate limit") ||
    haystack.includes("-32005")
  );
}
