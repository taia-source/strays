/**
 * `/docs` — how it works, and what is not true.
 *
 * The section that matters most on this page is "What is not audited". `DESIGN.md` §3 records that
 * openhood shipped a custody contract holding user money with no external audit and its own source
 * said: *"Ibrahim accepted this risk explicitly and in writing on 2026-08-06. **Users did not.**"*
 *
 * This page is where users get told. It is not a disclaimer in 8px grey at the bottom.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { EXPLORER, VAULT_ADDRESS, PAD_SITE } from "../lib/config";

export const metadata: Metadata = {
  title: "STRAYS — how it works",
  description: "The mechanism, the fees, the custody model, and what is not audited.",
};

const HOOK = "0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC";
const SPLITTER = "0x6D3d822F6e625c59804F47cf2Cc1d53B8301016F";

export default function Docs() {
  return (
    <main className="doc">
      <header className="doc-head">
        <Link href="/" className="back">
          ← STRAYS
        </Link>
        <h1>How it works</h1>
      </header>

      {/*
        The DOCUMENT does not scroll — this body does. See `.doc` / `.doc-body` in `globals.css`
        for why this route kept its full text instead of being cut to one viewport like `/`.
      */}
      <div className="doc-body">
      <section>
        <h2>The loop</h2>
        <ol className="steps">
          <li>
            You send ETH to the vault in <strong>one transaction</strong>. 20% is taken as an energy
            fee; the rest becomes your cat&apos;s trading stake.
          </li>
          <li>
            Every five minutes a keeper reads the launchpad, filters it, and asks each cat&apos;s
            strategy what to do.
          </li>
          <li>
            When a trade clears the cost bar, the keeper tells the vault to buy.{" "}
            <strong>The vault performs the swap itself</strong> — the keeper never holds your money.
          </li>
          <li>
            The cat exits on a target, a stop, or a drawdown halt. Proceeds return to your
            compartment in the vault.
          </li>
          <li>
            You withdraw whenever you like. Principal plus profit, minus 10% of the profit only.
          </li>
        </ol>
      </section>

      <section>
        <h2>Why only 1%-tax tokens</h2>
        <p>
          letscash lets a creator pick a trading tax of 1%, 3%, 5% or 10%, fixed forever at launch.
          The tax is charged on <em>both</em> legs of a round trip. We measured the real cost on live
          pools, on chain:
        </p>
        <table className="tiers">
          <thead>
            <tr>
              <th>tax</th>
              <th>round trip</th>
              <th>move needed to break even</th>
            </tr>
          </thead>
          <tbody>
            <tr className="fed">
              <td>1%</td>
              <td className="fig">199 bps</td>
              <td className="fig">2.0%</td>
            </tr>
            <tr>
              <td>3%</td>
              <td className="fig">591 bps</td>
              <td className="fig">6.1%</td>
            </tr>
            <tr>
              <td>5%</td>
              <td className="fig">975 bps</td>
              <td className="fig">10.8%</td>
            </tr>
            <tr className="starve">
              <td>10%</td>
              <td className="fig">1900 bps</td>
              <td className="fig">23.5%</td>
            </tr>
          </tbody>
        </table>
        <p className="stamp">
          Measured three ways and agreeing to the basis point: an off-chain probe, the contract on a
          mainnet fork, and the contract on mainnet with real ETH.
        </p>
        <p>
          A cat only hunts the top row. On a 10%-tax token it would need a 23.5% move just to get
          back to even, and roughly a third of the pad launches at 1%, so there is no shortage.
        </p>
      </section>

      <section>
        <h2>Who can touch your money</h2>
        <p>
          Your ETH sits in a compartment inside the vault, keyed to your cat. Three properties hold,
          and each is enforced by the code rather than by a promise:
        </p>
        <ul>
          <li>
            <strong>Only you can withdraw.</strong> The withdraw function pays whoever calls it, and
            only the recorded owner may call it. Nothing can pause it — not the keeper, not us, not a
            risk control, not while a trade is open.
          </li>
          <li>
            <strong>The keeper can only trade.</strong> It tells the vault which token to buy and how
            much, and it cannot name a destination for the proceeds. Uniswap v4&apos;s{" "}
            <code>TAKE_ALL</code> action has no recipient field at all, so the money returns to the
            vault because of the <em>shape of the transaction</em>, not because of a check somebody
            could delete.
          </li>
          <li>
            <strong>Cats cannot reach each other.</strong> One cat&apos;s balance is arithmetically
            unreachable from a call naming another.
          </li>
        </ul>
      </section>

      {/* The honest section. */}
      <section className="warn">
        <h2>What is not audited</h2>
        <p>
          <strong>No external auditor has reviewed the vault contract.</strong> What exists instead:
          33 tests, twelve deliberate sabotages of the source that the suite is proven to catch, and
          a full round trip executed against live pools on a mainnet fork and then on mainnet itself.
          That is not the same as an audit and is not offered as one. The{" "}
          <a href={`${EXPLORER}/address/${VAULT_ADDRESS}`} target="_blank" rel="noreferrer noopener">
            source is verified and readable
          </a>
          .
        </p>
        <p>
          <strong>Two of the launchpad&apos;s own contracts have no published source.</strong> Its{" "}
          <a href={`${EXPLORER}/address/${HOOK}`} target="_blank" rel="noreferrer noopener">
            fee hook
          </a>{" "}
          and{" "}
          <a href={`${EXPLORER}/address/${SPLITTER}`} target="_blank" rel="noreferrer noopener">
            revenue splitter
          </a>{" "}
          are unverified on the explorer, and every trade routes through them. We cannot audit them
          and neither can you. The only honest mitigation is a cap on what one trade can risk, and
          the vault enforces one.
        </p>
        <p>
          <strong>Two bugs were found during the build that tests alone did not catch.</strong> The
          swap encoder was silently producing calldata 64 bytes short — caught by diffing it against
          a transaction that had actually landed. And the vault rejected the incoming ETH on every
          sale, because the pool manager sends it rather than the router — caught only by running
          against a real pool. Both are fixed. Both are recorded in the repository. We mention them
          because a build that claims it found nothing is a build that did not look.
        </p>
        <p>
          <strong>Nothing here is investing.</strong> A stray trades memecoins minutes after they
          launch. Total loss is an ordinary outcome, not an edge case.
        </p>
      </section>

      <section>
        <h2>Where the numbers come from</h2>
        <p>
          Every figure in this product is read from the chain or from{" "}
          <a href={PAD_SITE} target="_blank" rel="noreferrer noopener">
            the launchpad
          </a>{" "}
          and carries the block it was read at. Nothing is illustrative, and there is no seeded or
          example data anywhere in the running product — if a table is empty, it is empty because
          nothing has happened yet.
        </p>
      </section>

      </div>

      <footer className="doc-foot stamp">
        <Link href="/logs">every decision, with its transaction →</Link>
      </footer>
    </main>
  );
}
