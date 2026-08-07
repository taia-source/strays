/**
 * `/colony` — the map. The social loop and the product's primary surface.
 *
 * Referent rule 3: THE CAMERA DOES NOT FOLLOW. It has a fixed frame and things enter and leave it.
 * The map does not pan to your cat and nothing is centred on the user — you find yours in the
 * frame. That is what makes it a colony rather than a dashboard.
 *
 * HONEST STATE: this route reads live vault state from chain. When no strays exist it renders an
 * EMPTY colony and says so. It does NOT seed example cats — "a blank table reads as broken, a fake
 * one reads as fine", and the fake one is the dangerous defect.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { listStrays } from "../lib/chain";
import { CatPortrait } from "../cat-portrait";

export const metadata: Metadata = { title: "STRAYS — the colony" };
export const revalidate = 15;

export default async function Colony() {
  const { strays, block, at } = await listStrays();
  return (
    <main className="colony">
      <header className="colony-head">
        <Link href="/" className="back">← STRAYS</Link>
        <h1>The colony</h1>
        <p className="stamp">
          {strays.length} {strays.length === 1 ? "stray" : "strays"} · block {block.toString()} ·{" "}
          {new Date(at).toISOString().replace("T", " ").slice(0, 19)}Z
        </p>
      </header>

      {strays.length === 0 ? (
        <section className="empty">
          <p>No strays yet.</p>
          <p className="stamp">
            Nothing has been adopted on this vault. This is an empty colony, not a broken page — the
            first cat to be funded appears here.
          </p>
        </section>
      ) : (
        <ul className="colony-grid">
          {strays.map((s) => (
            <li key={s.id}>
              <Link href={`/stray/${s.id}`}>
                <CatPortrait id={s.id} state={s.state} size={72} />
                <span className="fig">{s.stakeEth.toFixed(5)} ETH</span>
                <span className="stamp">{s.holding ? "hunting" : "idle"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
