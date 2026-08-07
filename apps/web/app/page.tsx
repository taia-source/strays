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
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS PAGE DOES NOT SCROLL, AND HOW THE DISCLOSURE SURVIVED THAT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ibrahim: *"didn't i tell you no scroll on the frontend? have you checked the landing page?"* He
 * had said it, and this file's previous header argued its way out of it — it claimed the landing
 * page was long-form prose that "must scroll" because the risk disclosure could not otherwise fit.
 * That reasoning is wrong, and the way it is wrong is worth keeping on the record: it treated the
 * WORD COUNT as fixed and the layout as the only free variable. The word count was never fixed.
 *
 * unitick's recorded failure is the trap on the other side: on a cramped no-scroll layout the
 * tempting fix was `display: none` on the help text, which would have hidden "NOT INVESTING — YOUR
 * ENTRY IS AT RISK" and traded a layout defect for a DISCLOSURE defect. Its lesson is the rule this
 * rewrite follows literally: **on a no-scroll layout, budget the WORDS before the boxes.**
 *
 * So every claim that was here is still here — total loss, unaudited contract, two unverified
 * launchpad contracts, and a cat can simply be wrong — and none of it is behind a toggle, a
 * `display: none`, a hover, or an accordion. What changed is the prose around them: the four risks
 * were 92 words of sentences and are now 47 of clauses, and the two explanatory sections lost the
 * paragraphs that restated the tagline. Nothing that was a FACT was cut. Several things that were
 * PADDING were.
 *
 * The one structural concession: below ~700px of viewport height the risk panel scrolls INTERNALLY
 * (`overflow-y: auto; overscroll-behavior: contain`), not the page. That is the honest version of
 * "it does not fit" — the content is all present and reachable, and the containment stops the
 * gesture leaking into a page that is meant to be fixed. It is what `/logs` and `/leaderboard`
 * already do, so it is the house pattern rather than a special case for this page.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { HeroCat } from "./hero-cat";
import { VAULT_ADDRESS, EXPLORER } from "./lib/config";

export const metadata: Metadata = {
  title: "STRAYS — feed a stray, it hunts letscash",
  description:
    "Fund a cat with ETH. It prowls new letscash launches, trades them, and brings back what it kills. It keeps a cut. Cats that stop eating starve out.",
};

export default function Landing() {
  return (
    <main className="landing">
      <div className="landing-grid">
        <header className="landing-head">
          <h1 className="wordmark">STRAYS</h1>
          <p className="tagline">Feed a stray. It hunts letscash. It brings back what it kills.</p>
        </header>

        {/*
          ONE cat, cycling fed → hunting → starving → dead. Not six strangers in a row — see the
          header in `hero-cat.tsx` for why the identity has to be held fixed for the states to mean
          anything. It is also the risk disclosure in a sprite: the dead cat is the same cat.
        */}
        <section className="landing-hero" aria-label="A stray, cycling its states">
          <HeroCat size={112} />
        </section>

        {/*
          The product, in one sentence and a consequence. This section was three sentences longer
          and every cut word went to the risk panel — the trade unitick's lesson prescribes. What
          survives is load-bearing: who trades (the cat, not you), where (letscash), and what
          happens when it loses (it starves out). Nothing that a visitor needs to decide is gone.
        */}
        <section className="explain landing-what">
          <h2>What it is</h2>
          <p>
            You fund a cat with ETH. It picks its own targets on{" "}
            <a href="https://www.letscash.fun/" target="_blank" rel="noreferrer noopener">
              letscash
            </a>
            , trades them on Uniswap v4, and drops the proceeds back in your vault. You do not pick
            or approve the trades. Cats that stop eating starve out and disappear.
          </p>
        </section>

        <section className="explain landing-costs">
          <h2>What it costs</h2>
          <dl className="costs">
            <div>
              <dt>To adopt</dt>
              <dd className="fig">20%</dd>
              <dd className="stamp">energy fee, once, up front</dd>
            </div>
            <div>
              <dt>On profit</dt>
              <dd className="fig">10%</dd>
              <dd className="stamp">of the gain only, at withdrawal</dd>
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
              <dd className="stamp">no cut when a cat loses</dd>
            </div>
            <div>
              <dt>Every trade</dt>
              <dd className="fig">~199 bps</dd>
              <dd className="stamp">the pad&apos;s 1% tax, both legs</dd>
            </div>
          </dl>
        </section>

        {/*
          THE RISKS. Every claim that was on this page before is still on it, in the same words for
          the load-bearing phrases — "you can lose all of it", "not audited", "unverified". Nothing
          here is collapsed, hidden, hover-revealed or truncated, and DESIGN §9 refuses to dress any
          of it up as investing. If this panel cannot fit the viewport it SCROLLS ITSELF; it never
          gets shortened by CSS.
        */}
        <section className="explain risks landing-risks">
          <h2>What can go wrong</h2>
          <ul>
            <li>
              <strong>You can lose all of it.</strong> A stray trades memecoins. This is not
              investing and there is no floor under it.
            </li>
            <li>
              <strong>The contract holding your money is not audited.</strong>{" "}
              <a
                href={`${EXPLORER}/address/${VAULT_ADDRESS}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                Source-verified
              </a>{" "}
              and tested — but no external auditor has seen it.
            </li>
            <li>
              <strong>Two of the launchpad&apos;s own contracts are unverified.</strong> Its fee
              hook and revenue splitter publish no source, and every trade routes through them.
            </li>
            <li>
              <strong>A cat can simply be wrong.</strong> Nothing here protects you from a bad
              trade.
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
            <a
              href={`${EXPLORER}/address/${VAULT_ADDRESS}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {VAULT_ADDRESS.slice(0, 10)}…{VAULT_ADDRESS.slice(-8)}
            </a>
          </span>
          <span>Robinhood Chain · 4663</span>
        </footer>
      </div>
    </main>
  );
}
