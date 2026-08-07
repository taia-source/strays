/**
 * Tests for the durable spend ledger, against a REAL Postgres.
 *
 * These do not run against a mock, deliberately. The properties that matter here — a UNIQUE
 * constraint stopping a concurrent double-spend, `NUMERIC(78,0)` holding a full uint256 without
 * truncating — are properties of the DATABASE, and a mock would assert only that I remembered to
 * write them down. This project already shipped a bug where every unit test passed against a mock
 * router while the real venue reverted (`STATE.md` bug #2): *a mock is a statement about what you
 * already believe.*
 *
 * Skipped cleanly when `STRAYS_TEST_DATABASE_URL` is unset so a bare `vitest run` still works. The
 * CI/local invocation sets it, and `it.skip` reports as skipped rather than silently passing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDurableLedger, createMemorySpendLedger } from "@strays/hunt";
import { createStore, type Store } from "./ledger.js";

const URL = process.env.STRAYS_TEST_DATABASE_URL ?? "";
const run = URL.length > 0 ? describe : describe.skip;

run("the durable spend ledger, against real Postgres", () => {
  let store: Store;

  beforeAll(async () => {
    store = await createStore(URL);
  });

  afterAll(async () => {
    await store?.close();
  });

  /** The one property `assertDurableLedger` exists to check. */
  it("declares itself durable, and the in-memory one does not", () => {
    expect(store.ledger.durable).toBe(true);
    expect(() => assertDurableLedger(store.ledger)).not.toThrow();

    const memory = createMemorySpendLedger();
    expect(memory.durable).toBe(false);
    expect(() => assertDurableLedger(memory)).toThrow(/non-durable/i);
  });

  /**
   * THE DOUBLE-SPEND RACE, which is the reason this is Postgres and not a Map.
   *
   * meridian shipped an in-process mutex, and its own docs record why that was not enough: two
   * processes holding the same key *"can each decide to re-center, withdraw, or collect — a real
   * double-spend on live capital."* An in-process guard is held by one process; a UNIQUE
   * constraint is held by the thing both processes share.
   *
   * Twenty concurrent commits of the SAME key must produce exactly one row.
   */
  it("a concurrent replay of one idempotency key commits exactly once", async () => {
    const key = `race-${Date.now()}`;
    const strayId = `stray-race-${Date.now()}`;
    const at = Math.floor(Date.now() / 1000);

    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.ledger.record({
          idempotencyKey: key,
          strayId,
          amountWei: 1_000_000_000_000_000n,
          atSeconds: at,
        } as never),
      ),
    );

    const count = await store.ledger.countInWindow(strayId, 3600, at + 1);
    expect(count).toBe(1);

    const spent = await store.ledger.spentInWindow(strayId, 3600, at + 1);
    expect(spent).toBe(1_000_000_000_000_000n);
  });

  /**
   * FULL PRECISION. `bigint` in Postgres is 64-bit and would silently truncate a uint256.
   *
   * RESEARCH §7d records the shape of this bug on the arithmetic side: an 18-decimal balance needs
   * ~22 significant digits, float64 holds ~15-17, and a round-tripped amount reverts with
   * TRANSFER_FROM_FAILED. A ledger that rounds is a ledger that disagrees with the chain.
   */
  it("stores a full uint256 without truncating", async () => {
    const strayId = `stray-big-${Date.now()}`;
    const at = Math.floor(Date.now() / 1000);
    // Larger than 2^64, which is where a Postgres BIGINT column would fail.
    const huge = 123_456_789_012_345_678_901_234_567_890n;

    await store.ledger.record({
      idempotencyKey: `big-${strayId}`,
      strayId,
      amountWei: huge,
      atSeconds: at,
    } as never);

    const spent = await store.ledger.spentInWindow(strayId, 3600, at + 1);
    expect(spent).toBe(huge);
  });

  /**
   * THE MERIDIAN BUG ITSELF: a cap that survives a restart.
   *
   * Its cap "only reset on process restart, so the 'daily' cap was really 'spend since last boot'."
   * A second `createStore` is a new pool and new process state; the spend must still be there.
   */
  it("a spend survives a simulated process restart", async () => {
    const strayId = `stray-restart-${Date.now()}`;
    const at = Math.floor(Date.now() / 1000);
    await store.ledger.record({
      idempotencyKey: `restart-${strayId}`,
      strayId,
      amountWei: 7_000_000_000_000_000n,
      atSeconds: at,
    } as never);

    const reborn = await createStore(URL);
    try {
      const spent = await reborn.ledger.spentInWindow(strayId, 3600, at + 1);
      expect(spent).toBe(7_000_000_000_000_000n);
    } finally {
      await reborn.close();
    }
  });

  /** The window is measured from timestamps, never from row count. */
  it("excludes spends outside the window", async () => {
    const strayId = `stray-window-${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    await store.ledger.record({
      idempotencyKey: `old-${strayId}`,
      strayId,
      amountWei: 5n,
      atSeconds: now - 7200,
    } as never);
    await store.ledger.record({
      idempotencyKey: `new-${strayId}`,
      strayId,
      amountWei: 3n,
      atSeconds: now - 60,
    } as never);

    expect(await store.ledger.spentInWindow(strayId, 3600, now)).toBe(3n);
    expect(await store.ledger.spentInWindow(strayId, 86400, now)).toBe(8n);
  });

  it("one stray's spend is invisible to another", async () => {
    const a = `stray-a-${Date.now()}`;
    const b = `stray-b-${Date.now()}`;
    const at = Math.floor(Date.now() / 1000);
    await store.ledger.record({
      idempotencyKey: `iso-${a}`,
      strayId: a,
      amountWei: 9n,
      atSeconds: at,
    } as never);

    expect(await store.ledger.spentInWindow(a, 3600, at + 1)).toBe(9n);
    expect(await store.ledger.spentInWindow(b, 3600, at + 1)).toBe(0n);
  });

  it("hasKey sees a committed key and not an uncommitted one", async () => {
    const key = `seen-${Date.now()}`;
    expect(await store.ledger.hasKey(key)).toBe(false);
    await store.ledger.record({
      idempotencyKey: key,
      strayId: "s",
      amountWei: 1n,
      atSeconds: Math.floor(Date.now() / 1000),
    } as never);
    expect(await store.ledger.hasKey(key)).toBe(true);
  });

  describe("price history", () => {
    it("round-trips oldest-first and respects the window", async () => {
      const token = `0xtoken${Date.now()}`;
      const now = Math.floor(Date.now() / 1000);
      await store.recordPrice(token, 300n, now - 30);
      await store.recordPrice(token, 100n, now - 90);
      await store.recordPrice(token, 200n, now - 60);
      await store.recordPrice(token, 999n, now - 100_000); // outside every window used below

      const h = await store.historyFor(token, 3600, now);
      expect(h.map((p) => p.ethPerTokenWei)).toEqual([100n, 200n, 300n]);
      expect(h[0]!.atSeconds).toBeLessThan(h[2]!.atSeconds);
    });

    /** Survives a restart, which is the whole reason it moved out of a Map. */
    it("survives a simulated process restart", async () => {
      const token = `0xsurvive${Date.now()}`;
      const now = Math.floor(Date.now() / 1000);
      await store.recordPrice(token, 424242n, now - 10);

      const reborn = await createStore(URL);
      try {
        const h = await reborn.historyFor(token, 3600, now);
        expect(h).toHaveLength(1);
        expect(h[0]!.ethPerTokenWei).toBe(424242n);
      } finally {
        await reborn.close();
      }
    });

    it("is case-insensitive on the token address", async () => {
      const now = Math.floor(Date.now() / 1000);
      const lower = `0xabc${Date.now()}`;
      await store.recordPrice(lower.toUpperCase(), 55n, now - 5);
      const h = await store.historyFor(lower.toLowerCase(), 3600, now);
      expect(h).toHaveLength(1);
    });
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
   * THE PEAK PRICE WATERMARKS
   *
   * The durable half of the trailing stop. `tick.test.ts` proves the RECONCILIATION survives a
   * restart against a fake store; this proves the STORE itself does, against real Postgres — and
   * that its monotonicity is enforced by the database rather than by application code, which is
   * the same argument the spend ledger's UNIQUE constraint makes: an in-process guard is held by
   * one process, a SQL constraint is held by the thing every process shares.
   * ══════════════════════════════════════════════════════════════════════════════════════════ */
  describe("position peak watermarks", () => {
    it("raises a watermark and reads it back", async () => {
      const strayId = `peak-basic-${Date.now()}`;
      const at = Math.floor(Date.now() / 1000);
      const effective = await store.raisePeak({
        strayId,
        slot: 3,
        token: "0xTOKEN",
        peakPriceWei: 5_000_000n,
        atSeconds: at,
      });
      expect(effective).toBe(5_000_000n);

      const peaks = await store.peaksFor(strayId);
      expect(peaks.get(3)?.peakPriceWei).toBe(5_000_000n);
      // Lowercased on write, so a case difference between the pad and the RPC cannot split a row.
      expect(peaks.get(3)?.token).toBe("0xtoken");
    });

    /**
     * MONOTONE, ENFORCED IN SQL.
     *
     * `GREATEST` runs under the row lock the upsert already holds, so two keepers racing on the
     * same slot cannot interleave a read and a write and lose the higher value. A
     * SELECT-then-UPDATE in TypeScript would reintroduce exactly the time-of-check/time-of-use gap
     * this file's header is about.
     *
     * The direction matters: a watermark that can FALL is a trailing stop that follows the price
     * down, which is not a trailing stop but a very slow market order.
     */
    it("never lowers a watermark, however many times a lower price is reported", async () => {
      const strayId = `peak-monotone-${Date.now()}`;
      const at = Math.floor(Date.now() / 1000);
      const args = { strayId, slot: 0, token: "0xsame" };

      await store.raisePeak({ ...args, peakPriceWei: 9_000_000n, atSeconds: at });
      const lowered = await store.raisePeak({ ...args, peakPriceWei: 1_000n, atSeconds: at + 1 });
      expect(lowered).toBe(9_000_000n);

      // Concurrently, too — the max must hold under a race, not just in sequence.
      await Promise.all(
        [5n, 500n, 50_000n, 900n].map((p) =>
          store.raisePeak({ ...args, peakPriceWei: p, atSeconds: at + 2 }),
        ),
      );
      expect((await store.peaksFor(strayId)).get(0)?.peakPriceWei).toBe(9_000_000n);
    });

    it("raises when the new price is genuinely higher", async () => {
      const strayId = `peak-raise-${Date.now()}`;
      const at = Math.floor(Date.now() / 1000);
      const args = { strayId, slot: 1, token: "0xup" };
      await store.raisePeak({ ...args, peakPriceWei: 100n, atSeconds: at });
      expect(await store.raisePeak({ ...args, peakPriceWei: 700n, atSeconds: at + 1 })).toBe(700n);
    });

    /**
     * A SLOT REUSED BY A DIFFERENT TOKEN GETS A FRESH WATERMARK, NOT THE PREVIOUS ONE'S.
     *
     * `GREATEST` is deliberately NOT applied across a token change. A previous token's peak is not
     * a larger observation of this token's price — it is an unrelated number, and carrying it over
     * would seed a brand-new position with a watermark it never reached, arming its trailing stop
     * immediately at a level it has never traded near.
     */
    it("resets rather than maxes when a slot is reused by another token", async () => {
      const strayId = `peak-reuse-${Date.now()}`;
      const at = Math.floor(Date.now() / 1000);
      await store.raisePeak({
        strayId,
        slot: 4,
        token: "0xold",
        peakPriceWei: 50_000_000n,
        atSeconds: at,
      });
      const fresh = await store.raisePeak({
        strayId,
        slot: 4,
        token: "0xnew",
        peakPriceWei: 12n,
        atSeconds: at + 1,
      });
      // NOT 50,000,000 — the high belonged to a different position entirely.
      expect(fresh).toBe(12n);
      expect((await store.peaksFor(strayId)).get(4)?.token).toBe("0xnew");
    });

    /** FULL PRECISION. A watermark that truncates is a stop computed from a number the chain disagrees with. */
    it("stores a full uint256 watermark without truncating", async () => {
      const strayId = `peak-huge-${Date.now()}`;
      const huge = 987_654_321_098_765_432_109_876_543_210n;
      await store.raisePeak({
        strayId,
        slot: 7,
        token: "0xbig",
        peakPriceWei: huge,
        atSeconds: Math.floor(Date.now() / 1000),
      });
      expect((await store.peaksFor(strayId)).get(7)?.peakPriceWei).toBe(huge);
    });

    /** A non-positive mark is a FAILED READ and must never touch the watermark. */
    it("refuses to store a zero or negative watermark", async () => {
      const strayId = `peak-zero-${Date.now()}`;
      const at = Math.floor(Date.now() / 1000);
      await expect(
        store.raisePeak({ strayId, slot: 0, token: "0xz", peakPriceWei: 0n, atSeconds: at }),
      ).rejects.toThrow(/refusing/i);
      await expect(
        store.raisePeak({ strayId, slot: 0, token: "0xz", peakPriceWei: -5n, atSeconds: at }),
      ).rejects.toThrow(/refusing/i);
    });

    /** Slots are independent. Eight positions means eight watermarks that cannot bleed together. */
    it("keeps each slot's watermark separate", async () => {
      const strayId = `peak-slots-${Date.now()}`;
      const at = Math.floor(Date.now() / 1000);
      for (let slot = 0; slot < 8; slot++) {
        await store.raisePeak({
          strayId,
          slot,
          token: `0xtok${slot}`,
          peakPriceWei: BigInt((slot + 1) * 1000),
          atSeconds: at,
        });
      }
      const peaks = await store.peaksFor(strayId);
      expect(peaks.size).toBe(8);
      expect(peaks.get(0)?.peakPriceWei).toBe(1000n);
      expect(peaks.get(7)?.peakPriceWei).toBe(8000n);
    });

    /** And one stray's watermarks are invisible to another, like its spend. */
    it("isolates watermarks between strays", async () => {
      const a = `peak-iso-a-${Date.now()}`;
      const b = `peak-iso-b-${Date.now()}`;
      await store.raisePeak({
        strayId: a,
        slot: 0,
        token: "0xt",
        peakPriceWei: 42n,
        atSeconds: Math.floor(Date.now() / 1000),
      });
      expect((await store.peaksFor(a)).size).toBe(1);
      expect((await store.peaksFor(b)).size).toBe(0);
    });

    /** A closed slot's watermark is removed, so it cannot attach to the slot's next occupant. */
    it("clears a watermark when a position closes", async () => {
      const strayId = `peak-clear-${Date.now()}`;
      await store.raisePeak({
        strayId,
        slot: 2,
        token: "0xgone",
        peakPriceWei: 7n,
        atSeconds: Math.floor(Date.now() / 1000),
      });
      expect((await store.peaksFor(strayId)).size).toBe(1);
      await store.clearPeak(strayId, 2);
      expect((await store.peaksFor(strayId)).size).toBe(0);
    });

    /**
     * ══ THE §7f PROPERTY ITSELF, AGAINST A REAL DATABASE ══
     *
     * A new `createStore` is a new pool and new process state — the closest thing to a Railway
     * redeploy this suite can produce. The watermark must still be there, because a watermark that
     * does not survive a restart re-anchors the trailing stop to the current price and silently
     * disarms the only exit this strategy has.
     */
    it("a watermark survives a simulated process restart", async () => {
      const strayId = `peak-restart-${Date.now()}`;
      await store.raisePeak({
        strayId,
        slot: 5,
        token: "0xsurvivor",
        peakPriceWei: 8_000_000n,
        atSeconds: Math.floor(Date.now() / 1000),
      });

      const reborn = await createStore(URL);
      try {
        const peaks = await reborn.peaksFor(strayId);
        expect(peaks.get(5)?.peakPriceWei).toBe(8_000_000n);
        // And the reborn process still cannot lower it — the rule outlives the process too.
        const lowered = await reborn.raisePeak({
          strayId,
          slot: 5,
          token: "0xsurvivor",
          peakPriceWei: 3_000_000n,
          atSeconds: Math.floor(Date.now() / 1000),
        });
        expect(lowered).toBe(8_000_000n);
      } finally {
        await reborn.close();
      }
    });
  });

  it("records a decision with its block and outcome", async () => {
    await store.recordDecision({
      strayId: `0xdec${Date.now()}`,
      action: "hunt",
      token: "0xtoken",
      amountWei: 1_200_000_000_000_000n,
      rationale: "momentum cleared the cost bar",
      outcome: "landed",
      txHash: "0xdeadbeef",
      block: 30_000_000n,
      atMs: Date.now(),
    });
    // No throw is the assertion; the read path is exercised by the web app.
    expect(true).toBe(true);
  });
});
