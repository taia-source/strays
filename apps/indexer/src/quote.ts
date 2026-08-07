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
