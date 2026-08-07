import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertDurableLedger,
  createMemorySpendLedger,
  DEFAULT_RISK,
  drawdownBps,
  mayEnter,
  mayExit,
  committedWei,
  firstFreeSlot,
  MAX_POSITIONS,
  minOutFor,
  type OpenPosition,
  type RiskConfig,
  sizePosition,
  type SpendLedger,
  type SpendRecord,
  stopFired,
  type StrayState,
} from "./risk.js";
import { HOOK_PRIMARY } from "./hook.js";
import { STOP_LOSS_BPS } from "./signal.js";
import { TRAIL_BPS } from "./trail.js";

const NOW = 1_700_000_000;
const BASE_PRICE = 1_000_000_000_000_000_000n;

function state(overrides: Partial<StrayState> = {}): StrayState {
  return {
    strayId: "stray-1",
    // 0.016 ETH ~= $31. Funded for EIGHT slots at 1/8 each (0.002 ETH, twice the 0.001 floor) —
    // §10.5's ladder is denominated in dollars precisely because slot count is a funding question.
    compartmentWei: 16_000_000_000_000_000n,
    highWaterMarkWei: 16_000_000_000_000_000n,
    equityWei: 16_000_000_000_000_000n,
    positions: [],
    ...overrides,
  };
}

function position(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    token: "0xCatDay",
    slot: 0,
    entryWei: 2_000_000_000_000_000n, // 1/8 of the 0.016 ETH compartment
    entryPriceWei: BASE_PRICE,
    peakPriceWei: BASE_PRICE,
    hook: HOOK_PRIMARY,
    tokenBalance: 1_298_451_422_972_480_224_401_102n,
    openedAtSeconds: NOW - 600,
    taxPct: 1,
    ...overrides,
  };
}

/** `n` positions in slots 0..n-1, each on its own token. For the multi-slot tests. */
function positions(n: number, overrides: Partial<OpenPosition> = {}): OpenPosition[] {
  return Array.from({ length: n }, (_v, i) =>
    position({ slot: i, token: `0xToken${String(i)}`, ...overrides }),
  );
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
      positions: [position()],
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
      positions: positions(MAX_POSITIONS), // every slot occupied
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
      "slots-full",
      "duplicate-token",
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
    expect(drawdownBps(state({ equityWei: 12_800_000_000_000_000n }))).toBe(2000n); // -20%
    expect(drawdownBps(state({ equityWei: 16_000_000_000_000_000n }))).toBe(0n);
  });

  it("is 0 above the high-water mark, never negative", () => {
    expect(drawdownBps(state({ equityWei: 30_000_000_000_000_000n }))).toBe(0n);
  });

  it("is 0 when there is no high-water mark yet", () => {
    expect(drawdownBps(state({ highWaterMarkWei: 0n, equityWei: 0n }))).toBe(0n);
  });

  it("HALTS entry at or past -20%", async () => {
    const halted = state({ equityWei: 12_800_000_000_000_000n });
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
    // -19.99%: 1.6e16 * (10000-1999)/10000
    const nearly = state({ equityWei: (16_000_000_000_000_000n * 8001n) / 10_000n });
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

  it("the halt is ~3 fully-lost positions, as re-derived for the trailing exit", () => {
    /*
     * The derivation moved with the exit rule, and the NUMBER did not — which is exactly the
     * situation where an unasserted derivation rots. It was: 231bps round trip + 235bps hard stop
     * = ~466bps per losing cycle, at a 5000bps position fraction = ~233bps of equity, so 2000bps
     * was ~8-9 cycles. It is now: a 5000bps trailing stop + ~208bps round trip = ~5208bps per
     * fully-lost position, at a 1250bps fraction = ~651bps of equity, so 2000bps is ~3.
     *
     * Three is the right direction for a strategy whose measured win rate is 73.6% (§10.4): three
     * total losses out of eight concurrent tickets is far outside what that rate produces by
     * chance, where eight would only fire after most of the money was gone.
     */
    const perLostPositionBps =
      ((TRAIL_BPS + 208n) * DEFAULT_RISK.positionFractionBps) / 10_000n;
    const positionsLost = DEFAULT_RISK.maxDrawdownBps / perLostPositionBps;
    expect(positionsLost).toBeGreaterThanOrEqual(2n); // not so tight it fires on the p10 tail
    expect(positionsLost).toBeLessThanOrEqual(5n); // not so loose it only binds after the money is gone

    // And the halt must be reachable by BREADTH as well as depth: eight positions each down 20%
    // of a 1250bps stake is 2000bps of equity — exactly the halt. That is the genuinely new shape.
    const breadthBps =
      (2000n * DEFAULT_RISK.positionFractionBps * BigInt(MAX_POSITIONS)) / 10_000n;
    expect(breadthBps).toBe(DEFAULT_RISK.maxDrawdownBps);
  });

  it("sits inside the measured -17.1% left tail, so it can actually fire", () => {
    expect(DEFAULT_RISK.maxDrawdownBps).toBeLessThan(1710n + 800n);
  });
});

describe("position sizing — flat, because cost is flat (RESEARCH §3c Rule 2)", () => {
  it("takes the configured fraction of the compartment", () => {
    // 1250bps = 1/8 of 0.004 ETH = 0.0005 ETH... which is UNDER the 0.001 ETH floor, so this
    // stray cannot fund eight slots at all and correctly refuses. That is the floor doing its job,
    // and it is why §10.5's ladder is denominated in dollars: 8 slots needs $20, not $5.
    expect(sizePosition(state({ compartmentWei: 4_000_000_000_000_000n }), DEFAULT_RISK)).toBe(0n);
    // A stray funded for eight slots at the floor: 0.008 ETH -> 0.001 ETH per slot, exactly.
    expect(sizePosition(state({ compartmentWei: 8_000_000_000_000_000n }), DEFAULT_RISK)).toBe(
      1_000_000_000_000_000n,
    );
  });

  /*
   * ══ THE MULTI-SLOT SIZING PROPERTY: EIGHT EQUAL POSITIONS, NOT A SHRINKING SEQUENCE ══
   *
   * The bug this pins is the obvious implementation: apply the fraction to the FREE compartment.
   * That compounds downward — slot 1 gets 1/8 of everything, slot 2 gets 1/8 of the remaining 7/8,
   * and by slot 4 the size is under the 0.001 ETH floor and the stray reports `size-below-floor`
   * while holding money and free slots. §10.5's whole finding is about how many opportunities get
   * TAKEN, so a sizing rule that silently caps the portfolio at 3 positions undoes the round.
   */
  it("sizes EIGHT EQUAL positions from one compartment — the fraction does not compound down", () => {
    const funded = 16_000_000_000_000_000n; // 0.016 ETH ~= $31, comfortably above the $20 rung
    const perSlot = funded / BigInt(MAX_POSITIONS); // 0.002 ETH
    let free = funded;
    const opened: OpenPosition[] = [];

    for (let i = 0; i < MAX_POSITIONS; i++) {
      const s = state({ compartmentWei: free, positions: opened });
      const size = sizePosition(s, DEFAULT_RISK);
      expect(size, `slot ${String(i)} must be sized like every other slot`).toBe(perSlot);
      opened.push(position({ slot: i, token: `0xToken${String(i)}`, entryWei: size }));
      free -= size;
    }

    // Eight equal positions exactly consume the compartment. Nothing left, nothing stranded.
    expect(free).toBe(0n);
    expect(committedWei(state({ positions: opened }))).toBe(funded);
  });

  it("sizes against free + committed, so a full portfolio would size the same as an empty one", () => {
    // The denominator is trading capital, not free cash. Same stray, same total money, different
    // split between free and committed: the target size must not move.
    const empty = state({ compartmentWei: 16_000_000_000_000_000n, positions: [] });
    const halfDeployed = state({
      compartmentWei: 8_000_000_000_000_000n,
      positions: positions(4, { entryWei: 2_000_000_000_000_000n }),
    });
    expect(sizePosition(halfDeployed, DEFAULT_RISK)).toBe(sizePosition(empty, DEFAULT_RISK));
  });

  it("never sizes above FREE cash, however much is committed", () => {
    // Committed capital sets the target size; it cannot pay for a new position. A stray whose
    // positions have lost value cannot conjure the difference.
    const strapped = state({
      compartmentWei: 1_200_000_000_000_000n,
      positions: positions(7, { entryWei: 2_000_000_000_000_000n }),
    });
    const size = sizePosition(strapped, DEFAULT_RISK);
    expect(size).toBeLessThanOrEqual(strapped.compartmentWei);
    expect(size).toBeGreaterThan(0n);
  });

  it("the fraction IS 10000/MAX_POSITIONS — the two cannot drift apart", () => {
    // If someone raises MAX_POSITIONS without re-deriving the fraction, the stray would fund only
    // some of its slots and the ladder measurement would no longer describe what it does.
    expect(DEFAULT_RISK.positionFractionBps).toBe(10_000n / BigInt(MAX_POSITIONS));
  });

  it("clamps to the maximum", () => {
    const huge = state({ compartmentWei: 10n ** 18n });
    expect(sizePosition(huge, DEFAULT_RISK)).toBe(DEFAULT_RISK.maxPositionWei);
  });

  it("returns 0 below the minimum rather than opening a position gas will eat", () => {
    // At $1 the flat ~$0.016 gas is ~160bps of the position and the round trip ~360bps, which
    // pushes the required gain past 720bps — most of a full mean-absolute 24h move.
    const tiny = state({ compartmentWei: 1_000_000_000_000_000n }); // 1/8 -> 1.25e14, under the floor
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
    const a = sizePosition(state({ compartmentWei: 8_000_000_000_000_000n }), DEFAULT_RISK);
    const b = sizePosition(state({ compartmentWei: 16_000_000_000_000_000n }), DEFAULT_RISK);
    // Exactly LINEAR in the compartment while under the cap: double the funds, double the size.
    // A U-shaped cost model would instead produce an interior optimum, where doubling the
    // compartment moves the size toward a preferred absolute notional rather than doubling it.
    expect(a).toBe(1_000_000_000_000_000n);
    expect(b).toBe(2_000_000_000_000_000n);
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
    expect(gate.sizeWei).toBe(2_000_000_000_000_000n);
    // A fresh stray takes slot 0 and has seven left. `hunt` scans lowest-first and must agree.
    expect(gate.slot).toBe(0);
    expect(gate.freeSlotsAfter).toBe(MAX_POSITIONS - 1);
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════════════════
   * ══ THE RULE THAT WAS DELETED, AND THE MEASUREMENT THAT DELETED IT (RESULTS §10.5) ══
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * `mayEnter` used to refuse with `reason: "position-open"` the moment a stray held anything,
   * justified as "one position at a time: a stray with $5 cannot diversify". Measured on the
   * held-out fold:
   *
   *     slots  usd  taken/72  skipped  median bps
   *       1    $ 5     17        55     +1,921    <- Welch t 1.16, NOT significant
   *       4    $10     48        24     +4,263
   *       6    $15     66         6     +4,410
   *       8    $20     71         1     +4,410    <- Welch t 2.38 … 2.72 on 20/20 seeds
   *
   * The per-ticket edge is the SAME across the ladder. What changed is n. These tests assert the
   * new behaviour in both directions, because a suite that only proved the refusal at 8 would pass
   * just as happily against the old rule.
   */
  it("ALLOWS a stray that already holds a position — this is the §10.5 change", async () => {
    const gate = await mayEnter({
      state: state({ positions: [position()] }),
      cfg: DEFAULT_RISK,
      ledger: durableLedger(),
      idempotencyKey: "k",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(true);
    if (!gate.allowed) throw new Error("unreachable");
    expect(gate.slot).toBe(1);
  });

  it("ALLOWS entries all the way to the EIGHTH slot", async () => {
    for (let held = 0; held < MAX_POSITIONS; held++) {
      const gate = await mayEnter({
        state: state({ positions: positions(held) }),
        cfg: DEFAULT_RISK,
        ledger: durableLedger(),
        idempotencyKey: `k-${String(held)}`,
        nowSeconds: NOW,
      });
      expect(gate.allowed, `a stray holding ${String(held)} must still be able to enter`).toBe(true);
      if (!gate.allowed) throw new Error("unreachable");
      expect(gate.slot).toBe(held);
      expect(gate.freeSlotsAfter).toBe(MAX_POSITIONS - held - 1);
    }
  });

  it("REFUSES the ninth — slots-full, and the reason says slot count is capital not conviction", async () => {
    const gate = await mayEnter({
      state: state({ positions: positions(MAX_POSITIONS) }),
      cfg: DEFAULT_RISK,
      ledger: durableLedger(),
      idempotencyKey: "k",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("unreachable");
    expect(gate.reason).toBe("slots-full");
    expect(gate.detail).toMatch(/CAPITAL, not/);
    // It must NOT claim the stray cannot diversify — that was the deleted, refuted justification.
    expect(gate.detail).not.toMatch(/cannot diversify/);
  });

  it("honours a SMALLER configured slot count — $10 of funding is four slots, not eight", async () => {
    const fourSlot: RiskConfig = { ...DEFAULT_RISK, maxPositions: 4 };
    const gate = await mayEnter({
      state: state({ positions: positions(4) }),
      cfg: fourSlot,
      ledger: durableLedger(),
      idempotencyKey: "k",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("unreachable");
    expect(gate.reason).toBe("slots-full");
  });

  it("CLAMPS a configured slot count above MAX_POSITIONS — the contract's array is fixed at 8", async () => {
    // A keeper that believed in 9 slots would commit the spend to the ledger and then get
    // `NoFreeSlot` from `hunt`, which is a spend recorded for a trade that never happened.
    const greedy: RiskConfig = { ...DEFAULT_RISK, maxPositions: 32 };
    const gate = await mayEnter({
      state: state({ positions: positions(MAX_POSITIONS) }),
      cfg: greedy,
      ledger: durableLedger(),
      idempotencyKey: "k",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("unreachable");
    expect(gate.reason).toBe("slots-full");
  });

  it("REFUSES a token the stray already holds in another slot", async () => {
    // Eight slots is eight ideas, not one idea eight times.
    const gate = await mayEnter({
      state: state({ positions: [position({ token: "0xCatDay" })] }),
      cfg: DEFAULT_RISK,
      ledger: durableLedger(),
      idempotencyKey: "k",
      nowSeconds: NOW,
      token: "0xcatday", // deliberately different casing
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) throw new Error("unreachable");
    expect(gate.reason).toBe("duplicate-token");
    expect(gate.detail).toMatch(/eight ideas, not one idea eight times/);
  });

  it("allows a DIFFERENT token while holding one", async () => {
    const gate = await mayEnter({
      state: state({ positions: [position({ token: "0xCatDay" })] }),
      cfg: DEFAULT_RISK,
      ledger: durableLedger(),
      idempotencyKey: "k",
      nowSeconds: NOW,
      token: "0xSomethingElse",
    });
    expect(gate.allowed).toBe(true);
  });

  it("fills the LOWEST free slot, matching StrayVault.hunt's own scan", async () => {
    /*
     * The contract scans `if (held == address(0) && slot == MAX_POSITIONS) slot = i` — lowest
     * first. If this disagreed, the indexer would attach its peak watermark to one slot while the
     * chain filled another, and the trailing stop for one token would then be computed from
     * another token's peak.
     */
    const gappy = state({
      positions: [position({ slot: 0 }), position({ slot: 2, token: "0xB" })],
    });
    expect(firstFreeSlot(gappy)).toBe(1);
    const gate = await mayEnter({
      state: gappy,
      cfg: DEFAULT_RISK,
      ledger: durableLedger(),
      idempotencyKey: "k",
      nowSeconds: NOW,
    });
    expect(gate.allowed).toBe(true);
    if (!gate.allowed) throw new Error("unreachable");
    expect(gate.slot).toBe(1);
  });

  it("firstFreeSlot is undefined only when every slot is genuinely taken", () => {
    expect(firstFreeSlot(state({ positions: [] }))).toBe(0);
    expect(firstFreeSlot(state({ positions: positions(MAX_POSITIONS - 1) }))).toBe(
      MAX_POSITIONS - 1,
    );
    expect(firstFreeSlot(state({ positions: positions(MAX_POSITIONS) }))).toBeUndefined();
  });

  it("MAX_POSITIONS is 8 and matches StrayVault.MAX_POSITIONS character for character", () => {
    // RESEARCH §7g is about the gap between a claim and the code that would have to run for it.
    // The contract source is the authority; if it changes, this goes red rather than the keeper
    // silently believing in a ninth slot that reverts NoFreeSlot.
    expect(MAX_POSITIONS).toBe(8);
    const sol = readFileSync(
      new URL("../../contracts/src/StrayVault.sol", import.meta.url),
      "utf8",
    );
    expect(sol).toContain(`uint256 public constant MAX_POSITIONS = ${String(MAX_POSITIONS)};`);
  });

  it("refuses an empty compartment", async () => {
    const gate = await mayEnter({
      state: state({ compartmentWei: 0n, equityWei: 16_000_000_000_000_000n }),
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
      Array.from({ length: MAX_POSITIONS }, (_v, i) => ({
        idempotencyKey: `tiny-${String(i)}`,
        strayId: "stray-1",
        amountWei: 1n,
        atSeconds: NOW,
      })),
    );
    expect(await l.spentInWindow("stray-1", 86_400, NOW)).toBe(BigInt(MAX_POSITIONS)); // under the cap
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
      { s: state({ positions: positions(MAX_POSITIONS) }), l: durableLedger(), k: "k" },
      { s: state({ equityWei: 1n }), l: durableLedger(), k: "k" },
      { s: state({ compartmentWei: 0n }), l: durableLedger(), k: "k" },
      // A funded stray whose 1/8 slice falls under the 0.001 ETH floor.
      {
        s: state({
          compartmentWei: 2_000_000_000_000_000n,
          equityWei: 2_000_000_000_000_000n,
          highWaterMarkWei: 2_000_000_000_000_000n,
        }),
        l: durableLedger(),
        k: "k",
      },
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
