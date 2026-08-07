/**
 * `/logs` — every decision, and whether it actually happened.
 *
 * meridian records that a live monitor must distinguish "the agent decided to trade" from "the
 * trade actually landed on chain", because risk caps and reverts block one from becoming the other,
 * "and previously that distinction was silent". This page renders the two DIFFERENTLY and never
 * merges them — a decided-but-failed trade is information, not a non-event.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { recentDecisions } from "../lib/decisions";
import { EXPLORER } from "../lib/config";

export const metadata: Metadata = { title: "STRAYS — every decision" };
export const revalidate = 15;

export default async function Logs() {
  const { rows, block, at } = await recentDecisions(100);
  return (
    <main className="logs">
      <header className="colony-head">
        <Link href="/" className="back">← STRAYS</Link>
        <h1>Every decision</h1>
        <p className="stamp">
          what each cat decided, and whether it landed · block {block.toString()} ·{" "}
          {new Date(at).toISOString().replace("T", " ").slice(0, 19)}Z
        </p>
      </header>
      {rows.length === 0 ? (
        <p className="empty stamp">
          No decisions recorded yet. The keeper writes a row every cycle, whether it trades or not —
          an empty list means it has not run against a funded stray.
        </p>
      ) : (
        <ul className="log-list">
          {rows.map((r) => (
            <li key={`${r.txHash ?? r.at}-${r.strayId}`} data-outcome={r.outcome}>
              <span className="stamp">blk {r.block.toString()}</span>
              <span className="act">{r.action}</span>
              <span className="why">{r.rationale}</span>
              {r.txHash ? (
                <a href={`${EXPLORER}/tx/${r.txHash}`} target="_blank" rel="noreferrer noopener" className="stamp">
                  {r.outcome === "landed" ? "landed" : r.outcome} ↗
                </a>
              ) : (
                <span className="stamp">{r.outcome}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
