import { describe, expect, it } from "vitest";
import { type Candidate, decide, type DecideConfig, type Market } from "./decide.js";
import { DEFAULT_ELIGIBILITY } from "./eligible.js";
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
    ...overrides,
  };
}

function cfg(overrides: Partial<DecideConfig> = {}): DecideConfig {
  return {
    eligibility: DEFAULT_ELIGIBILITY,
    risk: DEFAULT_RISK,
    ledger: durable(),
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
  it("HOLDS rather than entering a 10%-tax token", async () => {
    const d = await decide(
      state(),
      market({ candidates: [candidate({ token: { ...candidate().token, taxPct: 10 } })] }),
      cfg(),
    );
    expect(d.kind).toBe("hold");
    if (d.kind !== "hold") throw new Error("unreachable");
    expect(d.reason).toMatch(/taxPct 10%/);
  });

  it("picks the 1% token out of a mixed candidate list", async () => {
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
    const allBad = [
      candidate({ token: { ...candidate().token, address: "0xTen", taxPct: 10 } }),
      candidate({ token: { ...candidate().token, address: "0xThree", taxPct: 3 } }),
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
    expect(d.reason).toMatch(/cost bar refused it/);
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
