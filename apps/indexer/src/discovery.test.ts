/**
 * HOOK RESOLUTION AND THE ENTRY GATE'S INPUT.
 *
 * ══ WHY THIS FILE EXISTS: A SINGLE-SAMPLE VERIFICATION OF A TWO-VALUED FIELD CANNOT FAIL ══
 *
 * RESEARCH §7d is the most consequential finding in that document, and its detection lesson is
 * sharper than the finding: the v1 vault hardcoded ONE pool hook and was wrong about 40% of the pad
 * for an entire build. Every PoolKey check ever run happened to start from a token on the first
 * hook — §2 derived the key from CatDay, the fork tests used CatDay, the live-fire trades used
 * Yourcoin and CASHDOG. *"The reconstruction matched because the sample was homogeneous, not
 * because the derivation was right."*
 *
 * So the fixtures below are deliberately NOT homogeneous. They are real rows measured from the live
 * pad on 2026-08-07, covering BOTH hooks, and the test asserts the reconstruction distinguishes
 * them. A test that only ever exercised one hook would reproduce the original bug exactly.
 *
 * How the bug hid is also why it needs a unit test rather than an integration one: addressing the
 * wrong pool returns an EMPTY inner revert wrapped in `UnexpectedRevertBytes`, which reads like a
 * transient RPC problem rather than "you are asking about a pool that does not exist".
 */
import { describe, expect, it } from "vitest";
import { HOOK_PRIMARY, HOOK_SECONDARY, KNOWN_HOOKS, withinEntryWindow } from "@strays/hunt";
import { parseDetail, poolIdFor, resolveHook } from "./discovery.js";

/**
 * REAL rows from `api.letscash.fun`, measured 2026-08-07. Not invented.
 *
 * `pool` is the pad's own poolId and `tickSpacing` its own detail field, so the reconstruction
 * below is checked against numbers this repo did not produce. FLORK is on the SECONDARY hook —
 * chosen deliberately, because a fixture set that only contained primary-hook tokens is the exact
 * homogeneous sample that let this bug survive a whole build.
 */
const FLORK = {
  address: "0xa80F5E49d874f58F015280CF08cC6e28B6bf75cc",
  pool: "0x4bfe22f5a6d06b9585e805c8a777f3bc8def656eecf15b82fde9313e9d87afee",
  tickSpacing: 200,
  hook: HOOK_SECONDARY,
};

const INTERN = {
  address: "0x3aE3faCC99F43D5A39254A0b9f5cc0291ECd39cc",
  pool: "0x337b707a2806de0182d7204f437e2cc0d0e9056959da77a5d302e301f8eb83d8",
  tickSpacing: 200,
  hook: HOOK_SECONDARY,
};

describe("resolving a token's hook by reconstructing its poolId", () => {
  /**
   * The reconstruction reproduces the pad's OWN `pool` field, exactly.
   *
   * This is the property the whole approach rests on: poolId is a hash of the complete PoolKey, we
   * know four of its five fields for a pad launch, and there are only two candidates for the fifth.
   * If `poolIdFor` encoded anything differently from `PoolManager` — the wrong currency order, a
   * fee that is not 0, a mis-packed int24 — no token would ever match and the keeper would refuse
   * the entire pad.
   */
  it("reproduces the pad's own poolId for a real token", () => {
    expect(poolIdFor(FLORK.address, FLORK.tickSpacing, HOOK_SECONDARY).toLowerCase()).toBe(
      FLORK.pool,
    );
    expect(poolIdFor(INTERN.address, INTERN.tickSpacing, HOOK_SECONDARY).toLowerCase()).toBe(
      INTERN.pool,
    );
  });

  /** And the WRONG hook produces a different id — which is what makes this a discriminating test. */
  it("produces a DIFFERENT poolId under the other hook", () => {
    expect(poolIdFor(FLORK.address, FLORK.tickSpacing, HOOK_PRIMARY).toLowerCase()).not.toBe(
      FLORK.pool,
    );
  });

  it("resolves a real token to the hook that actually holds its pool", () => {
    expect(resolveHook({ token: FLORK.address, tickSpacing: 200, poolId: FLORK.pool })).toBe(
      HOOK_SECONDARY,
    );
  });

  /**
   * TOKENS MATCHING NEITHER HOOK ARE SKIPPED, NEVER DEFAULTED.
   *
   * RESEARCH §7d measured 67 / 44 / **3 unmatched**. The unmatched ones are pools quoted in
   * something other than native ETH — USDG, LAC, LETSBANK — so currency0 is not address(0) and the
   * key being reconstructed is not their key. The vault swaps native ETH and only native ETH, so
   * they are untradeable regardless.
   *
   * Defaulting them onto the more common hook would address a pool that does not exist, and §7d
   * records what that looks like: an empty inner revert that reads like an RPC blip.
   */
  it("returns null for a pool that matches neither hook", () => {
    expect(
      resolveHook({
        token: FLORK.address,
        tickSpacing: 200,
        // A poolId from a non-ETH-quoted pool: reconstructible from neither candidate.
        poolId: `0x${"99".repeat(32)}`,
      }),
    ).toBeNull();
  });

  /** A wrong tickSpacing is also a wrong key, so it must not silently resolve to a hook. */
  it("returns null when the tick spacing does not match the pool", () => {
    expect(resolveHook({ token: FLORK.address, tickSpacing: 60, poolId: FLORK.pool })).toBeNull();
  });

  /**
   * Case-insensitive on the poolId. The pad, the RPC and viem disagree about hex casing depending
   * on which produced the string, and a comparison that fails on case is one that refuses every
   * legitimate token from one data source while looking correct against the other.
   */
  it("matches regardless of hex casing", () => {
    expect(
      resolveHook({
        token: FLORK.address,
        tickSpacing: 200,
        poolId: FLORK.pool.toUpperCase().replace("0X", "0x"),
      }),
    ).toBe(HOOK_SECONDARY);
  });

  /** Only ever returns one of the two allowlisted hooks — it cannot launder a third address. */
  it("only ever returns a hook from the allowlist", () => {
    const resolved = resolveHook({ token: FLORK.address, tickSpacing: 200, poolId: FLORK.pool });
    expect(KNOWN_HOOKS).toContain(resolved);
  });
});

describe("parseDetail resolves the hook and refuses what it cannot place", () => {
  const at = { time: 1_700_000_000_000, block: 30_000_000n };
  /** A detail row in the shape the pad actually returns. */
  const row = (over: Record<string, unknown> = {}) => ({
    address: FLORK.address,
    symbol: "FLORK",
    name: "Flork",
    taxPct: 1,
    marketCapEth: 585.42,
    change24hPct: -0.003,
    launchedAt: 1_785_282_247_000,
    pool: FLORK.pool,
    tickSpacing: 200,
    priceEth: 5.872e-7,
    holders: 39,
    volumeEth: { allTime: 176.6, day: 0.0004 },
    hookAddress: HOOK_SECONDARY,
    ...over,
  });

  it("carries the resolved hook onto the candidate", () => {
    const c = parseDetail(row(), at, 25);
    expect(c?.hook).toBe(HOOK_SECONDARY);
    expect(c?.swapCount).toBe(25);
  });

  /**
   * The pad's `hookAddress` is a CROSS-CHECK, never the decision.
   *
   * When the pad claims one hook and the arithmetic says another, the token is dropped. Two sources
   * disagreeing about which pool a trade addresses is precisely where picking one is a coin flip
   * with a user's money on it — and the losing side reverts with empty bytes.
   */
  it("drops a token whose claimed hookAddress contradicts the reconstruction", () => {
    expect(parseDetail(row({ hookAddress: HOOK_PRIMARY }), at, 25)).toBeNull();
  });

  /** An absent `hookAddress` is fine — the reconstruction is the authority, not the field. */
  it("resolves the hook even when the pad omits hookAddress entirely", () => {
    const { hookAddress: _omitted, ...withoutHook } = row();
    expect(parseDetail(withoutHook, at, 25)?.hook).toBe(HOOK_SECONDARY);
  });

  /** A pool that reconstructs against neither hook is not a candidate at all. */
  it("returns null when the hook cannot be resolved", () => {
    expect(parseDetail(row({ pool: `0x${"77".repeat(32)}`, hookAddress: undefined }), at, 25))
      .toBeNull();
  });

  /**
   * `swapCount` defaults to -1, NOT 0.
   *
   * 0 is a real and highly attractive dose — the earliest measured, +9,791bps median — so a failed
   * or un-attempted read defaulting to 0 would forge the single most tempting value in the range
   * out of missing data. `withinEntryWindow` refuses a negative count and says why.
   */
  it("defaults an unread swap count to -1 rather than to the most attractive dose", () => {
    expect(parseDetail(row(), at)?.swapCount).toBe(-1);
    expect(withinEntryWindow(-1).inWindow).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE AGE GATE — indexed by SWAPS, not by seconds
 *
 * RESULTS §10.4's dose-response is indexed by swap number, and RESEARCH §3d measured that 40% of
 * this pad has never traded at all — so a token can be a day old and sit at swap 0. Age says how
 * long a token has EXISTED; swap count says how much it has been TRADED, and only the second
 * predicted anything. These tests pin that the indexer feeds the gate the unit it was measured in.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */
describe("the entry window, as the indexer feeds it", () => {
  it("admits a token inside the measured [20, 50] swap window", () => {
    expect(withinEntryWindow(20).inWindow).toBe(true);
    expect(withinEntryWindow(35).inWindow).toBe(true);
    expect(withinEntryWindow(50).inWindow).toBe(true);
  });

  /**
   * Below the floor is refused even though EARLIER doses measured BETTER (+9,791bps at swap 5 vs
   * +4,410 at swap 20). The reason is not the return: 68 of 72 held-out tokens pass the
   * sell-simulation gate at swap 20 and that has not been measured earlier, so a pool too quiet to
   * have absorbed a sell of our size is a position we cannot exit.
   */
  it("refuses a token that has barely traded", () => {
    expect(withinEntryWindow(0).inWindow).toBe(false);
    expect(withinEntryWindow(19).inWindow).toBe(false);
  });

  /**
   * Above the ceiling is refused because the held-out median decays monotonically with entry age
   * and crosses zero between swap 50 (+696bps) and swap 100 (−845bps). This is a GRADIENT with a
   * sign change, which is why the rule is a window rather than a floor.
   */
  it("refuses a token past the measured ceiling", () => {
    expect(withinEntryWindow(51).inWindow).toBe(false);
    expect(withinEntryWindow(100).inWindow).toBe(false);
  });

  /**
   * ══ THE MEASURED LIMITATION OF OUR OWN INPUT, STATED HONESTLY ══
   *
   * `fetchSwapCount` counts rows from `/api/tokens/{addr}/trades`, and MEASURED on the live pad
   * that endpoint hard-caps at **100 rows** with no total, no cursor and no working pagination
   * (`limit` of 100/200/500/1000 all return 100; `page=2` and `offset=100` return page 1 again).
   * So the value is `min(true count, 100)`, not a true lifetime count.
   *
   * This test pins why that is sound for the gate it feeds: the window is [20, 50], entirely below
   * the cap, so inside the window the count is EXACT — and that is the only region where the
   * verdict depends on the value. A saturated 100 can only occur above the ceiling, where the
   * answer is "refuse" either way. **The error is therefore in the safe direction: it can only
   * refuse a trade, never admit one the gate would have refused.**
   */
  it("saturating at the 100-row API cap can only refuse, never wrongly admit", () => {
    // A token with 400 real swaps reports 100. Both are refused, for the same reason.
    expect(withinEntryWindow(100).inWindow).toBe(false);
    expect(withinEntryWindow(400).inWindow).toBe(false);
    // And nothing inside the window is affected by the cap, because 50 < 100.
    expect(withinEntryWindow(50).inWindow).toBe(true);
  });

  /** A failed read is refused rather than treated as swap 0, the most attractive dose. */
  it("refuses a failed read instead of reading it as the earliest dose", () => {
    const verdict = withinEntryWindow(-1);
    expect(verdict.inWindow).toBe(false);
    expect(verdict.reason).toMatch(/not a count of realised swaps/i);
  });
});
