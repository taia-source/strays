/**
 * Adaptive `eth_getLogs` range sizing.
 *
 * Why this cannot be a constant, measured on chain 4663 (2026-07-27):
 *
 *   100 blocks   → 9,980 logs      OK
 *   1,000 blocks → 84,076 logs     OK
 *   2,000 blocks → -32000 "dial tcp … i/o timeout"
 *   10,000 blocks→ -32000 "logs matched by query exceeds limit of 10000"
 *   50,000 blocks→ 429 Too Many Requests
 *
 * Density is ~100 logs/block — very dense. A 10,000-log cap is therefore reached in
 * roughly 100 blocks, while a quiet chain would happily serve 50,000. A hardcoded chunk
 * size is wrong on one of those two chains, always. It has to converge at runtime.
 *
 * The control loop targets a LOG COUNT rather than a block count, computed from the
 * density we just observed:
 *
 *   next = clamp(targetLogs / observedLogsPerBlock, 1, min(hardMax, prev * growthCap))
 *
 * This converges in about one step in both sparse and dense regions. The alternative —
 * multiply by 1.05 on success — needs ~95 successful round trips to climb from 500 back
 * to 50,000, which is the wrong shape when a chain's density varies by region.
 *
 * Error classification is delegated to `@ponder/utils`' `getLogsRetryHelper`, which
 * carries ~25 provider-specific patterns validated against live endpoints. Hand-copying
 * those regexes is exactly the kind of thing that rots silently: ponsball's own matcher
 * (`/response size|too large|query returned more than|limit exceeded|10000 block/i`)
 * does NOT match the message chain 4663 actually returns today.
 */
import { getLogsRetryHelper } from "@ponder/utils";
import type { Hex } from "viem";

export type ChunkConfig = {
  /** Logs to aim for per request. Keep well under the provider's cap — size varies too. */
  readonly targetLogs: number;
  /** Never request more than this many blocks at once. */
  readonly maxBlocks: bigint;
  /** Where to start before any density is known. */
  readonly initialBlocks: bigint;
  /** Cap on per-step growth, so one sparse region can't overshoot wildly. */
  readonly growthCap: bigint;
};

export const DEFAULT_CHUNK: ChunkConfig = {
  targetLogs: 5_000,
  maxBlocks: 50_000n,
  initialBlocks: 500n,
  growthCap: 10n,
};

export type ChunkState = {
  /** Current range size in blocks. */
  readonly blocks: bigint;
  /**
   * A provider-declared hard cap, if one was reported. Once known, growth stops —
   * this is a real server limit, not a density artifact.
   */
  readonly pinned: bigint | undefined;
};

export function initialChunk(config: ChunkConfig = DEFAULT_CHUNK): ChunkState {
  return { blocks: clamp(config.initialBlocks, 1n, config.maxBlocks), pinned: undefined };
}

function clamp(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Next range size after a successful request, from the density just observed.
 *
 * A range that returned zero logs carries no density signal, so it grows by the cap
 * rather than dividing by zero.
 */
export function onSuccess(
  state: ChunkState,
  blocksRequested: bigint,
  logsReturned: number,
  config: ChunkConfig = DEFAULT_CHUNK,
): ChunkState {
  if (state.pinned !== undefined) return state;

  const ceiling = clamp(state.blocks * config.growthCap, 1n, config.maxBlocks);

  if (logsReturned === 0) {
    return { ...state, blocks: ceiling };
  }

  const blocks = blocksRequested > 0n ? blocksRequested : 1n;
  const logsPerBlock = logsReturned / Number(blocks);
  const target = BigInt(Math.max(1, Math.floor(config.targetLogs / Math.max(logsPerBlock, 1e-9))));

  return { ...state, blocks: clamp(target, 1n, ceiling) };
}

export type ChunkFailure =
  | { readonly kind: "retry"; readonly state: ChunkState }
  /** Cannot shrink further — a single block still exceeds the limit. Must not loop. */
  | { readonly kind: "unsplittable" }
  /** Not a range problem (429, auth, network). The caller decides; viem already retries. */
  | { readonly kind: "unrelated" };

/**
 * Classify a failed `eth_getLogs` and shrink accordingly.
 *
 * Three genuinely different failures, which must NOT be conflated:
 *   - range/size too large  → shrink the chunk
 *   - rate limited (429)    → back off in time; viem handles this internally
 *   - transport error       → not ours to fix here
 *
 * Treating a 429 as "too many logs" shrinks the chunk toward 1 against an endpoint that
 * was never complaining about size — the request count then rises and makes it worse.
 */
export function onFailure(
  state: ChunkState,
  fromBlock: bigint,
  toBlock: bigint,
  error: unknown,
  config: ChunkConfig = DEFAULT_CHUNK,
): ChunkFailure {
  // viem's own client-side tripwire, before any provider error is consulted.
  // `maxResponseBodySize` (10 MiB default) throws `ResponseBodyTooLargeError` when a
  // response is too big. It is deterministic and WE control the threshold, which makes it
  // a better chunking signal than a provider message — and @ponder/utils does not know
  // about it, since it is not a provider error at all. Seen live on 4663: a 500-block
  // range returned 10,502,144 bytes against the 10,485,760 limit.
  if (isResponseTooLarge(error)) {
    if (toBlock <= fromBlock) return { kind: "unsplittable" };
    const half = (toBlock - fromBlock + 1n) / 2n;
    if (half < 1n) return { kind: "unsplittable" };
    return { kind: "retry", state: { ...state, blocks: half } };
  }

  const params = [{ fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) }] as const;
  const result = getLogsRetryHelper({
    params: params as never,
    error: error as never,
  });

  if (!result.shouldRetry) {
    // `shouldRetry: false` is ambiguous. Verified against @ponder/utils 0.3.0: a
    // single-block range that still exceeds the limit returns exactly this — and so does
    // an error that was never about ranges at all (a 429, a bad API key).
    //
    // Range width alone cannot separate them: a rate limit on a one-block query looks
    // identical. So ask whether the SAME error would be retryable on a wider range — if
    // yes it is a genuine size problem that has bottomed out; if no it is not ours.
    if (toBlock <= fromBlock && isRangeError(error, fromBlock)) {
      return { kind: "unsplittable" };
    }
    return { kind: "unrelated" };
  }

  const ranges = result.ranges;
  const first = ranges[0];

  // Guard against an infinite loop: if the helper hands back the same range it was
  // given, halving has bottomed out and retrying would spin forever.
  const unchanged =
    ranges.length === 0 ||
    (ranges.length === 1 &&
      first !== undefined &&
      first.fromBlock === params[0].fromBlock &&
      first.toBlock === params[0].toBlock);

  if (unchanged) {
    if (toBlock <= fromBlock) return { kind: "unsplittable" };
    const half = (toBlock - fromBlock) / 2n;
    if (half < 1n) return { kind: "unsplittable" };
    return { kind: "retry", state: { ...state, blocks: half } };
  }

  if (first === undefined) return { kind: "unsplittable" };

  const suggested = BigInt(first.toBlock) - BigInt(first.fromBlock) + 1n;
  const next = clamp(suggested, 1n, config.maxBlocks);

  // A provider-suggested range is a declared cap: pin it and stop growing past it.
  return {
    kind: "retry",
    state: {
      blocks: next,
      pinned: result.isSuggestedRange ? next : state.pinned,
    },
  };
}

function toHex(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}

/** viem's client-side response-size guard, which is a range signal, not a fatal error. */
export function isResponseTooLarge(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "ResponseBodyTooLargeError" ||
    /response body is too large|maxResponseBodySize/i.test(message)
  );
}

/**
 * Would this error be treated as a range problem on a range wide enough to split?
 *
 * Used to disambiguate `shouldRetry: false`, which the helper returns both for
 * "not a range problem" and for "a range problem too small to split further".
 */
function isRangeError(error: unknown, fromBlock: bigint): boolean {
  const probe = getLogsRetryHelper({
    params: [{ fromBlock: toHex(fromBlock), toBlock: toHex(fromBlock + 1_024n) }] as never,
    error: error as never,
  });
  return probe.shouldRetry;
}
