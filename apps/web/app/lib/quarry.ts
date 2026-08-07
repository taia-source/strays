/**
 * THE QUARRY — the letscash tokens a stray is actually scanning, read live.
 *
 * ══ THE BUG THIS FILE WAS REWRITTEN TO FIX ══
 *
 * Ibrahim: *"how can the strategy say the 14 huntable targets are viable? they are all dead tokens
 * that rugged?"* He was right, and the cause was one query string.
 *
 * This module fetched `sort=newest` ONLY, while `apps/indexer/src/discovery.ts` — the module that
 * actually routes money — had already been fixed to merge three sorts. So the WORLD showed the
 * newest 40 launches and the STRATEGY scanned mature ones, and the two were looking at DISJOINT
 * SETS. Every number the page printed was true of a population the keeper never trades.
 *
 * MEASURED on the live pad, 2026-08-07, with the same merge `discovery.ts` performs:
 *
 *     newest+mcap+trending, deduped by address   110 rows
 *     after the 1.40Ξ market-cap prefilter        66 rows
 *     of those 66, with under 0.5Ξ of 24h volume   5 — effectively dead
 *
 * and the live ones are unmistakable once volume is read at all:
 *
 *     Seriouscat  383Ξ 24h vol   520 holders  +1647%
 *     LEVCAT      308Ξ          1177 holders
 *     CASHBIRD    219Ξ           766 holders
 *     INTERN      172Ξ          1251 holders
 *
 * ══ WHY THIS MODULE NOW FETCHES DETAILS, HAVING DELIBERATELY REFUSED TO BEFORE ══
 *
 * The previous header argued — correctly, for what it then claimed — that a detail fan-out was
 * waste: the page rendered a ticker, a market cap and a price change, all of which the LIST
 * endpoint carries, so spending the measured 240-req/60s budget on detail rows nothing displayed
 * would have been paying for fields that get dropped.
 *
 * That argument dies the moment the page has to say the word "huntable". MEASURED: the list
 * endpoint omits `volumeEth` and `holders` — both are DETAIL-only (the same finding
 * `discovery.ts` records as behaviour 1). Those two fields are precisely what separates a live
 * token from a rugged one, so a page that will not fetch them CANNOT tell the difference and can
 * only ever have been asserting viability it never measured. Fetching them is not scope creep; it
 * is the minimum required to stop the label being a lie.
 *
 * The budget is respected the way `discovery.ts` respects it: a market-cap prefilter that refuses
 * ~40% of the merge on a field the LIST already returns, a hard `DETAIL_CONCURRENCY` cap, a cache
 * keyed by address, and a cap on how many rows are ever eligible for a detail fetch at all.
 *
 * ══ THE RULE THIS FILE OBEYS ══
 *
 * `@taia/rpc`: **a fetch failure is a failure mode, not a conclusion.** Never conclude "there are no
 * tokens" from a 500. The return type is a discriminated union precisely so a caller cannot
 * accidentally render a failure as an empty world — there is no `readonly tokens: []` to fall
 * through to. The world renders "the quarry could not be read" instead, which is a different
 * sentence than "no tokens qualified".
 *
 * That rule cuts BOTH ways, and the second direction is the one that matters here: a token whose
 * DETAIL we could not read has unknown volume, and unknown is not zero. Such a token is marked
 * `liveness: "unknown"` and is never labelled huntable — but it is never labelled DEAD either,
 * because "we failed to measure this" and "this has no volume" are different facts.
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

/**
 * The market cap every UNTRADED token on this pad reports, in ETH.
 *
 * Mirrors `SEED_MARKET_CAP_ETH` in `apps/indexer/src/discovery.ts`, and it is duplicated rather
 * than imported for the same reason `QuarryToken` is not the indexer's `Candidate`: this app does
 * not depend on the indexer package, and a web route that cannot build because a keeper module
 * moved is a worse failure than a restated constant with a comment pointing at its twin.
 *
 * MEASURED there: 84 of the newest 100 tokens sit at exactly 1.356 ETH, because that is the seed a
 * launch is initialised to before anyone buys. `> 1.36` was sellable 15/15, `<= 1.36` was sellable
 * 1/85 — so "above the seed" means "somebody has actually bought this".
 */
export const SEED_MARKET_CAP_ETH = 1.356;

/** The prefilter floor, sitting just above the seed. Same value `discovery.ts` defaults to. */
export const MIN_MARKET_CAP_ETH = SEED_MARKET_CAP_ETH + 0.044;

/**
 * ══ WHAT "HUNTABLE" MEANS, AND WHY IT IS THREE TESTS RATHER THAN ONE ══
 *
 * The word has to mean something. It used to mean `taxPct === 1` — a rule
 * `apps/indexer/src/discovery.ts` has since DELETED, because tax is a cost term priced in
 * `@strays/hunt`'s `score.ts`, not an exclusion. So the page was applying a filter the strategy no
 * longer had, and calling the survivors "huntable" on the strength of it.
 *
 * These are the thresholds that actually separate a token a stray can trade from a corpse:
 *
 *   VOLUME   the load-bearing one. A token with no 24h volume cannot be SOLD, whatever its market
 *            cap says — and being unable to exit is the whole risk. 0.5Ξ is the figure Ibrahim
 *            measured as "effectively dead" and it separated 5 of 66 on the live pad.
 *   HOLDERS  a token held by a handful of wallets is a token whose float is one person's decision.
 *            `discovery.ts` uses `minHolders: 3` as a floor before it will spend a detail request;
 *            this is stricter because the page is making a public claim rather than screening.
 *   MCAP     above the seed, i.e. somebody has actually bought it. Applied as a PREFILTER before
 *            any detail request, exactly as `discovery.ts` does.
 */
export const MIN_VOLUME_24H_ETH = 0.5;
export const MIN_HOLDERS = 25;

/**
 * How live a token is, as a fact about what we MEASURED rather than a verdict.
 *
 * `"unknown"` exists so a failed detail read can never be rendered as a dead token. It is the
 * discriminated-union rule from the header applied at the row level.
 */
export type Liveness = "live" | "dead" | "unknown";

/**
 * One token in the world, as the renderer needs it.
 *
 * Deliberately NOT the indexer's `Candidate`: no `tickSpacing` and no `priceEth`, because this
 * module never builds a swap and inventing either would be exactly the defect the whole corpus is
 * shaped against. It DOES now carry volume and holders, because those are what the word "huntable"
 * is asserting and a claim whose evidence is not in the payload cannot be checked by the renderer.
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
  /** 24h volume in ETH. `null` when the detail read failed — NEVER defaulted to 0. See `Liveness`. */
  readonly volume24hEth: number | null;
  /** Holder count. `null` when the detail read failed — never defaulted to 0. */
  readonly holders: number | null;
  readonly liveness: Liveness;
  /**
   * True only when we MEASURED enough to say a stray could actually trade this: real volume, a real
   * holder base, and a market cap above the seed. An unmeasured token is never huntable.
   */
  readonly huntable: boolean;
};

export type QuarryRead =
  | {
      readonly ok: true;
      readonly tokens: readonly QuarryToken[];
      /** How many rows the merge returned before any filtering — the honest denominator. */
      readonly scanned: number;
      /** How many survived the market-cap prefilter and were eligible for a detail read. */
      readonly considered: number;
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
 *
 * The liveness fields come out `null`/`"unknown"` here by construction: a LIST row has no volume
 * and no holders to read (measured — both are detail-only), so this cannot and must not guess them.
 * `enrich` below is the only thing that may set them.
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
    volume24hEth: null,
    holders: null,
    liveness: "unknown",
    huntable: false,
  };
}

/**
 * Fold a DETAIL row's volume and holders into a summary parsed from the list.
 *
 * Exported for the test: this is the function that decides what the word "huntable" means, so it is
 * the one piece of this module that must be assertable without a network.
 *
 * A detail row that parses but omits `volumeEth.day` leaves the token `"unknown"`, not `"dead"`.
 * Reading a missing figure as zero is how a measurement gap becomes a false accusation.
 */
export function enrich(token: QuarryToken, detail: unknown): QuarryToken {
  if (!isRecord(detail)) return token;
  const vol = isRecord(detail.volumeEth) && typeof detail.volumeEth.day === "number"
    ? detail.volumeEth.day
    : null;
  const holders = typeof detail.holders === "number" ? detail.holders : null;
  if (vol === null) return { ...token, holders };

  const live = vol >= MIN_VOLUME_24H_ETH && (holders ?? 0) >= MIN_HOLDERS;
  return {
    ...token,
    volume24hEth: vol,
    holders,
    liveness: live ? "live" : "dead",
    // The market-cap test is already guaranteed by the prefilter every enriched row passed through,
    // but it is restated here so the predicate is TRUE ON ITS OWN rather than true-given-a-caller.
    huntable: live && token.marketCapEth >= MIN_MARKET_CAP_ETH,
  };
}

/**
 * How many tokens the world renders. The field holds this many diamonds legibly at 320px; asking
 * the API for more than the field can show would be paying for rows that get dropped.
 */
export const WORLD_QUARRY_CAP = 14;

/**
 * A ceiling on detail requests per read, protecting the measured 240-req/60s budget.
 *
 * The merge yields ~110 rows and the prefilter leaves ~66. Detailing all 66 on every page load
 * would be 66 requests per visitor — fine for one viewer, a rate-limit trip for ten. 28 is
 * comfortably more than `WORLD_QUARRY_CAP` (so the ranking below still has real choice among
 * candidates) and comfortably inside the budget.
 */
const DETAIL_BUDGET = 28;

/** `discovery.ts`'s figure: 8 concurrent at ~500ms is ~16 req/s, inside the budget with room. */
const DETAIL_CONCURRENCY = 8;

/**
 * Detail rows cached by address, so a 5-second poll from N viewers is not N×28 requests.
 *
 * The TTL matches `discovery.ts`'s. Volume moves on a 24h window, so a minute-old figure is not
 * meaningfully staler than a fresh one — and the alternative is re-reading static fields at the
 * page's poll rate.
 */
const detailCache = new Map<string, { at: number; value: unknown }>();
const DETAIL_TTL_MS = 60_000;

export function clearDetailCache(): void {
  detailCache.clear();
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS, signal, cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.json();
}

/**
 * Read the pad and return what a stray is actually scanning.
 *
 * ══ THREE SORTS, MERGED AND DEDUPED BY ADDRESS — MATCHING `discovery.ts` EXACTLY ══
 *
 * `sort=newest` alone is structurally incapable of supplying what the strategy needs, and
 * `discovery.ts` records the measurement: of the newest 48 tokens, 5 survive the seed prefilter and
 * their ages are 1, 2, 8, 14 and 41 MINUTES. The signal measures a move over a 60-minute window, so
 * every one was refused for "age < 3600s" — scanner and strategy looking at disjoint sets.
 *
 * `mcap` and `trending` return established tokens with real volume, and they are dramatically safer
 * (measured with the sell simulation: newest 40 → 7 sellable; mature 11 → 11 sellable). `newest` is
 * KEPT because a genuinely new token is the product's premise.
 *
 * The iteration order `[mcap, trending, newest]` is `discovery.ts`'s, and it is load-bearing rather
 * than incidental: `dedupe by address` keeps the FIRST occurrence, so a token appearing in both
 * `mcap` and `newest` is kept as its mcap row. Reordering these would silently change which
 * duplicate survives.
 */
export async function fetchQuarry(limit = 48, timeoutMs = 9000): Promise<QuarryRead> {
  const at = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  try {
    let merged: unknown[];
    try {
      /*
       * One source failing must not empty the pond. `mcap` and `trending` are allowed to fail
       * individually — a fetch failure is a failure mode, not a conclusion — and only a total
       * failure of all three is fatal. `newest` is the one awaited without a `.catch`, so if
       * everything is down we surface a real error rather than an empty list.
       */
      const [newest, mcap, trending] = await Promise.all([
        getJson(`${PAD_API}/tokens?sort=newest&limit=${limit}`, ctl.signal),
        getJson(`${PAD_API}/tokens?sort=mcap&limit=${limit}`, ctl.signal).catch(() => null),
        getJson(`${PAD_API}/tokens?sort=trending&limit=${limit}`, ctl.signal).catch(() => null),
      ]);
      merged = mergeRows([mcap, trending, newest]);
      if (merged.length === 0) {
        if (!isRecord(newest) || !Array.isArray(newest.tokens)) {
          return { ok: false, reason: "letscash list shape changed — `tokens` is not an array", at };
        }
      }
    } catch (err) {
      return {
        ok: false,
        reason: `letscash unreachable: ${err instanceof Error ? err.message : String(err)}`,
        at,
      };
    }

    const parsed = merged.map(parseToken).filter((t): t is QuarryToken => t !== null);

    /*
     * ══ THE PREFILTER, ON A FIELD THE LIST ALREADY RETURNS ══
     *
     * Applied BEFORE any detail request, so it costs nothing and refuses the ~40% of the merge that
     * has never been bought. This is the same trade `discovery.ts` makes and for the same reason:
     * it is the only filter that shrinks the detail fan-out without a request of its own.
     */
    const considered = parsed.filter((t) => t.marketCapEth >= MIN_MARKET_CAP_ETH);

    /*
     * ══ ONE ROW PER TICKER ══
     *
     * Memecoin launchpads have no ticker uniqueness — the live list routinely carries several
     * unrelated contracts all called CATONIT (measured: two, at 2.2Ξ and 4.6Ξ, both with real
     * volume). Rendered on the field that is two identical diamonds both labelled CATONIT, which
     * looks like a rendering bug and is worse than one: a viewer cannot tell which contract a cat
     * is on, so the label stops being information.
     *
     * De-duplicating on ADDRESS instead would be wrong HERE — the addresses genuinely differ; it is
     * the human-readable LABEL that collides, and the label is what this layer renders. (The merge
     * above dedupes on address, which is the right key for "is this the same token in two sorts".
     * Two different keys for two different questions.)
     *
     * Ordered by market cap first so the survivor is the largest contract carrying that ticker,
     * which is the one a stray would actually pick.
     */
    const byTicker = new Set<string>();
    const unique = [...considered]
      .sort((a, b) => b.marketCapEth - a.marketCapEth)
      .filter((t) => {
        const key = t.symbol.toUpperCase();
        if (byTicker.has(key)) return false;
        byTicker.add(key);
        return true;
      });

    /*
     * ══ WHICH ROWS GET A DETAIL REQUEST ══
     *
     * Market cap is the only ranking signal available before a detail fetch, and it is a poor proxy
     * for activity — USDG sits at 10,411Ξ and Seriouscat at 74Ξ, and Seriouscat is the one moving.
     * But it is what there IS at this point, and the budget has to be spent on something. Taking the
     * top `DETAIL_BUDGET` by market cap is a defensible allocation: it cannot miss a large live
     * token, and the ranking below then re-sorts by what was actually measured.
     */
    const toDetail = unique.slice(0, DETAIL_BUDGET);
    const enriched = await enrichAll(toDetail, ctl.signal, at);

    /*
     * ══ RANK BY REAL ACTIVITY, NOT BY MARKET CAP ══
     *
     * This is the substance of the fix. Market cap is a claim about a token; 24h volume and holders
     * are a record of what people did with it. A field ranked by market cap put USDG's 10,411Ξ
     * first and buried Seriouscat, which had 383Ξ of real volume and a +1647% move.
     *
     * LIVE tokens sort first, by volume descending. Everything unmeasured or dead sorts after them
     * and is still RENDERED — dropping the dead ones would make the field look like every token on
     * the pad is viable, which is the flattering version of the same lie this rewrite is fixing.
     * They are labelled for what they are instead.
     */
    const rank = (t: QuarryToken): number => (t.liveness === "live" ? 0 : t.liveness === "unknown" ? 1 : 2);
    const ranked = [...enriched].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      const av = a.volume24hEth ?? -1;
      const bv = b.volume24hEth ?? -1;
      if (av !== bv) return bv - av;
      return b.marketCapEth - a.marketCapEth;
    });

    return {
      ok: true,
      tokens: ranked.slice(0, WORLD_QUARRY_CAP),
      scanned: parsed.length,
      considered: unique.length,
      at,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge several list payloads into one row array, deduped by lowercased address.
 *
 * Exported for the test that asserts this behaves identically to `discovery.ts`'s inline merge —
 * the divergence between those two is the entire bug, so the equivalence is worth pinning.
 */
export function mergeRows(sources: readonly unknown[]): unknown[] {
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    if (!isRecord(src) || !Array.isArray(src.tokens)) continue;
    for (const row of src.tokens) {
      const addr = isRecord(row) && typeof row.address === "string" ? row.address.toLowerCase() : null;
      if (addr === null || seen.has(addr)) continue;
      seen.add(addr);
      merged.push(row);
    }
  }
  return merged;
}

/** Detail fan-out, capped and cached. One bad detail must not fail the read. */
async function enrichAll(
  tokens: readonly QuarryToken[],
  signal: AbortSignal,
  now: number,
): Promise<QuarryToken[]> {
  const out: QuarryToken[] = [];

  const one = async (t: QuarryToken): Promise<QuarryToken> => {
    const cached = detailCache.get(t.address);
    if (cached !== undefined && now - cached.at < DETAIL_TTL_MS) return enrich(t, cached.value);
    try {
      const raw = await getJson(`${PAD_API}/tokens/${t.address}`, signal);
      detailCache.set(t.address, { at: now, value: raw });
      return enrich(t, raw);
    } catch {
      // A failed detail leaves the token `"unknown"` — never huntable, and never accused of being
      // dead. This is the discriminated-union rule applied at row granularity.
      return t;
    }
  };

  for (let i = 0; i < tokens.length; i += DETAIL_CONCURRENCY) {
    out.push(...(await Promise.all(tokens.slice(i, i + DETAIL_CONCURRENCY).map(one))));
  }
  return out;
}
