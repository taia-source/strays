import { describe, expect, it } from "vitest";
import { EDGE_MULTIPLE } from "./bar.js";
import { type Candidate, decide, type DecideConfig, type Market } from "./decide.js";
import { DEFAULT_ELIGIBILITY } from "./eligible.js";
import { DEFAULT_SCREEN } from "./screen.js";
import { HOOK_PRIMARY, HOOK_SECONDARY } from "./hook.js";
import {
  createMemorySpendLedger,
  DEFAULT_RISK,
  MAX_POSITIONS,
  type OpenPosition,
  type SpendLedger,
  type SpendRecord,
  type StrayState,
} from "./risk.js";
import { type PricePoint } from "./signal.js";
import { TRAIL_BPS } from "./trail.js";

const NOW = 1_700_000_000;
const BASE_PRICE = 1_000_000_000_000_000_000n;
const MAINNET_GAS_PRICE_WEI = 29_474_000n;

function durable(seed: readonly SpendRecord[] = []): SpendLedger {
  return { ...createMemorySpendLedger(seed), durable: true };
}

function state(overrides: Partial<StrayState> = {}): StrayState {
  return {
    strayId: "stray-1",
    // 0.016 ETH ~= $31: funded for all eight slots at 1/8 = 0.002 ETH each, twice the 0.001 floor.
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
    entryWei: 2_000_000_000_000_000n,
    entryPriceWei: BASE_PRICE,
    // The watermark starts AT the entry price, exactly as `StrayVault.hunt` sets it.
    peakPriceWei: BASE_PRICE,
    hook: HOOK_PRIMARY,
    tokenBalance: 1_298_451_422_972_480_224_401_102n,
    openedAtSeconds: NOW - 600,
    taxPct: 1,
    ...overrides,
  };
}

/** `n` positions in slots 0..n-1, each on its own token, all flat at BASE_PRICE. */
function positions(n: number, overrides: Partial<OpenPosition> = {}): OpenPosition[] {
  return Array.from({ length: n }, (_v, i) =>
    position({ slot: i, token: `0xToken${String(i)}`, ...overrides }),
  );
}

/** Mark prices keyed by token, as `Market.markPricesWei` wants them. */
function marks(entries: readonly (readonly [string, bigint])[]): ReadonlyMap<string, bigint> {
  return new Map(entries);
}

function history(moveBps: bigint, spanSeconds = 3600, samples = 13): PricePoint[] {
  const points: PricePoint[] = [];
  for (let i = 0; i < samples; i++) {
    const bpsHere = (moveBps * BigInt(i)) / BigInt(samples - 1);
    points.push({
      ethPerTokenWei: BASE_PRICE + (BASE_PRICE * bpsHere) / 10_000n,
      atSeconds: NOW - spanSeconds + Math.round((i * spanSeconds) / (samples - 1)),
    });
  }
  return points;
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    token: {
      address: "0xCatDay",
      taxPct: 1,
      marketCapWei: 5_000_000_000_000_000_000n,
      holders: 120,
      volumeAllTimeWei: 500_000_000_000_000_000n,
      ageSeconds: 7200,
      // 25 realised swaps: inside `age.ts`'s [20, 50] entry window. THE gate now.
      swapCount: 25,
      tickSpacing: 200,
      hook: HOOK_PRIMARY,
    },
    // A move well past the ~314bps breakout AND past the ~463bps bar.
    history: history(900n),
    quotedOut: 1_298_451_422_972_480_224_401_102n,
    // The SELL SIMULATION passes by default so that tests of OTHER gates are not all silently
    // short-circuited by the screen. Tests that care about the screen override it explicitly.
    sell: { ok: true, proceedsWei: 2_540_919_554_531_752n },
    // Concentration well inside every measured ceiling (top10 max on the pad was 23.92%).
    holders: {
      top10Pct: 5,
      creatorPct: 0,
      creatorSold: true,
      sniperCount: 0,
      sniperHeldPct: 0,
    },
    // 6500 = 65% buys, the measured CASHDOG figure.
    buyRatioBps: 6500n,
    ...overrides,
  };
}

function cfg(overrides: Partial<DecideConfig> = {}): DecideConfig {
  return {
    eligibility: DEFAULT_ELIGIBILITY,
    risk: DEFAULT_RISK,
    ledger: durable(),
    screen: DEFAULT_SCREEN,
    slippageBps: 100n,
    idempotencyKey: "tick-1",
    approvalsNeeded: false,
    ...overrides,
  };
}

function market(overrides: Partial<Market> = {}): Market {
  return {
    candidates: [candidate()],
    gasPriceWei: MAINNET_GAS_PRICE_WEI,
    markPricesWei: marks([]),
    nowSeconds: NOW,
    ...overrides,
  };
}

describe("decide — the happy path exists, so the bar is provably clearable", () => {
  it("ENTERS an eligible token inside the entry window", async () => {
    const d = await decide(state(), market(), cfg());
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    expect(d.token).toBe("0xCatDay");
    // 1/8 of the 0.016 ETH compartment. Eight equal slots, not half the money in the first idea.
    expect(d.sizeWei).toBe(2_000_000_000_000_000n);
    expect(d.sizeWei * BigInt(MAX_POSITIONS)).toBe(16_000_000_000_000_000n);
    expect(d.minOut).toBeGreaterThan(0n);
  });

  it("the entry carries the arithmetic for /logs — cost, bar and signal all rendered", async () => {
    const d = await decide(state(), market(), cfg());
    if (d.kind !== "enter") throw new Error("expected an entry");
    expect(d.reason).toMatch(/ENTER 0xCatDay/);
    expect(d.reason).toMatch(/breakout/);
    expect(d.reason).toMatch(/round-trip cost/);
    expect(d.reason).toMatch(/TOTAL/);
    expect(d.reason).toMatch(/minOut/);
    // And the structured fields are there too, not only the prose.
    expect(d.cost.totalBps).toBeGreaterThan(0n);
    expect(d.bar.clears).toBe(true);
    expect(d.signal.direction).toBe("long");
  });

  it("minOut is NEVER zero (RESEARCH §7c)", async () => {
    const d = await decide(state(), market(), cfg());
    if (d.kind !== "enter") throw new Error("expected an entry");
    expect(d.minOut).toBe((1_298_451_422_972_480_224_401_102n * 9900n) / 10_000n);
    expect(d.minOut).toBeGreaterThan(0n);
  });
});

describe("EXIT IS EVALUATED FIRST AND GATED BY NOTHING (DESIGN §6 Rule 5)", () => {
  /*
   * ══ THE TEST THE BRIEF NAMES, NOW WITH A FULL PORTFOLIO IN IT ══
   *
   * "an exit is allowed even when every other risk control is tripped". Every gate below is
   * tripped simultaneously — drawdown halt, empty compartment, exhausted spend cap, exhausted
   * count cap, duplicate idempotency key — and now ALSO every slot occupied, which is a new way
   * the entry side can refuse. `slots-full` reaching the exit path would present as a cat that
   * stopped trading rather than as a bug, so it is tripped here deliberately.
   */
  it("EXITS on a tripped trailing stop with EVERY other risk control simultaneously tripped", async () => {
    const held = positions(MAX_POSITIONS, { peakPriceWei: BASE_PRICE });
    const wrecked = state({
      strayId: "doomed",
      compartmentWei: 0n,
      equityWei: 1n, // ~-100% drawdown, far past the halt
      highWaterMarkWei: 16_000_000_000_000_000n,
      positions: held, // and every slot is full, so `mayEnter` would refuse `slots-full`
    });
    const exhausted = durable([
      { idempotencyKey: "tick-1", strayId: "doomed", amountWei: 10n ** 18n, atSeconds: NOW },
      ...Array.from({ length: 20 }, (_v, i) => ({
        idempotencyKey: `x-${String(i)}`,
        strayId: "doomed",
        amountWei: 10n ** 18n,
        atSeconds: NOW,
      })),
    ]);

    // Slot 3 has halved from its peak; everything else is flat at its watermark.
    const halved = (BASE_PRICE * 5000n) / 10_000n;
    const d = await decide(
      wrecked,
      market({
        markPricesWei: marks(
          held.map((p) => [p.token, p.slot === 3 ? halved : BASE_PRICE] as const),
        ),
      }),
      cfg({ ledger: exhausted }),
    );

    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.token).toBe("0xToken3");
    expect(d.slot).toBe(3);
    expect(d.reason).toMatch(/^TRAILING STOP:/);
  });

  it("the drawdown halt blocks ENTRY but is bypassed entirely by the EXIT branch", async () => {
    const halted = { equityWei: 1n, highWaterMarkWei: 16_000_000_000_000_000n };

    // Flat and halted -> hold, with the halt named.
    const flat = await decide(state(halted), market(), cfg());
    expect(flat.kind).toBe("hold");
    if (flat.kind !== "hold") throw new Error("unreachable");
    expect(flat.reason).toMatch(/drawdown halt/);
    expect(flat.reason).toMatch(/Withdrawal remains available at all times/);

    // Holding, halted, and past the trailing stop -> exit. Same halt, opposite outcome.
    const holding = await decide(
      state({ ...halted, positions: [position()] }),
      market({ markPricesWei: marks([["0xCatDay", (BASE_PRICE * 4000n) / 10_000n]]) }),
      cfg(),
    );
    expect(holding.kind).toBe("exit");
  });

  it("EXITS on the stop with an exhausted spend ledger — the ledger is never consulted", async () => {
    // Proof the exit path does not touch the ledger at all: a ledger whose every method throws.
    const exploding: SpendLedger = {
      durable: true,
      spentInWindow: () => Promise.reject(new Error("ledger must not be consulted on an exit")),
      countInWindow: () => Promise.reject(new Error("ledger must not be consulted on an exit")),
      hasKey: () => Promise.reject(new Error("ledger must not be consulted on an exit")),
      record: () => Promise.reject(new Error("ledger must not be consulted on an exit")),
    };
    const d = await decide(
      state({ positions: [position()] }),
      market({ markPricesWei: marks([["0xCatDay", (BASE_PRICE * 4000n) / 10_000n]]) }),
      cfg({ ledger: exploding }),
    );
    expect(d.kind).toBe("exit");
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════════════════
   * ══ THE NEW EXIT RULE: 50% FROM THE PEAK WATERMARK, NOT A LEVEL FROM ENTRY ══
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * The distinction these tests pin is the whole of RESULTS §10: the old exit measured price
   * against ENTRY (a −235bps stop, a +471bps take-profit) and the new one measures price against
   * the RUNNING PEAK. On an asset whose winning tickets move thousands of bps, a level stop from
   * entry closes exactly the positions that pay for everything.
   */
  it("EXITS at exactly the 50% trail boundary, measured from the PEAK not from entry", async () => {
    const peak = BASE_PRICE * 4n; // the position ran 4x before turning
    const mark = (peak * (10_000n - TRAIL_BPS)) / 10_000n; // exactly 50% off the peak
    const d = await decide(
      state({ positions: [position({ peakPriceWei: peak })] }),
      market({ markPricesWei: marks([["0xCatDay", mark]]) }),
      cfg(),
    );
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.trail?.fallFromPeakBps).toBe(TRAIL_BPS);
    // Note the mark is still DOUBLE the entry price. Measured from entry this is a +10,000bps
    // winner; measured from the peak it is a stop. Only the second reading is the exit rule.
    expect(mark).toBe(BASE_PRICE * 2n);
  });

  it("HOLDS one bp inside the trail", async () => {
    const peak = BASE_PRICE * 4n;
    const mark = (peak * (10_000n - TRAIL_BPS + 1n)) / 10_000n;
    const d = await decide(
      state({ positions: [position({ peakPriceWei: peak })] }),
      market({ markPricesWei: marks([["0xCatDay", mark]]) }),
      cfg(),
    );
    expect(d.kind).not.toBe("exit");
  });

  it("does NOT exit on the old -235bps level stop — that rule is refuted and GONE", async () => {
    /*
     * A −300bps move from entry, with the peak still at entry. The old `stopFired` fires here; the
     * trailing stop does not, and must not. This is the single most important behavioural
     * assertion in this file: a suite that did not test it would pass against the old strategy.
     */
    const mark = (BASE_PRICE * 9700n) / 10_000n;
    const d = await decide(
      state({ positions: [position({ peakPriceWei: BASE_PRICE })] }),
      market({ markPricesWei: marks([["0xCatDay", mark]]) }),
      cfg(),
    );
    expect(d.kind).not.toBe("exit");
  });

  it("does NOT take profit at +2000bps — the fixed take-profit is gone too", async () => {
    /*
     * The old rule sold here, at +2000bps, against a ~471bps target. §10.4 measured that the top
     * 10% of positions carry 76.1% of all profit and the median winner is +5,609bps, so selling at
     * the first +471bps is how the old strategy converted its winners into small ones.
     */
    const mark = (BASE_PRICE * 12_000n) / 10_000n;
    const d = await decide(
      state({ positions: [position({ peakPriceWei: mark })] }),
      market({ markPricesWei: marks([["0xCatDay", mark]]) }),
      cfg(),
    );
    expect(d.kind).not.toBe("exit");
  });

  it("a position at a NEW HIGH is held, and the log says how far it is from its stop", async () => {
    const mark = BASE_PRICE * 10n;
    const d = await decide(
      state({ positions: [position({ peakPriceWei: mark })] }),
      market({ markPricesWei: marks([["0xCatDay", mark]]) }),
      cfg({ ledger: durable([{ idempotencyKey: "tick-1", strayId: "stray-1", amountWei: 1n, atSeconds: NOW }]) }),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/no trailing stop/);
    expect(d.reason).toMatch(/stop price/);
  });

  it("does NOT force a sale on an unreadable mark price", async () => {
    // Selling on a failed price read is trading on no information, and RESEARCH §5 warns the API
    // is unstable. A forced exit here would turn every API blip into a realised loss.
    for (const bad of [marks([]), marks([["0xCatDay", 0n]]), marks([["0xCatDay", -1n]])]) {
      const d = await decide(
        state({ positions: [position()], compartmentWei: 0n }),
        market({ markPricesWei: bad }),
        cfg(),
      );
      expect(d.kind).toBe("hold");
      if (d.kind !== "hold") continue;
      expect(d.reason).toMatch(/mark price unreadable/);
      expect(d.reason).toMatch(/withdrawal is not gated/);
    }
  });

  /*
   * ══ ONE UNREADABLE PRICE MUST NOT DISARM SEVEN LIVE STOPS ══
   *
   * With a single position, "mark unreadable -> hold" was the whole story. With eight it is a
   * trap: an early return on the first missing price would leave every later position unchecked,
   * on every tick, until that one read recovered — and the failure would look like a quiet cat.
   */
  it("keeps scanning past an unreadable price and still fires a LATER position's stop", async () => {
    const held = positions(3);
    const d = await decide(
      state({ positions: held, compartmentWei: 0n }),
      market({
        markPricesWei: marks([
          // slot 0 missing entirely, slot 1 unreadable-as-zero, slot 2 halved from its peak.
          ["0xToken1", 0n],
          ["0xToken2", (BASE_PRICE * 4000n) / 10_000n],
        ]),
      }),
      cfg(),
    );
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.token).toBe("0xToken2");
    expect(d.slot).toBe(2);
  });

  it("emits ONE exit per tick, in SLOT ORDER, regardless of how the array is ordered", async () => {
    // A tick lands at most one transaction, so the choice must be deterministic. Slot order is
    // arbitrary but replayable; "worst drawdown first" would be a ranking rule on the exit path,
    // and a ranking rule is a place a future edit can express a preference for NOT selling.
    const held = positions(4);
    const allHalved = marks(held.map((p) => [p.token, (BASE_PRICE * 3000n) / 10_000n] as const));
    const forward = await decide(
      state({ positions: held, compartmentWei: 0n }),
      market({ markPricesWei: allHalved }),
      cfg(),
    );
    const reversed = await decide(
      state({ positions: [...held].reverse(), compartmentWei: 0n }),
      market({ markPricesWei: allHalved }),
      cfg(),
    );
    expect(forward).toEqual(reversed);
    if (forward.kind !== "exit") throw new Error("expected an exit");
    expect(forward.slot).toBe(0);
  });

  it("the exit names the SLOT, because flee() sells whatever is in the slot it is given", async () => {
    /*
     * `StrayVault.flee(strayId, slot, minOut)` reads the token, hook and tickSpacing back OUT of
     * the slot. A wrong slot therefore sells a DIFFERENT position at this one's minOut, which is
     * the most dangerous single field on this type.
     */
    const held = [position({ slot: 5, token: "0xFar" })];
    const d = await decide(
      state({ positions: held, compartmentWei: 0n }),
      market({ markPricesWei: marks([["0xFar", (BASE_PRICE * 2000n) / 10_000n]]) }),
      cfg(),
    );
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.slot).toBe(5);
    expect(d.token).toBe("0xFar");
  });

  it("matches the mark CASE-INSENSITIVELY — a map miss would silently disarm a stop", async () => {
    // The pad's API and the RPC disagree about EIP-55 casing. A lookup that misses is
    // indistinguishable from a failed read, and a failed read holds.
    const d = await decide(
      state({ positions: [position({ token: "0xCatDay" })], compartmentWei: 0n }),
      market({ markPricesWei: marks([["0xcatday", (BASE_PRICE * 2000n) / 10_000n]]) }),
      cfg(),
    );
    expect(d.kind).toBe("exit");
  });

  it("the exit REPORTS its cost but is never gated on it (DESIGN §6 Rule 5)", async () => {
    // A 10%-tax position whose exit costs ~1938bps still exits. The cost of leaving is a fact
    // about the exit, not a reason to stay — that is the rule meridian learned live.
    const d = await decide(
      state({ positions: [position({ taxPct: 10 })], compartmentWei: 0n }),
      market({ markPricesWei: marks([["0xCatDay", (BASE_PRICE * 2000n) / 10_000n]]) }),
      cfg(),
    );
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.reason).toMatch(/REPORTED, not consulted/);
    // Costed against the POSITION's own 10% tier, not the config's.
    expect(d.reason).toMatch(/10% tax/);
  });

  /*
   * ══ A FULL PORTFOLIO MUST NOT GATE ITS OWN EXITS ══
   *
   * The specific new failure mode eight slots introduce. If the entry branch ran first, a stray
   * holding eight positions would hit `slots-full` and return `hold` before any stop was checked.
   */
  it("a stray with EVERY slot full still exits", async () => {
    const held = positions(MAX_POSITIONS);
    const d = await decide(
      state({ positions: held, compartmentWei: 0n }),
      market({
        markPricesWei: marks(
          held.map((p) => [p.token, p.slot === 7 ? BASE_PRICE / 4n : BASE_PRICE] as const),
        ),
      }),
      cfg(),
    );
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.slot).toBe(7);
  });

  /*
   * ══ AND THE FALL-THROUGH THAT MAKES THE EIGHT SLOTS REAL ══
   *
   * The old code returned `hold` as soon as it found an open position. §10.5's entire finding
   * (17 vs 71 of 72 opportunities taken) depends on a stray with free slots still hunting.
   */
  it("HOLDING something does not stop it ENTERING something else", async () => {
    const d = await decide(
      state({ positions: [position({ token: "0xAlready" })] }),
      market({ markPricesWei: marks([["0xAlready", BASE_PRICE]]) }),
      cfg(),
    );
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    expect(d.token).toBe("0xCatDay");
    expect(d.slot).toBe(1);
    // And the log still reports the position it is holding, so /logs is never silent about it.
    expect(d.reason).toMatch(/holding: slot 0 0xAlready/);
  });
});

describe("decide — RULE 1 reaches all the way through", () => {
  /*
   * ══ THE BEHAVIOUR CHANGE, ASSERTED IN BOTH DIRECTIONS ══
   *
   * A 10%-tax token is not refused by a TIER RULE. It is refused by its own COST BAR when the
   * expected gain is too small, and admitted when it is large enough to pay for the tax. Both
   * halves are tested, because a suite that only proved the refusal would pass just as happily
   * against the old hard filter — which is the thing being replaced.
   *
   * ══ AND THE HONEST CONSEQUENCE OF THE NEW EXPECTED GAIN ══
   *
   * The bar is now fed the MEASURED HELD-OUT MEDIAN at the entry dose (+4,410bps at swap 20)
   * rather than the momentum signal's take-profit projection. A 10%-tax token's bar is
   * 2 x ~1938bps = ~3876bps, so +4,410bps CLEARS IT — and this suite says so rather than
   * pretending the old refusal survived. That is RESULTS §10.7's finding arriving in the code:
   * *"the toll never was the binding constraint. The holding period was."*
   *
   * What still binds at 10% tax is `score.ts`'s NET edge, which subtracts the tier's full round
   * trip from the expected move and then applies the quality multipliers. The margin is thin and
   * the tests below pin which side of it each tier lands on, so a future change to either number
   * cannot move a tier across the line silently.
   */
  it("ADMITS a 10%-tax token at the measured median — the bar is no longer what refuses it", async () => {
    const d = await decide(
      state(),
      market({ candidates: [candidate({ token: { ...candidate().token, taxPct: 10 } })] }),
      cfg(),
    );
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    // The cost actually charged is the 10% one, read off the candidate, not a 1% one from config.
    expect(d.cost.totalBps).toBeGreaterThan(1900n);
    // And it cleared its OWN bar: 2 x its own round trip, not somebody else's.
    expect(d.bar.requiredWei).toBe(d.cost.totalWei * EDGE_MULTIPLE);
    expect(d.score.netEdgeBps).toBeGreaterThan(0n);
  });

  it("REFUSES a 10%-tax token when the ENTRY DOSE makes the median too small", async () => {
    /*
     * The bar still binds — what changed is what moves it. At swap 50 the measured median is
     * +696bps, which cannot clear 2 x a 10%-tax round trip (~3876bps). Same token, same tier,
     * different point in its life, opposite answer. That is the dose-response reaching the bar.
     */
    const d = await decide(
      state(),
      market({
        candidates: [
          candidate({ token: { ...candidate().token, taxPct: 10, swapCount: 50 } }),
        ],
      }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/cost bar refused it|does not cover its own tax/);
    // And it must NOT be refused for being tier 10 — that rule is gone.
    expect(d.reason).not.toMatch(/taxPct 10% !=/);
  });

  it("ranks on NET edge, so a low-tax token beats a high-tax one at the SAME dose", async () => {
    // Identical swap counts, so the expected move is identical. The only thing separating them is
    // the round trip their own tier implies. Ranking on GROSS would make them indistinguishable.
    const mixed = [
      candidate({ token: { ...candidate().token, address: "0xTen", taxPct: 10 } }),
      candidate({ token: { ...candidate().token, address: "0xFive", taxPct: 5 } }),
      candidate({ token: { ...candidate().token, address: "0xOne", taxPct: 1 } }),
    ];
    const d = await decide(state(), market({ candidates: mixed }), cfg());
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    expect(d.token).toBe("0xOne");
  });

  it("HOLDS when every candidate is refused, and lists every reason", async () => {
    // Each fails a DIFFERENT gate: one is outside the entry window, one cannot be sold.
    const allBad = [
      candidate({ token: { ...candidate().token, address: "0xOld", swapCount: 500 } }),
      candidate({
        token: { ...candidate().token, address: "0xThree", taxPct: 3 },
        sell: { ok: false, selector: "0x7a5ed734" },
      }),
    ];
    const d = await decide(state(), market({ candidates: allBad }), cfg());
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/2 candidate\(s\) refused/);
    expect(d.reason).toContain("0xOld");
    expect(d.reason).toContain("0xThree");
  });
});

describe("THE ENTRY GATE IS AGE IN SWAPS — the momentum family is refuted (RESULTS §10)", () => {
  /*
   * ══ THE MOST IMPORTANT PAIR OF TESTS IN THIS FILE ══
   *
   * The old entry required `signal.direction === "long"` — a 2-sigma momentum breakout. That
   * family lost 145bps of edge against a 208bps round trip, and STATE.md's quintile table shows
   * WHY: forward net by prior run-up is +3,260bps for tokens that had already FALLEN and −5,999bps
   * for those up more than 296%. A momentum entry buys the bottom row by construction.
   *
   * So a flat or FALLING token must now be entered when it is at the right age, and these two
   * tests are the ones that would have passed against the old strategy if the change were
   * cosmetic. They fail against it.
   */
  it("ENTERS a FLAT token — the breakout requirement is gone", async () => {
    const d = await decide(
      state(),
      market({ candidates: [candidate({ history: history(0n) })] }),
      cfg(),
    );
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    // The momentum reading is still computed and still logged — it just decides nothing.
    expect(d.signal.direction).toBe("none");
    expect(d.reason).toMatch(/RECORDED NOT ACTED ON/);
  });

  it("ENTERS a token whose last hour FELL — the quintile with the best forward net", async () => {
    const d = await decide(
      state(),
      market({ candidates: [candidate({ history: history(-900n) })] }),
      cfg(),
    );
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    expect(d.signal.moveBps).toBeLessThan(0n);
  });

  it("REFUSES a token that is too YOUNG — before the sell-simulation gate is measurable", async () => {
    const d = await decide(
      state(),
      market({ candidates: [candidate({ token: { ...candidate().token, swapCount: 3 } })] }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/3 realised swaps < the 20-swap entry point/);
    // The refusal is honest about the earlier dose measuring BETTER, and about why we do not take it.
    expect(d.reason).toMatch(/\+9,791bps median at swap 5/);
  });

  it("REFUSES a token that is too OLD — past where the measured median crosses zero", async () => {
    const d = await decide(
      state(),
      market({ candidates: [candidate({ token: { ...candidate().token, swapCount: 500 } })] }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/500 realised swaps > the 50-swap ceiling/);
    expect(d.reason).toMatch(/GRADIENT, not a threshold/);
  });

  it("the entry window is a CONFIG a backtest can sweep, not a constant it must edit around", async () => {
    // §10.1's mechanical finding: three rounds never tested this family because the harness could
    // not express it. A constant `decide()` read directly would reproduce that exactly.
    const late = await decide(
      state(),
      market({ candidates: [candidate({ token: { ...candidate().token, swapCount: 90 } })] }),
      cfg({ age: { entrySwapIndex: 80, maxEntrySwapIndex: 120 } }),
    );
    expect(late.kind).toBe("enter");
  });

  it("the ENTER decision carries the hook, tickSpacing and slot the keeper must pass on", async () => {
    const d = await decide(
      state(),
      market({ candidates: [candidate({ token: { ...candidate().token, hook: HOOK_SECONDARY } })] }),
      cfg(),
    );
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    // The SECOND hook — the one v1 could not reach, carrying LEVCAT, INTERN and Seriouscat.
    expect(d.hook).toBe(HOOK_SECONDARY);
    expect(d.tickSpacing).toBe(200);
    expect(d.slot).toBe(0);
    expect(d.reason).toContain(HOOK_SECONDARY);
  });

  it("REFUSES a candidate on an unknown hook — the pool cannot be addressed, and it is a risk", async () => {
    const d = await decide(
      state(),
      market({
        candidates: [
          candidate({
            token: { ...candidate().token, hook: "0x000000000000000000000000000000000000dEaD" },
          }),
        ],
      }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/not one of the two known letscash hooks/);
  });

  it("does not enter the SAME token twice — eight slots is eight ideas", async () => {
    const d = await decide(
      state({ positions: [position({ token: "0xCatDay", slot: 0 })] }),
      market({ markPricesWei: marks([["0xCatDay", BASE_PRICE]]) }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/already held in another slot/);
  });
});

describe("decide — the cost bar still binds", () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════
   * ══ TWO GATES THAT CAN REJECT THE SAME INPUT, EACH PINNED TO AN INPUT ONLY IT REJECTS ══
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * PLAN.md §3 records the unitick finding, having seen it recur five times: *"when two mechanisms
   * can independently reject the same input, at least one test must construct an input that only
   * ONE of them rejects."*
   *
   * `score.netEdgeBps <= 0` (break-even) and `clearsBar` (2x cost) are exactly such a pair, and a
   * SABOTAGE RUN caught them collapsing into one. Both used to be fed different quantities — the
   * bar got the momentum signal's projection, break-even got the observed move — so either could
   * fire alone. Feeding both from the measured median made the bar strictly stronger
   * (`move >= 2*cost` implies `move > cost`), so the break-even check became unreachable and
   * `sabotage.mjs` S51 replaced it with `if (false)` without turning the suite red.
   *
   * The order was flipped so break-even runs first. These two tests are what keeps them apart.
   */
  it("the BAR alone refuses a candidate that HAS cleared break-even", async () => {
    // 10% tax at 900 gwei: round trip 3282bps. The +4,410bps median at swap 20 covers it (net
    // edge +1,128bps, positive) but does not reach 2 x 3282 = 6,564bps. Only the bar rejects.
    const d = await decide(
      state(),
      market({
        candidates: [candidate({ token: { ...candidate().token, taxPct: 10 } })],
        gasPriceWei: 900_000_000n,
      }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/the cost bar refused it/);
    expect(d.reason).not.toMatch(/does not cover its own tax/);
  });

  it("BREAK-EVEN alone refuses a candidate whose move cannot cover its tax at all", async () => {
    // 10% tax at 2 gwei: round trip 4850bps, above the +4,410bps median. Net edge is NEGATIVE, so
    // the break-even check fires first and reports the more specific finding.
    const d = await decide(
      state(),
      market({
        candidates: [candidate({ token: { ...candidate().token, taxPct: 10 } })],
        gasPriceWei: 2_000_000_000n,
      }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/does not cover its own tax/);
    expect(d.reason).not.toMatch(/the cost bar refused it/);
  });


  it("HOLDS when a punitive gas price pushes the round trip past the measured median", async () => {
    // Nothing about the token changes; only the gas price read from the chain. At anvil-scale gas
    // the round trip swallows the +4,410bps median and the bar correctly refuses.
    const d = await decide(
      state(),
      market({ gasPriceWei: 5_000_000_000n }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/cost bar refused it|does not cover its own tax/);
  });

  it("the SAME token enters at a real gas price and is refused at anvil's", async () => {
    // openhood's bug, end to end. Nothing changes but the gas price read from the chain.
    const real = await decide(state(), market({ gasPriceWei: MAINNET_GAS_PRICE_WEI }), cfg());
    expect(real.kind).toBe("enter");

    const anvil = await decide(state(), market({ gasPriceWei: 1_019_000_000n * 20n }), cfg());
    expect(anvil.kind).toBe("hold");
  });

  it("REFUSES to decide at all when the gas price is zero — never defaults it", async () => {
    await expect(decide(state(), market({ gasPriceWei: 0n }), cfg())).rejects.toThrow(
      /gasPriceWei is REQUIRED/,
    );
  });
});

describe("decide — the risk gates reach through", () => {
  it("HOLDS when the spend cap is exhausted", async () => {
    const l = durable([
      { idempotencyKey: "old", strayId: "stray-1", amountWei: 9_000_000_000_000_000n, atSeconds: NOW },
    ]);
    const d = await decide(state(), market(), cfg({ ledger: l }));
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/window-spend-cap/);
  });

  it("HOLDS on a duplicate idempotency key", async () => {
    const l = durable([
      { idempotencyKey: "tick-1", strayId: "stray-1", amountWei: 1n, atSeconds: NOW },
    ]);
    const d = await decide(state(), market(), cfg({ ledger: l }));
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/duplicate-key/);
  });

  it("HOLDS with no candidates, and says so rather than saying nothing", async () => {
    const d = await decide(state(), market({ candidates: [] }), cfg());
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/no candidates were offered/);
  });
});

describe("decide is PURE and FULLY DETERMINISTIC", () => {
  it("the same inputs always give the same Decision", async () => {
    const s = state();
    const m = market();
    const c = cfg();
    const a = await decide(s, m, c);
    const b = await decide(s, m, c);
    expect(a).toEqual(b);
  });

  /*
   * ══ TIME COMES IN AS A PARAMETER ══
   *
   * If this function read a clock, moving the clock without moving `nowSeconds` would change the
   * answer. Here the ONLY thing that changes the answer is the data.
   */
  it("reads no clock — a Date.now() jump cannot change the decision", async () => {
    const s = state();
    const m = market();
    const c = cfg();
    const before = await decide(s, m, c);

    const realNow = Date.now;
    try {
      // Jump the wall clock a decade forward. Nothing may change.
      Date.now = () => realNow() + 315_360_000_000;
      const after = await decide(s, m, c);
      expect(after).toEqual(before);
    } finally {
      Date.now = realNow;
    }
  });

  it("nowSeconds is what actually moves the window, not the wall clock", async () => {
    // The spend record is inside the window at NOW and outside it a week later, so the SAME
    // ledger produces different gates purely from the passed-in time.
    const l = durable([
      { idempotencyKey: "old", strayId: "stray-1", amountWei: 9_500_000_000_000_000n, atSeconds: NOW },
    ]);
    const blocked = await decide(state(), market({ nowSeconds: NOW }), cfg({ ledger: l }));
    expect(blocked.kind).toBe("hold");

    const later = await decide(state(), market({ nowSeconds: NOW + 604_800 }), cfg({ ledger: l }));
    expect(later.kind).toBe("enter");
  });

  it("uses no randomness — 50 identical calls give 50 identical answers", async () => {
    const s = state();
    const m = market();
    const c = cfg();
    const results = await Promise.all(Array.from({ length: 50 }, () => decide(s, m, c)));
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it("does not mutate the state, market or config it is given", async () => {
    const s = Object.freeze(state());
    const m = Object.freeze(market());
    const c = Object.freeze(cfg());
    await expect(decide(s, m, c)).resolves.toBeDefined();
    expect(s.compartmentWei).toBe(16_000_000_000_000_000n);
    expect(m.candidates.length).toBe(1);
  });

  it("makes no network call — there is no fetch on any path", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (() => {
        throw new Error("decide() must not touch the network");
      }) as typeof fetch;
      await expect(decide(state(), market(), cfg())).resolves.toBeDefined();
      await expect(
        decide(
          state({ positions: [position()] }),
          market({ markPricesWei: marks([["0xCatDay", BASE_PRICE]]) }),
          cfg(),
        ),
      ).resolves.toBeDefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("every Decision is exactly one of hold | enter | exit", async () => {
    const cases: Array<Promise<unknown>> = [
      decide(state(), market(), cfg()),
      decide(state(), market({ candidates: [] }), cfg()),
      decide(
        state({ positions: [position()] }),
        market({ markPricesWei: marks([["0xCatDay", BASE_PRICE / 4n]]) }),
        cfg(),
      ),
      decide(
        state({ positions: [position()] }),
        market({ markPricesWei: marks([["0xCatDay", BASE_PRICE]]) }),
        cfg(),
      ),
    ];
    for (const p of cases) {
      const d = (await p) as { kind: string };
      expect(["hold", "enter", "exit"]).toContain(d.kind);
    }
  });
});

describe("decide — the sell simulation reaches all the way through", () => {
  /*
   * ══ THE HIGHEST-VALUE CHECK, ASSERTED ON THE REAL DECISION PATH ══
   *
   * 84 of the newest 100 tokens quote a buy and cannot be sold. It is not enough for `screen.ts`
   * to refuse them in isolation — `decide` has to actually consult it. RESEARCH §7g is precisely
   * about the gap between a claim and the code that would have to run for it.
   */
  it("HOLDS on a token that cannot be sold, even though everything else is perfect", async () => {
    const d = await decide(
      state(),
      market({
        candidates: [candidate({ sell: { ok: false, selector: "0x90bfb865" } })],
      }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/SELL SIMULATION FAILED/);
  });

  it("picks the SELLABLE token over an unsellable one with a bigger move", async () => {
    // The unsellable token has the far better signal. It must still lose, because a position you
    // cannot exit has no expected value at all.
    const d = await decide(
      state(),
      market({
        candidates: [
          candidate({
            token: { ...candidate().token, address: "0xTrap" },
            history: history(5000n),
            sell: { ok: false, selector: "0x7a5ed734" },
          }),
          candidate({ token: { ...candidate().token, address: "0xGood" } }),
        ],
      }),
      cfg(),
    );
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    expect(d.token).toBe("0xGood");
  });

  it("HOLDS on a bundled token — concentration is consulted on the real path", async () => {
    const d = await decide(
      state(),
      market({
        candidates: [
          candidate({
            holders: {
              top10Pct: 5,
              creatorPct: 0,
              creatorSold: true,
              sniperCount: 30,
              sniperHeldPct: 45,
            },
          }),
        ],
      }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/sniper\/bundle wallets hold/);
  });
});

describe("decide — scoring picks the BEST candidate, not the first", () => {
  it("enters the highest-scoring token even when it is LAST in the list", async () => {
    /*
     * The old loop returned the first candidate that passed every gate, so the winner depended on
     * arrival order — the one channel DESIGN §5 lets the LLM influence. This is the test that
     * proves the arithmetic decides instead.
     */
    const d = await decide(
      state(),
      market({
        candidates: [
          candidate({ token: { ...candidate().token, address: "0xWeak" }, history: history(600n) }),
          candidate({ token: { ...candidate().token, address: "0xMid" }, history: history(900n) }),
          candidate({ token: { ...candidate().token, address: "0xBest" }, history: history(4000n) }),
        ],
      }),
      cfg(),
    );
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    expect(d.token).toBe("0xBest");
  });

  it("gives the same winner however the candidates are ordered", async () => {
    const weak = candidate({
      token: { ...candidate().token, address: "0xWeak" },
      history: history(600n),
    });
    const best = candidate({
      token: { ...candidate().token, address: "0xBest" },
      history: history(4000n),
    });
    const forward = await decide(state(), market({ candidates: [weak, best] }), cfg());
    const reversed = await decide(state(), market({ candidates: [best, weak] }), cfg());
    expect(forward.kind).toBe("enter");
    expect(reversed.kind).toBe("enter");
    if (forward.kind !== "enter" || reversed.kind !== "enter") throw new Error("unreachable");
    expect(forward.token).toBe("0xBest");
    expect(reversed.token).toBe("0xBest");
  });

  it("the entry reason names the runners-up and the score arithmetic, for /logs", async () => {
    const d = await decide(
      state(),
      market({
        candidates: [
          candidate({ token: { ...candidate().token, address: "0xBest" }, history: history(4000n) }),
          candidate({ token: { ...candidate().token, address: "0xMid" }, history: history(900n) }),
        ],
      }),
      cfg(),
    );
    if (d.kind !== "enter") throw new Error("expected an entry");
    expect(d.reason).toMatch(/BEST OF 2 scored candidate/);
    expect(d.reason).toMatch(/Runners-up: 0xMid/);
    expect(d.score.netEdgeBps).toBeGreaterThan(0n);
  });

  it("HOLDS rather than buying the least-bad token when NONE has a positive net edge", async () => {
    // Ranking is for choosing among trades worth making. A tick where every survivor is
    // unprofitable must hold, not buy the top of a bad list. Both candidates are 10%-tax at the
    // swap-50 dose (+696bps median), which cannot cover a ~2000bps round trip at any ranking.
    const d = await decide(
      state(),
      market({
        candidates: [
          candidate({ token: { ...candidate().token, address: "0xA", taxPct: 10, swapCount: 50 } }),
          candidate({ token: { ...candidate().token, address: "0xB", taxPct: 10, swapCount: 50 } }),
        ],
      }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
  });
});

describe("decide — the exit is costed against the POSITION's tax, not the config's", () => {
  /*
   * ══ WHAT THIS BLOCK USED TO ASSERT, AND WHY THE ASSERTION MOVED ══
   *
   * It used to prove that the TAKE-PROFIT TARGET was floored against the position's own tax tier,
   * because reading the config's 1% for a 10%-tax position understated the round trip by ~1700bps
   * and sold into a "profit" that did not cover the tax. That was a real bug and a real fix.
   *
   * The take-profit is gone (RESULTS §10 — a fixed target is how the old strategy converted its
   * winners into small ones), so there is no target left to floor. The per-position tax field is
   * still load-bearing and still tested, in the place it now matters: the exit REPORTS its own
   * cost, and it reports the tier actually held rather than the one in config.
   */
  it("reports the exit cost at the POSITION's own tier, not the config's", async () => {
    const held = [position({ taxPct: 10, slot: 0 }), position({ taxPct: 1, slot: 1, token: "0xCheap" })];
    const dear = await decide(
      state({ positions: [held[0] as OpenPosition], compartmentWei: 0n }),
      market({ markPricesWei: marks([["0xCatDay", (BASE_PRICE * 2000n) / 10_000n]]) }),
      cfg(),
    );
    expect(dear.kind).toBe("exit");
    if (dear.kind !== "exit") throw new Error("unreachable");
    // ~1938bps on a 10%-tax token, versus ~208bps on a 1% one. The tier is read off the position.
    expect(dear.reason).toMatch(/10% tax/);
    expect(dear.reason).toMatch(/20\d\dbps at this token's own/);

    const cheap = await decide(
      state({ positions: [held[1] as OpenPosition], compartmentWei: 0n }),
      market({ markPricesWei: marks([["0xCheap", (BASE_PRICE * 2000n) / 10_000n]]) }),
      cfg(),
    );
    if (cheap.kind !== "exit") throw new Error("expected an exit");
    expect(cheap.reason).toMatch(/1% tax/);
    expect(cheap.reason).not.toMatch(/10% tax/);
  });

  it("EXITS both tiers on the same move — an expensive exit is never refused", async () => {
    // DESIGN §6 Rule 5. A 10%-tax position costs ~1938bps to leave and it leaves anyway.
    for (const taxPct of [1, 3, 5, 10]) {
      const d = await decide(
        state({ positions: [position({ taxPct })], compartmentWei: 0n }),
        market({ markPricesWei: marks([["0xCatDay", (BASE_PRICE * 2000n) / 10_000n]]) }),
        cfg(),
      );
      expect(d.kind, `a ${String(taxPct)}%-tax position must still exit`).toBe("exit");
    }
  });
});

describe("decide — refusal paths that must stay reachable", () => {
  it("refuses an INELIGIBLE candidate and keeps evaluating the rest", async () => {
    // The eligibility refusal must not abort the loop — it is about one token, not the stray.
    const d = await decide(
      state(),
      market({
        candidates: [
          // Untraded: market cap sits on the 1.356 ETH seed, below the 1.40 floor.
          candidate({
            token: {
              ...candidate().token,
              address: "0xSeed",
              marketCapWei: 1_356_000_000_000_000_000n,
            },
          }),
          candidate({ token: { ...candidate().token, address: "0xGood" } }),
        ],
      }),
      cfg(),
    );
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    expect(d.token).toBe("0xGood");
  });

  it("a candidate OUTSIDE the entry window is skipped, not fatal", async () => {
    // The refusal is about one token, not the stray, so the loop keeps going.
    const d = await decide(
      state(),
      market({
        candidates: [
          candidate({ token: { ...candidate().token, address: "0xOld", swapCount: 400 } }),
          candidate({ token: { ...candidate().token, address: "0xGood" } }),
        ],
      }),
      cfg(),
    );
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    expect(d.token).toBe("0xGood");
  });

  it("lists a mixture of refusal causes when everything is refused", async () => {
    // Each token fails a DIFFERENT gate, and /logs must carry all three reasons.
    const d = await decide(
      state(),
      market({
        candidates: [
          candidate({
            token: { ...candidate().token, address: "0xSeed", marketCapWei: 1n },
          }),
          candidate({
            token: { ...candidate().token, address: "0xTrap" },
            sell: { ok: false, selector: "0x7a5ed734" },
          }),
          candidate({ token: { ...candidate().token, address: "0xOld", swapCount: 900 } }),
        ],
      }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/3 candidate\(s\) refused/);
    expect(d.reason).toContain("0xSeed");
    expect(d.reason).toContain("0xTrap");
    expect(d.reason).toContain("0xOld");
  });
});

describe("edgeMultiple is CONFIG, and the bar and the target must read the SAME one", () => {
  it("defaults to EDGE_MULTIPLE when the caller does not set it", async () => {
    const withDefault = await decide(state(), market(), cfg());
    const withExplicit = await decide(state(), market(), cfg({ edgeMultiple: EDGE_MULTIPLE }));
    expect(withDefault.kind).toBe("enter");
    if (withDefault.kind !== "enter" || withExplicit.kind !== "enter") {
      throw new Error("expected both to enter");
    }
    // Passing the default explicitly must be indistinguishable from omitting it, or the option
    // has quietly changed behaviour for every existing caller.
    expect(withExplicit.bar.multiple).toBe(withDefault.bar.multiple);
    expect(withExplicit.bar.requiredWei).toBe(withDefault.bar.requiredWei);
  });

  it("THE CONFIGURED MULTIPLE REACHES THE BAR — it is not silently replaced by the constant", async () => {
    // The sabotage this pins (S54) is `const edgeMultiple = EDGE_MULTIPLE`, which ignores config
    // and hands every caller the default bar while appearing to accept the option.
    const d = await decide(state(), market(), cfg({ edgeMultiple: 5n }));
    if (d.kind !== "enter") throw new Error("expected an entry");
    expect(d.bar.multiple).toBe(5n);
    expect(d.bar.requiredWei).toBe(d.cost.totalWei * 5n);
  });

  it("THE BAR AND THE TAKE-PROFIT FLOOR AGREE — a fired trade always aims past its own bar", async () => {
    // The sabotage this pins (S55) sets the bar's multiple to 1 while the take-profit floor keeps
    // the configured one. That combination lets a trade fire against a target that does not cover
    // `multiple x cost`, which is the exact condition the bar exists to prevent.
    for (const edgeMultiple of [1n, 2n, 3n, 5n]) {
      const d = await decide(state(), market(), cfg({ edgeMultiple }));
      if (d.kind !== "enter") throw new Error(`expected an entry at multiple ${edgeMultiple}`);
      expect(d.bar.multiple).toBe(edgeMultiple);
      // The expected gain is derived from the take-profit target, and the bar requires
      // `multiple x cost`. If the two multiples ever diverge, this equality breaks.
      expect(d.bar.requiredWei).toBe(d.cost.totalWei * edgeMultiple);
      expect(d.signal.expectedGainWei).toBeGreaterThanOrEqual(d.bar.requiredWei);
    }
  });

  it("refuses a multiple below 1 — a bar beneath the cost it exists to clear", async () => {
    await expect(decide(state(), market(), cfg({ edgeMultiple: 0n }))).rejects.toThrow(
      /refusing an edge multiple/,
    );
  });
});
