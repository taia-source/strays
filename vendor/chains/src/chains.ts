/**
 * The chain registry.
 *
 * Rule: WRAP viem's definition, never hand-roll one. viem already maintains id, RPC URLs,
 * explorer and multicall3 upstream. We add only what viem omits — Nitro formatters,
 * confirmations, and the block-clock family — so upstream fixes still flow to us.
 *
 * This registry is chain-agnostic by construction. 4663 is first because that is where the
 * volume is today, not because anything here is specific to it.
 */

import { defineChain } from "viem";
import { bsc, robinhood, robinhoodTestnet } from "viem/chains";
import { nitroChainConfig } from "./nitro.js";

/**
 * How a chain reports block numbers. Load-bearing: see the ArbSys note in `nitro.ts`.
 *
 * - `nitro`  — NUMBER opcode returns the L1 height; eth_blockNumber returns L2.
 * - `standard` — both agree (L1s, OP-Stack).
 */
export type BlockClock = "nitro" | "standard";

export type TaiaChainMeta = {
  /** Blocks to wait before treating a tx as settled for our purposes. */
  readonly confirmations: number;
  readonly blockClock: BlockClock;
  /**
   * Substring the chain's `web3_clientVersion` must contain. The stack-assertion test
   * checks this against the live chain — one assertion that would have caught the
   * "OP-Stack" comment which caused two production bugs.
   */
  readonly clientVersionMatch: string | undefined;
  /** Public RPC has no archive data / is rate-limited → backfill needs a paid endpoint. */
  readonly publicRpcHasArchive: boolean;
};

/**
 * Robinhood Chain (4663) — Arbitrum Orbit rollup, settles to Ethereum L1.
 *
 * Confirmed live by probing `web3_clientVersion`, which returns a `nitro/...` string —
 * that PREFIX is the load-bearing part and is what `assertNitro` matches on.
 *
 * The exact version deliberately is not recorded here. Three readings of this same
 * endpoint within about a day produced `v3.11.3-rc.4`, `v3.11.3-rc.5` and `v3.11.2` — the
 * chain moves faster than any comment can track, and a stale version string in prose reads
 * as a verified fact while being wrong. This is the "probe, never assume" rule applied to
 * our own documentation: pin the invariant (it is Nitro), probe the variable (which build).
 *
 * viem ships this chain but with NO formatters, so `l1BlockNumber`/`sendRoot` arrive
 * untyped. Spreading `nitroChainConfig` is the entire reason this wrapper exists.
 */
export const robinhoodNitro = /*#__PURE__*/ defineChain({
  ...robinhood,
  ...nitroChainConfig,
});

export const robinhoodTestnetNitro = /*#__PURE__*/ defineChain({
  ...robinhoodTestnet,
  ...nitroChainConfig,
});

/**
 * 240 blocks ≈ 24s at 100ms. The Arbitrum finality convention; soft confirmation is
 * sub-second but a batch is not posted to L1 for minutes. Use more for real money.
 */
const ROBINHOOD_CONFIRMATIONS = 240;

/**
 * BNB Smart Chain (56).
 *
 * viem ships the definition; this wrapper adds only the measured metadata below. No
 * formatters are needed — BSC blocks carry no extra fields, unlike Nitro's
 * `l1BlockNumber`/`sendRoot`.
 *
 * ══ `clientVersionMatch` is deliberately `undefined`, and that is a finding ══
 *
 * The first draft set it to `"reth-bsc"`, having probed one endpoint. The stack-assertion
 * test then failed against a different provider, and the reason is the point:
 *
 *     bsc-rpc.publicnode.com    reth-bsc/v0.1.1-457f81a/linux
 *     bsc-dataseed.bnbchain.org Geth/v1.7.7-6c154fb3-20260723/linux-amd64/go1.26.5
 *     bnb-mainnet.g.alchemy.com Alchemy/v1.0.0/linux-amd64
 *
 * Three providers, three client families, same chain. **BSC has real client diversity**,
 * unlike a single-sequencer rollup where every endpoint is the same binary — and Alchemy
 * does not report a client family at all, it reports itself.
 *
 * So on this chain the assertion is not merely unhelpful, it is WRONG: it would encode the
 * provider currently configured rather than anything true of the chain, and a routine RPC
 * change would turn the gate red for no defect. `undefined` disables it, which the test
 * already handles.
 *
 * The lesson generalises: a stack assertion is only meaningful where the stack is uniform.
 * On 4663 (`nitro`) it caught two real bugs. Here it would manufacture one.
 *
 * ══ Block time is 0.45s and it MOVES ══
 *
 * Measured over 1,000 blocks: **0.450 s**, i.e. ~70,080,000 blocks/year. BSC has shortened
 * block time twice in a year (Lorentz, Maxwell), and most published integration guides
 * still assume 3 s.
 *
 * This is not a trivium. Compound-v2-style lending markets — Venus among them — express
 * rates **per block**, so an APY computed from a stale block time is wrong by the ratio of
 * the two:
 *
 *     assumed 3.00 s -> 10,512,000 blocks/yr -> Venus USDT supply APY reads 0.36 %
 *     measured 0.45 s -> 70,080,000 blocks/yr -> the same market reads 2.41 %
 *
 * A 6.7x error, silent, in the direction that makes a product look broken. Hence: derive
 * blocks-per-year from a probe, never from a literal, and re-measure on every deploy.
 */
export const bscChain = /*#__PURE__*/ defineChain({ ...bsc });

/**
 * 15 blocks ≈ 6.75 s at 0.45 s.
 *
 * Deliberately far above what finality alone would justify. Measured 2026-07-30, sampled
 * three times: `finalized` trails `latest` by **0 to 1 blocks**, and advanced 66 blocks over
 * a 30 s window — so the tag is alive, not frozen, and BSC finalises in under a second.
 *
 * That is unusually fast and it is tempting to set this to 1. It is not set to 1 because a
 * finality tag reported by one RPC is a claim about consensus, not a guarantee against a
 * provider serving a stale or minority view, and this number is used for money. 15 costs
 * under seven seconds.
 */
const BSC_CONFIRMATIONS = 15;

export const meta = {
  [robinhoodNitro.id]: {
    confirmations: ROBINHOOD_CONFIRMATIONS,
    blockClock: "nitro",
    clientVersionMatch: "nitro",
    publicRpcHasArchive: false,
  },
  [robinhoodTestnetNitro.id]: {
    confirmations: ROBINHOOD_CONFIRMATIONS,
    blockClock: "nitro",
    clientVersionMatch: "nitro",
    publicRpcHasArchive: false,
  },
  [bscChain.id]: {
    confirmations: BSC_CONFIRMATIONS,
    // An L1 in its own right: the NUMBER opcode and eth_blockNumber agree. No second clock.
    blockClock: "standard",
    // Not "reth-bsc" — see the note on bscChain. Three providers report three client
    // families on this chain, so pinning one encodes the RPC, not the chain.
    clientVersionMatch: undefined,
    // `eth_getBalance` at block 1 answers on the public endpoint rather than erroring, so
    // historical state is served. Recorded as measured, not assumed — but note this says
    // nothing about rate limits, which is a separate reason to set TAIA_RPC_56.
    publicRpcHasArchive: true,
  },
} as const satisfies Record<number, TaiaChainMeta>;

export const chains = {
  [robinhoodNitro.id]: robinhoodNitro,
  [robinhoodTestnetNitro.id]: robinhoodTestnetNitro,
  [bscChain.id]: bscChain,
} as const;

export type SupportedChainId = keyof typeof chains;

export function getChain(id: SupportedChainId) {
  return chains[id];
}

export function getMeta(id: SupportedChainId): TaiaChainMeta {
  return meta[id];
}

/**
 * RPC URL for a chain, env-var first. No keys are ever hardcoded.
 *
 * `TAIA_RPC_<id>` (e.g. `TAIA_RPC_4663`) overrides the public default — required for
 * backfill and CI, since the public endpoint has no archive data and is rate-limited.
 */
export function rpcUrl(id: SupportedChainId): string {
  return resolveRpc(id, process.env).url;
}

/** Where an RPC URL came from. The distinction is the point — see {@link resolveRpc}. */
export type RpcSource = "override" | "public-default";

/**
 * Resolve an RPC URL and say **where it came from**.
 *
 * ══ Why the source is returned rather than discarded ══
 *
 * `rpcUrl` alone cannot be misused loudly: with `TAIA_RPC_4663` unset it silently returns
 * the public endpoint. Verified:
 *
 *     TAIA_RPC_4663 unset  ->  https://rpc.mainnet.chain.robinhood.com
 *
 * That endpoint has no archive data and is rate-limited, so a backfill against it returns
 * *fewer logs* rather than an error, and a live test suite against it becomes slow and
 * flaky. Both failures are silent, and silent wrongness is the thing this repo exists to
 * prevent.
 *
 * A typo'd or dropped env var therefore has to be *visible*. This function makes it a value
 * a caller can assert on; {@link requireOwnRpc} makes it fatal where that is correct.
 */
export function resolveRpc(
  id: SupportedChainId,
  env: Readonly<Record<string, string | undefined>>,
): { readonly url: string; readonly source: RpcSource } {
  const override = env[`TAIA_RPC_${id}`];
  if (override !== undefined && override !== "") {
    return { url: override, source: "override" };
  }
  const url = chains[id].rpcUrls.default.http[0];
  if (!url) throw new Error(`No RPC URL for chain ${id}`);
  return { url, source: "public-default" };
}

/**
 * The RPC URL, refusing the public fallback.
 *
 * For anything that reads history or runs in a suite: the public endpoint has no archive
 * data, so a backfill against it silently returns an incomplete result. Failing here is
 * strictly better than succeeding with less data than the caller asked for.
 */
export function requireOwnRpc(
  id: SupportedChainId,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const resolved = resolveRpc(id, env);
  if (resolved.source === "public-default") {
    throw new Error(
      `TAIA_RPC_${id} is not set, so this would fall back to ${resolved.url} — a rate-limited ` +
        "endpoint with no archive data. A backfill against it returns FEWER logs rather than " +
        "an error, which is silent data loss. Set the env var rather than accepting the default",
    );
  }
  return resolved.url;
}
