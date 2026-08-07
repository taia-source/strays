import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCREEN,
  explainSellRevert,
  type HolderDistribution,
  type ScreenConfig,
  screenToken,
  SELL_REVERT_HOOK_REFUSAL,
  SELL_REVERT_NOT_ENOUGH_LIQUIDITY,
  type SellSimulation,
  simulatedRoundTripBps,
} from "./screen.js";

/** Concentration well inside every measured ceiling. Each test breaks exactly one thing. */
function holders(overrides: Partial<HolderDistribution> = {}): HolderDistribution {
  return {
    top10Pct: 5,
    creatorPct: 0,
    creatorSold: true,
    sniperCount: 0,
    sniperHeldPct: 0,
    ...overrides,
  };
}

/** A sell simulation that succeeded, returning ~231bps less than a $5 position — the 1% tier. */
const SELLABLE: SellSimulation = { ok: true, proceedsWei: 2_540_919_554_531_752n };
const POSITION = 2_600_000_000_000_000n;

function screen(args: {
  sell?: SellSimulation;
  holders?: Partial<HolderDistribution>;
  cfg?: ScreenConfig;
}) {
  return screenToken({
    address: "0xCatDay",
    sell: args.sell ?? SELLABLE,
    holders: holders(args.holders),
    cfg: args.cfg ?? DEFAULT_SCREEN,
  });
}

describe("THE SELL SIMULATION — the check that refused 84 of 100 live tokens", () => {
  /*
   * ══ THE MEASUREMENT THIS WHOLE MODULE EXISTS FOR ══
   *
   * Across the newest 100 tokens: 0 buy-quote failures, 84 SELL-quote failures. The shipped
   * strategy checked only the buy side, so it would have bought all 84 and found out while holding.
   */
  it("REFUSES a token whose sell leg does not quote — the honeypot shape", () => {
    const v = screen({ sell: { ok: false, selector: SELL_REVERT_HOOK_REFUSAL } });
    expect(v.safe).toBe(false);
    if (v.safe) throw new Error("unreachable");
    expect(v.reason).toMatch(/SELL SIMULATION FAILED/);
    // The reason must carry the MEASUREMENT, so /logs shows a finding rather than an assertion.
    expect(v.reason).toMatch(/84 of the newest\s+100/);
  });

  it("ADMITS a token whose sell leg quotes — the bar is not simply 'refuse everything'", () => {
    // Both directions. A screen that refused everything would pass a one-sided suite, and that is
    // precisely the state openhood shipped in when its gas price made every trade impossible.
    const v = screen({});
    expect(v.safe).toBe(true);
    if (!v.safe) throw new Error("unreachable");
    expect(v.proceedsWei).toBe(2_540_919_554_531_752n);
    expect(v.notes).toMatch(/sell simulation PASSED/);
  });

  it("REFUSES a sell that quotes but returns nothing — a politely-reverting honeypot", () => {
    const v = screen({ sell: { ok: true, proceedsWei: 0n } });
    expect(v.safe).toBe(false);
    if (v.safe) throw new Error("unreachable");
    expect(v.reason).toMatch(/honeypot that reverts politely/);
  });

  it("REFUSES a negative sell proceeds — a failed read, not a payout", () => {
    expect(screen({ sell: { ok: true, proceedsWei: -1n } }).safe).toBe(false);
  });

  /*
   * ══ THE TWO MEASURED REVERT CAUSES ARE DISTINGUISHED IN THE LOG ══
   *
   * Unwrapping `UnexpectedRevertBytes` gave exactly two inner selectors across all 84 failures,
   * and they mean different things. The ACTION is the same — do not buy — but a log that cannot
   * tell a thin pool from a hook refusal cannot tell an operator whether the pad is broken.
   */
  it("names NotEnoughLiquidity as a DEPTH problem, not malice", () => {
    expect(explainSellRevert(SELL_REVERT_NOT_ENOUGH_LIQUIDITY)).toMatch(/NotEnoughLiquidity/);
    expect(explainSellRevert(SELL_REVERT_NOT_ENOUGH_LIQUIDITY)).toMatch(/38\/100/);
  });

  it("names the hook refusal, and records that all 46 had ZERO trades", () => {
    // This is the correction that stopped us calling 84% of the pad a honeypot. The perfect
    // correlation with zero trades is the evidence, and it belongs in the string.
    expect(explainSellRevert(SELL_REVERT_HOOK_REFUSAL)).toMatch(/zero trades ever/);
    expect(explainSellRevert(SELL_REVERT_HOOK_REFUSAL)).toMatch(/46\/100/);
  });

  it("reports an unknown selector verbatim rather than guessing at it", () => {
    expect(explainSellRevert("0xdeadbeef")).toMatch(/unrecognised selector 0xdeadbeef/);
    expect(explainSellRevert(null)).toMatch(/no decodable revert selector/);
  });

  it("the sell check runs BEFORE concentration — an unsellable token is refused whatever else", () => {
    // Ordering matters: no amount of good concentration data makes an unsellable token tradeable,
    // and the reason must name the sell failure rather than a concentration figure.
    const v = screen({
      sell: { ok: false, selector: SELL_REVERT_NOT_ENOUGH_LIQUIDITY },
      holders: { top10Pct: 0, sniperHeldPct: 0, creatorPct: 0 },
    });
    expect(v.safe).toBe(false);
    if (v.safe) throw new Error("unreachable");
    expect(v.reason).toMatch(/SELL SIMULATION FAILED/);
  });
});

describe("concentration ceilings", () => {
  it("REFUSES sniper/bundle holdings above the ceiling", () => {
    const v = screen({ holders: { sniperHeldPct: 20, sniperCount: 12 } });
    expect(v.safe).toBe(false);
    if (v.safe) throw new Error("unreachable");
    expect(v.reason).toMatch(/sniper\/bundle wallets hold 20\.00%/);
    // The citation matters: bundling is what makes naive top-10 understate risk.
    expect(v.reason).toMatch(/median 24 points/);
  });

  it("checks SNIPERS BEFORE top-10 — bundling is what top-10 hides behind", () => {
    // A token with a flattering top-10 and a damning sniper figure must be refused ON THE SNIPERS.
    // Checking the weaker signal first would let exactly this token through.
    const v = screen({ holders: { top10Pct: 1, sniperHeldPct: 40, sniperCount: 30 } });
    expect(v.safe).toBe(false);
    if (v.safe) throw new Error("unreachable");
    expect(v.reason).toMatch(/sniper\/bundle/);
    expect(v.reason).not.toMatch(/top-10 holders hold/);
  });

  it("REFUSES top-10 concentration above the ceiling", () => {
    const v = screen({ holders: { top10Pct: 60 } });
    expect(v.safe).toBe(false);
    if (v.safe) throw new Error("unreachable");
    expect(v.reason).toMatch(/top-10 holders hold 60\.00%/);
    expect(v.reason).toMatch(/23\.92%/);
  });

  it("REFUSES a creator still holding above the ceiling", () => {
    const v = screen({ holders: { creatorPct: 25, creatorSold: false } });
    expect(v.safe).toBe(false);
    if (v.safe) throw new Error("unreachable");
    expect(v.reason).toMatch(/creator still holds 25\.00%/);
    expect(v.reason).toMatch(/supply that dumps on us/);
  });

  it("ADMITS every value at the MEASURED maximum for this pad", () => {
    // top10 23.92, sniperHeld 8.82, creator 3.36 were the measured maxima across the newest 100.
    // The ceilings must not refuse the real distribution — a filter that refuses everything
    // observed is not a filter, it is an outage.
    const v = screen({ holders: { top10Pct: 23.92, sniperHeldPct: 8.82, creatorPct: 3.36 } });
    expect(v.safe).toBe(true);
  });

  it("admits values exactly AT each ceiling — the boundary is inclusive", () => {
    expect(screen({ holders: { top10Pct: DEFAULT_SCREEN.maxTop10Pct } }).safe).toBe(true);
    expect(screen({ holders: { sniperHeldPct: DEFAULT_SCREEN.maxSniperHeldPct } }).safe).toBe(true);
    expect(screen({ holders: { creatorPct: DEFAULT_SCREEN.maxCreatorPct } }).safe).toBe(true);
  });

  it("refuses one bp past each ceiling — the other side of the same boundary", () => {
    expect(screen({ holders: { top10Pct: DEFAULT_SCREEN.maxTop10Pct + 0.01 } }).safe).toBe(false);
    expect(
      screen({ holders: { sniperHeldPct: DEFAULT_SCREEN.maxSniperHeldPct + 0.01 } }).safe,
    ).toBe(false);
    expect(screen({ holders: { creatorPct: DEFAULT_SCREEN.maxCreatorPct + 0.01 } }).safe).toBe(
      false,
    );
  });

  it("REFUSES a NaN or negative concentration — a failed API read is not a measurement of zero", () => {
    // RESEARCH §5: the API is unofficial. A missing field coerced to NaN must not read as "0% is
    // wonderfully decentralised", which is the direction a naive comparison fails in.
    for (const bad of [Number.NaN, -1]) {
      expect(screen({ holders: { sniperHeldPct: bad } }).safe, `sniper ${String(bad)}`).toBe(false);
      expect(screen({ holders: { top10Pct: bad } }).safe, `top10 ${String(bad)}`).toBe(false);
      expect(screen({ holders: { creatorPct: bad } }).safe, `creator ${String(bad)}`).toBe(false);
    }
  });

  it("the notes name every figure, so /logs shows what was checked", () => {
    const v = screen({ holders: { top10Pct: 12.5, sniperCount: 3, sniperHeldPct: 4.25 } });
    if (!v.safe) throw new Error("expected safe");
    expect(v.notes).toMatch(/top10 12\.50%/);
    expect(v.notes).toMatch(/snipers 3 holding 4\.25%/);
  });
});

describe("simulatedRoundTripBps — the only cost figure taken from the chain", () => {
  it("reproduces the MEASURED 1% round trip from a real quote pair", () => {
    // Live measurement: $5 in, 2540919554531752 wei back on CatDay. That is 227bps, and the
    // model in cost.ts independently predicts ~231bps. Both agreeing is the point.
    expect(simulatedRoundTripBps({ positionWei: POSITION, proceedsWei: SELLABLE.proceedsWei })).toBe(
      227n,
    );
  });

  it("reproduces the MEASURED 10% round trip", () => {
    // SpinningCat, live: 2600000000000000 in -> 2099391890934906 back = 1925bps, against a model
    // prediction of 1938bps. The tax tiers are real and the model is calibrated.
    expect(
      simulatedRoundTripBps({ positionWei: POSITION, proceedsWei: 2_099_391_890_934_906n }),
    ).toBe(1925n);
  });

  it("REFUSES a non-positive position rather than dividing by zero", () => {
    expect(() => simulatedRoundTripBps({ positionWei: 0n, proceedsWei: 1n })).toThrow(
      /divides by zero/,
    );
  });

  it("reports a LOSS as positive bps and a gain as negative — sign is not ambiguous", () => {
    expect(simulatedRoundTripBps({ positionWei: 1000n, proceedsWei: 900n })).toBe(1000n);
    expect(simulatedRoundTripBps({ positionWei: 1000n, proceedsWei: 1100n })).toBe(-1000n);
  });
});

describe("the notes distinguish a creator who has sold from one who has not", () => {
  it("marks a creator that already sold", () => {
    const v = screen({ holders: { creatorSold: true } });
    if (!v.safe) throw new Error("expected safe");
    expect(v.notes).toMatch(/\(already sold\)/);
  });

  it("does NOT mark one that still holds — 34 of 100 had sold, so the difference is real", () => {
    const v = screen({ holders: { creatorSold: false, creatorPct: 2 } });
    if (!v.safe) throw new Error("expected safe");
    expect(v.notes).not.toMatch(/already sold/);
  });
});
