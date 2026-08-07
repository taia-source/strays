/**
 * `/api/world` — one poll, both halves of the world.
 *
 * The world client polls this every `POLL_MS`. It returns the colony (from chain) and the quarry
 * (from letscash) as INDEPENDENTLY-FALLIBLE halves, because they fail independently in reality:
 * the RPC can be down while letscash is up, and vice versa. A single `ok` flag over both would
 * force the renderer to blank a working half because the other half failed.
 *
 * ══ A FAILED READ IS NEVER SERIALISED AS EMPTY ══
 *
 * `colony` is `{ok:true, strays:[…]}` or `{ok:false, reason}`. There is no shape where a caller can
 * read zero strays without also having been told whether that zero is a measurement or a failure.
 * `chain.ts`'s header states the rule: "a blank table reads as broken, a fake one reads as fine" —
 * and the third case, a FAILED table rendered as blank, reads as an empty colony, which is a lie of
 * the same family.
 *
 * `bigint` does not survive `JSON.stringify`, so block numbers cross the wire as decimal strings
 * and are parsed back by the client. Serialising them as `Number` would silently lose precision
 * above 2^53 — a chain at 30M blocks is nowhere near that today, which is exactly why the bug would
 * not show up until it was someone else's problem.
 */
import { NextResponse } from "next/server";
import { listStrays } from "../../lib/chain";
import { fetchQuarry, type QuarryRead } from "../../lib/quarry";

/** Never cached: this is the live world, and a cached world is a photograph. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export type WorldPayload = {
  readonly colony:
    | {
        readonly ok: true;
        readonly strays: readonly {
          readonly id: string;
          readonly owner: string;
          readonly stakeEth: number;
          readonly principalEth: number;
          readonly pnlEth: number;
          readonly holding: string | null;
          readonly state: "fed" | "hunting" | "starving" | "dead";
        }[];
        readonly block: string;
      }
    | { readonly ok: false; readonly reason: string };
  readonly quarry:
    | {
        readonly ok: true;
        readonly tokens: readonly {
          readonly address: string;
          readonly symbol: string;
          readonly name: string;
          readonly marketCapEth: number;
          readonly change24hPct: number | null;
          /** Carried so the roster can say WHY a token is not huntable, not merely that it isn't. */
          readonly taxPct: number;
          /**
           * The EVIDENCE for the `huntable` claim, carried so the renderer can show it rather than
           * asking the viewer to take the boolean on trust. `null` means the detail read failed —
           * which is why `liveness` exists as a third state and not as `volume === 0`.
           */
          readonly volume24hEth: number | null;
          readonly holders: number | null;
          readonly liveness: "live" | "dead" | "unknown";
          readonly huntable: boolean;
        }[];
        readonly scanned: number;
        readonly considered: number;
      }
    | { readonly ok: false; readonly reason: string };
  /** Unix ms the server assembled this. The BLOCK is the authoritative stamp for chain figures. */
  readonly at: number;
};

/**
 * Project a `QuarryRead` onto the wire shape.
 *
 * ══ WHY THIS IS EXPORTED RATHER THAN INLINED TWICE ══
 *
 * `app/app/page.tsx` builds the SAME payload for the first server render that this route builds for
 * every poll, and until now each had its own copy of this mapping. That is the identical shape of
 * defect the quarry rewrite was fixing one layer down: two copies of one rule, which agree right up
 * until somebody edits one of them. Adding `volume24hEth`, `holders` and `liveness` here would have
 * left the server-rendered first frame silently missing them — a page that shows the right thing
 * five seconds after load and the wrong thing before that.
 *
 * One function, one shape, both call sites.
 */
export function projectQuarry(read: QuarryRead): WorldPayload["quarry"] {
  if (!read.ok) return { ok: false, reason: read.reason };
  return {
    ok: true,
    tokens: read.tokens.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      marketCapEth: t.marketCapEth,
      change24hPct: t.change24hPct,
      taxPct: t.taxPct,
      volume24hEth: t.volume24hEth,
      holders: t.holders,
      liveness: t.liveness,
      huntable: t.huntable,
    })),
    scanned: read.scanned,
    considered: read.considered,
  };
}

export async function GET(): Promise<NextResponse<WorldPayload>> {
  // Both halves in parallel — one slow read must not serialise behind the other. `allSettled`
  // rather than `all` so a rejection on one side cannot take down the side that succeeded.
  const [colonyResult, quarryResult] = await Promise.allSettled([listStrays(), fetchQuarry()]);

  const colony: WorldPayload["colony"] =
    colonyResult.status === "fulfilled"
      ? {
          ok: true,
          strays: colonyResult.value.strays.map((s) => ({
            id: s.id,
            owner: s.owner,
            stakeEth: s.stakeEth,
            principalEth: s.principalEth,
            pnlEth: s.pnlEth,
            holding: s.holding,
            state: s.state,
          })),
          block: colonyResult.value.block.toString(),
        }
      : {
          ok: false,
          reason:
            colonyResult.reason instanceof Error
              ? colonyResult.reason.message
              : String(colonyResult.reason),
        };

  /*
   * A REJECTED promise and a `{ok:false}` read are different failures and both must survive as
   * failures. `projectQuarry` handles the second; this handles the first.
   */
  const quarry: WorldPayload["quarry"] =
    quarryResult.status === "rejected"
      ? {
          ok: false,
          reason:
            quarryResult.reason instanceof Error
              ? quarryResult.reason.message
              : String(quarryResult.reason),
        }
      : projectQuarry(quarryResult.value);

  return NextResponse.json(
    { colony, quarry, at: Date.now() } satisfies WorldPayload,
    { headers: { "cache-control": "no-store" } },
  );
}
