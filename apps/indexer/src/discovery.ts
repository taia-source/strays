/**
 * Finding tokens a stray is allowed to hunt.
 *
 * ══ THE API IS UNOFFICIAL, AND THIS MODULE IS SHAPED AROUND THAT ══
 *
 * `api.letscash.fun` has no OpenAPI spec, no published docs, and no stability guarantee. Its routes
 * were recovered from the site's JS bundle (RESEARCH §5). It is fast, free, unauthenticated and
 * CORS-open, so it is worth using — but **it can change or vanish without notice, and a product
 * that hard-fails when it does is a product that stops trading for a reason unrelated to trading.**
 *
 * So every field this module depends on is either (a) re-derivable from chain, or (b) explicitly
 * marked as fatal-if-missing. `fetchCandidates` returns a discriminated result rather than throwing,
 * and the caller decides whether to degrade or halt. `@taia/rpc`'s rule applies: a fetch failure is
 * a failure mode, not a conclusion — never conclude "there are no tokens" from a 500.
 *
 * ══ THREE API BEHAVIOURS MEASURED THE HARD WAY, 2026-08-07 ══
 *
 * 1. **The LIST endpoint omits `tickSpacing` and `volumeEth`.** Both are DETAIL-endpoint only.
 *    `tickSpacing` is required to build a PoolKey, so a candidate is not tradeable until its detail
 *    has been fetched. Discovered by a `KeyError` while picking a token for the live-fire test.
 * 2. **The API 403s on Python's default User-Agent but serves `curl` fine.** It is fronted by
 *    Cloudflare. `fetch` from Node works, but a UA is sent explicitly here rather than relying on
 *    the runtime's default staying acceptable.
 * 3. **Rate limit is 240 requests / 60s**, from the `ratelimit` response header. One detail fetch
 *    per candidate per cycle would blow that at scale, so details are cached by address and only
 *    re-fetched when stale.
 *
 * ══ AND A FOURTH, MEASURED 2026-08-07 WHILE WIRING THE MULTI-SLOT KEEPER ══
 *
 * 4. **The pad does not tell you which HOOK a token's pool uses in the list response, and there are
 *    two of them.** RESEARCH §7d is the finding; `resolveHook` below is the fix. A PoolKey is
 *    (currency0, currency1, fee, tickSpacing, HOOKS) and four fifths of a key addresses nothing —
 *    the v1 vault hardcoded one hook and therefore could not trade LEVCAT, INTERN or Seriouscat at
 *    all, which are three of the four highest-volume names on the pad.
 */

import { KNOWN_HOOKS } from "@strays/hunt";
import { encodeAbiParameters, keccak256 } from "viem";

/**
 * The market cap every UNTRADED token on this pad reports, in ETH.
 *
 * MEASURED: 84 of the newest 100 tokens sit at exactly 1.356 ETH, because that is the seed value a
 * launch is initialised to before anyone buys. So "above the seed" means "somebody has actually
 * bought this", and it split the pad almost perfectly — `> 1.36` was sellable 15/15, `<= 1.36` was
 * sellable 1/85.
 *
 * This constant replaces `HUNTABLE_TAX_PCT = 1`, which asserted a rule that no longer exists: tax
 * is a COST TERM priced in `@strays/hunt`'s `score.ts`, not a filter. Leaving the old constant in
 * place would have been a comment claiming a policy the code no longer implements.
 */
export const SEED_MARKET_CAP_ETH = 1.356;

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * RESOLVING A TOKEN'S HOOK — RESEARCH §7d
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * There are exactly two hooks on this pad and **the list endpoint does not say which one a token
 * uses**. It does say `pool`, which is the v4 poolId, and a poolId is a hash of the whole PoolKey:
 *
 *     poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
 *
 * Four of those five fields we already know for a pad launch — currency0 is native ETH (address 0),
 * currency1 is the token, fee is 0, and tickSpacing comes from the detail endpoint. So the hook is
 * the ONE unknown in an equation whose output we can read, and there are only two candidates.
 * Reconstruct the poolId with each and see which one reproduces the pad's own `pool` field.
 *
 * ══ WHY DERIVE IT RATHER THAN READ `hookAddress` FROM THE DETAIL ENDPOINT ══
 *
 * The detail endpoint DOES expose a `hookAddress` field, and MEASURED over 20 live tokens it agreed
 * with the reconstruction 20/20. It is used below as a fast path — but only ever CONFIRMED against
 * the reconstruction, never trusted alone, and the reconstruction is what decides.
 *
 * That is not paranoia about this specific field; it is RESEARCH §7d's own lesson about how the
 * two-hook bug hid for an entire build: *"A single-sample verification of a two-valued field cannot
 * fail. The reconstruction matched because the sample was homogeneous, not because the derivation
 * was right."* An unofficial API's undocumented field naming the most dangerous argument in the
 * contract is exactly the input that deserves to be checked against arithmetic we control. The
 * check costs a keccak256 — no network, no gas — and it fails CLOSED: a token whose hook cannot be
 * confirmed is not traded.
 *
 * ══ WHAT "MATCHING NEITHER" MEANS, AND WHY THOSE TOKENS ARE SKIPPED RATHER THAN GUESSED ══
 *
 * RESEARCH §7d measured 67 / 44 / **3 unmatched**. The unmatched ones are not a defect in this
 * routine: they are pools quoted in something other than native ETH (USDG, LAC, LETSBANK), so
 * currency0 is not address(0) and the key we are reconstructing is not their key. We cannot trade
 * them anyway — the vault swaps native ETH and only native ETH — so they are dropped with a reason
 * rather than defaulted onto a hook. Defaulting would address a pool that does not exist, and
 * §7d records what that failure looks like: an empty inner revert wrapped in
 * `UnexpectedRevertBytes`, which reads exactly like a transient RPC problem and hides for weeks.
 */

/** Native ETH is currency0 for every pad pool we can trade. Not a guess — the vault sends ETH. */
const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000" as const;

/** Pad pools are created with a zero LP fee; the tax is taken by the hook, not by the fee tier. */
const POOL_FEE = 0;

/**
 * Reconstruct the v4 poolId for one (token, tickSpacing, hook) triple.
 *
 * `encodeAbiParameters` rather than string concatenation: a PoolKey is a struct of five ABI-encoded
 * 32-byte words, and hand-packing addresses is how you get a hash that is subtly wrong for the two
 * signed/short types here (`uint24` fee and `int24` tickSpacing both left-pad, and a negative
 * tickSpacing would sign-extend). Letting viem encode it means the bytes are the same bytes
 * `PoolManager` hashed.
 */
export function poolIdFor(token: string, tickSpacing: number, hook: string): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [NATIVE_CURRENCY, token as `0x${string}`, POOL_FEE, tickSpacing, hook as `0x${string}`],
    ),
  );
}

/**
 * WHICH HOOK DOES THIS TOKEN'S POOL USE? Returns `null` when neither candidate reproduces the
 * pad's poolId.
 *
 * PURE — no network, no chain. Everything it needs is already in hand by the time it is called,
 * which is what lets `discovery.test.ts` measure it against recorded rows rather than against the
 * live pad.
 *
 * The comparison is lowercased on both sides because the pad, the RPC and our own constants
 * disagree about EIP-55 checksum casing depending on which produced the string — `hook.ts` makes
 * the same point about the allowlist, and a hex comparison that fails on case is a comparison that
 * silently refuses every legitimate token from one data source.
 */
export function resolveHook(args: {
  readonly token: string;
  readonly tickSpacing: number;
  readonly poolId: string;
}): string | null {
  const want = args.poolId.trim().toLowerCase();
  for (const hook of KNOWN_HOOKS) {
    if (poolIdFor(args.token, args.tickSpacing, hook).toLowerCase() === want) return hook;
  }
  return null;
}

export type TokenSummary = {
  readonly address: `0x${string}`;
  readonly symbol: string;
  readonly name: string;
  readonly taxPct: number;
  readonly marketCapEth: number;
  readonly change24hPct: number | null;
  readonly launchedAt: number;
  readonly pool: `0x${string}`;
};

/** A candidate with everything needed to actually build a swap. */
export type Candidate = TokenSummary & {
  /** Required to build the PoolKey. NOT available from the list endpoint. */
  readonly tickSpacing: number;
  /**
   * THE POOL'S HOOK, resolved by reconstructing the poolId. The other fifth of the PoolKey.
   *
   * Not optional and not defaulted: a `Candidate` exists only if its hook was CONFIRMED, because a
   * candidate carrying a guessed hook is a candidate that will address a nonexistent pool and
   * revert with empty bytes (RESEARCH §7d). `parseDetail` returns `null` instead.
   */
  readonly hook: string;
  readonly priceEth: number;
  readonly holders: number;
  readonly volume24hEth: number;
  /**
   * REALISED SWAPS AGAINST THIS POOL, and the number the entry gate is indexed by.
   *
   * ⚠ **A FLOOR, NOT AN EXACT LIFETIME COUNT, AND THE CEILING IS 100.** Stated plainly because the
   * honest description of a measured limitation belongs next to the number it limits.
   *
   * MEASURED on the live pad: `GET /api/tokens/{addr}/trades` hard-caps at **100 rows** — `limit`
   * values of 100, 200, 500 and 1000 all return exactly 100 — and it exposes **no total, no cursor
   * and no working pagination** (`page=2` and `offset=100` both return the same first row as page
   * 1). There is no field anywhere in the list or detail responses carrying a swap count. So this
   * is `min(realised swaps, 100)`, counted from the rows the endpoint will actually serve.
   *
   * ══ WHY THAT IS SOUND FOR THE GATE IT FEEDS, AND WHERE IT IS NOT ══
   *
   * `age.ts`'s window is **[20, 50] swaps**, which sits entirely below the 100-row cap. Inside the
   * window the count is EXACT, which is the only region where the gate's answer depends on the
   * value. Saturation at 100 can only occur above the ceiling, where the verdict is "too old —
   * refuse" either way; a token pinned at 100 is refused for being past swap 50, and it would have
   * been refused at its true count too. **The failure is therefore in the safe direction: it can
   * only ever refuse a trade, never admit one the gate would have refused.**
   *
   * Where it IS wrong: a token with, say, 400 lifetime swaps reports 100 in `/logs`, so the
   * displayed figure understates a mature token's activity. That is cosmetic here because nothing
   * downstream reads it except the gate — but it must not be reused as a volume or activity metric
   * without re-deriving it, and it is documented rather than quietly rounded because RESEARCH §7g
   * is about the gap between what a number claims and what it measures.
   *
   * The exact count is recoverable from chain by counting the pool's `Swap` events since launch.
   * That is a real indexer with real storage and it is not built; this is what the pad will serve.
   */
  readonly swapCount: number;
  /** When this row was read, so nothing downstream can render an unstamped figure. */
  readonly observedAt: number;
  readonly observedBlock: bigint;
};

export type DiscoveryResult =
  | { readonly ok: true; readonly candidates: readonly Candidate[]; readonly scanned: number }
  | { readonly ok: false; readonly reason: string; readonly recoverable: boolean };

const API = "https://api.letscash.fun/api";

/**
 * A User-Agent is sent explicitly. Measured: the API 403s Python's default UA. Node's default is
 * currently accepted, but depending on a runtime default staying acceptable is how a working
 * integration breaks on a version bump.
 */
const HEADERS = { accept: "application/json", "user-agent": "strays-indexer/0.1" };

async function getJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Parse a list row. Returns `null` rather than throwing on a shape change, so one malformed row
 * cannot take down a whole discovery cycle — the API is unofficial and its shape is not a contract.
 */
export function parseSummary(raw: unknown): TokenSummary | null {
  if (!isRecord(raw)) return null;
  const { address, symbol, name, taxPct, marketCapEth, change24hPct, launchedAt, pool } = raw;
  if (typeof address !== "string" || !address.startsWith("0x")) return null;
  if (typeof taxPct !== "number") return null;
  if (typeof marketCapEth !== "number") return null;
  if (typeof pool !== "string" || !pool.startsWith("0x")) return null;
  return {
    address: address as `0x${string}`,
    symbol: typeof symbol === "string" ? symbol : "",
    name: typeof name === "string" ? name : "",
    taxPct,
    marketCapEth,
    change24hPct: typeof change24hPct === "number" ? change24hPct : null,
    launchedAt: typeof launchedAt === "number" ? launchedAt : 0,
    pool: pool as `0x${string}`,
  };
}

/**
 * Parse a detail row into the fields a swap actually needs.
 *
 * `tickSpacing` is FATAL if missing: without it the PoolKey cannot be built, and a guessed value
 * produces a poolId for a pool that does not exist. Guessing here would mean routing a real trade
 * into an uninitialised pool, which does not fail cleanly — it prices against an empty book.
 *
 * **So is the HOOK**, for exactly the same reason and with the same consequence: it is the fifth
 * field of the same PoolKey. It is resolved rather than read (see `resolveHook`), and a token whose
 * hook does not reconstruct is returned as `null` — dropped, never defaulted onto the more common
 * hook. RESEARCH §7d: the tokens that match neither are non-ETH-quoted pools (USDG, LAC,
 * LETSBANK) that this vault could not trade in any case.
 *
 * `swapCount` is supplied by the CALLER rather than parsed, because it needs a second request. It
 * defaults to `-1` — deliberately not 0. `withinEntryWindow` refuses a negative count outright,
 * whereas 0 is a real and highly attractive dose (the earliest measured, +9,791bps median), so a
 * failed or un-attempted read defaulting to 0 would forge the most tempting value in the range out
 * of missing data. `age.ts` makes the same argument in its own refusal path.
 */
export function parseDetail(
  raw: unknown,
  at: { time: number; block: bigint },
  swapCount = -1,
): Candidate | null {
  const summary = parseSummary(raw);
  if (!summary || !isRecord(raw)) return null;
  const { tickSpacing, priceEth, holders, volumeEth } = raw;
  if (typeof tickSpacing !== "number") return null; // fatal — see above
  if (typeof priceEth !== "number" || !(priceEth > 0)) return null;

  /*
   * THE HOOK, derived from the pad's own poolId. Fatal if it does not reconstruct.
   *
   * The detail endpoint's `hookAddress` is used only as a cross-check: when present it must AGREE
   * with the reconstruction, and a disagreement drops the token. Two sources that disagree about
   * which pool a trade addresses is precisely the situation where picking one is a coin flip with
   * a user's money on it, and §7d records that the losing side of that flip reverts with empty
   * bytes that read like an RPC blip.
   */
  const hook = resolveHook({
    token: summary.address,
    tickSpacing,
    poolId: summary.pool,
  });
  if (hook === null) return null;
  const claimed = raw.hookAddress;
  if (typeof claimed === "string" && claimed.trim().toLowerCase() !== hook.toLowerCase()) {
    return null;
  }

  const day = isRecord(volumeEth) && typeof volumeEth.day === "number" ? volumeEth.day : 0;
  return {
    ...summary,
    tickSpacing,
    hook,
    priceEth,
    holders: typeof holders === "number" ? holders : 0,
    volume24hEth: day,
    swapCount,
    observedAt: at.time,
    observedBlock: at.block,
  };
}

/**
 * The number of realised swaps the pad will admit to for one token.
 *
 * Counts the rows `GET /api/tokens/{addr}/trades` returns. See `Candidate.swapCount` for the
 * measured limitation this carries — the endpoint caps at 100 rows with no total and no
 * pagination, so this is `min(true count, 100)` and it is exact only below the cap. The entry
 * window is [20, 50], which is entirely below it.
 *
 * Returns `-1` on any failure rather than 0, and the distinction is the whole point: 0 is the
 * earliest and most attractive dose on the measured curve, so reading a network error as "swap 0"
 * would manufacture the single most tempting entry signal out of a failed request.
 * `withinEntryWindow` refuses a negative count and says why.
 */
export async function fetchSwapCount(address: string): Promise<number> {
  try {
    const raw = await getJson(`${API}/tokens/${address}/trades?limit=100`);
    if (!isRecord(raw) || !Array.isArray(raw.trades)) return -1;
    return raw.trades.length;
  } catch {
    return -1;
  }
}

/**
 * Holder concentration from `GET /api/tokens/{addr}/holders`.
 *
 * This endpoint was undocumented in RESEARCH.md and turns out to expose exactly the fields the rug
 * literature says matter — including `snipers`, which is BUNDLE DETECTION the pad computes for us.
 *
 * That last one is the valuable one. The strongest empirical finding on concentration is that naive
 * top-10 systematically understates risk because bundled wallets hide behind it: resolving bundles
 * into beneficial owners raises measured top-10 concentration by a median 24 points for high-risk
 * tokens vs 6 for low-risk (MemeTrans, arXiv:2602.13480, 41,470 migrated memecoins). We could not
 * compute that ourselves — it needs wallet clustering across the whole chain — and the pad
 * publishes the answer.
 *
 * Returns `null` on any failure. A token whose concentration we cannot read is a token we do not
 * trade this tick: `@taia/rpc`'s rule that a fetch failure is a failure mode, not a conclusion, cuts
 * BOTH ways — we must not conclude "no tokens" from a 500, and we must not conclude "0% insider
 * concentration" from one either.
 */
export type HolderDistribution = {
  readonly top10Pct: number;
  readonly creatorPct: number;
  readonly creatorSold: boolean;
  readonly sniperCount: number;
  readonly sniperHeldPct: number;
};

export function parseHolders(raw: unknown): HolderDistribution | null {
  if (!isRecord(raw)) return null;
  const creator = isRecord(raw.creator) ? raw.creator : {};
  const snipers = isRecord(raw.snipers) ? raw.snipers : {};
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

  // `top10Pct` is the field the whole screen turns on. A missing one is fatal for this token
  // rather than defaulted to 0 — see the header.
  const top10Pct = num(raw.top10Pct);
  if (top10Pct === null) return null;

  return {
    top10Pct,
    creatorPct: num(creator.pct) ?? 0,
    creatorSold: creator.sold === true,
    sniperCount: num(snipers.count) ?? 0,
    // Likewise fatal if absent: reading a missing sniper figure as 0% would turn the most
    // important concentration signal we have into an automatic pass.
    sniperHeldPct: num(snipers.heldPct) ?? Number.NaN,
  };
}

export async function fetchHolders(address: string): Promise<HolderDistribution | null> {
  try {
    return parseHolders(await getJson(`${API}/tokens/${address}/holders`));
  } catch {
    return null;
  }
}

/**
 * Buys as a fraction of all trades, in bps, from `GET /api/tokens/{addr}/trades`.
 *
 * MEASURED range on live tokens: 0.33 .. 0.73. Feeds the momentum term of the score, which is a
 * multiplier in [0,1] and therefore cannot manufacture an edge — see `score.ts` on why this signal
 * is weighted modestly (early-buyer effects collapse to +16.1% after propensity matching,
 * arXiv:2607.02795).
 *
 * Returns `null` when there are no trades to measure, which the caller reads as "no momentum",
 * never as "balanced".
 */
export async function fetchBuyRatioBps(address: string, limit = 200): Promise<bigint | null> {
  try {
    const raw = await getJson(`${API}/tokens/${address}/trades?limit=${String(limit)}`);
    if (!isRecord(raw) || !Array.isArray(raw.trades)) return null;
    let buys = 0;
    let total = 0;
    for (const t of raw.trades) {
      if (!isRecord(t) || typeof t.side !== "string") continue;
      total++;
      if (t.side === "buy") buys++;
    }
    if (total === 0) return null;
    return BigInt(Math.round((buys / total) * 10_000));
  } catch {
    return null;
  }
}

/** Cache of detail rows, so the 240/60s budget is not spent re-reading static fields. */
const detailCache = new Map<string, { at: number; value: Candidate }>();
const DETAIL_TTL_MS = 60_000;

export function clearDetailCache(): void {
  detailCache.clear();
}

/**
 * Fetch the newest launches and return the ones worth spending a detail request on.
 *
 * ══ THE `taxPct === 1` PRE-FILTER IS GONE ══
 *
 * It used to be applied to the LIST before any detail was fetched. It is removed because tax is now
 * a COST TERM priced in `@strays/hunt`'s `score.ts`, not an exclusion — a 5%-tax token that moves
 * 30% is far more profitable than a 1%-tax token that moves 2%, and filtering by tier here would
 * mean the scoring model never sees the former.
 *
 * The rate limit is still survivable, because the filter that replaced it is STRICTER in practice
 * and is measured: market cap above the 1.356 ETH seed. 84 of the newest 100 tokens sit exactly on
 * the seed having never been bought, so this refuses ~85% of the list on a field the list endpoint
 * already returns — no extra request — where the tax filter refused ~67%.
 */
export async function fetchCandidates(opts: {
  readonly limit?: number;
  readonly now: number;
  readonly block: bigint;
  readonly minMarketCapEth?: number;
  readonly minHolders?: number;
}): Promise<DiscoveryResult> {
  const limit = opts.limit ?? 48;
  /*
   * ══ WHY THREE SORTS AND NOT `newest` ALONE ══
   *
   * `sort=newest` was the only source, and it is structurally incapable of supplying what the
   * strategy needs. MEASURED on live data: of the newest 48 tokens, 5 survive the seed-cap
   * prefilter and their ages are 1, 2, 8, 14 and 41 MINUTES. The signal measures a move over a
   * 60-minute window, so every candidate was refused with "age < 3600s" — the scanner and the
   * strategy were looking at disjoint sets and the cats could never trade.
   *
   * `sort=mcap` and `sort=trending` return established tokens: ages up to 573h and 235h, with
   * real volume. And they are dramatically safer — MEASURED with the sell simulation:
   *
   *     newest 40  ->   7 sellable  (18%)
   *     mature 11  ->  11 sellable (100%)
   *
   * `newest` is kept because a genuinely new token is the product's premise, and the sell
   * simulation is what makes including it safe rather than reckless.
   */
  let list: unknown;
  try {
    const [newest, mcap, trending] = await Promise.all([
      getJson(`${API}/tokens?sort=newest&limit=${limit}`),
      getJson(`${API}/tokens?sort=mcap&limit=${limit}`).catch(() => null),
      getJson(`${API}/tokens?sort=trending&limit=${limit}`).catch(() => null),
    ]);
    const merged: unknown[] = [];
    const seen = new Set<string>();
    for (const src of [mcap, trending, newest]) {
      if (!isRecord(src) || !Array.isArray(src.tokens)) continue;
      for (const row of src.tokens) {
        const addr = isRecord(row) && typeof row.address === "string" ? row.address.toLowerCase() : null;
        if (addr === null || seen.has(addr)) continue;
        seen.add(addr);
        merged.push(row);
      }
    }
    // One source failing must not empty the pond — a fetch failure is a failure mode, not a
    // conclusion. Only a total failure of all three is fatal.
    list = merged.length > 0 ? { tokens: merged } : newest;
  } catch (err) {
    // A fetch failure is a failure mode, not a conclusion. The caller must NOT read this as
    // "there are no tokens today" — that is how a service quietly stops trading.
    return { ok: false, reason: `token list unreachable: ${String(err)}`, recoverable: true };
  }

  if (!isRecord(list) || !Array.isArray(list.tokens)) {
    return { ok: false, reason: "token list shape changed - `tokens` is not an array", recoverable: false };
  }

  const summaries = list.tokens.map(parseSummary).filter((t): t is TokenSummary => t !== null);
  /*
   * MEASURED floor, replacing the tax tier filter. 1.40 ETH sits above the 1.356 ETH seed:
   * `> 1.36` was sellable 15/15, `<= 1.36` was sellable 1/85. The old default of 1.0 ETH sat BELOW
   * the minimum the field can take and refused nothing at all.
   */
  const huntable = summaries.filter(
    (t) => t.marketCapEth >= (opts.minMarketCapEth ?? SEED_MARKET_CAP_ETH + 0.044),
  );

  /*
   * ══ DETAIL FETCHES RUN IN PARALLEL, WITH A CAP ══
   *
   * This was a serial `for` loop, one detail fetch per candidate. MEASURED: 61 candidates at
   * ~500ms each = **30 SECONDS of a 34-second tick**, and it scales linearly with the pad. At a
   * 5-minute tick that is 10% of the cycle spent waiting on HTTP that could have been concurrent.
   *
   * The cap is the point, not the parallelism: the pad allows 240 req/60s, so 8 concurrent
   * requests at ~500ms each is ~16 req/s sustained — inside the budget with room, and far short
   * of the unbounded fan-out that would trip the rate limiter and turn a slow tick into no tick.
   */
  const candidates: Candidate[] = [];
  const DETAIL_CONCURRENCY = 8;

  const fetchOne = async (s: TokenSummary): Promise<Candidate | null> => {
    const cached = detailCache.get(s.address);
    if (cached && opts.now - cached.at < DETAIL_TTL_MS) return cached.value;
    try {
      /*
       * TWO requests per candidate now, not one: the detail row and the swap count.
       *
       * They are issued CONCURRENTLY rather than in sequence, so the added cost is one extra
       * request against the 240/60s budget rather than an extra round-trip of latency per
       * candidate. That budget is what the seed-cap prefilter above protects — it removes ~85% of
       * the list before either request is spent, which is what makes a second one affordable.
       *
       * The swap count is fetched even though the detail may turn out to be unusable, because
       * awaiting them in sequence to save the occasional wasted request would add ~500ms to EVERY
       * candidate. The measured tick budget is the scarcer resource: a serial detail loop already
       * cost 30 seconds of a 34-second tick once (see the note above).
       */
      const [raw, swapCount] = await Promise.all([
        getJson(`${API}/tokens/${s.address}`),
        fetchSwapCount(s.address),
      ]);
      const detail = parseDetail(raw, { time: opts.now, block: opts.block }, swapCount);
      if (!detail) return null; // a row we cannot build a swap from is skipped, never guessed at
      if (detail.holders < (opts.minHolders ?? 3)) return null;
      detailCache.set(s.address, { at: opts.now, value: detail });
      return detail;
    } catch {
      // One bad detail fetch must not fail the cycle.
      return null;
    }
  };

  for (let i = 0; i < huntable.length; i += DETAIL_CONCURRENCY) {
    const batch = await Promise.all(huntable.slice(i, i + DETAIL_CONCURRENCY).map(fetchOne));
    for (const d of batch) if (d !== null) candidates.push(d);
  }

  return { ok: true, candidates, scanned: summaries.length };
}
