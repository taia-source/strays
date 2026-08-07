/**
 * Finality: deciding which blocks are safe to treat as settled.
 *
 * The obvious answer — "just use the `finalized` block tag" — is WRONG on Orbit chains,
 * and we have the measurement to prove it.
 *
 * On Nitro these tags are not computed by the L2 node — they are PUSHED from L1 by a
 * background syncer. If that syncer stalls, or the operator disables `use-finality-data`,
 * the tags freeze silently and forever. A consumer trusting `finalized` stalls with it,
 * and nothing errors. This has been observed on real Orbit L3s.
 *
 * So: probe the tag, verify it actually advances, and fall back to a time-based lag.
 *
 * ⚠ THE PROBE INTERVAL IS LOAD-BEARING, and getting it wrong was a real bug in the first
 * draft of this file. Measured on chain 4663, 2026-07-27:
 *
 *   sampled  45s apart → finalized advanced 0 blocks     ("frozen!")
 *   sampled  60s apart → finalized advanced 3,790 blocks (alive)
 *
 * Finality advances in ~13-minute L1 batches, not continuously. A short sample lands
 * between batches, sees no movement, and declares a healthy chain frozen — then silently
 * degrades every consumer to the fallback lag. The interval MUST exceed the chain's L1
 * batch cadence. Default is 15 minutes for that reason, not for politeness.
 *
 * Observed lag at the same time: latest−finalized ≈ 14.4 min, latest−safe ≈ 8.0 min.
 *
 * The lag is expressed in SECONDS, not blocks. This is the single most transferable
 * decision in the package: 240 blocks is ~60s on Arbitrum One (250ms blocks) but only
 * ~24s on chain 4663 (100ms blocks). Copying a block count across chains silently
 * shortens or lengthens the safety margin. Seconds convert correctly everywhere.
 */
import type { Chain, Client, Transport } from "viem";
import { getBlock, getBlockNumber } from "viem/actions";

/**
 * Any viem client that can read blocks, regardless of how its chain is typed.
 *
 * Deliberately NOT `PublicClient`: that type is invariant in its chain parameter, so a
 * client created with a concrete chain (the normal case) is not assignable to it.
 * Accepting a loose `Client` and routing through `viem/actions` keeps this usable from
 * every consumer — which is the whole point of a shared package.
 */
export type BlockReader = Client<Transport, Chain | undefined>;

export type FinalityMode = "finalized" | "safe" | "lag";

export type FinalityConfig = {
  /**
   * Preferred source of truth. Falls back to `lag` if the tag is frozen or unsupported.
   * `lag` skips probing entirely — correct when you already know the tag is unreliable.
   */
  readonly prefer: FinalityMode;
  /**
   * How far behind the tip to read when falling back. SECONDS, converted via block time.
   * Default 900s (15 min) ≈ the observed L1 batch-posting finality on Nitro.
   */
  readonly lagSeconds: number;
  /**
   * Milliseconds between the two liveness samples.
   *
   * MUST exceed the chain's L1 batch-posting cadence or a healthy chain reads as frozen
   * — see the header. 4663 posts roughly every 13 minutes; 15 minutes gives margin.
   */
  readonly probeIntervalMs: number;
  /**
   * How many times the expected finality window a tag may lag before being called stale.
   * Catches a frozen tag in one round trip instead of one batch interval.
   */
  readonly staleMultiple: number;
};

export const DEFAULT_FINALITY: FinalityConfig = {
  prefer: "finalized",
  lagSeconds: 900,
  probeIntervalMs: 900_000,
  staleMultiple: 4,
};

export type FinalityProbe = {
  readonly mode: FinalityMode;
  /** Why we ended up in this mode — surfaced so a stalled chain is visible, not silent. */
  readonly reason: string;
};

/** Blocks equivalent to `lagSeconds` on this chain. Never less than 1. */
export function lagBlocks(blockTimeMs: number, lagSeconds: number): bigint {
  if (blockTimeMs <= 0) throw new Error("blockTimeMs must be positive");
  const blocks = Math.ceil((lagSeconds * 1000) / blockTimeMs);
  return BigInt(Math.max(1, blocks));
}

/**
 * Read a finality tag, distinguishing "unsupported" from "frozen".
 *
 * Nitro embeds geth, which throws `safe block not found` rather than returning null when
 * the pointer is unset — so this must catch, not null-check.
 */
async function readTag(
  client: BlockReader,
  blockTag: "safe" | "finalized",
): Promise<bigint | undefined> {
  try {
    const block = await getBlock(client, { blockTag });
    return block.number ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide how to derive finality for a chain, by measuring rather than assuming.
 *
 * Takes two samples `probeIntervalMs` apart. The tag is only trusted if it is supported
 * AND advanced between them. Anything else falls back to the time-based lag.
 */
export async function probeFinality(
  client: BlockReader,
  blockTimeMs: number,
  config: FinalityConfig = DEFAULT_FINALITY,
): Promise<FinalityProbe> {
  if (config.prefer === "lag") {
    return { mode: "lag", reason: "configured to use a fixed lag" };
  }

  const tag = config.prefer;
  const first = await readTag(client, tag);
  if (first === undefined) {
    return { mode: "lag", reason: `'${tag}' tag unsupported or errored` };
  }

  // Cheap single-shot check before spending 15 minutes on the two-sample probe. A tag
  // that has drifted far beyond any plausible finality window is stale, not slow — and
  // this catches it in one round trip instead of one batch interval.
  const head = await getBlockNumber(client);
  const staleLimit = lagBlocks(blockTimeMs, config.lagSeconds) * BigInt(config.staleMultiple);
  if (head > first && head - first > staleLimit) {
    return {
      mode: "lag",
      reason: `'${tag}' is ${head - first} blocks behind head — beyond ${config.staleMultiple}x the expected window, treating as stale`,
    };
  }

  await new Promise((resolve) => setTimeout(resolve, config.probeIntervalMs));

  const second = await readTag(client, tag);
  if (second === undefined) {
    return { mode: "lag", reason: `'${tag}' tag stopped responding` };
  }
  if (second <= first) {
    // The Degen/4663 failure mode. Loud, because silence here means a stalled indexer.
    return {
      mode: "lag",
      reason: `'${tag}' tag is frozen at ${second} — not advancing, using a fixed lag instead`,
    };
  }

  return { mode: tag, reason: `'${tag}' tag advanced ${second - first} blocks while sampling` };
}

/**
 * The highest block safe to treat as settled, given a probe result.
 *
 * Never returns a negative block. On a chain younger than the lag, this clamps to 0.
 */
export async function finalizedBlock(
  client: BlockReader,
  probe: FinalityProbe,
  blockTimeMs: number,
  config: FinalityConfig = DEFAULT_FINALITY,
): Promise<bigint> {
  if (probe.mode !== "lag") {
    const block = await getBlock(client, { blockTag: probe.mode });
    if (block.number !== null) return block.number;
  }
  const head = await getBlockNumber(client);
  const lag = lagBlocks(blockTimeMs, config.lagSeconds);
  return head > lag ? head - lag : 0n;
}
