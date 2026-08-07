/**
 * Quoting a swap, and remembering what prices did.
 *
 * ══ WHY A QUOTER AND NOT A PRICE MULTIPLICATION ══
 *
 * `@strays/hunt`'s `Candidate.quotedOut` carries a warning worth repeating: the number must come
 * from a QUOTER, never from a model and never from `size × price`. meridian's recorded failure is
 * that a real 18-decimal amount needs ~22 significant digits and float64 holds ~15–17, so an amount
 * reconstructed through a `number` does not match the balance and reverts with
 * `TRANSFER_FROM_FAILED`. Everything here is `bigint` end to end.
 *
 * The v4 quoter is a real contract on this chain — `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`,
 * verified on Blockscout (RESEARCH §1b) — and it is `eth_call`-only, so quoting costs nothing and
 * risks nothing.
 *
 * ══ WHY HISTORY LIVES HERE AND NOT IN THE STRATEGY ══
 *
 * `@strays/hunt` is a pure function of (state, market, config) and reads no clock and no network.
 * That is what makes it testable. Somebody still has to remember what the price was ten minutes
 * ago, and this is that somebody.
 *
 * **The history starts EMPTY and that is stated rather than hidden.** unitick's recorded failure is
 * a page that rendered seven flat lines because "history started empty and accumulated one
 * client-side poll per 1.5s" — it read as a loading state, not a product. Here the consequence is
 * different and safer: with too few points the signal cannot fire, `decide` returns `hold` with a
 * reason naming the shortfall, and `/logs` says so in words. A stray that has not yet seen enough
 * price history is not broken; it is a stray that has not yet seen enough price history.
 */
import { createPublicClient, http, parseAbi } from "viem";

/** The v4 quoter on chain 4663. Verified on Blockscout. */
export const V4_QUOTER = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94" as const;
export const HOOK = "0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC" as const;
const NATIVE = "0x0000000000000000000000000000000000000000" as const;

const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

export type PricePoint = {
  /** ETH per token, scaled by 1e18. */
  readonly ethPerTokenWei: bigint;
  /** Unix SECONDS. The window is measured from this, never from the sample count. */
  readonly atSeconds: number;
};

/**
 * Price history per token, in memory.
 *
 * ⚠ IN MEMORY, so it is lost on restart. That is a real limitation with a real consequence: after a
 * redeploy every stray holds until the window refills. It is recorded here rather than glossed
 * because meridian's identical shortcut caused a live incident — position state lived only in
 * process memory, `tsx watch` restarted on file save, and the agent re-proposed entering a position
 * it already held. Ours fails SAFE (a cold history means `hold`, never a spurious trade), which is
 * why it is tolerable in observe mode and must be moved to Postgres before going live.
 */
const history = new Map<string, PricePoint[]>();

/** Points older than this are dropped. Generous against the 60-minute signal lookback. */
const HISTORY_WINDOW_SECONDS = 4 * 60 * 60;

export function recordPrice(token: string, ethPerTokenWei: bigint, atSeconds: number): void {
  const key = token.toLowerCase();
  const points = history.get(key) ?? [];
  points.push({ ethPerTokenWei, atSeconds });
  const cutoff = atSeconds - HISTORY_WINDOW_SECONDS;
  // Oldest-first, which is what `@strays/hunt` expects.
  const kept = points.filter((p) => p.atSeconds >= cutoff).sort((a, b) => a.atSeconds - b.atSeconds);
  history.set(key, kept);
}

export function historyFor(token: string): readonly PricePoint[] {
  return history.get(token.toLowerCase()) ?? [];
}

export function clearHistory(): void {
  history.clear();
}

/**
 * Ask the quoter what `amountInWei` of ETH actually buys.
 *
 * Returns `null` on any failure rather than throwing or guessing. A token we cannot quote is a
 * token we do not trade this tick — RESEARCH §7c's rule that a floor must never be zero means a
 * missing quote must never be substituted with an estimate.
 */
export async function quoteBuy(args: {
  readonly client: ReturnType<typeof createPublicClient>;
  readonly token: `0x${string}`;
  readonly tickSpacing: number;
  readonly amountInWei: bigint;
}): Promise<bigint | null> {
  try {
    const { result } = await args.client.simulateContract({
      address: V4_QUOTER,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        [
          [NATIVE, args.token, 0, args.tickSpacing, HOOK],
          true, // zeroForOne: ETH (currency0) in, token out
          args.amountInWei,
          "0x",
        ],
      ],
    });
    // The quoter returns (amountOut, gasEstimate). Take the first element by position rather than
    // casting the tuple to a bigint — `tsc` rejects that cast, correctly.
    const out = result[0];
    return out > 0n ? out : null;
  } catch {
    return null;
  }
}

/**
 * THE SELL SIMULATION. Quote selling `amountInTokens` back to ETH — **before we buy**.
 *
 * ══ MEASURED: 84 OF THE NEWEST 100 TOKENS FAIL THIS AND 0 FAIL THE BUY ══
 *
 * Every token on this pad quotes a BUY successfully. 84 of 100 cannot be quoted for a SELL. Until
 * this function existed the keeper checked only `quoteBuy`, so it would have bought all 84 and
 * discovered the problem while holding — RESEARCH-STRATEGY §1.
 *
 * It is the same `eth_call` in the opposite direction (`zeroForOne: false`), so it costs nothing
 * and risks nothing, and it is the single highest-value check available to us.
 *
 * ══ WHY THE REVERT SELECTOR IS UNWRAPPED RATHER THAN DISCARDED ══
 *
 * The v4 quoter wraps inner reverts in `UnexpectedRevertBytes(bytes)` (`0x6190b2b0`). Unwrapping
 * gave exactly two inner selectors across all 84 measured failures, and they mean different things:
 *
 *   0x7a5ed734  NotEnoughLiquidity  — 38 tokens, a genuine DEPTH refusal
 *   0x90bfb865  hook refusal        — 46 tokens, ALL of which had never traded
 *
 * The ACTION is identical (do not buy), so `screen.ts` keys on the outcome. But a log that cannot
 * tell a thin pool from a hook refusal cannot tell an operator whether the pad has changed, so the
 * selector is extracted and carried through.
 */
export async function simulateSell(args: {
  readonly client: ReturnType<typeof createPublicClient>;
  readonly token: `0x${string}`;
  readonly tickSpacing: number;
  readonly amountInTokens: bigint;
}): Promise<{ ok: true; proceedsWei: bigint } | { ok: false; selector: string | null }> {
  if (args.amountInTokens <= 0n) {
    // Nothing to sell back is not evidence that selling works. Refuse rather than report success.
    return { ok: false, selector: null };
  }
  try {
    const { result } = await args.client.simulateContract({
      address: V4_QUOTER,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        [
          [NATIVE, args.token, 0, args.tickSpacing, HOOK],
          false, // zeroForOne: FALSE — token in, ETH out. This is the whole point.
          args.amountInTokens,
          "0x",
        ],
      ],
    });
    const out = result[0];
    return out > 0n ? { ok: true, proceedsWei: out } : { ok: false, selector: null };
  } catch (err) {
    return { ok: false, selector: innerRevertSelector(err) };
  }
}

/**
 * Pull the INNER revert selector out of the quoter's `UnexpectedRevertBytes(bytes)` wrapper.
 *
 * Returns `null` when nothing decodable is present — an RPC error rather than a contract refusal.
 * Deliberately does not throw: a failure to parse a revert must not become a failure to screen.
 */
export function innerRevertSelector(err: unknown): string | null {
  // viem nests the original data through a `cause` chain; walk it for the wrapper payload.
  let node: unknown = err;
  let wrapped: string | null = null;
  for (let depth = 0; node !== null && node !== undefined && depth < 10; depth++) {
    if (typeof node !== "object") break;
    const data = (node as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x6190b2b0")) wrapped = data;
    node = (node as { cause?: unknown }).cause;
  }
  if (wrapped === null) return null;
  // Layout after the 4-byte selector: offset word (32B), length word (32B), then the payload.
  const body = wrapped.slice(10);
  const lengthHex = body.slice(64, 128);
  if (lengthHex.length < 64) return null;
  const length = Number.parseInt(lengthHex, 16);
  if (!Number.isFinite(length) || length < 4) return null;
  const payload = body.slice(128, 128 + length * 2);
  return payload.length >= 8 ? `0x${payload.slice(0, 8)}` : null;
}
