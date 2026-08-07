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
`;

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
  await pool.query(SCHEMA);

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

    /** Price history is unbounded otherwise. The ledger is NOT pruned — it is the audit trail. */
    prune: async (olderThanSeconds, nowSeconds) => {
      await pool.query("DELETE FROM price_history WHERE at_seconds < $1", [
        nowSeconds - olderThanSeconds,
      ]);
    },

    close: () => pool.end(),
  };
}
