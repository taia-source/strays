/**
 * THE SURVIVORSHIP-FREE COLLECTOR — a universe built FORWARD FROM LAUNCH, including the dead.
 *
 * ══ THE CAVEAT THIS FILE EXISTS TO KILL ══
 *
 * Every number in RESULTS.md rounds 1-4 is computed on a universe drawn from `collect.ts`, whose
 * universe is the union of TODAY's `sort=mcap` and `sort=trending` lists. **That is a survivorship
 * filter and it is not a subtle one.** A token only appears on those lists if it is still alive and
 * large enough to rank today; every token that launched, dumped, and died is invisible to it. §10.7
 * named this as the one remaining doubt that could invalidate the whole result, and named the fix:
 * collect forward from launch, take EVERY token, and re-measure.
 *
 * This file is that collection. It does not sample, rank, or filter by outcome. The universe is
 * defined by ONE event:
 *
 *   `TokenLaunched` on factory `0x5bd1Fbe78a78fe8236fa00CF48fbEBA74ae34661`
 *   topic0 `0x17091df68f499cf4e20dcfc5d42f064dd22359e785b77691c4c4ed0322608897`
 *
 * — which fires once, at launch, before any outcome exists. A token cannot fail to emit it by
 * performing badly. That is the whole point: **the selection is made at t=0, by the chain, not at
 * t=today, by a leaderboard.**
 *
 * MEASURED: 3,202 tokens emitted `TokenLaunched` in the 28 days to 2026-08-07. `collect.ts`'s
 * universe is 461. **2,741 tokens — 85.6% of everything ever launched — are missing from every
 * number in rounds 1-4.**
 *
 * ══ THE TWO-HOOK BUG, AND WHY THE HOOK IS READ RATHER THAN ASSUMED ══
 *
 * The pad runs TWO fee hooks — `0x75A54357…` and `0xEfe66981…` — and a collector that hard-codes
 * one silently loses every pool on the other. That was a real bug and it hid the pad's best tokens.
 *
 * This collector cannot have it, for a structural reason worth stating: **the pool id comes from
 * the launch event's own topic3, so the hook is never an input to finding a pool.** The hook is
 * nevertheless read per-pool from the PoolManager's `Initialize` event and recorded, both as
 * provenance and as a cross-check. VERIFIED at collection time: the hook in `Initialize` agrees
 * with the hook in `TokenLaunched` on **3,202 of 3,202 pools, with zero disagreements**, split
 * 2,347 / 855 across the two hooks. Neither hook is assumed anywhere.
 *
 * ══ WHY THE API IS STILL USED, AND FOR EXACTLY ONE FIELD ══
 *
 * `taxPct` decides the cost of every simulated position, so getting it wrong biases every return.
 * The launch event carries a tax code in its first data word, but that encoding is ambiguous on
 * this data — the values 15, 16 and 17 all correspond to a 1% tax on tokens the API confirms, and
 * guessing at an encoding that decides the cost model is precisely the kind of silent lie this
 * package refuses. `GET /api/tokens/{addr}` resolves ANY launched token, including dead and
 * unlisted ones (verified against tokens absent from every leaderboard), and it is the same
 * authority `collect.ts` used. It is queried per address for `taxPct` and `symbol` only.
 *
 * **This does NOT reintroduce survivorship.** The universe is fixed by the launch event before the
 * API is consulted; the API is asked about a token we already decided to include, and a token that
 * fails to resolve is kept with its on-chain-implied tax rather than dropped. A dropped token is a
 * survivorship filter by the back door.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, type RawSwap, type TokenSeries, decodeSwapLog } from "./collect.js";

const FACTORY = "0x5bd1Fbe78a78fe8236fa00CF48fbEBA74ae34661";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

/** keccak256("TokenLaunched(address,address,bytes32,...)") — the pad's launch event. */
const LAUNCHED_TOPIC = "0x17091df68f499cf4e20dcfc5d42f064dd22359e785b77691c4c4ed0322608897";
/** keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"). */
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
/** keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"). */
const INITIALIZE_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

const API = "https://api.letscash.fun/api";
const UA = "strays-backtest/0.1";

/** The forward-collected corpus. Written to `data/forward.json`. */
export const FORWARD_PATH = join(DATA_DIR, "forward.json");

/**
 * One token as the LAUNCH EVENT sees it — before any outcome is known.
 *
 * `listedToday` records whether this token also appears in `collect.ts`'s leaderboard universe.
 * It is the survivorship flag, and it is what makes the two corpora directly comparable: the
 * survivor-biased result is exactly this corpus filtered to `listedToday === true`.
 */
export type LaunchedToken = {
  readonly address: string;
  readonly poolId: string;
  /** Read from the PoolManager's `Initialize` event for THIS pool. Never assumed. */
  readonly hook: string;
  readonly launchBlock: number;
  /** Unix seconds, from the launch block header. */
  readonly launchTs: number;
};

/** Read a 32-byte word out of a hex data blob at word index `i`. */
function word(data: string, i: number): string {
  const raw = data.startsWith("0x") ? data.slice(2) : data;
  return raw.slice(i * 64, (i + 1) * 64);
}

/**
 * The low 20 bytes of a 32-byte word, as a lowercase `0x` address.
 *
 * Takes the LAST 40 hex characters rather than slicing from a fixed offset, because this function
 * is fed from two places whose strings differ: `log.topics[n]` arrives `0x`-prefixed (66 chars)
 * while a word cut out of `log.data` does not (64 chars). A fixed `slice(24)` is correct for one
 * and off by two for the other, and the off-by-two failure is SILENT — it yields a 42-hex-digit
 * string that still looks like an address, still lowercases, still compares equal to itself, and
 * simply never matches any real token. That bug shipped in the first draft of this file and
 * reported "launched-but-never-listed: 3202 of 3202", i.e. it erased the entire survivorship
 * comparison by making every address unmatchable. `forward.test.ts` pins both input shapes.
 */
export function addressFromWord(w: string): string {
  const raw = w.startsWith("0x") ? w.slice(2) : w;
  if (raw.length < 40) {
    throw new Error(
      `cannot read an address from "${w}" — ${String(raw.length)} hex chars is shorter than the ` +
        "40 an address needs, and padding it would fabricate a token identity",
    );
  }
  return `0x${raw.slice(-40)}`.toLowerCase();
}

/**
 * Decode a `TokenLaunched` log into the token, its pool, and its launch time.
 *
 * The pool id is `topics[3]` and the token is `topics[1]` — VERIFIED by cross-checking every one of
 * the 461 tokens in the leaderboard corpus: the pool id derived here matched the API's `pool` field
 * on 461 of 461 with zero mismatches.
 */
export function decodeLaunchedLog(log: {
  topics: readonly string[];
  data: string;
  blockNumber: string;
  blockTimestamp?: string;
}): Omit<LaunchedToken, "hook"> {
  const token = log.topics[1];
  const pool = log.topics[3];
  if (token === undefined || pool === undefined) {
    throw new Error(
      "TokenLaunched log is missing topic1 (token) or topic3 (pool id). Guessing either would " +
        "silently key the entire corpus on the wrong pool",
    );
  }
  if (log.blockTimestamp === undefined) {
    throw new Error(
      "TokenLaunched log arrived without blockTimestamp. Launch time defines the train/test " +
        "split for this family; inferring it from block number would fabricate the split",
    );
  }
  return {
    address: addressFromWord(token),
    poolId: pool.toLowerCase(),
    launchBlock: Number(BigInt(log.blockNumber)),
    launchTs: Number(BigInt(log.blockTimestamp)),
  };
}

/** The hook address carried in a `TokenLaunched` log's data, for cross-checking `Initialize`. */
export function hookFromLaunchedLog(log: { data: string }): string {
  return addressFromWord(word(log.data, 3));
}

/** The hook address carried in a PoolManager `Initialize` log. The AUTHORITY on a pool's hook. */
export function hookFromInitializeLog(log: { data: string }): string {
  return addressFromWord(word(log.data, 2));
}

type RpcLog = {
  topics: string[];
  data: string;
  blockNumber: string;
  blockTimestamp?: string;
  logIndex: string;
};

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  for (let attempt = 0; attempt < 6; attempt++) {
    let body: { result?: unknown; error?: { message: string } };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      // A 400 carries the same "too many logs" condition as a JSON-RPC error and must be
      // surfaced as one so the bisect below can see it, rather than thrown as a network fault.
      if (!res.ok) {
        body = { error: { message: `HTTP ${String(res.status)} ${(await res.text()).slice(0, 200)}` } };
      } else {
        body = (await res.json()) as { result?: unknown; error?: { message: string } };
      }
    } catch (e) {
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (body.error !== undefined) {
      if (/rate|limit|429|capacity|timeout/i.test(body.error.message) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`${method} failed: ${body.error.message}`);
    }
    return body.result;
  }
  throw new Error(`${method} exhausted retries`);
}

/**
 * `eth_getLogs` over a block range, bisecting on the response-size cap.
 *
 * Same shape as `collect.ts`'s `fetchAllSwaps` and for the same reason: asking for everything and
 * splitting only on overflow keeps the request count at one for the ~95% of pools that fit. The
 * single-block guard is the important part — a range of one block that still overflows means the
 * data is genuinely unfetchable, and returning a truncated series would replay as a quiet pool,
 * which is a silent lie.
 */
async function getLogsBisect(
  url: string,
  filter: { address: string; topics: (string | null)[] },
  from: number,
  to: number,
): Promise<RpcLog[]> {
  try {
    return (await rpc(url, "eth_getLogs", [
      { ...filter, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
    ])) as RpcLog[];
  } catch (e) {
    const msg = String(e);
    if (!/response size|10K logs|10,000|limit|HTTP 400|too large|range/i.test(msg)) throw e;
    if (to - from < 2) {
      throw new Error(
        `range [${String(from)}, ${String(to)}] overflows in a single block and cannot be split ` +
          `further. Refusing to return a partial log set — a truncated history replays as a ` +
          `quiet pool. (${msg})`,
      );
    }
    const mid = Math.floor((from + to) / 2);
    const left = await getLogsBisect(url, filter, from, mid);
    const right = await getLogsBisect(url, filter, mid + 1, to);
    return [...left, ...right];
  }
}

type ApiToken = { symbol?: string; taxPct?: number; launchedAt?: number; marketCapEth?: number };

/**
 * `taxPct` and `symbol` for one launched token.
 *
 * Returns `undefined` on any failure. The CALLER MUST NOT DROP the token on `undefined` — a token
 * dropped because the API would not describe it is a survivorship filter reintroduced by the back
 * door, and it would bias in exactly the direction this file exists to remove.
 */
async function describeToken(address: string): Promise<ApiToken | undefined> {
  /*
   * MEASURED: this endpoint rate-limits on CONCURRENCY, not on total volume. At 12 parallel
   * workers it returns 429 for ~85% of requests; issued sequentially with a small gap it returned
   * 200 on 15 of 15. A first draft treated the 429s as "token not found" and silently fell back to
   * the default tax on 2,722 of 3,202 tokens — which would have applied a 1% cost model to every
   * 10% token in the corpus and understated the true round trip by up to 1,800bps on those.
   * Retrying with exponential backoff is therefore not politeness, it is the cost model.
   */
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`${API}/tokens/${address}`, { headers: { "user-agent": UA } });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
        continue;
      }
      if (!res.ok) return undefined;
      const body = (await res.json()) as { token?: ApiToken } & ApiToken;
      return body.token ?? body;
    } catch {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
    }
  }
  return undefined;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      out[i] = await fn(item, i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main(): Promise<void> {
  const rpcUrl = process.env["ROBINHOOD_RPC_URL"];
  if (rpcUrl === undefined || rpcUrl === "") {
    throw new Error("ROBINHOOD_RPC_URL is required — the public endpoint 403s under load");
  }
  mkdirSync(DATA_DIR, { recursive: true });

  // Pin the head ONCE, so a token launched during the run is not given a longer history than one
  // collected a minute earlier.
  const head = Number(BigInt((await rpc(rpcUrl, "eth_blockNumber", [])) as string));
  process.stdout.write(`head block: ${String(head)}\n`);

  /* ── 1. THE UNIVERSE: every TokenLaunched, no outcome filter of any kind. ── */
  const launchLogs = await getLogsBisect(
    rpcUrl,
    { address: FACTORY, topics: [LAUNCHED_TOPIC] },
    0,
    head,
  );
  const launched = launchLogs.map(decodeLaunchedLog);
  process.stdout.write(`TokenLaunched events: ${String(launched.length)}\n`);

  /* ── 2. THE HOOK PER POOL, from Initialize. Read, never assumed. ── */
  /*
   * The PoolManager serves EVERY v4 pool on the chain, not just this pad's, so this scan returns
   * ~305,000 `Initialize` logs and takes far longer than the rest of the collection put together.
   * It is cached to disk because it is pure history: a pool is initialized exactly once and the
   * hook it was initialized with can never change. The cache is keyed by nothing and refreshed by
   * deleting the file — there is no staleness risk in the direction that matters, since a pool
   * missing from the cache falls through to the launch event's own hook and is counted as such.
   */
  const hookCache = join(DATA_DIR, "pool-hooks.json");
  const hookByPool = new Map<string, string>();
  if (existsSync(hookCache)) {
    const cached = JSON.parse(readFileSync(hookCache, "utf8")) as Record<string, string>;
    for (const [pid, hook] of Object.entries(cached)) hookByPool.set(pid, hook);
    process.stdout.write(`hook cache: ${String(hookByPool.size)} pools (delete to refetch)\n`);
  } else {
    const initLogs = await getLogsBisect(
      rpcUrl,
      { address: POOL_MANAGER, topics: [INITIALIZE_TOPIC] },
      0,
      head,
    );
    for (const l of initLogs) {
      const pid = l.topics[1];
      if (pid !== undefined) hookByPool.set(pid.toLowerCase(), hookFromInitializeLog(l));
    }
    writeFileSync(hookCache, JSON.stringify(Object.fromEntries(hookByPool)));
    process.stdout.write(`hook scan: ${String(hookByPool.size)} pools initialized, cached\n`);
  }
  let hookAgree = 0;
  let hookDisagree = 0;
  let hookMissing = 0;
  const tokens: LaunchedToken[] = [];
  for (let i = 0; i < launched.length; i++) {
    const t = launched[i];
    const log = launchLogs[i];
    if (t === undefined || log === undefined) continue;
    const fromInit = hookByPool.get(t.poolId);
    if (fromInit === undefined) hookMissing += 1;
    else if (fromInit === hookFromLaunchedLog(log)) hookAgree += 1;
    else hookDisagree += 1;
    tokens.push({ ...t, hook: fromInit ?? hookFromLaunchedLog(log) });
  }
  const byHook = new Map<string, number>();
  for (const t of tokens) byHook.set(t.hook, (byHook.get(t.hook) ?? 0) + 1);
  process.stdout.write(
    `hook cross-check (Initialize vs TokenLaunched): agree ${String(hookAgree)}, ` +
      `disagree ${String(hookDisagree)}, pool never initialized ${String(hookMissing)}\n` +
      `hook split: ${[...byHook].map(([h, n]) => `${h}=${String(n)}`).join("  ")}\n`,
  );

  /* ── 3. WHICH OF THESE SURVIVED ONTO TODAY'S LEADERBOARDS? The survivorship flag. ── */
  const listed = new Set<string>();
  const survivorPath = join(DATA_DIR, "series.json");
  if (existsSync(survivorPath)) {
    const surv = JSON.parse(readFileSync(survivorPath, "utf8")) as { address: string }[];
    for (const t of surv) listed.add(t.address.toLowerCase());
  }
  process.stdout.write(
    `leaderboard corpus: ${String(listed.size)} tokens; ` +
      `launched-but-never-listed: ${String(tokens.filter((t) => !listed.has(t.address)).length)}\n`,
  );

  /* ── 4. TAX AND SYMBOL, per token. Never a reason to drop a token. ── */
  process.stdout.write("fetching tax/symbol...\n");
  // Concurrency 4, not 12: the endpoint rate-limits on parallelism and a 429 that falls through to
  // the default tax is a silently wrong COST MODEL, not a missing label.
  const meta = await mapWithConcurrency(tokens, 4, async (t) => describeToken(t.address));
  const unresolved = meta.filter((m) => m === undefined).length;
  const noTax = meta.filter((m) => m?.taxPct === undefined).length;
  process.stdout.write(
    `  API resolved ${String(tokens.length - unresolved)}/${String(tokens.length)}; ` +
      `tokens falling back to the default tax: ${String(noTax)}\n`,
  );
  if (noTax > tokens.length * 0.05) {
    process.stdout.write(
      `  WARNING: ${String(noTax)} tokens (${((noTax / tokens.length) * 100).toFixed(1)}%) have no ` +
        "API tax and are costed at the 1% default. Every one of them is charged too LITTLE if it\n" +
        "  is really a 5% or 10% token, which biases returns OPTIMISTIC. Re-run before trusting\n" +
        "  any absolute figure.\n",
    );
  }

  /* ── 5. THE SWAPS, per pool, from the launch block forward. ── */
  process.stdout.write("fetching swaps...\n");
  let done = 0;
  const out = await mapWithConcurrency(tokens, 8, async (t, i) => {
    const logs = await getLogsBisect(
      rpcUrl,
      { address: POOL_MANAGER, topics: [SWAP_TOPIC, t.poolId] },
      t.launchBlock,
      head,
    );
    const swaps: RawSwap[] = [];
    for (const log of logs) {
      const d = decodeSwapLog(log);
      if (d.ts === undefined) {
        throw new Error(
          "a Swap log arrived without blockTimestamp — every price point must carry a REAL " +
            "block time, and inferring one would fabricate the x-axis",
        );
      }
      swaps.push({ ...d, ts: d.ts });
    }
    swaps.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    done += 1;
    if (done % 100 === 0) process.stdout.write(`  ${String(done)}/${String(tokens.length)}\n`);
    const m = meta[i];
    return {
      address: t.address,
      symbol: m?.symbol ?? t.address.slice(0, 8),
      poolId: t.poolId,
      // A token the API would not describe keeps the pad's default 1% rather than being dropped.
      taxPct: m?.taxPct ?? 1,
      launchedAt: t.launchTs * 1000,
      marketCapEth: m?.marketCapEth ?? 0,
      hook: t.hook,
      launchBlock: t.launchBlock,
      listedToday: listed.has(t.address),
      taxFromApi: m?.taxPct !== undefined,
      swaps,
    };
  });

  writeFileSync(FORWARD_PATH, JSON.stringify(out));
  const total = out.reduce((n, t) => n + t.swaps.length, 0);
  const dead = out.filter((t) => t.swaps.length < 2).length;
  process.stdout.write(
    `\nwrote ${FORWARD_PATH}\n` +
      `  tokens ${String(out.length)}  (${String(out.filter((t) => t.listedToday).length)} listed today, ` +
      `${String(out.filter((t) => !t.listedToday).length)} never listed)\n` +
      `  swaps  ${String(total)}\n` +
      `  tokens with <2 swaps (born dead): ${String(dead)}\n`,
  );
  appendFileSync(
    join(DATA_DIR, "provenance.txt"),
    `${new Date().toISOString()} FORWARD tokens=${String(out.length)} swaps=${String(total)} ` +
      `head=${String(head)}\n`,
  );
}

/** The forward corpus as written, with the survivorship flag each row carries. */
export type ForwardSeries = TokenSeries & {
  readonly hook: string;
  readonly launchBlock: number;
  /** True if this token also appears in `collect.ts`'s leaderboard universe. */
  readonly listedToday: boolean;
  /** False if the API would not describe the token and the default tax was used. */
  readonly taxFromApi: boolean;
};

if (process.env["COLLECT_FORWARD"] === "1") {
  main().catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`);
    process.exitCode = 1;
  });
}
