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
 *
 * ══ WHAT A TRADE ROW HAS TO SAY ══
 *
 * Ibrahim: *"why not showing pnls in logs and what token it bought?"* He was reading rows like
 * `HUNT bought 561427.711 units for 0.0012 ETH` — a number of units of an unnamed thing, and no
 * result anywhere on the page. Both facts were already being decoded off the events and discarded
 * (see `lib/decisions.ts`). A trade row now carries three things it did not:
 *
 *   1. WHAT — the ticker, resolved from the launchpad, with the address linked to the explorer so
 *      the claim is checkable. An unresolvable address renders truncated, never blank.
 *   2. HOW MUCH — the realised `ethOut - ethIn` of the round trip, in ETH and in bps.
 *   3. WHETHER IT IS DONE — an open position says "open" rather than showing a result it does not
 *      have. `DESIGN.md` §9 bans presenting a mark as an outcome.
 *
 * The PnL is coloured with `.fed` / `.starve`, the same two hues the whole product uses for ate /
 * starved, and a LOSS gets the identical weight and size as a win. §9: **no hidden losses.** The
 * one real round trip on chain today is a −199 bps loss, so this column ships exercised against a
 * losing trade rather than against a hypothetical winning one.
 */
import type { Metadata } from "next";
import { recentDecisions, formatPnlEth, formatPnlBps } from "../lib/decisions";
import { symbolsFor, shortAddress } from "../lib/token-names";
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

  /*
   * Ticker lookup, over the DEDUPLICATED set of traded addresses.
   *
   * Deliberately NOT inside the `try` above: the chain read is the page, and the launchpad is a
   * decoration on it. A pad outage must degrade a ticker to an address, never turn a page of real
   * on-chain trades into "the decision log could not be read". `symbolsFor` cannot reject, so the
   * failure surfaces as a `null` per address and the row falls back on its own.
   */
  const symbols = await symbolsFor(
    (data?.rows ?? []).flatMap((r) => (r.token === null ? [] : [r.token])),
  );

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
                <span className="why">
                  {r.token !== null ? (
                    <>
                      {/* WHAT it bought. The ticker is the label and the ADDRESS is the link, so
                          the ticker is never the only evidence — memecoin tickers are not unique
                          and a reader has to be able to check which contract this was. */}
                      <a
                        href={`${EXPLORER}/address/${r.token}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="tok"
                        title={r.token}
                      >
                        {symbols.get(r.token.toLowerCase()) ?? shortAddress(r.token)}
                      </a>{" "}
                    </>
                  ) : null}
                  {r.rationale}
                </span>
                {/*
                  THE RESULT. Three mutually exclusive states, and none of them is a blank cell:
                  a closed round trip shows its realised PnL, an open position says so, and an exit
                  we could not pair says THAT rather than inventing a cost basis of zero.
                */}
                {r.pnl !== null ? (
                  <span
                    className={`pnl fig ${r.pnl.eth > 0 ? "fed" : r.pnl.eth < 0 ? "starve" : ""}`}
                    title={`in ${r.pnl.ethIn} ETH, out ${r.pnl.ethOut} ETH, opened at block ${r.pnl.openedAtBlock}`}
                  >
                    {formatPnlEth(r.pnl.eth)}
                    {r.pnl.bps !== null ? (
                      <span className="pnl-bps">{formatPnlBps(r.pnl.bps)}</span>
                    ) : null}
                  </span>
                ) : r.open ? (
                  <span className="pnl stamp">open</span>
                ) : r.action === "flee" ? (
                  /* An exit whose entry is outside the scan window. "We cannot compute this" is a
                     different fact from "this broke even", and a 0 here would be a fabrication. */
                  <span className="pnl stamp" title="the opening trade is outside the scanned range">
                    unpaired
                  </span>
                ) : (
                  <span className="pnl" />
                )}
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
