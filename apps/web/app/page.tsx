/**
 * `/` — the LANDING page. Not the app.
 *
 * `BUILD-A-PROJECT.md` names the failure this is shaped against: a deployed service once served its
 * control panel at `/` with 388 characters of visible text, every one a label or a number, and a
 * visitor could not tell what the product was. `landing-page-explains-the-product` blocks on it now.
 *
 * So this page answers four questions before anything else appears:
 *   1. what is it          — "Feed a stray. It hunts letscash. It brings back what it kills."
 *   2. what does it cost   — 20% energy fee up front, 10% of PROFIT only, nothing on a loss
 *   3. what can go wrong   — total loss, unaudited contract, unverified pad contracts
 *   4. the way in          — one button
 *
 * Question 3 is not a disclaimer at the bottom in 8px grey. `DESIGN.md` §9 refuses to dress this up
 * as investing, and unitick recorded the specific trap: the tempting fix for a cramped mobile
 * layout was `display: none` on the help text, which would have hidden "NOT INVESTING — YOUR ENTRY
 * IS AT RISK" and traded a layout defect for a disclosure defect. Budget the words before the boxes.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { CatPortrait } from "./cat-portrait";
import { VAULT_ADDRESS, EXPLORER } from "./lib/config";

export const metadata: Metadata = {
  title: "STRAYS — feed a stray, it hunts letscash",
  description:
    "Fund a cat with ETH. It prowls new letscash launches, trades them, and brings back what it kills. It keeps a cut. Cats that stop eating starve out.",
};

/**
 * Cats shown on the landing page are drawn from FIXED demo ids, and they are labelled as such.
 *
 * They are not presented as live strays and carry no balances, because a table of plausible-looking
 * numbers is the single most dangerous defect in this corpus: "a blank table reads as broken, a
 * fake one reads as fine." These are portraits of the art, nothing more.
 */
const DEMO_IDS = ["demo:tabby", "demo:smoke", "demo:patch", "demo:ash", "demo:rust", "demo:coal"];

export default function Landing() {
  return (
    <main className="landing">
      <header className="landing-head">
        <h1 className="wordmark">STRAYS</h1>
        <p className="tagline">
          Feed a stray. It hunts letscash. It brings back what it kills.
        </p>
      </header>

      <section className="colony-strip" aria-label="Example strays">
        {DEMO_IDS.map((id, i) => (
          <CatPortrait key={id} id={id} state={i === 4 ? "starving" : i === 1 ? "fed" : "hunting"} size={64} />
        ))}
        <p className="stamp strip-note">portraits — drawn from an id, not live strays</p>
      </section>

      <section className="explain">
        <h2>What it is</h2>
        <p>
          You fund a cat with ETH. It prowls new launches on{" "}
          <a href="https://www.letscash.fun/" target="_blank" rel="noreferrer noopener">
            letscash
          </a>
          , picks its targets, trades them on Uniswap v4, and drops the proceeds back in your vault.
          You do not pick the trades. You do not approve them. After you fund it, the cat is on its
          own.
        </p>
        <p>
          Cats that stop eating starve out and disappear from the colony. That is the risk, drawn
          honestly — a losing cat is drawn losing.
        </p>
      </section>

      <section className="explain">
        <h2>What it costs</h2>
        <dl className="costs">
          <div>
            <dt>To adopt</dt>
            <dd className="fig">20% energy fee</dd>
            <dd className="stamp">covers the cat&apos;s RPC and gas. Taken once, up front.</dd>
          </div>
          <div>
            <dt>On profit</dt>
            <dd className="fig">10% of the gain</dd>
            <dd className="stamp">taken at withdrawal, on the gain only — never on your principal.</dd>
          </div>
          <div>
            <dt>On a loss</dt>
            {/*
              Deliberately NOT `.fed`. Amber means exactly one thing — "the cat ate", a closed
              winning trade — and a zero fee on a LOSS is not that. unitick shipped the same class
              of bug: a HALTED lane drawn in the knockout hue, reading as "this one died" when a
              halt is the opposite. One hue, one meaning.
            */}
            <dd className="fig">nothing</dd>
            <dd className="stamp">the house takes no cut when a cat loses money.</dd>
          </div>
          <div>
            <dt>Every trade</dt>
            <dd className="fig">~199 bps</dd>
            <dd className="stamp">
              the pad&apos;s own 1% tax, charged on both legs. Measured on chain, not estimated.
            </dd>
          </div>
        </dl>
      </section>

      {/*
        The risks. Deliberately ABOVE the fold on mobile and never collapsed behind a toggle.
        DESIGN §9 refuses the words yield, returns, investing, APY and earn — this is a speculative
        agent trading memecoins with a real chance of total loss, and it says so in those words.
      */}
      <section className="explain risks">
        <h2>What can go wrong</h2>
        <ul>
          <li>
            <strong>You can lose all of it.</strong> A stray trades memecoins. This is not investing
            and there is no floor under it.
          </li>
          <li>
            <strong>The contract holding your money is not audited.</strong> It is{" "}
            <a href={`${EXPLORER}/address/${VAULT_ADDRESS}`} target="_blank" rel="noreferrer noopener">
              source-verified and readable
            </a>
            , and it is tested against twelve deliberate sabotages and against live pools — but no
            external auditor has looked at it.
          </li>
          <li>
            <strong>Two of the launchpad&apos;s own contracts are unverified.</strong> Its fee hook
            and revenue splitter have no published source, and every trade routes through them. We
            cap what a single trade can put at risk because of it.
          </li>
          <li>
            <strong>A cat can simply be wrong.</strong> Nothing here protects you from a bad trade.
          </li>
        </ul>
      </section>

      <nav className="ways-in">
        {/* `/app` is the world. `/colony` 308s here, so old links still land. */}
        <Link href="/app" className="cta">
          Enter the colony
        </Link>
        <div className="secondary">
          <Link href="/leaderboard">Who is eating</Link>
          <Link href="/logs">Every decision</Link>
          <Link href="/docs">How it works</Link>
        </div>
      </nav>

      <footer className="landing-foot stamp">
        <span>
          vault{" "}
          <a href={`${EXPLORER}/address/${VAULT_ADDRESS}`} target="_blank" rel="noreferrer noopener">
            {VAULT_ADDRESS.slice(0, 10)}…{VAULT_ADDRESS.slice(-8)}
          </a>
        </span>
        <span>Robinhood Chain · 4663</span>
      </footer>
    </main>
  );
}
