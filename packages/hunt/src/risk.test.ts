import { describe, expect, it } from "vitest";
import {
  assertDurableLedger,
  createMemorySpendLedger,
  DEFAULT_RISK,
  drawdownBps,
  mayEnter,
  mayExit,
  minOutFor,
  type OpenPosition,
  type RiskConfig,
  sizePosition,
  type SpendLedger,
  type SpendRecord,
  stopFired,
  type StrayState,
} from "./risk.js";
import { STOP_LOSS_BPS } from "./signal.js";

const NOW = 1_700_000_000;
const BASE_PRICE = 1_000_000_000_000_000_000n;

function state(overrides: Partial<StrayState> = {}): StrayState {
  return {
    strayId: "stray-1",
    compartmentWei: 5_000_000_000_000_000n, // 0.005 ETH
    highWaterMarkWei: 5_000_000_000_000_000n,
    equityWei: 5_000_000_000_000_000n,
    position: undefined,
    ...overrides,
  };
}

function position(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    token: "0xCatDay",
    entryWei: 2_500_000_000_000_000n,
    entryPriceWei: BASE_PRICE,
    tokenBalance: 1_298_451_422_972_480_224_401_102n,
    openedAtSeconds: NOW - 600,
    taxPct: 1,
    ...overrides,
  };
}

/** A ledger that is `durable: true` — for tests about the caps rather than about durability. */
function durableLedger(seed: readonly SpendRecord[] = []): SpendLedger {
  const inner = createMemorySpendLedger(seed);
  return { ...inner, durable: true };
}

describe("THE HARD STOP LOSS — meridian has none, and for memecoins that is not survivable", () => {
  it("FIRES when the position is at or beyond -235bps", () => {
    // RESEARCH §3d measured 24h moves from -17.1% to +38.8%. The left tail is real and nothing
    // arbitrages it back — there is no NAV anchor on a memecoin. DESIGN §6 Rule 4.
    const mark = BASE_PRICE - (BASE_PRICE * STOP_LOSS_BPS) / 10_000n;
    const verdict = stopFired({ position: position(), markPriceWei: mark, stopLossBps: STOP_LOSS_BPS });
    expect(verdict.fired).toBe(true);
    expect(verdict.moveBps).toBe(-STOP_LOSS_BPS);
    expect(verdict.reason).toMatch(/^STOP:/);
  });

  it("FIRES harder on a larger fall", () => {
    const mark = (BASE_PRICE * 5000n) / 10_000n; // -50%
    const verdict = stopFired({ position: position(), markPriceWei: mark, stopLossBps: STOP_LOSS_BPS });
    expect(verdict.fired).toBe(true);
    expect(verdict.moveBps).toBe(-5000n);
  });

  it("FIRES on the measured -17.1% left tail", () => {
    const mark = (BASE_PRICE * 8290n) / 10_000n;
    expect(
      stopFired({ position: position(), markPriceWei: mark, stopLossBps: STOP_LOSS_BPS }).fired,
    ).toBe(true);
  });

  it("does NOT fire one bp inside the stop — the boundary is exact", () => {
    const mark = BASE_PRICE - (BASE_PRICE * (STOP_LOSS_BPS - 1n)) / 10_000n;
    const verdict = stopFired({ position: position(), markPriceWei: mark, stopLossBps: STOP_LOSS_BPS });
    expect(verdict.fired).toBe(false);
    expect(verdict.reason).toMatch(/^no stop:/);
  });

  it("does NOT fire on a rise", () => {
    const mark = (BASE_PRICE * 12_000n) / 10_000n;
    expect(
      stopFired({ position: position(), markPriceWei: mark, stopLossBps: STOP_LOSS_BPS }).fired,
    ).toBe(false);
  });

  it("does NOT fire on a flat mark", () => {
    expect(
      stopFired({ position: position(), markPriceWei: BASE_PRICE, stopLossBps: STOP_LOSS_BPS })
        .fired,
    ).toBe(false);
  });

  /*
   * ══ THE STOP CANNOT BE TALKED OUT OF FIRING ══
   *
   * It consults only the price and the level. Not the drawdown halt, not the ledger, not the cost
   * of exiting. A stop that another control can veto is not a stop.
   */
  it("depends on price ALONE — no other risk state can veto it", () => {
    const mark = (BASE_PRICE * 5000n) / 10_000n;
    const halted = state({
      position: position(),
      equityWei: 1n,
      highWaterMarkWei: 5_000_000_000_000_000n,
      compartmentWei: 0n,
    });
    // The stray is fully halted, has no compartment, and is 99.99% drawn down.
    expect(drawdownBps(halted)).toBeGreaterThan(DEFAULT_RISK.maxDrawdownBps);
    // The stop still fires, computed from exactly the same inputs as when it was healthy.
    expect(
      stopFired({ position: position(), markPriceWei: mark, stopLossBps: STOP_LOSS_BPS }).fired,
    ).toBe(true);
  });

  it("the default stop IS the level signal.ts derived — the two cannot drift apart", () => {
    expect(DEFAULT_RISK.stopLossBps).toBe(STOP_LOSS_BPS);
  });

  it("refuses to evaluate against a non-positive entry price", () => {
    expect(() =>
      stopFired({
        position: position({ entryPriceWei: 0n }),
        markPriceWei: BASE_PRICE,
        stopLossBps: STOP_LOSS_BPS,
      }),
    ).toThrow(/non-positive entry price/);
  });
});

describe("GETTING OUT IS ALWAYS ALLOWED (DESIGN §6 Rule 5)", () => {
  /*
   * ══ THE TEST THE BRIEF NAMES ══
   *
   * "an exit is allowed even when every other risk control is tripped". Every gate is tripped
   * simultaneously below, and the exit is still permitted.
   */
  it("mayExit() is true with EVERY other risk control simultaneously tripped", async () => {
    const wrecked = state({
      strayId: "stray-doomed",
      compartmentWei: 0n, // no funds
      equityWei: 1n, // -99.99% drawdown
      highWaterMarkWei: 5_000_000_000_000_000n,
      position: position(), // already holding
    });

    // A ledger that has blown through both the value cap and the count cap, and already holds
    // the idempotency key.
    const exhausted = durableLedger([
      { idempotencyKey: "k", strayId: "stray-doomed", amountWei: 10n ** 18n, atSeconds: NOW },
      ...Array.from({ length: 20 }, (_v, i) => ({
        idempotencyKey: `spent-${String(i)}`,
        strayId: "stray-doomed",
        amountWei: 10n ** 18n,
        atSeconds: NOW,
      })),
    ]);

    // Confirm the entry side really is fully blocked — otherwise this test proves nothing.
    const entry = await mayEnter({
      state: wrecked,
      cfg: DEFAULT_RISK,
      ledger: exhausted,
      idempotencyKey: "k",
      nowSeconds: NOW,
    });
    expect(entry.allowed).toBe(false);
    expect(drawdownBps(wrecked)).toBeGreaterThan(DEFAULT_RISK.maxDrawdownBps);
    expect(sizePosition(wrecked, DEFAULT_RISK)).toBe(0n);
    expect(await exhausted.hasKey("k")).toBe(true);
    expect(await exhausted.spentInWindow("stray-doomed", 86_400, NOW)).toBeGreaterThan(
      DEFAULT_RISK.maxSpendPerWindowWei,
    );
    expect(await exhausted.countInWindow("stray-doomed", 86_400, NOW)).toBeGreaterThan(
      DEFAULT_RISK.maxEntriesPerWindow,
    );

    // And the exit is STILL allowed. This is the invariant.
    expect(mayExit()).toBe(true);
  });

  it("mayExit takes NO arguments — there is nothing that could gate it", () => {
    // A function with no inputs cannot be made conditional on risk state. The absence of a
    // parameter is the guarantee; a `mayExit(state)` would invite exactly the check we forbid.
    expect(mayExit.length).toBe(0);
  });

  it("its return type is the literal `true`, so a future `false` cannot typecheck", () => {
    // Compile-time property, exercised at runtime: this assignment only compiles because the
    // declared return type is `true` rather than `boolean`. Any edit adding a falsy branch
    // breaks the build rather than silently trapping a user's capital.
    const allowed: true = mayExit();
    expect(allowed).toBe(true);
  });

  it("no exported denial reason mentions exiting or withdrawing", () => {
    // The EntryDenialReason union is the only refusal vocabulary in this module. If an exit could
    // ever be refused, a reason for it would have to exist somewhere — and none does.
    const entryReasons = [
      "drawdown-halt",
      "position-open",
      "size-below-floor",
      "window-spend-cap",
      "window-count-cap",
      "duplicate-key",
      "no-compartment",
    ];
    for (const r of entryReasons) {
      expect(r).not.toMatch(/exit|withdraw|sell|close/i);
    }
  });
});

describe("the per-stray drawdown halt", () => {
  it("computes drawdown from the high-water mark", () => {
    expect(drawdownBps(state({ equityWei: 4_000_000_000_000_000n }))).toBe(2000n); // -20%
    expect(drawdownBps(state({ equityWei: 5_000_000_000_000_000n }))).toBe(0n);
  });

  it("is 0 above the high-water mark, never negative", () => {
    expect(drawdownBps(state({ equityWei: 9_000_000_000_000_000n }))).toBe(0n);
  });

  it("is 0 when there is no high-water mark yet", () => {
    expect(drawdownBps(state({ highWaterMarkWei: 0n, equityWei: 0n }))).toBe(0n);
  });

  it("HALTS entry at or past -20%", async () => {
    const halted = state({ equityWei: 4_000_000_000_000_000n });
    const gate = await mayEnter({
      state: halted,
      cfg: DEFAULT_RISK,
      ledger: durableLedger(),
      idempotencyKey: "k1",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("unreachable");
    expect(gate.reason).toBe("drawdown-halt");
    // And the message says the owner can still withdraw — the property, stated in the log.
    expect(gate.detail).toMatch(/may still withdraw/);
  });

  it("does NOT halt one bp inside the limit", async () => {
    // -19.99%: 5e15 * (10000-1999)/10000
    const nearly = state({ equityWei: (5_000_000_000_000_000n * 8001n) / 10_000n });
    expect(drawdownBps(nearly)).toBeLessThan(DEFAULT_RISK.maxDrawdownBps);
    const gate = await mayEnter({
      state: nearly,
      cfg: DEFAULT_RISK,
      ledger: durableLedger(),
      idempotencyKey: "k1",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(true);
  });

  it("the halt is ~8-9 losing cycles, as derived — not a number picked to look prudent", () => {
    // 231bps round trip + 235bps stop = ~466bps of position per full losing cycle; at a 5000bps
    // position fraction that is ~233bps of total equity per cycle.
    const perCycleBps = ((231n + 235n) * DEFAULT_RISK.positionFractionBps) / 10_000n;
    const cycles = DEFAULT_RISK.maxDrawdownBps / perCycleBps;
    expect(cycles).toBeGreaterThanOrEqual(5n); // not so tight it fires on variance
    expect(cycles).toBeLessThanOrEqual(12n); // not so loose it never binds
  });

  it("sits inside the measured -17.1% left tail, so it can actually fire", () => {
    expect(DEFAULT_RISK.maxDrawdownBps).toBeLessThan(1710n + 800n);
  });
});

describe("position sizing — flat, because cost is flat (RESEARCH §3c Rule 2)", () => {
  it("takes the configured fraction of the compartment", () => {
    expect(sizePosition(state({ compartmentWei: 4_000_000_000_000_000n }), DEFAULT_RISK)).toBe(
      2_000_000_000_000_000n,
    );
  });

  it("clamps to the maximum", () => {
    const huge = state({ compartmentWei: 10n ** 18n });
    expect(sizePosition(huge, DEFAULT_RISK)).toBe(DEFAULT_RISK.maxPositionWei);
  });

  it("returns 0 below the minimum rather than opening a position gas will eat", () => {
    // At $1 the flat ~$0.016 gas is ~160bps of the position and the round trip ~360bps, which
    // pushes the required gain past 720bps — most of a full mean-absolute 24h move.
    const tiny = state({ compartmentWei: 1_000_000_000_000_000n }); // fraction -> 5e14, under the floor
    expect(sizePosition(tiny, DEFAULT_RISK)).toBe(0n);
  });

  it("returns 0 on an empty or negative compartment", () => {
    expect(sizePosition(state({ compartmentWei: 0n }), DEFAULT_RISK)).toBe(0n);
    expect(sizePosition(state({ compartmentWei: -1n }), DEFAULT_RISK)).toBe(0n);
  });

  it("never sizes above what is actually in the compartment", () => {
    const cfg: RiskConfig = { ...DEFAULT_RISK, positionFractionBps: 50_000n }; // 500%
    const s = state({ compartmentWei: 3_000_000_000_000_000n });
    expect(sizePosition(s, cfg)).toBeLessThanOrEqual(s.compartmentWei);
  });

  it("is NOT size-optimised — the same bps cost applies across the whole range", () => {
    // openhood's U-shaped cost justified an optimal size. Ours is flat, so a flat fraction is
    // the honest rule and anything fancier would be fitting a curve that does not exist.
    const a = sizePosition(state({ compartmentWei: 4_000_000_000_000_000n }), DEFAULT_RISK);
    const b = sizePosition(state({ compartmentWei: 8_000_000_000_000_000n }), DEFAULT_RISK);
    // Exactly LINEAR in the compartment while under the cap: double the funds, double the size.
    // A U-shaped cost model would instead produce an interior optimum, where doubling the
    // compartment moves the size toward a preferred absolute notional rather than doubling it.
    expect(a).toBe(2_000_000_000_000_000n);
    expect(b).toBe(4_000_000_000_000_000n);
    expect(b).toBe(a * 2n);

    // And the cap — not an optimum — is what eventually stops it growing.
    const capped = sizePosition(state({ compartmentWei: 100_000_000_000_000_000n }), DEFAULT_RISK);
    expect(capped).toBe(DEFAULT_RISK.maxPositionWei);
  });
});

describe("minOut — a zero slippage floor is a free MEV sandwich (RESEARCH §7c)", () => {
  it("computes a floor below the expected output", () => {
    const minOut = minOutFor({ expectedOut: 1_000_000n, slippageBps: 100n });
    expect(minOut).toBe(990_000n);
  });

  it("NEVER returns zero — it throws instead", () => {
    // A zero returned from a function named minOut is indistinguishable at the call site from a
    // deliberate "no floor". The proven mainnet tx openhood decoded carried zeros in both slots.
    expect(() => minOutFor({ expectedOut: 0n, slippageBps: 100n })).toThrow(/free MEV sandwich/);
    expect(() => minOutFor({ expectedOut: -1n, slippageBps: 100n })).toThrow(/free MEV sandwich/);
  });

  /*
   * ══ A CHECK THIS SUITE'S OWN SABOTAGE RUN FOUND TO BE DECORATION (S12) ══
   *
   * `minOutFor` has TWO independent guards that both reject a non-positive `expectedOut`: the
   * explicit `expectedOut <= 0n` check, and the later `minOut <= 0n` check that catches a floor
   * which rounded to zero. The test above asserted only that SOMETHING throws — so deleting the
   * first guard entirely left the second one catching every input the test tried, and the
   * sabotage went undetected. Coverage was 100% throughout.
   *
   * This is the unitick finding, quoted in PLAN.md §3 and recorded there as having recurred five
   * times: *"when two mechanisms can independently reject the same input, at least one test must
   * construct an input that only ONE of them rejects."*
   *
   * The two guards reject for DIFFERENT reasons and say so in their messages, so the fix is to
   * pin which guard fires. `expectedOut = 0` must be refused by the FIRST guard — if the first
   * is deleted, the second still throws but with the other message, and this test goes red.
   */
  it("SABOTAGE S12: the non-positive guard fires FIRST, distinguishably from the rounding guard", () => {
    // A zero expected output is rejected by the EXPECTED-OUTPUT guard, naming the input.
    expect(() => minOutFor({ expectedOut: 0n, slippageBps: 100n })).toThrow(
      /non-positive expected output/,
    );
    expect(() => minOutFor({ expectedOut: -1n, slippageBps: 100n })).toThrow(
      /non-positive expected output/,
    );

    // A positive expected output whose floor ROUNDS to zero is rejected by the OTHER guard, with
    // the other message. Two distinct inputs, two distinct guards, each pinned to its own.
    expect(() => minOutFor({ expectedOut: 1n, slippageBps: 9999n })).toThrow(/rounded to zero/);
    expect(() => minOutFor({ expectedOut: 1n, slippageBps: 9999n })).not.toThrow(
      /non-positive expected output/,
    );
  });

  it("refuses a 100% slippage tolerance, which would collapse the floor to zero", () => {
    expect(() => minOutFor({ expectedOut: 1_000_000n, slippageBps: 10_000n })).toThrow(
      /the sandwich this function exists to prevent/,
    );
  });

  it("refuses a negative slippage tolerance", () => {
    expect(() => minOutFor({ expectedOut: 1_000_000n, slippageBps: -1n })).toThrow();
  });

  it("throws rather than returning a floor that rounded to zero", () => {
    // A tiny expected output with a large tolerance truncates to 0 under integer division.
    expect(() => minOutFor({ expectedOut: 1n, slippageBps: 9999n })).toThrow(/rounded to zero/);
  });

  it("a 0bps tolerance is allowed — that is a TIGHT floor, not an absent one", () => {
    expect(minOutFor({ expectedOut: 1_000_000n, slippageBps: 0n })).toBe(1_000_000n);
  });
});

describe("THE DURABLE SPEND LEDGER (RESEARCH §7f)", () => {
  it("REFUSES an in-memory ledger on the money path", () => {
    const memory = createMemorySpendLedger();
    expect(memory.durable).toBe(false);
    expect(() => assertDurableLedger(memory)).toThrow(/An in-memory daily cap is not a daily cap/);
  });

  it("the refusal names meridian's exact failure, both halves of it", () => {
    let message = "";
    try {
      assertDurableLedger(createMemorySpendLedger());
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/spend since last boot/);
    expect(message).toMatch(/long uptime falsely blocked/);
    expect(message).toMatch(/frequent redeploys never enforced/);
    expect(message).toMatch(/never with a Map/);
  });

  it("accepts a durable one", () => {
    expect(() => assertDurableLedger(durableLedger())).not.toThrow();
  });

  /*
   * ══ THE TEST THE BRIEF NAMES: THE LEDGER SURVIVES A SIMULATED RESTART ══
   *
   * meridian's cap "reset on process restart, so it was really 'spend since last boot'". This
   * spends up to the cap, DESTROYS the ledger object entirely, rebuilds it from persisted
   * records, and proves the cap is still enforced. A `Map` inside the module would fail here.
   */
  it("the spend cap SURVIVES a simulated process restart", async () => {
    const strayId = "stray-restart";
    // 6 entries of 0.002 ETH = 0.012 ETH, past both the 0.01 ETH cap and the 6-entry count cap.
    const spends: SpendRecord[] = Array.from({ length: 6 }, (_v, i) => ({
      idempotencyKey: `entry-${String(i)}`,
      strayId,
      amountWei: 2_000_000_000_000_000n,
      atSeconds: NOW - 60 * i,
    }));

    // ── PROCESS 1 ──
    const before = createMemorySpendLedger();
    for (const s of spends) await before.record(s);
    const persisted = before.snapshot();
    expect(await before.spentInWindow(strayId, 86_400, NOW)).toBe(12_000_000_000_000_000n);

    const blockedBefore = await mayEnter({
      state: state({ strayId }),
      cfg: DEFAULT_RISK,
      ledger: { ...before, durable: true },
      idempotencyKey: "new-entry",
      nowSeconds: NOW,
    });
    expect(blockedBefore.allowed).toBe(false);

    // ── THE RESTART. The old ledger object is gone; only the persisted records survive. ──
    const after = { ...createMemorySpendLedger(persisted), durable: true };

    // ── PROCESS 2. The cap is STILL enforced. ──
    expect(await after.spentInWindow(strayId, 86_400, NOW)).toBe(12_000_000_000_000_000n);
    const blockedAfter = await mayEnter({
      state: state({ strayId }),
      cfg: DEFAULT_RISK,
      ledger: after,
      idempotencyKey: "new-entry",
      nowSeconds: NOW,
    });
    expect(blockedAfter.allowed).toBe(false);
    if (blockedAfter.allowed) throw new Error("unreachable");
    expect(blockedAfter.reason).toBe("window-spend-cap");

    // ── AND THE CONTROL: a ledger that did NOT survive the restart would allow it. ──
    // This is meridian's bug, reproduced. It proves the assertion above is testing durability
    // and not something incidental about the state.
    const amnesiac = { ...createMemorySpendLedger(), durable: true };
    const allowedByAmnesiac = await mayEnter({
      state: state({ strayId }),
      cfg: DEFAULT_RISK,
      ledger: amnesiac,
      idempotencyKey: "new-entry",
      nowSeconds: NOW,
    });
    expect(allowedByAmnesiac.allowed).toBe(true);
  });

  it("idempotency keys survive the restart too, so a retry cannot re-execute", async () => {
    const seed: SpendRecord[] = [
      { idempotencyKey: "buy-abc", strayId: "s", amountWei: 1n, atSeconds: NOW },
    ];
    const restarted = createMemorySpendLedger(seed);
    expect(await restarted.hasKey("buy-abc")).toBe(true);
    expect(await restarted.hasKey("buy-xyz")).toBe(false);
  });

  it("recording the same key twice does not double-count", async () => {
    const l = createMemorySpendLedger();
    const r: SpendRecord = { idempotencyKey: "k", strayId: "s", amountWei: 100n, atSeconds: NOW };
    await l.record(r);
    await l.record(r);
    expect(await l.spentInWindow("s", 86_400, NOW)).toBe(100n);
  });

  it("the window is a real time window — spends outside it do not count", async () => {
    const l = createMemorySpendLedger([
      { idempotencyKey: "old", strayId: "s", amountWei: 10n ** 18n, atSeconds: NOW - 90_000 },
      { idempotencyKey: "new", strayId: "s", amountWei: 5n, atSeconds: NOW - 100 },
    ]);
    // The 90,000s-old spend is outside the 86,400s window.
    expect(await l.spentInWindow("s", 86_400, NOW)).toBe(5n);
    expect(await l.countInWindow("s", 86_400, NOW)).toBe(1);
  });

  it("is per-stray — one stray's spending does not consume another's cap", async () => {
    const l = createMemorySpendLedger([
      { idempotencyKey: "a", strayId: "stray-a", amountWei: 10n ** 18n, atSeconds: NOW },
    ]);
    expect(await l.spentInWindow("stray-a", 86_400, NOW)).toBe(10n ** 18n);
    expect(await l.spentInWindow("stray-b", 86_400, NOW)).toBe(0n);
  });

  it("the ledger interface is ASYNC, so a Map cannot satisfy it by accident", () => {
    // A synchronous signature is one a caller can satisfy with a Map, and a type that permits the
    // bug is a type that will eventually get it.
    const l = createMemorySpendLedger();
    expect(l.spentInWindow("s", 1, NOW)).toBeInstanceOf(Promise);
    expect(l.countInWindow("s", 1, NOW)).toBeInstanceOf(Promise);
    expect(l.hasKey("k")).toBeInstanceOf(Promise);
    expect(l.record({ idempotencyKey: "k", strayId: "s", amountWei: 1n, atSeconds: NOW })).toBeInstanceOf(
      Promise,
    );
  });
});

describe("mayEnter — the caps, each refusing for its own reason", () => {
  it("allows a healthy stray", async () => {
    const gate = await mayEnter({
      state: state(),
      cfg: DEFAULT_RISK,
      ledger: durableLedger(),
      idempotencyKey: "k",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(true);
    if (!gate.allowed) throw new Error("unreachable");
    expect(gate.sizeWei).toBe(2_500_000_000_000_000n);
  });

  it("refuses a stray that already holds a position", async () => {
    const gate = await mayEnter({
      state: state({ position: position() }),
      cfg: DEFAULT_RISK,
      ledger: durableLedger(),
      idempotencyKey: "k",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("unreachable");
    expect(gate.reason).toBe("position-open");
  });

  it("refuses an empty compartment", async () => {
    const gate = await mayEnter({
      state: state({ compartmentWei: 0n, equityWei: 5_000_000_000_000_000n }),
      cfg: DEFAULT_RISK,
      ledger: durableLedger(),
      idempotencyKey: "k",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("unreachable");
    expect(gate.reason).toBe("no-compartment");
  });

  it("refuses a duplicate idempotency key — a retry is not a new entry", async () => {
    const l = durableLedger([
      { idempotencyKey: "dup", strayId: "stray-1", amountWei: 1n, atSeconds: NOW },
    ]);
    const gate = await mayEnter({
      state: state(),
      cfg: DEFAULT_RISK,
      ledger: l,
      idempotencyKey: "dup",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("unreachable");
    expect(gate.reason).toBe("duplicate-key");
  });

  it("refuses when the size falls below the floor", async () => {
    const gate = await mayEnter({
      state: state({ compartmentWei: 1_000_000_000_000_000n, equityWei: 1_000_000_000_000_000n, highWaterMarkWei: 1_000_000_000_000_000n }),
      cfg: DEFAULT_RISK,
      ledger: durableLedger(),
      idempotencyKey: "k",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("unreachable");
    expect(gate.reason).toBe("size-below-floor");
  });

  it("refuses on the WINDOW SPEND cap", async () => {
    const l = durableLedger([
      { idempotencyKey: "s1", strayId: "stray-1", amountWei: 9_000_000_000_000_000n, atSeconds: NOW },
    ]);
    const gate = await mayEnter({
      state: state(),
      cfg: DEFAULT_RISK,
      ledger: l,
      idempotencyKey: "k",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("unreachable");
    expect(gate.reason).toBe("window-spend-cap");
    expect(gate.detail).toMatch(/DURABLE ledger/);
  });

  /*
   * A COUNT cap catches what a VALUE cap cannot: a retry storm of small entries that stays under
   * every value limit. `@taia/authority` records Zodiac Roles v2 modelling these separately for
   * exactly this reason. The seed below is 6 x 1 wei — negligible value, at the count limit.
   */
  it("refuses on the WINDOW COUNT cap even when the value cap is nowhere near", async () => {
    const l = durableLedger(
      Array.from({ length: 6 }, (_v, i) => ({
        idempotencyKey: `tiny-${String(i)}`,
        strayId: "stray-1",
        amountWei: 1n,
        atSeconds: NOW,
      })),
    );
    expect(await l.spentInWindow("stray-1", 86_400, NOW)).toBe(6n); // trivially under the cap
    const gate = await mayEnter({
      state: state(),
      cfg: DEFAULT_RISK,
      ledger: l,
      idempotencyKey: "k",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("unreachable");
    expect(gate.reason).toBe("window-count-cap");
  });

  it("every refusal detail is a sentence a human can act on", async () => {
    const cases: Array<{ s: StrayState; l: SpendLedger; k: string }> = [
      { s: state({ position: position() }), l: durableLedger(), k: "k" },
      { s: state({ equityWei: 1n }), l: durableLedger(), k: "k" },
      { s: state({ compartmentWei: 0n }), l: durableLedger(), k: "k" },
    ];
    for (const c of cases) {
      const gate = await mayEnter({
        state: c.s,
        cfg: DEFAULT_RISK,
        ledger: c.l,
        idempotencyKey: c.k,
        nowSeconds: NOW,
      });
      expect(gate.allowed).toBe(false);
      if (gate.allowed) continue;
      expect(gate.detail.length).toBeGreaterThan(30);
    }
  });
});
