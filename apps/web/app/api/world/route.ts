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
import { fetchQuarry } from "../../lib/quarry";

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
          readonly huntable: boolean;
        }[];
        readonly scanned: number;
      }
    | { readonly ok: false; readonly reason: string };
  /** Unix ms the server assembled this. The BLOCK is the authoritative stamp for chain figures. */
  readonly at: number;
};

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

  const quarry: WorldPayload["quarry"] =
    quarryResult.status === "fulfilled" && quarryResult.value.ok
      ? {
          ok: true,
          tokens: quarryResult.value.tokens.map((t) => ({
            address: t.address,
            symbol: t.symbol,
            name: t.name,
            marketCapEth: t.marketCapEth,
            change24hPct: t.change24hPct,
            huntable: t.huntable,
          })),
          scanned: quarryResult.value.scanned,
        }
      : {
          ok: false,
          reason:
            quarryResult.status === "rejected"
              ? quarryResult.reason instanceof Error
                ? quarryResult.reason.message
                : String(quarryResult.reason)
              : quarryResult.value.reason,
        };

  return NextResponse.json(
    { colony, quarry, at: Date.now() } satisfies WorldPayload,
    { headers: { "cache-control": "no-store" } },
  );
}
