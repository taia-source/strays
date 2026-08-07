/**
 * `/logs` — every decision, and whether it actually happened.
 *
 * meridian records that a live monitor must distinguish "the agent DECIDED to trade" from "the
 * trade actually LANDED on chain", because risk caps and reverts block one from becoming the other,
 * *"and previously that distinction was silent"*. This page renders the two DIFFERENTLY and never
 * merges them — a decided-but-failed trade is information, not a non-event.
 *
 * ══ WHY THIS IS A FIXED-VIEWPORT PANEL AND NOT A DOCUMENT ══
 *
 * Brief: make it "feel like part of the world (dark, mono, live-updating), not a bare document".
 * A log is the one surface where a fixed header genuinely helps: the stamp says which block you
 * are looking at, and on a scrolling document that stamp leaves the screen after four rows —
 * exactly when you start needing it. Here the header is pinned and only the list moves.
 *
 * The auto-refresh is a CLIENT island (`<LiveStamp>`) over a server-rendered list. The list is
 * data, and re-fetching a hundred chain logs every few seconds to change nothing would be spending
 * an RPC budget on a page that is already correct.
 */
import type { Metadata } from "next";
import { recentDecisions } from "../lib/decisions";
import { EXPLORER } from "../lib/config";
import { LiveStamp } from "../nav/live-stamp";

export const metadata: Metadata = { title: "STRAYS — every decision" };
export const revalidate = 15;

export default async function Logs() {
  /*
   * A failed read is reported as a failure, never as an empty log.
   *
   * "No decisions recorded yet" and "we could not reach the chain" are different facts and they
   * look identical if a throw is swallowed into an empty array. `recentDecisions` can throw; this
   * catches it and says which one happened.
   */
  let data: Awaited<ReturnType<typeof recentDecisions>> | null = null;
  let error: string | null = null;
  try {
    data = await recentDecisions(100);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="panel-route">
      <header className="panel-head">
        <div>
          <h1>Every decision</h1>
          <p className="stamp">
            what each cat decided, and whether it landed on chain
          </p>
        </div>
        <div className="panel-head-meta">
          {data !== null ? (
            <p className="stamp">block {data.block.toString()}</p>
          ) : null}
          <LiveStamp intervalSec={15} />
        </div>
      </header>

      <div className="panel-body">
        {error !== null ? (
          <div className="warn">
            <p>
              <strong>The decision log could not be read.</strong> {error}
            </p>
            <p className="stamp">
              This is a failure to reach the chain, not an empty log. Nothing is shown because we do
              not know what is there.
            </p>
          </div>
        ) : data === null || data.rows.length === 0 ? (
          <p className="empty stamp">
            No decisions recorded yet. The keeper writes a row every cycle, whether it trades or not
            — an empty list means it has not run against a funded stray.
          </p>
        ) : (
          <ul className="log-list">
            {data.rows.map((r) => (
              <li key={`${r.txHash ?? r.at}-${r.strayId}-${r.block}`} data-outcome={r.outcome}>
                <span className="stamp">blk {r.block.toString()}</span>
                <span className="act">{r.action}</span>
                <span className="why">{r.rationale}</span>
                {r.txHash !== null ? (
                  <a
                    href={`${EXPLORER}/tx/${r.txHash}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="stamp"
                  >
                    {r.outcome === "landed" ? "landed" : r.outcome} ↗
                  </a>
                ) : (
                  /* No tx hash means it never reached the chain. That is the DECIDED-but-not-LANDED
                     case meridian says must never be silent, so it is drawn in the loss hue and
                     labelled, not left as an empty cell. */
                  <span className="stamp starve">not landed</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
