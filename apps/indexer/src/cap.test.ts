/**
 * THE SPEND CAP, tested against the durable ledger rather than asserted.
 *
 * Ibrahim asked for the "spending cap" gap to be resolved. The cap exists at four layers and this
 * file proves the two that live in software; the other two are on chain and immutable.
 *
 *   1. `MAX_POSITION_WEI = 0.01 ETH` — ON CHAIN, immutable, refuses a single oversized trade.
 *   2. `maxPositionWei` / `positionFractionBps` — sizes a position from the stray's OWN compartment.
 *   3. `maxSpendPerWindowWei` — a rolling per-hour ceiling across trades. **Tested here.**
 *   4. `maxEntriesPerWindow` — a count cap, because a value cap alone misses a retry storm.
 *      **Tested here.**
 *
 * meridian's cap "only reset on process restart, so the 'daily' cap was really 'spend since last
 * boot'". Ours is Postgres-backed, so the test that matters is that a cap SURVIVES A RESTART — and
 * that is measured against a real database, not a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RISK, mayEnter } from "@strays/hunt";
import { createStore, type Store } from "./ledger.js";

const URL = process.env.STRAYS_TEST_DATABASE_URL ?? "";
const run = URL.length > 0 ? describe : describe.skip;

run("the spend cap holds across a restart", () => {
  let store: Store;
  const now = Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    store = await createStore(URL);
  });
  afterAll(async () => {
    await store?.close();
  });

  it("refuses an entry once the hourly VALUE cap is reached", async () => {
    const strayId = `cap-value-${Date.now()}`;
    // Spend right up to the ceiling in one commit.
    await store.ledger.record({
      idempotencyKey: `${strayId}-fill`,
      strayId,
      amountWei: DEFAULT_RISK.maxSpendPerWindowWei,
      atSeconds: now,
    } as never);

    const spent = await store.ledger.spentInWindow(
      strayId,
      DEFAULT_RISK.spendWindowSeconds,
      now,
    );
    expect(spent).toBe(DEFAULT_RISK.maxSpendPerWindowWei);

    // A fresh process reading the same ledger must still see it — this is the meridian bug.
    const reborn = await createStore(URL);
    try {
      const seen = await reborn.ledger.spentInWindow(
        strayId,
        DEFAULT_RISK.spendWindowSeconds,
        now,
      );
      expect(seen).toBe(DEFAULT_RISK.maxSpendPerWindowWei);

      /*
       * ══ AND THE GATE MUST ACTUALLY REFUSE ══
       *
       * This assertion was missing and a sabotage found it: deleting the value-cap check from
       * `mayEnter` left the suite GREEN, because the test only proved the ledger RECORDED the
       * spend. Recording a spend and refusing the next one are two different things, and only the
       * second is a cap. Asserted here against the REBORN store, so it also proves the refusal
       * survives a restart.
       */
      const gate = await mayEnter({
        state: {
          strayId,
          compartmentWei: 10_000_000_000_000_000n,
          highWaterMarkWei: 10_000_000_000_000_000n,
          equityWei: 10_000_000_000_000_000n,
          positions: [],
        },
        cfg: DEFAULT_RISK,
        ledger: reborn.ledger,
        idempotencyKey: `${strayId}-after-cap`,
        nowSeconds: now,
      });
      // Narrow on the discriminant before reading the failure fields — EntryGate is a union and
      // `reason` exists only on the refusal arm. `tsc` catches this; vitest alone would not.
      expect(gate.allowed).toBe(false);
      if (gate.allowed) throw new Error("unreachable: asserted above");
      expect(`${gate.reason} ${gate.detail}`).toMatch(/spend|window|cap/i);
    } finally {
      await reborn.close();
    }
  });

  /**
   * A VALUE cap alone misses a retry storm: many tiny entries can stay under the ceiling while
   * churning the compartment away in fees. The COUNT cap is the second half.
   */
  it("counts entries in the window, not just their value", async () => {
    const strayId = `cap-count-${Date.now()}`;
    for (let i = 0; i < DEFAULT_RISK.maxEntriesPerWindow; i++) {
      await store.ledger.record({
        idempotencyKey: `${strayId}-${i}`,
        strayId,
        amountWei: 1n, // trivially small — the VALUE cap would never notice these
        atSeconds: now,
      } as never);
    }
    const n = await store.ledger.countInWindow(
      strayId,
      DEFAULT_RISK.spendWindowSeconds,
      now,
    );
    expect(n).toBe(DEFAULT_RISK.maxEntriesPerWindow);

    const spent = await store.ledger.spentInWindow(
      strayId,
      DEFAULT_RISK.spendWindowSeconds,
      now,
    );
    // Value is negligible, so ONLY the count cap can refuse the next one.
    expect(spent).toBeLessThan(DEFAULT_RISK.maxSpendPerWindowWei);

    // `mayEnter` takes the LEDGER itself and reads the window from it — a better shape than
    // passing precomputed totals, because the caller cannot accidentally supply stale ones.
    const gate = await mayEnter({
      state: {
        strayId,
        compartmentWei: 10_000_000_000_000_000n,
        highWaterMarkWei: 10_000_000_000_000_000n,
        equityWei: 10_000_000_000_000_000n,
        positions: [],
      },
      cfg: DEFAULT_RISK,
      ledger: store.ledger,
      idempotencyKey: `${strayId}-next`,
      nowSeconds: now,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("unreachable: asserted above");
    expect(`${gate.reason} ${gate.detail}`).toMatch(/entr/i);
  });

  it("the window is measured from timestamps, so old spends expire", async () => {
    const strayId = `cap-window-${Date.now()}`;
    await store.ledger.record({
      idempotencyKey: `${strayId}-old`,
      strayId,
      amountWei: DEFAULT_RISK.maxSpendPerWindowWei,
      atSeconds: now - DEFAULT_RISK.spendWindowSeconds - 60,
    } as never);

    const inWindow = await store.ledger.spentInWindow(
      strayId,
      DEFAULT_RISK.spendWindowSeconds,
      now,
    );
    expect(inWindow).toBe(0n);
  });
});
