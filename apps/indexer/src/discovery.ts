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

/** The one filter that decides whether this product can make money. See RESEARCH §3c. */
export const HUNTABLE_TAX_PCT = 1;

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

/** Cache of detail rows, so the 240/60s budget is not spent re-reading static fields. */
const detailCache = new Map<string, { at: number; value: Candidate }>();
const DETAIL_TTL_MS = 60_000;

export function clearDetailCache(): void {
  detailCache.clear();
}

/**
 * Fetch the newest launches and return the ones a stray may hunt.
 *
 * The `taxPct === 1` filter is applied to the LIST before any detail is fetched, which is both the
 * correct filter and the reason the rate limit is survivable: only ~33% of launches qualify, so
 * two thirds of the detail requests are never made.
 */
export async function fetchCandidates(opts: {
  readonly limit?: number;
  readonly now: number;
  readonly block: bigint;
  readonly minMarketCapEth?: number;
  readonly minHolders?: number;
}): Promise<DiscoveryResult> {
  const limit = opts.limit ?? 48;
  let list: unknown;
  try {
    list = await getJson(`${API}/tokens?sort=newest&limit=${limit}`);
  } catch (err) {
    // A fetch failure is a failure mode, not a conclusion. The caller must NOT read this as
    // "there are no tokens today" — that is how a service quietly stops trading.
    return { ok: false, reason: `token list unreachable: ${String(err)}`, recoverable: true };
  }

  if (!isRecord(list) || !Array.isArray(list.tokens)) {
    return { ok: false, reason: "token list shape changed - `tokens` is not an array", recoverable: false };
  }

  const summaries = list.tokens.map(parseSummary).filter((t): t is TokenSummary => t !== null);
  const huntable = summaries.filter(
    (t) => t.taxPct === HUNTABLE_TAX_PCT && t.marketCapEth >= (opts.minMarketCapEth ?? 1.0),
  );

  const candidates: Candidate[] = [];
  for (const s of huntable) {
    const cached = detailCache.get(s.address);
    if (cached && opts.now - cached.at < DETAIL_TTL_MS) {
      candidates.push(cached.value);
      continue;
    }
    try {
      const raw = await getJson(`${API}/tokens/${s.address}`);
      const detail = parseDetail(raw, { time: opts.now, block: opts.block });
      if (!detail) continue; // a row we cannot build a swap from is skipped, never guessed at
      if (detail.holders < (opts.minHolders ?? 3)) continue;
      detailCache.set(s.address, { at: opts.now, value: detail });
      candidates.push(detail);
    } catch {
      // One bad detail fetch must not fail the cycle. The token is simply not a candidate now.
    }
  }

  return { ok: true, candidates, scanned: summaries.length };
}
