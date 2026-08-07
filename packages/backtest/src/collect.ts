/**
 * DATA COLLECTION — reconstruct real price history from Uniswap v4 `Swap` events.
 *
 * This is the gold-standard path from the brief: every swap on the PoolManager carries
 * `sqrtPriceX96`, so the price *after* each swap is exactly reconstructible, at the real block
 * timestamp, for every pool. Nothing here is modelled, interpolated or assumed — a row in the
 * output is a trade that happened.
 *
 * ══ WHY NOT THE API'S /trades ENDPOINT ══
 *
 * `GET /api/tokens/{addr}/trades` returns the same data pre-decoded, and its `priceEth` matches
 * this decoder to 7 significant figures (verified in `series.test.ts`). But it is **hard-capped at
 * 100 trades** and has no pagination — `page`, `offset`, `before`, `cursor` and `beforeId` were all
 * probed and every one returns the identical newest-100 window. For an active token that is ~10
 * hours of history. It is used here ONLY as an independent cross-check on the decoder, never as
 * the series itself.
 *
 * ══ THE RANGE FINDING ══
 *
 * Alchemy's Robinhood endpoint serves `eth_getLogs` over `fromBlock: 0x0, toBlock: latest` for a
 * single pool topic in under a second, and — critically — includes `blockTimestamp` on every log.
 * That removes the per-block `eth_getBlockByNumber` fan-out that would otherwise dominate. One
 * request yields a pool's ENTIRE history from its launch block. The public
 * `rpc.mainnet.chain.robinhood.com` rate-limits under load with a Cloudflare 403, so
 * `ROBINHOOD_RPC_URL` is required.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, "..", "data");

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

/** keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)") — cast-verified. */
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

const API = "https://api.letscash.fun/api";
/** The API 403s python's default UA behind Cloudflare (RESEARCH-STRATEGY §9). */
const UA = "strays-backtest/0.1";

export type RawSwap = {
  /** Block number the swap landed in. */
  readonly block: number;
  /** Unix seconds, from the block header, carried on the log itself. */
  readonly ts: number;
  /** Ordering key within a block. */
  readonly logIndex: number;
  /** ETH per token, after this swap, from `sqrtPriceX96`. Stored as a decimal string. */
  readonly priceEth: string;
  /** currency0 (ETH) delta, signed, from the pool's perspective. Positive = ETH into pool = BUY. */
  readonly amount0: string;
  /** currency1 (token) delta, signed. */
  readonly amount1: string;
};

export type TokenSeries = {
  readonly address: string;
  readonly symbol: string;
  readonly poolId: string;
  readonly taxPct: number;
  readonly launchedAt: number;
  readonly marketCapEth: number;
  readonly swaps: readonly RawSwap[];
};

/* ══════════════════════════════════════════════════════════════════════════════════════════
   DECODING — the only arithmetic in this file, and the one thing that could silently lie
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** Read a 32-byte word as a two's-complement signed integer. */
export function readSigned(word: bigint): bigint {
  return word >= 1n << 255n ? word - (1n << 256n) : word;
}

/**
 * ETH per token from `sqrtPriceX96`.
 *
 * v4 sorts currencies by address and the zero address (native ETH) always sorts first, so
 * currency0 = ETH and currency1 = the token on every letscash pool (RESEARCH §2). `sqrtPriceX96`
 * encodes sqrt(price of currency1 in currency0 terms) — i.e. sqrt(token per ETH) — so ETH per
 * token is the reciprocal of its square.
 *
 * Computed in fixed-point with a 10^36 scale rather than float, then divided once at the end.
 * `(sqrt/2^96)^2` in float64 loses precision at the ~1e-13 prices these pools trade at.
 */
export function ethPerTokenFromSqrtX96(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 <= 0n) {
    throw new Error(
      `refusing to derive a price from sqrtPriceX96=${sqrtPriceX96.toString()} — a non-positive ` +
        "sqrt price is a failed read, and treating it as a price invents a number",
    );
  }
  const Q192 = 1n << 192n;
  const SCALE = 10n ** 36n;
  // token-per-ETH = sqrt^2 / 2^192. ETH-per-token is its reciprocal: 2^192 / sqrt^2.
  const scaled = (Q192 * SCALE) / (sqrtPriceX96 * sqrtPriceX96);
  return Number(scaled) / 1e36;
}

export function decodeSwapLog(log: {
  data: string;
  blockNumber: string;
  blockTimestamp?: string;
  logIndex: string;
}): Omit<RawSwap, "ts"> & { readonly ts: number | undefined } {
  const raw = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  if (raw.length !== 6 * 64) {
    throw new Error(
      `Swap log data is ${String(raw.length / 2)} bytes, expected 192 (6 words: amount0, ` +
        "amount1, sqrtPriceX96, liquidity, tick, fee). A short read here would silently " +
        "misalign every field after it",
    );
  }
  const word = (i: number): bigint => BigInt(`0x${raw.slice(i * 64, (i + 1) * 64)}`);

  const amount0 = readSigned(word(0));
  const amount1 = readSigned(word(1));
  const sqrtPriceX96 = word(2);

  return {
    block: Number(BigInt(log.blockNumber)),
    ts: log.blockTimestamp === undefined ? undefined : Number(BigInt(log.blockTimestamp)),
    logIndex: Number(BigInt(log.logIndex)),
    priceEth: ethPerTokenFromSqrtX96(sqrtPriceX96).toExponential(12),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   FETCHING
   ══════════════════════════════════════════════════════════════════════════════════════════ */

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error !== undefined) {
      // Rate limits are transient; a malformed request is not. Back off on the former only.
      if (/rate|limit|429|capacity/i.test(body.error.message) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`${method} failed: ${body.error.message}`);
    }
    return body.result;
  }
  throw new Error(`${method} exhausted retries`);
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${path} -> HTTP ${String(res.status)}`);
  return (await res.json()) as T;
}

type RpcLog = {
  data: string;
  blockNumber: string;
  blockTimestamp?: string;
  logIndex: string;
};

/**
 * Every `Swap` for one pool, from genesis to `head`.
 *
 * Alchemy serves an unbounded block range but caps the RESPONSE at 10,000 logs. Most pools on this
 * pad are far under that and come back in a single call; the busiest do not. Rather than guess a
 * safe window up front — which would multiply the request count for the ~95% of pools that need
 * one call — this asks for everything and BISECTS only on the specific overflow error. The busiest
 * pool in the sample needed 3 calls.
 *
 * The overflow is detected on the error STRING, which is brittle by nature, so the split is also
 * guarded: if a range of one block still overflows the data is genuinely unfetchable and we throw
 * rather than silently return a truncated series. A truncated series is the worst possible outcome
 * here — it would look like a quiet pool and be replayed as one.
 */
async function fetchAllSwaps(
  rpcUrl: string,
  poolId: string,
  head: number,
  from = 0,
  to?: number,
): Promise<RpcLog[]> {
  const hi = to ?? head;
  try {
    return (await rpc(rpcUrl, "eth_getLogs", [
      {
        address: POOL_MANAGER,
        topics: [SWAP_TOPIC, poolId],
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${hi.toString(16)}`,
      },
    ])) as RpcLog[];
  } catch (e) {
    const msg = String(e);
    if (!/response size|10K logs|10,000|limit/i.test(msg)) throw e;
    if (hi - from < 2) {
      throw new Error(
        `pool ${poolId} has >10k swaps inside a single block range [${String(from)}, ` +
          `${String(hi)}] and cannot be split further. Refusing to return a partial series — ` +
          `a truncated history replays as a quiet pool, which is a silent lie. (${msg})`,
      );
    }
    const mid = Math.floor((from + hi) / 2);
    const left = await fetchAllSwaps(rpcUrl, poolId, head, from, mid);
    const right = await fetchAllSwaps(rpcUrl, poolId, head, mid + 1, hi);
    return [...left, ...right];
  }
}

type ApiToken = {
  address: string;
  symbol: string;
  pool: string;
  taxPct: number;
  launchedAt: number;
  marketCapEth: number;
};

async function main(): Promise<void> {
  const rpcUrl = process.env["ROBINHOOD_RPC_URL"];
  if (rpcUrl === undefined || rpcUrl === "") {
    throw new Error(
      "ROBINHOOD_RPC_URL is required. The public rpc.mainnet.chain.robinhood.com rate-limits " +
        "under load with a Cloudflare 403, so it cannot serve a full-universe collection",
    );
  }
  mkdirSync(DATA_DIR, { recursive: true });

  // ── Universe: every token the API will name. `sort=newest` only ever returns minutes-old
  // tokens, so it contributes nothing to a historical sample; `mcap` and `trending` reach back
  // ~28 days and are the only two sorts that do.
  const universe = new Map<string, ApiToken>();
  for (const sort of ["mcap", "trending"]) {
    for (let page = 1; page <= 3; page++) {
      const r = await api<{ tokens: ApiToken[] }>(
        `/tokens?sort=${sort}&limit=100&page=${String(page)}`,
      );
      for (const t of r.tokens) universe.set(t.address, t);
    }
  }
  process.stdout.write(`universe: ${String(universe.size)} unique tokens\n`);

  // Pin the head block ONCE. Collecting against `latest` would give later tokens a longer
  // history than earlier ones purely because the chain advanced mid-run.
  const head = Number(BigInt((await rpc(rpcUrl, "eth_blockNumber", [])) as string));
  process.stdout.write(`head block: ${String(head)}\n`);

  const out: TokenSeries[] = [];
  let done = 0;
  for (const token of universe.values()) {
    const logs = await fetchAllSwaps(rpcUrl, token.pool, head);

    const swaps: RawSwap[] = [];
    for (const log of logs) {
      const d = decodeSwapLog(log);
      if (d.ts === undefined) {
        throw new Error(
          "a Swap log arrived without blockTimestamp. Every price point must carry a REAL " +
            "block time; inferring one from block number would fabricate the x-axis the whole " +
            "backtest is indexed on",
        );
      }
      swaps.push({ ...d, ts: d.ts });
    }
    // Chain order: block, then logIndex. Never arrival order.
    swaps.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

    out.push({
      address: token.address,
      symbol: token.symbol,
      poolId: token.pool,
      taxPct: token.taxPct,
      launchedAt: token.launchedAt,
      marketCapEth: token.marketCapEth,
      swaps,
    });
    done++;
    if (done % 25 === 0) process.stdout.write(`  ${String(done)}/${String(universe.size)}\n`);
  }

  const path = join(DATA_DIR, "series.json");
  writeFileSync(path, JSON.stringify(out));
  const total = out.reduce((n, t) => n + t.swaps.length, 0);
  const withData = out.filter((t) => t.swaps.length >= 2);
  // Fold rather than `Math.min(...times)` — the spread blew the call stack at 394,635 elements.
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (const t of out) {
    for (const s of t.swaps) {
      if (s.ts < lo) lo = s.ts;
      if (s.ts > hi) hi = s.ts;
    }
  }
  process.stdout.write(
    `\nwrote ${path}\n` +
      `  tokens ${String(out.length)} (${String(withData.length)} with >=2 swaps)\n` +
      `  swaps  ${String(total)}\n` +
      `  range  ${new Date(lo * 1000).toISOString()} .. ${new Date(hi * 1000).toISOString()}\n`,
  );
  appendFileSync(
    join(DATA_DIR, "provenance.txt"),
    `${new Date().toISOString()} tokens=${String(out.length)} swaps=${String(total)}\n`,
  );
}

if (process.env["COLLECT"] === "1") {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`);
    process.exitCode = 1;
  });
}
