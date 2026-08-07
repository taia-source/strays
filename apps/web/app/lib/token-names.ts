/**
 * ADDRESS → TICKER, so a trade row can name what the cat actually bought.
 *
 * Ibrahim, on `/logs`: *"why not showing pnls in logs and what token it bought?"* The row read
 * `HUNT bought 561427.711 units for 0.0012 ETH` — 561 thousand units of WHAT. The vault's own
 * `Entered`/`Exited` events carry the token address in an indexed arg and the page was decoding it
 * and throwing it away. A hex address is technically the answer and is not a readable one, so this
 * resolves it to the ticker the launchpad itself publishes.
 *
 * ══ WHY A SEPARATE MODULE FROM `quarry.ts` ══
 *
 * `quarry.ts` reads the LIST endpoint for the world's field of live launches, and its rows expire —
 * a token that launched last week is off the list entirely. A traded token is by definition in the
 * PAST, so the list is exactly the wrong source: the tokens most likely to appear in a log are the
 * ones least likely to still be on the front page. This hits the DETAIL endpoint per address, which
 * answers for any token that ever launched.
 *
 * ══ THE UNRESOLVED CASE IS A FIRST-CLASS ANSWER, NOT A BLANK ══
 *
 * `symbolFor` returns `null` when the pad does not know an address or cannot be reached, and the
 * caller renders the truncated address instead. It must never invent a ticker and must never render
 * an empty cell — `@taia/rpc`'s rule, which this repo applies everywhere: **a fetch failure is a
 * failure mode, not a conclusion.** "We could not name this token" and "this token has no name" are
 * different facts, and the address is always shown regardless so the row is verifiable either way.
 *
 * ══ THE USER-AGENT IS LOAD-BEARING ══
 *
 * `api.letscash.fun` sits behind Cloudflare and 403s a default UA (RESEARCH §5 — it 403s Python's).
 * Sending one explicitly is the difference between a working integration and a page full of
 * unresolved addresses, so it is set here rather than left to whatever the runtime happens to send.
 */
import { PAD_API } from "./config";

const HEADERS = { accept: "application/json", "user-agent": "strays-web/0.1" };

/**
 * The process-wide cache.
 *
 * A log page renders ~100 rows drawn from a handful of distinct tokens, so the naive version is
 * dozens of identical HTTP requests per render against an API with a measured 240-req/60s budget.
 * `null` is cached as deliberately as a hit: a 404 means the pad does not know this address and
 * asking again on the next render will not change that.
 *
 * A plain `Map` on the module, not a `Map` per request: the page is `revalidate = 15`, so the cache
 * outliving one render is the entire point. Tickers are fixed at launch and never change, so this
 * has no staleness window worth bounding — which is exactly why the same trick would be wrong for
 * a price.
 */
const cache = new Map<string, string | null>();

/** In-flight requests, so N rows of the same token cause ONE fetch rather than N. */
const inflight = new Map<string, Promise<string | null>>();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * The ticker for one address, or `null` if the pad cannot name it.
 *
 * Never throws. A caller rendering a log row must not have its whole page taken out because one
 * token lookup timed out — the row degrades to the address, which was always going to be shown
 * anyway.
 */
export async function symbolFor(address: string, timeoutMs = 5000): Promise<string | null> {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;

  const task = (async (): Promise<string | null> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${PAD_API}/tokens/${address}`, {
        headers: HEADERS,
        signal: ctl.signal,
        cache: "no-store",
      });
      if (!res.ok) {
        // A 404 is a real answer — the pad does not know this token — and is cached as one. A 5xx
        // or a 403 is NOT, so it is left uncached and retried on the next render.
        if (res.status === 404) cache.set(key, null);
        return null;
      }
      const body: unknown = await res.json();
      if (!isRecord(body)) return null;
      const sym = body.symbol;
      const out = typeof sym === "string" && sym !== "" ? sym : null;
      cache.set(key, out);
      return out;
    } catch {
      // Timeout, abort, DNS, malformed JSON. Uncached: the next render gets a fresh attempt.
      return null;
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/**
 * Resolve a whole set at once.
 *
 * `Promise.all` over the DEDUPLICATED set, not over the rows: a hundred-row page with four distinct
 * tokens makes four requests. Every one already cannot reject, so there is no `allSettled` needed.
 */
export async function symbolsFor(
  addresses: Iterable<string>,
): Promise<ReadonlyMap<string, string | null>> {
  const unique = [...new Set([...addresses].map((a) => a.toLowerCase()))];
  const pairs = await Promise.all(unique.map(async (a) => [a, await symbolFor(a)] as const));
  return new Map(pairs);
}

/** The fallback label: a truncated address, which is honest and still recognisable. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
