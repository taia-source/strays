/**
 * Tests for the keeper tick.
 *
 * The single most important assertion in this file is that **a full cycle actually reaches the
 * executor**, and that it fails if the call is removed. openhood shipped
 * `AUTOMATIC_EXECUTION_WIRED = true` while nothing called the executor at all: "the flag said
 * automatic; the system was operator-initiated." A boolean can be set by hand. A test that observes
 * the call cannot.
 *
 * The second most important is the block near the end of this file: **the peak watermark survives a
 * simulated restart**. RESEARCH §7f is meridian's daily cap that reset on every deploy; a trailing
 * stop's watermark held in process memory is that bug in a new costume, and it fails worse, because
 * a reset watermark re-anchors the stop to the current price and silently disarms the only exit the
 * strategy has. `restartKeepsTheWatermark` throws a whole process away mid-position and asserts the
 * stop is still measured from the ORIGINAL peak.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candidate } from "./discovery.js";
import {
  type Decision,
  type DecideInput,
  type PositionState,
  type StrayState,
  type TickDeps,
  runTick,
} from "./tick.js";

const HOOK_A = "0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC";
const HOOK_B = "0xEfe669814e5Eec33406Bd50ffa8331618D076aEc";

const STRAY: StrayState = {
  id: `0x${"11".repeat(32)}` as `0x${string}`,
  stakeWei: 10_000_000_000_000_000n,
  positions: [],
  entryBlock: 0n,
};

const CANDIDATE: Candidate = {
  address: `0x${"22".repeat(20)}` as `0x${string}`,
  symbol: "TESTCAT",
  name: "Test Cat",
  taxPct: 1,
  marketCapEth: 2,
  change24hPct: 12,
  launchedAt: 1_700_000_000_000,
  pool: `0x${"33".repeat(32)}` as `0x${string}`,
  tickSpacing: 200,
  hook: HOOK_A,
  priceEth: 2e-9,
  holders: 11,
  volume24hEth: 3.9,
  swapCount: 25,
  observedAt: 1_700_000_000_000,
  observedBlock: 30_000_000n,
};

/** A position in a given slot, with sane defaults. */
function positionAt(over: Partial<PositionState> & { slot: number }): PositionState {
  return {
    token: `0x${String(over.slot).repeat(2).padStart(40, "a")}` as `0x${string}`,
    units: 1_000_000_000_000_000_000_000n,
    costBasisWei: 1_000_000_000_000_000n,
    tickSpacing: 200,
    hook: HOOK_A,
    peakPriceWei: 1_000_000n,
    taxPct: 1,
    openedAtSeconds: 1_700_000_000,
    ...over,
  };
}

function makeDeps(overrides: Partial<TickDeps> = {}): TickDeps & {
  huntCalls: Array<unknown[]>;
  fleeCalls: Array<unknown[]>;
  markCalls: Array<unknown[]>;
  quoteCalls: Array<unknown[]>;
  records: unknown[];
  decideInputs: DecideInput[];
} {
  const huntCalls: Array<unknown[]> = [];
  const fleeCalls: Array<unknown[]> = [];
  const markCalls: Array<unknown[]> = [];
  const quoteCalls: Array<unknown[]> = [];
  const records: unknown[] = [];
  const decideInputs: DecideInput[] = [];
  const base: TickDeps = {
    listStrays: async () => [STRAY],
    discover: async () => [CANDIDATE],
    currentBlock: async () => 30_000_001n,
    gasPriceWei: async () => 30_000_000n,
    executeHunt: async (...args) => {
      huntCalls.push(args);
      return { txHash: `0x${"ab".repeat(32)}` as `0x${string}`, gasUsed: 220_000n, slot: 0 };
    },
    executeFlee: async (...args) => {
      fleeCalls.push(args);
      return { txHash: `0x${"cd".repeat(32)}` as `0x${string}`, gasUsed: 180_000n };
    },
    executeMark: async (...args) => {
      markCalls.push(args);
      return { txHash: `0x${"ef".repeat(32)}` as `0x${string}`, peakPriceWei: args[2] };
    },
    quoteExitWei: async (...args) => {
      quoteCalls.push(args);
      return 1_000_000_000_000_000n;
    },
    record: async (r) => {
      records.push(r);
    },
    decide: (): Decision => ({
      kind: "enter",
      token: CANDIDATE.address,
      amountWei: 1_200_000_000_000_000n,
      minOut: 500_000n,
      tickSpacing: 200,
      hook: HOOK_A,
      reason: "momentum cleared the cost bar",
    }),
    now: () => 1_700_000_000_000,
  };
  const merged: TickDeps = { ...base, ...overrides };
  /*
   * `decide` is WRAPPED rather than replaced, so `decideInputs` records what the tick computed
   * even when a test supplies its own decision. Recording inside the default `decide` instead
   * would silently stop capturing the moment a test overrode it — and the marks and watermarks
   * these tests assert on are exactly what the tick hands to `decide`, so a test that overrode it
   * would be asserting against an empty array rather than failing.
   */
  const wrapped: TickDeps = {
    ...merged,
    decide: (input) => {
      decideInputs.push(input);
      return merged.decide(input);
    },
  };
  return {
    ...wrapped,
    huntCalls,
    fleeCalls,
    markCalls,
    quoteCalls,
    records,
    decideInputs,
  };
}

describe("runTick", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * THE TEST THAT MAKES "AUTOMATIC" A BEHAVIOUR RATHER THAN A CLAIM.
   *
   * Delete the `executeHunt` call from `runTick` and this fails. That is the whole point: openhood's
   * equivalent claim was a constant, and a constant cannot notice that nothing calls the executor.
   */
  it("actually reaches the executor on a full cycle", async () => {
    const deps = makeDeps();
    const written = await runTick(deps);

    expect(deps.huntCalls).toHaveLength(1);
    expect(deps.huntCalls[0]?.[0]).toBe(STRAY.id);
    expect(deps.huntCalls[0]?.[1]).toBe(CANDIDATE.address);
    // The HOOK reaches the executor too. RESEARCH §7d: a PoolKey without it addresses nothing.
    expect(deps.huntCalls[0]?.[2]).toBe(HOOK_A);
    expect(written).toHaveLength(1);
    expect(written[0]?.outcome.kind).toBe("landed");
  });

  /**
   * DECIDED is not LANDED. meridian records that a monitor must tell them apart because risk caps
   * and reverts block one from becoming the other, "and previously that distinction was silent".
   */
  it("records a decided-but-failed trade distinctly from a landed one", async () => {
    const deps = makeDeps({
      executeHunt: async () => {
        throw new Error("V4TooLittleReceived");
      },
    });
    const written = await runTick(deps);

    expect(written).toHaveLength(1);
    expect(written[0]?.outcome.kind).toBe("failed");
    // The decision itself is still recorded — a failed trade is information, not a non-event.
    expect(written[0]?.action).toBe("hunt");
    expect(written[0]?.rationale).toContain("cost bar");
  });

  it("does not call the executor when the decision is to hold", async () => {
    const deps = makeDeps({
      decide: (): Decision => ({ kind: "hold", reason: "nothing cleared the bar" }),
    });
    const written = await runTick(deps);

    expect(deps.huntCalls).toHaveLength(0);
    expect(deps.fleeCalls).toHaveLength(0);
    expect(written[0]?.outcome.kind).toBe("skipped");
  });

  it("exits the NAMED SLOT when told to", async () => {
    const holding: StrayState = {
      ...STRAY,
      positions: [positionAt({ slot: 3 })],
    };
    const deps = makeDeps({
      listStrays: async () => [holding],
      decide: (): Decision => ({
        kind: "exit",
        slot: 3,
        token: positionAt({ slot: 3 }).token,
        minOut: 1_000_000_000_000n,
        reason: "trailing stop",
      }),
    });
    const written = await runTick(deps);

    expect(deps.fleeCalls).toHaveLength(1);
    // The SLOT is what `flee(strayId, slot, minOut)` names, and a wrong index sells another
    // position at this one's floor.
    expect(deps.fleeCalls[0]?.[1]).toBe(3);
    expect(written[0]?.action).toBe("flee");
    expect(written[0]?.rationale).toBe("trailing stop");
  });

  /**
   * The overlap guard. openhood: "a live trade can outlast the think interval; without this guard
   * two ticks execute concurrently and can both spend before either records against the risk cap."
   */
  it("refuses to run two ticks concurrently", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const huntLog: Array<unknown[]> = [];
    const deps = makeDeps({
      executeHunt: async (...args) => {
        huntLog.push(args);
        await gate;
        return { txHash: `0x${"ab".repeat(32)}` as `0x${string}`, gasUsed: 220_000n, slot: 0 };
      },
    });

    const first = runTick(deps);
    // Second tick starts while the first is mid-trade. It must return EMPTY rather than spending
    // a second time — the SAME deps object, so both ticks share one executor and one call log.
    const second = await runTick(deps);
    expect(second).toEqual([]);

    release();
    const firstResult = await first;
    expect(firstResult).toHaveLength(1);
    // Exactly ONE spend happened across both ticks, not two.
    expect(huntLog).toHaveLength(1);
  });

  /** The guard must release even when a tick throws, or the keeper deadlocks forever. */
  it("releases the overlap guard when a tick throws", async () => {
    const boom = makeDeps({
      listStrays: async () => {
        throw new Error("rpc down");
      },
    });
    await expect(runTick(boom)).rejects.toThrow("rpc down");

    // A subsequent tick must still be able to run.
    const ok = makeDeps();
    const written = await runTick(ok);
    expect(written).toHaveLength(1);
  });

  /**
   * Discovery runs once per tick, not once per stray. At 240 req/60s a per-stray scan exhausts the
   * budget with a handful of cats, and every stray sees the same market anyway.
   */
  it("discovers once per tick regardless of how many strays exist", async () => {
    const discover = vi.fn(async () => [CANDIDATE]);
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...STRAY,
      id: `0x${String(i).padStart(64, "0")}` as `0x${string}`,
    }));
    const deps = makeDeps({ listStrays: async () => many, discover });

    await runTick(deps);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(deps.huntCalls).toHaveLength(25);
  });

  /** Every record carries the block it was observed at — ART-DIRECTION rule 2, no unstamped figure. */
  it("stamps every record with the chain block, not a wall clock alone", async () => {
    const deps = makeDeps();
    const written = await runTick(deps);
    expect(written[0]?.block).toBe(30_000_001n);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * MULTI-SLOT TICKING
 *
 * RESULTS §10.5: one slot takes 17 of 72 held-out opportunities at a Welch t of 1.16 (not
 * significant); eight slots take 71 of 72 at t 2.38–2.72, with the SAME per-ticket median. The
 * per-ticket edge never changed — n did. So the tick has to actually handle eight of everything,
 * and these are the assertions that fail if it quietly handles one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */
describe("multi-slot ticking", () => {
  /**
   * THE REGRESSION THAT MATTERS MOST HERE. The old tick quoted a single `holding`.
   *
   * If this loop is ever narrowed back to one position, seven stops go unevaluated every tick —
   * and an unevaluated stop is indistinguishable from a stop that has not fired.
   */
  it("quotes EVERY open position, not just the first", async () => {
    const stray: StrayState = {
      ...STRAY,
      positions: [
        positionAt({ slot: 0 }),
        positionAt({ slot: 1 }),
        positionAt({ slot: 4 }),
        positionAt({ slot: 7 }),
      ],
    };
    const deps = makeDeps({
      listStrays: async () => [stray],
      decide: (): Decision => ({ kind: "hold", reason: "all inside their trails" }),
    });
    await runTick(deps);

    expect(deps.quoteCalls).toHaveLength(4);
    // Each position is quoted for ITS OWN token, not four times for one.
    const quotedTokens = deps.quoteCalls.map((c) => c[0]);
    expect(new Set(quotedTokens).size).toBe(4);
  });

  /**
   * Each position is quoted in ITS OWN pool — its own tickSpacing AND its own hook.
   *
   * RESEARCH §7d: there are two hooks on this pad and quoting against the wrong one prices a pool
   * the position is not in. The failure is an empty inner revert that reads like an RPC blip, which
   * is exactly why it needs a test rather than a comment.
   */
  it("quotes each position through the hook it was ENTERED through", async () => {
    const stray: StrayState = {
      ...STRAY,
      positions: [
        positionAt({ slot: 0, hook: HOOK_A, tickSpacing: 200 }),
        positionAt({ slot: 1, hook: HOOK_B, tickSpacing: 60 }),
      ],
    };
    const deps = makeDeps({
      listStrays: async () => [stray],
      decide: (): Decision => ({ kind: "hold", reason: "held" }),
    });
    await runTick(deps);

    // quoteExitWei(token, units, tickSpacing, hook)
    expect(deps.quoteCalls[0]?.[2]).toBe(200);
    expect(deps.quoteCalls[0]?.[3]).toBe(HOOK_A);
    expect(deps.quoteCalls[1]?.[2]).toBe(60);
    expect(deps.quoteCalls[1]?.[3]).toBe(HOOK_B);
  });

  /**
   * ONE UNREADABLE PRICE MUST NOT DISARM THE OTHER SEVEN STOPS.
   *
   * A tick that returned early on the first failed quote would, on a single flaky token, stop
   * evaluating every other position's stop — on every tick, until that one read recovered. The
   * failure is invisible: a cat that never sells looks exactly like a cat whose stop has not fired.
   */
  it("keeps valuing the remaining positions when one quote fails", async () => {
    const stray: StrayState = {
      ...STRAY,
      positions: [positionAt({ slot: 0 }), positionAt({ slot: 1 }), positionAt({ slot: 2 })],
    };
    const deps = makeDeps({
      listStrays: async () => [stray],
      quoteExitWei: async (token, units, tickSpacing, hook) => {
        if (token === positionAt({ slot: 1 }).token) throw new Error("pool unreadable");
        void units;
        void tickSpacing;
        void hook;
        return 2_000_000_000_000_000n;
      },
      decide: (): Decision => ({ kind: "hold", reason: "held" }),
    });
    await runTick(deps);

    const marks = deps.decideInputs[0]?.marks ?? [];
    expect(marks).toHaveLength(3);
    // The failed one is null — NOT zero. Zero would read as a 100% fall and fire its stop.
    expect(marks.find((m) => m.slot === 1)?.markPriceWei).toBeNull();
    // The other two were still valued.
    expect(marks.find((m) => m.slot === 0)?.markPriceWei).not.toBeNull();
    expect(marks.find((m) => m.slot === 2)?.markPriceWei).not.toBeNull();
  });

  /** The equity term sums EVERY position, or sizing and drawdown are computed off a fraction. */
  it("totals the value of all open positions", async () => {
    const stray: StrayState = {
      ...STRAY,
      positions: [positionAt({ slot: 0 }), positionAt({ slot: 1 }), positionAt({ slot: 2 })],
    };
    const deps = makeDeps({
      listStrays: async () => [stray],
      quoteExitWei: async () => 3_000_000_000_000_000n,
      decide: (): Decision => ({ kind: "hold", reason: "held" }),
    });
    await runTick(deps);
    expect(deps.decideInputs[0]?.totalValueWei).toBe(9_000_000_000_000_000n);
  });

  /**
   * The mark is a PER-UNIT price, not a total. `units.test.ts` pins the arithmetic; this pins that
   * `runTick` is the thing that performs the conversion, for every slot.
   */
  it("hands the strategy per-unit mark prices, never totals", async () => {
    const stray: StrayState = {
      ...STRAY,
      positions: [positionAt({ slot: 0, units: 1_000_000_000_000_000_000_000n })],
    };
    const deps = makeDeps({
      listStrays: async () => [stray],
      quoteExitWei: async () => 2_000_000_000_000_000n,
      decide: (): Decision => ({ kind: "hold", reason: "held" }),
    });
    await runTick(deps);
    // 2e15 wei of proceeds over 1e21 units, scaled 1e18 => 2e12 wei per whole token.
    expect(deps.decideInputs[0]?.marks[0]?.markPriceWei).toBe(2_000_000_000_000n);
  });

  /** The watermark for a landed entry is filed under the slot the CHAIN chose, not the predicted one. */
  it("files the entry watermark under the slot the contract actually returned", async () => {
    const saved: Array<{ slot: number; token: string }> = [];
    const deps = makeDeps({
      // The contract picked slot 5 — e.g. a flee freed an earlier slot after we decided.
      executeHunt: async () => ({
        txHash: `0x${"ab".repeat(32)}` as `0x${string}`,
        gasUsed: 220_000n,
        slot: 5,
      }),
      savePeak: async ({ slot, token }) => {
        saved.push({ slot, token });
      },
    });
    await runTick(deps);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.slot).toBe(5);
    expect(saved[0]?.token).toBe(CANDIDATE.address);
  });

  /** A closed slot's watermark is dropped, so it cannot attach to the slot's next occupant. */
  it("clears the watermark of a slot it just exited", async () => {
    const cleared: Array<[string, number]> = [];
    const stray: StrayState = { ...STRAY, positions: [positionAt({ slot: 2 })] };
    const deps = makeDeps({
      listStrays: async () => [stray],
      decide: (): Decision => ({
        kind: "exit",
        slot: 2,
        token: positionAt({ slot: 2 }).token,
        minOut: 1n,
        reason: "trailing stop",
      }),
      clearPeak: async (strayId, slot) => {
        cleared.push([strayId, slot]);
      },
    });
    await runTick(deps);
    expect(cleared).toEqual([[STRAY.id, 2]]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PEAK WATERMARK — AND THE RESTART IT MUST SURVIVE
 *
 * RESEARCH §7f: meridian's daily cap *"only reset on process restart, so the 'daily' cap was really
 * 'spend since last boot'"*. A trailing stop's watermark in process memory is that bug in new
 * clothes and it fails strictly worse — a reset watermark re-anchors the stop to the current price,
 * WIDENING it on every deploy, and RESULTS §10.3 measured that this exit is the only thing that
 * resolves positions at all (0 of 72 held-out positions needed marking to market with it; 100% were
 * unresolved without it).
 *
 * These tests are what makes "durable" a behaviour rather than a comment.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */
describe("the peak price watermark", () => {
  it("raises the watermark on a new high, in BOTH Postgres and the chain", async () => {
    const saved: bigint[] = [];
    const stray: StrayState = {
      ...STRAY,
      positions: [positionAt({ slot: 1, peakPriceWei: 1_000n, units: 1_000_000_000_000_000_000n })],
    };
    const deps = makeDeps({
      listStrays: async () => [stray],
      // 5e15 proceeds / 1e18 units, scaled 1e18 = 5,000,000 wei per token — well above the 1000 peak.
      quoteExitWei: async () => 5_000_000n,
      savePeak: async ({ peakPriceWei }) => {
        saved.push(peakPriceWei);
      },
      decide: (): Decision => ({ kind: "hold", reason: "inside the trail" }),
    });
    await runTick(deps);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toBe(5_000_000n);
    // And the CHAIN copy, via mark(strayId, slot, priceWei).
    expect(deps.markCalls).toHaveLength(1);
    expect(deps.markCalls[0]?.[1]).toBe(1);
    expect(deps.markCalls[0]?.[2]).toBe(5_000_000n);
  });

  /** MONOTONE. A mark below the peak is not a new high and must not write anything. */
  it("never lowers the watermark when the price falls", async () => {
    const saved: bigint[] = [];
    const stray: StrayState = {
      ...STRAY,
      positions: [
        positionAt({ slot: 0, peakPriceWei: 9_000_000n, units: 1_000_000_000_000_000_000n }),
      ],
    };
    const deps = makeDeps({
      listStrays: async () => [stray],
      quoteExitWei: async () => 4_000_000n, // a fall, well below the 9,000,000 peak
      savePeak: async ({ peakPriceWei }) => {
        saved.push(peakPriceWei);
      },
      decide: (): Decision => ({ kind: "hold", reason: "inside the trail" }),
    });
    await runTick(deps);

    expect(saved).toEqual([]);
    expect(deps.markCalls).toEqual([]);
    // The peak handed to the strategy is still the HIGH, which is what the stop is measured from.
    expect(deps.decideInputs[0]?.marks[0]?.peakPriceWei).toBe(9_000_000n);
  });

  /**
   * ══ THE ONE THAT MATTERS: A RESTART MUST NOT WIDEN THE STOP ══
   *
   * Simulates a full process death. Tick 1 runs, the price climbs, the watermark is raised and
   * persisted. Then EVERY piece of process state is thrown away — new deps, new closures, empty
   * in-memory anything — and only the durable store survives, exactly as it would across a Railway
   * redeploy. The price then falls.
   *
   * The assertion is that the stop is still measured from the ORIGINAL peak. If the watermark lived
   * in the process, the reborn keeper would re-seed it at the fallen price and the trailing stop
   * would silently widen — which is the §7f failure, and it would disarm the only exit there is.
   */
  it("survives a simulated restart: the stop is still measured from the ORIGINAL peak", async () => {
    /** The ONLY thing that outlives the "process". A stand-in for the `position_peaks` table. */
    const durable = new Map<string, { token: string; peakPriceWei: bigint }>();
    const TOKEN = positionAt({ slot: 2 }).token;
    const UNITS = 1_000_000_000_000_000_000n;

    /** Build a keeper "process" from scratch, sharing nothing but the durable store. */
    const spawn = (chainPeak: bigint, proceedsWei: bigint) => {
      const stray: StrayState = {
        ...STRAY,
        positions: [
          positionAt({ slot: 2, token: TOKEN, units: UNITS, peakPriceWei: chainPeak }),
        ],
      };
      return makeDeps({
        listStrays: async () => [stray],
        quoteExitWei: async () => proceedsWei,
        loadPeaks: async () => {
          const out = new Map<number, { token: string; peakPriceWei: bigint }>();
          const row = durable.get("2");
          if (row) out.set(2, row);
          return out;
        },
        savePeak: async ({ slot, token, peakPriceWei }) => {
          const prior = durable.get(String(slot));
          // The store's monotone GREATEST, mirrored: never lower, and reset on a token change.
          const next =
            prior && prior.token === token && prior.peakPriceWei > peakPriceWei
              ? prior.peakPriceWei
              : peakPriceWei;
          durable.set(String(slot), { token, peakPriceWei: next });
        },
        decide: (): Decision => ({ kind: "hold", reason: "inside the trail" }),
      });
    };

    /* ── TICK 1: the price runs up to 8,000,000 wei/token. The watermark records the high. ── */
    const before = spawn(1_000_000n, 8_000_000n);
    await runTick(before);
    expect(before.decideInputs[0]?.marks[0]?.peakPriceWei).toBe(8_000_000n);
    expect(durable.get("2")?.peakPriceWei).toBe(8_000_000n);

    /* ── THE RESTART. Everything above is discarded. Only `durable` crosses the boundary. ──
     *
     * The chain's copy comes back as the ENTRY price here, deliberately understating what the
     * chain would really hold — `mark()` would have raised it too. Using the low value proves the
     * POSTGRES copy is doing the work, so this test cannot pass by accident on the chain read.
     */
    const after = spawn(1_000_000n, 5_000_000n); // price has fallen from the 8,000,000 peak
    await runTick(after);

    const peak = after.decideInputs[0]?.marks[0]?.peakPriceWei;
    // THE ASSERTION. Still measured from the high, not re-anchored to the current price.
    expect(peak).toBe(8_000_000n);
    // And concretely: a 50% trail off 8,000,000 stops at 4,000,000. Off a reset watermark of
    // 5,000,000 it would stop at 2,500,000 — the stop would have widened by 37.5%.
    expect((peak as bigint) / 2n).toBe(4_000_000n);
    // The fall is not a new high, so nothing was written and no `mark` was sent.
    expect(after.markCalls).toEqual([]);
  });

  /**
   * THE CHAIN IS THE AUTHORITY. When the two copies disagree, the HIGHER one wins — which is
   * `raisePeak`'s monotonicity used as a merge rule rather than an arbitrary tie-break.
   */
  it("takes the chain's watermark when it is ahead of the local copy", async () => {
    const stray: StrayState = {
      ...STRAY,
      positions: [
        positionAt({ slot: 0, peakPriceWei: 9_000_000n, units: 1_000_000_000_000_000_000n }),
      ],
    };
    const deps = makeDeps({
      listStrays: async () => [stray],
      quoteExitWei: async () => 1_000_000n,
      // Postgres is BEHIND — e.g. a save failed, or this keeper is new to the stray.
      loadPeaks: async () =>
        new Map([[0, { token: positionAt({ slot: 0 }).token, peakPriceWei: 2_000_000n }]]),
      decide: (): Decision => ({ kind: "hold", reason: "held" }),
    });
    await runTick(deps);
    expect(deps.decideInputs[0]?.marks[0]?.peakPriceWei).toBe(9_000_000n);
  });

  /** And the other direction: a local copy ahead of the chain is preserved, not discarded. */
  it("takes the local watermark when it is ahead of the chain", async () => {
    const stray: StrayState = {
      ...STRAY,
      positions: [
        positionAt({ slot: 0, peakPriceWei: 2_000_000n, units: 1_000_000_000_000_000_000n }),
      ],
    };
    const deps = makeDeps({
      listStrays: async () => [stray],
      quoteExitWei: async () => 1_000_000n,
      loadPeaks: async () =>
        new Map([[0, { token: positionAt({ slot: 0 }).token, peakPriceWei: 7_500_000n }]]),
      decide: (): Decision => ({ kind: "hold", reason: "held" }),
    });
    await runTick(deps);
    expect(deps.decideInputs[0]?.marks[0]?.peakPriceWei).toBe(7_500_000n);
  });

  /**
   * A STALE ROW FROM A CLOSED POSITION MUST NOT ATTACH TO THE SLOT'S NEXT OCCUPANT.
   *
   * Slot 0 previously held a token whose peak was 50,000,000. A new token now occupies it. That
   * number is not a larger observation of the new token's price — it is arithmetically unrelated,
   * and adopting it would arm the new position's stop at a level it has never traded near.
   */
  it("ignores a stored watermark whose token no longer matches the slot", async () => {
    const stray: StrayState = {
      ...STRAY,
      positions: [
        positionAt({
          slot: 0,
          token: `0x${"be".repeat(20)}` as `0x${string}`,
          peakPriceWei: 1_000_000n,
          units: 1_000_000_000_000_000_000n,
        }),
      ],
    };
    const deps = makeDeps({
      listStrays: async () => [stray],
      quoteExitWei: async () => 1_200_000n,
      loadPeaks: async () =>
        new Map([[0, { token: `0x${"ff".repeat(20)}`, peakPriceWei: 50_000_000n }]]),
      decide: (): Decision => ({ kind: "hold", reason: "held" }),
    });
    await runTick(deps);
    // The stale 50,000,000 is refused; this tick's own mark (1,200,000) is the new high.
    expect(deps.decideInputs[0]?.marks[0]?.peakPriceWei).toBe(1_200_000n);
  });

  /**
   * A FAILED `mark()` MUST NOT ABORT THE TICK.
   *
   * This is the OBSERVE-MODE path as much as an error path: `executeMark` throws by construction
   * when the three switches are not all on. A tick that propagated that would evaluate no stops at
   * all, which would turn "we are not allowed to transact" into "we are not allowed to think".
   */
  it("continues the tick when the on-chain mark fails or is refused", async () => {
    const stray: StrayState = {
      ...STRAY,
      positions: [
        positionAt({ slot: 0, peakPriceWei: 1_000n, units: 1_000_000_000_000_000_000n }),
      ],
    };
    const deps = makeDeps({
      listStrays: async () => [stray],
      quoteExitWei: async () => 5_000_000n,
      executeMark: async () => {
        throw new Error("refusing to mark: keeper is in OBSERVE mode");
      },
      decide: (): Decision => ({ kind: "hold", reason: "held" }),
    });
    const written = await runTick(deps);

    // The tick completed and a decision was still recorded.
    expect(written).toHaveLength(1);
    // And the stop was still evaluated against the correct, raised watermark.
    expect(deps.decideInputs[0]?.marks[0]?.peakPriceWei).toBe(5_000_000n);
  });
});
