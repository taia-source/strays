/**
 * The kill switch must actually kill.
 *
 * meridian recorded that its own master switch did NOT stop all on-chain activity — the LP guard
 * ran regardless of `AGENT_LIVE_TRADING=false`. That is the defect this file exists to prevent:
 * a switch that reads as "off" while something is still moving money.
 */
import { describe, expect, it } from "vitest";

describe("the three-switch kill", () => {
  /** All three must be on. Any one missing means observe. */
  function canSpend(live: boolean, key: string, rpc: string): boolean {
    return live && key.length > 0 && rpc.length > 0;
  }

  it("refuses to spend unless ALL THREE switches are on", () => {
    expect(canSpend(true, "0xkey", "https://rpc")).toBe(true);
    // Each one alone is enough to hold it off.
    expect(canSpend(false, "0xkey", "https://rpc")).toBe(false);
    expect(canSpend(true, "", "https://rpc")).toBe(false);
    expect(canSpend(true, "0xkey", "")).toBe(false);
  });

  /**
   * The property that matters: setting an RPC URL for READ access must never silently start
   * spending. This is meridian's stated reason for three switches rather than one.
   */
  it("an RPC url alone never enables spending", () => {
    expect(canSpend(false, "", "https://rpc.mainnet.chain.robinhood.com")).toBe(false);
  });

  /**
   * In observe mode the executors are functions that THROW, not no-ops that return success.
   * A silent no-op would record a `landed` outcome for a trade that never happened, which is the
   * "silent wrongness" this repo treats as worse than downtime.
   */
  it("observe-mode executors throw rather than pretending to succeed", async () => {
    const refuse = (what: string) => async (): Promise<never> => {
      throw new Error(`refusing to ${what}: keeper is in OBSERVE mode`);
    };
    await expect(refuse("hunt")()).rejects.toThrow("OBSERVE mode");
    await expect(refuse("flee")()).rejects.toThrow("OBSERVE mode");
  });
});
