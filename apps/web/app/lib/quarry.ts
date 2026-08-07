/**
 * THE QUARRY — the letscash tokens a stray is actually scanning, read live.
 *
 * ══ WHY THIS EXISTS SEPARATELY FROM `apps/indexer/src/discovery.ts` ══
 *
 * The indexer's `fetchCandidates` fetches a DETAIL row per candidate to recover `tickSpacing`,
 * because it is about to build a PoolKey and route real money. This module is not going to trade
 * anything — it feeds the world renderer, which needs a ticker, a market cap and a price change,
 * all of which the LIST endpoint already carries. Copying the detail fan-out here would spend the
 * measured 240-req/60s budget on fields nothing on this page renders, and it would do it on every
 * page load rather than once per keeper cycle.
 *
 * So: the same list endpoint, the same `taxPct === 1` huntability filter (RESEARCH §3c — the one
 * filter that decides whether this product can make money), and NO detail fetch.
 *
 * ══ THE RULE THIS FILE OBEYS ══
 *
 * `@taia/rpc`: **a fetch failure is a failure mode, not a conclusion.** Never conclude "there are no
 * tokens" from a 500. The return type is a discriminated union precisely so a caller cannot
 * accidentally render a failure as an empty world — there is no `readonly tokens: []` to fall
 * through to. The world renders "the quarry could not be read" instead, which is a different
 * sentence than "no tokens qualified".
 *
 * ══ THE API IS UNOFFICIAL ══
 *
 * `api.letscash.fun` has no spec and no stability guarantee (routes recovered from the site bundle,
 * RESEARCH §5). Every row parses defensively and one malformed row is skipped rather than fatal.
 * A User-Agent is sent explicitly: the API 403s Python's default UA behind Cloudflare, and
 * depending on a runtime default staying acceptable is how a working integration breaks silently on
 * a version bump.
 */
import { PAD_API } from "./config";

/** The one filter that decides whether this product can make money. RESEARCH §3c. */
export const HUNTABLE_TAX_PCT = 1;

/**
 * One token in the world, as the renderer needs it.
 *
 * Deliberately NOT the indexer's `Candidate`: no `tickSpacing`, no `priceEth`, because this module
 * does not fetch the detail endpoint and inventing either would be exactly the defect the whole
 * corpus is shaped against.
 */
export type QuarryToken = {
  readonly address: `0x${string}`;
  readonly symbol: string;
  readonly name: string;
  readonly taxPct: number;
  readonly marketCapEth: number;
  readonly change24hPct: number | null;
  /** Unix ms. 0 when the API omitted it — rendered as "age unknown", never as "just launched". */
  readonly launchedAt: number;
  readonly pool: `0x${string}`;
  /** True when it passes the tax filter a stray is allowed to hunt. */
  readonly huntable: boolean;
};

export type QuarryRead =
  | {
      readonly ok: true;
      readonly tokens: readonly QuarryToken[];
      /** How many rows the API returned before filtering — the honest denominator. */
      readonly scanned: number;
      /** Unix ms of the read. Every figure on this page carries its stamp. */
      readonly at: number;
    }
  | { readonly ok: false; readonly reason: string; readonly at: number };

const HEADERS = { accept: "application/json", "user-agent": "strays-web/0.1" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Parse one list row. `null` on a shape change rather than a throw, so one bad row cannot take out
 * the whole world. Only `address`, `taxPct`, `marketCapEth` and `pool` are load-bearing enough to
 * reject on — a token with a missing name is still a real token.
 */
export function parseToken(raw: unknown): QuarryToken | null {
  if (!isRecord(raw)) return null;
  const { address, symbol, name, taxPct, marketCapEth, change24hPct, launchedAt, pool } = raw;
  if (typeof address !== "string" || !address.startsWith("0x")) return null;
  if (typeof taxPct !== "number") return null;
  if (typeof marketCapEth !== "number") return null;
  if (typeof pool !== "string" || !pool.startsWith("0x")) return null;
  const sym = typeof symbol === "string" && symbol !== "" ? symbol : null;
  if (sym === null) return null; // a token with no ticker cannot be LABELLED in the world
  return {
    address: address as `0x${string}`,
    symbol: sym,
    name: typeof name === "string" ? name : sym,
    taxPct,
    marketCapEth,
    change24hPct: typeof change24hPct === "number" ? change24hPct : null,
    launchedAt: typeof launchedAt === "number" ? launchedAt : 0,
    pool: pool as `0x${string}`,
    huntable: taxPct === HUNTABLE_TAX_PCT,
  };
}

/**
 * Read the newest launches.
 *
 * `limit` is the API's own page size. The world renders at most `WORLD_QUARRY_CAP` of them (see
 * below) — asking for more than the field can hold would be paying for rows that get dropped, and
 * asking for fewer would mean the huntability filter could empty the field on a slow launch day.
 */
export const WORLD_QUARRY_CAP = 14;

export async function fetchQuarry(limit = 40, timeoutMs = 7000): Promise<QuarryRead> {
  const at = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let body: unknown;
  try {
    const res = await fetch(`${PAD_API}/tokens?sort=newest&limit=${limit}`, {
      headers: HEADERS,
      signal: ctl.signal,
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, reason: `letscash returned ${res.status}`, at };
    body = await res.json();
  } catch (err) {
    return {
      ok: false,
      reason: `letscash unreachable: ${err instanceof Error ? err.message : String(err)}`,
      at,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!isRecord(body) || !Array.isArray(body.tokens)) {
    return { ok: false, reason: "letscash list shape changed — `tokens` is not an array", at };
  }

  const parsed = body.tokens
    .map(parseToken)
    .filter((t): t is QuarryToken => t !== null);

  /*
   * HUNTABLE FIRST, then the rest by market cap.
   *
   * The world is showing what the keeper is SCANNING, and the huntable ones are the ones it can
   * actually act on — so they are the ones that must survive the cap. The non-huntable rows are
   * kept (dimmed in the render) rather than dropped, because "34 scanned, 9 huntable" is a truer
   * picture of the hunt than a field where every token is a valid target.
   */
  const ranked = [...parsed].sort((a, b) => {
    if (a.huntable !== b.huntable) return a.huntable ? -1 : 1;
    return b.marketCapEth - a.marketCapEth;
  });

  /*
   * ══ ONE ROW PER TICKER ══
   *
   * Memecoin launchpads have no ticker uniqueness — the live list routinely carries several
   * unrelated contracts all called MEDICI. Rendered on the field that is two identical diamonds
   * both labelled MEDICI, which looks like a rendering bug and is worse than one: a viewer cannot
   * tell which contract a cat is actually on, so the label stops being information.
   *
   * The FIRST occurrence survives, and because the list is already sorted huntable-first then by
   * market cap, that is the largest huntable one — the row a stray would actually pick. The dropped
   * duplicates are still counted in `scanned`, so the denominator stays honest: "14 on field of 40
   * scanned" does not claim the other 26 did not exist.
   *
   * De-duplicating on ADDRESS instead would be wrong here. The addresses genuinely differ; it is
   * the human-readable label that collides, and the label is what this layer renders.
   */
  const seen = new Set<string>();
  const unique = ranked.filter((t) => {
    const key = t.symbol.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { ok: true, tokens: unique.slice(0, WORLD_QUARRY_CAP), scanned: parsed.length, at };
}
