/**
 * `/leaderboard` — which cats are eating.
 *
 * DESIGN §9: **no hidden losses.** The starving cats are on this board too, and a losing cat is
 * drawn losing. A leaderboard that shows only winners is a survivorship-biased advertisement, and
 * the cute rendering is not there to soften the outcome.
 *
 * Fixed-viewport with one internally-scrolling panel, same shape as `/logs` — see the note in that
 * file for why a pinned header earns its space on a ranked list.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { listStrays } from "../lib/chain";
import { CatPortrait } from "../cat-portrait";
import { LiveStamp } from "../nav/live-stamp";

export const metadata: Metadata = { title: "STRAYS — who is eating" };
export const revalidate = 15;

export default async function Leaderboard() {
  let data: Awaited<ReturnType<typeof listStrays>> | null = null;
  let error: string | null = null;
  try {
    data = await listStrays();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const ranked = data === null ? [] : [...data.strays].sort((a, b) => b.pnlEth - a.pnlEth);

  return (
    <main className="panel-route">
      <header className="panel-head">
        <div>
          <h1>Who is eating</h1>
          <p className="stamp">ranked by realised profit — losses included, never hidden</p>
        </div>
        <div className="panel-head-meta">
          {data !== null ? <p className="stamp">block {data.block.toString()}</p> : null}
          <LiveStamp intervalSec={15} />
        </div>
      </header>

      <div className="panel-body">
        {error !== null ? (
          <div className="warn">
            <p>
              <strong>The colony could not be read.</strong> {error}
            </p>
            <p className="stamp">
              A failed read of the chain, not an empty board. No ranking is shown because we do not
              know what is there — an empty table here would read as "nobody has traded", which is a
              different and possibly false claim.
            </p>
          </div>
        ) : ranked.length === 0 ? (
          <p className="empty stamp">
            No strays have been adopted yet, so there is nothing to rank. This is an empty board,
            not a broken page — the first funded cat appears here.
          </p>
        ) : (
          /* A table cannot reflow. Below its natural minimum it scrolls INSIDE this box rather
             than pushing the document wide — the page must never scroll sideways at any width. */
          <div className="rank-wrap">
            <table className="rank">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">stray</th>
                  <th scope="col">stake</th>
                  <th scope="col">profit</th>
                  <th scope="col">state</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((s, i) => (
                  <tr key={s.id} data-state={s.state}>
                    <td className="stamp">{i + 1}</td>
                    <td>
                      <Link href={`/stray/${s.id}`} className="rank-cat">
                        {/* `idle={false}` — a table of twenty bobbing sprites is a table nobody
                            can read a number off. The idle world is the WORLD's job. */}
                        <CatPortrait id={s.id} state={s.state} size={28} idle={false} />
                        <span className="stamp">{s.id.slice(0, 8)}…</span>
                      </Link>
                    </td>
                    <td className="fig">{s.stakeEth.toFixed(5)}</td>
                    <td className={`fig ${s.pnlEth > 0 ? "fed" : s.pnlEth < 0 ? "starve" : ""}`}>
                      {s.pnlEth >= 0 ? "+" : ""}
                      {s.pnlEth.toFixed(6)}
                    </td>
                    <td className={`stamp ${s.state === "starving" || s.state === "dead" ? "starve" : ""}`}>
                      {s.state}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
