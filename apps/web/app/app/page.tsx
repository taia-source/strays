/**
 * `/app` — THE WORLD. A fixed viewport, no scroll, a living colony.
 *
 * Ibrahim: *"for frontend i said no scroll, i visit the frontend there is scroll ... i dont see
 * world the cats are living in showing them trading letscash tokens?"*
 *
 * This is that world. `.world-root` is `position: fixed; inset: 0; height: 100svh; overflow:
 * hidden` — silvertongue's proven no-scroll lock, and `100svh` rather than `100vh` because on
 * mobile Safari `100vh` is the LARGE viewport height, which is taller than the visible area while
 * the URL bar is showing. `100vh` on a phone therefore GUARANTEES a scrollbar on a page designed
 * to have none, which is very likely the actual bug he hit.
 *
 * ══ WHY THE FIRST PAINT IS SERVER-RENDERED ══
 *
 * The world could mount empty and fill in on its first poll. It does not, because a visitor
 * arriving from a screenshot on X (DESIGN §7 step 1) would see an empty field for 5 seconds and
 * conclude the colony is empty — the exact confusion between "loading" and "nothing there" that
 * the whole payload shape exists to prevent. The server does the first read; the client polls from
 * there.
 *
 * `revalidate = 0` / `dynamic = "force-dynamic"`: a cached world is a photograph of a world.
 */
import type { Metadata } from "next";
import { listStrays } from "../lib/chain";
import { fetchQuarry } from "../lib/quarry";
import type { WorldPayload } from "../api/world/route";
import { WorldApp } from "../world/world-app";
import { Adopt } from "../adopt";

export const metadata: Metadata = {
  title: "STRAYS — the colony",
  description:
    "A living colony of pixel cats hunting real letscash launches. Every cat is a funded stray read from chain; every target is a real token read from the pad.",
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AppWorld() {
  /*
   * Both reads in parallel, both allowed to fail independently.
   *
   * `allSettled`, not `all` — with `all`, an RPC hiccup would reject the whole page and Next would
   * render the error boundary, so a letscash-only world (which is perfectly renderable, and is what
   * a visitor gets today) would be thrown away because of an unrelated failure.
   */
  const [colonyResult, quarryResult] = await Promise.allSettled([listStrays(), fetchQuarry()]);

  const initial: WorldPayload = {
    colony:
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
          },
    /* Explicit branches, not a nested ternary — see the note in `api/world/route.ts` for why the
       ternary form cannot narrow the else arm. */
    quarry: ((): WorldPayload["quarry"] => {
      if (quarryResult.status === "rejected") {
        const err = quarryResult.reason;
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      const read = quarryResult.value;
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
          huntable: t.huntable,
        })),
        scanned: read.scanned,
      };
    })(),
    at: Date.now(),
  };

  return (
    /*
      ══ ADOPTION IS PASSED INTO THE WORLD, NOT RENDERED BESIDE IT ══

      DESIGN §7 steps 3 and 4 are the only two interactions in the entire product, and the recorded
      failure this guards against is a service built to act on a user's token that shipped with NO
      TEXT INPUT ANYWHERE — 747 tests and 24 browser checks passed, because the user's path was
      never written down so nothing could notice a step was missing.

      It is passed as a PROP rather than rendered as a sibling of `<WorldApp>` because it has to be
      a child of the HUD's grid. As a sibling it needed `position: fixed` to reach its corner, and
      that second coordinate system is exactly what made the 390px layout pile up — the adopt
      panel's text drawn on top of the empty-colony banner's. See the note above `.world-hud`.

      `<Adopt>` is a client component and this is a server component, so it crosses as a rendered
      ReactNode — which also means its wallet-connect JS is not in the world's bundle until the
      panel is actually in the tree.
    */
    <WorldApp
      initial={initial}
      adopt={
        <details className="world-adopt" id="adopt">
          <summary>
            <span className="world-adopt-title">ADOPT A STRAY</span>
            <span className="stamp">
              20% energy fee up front · 10% of profit only · nothing on a loss
            </span>
          </summary>
          <div className="world-adopt-body">
            <Adopt />
          </div>
        </details>
      }
    />
  );
}
