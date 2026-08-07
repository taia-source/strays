/**
 * The DURABLE spend ledger, and the durable price history. Postgres-backed.
 *
 * ══ WHY THIS FILE BLOCKS LIVE TRADING UNTIL IT EXISTS ══
 *
 * `@strays/hunt` exports `assertDurableLedger`, which THROWS on any ledger declaring
 * `durable: false`. That is not belt-and-braces; it is the only thing standing between this
 * product and meridian's recorded bug:
 *
 *   > "the daily cap only reset on process restart, so the 'daily' cap was really 'spend since
 *   >  last boot': long uptime falsely blocked, frequent redeploys never enforced."
 *
 * A cap that resets on deploy is not a cap. On Railway, where a push redeploys, it would have been
 * reset several times an hour during this build alone.
 *
 * ══ COMMIT BEFORE SIGNING, NEVER AFTER ══
 *
 * `record()` is called BEFORE the transaction is signed. `@taia/authority`'s `STATE_COMMIT_RULE`
 * quotes Privy's own documentation on why: *"aggregation values are updated AFTER a request is
 * successfully signed, not before. This means multiple concurrent requests may all pass policy
 * evaluation before any of their values are recorded."* That is a time-of-check/time-of-use gap
 * and a retry storm walks straight through it.
 *
 * The idempotency key is a UNIQUE column, so a duplicate insert fails at the DATABASE rather than
 * in application logic. meridian's own mitigation was an in-process mutex, and its docs record why
 * that is not enough: two processes holding the same key *"can each decide to re-center, withdraw,
 * or collect — a real double-spend on live capital, and one that stays invisible while the wallet
 * is empty."* A unique constraint is held by the one thing both processes share.
 *
 * ══ WHY PRICE HISTORY IS HERE TOO ══
 *
 * The in-memory version loses everything on restart, so after every deploy each stray holds until
 * its 60-minute window refills. It fails safe rather than dangerous — a cold history means `hold`,
 * never a spurious trade — but a keeper that cannot trade for an hour after each deploy is a
 * keeper that barely trades. unitick's recorded failure is the same shape from the render side: a
 * page that showed seven flat lines because "history started empty and accumulated one
 * client-side poll per 1.5s".
 */
// ══ A DEFAULT IMPORT, NOT A NAMED ONE ══
//
// `pg` is CommonJS. Under vitest a named import works because the transform interops it; the
// BUILT ESM output crashes at startup with "Named export 'Pool' not found". The 11 ledger tests
// passed while the compiled keeper could not boot — the same shape as this project's mock-router
// bug, where the test agreed with itself and the real artifact did not.
import pg from "pg";

const { Pool } = pg;
import type { SpendLedger, SpendRecord } from "@strays/hunt";

export type PricePoint = {
  readonly ethPerTokenWei: bigint;
  readonly atSeconds: number;
};

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PEAK PRICE WATERMARKS. One row per (stray, slot) — the local copy of the trailing stop's
 * only state.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ WHY A WATERMARK IN PROCESS MEMORY IS THE §7f BUG IN A NEW COSTUME ══
 *
 * RESEARCH §7f records meridian's daily cap: it *"only reset on process restart, so the 'daily' cap
 * was really 'spend since last boot': long uptime falsely blocked, frequent redeploys never
 * enforced."* That bug is already the reason `spend_ledger` above is a table instead of a `Map`.
 *
 * A peak watermark held only in the keeper process is the SAME bug — and it fails strictly worse.
 * A reset spend cap is too permissive about how much is spent. A reset watermark **re-anchors the
 * trailing stop to whatever the price happens to be at boot**, and because `raisePeak` is monotone
 * the stop can only ever be re-armed lower, never restored. Concretely:
 *
 *     entry 100 → peak climbs to 500 → stop sits at 250 (50% trail)
 *     REDEPLOY, watermark lost, price now 260
 *     peak re-seeds at 260 → stop drops to 130
 *
 * The position must now fall to 130 instead of 250 before anything sells: **the trailing stop has
 * been silently WIDENED by 48%, and it widens again on every deploy.** RESULTS §10.3 measured that
 * the trailing exit is what resolves positions at all (0 of 72 held-out positions needed marking to
 * market with it; 100% were unresolved without it), so a watermark that resets does not degrade the
 * strategy — it disarms **the only exit the strategy has**, and does so invisibly, because a cat
 * that never sells looks exactly like a cat whose stop has not been hit.
 *
 * On Railway a push redeploys. During this build alone that would have happened several times an
 * hour.
 *
 * ══ WHY THIS TABLE EXISTS WHEN THE CHAIN ALREADY HOLDS THE SAME NUMBER ══
 *
 * It is deliberately the SECOND copy, not the only one. `StrayVault.Position.peakPriceWei` is the
 * authority and `runTick`'s reconciliation block takes the chain's value every tick. This table is the
 * fast local copy: reading eight slots per stray from the RPC on every tick is eight round-trips
 * per stray per tick, and the keeper needs the number every tick to evaluate the stop.
 *
 * Two copies of one number can disagree, and that is handled rather than assumed away: both sides
 * apply the same monotone `raisePeak`, so the higher value is the true one and applying the rule to
 * both converges them. A disagreement is a reconciliation signal, never a race — and it is
 * VISIBLE, which a single copy would not be.
 *
 * `NUMERIC(78,0)`, like every other wei column here: a uint256 is 78 decimal digits and Postgres
 * `bigint` is 64-bit, which silently truncates. A watermark that truncates is a stop computed from
 * a number that disagrees with the chain.
 *
 * The PRIMARY KEY is (stray_id, slot) because that is exactly what `mark(strayId, slot, priceWei)`
 * names on chain. `token` is stored alongside so a stale row from a CLOSED position cannot be
 * silently attached to the NEXT position that occupies the same slot — `peaksFor` returns the
 * token so the caller can require it to match. A watermark from a previous token is arithmetically unrelated to
 * this one's price and would fire or disarm the stop on a number belonging to something else.
 */
/**
 * Schema, applied idempotently at boot.
 *
 * `NUMERIC(78,0)` for wei: a uint256 is 78 decimal digits, and `bigint` in Postgres is 64-bit,
 * which silently truncates. This is the RESEARCH §7d rule (full precision or nothing) applied to
 * storage rather than to arithmetic — a ledger that rounds is a ledger that disagrees with the
 * chain.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS spend_ledger (
  idempotency_key TEXT PRIMARY KEY,
  stray_id        TEXT NOT NULL,
  amount_wei      NUMERIC(78,0) NOT NULL,
  at_seconds      BIGINT NOT NULL,
  token           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spend_ledger_stray_time ON spend_ledger (stray_id, at_seconds DESC);

CREATE TABLE IF NOT EXISTS price_history (
  token            TEXT NOT NULL,
  at_seconds       BIGINT NOT NULL,
  eth_per_token_wei NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (token, at_seconds)
);
CREATE INDEX IF NOT EXISTS price_history_token_time ON price_history (token, at_seconds DESC);

CREATE TABLE IF NOT EXISTS decisions (
  id          BIGSERIAL PRIMARY KEY,
  stray_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  token       TEXT,
  amount_wei  NUMERIC(78,0) NOT NULL DEFAULT 0,
  rationale   TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  tx_hash     TEXT,
  block       BIGINT NOT NULL,
  at_ms       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_time ON decisions (at_ms DESC);
CREATE INDEX IF NOT EXISTS decisions_stray ON decisions (stray_id, at_ms DESC);

CREATE TABLE IF NOT EXISTS position_peaks (
  stray_id      TEXT NOT NULL,
  slot          INTEGER NOT NULL,
  token         TEXT NOT NULL,
  peak_price_wei NUMERIC(78,0) NOT NULL,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (stray_id, slot)
);
`;

/** One position's watermark, as stored. */
export type PositionPeak = {
  readonly straySlot: number;
  readonly token: string;
  readonly peakPriceWei: bigint;
  readonly updatedAtSeconds: number;
};

export type Store = {
  readonly ledger: SpendLedger;
  readonly recordPrice: (token: string, ethPerTokenWei: bigint, atSeconds: number) => Promise<void>;
  readonly historyFor: (token: string, windowSeconds: number, nowSeconds: number) => Promise<readonly PricePoint[]>;
  readonly recordDecision: (d: {
    strayId: string;
    action: string;
    token: string | null;
    amountWei: bigint;
    rationale: string;
    outcome: string;
    txHash: string | null;
    block: bigint;
    atMs: number;
  }) => Promise<void>;
  /**
   * Raise the stored watermark for one slot. **MONOTONE — it can never be lowered.**
   *
   * The monotonicity is enforced in SQL (`GREATEST` on conflict), not in application code, for the
   * same reason the spend ledger's dedup is a PRIMARY KEY rather than an in-process mutex: two
   * keeper processes hitting the same row must not be able to produce a lower value between them.
   * `@strays/hunt`'s `raisePeak` applies the identical rule on the other side, so the two agree by
   * construction rather than by convention.
   *
   * The token is part of the write. When a slot is REUSED by a different token the row is replaced
   * outright rather than maxed — a previous token's peak is not a larger observation of this
   * token's price, it is an unrelated number, and taking `GREATEST` across a token change would
   * seed a brand-new position with a watermark it never reached and arm its stop immediately.
   */
  readonly raisePeak: (args: {
    strayId: string;
    slot: number;
    token: string;
    peakPriceWei: bigint;
    atSeconds: number;
  }) => Promise<bigint>;
  /**
   * Every stored watermark for one stray, keyed by slot.
   *
   * Returns the token too, so the caller can refuse a row whose token no longer matches the slot's
   * current occupant rather than trusting the slot index alone.
   */
  readonly peaksFor: (strayId: string) => Promise<ReadonlyMap<number, PositionPeak>>;
  /**
   * Forget a slot's watermark, called when a position CLOSES.
   *
   * Not merely housekeeping: a stale row is a watermark that would be handed to the next position
   * opening in that slot. `peaksFor`'s token check already refuses that, so this is the second of
   * two independent guards — the row is deleted, and if the delete were ever missed the token
   * mismatch still catches it.
   */
  readonly clearPeak: (strayId: string, slot: number) => Promise<void>;
  readonly prune: (olderThanSeconds: number, nowSeconds: number) => Promise<void>;
  readonly close: () => Promise<void>;
};

export async function createStore(databaseUrl: string): Promise<Store> {
  const pool = new Pool({
    connectionString: databaseUrl,
    // Railway's Postgres terminates idle connections; a small pool with a short idle timeout
    // reconnects cleanly rather than surfacing ECONNRESET on the first query after a quiet period.
    max: 4,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 8_000,
  });
  /*
   * ══ `CREATE TABLE IF NOT EXISTS` IS NOT ATOMIC AGAINST A CONCURRENT IDENTICAL CREATE ══
   *
   * MEASURED while adding the watermark table: two `createStore` calls racing at boot fail with
   * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`. `IF NOT EXISTS`
   * checks for the table and then creates it, and two sessions can both pass the check — the
   * conflict then surfaces from the system catalog rather than from the statement, which is why
   * the error names `pg_type` and not the table being created.
   *
   * This is not a test-only concern. Railway runs the keeper alongside the web app and a redeploy
   * overlaps the old and new instances, so two processes applying this schema simultaneously is the
   * NORMAL case at boot, not an edge one — and a keeper that crashes on startup because another
   * keeper started at the same moment is a keeper that fails to trade for reasons unrelated to
   * trading.
   *
   * The retry is bounded and narrow: it re-reads the schema exactly once, after which the losing
   * session sees the table the winner committed and every `IF NOT EXISTS` becomes a no-op. A
   * failure that is not this race propagates unchanged — a broken schema must still refuse to boot.
   */
  try {
    await pool.query(SCHEMA);
  } catch (err) {
    const message = String(err);
    const isCreateRace =
      message.includes("pg_type_typname_nsp_index") ||
      message.includes("duplicate key value violates unique constraint");
    if (!isCreateRace) throw err;
    await pool.query(SCHEMA);
  }

  const ledger: SpendLedger = {
    // The whole point of this file.
    durable: true,

    spentInWindow: async (strayId, windowSeconds, nowSeconds) => {
      const { rows } = await pool.query<{ total: string | null }>(
        "SELECT COALESCE(SUM(amount_wei), 0)::TEXT AS total FROM spend_ledger WHERE stray_id = $1 AND at_seconds > $2",
        [strayId, nowSeconds - windowSeconds],
      );
      return BigInt(rows[0]?.total ?? "0");
    },

    countInWindow: async (strayId, windowSeconds, nowSeconds) => {
      const { rows } = await pool.query<{ n: string }>(
        "SELECT COUNT(*)::TEXT AS n FROM spend_ledger WHERE stray_id = $1 AND at_seconds > $2",
        [strayId, nowSeconds - windowSeconds],
      );
      return Number(rows[0]?.n ?? "0");
    },

    hasKey: async (idempotencyKey) => {
      const { rowCount } = await pool.query(
        "SELECT 1 FROM spend_ledger WHERE idempotency_key = $1",
        [idempotencyKey],
      );
      return (rowCount ?? 0) > 0;
    },

    /**
     * Commit a spend.
     *
     * `ON CONFLICT DO NOTHING` makes a replay a no-op rather than an error, so a keeper retrying
     * after an ambiguous timeout does not crash — but the PRIMARY KEY is what actually prevents
     * the double-spend, and it is enforced by Postgres rather than by this process.
     */
    record: async (r: SpendRecord) => {
      await pool.query(
        `INSERT INTO spend_ledger (idempotency_key, stray_id, amount_wei, at_seconds, token)
         VALUES ($1, $2, $3::NUMERIC, $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          r.idempotencyKey,
          r.strayId,
          r.amountWei.toString(),
          r.atSeconds,
          (r as { token?: string }).token ?? null,
        ],
      );
    },
  };

  return {
    ledger,

    recordPrice: async (token, ethPerTokenWei, atSeconds) => {
      await pool.query(
        `INSERT INTO price_history (token, at_seconds, eth_per_token_wei)
         VALUES ($1, $2, $3::NUMERIC) ON CONFLICT (token, at_seconds) DO NOTHING`,
        [token.toLowerCase(), atSeconds, ethPerTokenWei.toString()],
      );
    },

    /** Oldest-first, which is the order `@strays/hunt`'s signal expects. */
    historyFor: async (token, windowSeconds, nowSeconds) => {
      const { rows } = await pool.query<{ at_seconds: string; eth_per_token_wei: string }>(
        `SELECT at_seconds::TEXT, eth_per_token_wei::TEXT FROM price_history
         WHERE token = $1 AND at_seconds > $2 ORDER BY at_seconds ASC`,
        [token.toLowerCase(), nowSeconds - windowSeconds],
      );
      return rows.map((r) => ({
        ethPerTokenWei: BigInt(r.eth_per_token_wei),
        atSeconds: Number(r.at_seconds),
      }));
    },

    recordDecision: async (d) => {
      await pool.query(
        `INSERT INTO decisions (stray_id, action, token, amount_wei, rationale, outcome, tx_hash, block, at_ms)
         VALUES ($1,$2,$3,$4::NUMERIC,$5,$6,$7,$8,$9)`,
        [
          d.strayId,
          d.action,
          d.token,
          d.amountWei.toString(),
          d.rationale,
          d.outcome,
          d.txHash,
          d.block.toString(),
          d.atMs,
        ],
      );
    },

    /**
     * Raise a watermark, monotonically, in ONE statement.
     *
     * `GREATEST(existing, incoming)` inside the `DO UPDATE` means the max is computed by the
     * database under the row lock the upsert already holds — so two keepers racing on the same slot
     * cannot interleave a read and a write and lose the higher value. Doing this as
     * SELECT-then-UPDATE in TypeScript would reintroduce exactly the time-of-check/time-of-use gap
     * the spend ledger's header is about.
     *
     * The `WHERE position_peaks.token = EXCLUDED.token` guard is what keeps a slot's history from
     * bleeding across tokens: when the token differs the `GREATEST` branch does not apply and the
     * row is overwritten with the new token's price instead. Same slot, different position, fresh
     * watermark.
     *
     * Returns the peak AFTER the call — the effective value — so a caller never needs a second read
     * to know what the stop will be computed from. `StrayVault.mark()` returns it for the same
     * reason.
     */
    raisePeak: async ({ strayId, slot, token, peakPriceWei, atSeconds }) => {
      if (peakPriceWei <= 0n) {
        // A failed price read must never touch the watermark. `@strays/hunt`'s `raisePeak` throws
        // on this too — a watermark that moves on bad data is a stop that moves on bad data.
        throw new Error(
          `refusing to store a peak watermark of ${peakPriceWei.toString()} wei for ${strayId} ` +
            `slot ${String(slot)}: a non-positive mark is a failed read, and a zero watermark ` +
            "disarms the trailing stop entirely (RESEARCH §7f)",
        );
      }
      const { rows } = await pool.query<{ peak_price_wei: string }>(
        `INSERT INTO position_peaks (stray_id, slot, token, peak_price_wei, updated_at)
         VALUES ($1, $2, $3, $4::NUMERIC, $5)
         ON CONFLICT (stray_id, slot) DO UPDATE SET
           peak_price_wei = CASE
             WHEN position_peaks.token = EXCLUDED.token
               THEN GREATEST(position_peaks.peak_price_wei, EXCLUDED.peak_price_wei)
             ELSE EXCLUDED.peak_price_wei
           END,
           token = EXCLUDED.token,
           updated_at = EXCLUDED.updated_at
         RETURNING peak_price_wei::TEXT`,
        [strayId, slot, token.toLowerCase(), peakPriceWei.toString(), atSeconds],
      );
      return BigInt(rows[0]?.peak_price_wei ?? peakPriceWei.toString());
    },

    peaksFor: async (strayId) => {
      const { rows } = await pool.query<{
        slot: number;
        token: string;
        peak_price_wei: string;
        updated_at: string;
      }>(
        `SELECT slot, token, peak_price_wei::TEXT, updated_at::TEXT
           FROM position_peaks WHERE stray_id = $1`,
        [strayId],
      );
      const out = new Map<number, PositionPeak>();
      for (const r of rows) {
        out.set(Number(r.slot), {
          straySlot: Number(r.slot),
          token: r.token,
          peakPriceWei: BigInt(r.peak_price_wei),
          updatedAtSeconds: Number(r.updated_at),
        });
      }
      return out;
    },

    clearPeak: async (strayId, slot) => {
      await pool.query("DELETE FROM position_peaks WHERE stray_id = $1 AND slot = $2", [
        strayId,
        slot,
      ]);
    },

    /** Price history is unbounded otherwise. The ledger is NOT pruned — it is the audit trail. */
    prune: async (olderThanSeconds, nowSeconds) => {
      await pool.query("DELETE FROM price_history WHERE at_seconds < $1", [
        nowSeconds - olderThanSeconds,
      ]);
    },

    close: () => pool.end(),
  };
}
