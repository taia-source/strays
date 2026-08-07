/**
 * Tests for the keeper tick.
 *
 * The single most important assertion in this file is that **a full cycle actually reaches the
 * executor**, and that it fails if the call is removed. openhood shipped
 * `AUTOMATIC_EXECUTION_WIRED = true` while nothing called the executor at all: "the flag said
 * automatic; the system was operator-initiated." A boolean can be set by hand. A test that observes
 * the call cannot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candidate } from "./discovery.js";
import { type Decision, type DecideInput, type StrayState, type TickDeps, runTick } from "./tick.js";

const STRAY: StrayState = {
  id: `0x${"11".repeat(32)}` as `0x${string}`,
  stakeWei: 10_000_000_000_000_000n,
  holding: null,
  holdingUnits: 0n,
  costBasisWei: 0n,
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
  priceEth: 2e-9,
  holders: 11,
  volume24hEth: 3.9,
  observedAt: 1_700_000_000_000,
  observedBlock: 30_000_000n,
};

function makeDeps(overrides: Partial<TickDeps> = {}): TickDeps & {
  huntCalls: Array<unknown[]>;
  fleeCalls: Array<unknown[]>;
  records: unknown[];
} {
  const huntCalls: Array<unknown[]> = [];
  const fleeCalls: Array<unknown[]> = [];
  const records: unknown[] = [];
  const base: TickDeps = {
    listStrays: async () => [STRAY],
    discover: async () => [CANDIDATE],
    currentBlock: async () => 30_000_001n,
    gasPriceWei: async () => 30_000_000n,
    executeHunt: async (...args) => {
      huntCalls.push(args);
      return { txHash: `0x${"ab".repeat(32)}` as `0x${string}`, gasUsed: 220_000n };
    },
    executeFlee: async (...args) => {
      fleeCalls.push(args);
      return { txHash: `0x${"cd".repeat(32)}` as `0x${string}`, gasUsed: 180_000n };
    },
    quoteExitWei: async () => 1_000_000_000_000_000n,
    record: async (r) => {
      records.push(r);
    },
    decide: (): Decision => ({
      kind: "enter",
      token: CANDIDATE.address,
      amountWei: 1_200_000_000_000_000n,
      minOut: 500_000n,
      tickSpacing: 200,
      reason: "momentum cleared the cost bar",
    }),
    now: () => 1_700_000_000_000,
  };
  return { ...base, ...overrides, huntCalls, fleeCalls, records };
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

  it("exits a position when told to", async () => {
    const holding: StrayState = {
      ...STRAY,
      holding: CANDIDATE.address,
      holdingUnits: 500_000_000_000_000_000_000_000n,
      costBasisWei: 1_200_000_000_000_000n,
    };
    const deps = makeDeps({
      listStrays: async () => [holding],
      decide: (): Decision => ({ kind: "exit", minOut: 1_000_000_000_000n, reason: "stop loss" }),
    });
    const written = await runTick(deps);

    expect(deps.fleeCalls).toHaveLength(1);
    expect(written[0]?.action).toBe("flee");
    expect(written[0]?.rationale).toBe("stop loss");
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
        return { txHash: `0x${"ab".repeat(32)}` as `0x${string}`, gasUsed: 220_000n };
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
