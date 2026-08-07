/**
 * `/leaderboard` — which cats are eating.
 *
 * DESIGN §9: no hidden losses. The starving cats are on this board too, and a losing cat is drawn
 * losing. A leaderboard that shows only winners is a survivorship-biased advertisement.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { listStrays } from "../lib/chain";
import { CatPortrait } from "../cat-portrait";

export const metadata: Metadata = { title: "STRAYS — who is eating" };
export const revalidate = 15;

export default async function Leaderboard() {
  const { strays, block, at } = await listStrays();
  const ranked = [...strays].sort((a, b) => b.pnlEth - a.pnlEth);
  return (
    <main className="board">
      <header className="colony-head">
        <Link href="/" className="back">← STRAYS</Link>
        <h1>Who is eating</h1>
        <p className="stamp">
          ranked by realised profit · block {block.toString()} ·{" "}
          {new Date(at).toISOString().replace("T", " ").slice(0, 19)}Z
        </p>
      </header>
      {ranked.length === 0 ? (
        <p className="empty stamp">No strays have traded yet. Nothing to rank.</p>
      ) : (
        <table className="rank">
          <thead>
            <tr><th></th><th>stray</th><th>stake</th><th>profit</th></tr>
          </thead>
          <tbody>
            {ranked.map((s, i) => (
              <tr key={s.id}>
                <td className="stamp">{i + 1}</td>
                <td>
                  <Link href={`/stray/${s.id}`}>
                    <CatPortrait id={s.id} state={s.state} size={28} idle={false} />
                  </Link>
                </td>
                <td className="fig">{s.stakeEth.toFixed(5)}</td>
                <td className={`fig ${s.pnlEth >= 0 ? "fed" : "starve"}`}>
                  {s.pnlEth >= 0 ? "+" : ""}{s.pnlEth.toFixed(6)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
