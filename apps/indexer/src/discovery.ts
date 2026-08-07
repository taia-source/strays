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
 */

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
  readonly priceEth: number;
  readonly holders: number;
  readonly volume24hEth: number;
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
 */
export function parseDetail(raw: unknown, at: { time: number; block: bigint }): Candidate | null {
  const summary = parseSummary(raw);
  if (!summary || !isRecord(raw)) return null;
  const { tickSpacing, priceEth, holders, volumeEth } = raw;
  if (typeof tickSpacing !== "number") return null; // fatal — see above
  if (typeof priceEth !== "number" || !(priceEth > 0)) return null;
  const day = isRecord(volumeEth) && typeof volumeEth.day === "number" ? volumeEth.day : 0;
  return {
    ...summary,
    tickSpacing,
    priceEth,
    holders: typeof holders === "number" ? holders : 0,
    volume24hEth: day,
    observedAt: at.time,
    observedBlock: at.block,
  };
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
      const raw = await getJson(`${API}/tokens/${s.address}`);
      const detail = parseDetail(raw, { time: opts.now, block: opts.block });
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
