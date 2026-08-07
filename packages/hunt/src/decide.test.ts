import { describe, expect, it } from "vitest";
import { EDGE_MULTIPLE } from "./bar.js";
import { type Candidate, decide, type DecideConfig, type Market } from "./decide.js";
import { DEFAULT_ELIGIBILITY } from "./eligible.js";
import { DEFAULT_SCREEN } from "./screen.js";
import {
  createMemorySpendLedger,
  DEFAULT_RISK,
  type OpenPosition,
  type SpendLedger,
  type SpendRecord,
  type StrayState,
} from "./risk.js";
import { type PricePoint, STOP_LOSS_BPS } from "./signal.js";

const NOW = 1_700_000_000;
const BASE_PRICE = 1_000_000_000_000_000_000n;
const MAINNET_GAS_PRICE_WEI = 29_474_000n;

function durable(seed: readonly SpendRecord[] = []): SpendLedger {
  return { ...createMemorySpendLedger(seed), durable: true };
}

function state(overrides: Partial<StrayState> = {}): StrayState {
  return {
    strayId: "stray-1",
    compartmentWei: 5_000_000_000_000_000n,
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
      tickSpacing: 200,
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
    markPriceWei: undefined,
    nowSeconds: NOW,
    ...overrides,
  };
}

describe("decide — the happy path exists, so the bar is provably clearable", () => {
  it("ENTERS on an eligible token with a breakout that clears the bar", async () => {
    const d = await decide(state(), market(), cfg());
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    expect(d.token).toBe("0xCatDay");
    expect(d.sizeWei).toBe(2_500_000_000_000_000n);
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
   * ══ THE TEST THE BRIEF NAMES ══
   *
   * "an exit is allowed even when every other risk control is tripped". Every gate below is
   * tripped simultaneously — drawdown halt, empty compartment, exhausted spend cap, exhausted
   * count cap, duplicate idempotency key — and the stop still produces an exit.
   */
  it("EXITS on a tripped stop with EVERY other risk control simultaneously tripped", async () => {
    const wrecked = state({
      strayId: "doomed",
      compartmentWei: 0n,
      equityWei: 1n, // ~-100% drawdown, far past the halt
      highWaterMarkWei: 5_000_000_000_000_000n,
      position: position(),
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

    const mark = (BASE_PRICE * 5000n) / 10_000n; // -50%, well past the -235bps stop
    const d = await decide(wrecked, market({ markPriceWei: mark }), cfg({ ledger: exhausted }));

    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.token).toBe("0xCatDay");
    expect(d.reason).toMatch(/^STOP:/);
  });

  it("the drawdown halt blocks ENTRY but is bypassed entirely by the EXIT branch", async () => {
    const halted = { equityWei: 1n, highWaterMarkWei: 5_000_000_000_000_000n };

    // Flat and halted -> hold, with the halt named.
    const flat = await decide(state(halted), market(), cfg());
    expect(flat.kind).toBe("hold");
    if (flat.kind !== "hold") throw new Error("unreachable");
    expect(flat.reason).toMatch(/drawdown halt/);
    expect(flat.reason).toMatch(/Withdrawal remains available at all times/);

    // Holding, halted, and past the stop -> exit. Same halt, opposite outcome.
    const holding = await decide(
      state({ ...halted, position: position() }),
      market({ markPriceWei: (BASE_PRICE * 5000n) / 10_000n }),
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
      state({ position: position() }),
      market({ markPriceWei: (BASE_PRICE * 5000n) / 10_000n }),
      cfg({ ledger: exploding }),
    );
    expect(d.kind).toBe("exit");
  });

  it("EXITS at exactly the stop boundary", async () => {
    const mark = BASE_PRICE - (BASE_PRICE * STOP_LOSS_BPS) / 10_000n;
    const d = await decide(
      state({ position: position() }),
      market({ markPriceWei: mark }),
      cfg(),
    );
    expect(d.kind).toBe("exit");
  });

  it("HOLDS one bp inside the stop", async () => {
    const mark = BASE_PRICE - (BASE_PRICE * (STOP_LOSS_BPS - 1n)) / 10_000n;
    const d = await decide(state({ position: position() }), market({ markPriceWei: mark }), cfg());
    expect(d.kind).toBe("hold");
  });

  it("EXITS on take-profit, and the reason shows the floored target", async () => {
    const mark = (BASE_PRICE * 12_000n) / 10_000n; // +2000bps, past the ~471bps target
    const d = await decide(state({ position: position() }), market({ markPriceWei: mark }), cfg());
    expect(d.kind).toBe("exit");
    if (d.kind !== "exit") throw new Error("unreachable");
    expect(d.reason).toMatch(/^TAKE PROFIT:/);
    expect(d.reason).toMatch(/round trip/);
  });

  it("HOLDS inside the band, and says where both edges are", async () => {
    const mark = (BASE_PRICE * 10_100n) / 10_000n; // +100bps
    const d = await decide(state({ position: position() }), market({ markPriceWei: mark }), cfg());
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/inside the band/);
    expect(d.reason).toMatch(/-235/);
  });

  it("does NOT force a sale on an unreadable mark price", async () => {
    // Selling on a failed price read is trading on no information, and RESEARCH §5 warns the API
    // is unstable. A forced exit here would turn every API blip into a realised loss.
    for (const bad of [undefined, 0n, -1n]) {
      const d = await decide(
        state({ position: position() }),
        market({ markPriceWei: bad }),
        cfg(),
      );
      expect(d.kind).toBe("hold");
      if (d.kind !== "hold") continue;
      expect(d.reason).toMatch(/mark price unreadable/);
      expect(d.reason).toMatch(/withdrawal is not gated/);
    }
  });
});

describe("decide — RULE 1 reaches all the way through", () => {
  /*
   * ══ THE BEHAVIOUR CHANGE, ASSERTED IN BOTH DIRECTIONS ══
   *
   * A 10%-tax token is no longer refused by a TIER RULE. It is refused by its own COST BAR when
   * its move is too small, and ADMITTED when the move is large enough to pay for the tax. Both
   * halves are tested, because a suite that only proved the refusal would pass just as happily
   * against the old hard filter — which is the thing being replaced.
   */
  it("HOLDS on a 10%-tax token whose move cannot pay its 1938bps round trip", async () => {
    // A 900bps move clears the bar comfortably at 1% tax. At 10% it does not come close.
    const d = await decide(
      state(),
      market({ candidates: [candidate({ token: { ...candidate().token, taxPct: 10 } })] }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    // Refused by ARITHMETIC, not by a tier rule. The reason must carry the numbers.
    expect(d.reason).toMatch(/cost bar refused it|does not cover its own tax/);
    // And it must NOT be refused for being tier 10 — that rule is gone.
    expect(d.reason).not.toMatch(/taxPct 10% !=/);
  });

  it("ENTERS a 10%-tax token when the move DOES clear its own tax bar", async () => {
    // THE POINT OF THE REBUILD: a 5%-tax token that moves 30% beats a 1%-tax token that moves 2%.
    // At 10% tax the bar is ~3876bps of expected gain; a 6000bps move clears it.
    const d = await decide(
      state(),
      market({
        candidates: [
          candidate({
            token: { ...candidate().token, taxPct: 10 },
            history: history(6000n),
          }),
        ],
      }),
      cfg(),
    );
    expect(d.kind).toBe("enter");
    if (d.kind !== "enter") throw new Error("unreachable");
    // The cost actually charged must be the 10% one, not a 1% one read from config.
    expect(d.cost.totalBps).toBeGreaterThan(1900n);
    expect(d.score.netEdgeBps).toBeGreaterThan(0n);
  });

  it("ranks on NET edge, so a low-tax token beats a high-tax one on the SAME move", async () => {
    // Identical 900bps moves. The 1% token nets ~669bps; the 10% token nets negative and is
    // refused outright. Ranking on GROSS move would have made them indistinguishable.
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
    // Both refused for REAL reasons now that tier alone is not one: a 10%-tax token whose 900bps
    // move cannot pay its 1938bps round trip, and a token that fails the sell simulation.
    const allBad = [
      candidate({ token: { ...candidate().token, address: "0xTen", taxPct: 10 } }),
      candidate({
        token: { ...candidate().token, address: "0xThree", taxPct: 3 },
        sell: { ok: false, selector: "0x7a5ed734" },
      }),
    ];
    const d = await decide(state(), market({ candidates: allBad }), cfg());
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/2 candidate\(s\) refused/);
    expect(d.reason).toContain("0xTen");
    expect(d.reason).toContain("0xThree");
  });
});

describe("decide — the bar and the signal both bind", () => {
  it("HOLDS when the signal does not fire — a flat token is not entered", async () => {
    const d = await decide(state(), market({ candidates: [candidate({ history: history(0n) })] }), cfg());
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/no breakout/);
  });

  it("HOLDS on a downward move — long only", async () => {
    const d = await decide(
      state(),
      market({ candidates: [candidate({ history: history(-900n) })] }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/DOWNWARD/);
  });

  it("HOLDS when the signal fires but too weakly to clear the bar", async () => {
    // A move over the ~314bps breakout but the expected gain is the take-profit, which at a
    // punitive gas price cannot clear 2x cost. Raising gas is the cleanest way to move the bar
    // without touching the signal.
    const d = await decide(
      state(),
      market({ candidates: [candidate({ history: history(400n) })], gasPriceWei: 5_000_000_000n }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    // Either gate may catch it — the bar on expected gain, or the net-edge check that refuses a
    // move which cannot cover its own cost. Both are the cost term binding, which is the property.
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
    expect(s.compartmentWei).toBe(5_000_000_000_000_000n);
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
        decide(state({ position: position() }), market({ markPriceWei: BASE_PRICE }), cfg()),
      ).resolves.toBeDefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("every Decision is exactly one of hold | enter | exit", async () => {
    const cases: Array<Promise<unknown>> = [
      decide(state(), market(), cfg()),
      decide(state(), market({ candidates: [] }), cfg()),
      decide(state({ position: position() }), market({ markPriceWei: BASE_PRICE / 2n }), cfg()),
      decide(state({ position: position() }), market({ markPriceWei: BASE_PRICE }), cfg()),
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
    // unprofitable must hold, not buy the top of a bad list.
    const d = await decide(
      state(),
      market({
        candidates: [
          candidate({ token: { ...candidate().token, address: "0xA", taxPct: 10 } }),
          candidate({ token: { ...candidate().token, address: "0xB", taxPct: 10 } }),
        ],
      }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
  });
});

describe("decide — the exit is costed against the POSITION's tax, not the config's", () => {
  it("uses the open position's own tax tier for the take-profit floor", async () => {
    /*
     * A REAL BUG this replaced: the exit read `cfg.eligibility.requiredTaxPct`, which was correct
     * only while every position was guaranteed to be 1%-tax. Now that any tier may be held,
     * reading config would understate a 10%-tax exit by ~1700bps and set the take-profit far too
     * low — selling into a "profit" that does not cover the tax.
     *
     * A 10%-tax position needs ~3876bps to clear its round trip. At +2000bps it must still HOLD.
     */
    const d = await decide(
      state({
        position: position({ taxPct: 10 }),
        compartmentWei: 0n,
      }),
      market({ markPriceWei: (BASE_PRICE * 12_000n) / 10_000n }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    /*
     * The band must be the 10%-TAX one: +4068bps, i.e. 2 x the ~2034bps round trip on a 10% token.
     * Had the config's 1% been read instead, the target would be ~471bps and a +2000bps move would
     * have taken profit — selling into a "gain" that does not cover the tax.
     */
    expect(d.reason).toMatch(/\+4068\]bps/);
    expect(d.reason).not.toMatch(/\+471\]bps/);
  });

  it("takes profit on the SAME move when the position is 1%-tax", async () => {
    // Both directions: the tier actually changes the outcome, so the field is load-bearing.
    const d = await decide(
      state({ position: position({ taxPct: 1 }), compartmentWei: 0n }),
      market({ markPriceWei: (BASE_PRICE * 12_000n) / 10_000n }),
      cfg(),
    );
    expect(d.kind).toBe("exit");
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

  it("a candidate whose signal does not fire is skipped, not fatal", async () => {
    const d = await decide(
      state(),
      market({
        candidates: [
          candidate({ token: { ...candidate().token, address: "0xFlat" }, history: history(0n) }),
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
          candidate({ token: { ...candidate().token, address: "0xFlat" }, history: history(0n) }),
        ],
      }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/3 candidate\(s\) refused/);
    expect(d.reason).toContain("0xSeed");
    expect(d.reason).toContain("0xTrap");
    expect(d.reason).toContain("0xFlat");
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
