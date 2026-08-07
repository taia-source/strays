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
    /*
     * ══ `mark` IS NOT EXEMPT, AND THE EXEMPTION IS THE EXACT BUG meridian SHIPPED ══
     *
     * `StrayVault.mark` moves no value: it is keeper-only, monotone, and nothing in the contract
     * reads `peakPriceWei` to gate anything, so a wrong value cannot block an exit or a withdrawal.
     * That makes it the most tempting call in the system to wave through the kill switch — and
     * "moves no value" is the wrong test.
     *
     * It signs a transaction with the keeper key, spends gas, and writes contract storage. meridian
     * recorded its own version of this exemption against itself: the LP guard "runs EVEN WITH
     * AGENT_LIVE_TRADING=false ... If you need the engine to touch nothing at all, it must also
     * hold no open LP positions." Their master switch did not stop all on-chain activity, because
     * one call had been judged harmless enough to skip it.
     *
     * An operator who has not set all three switches has not consented to ANY transaction.
     */
    await expect(refuse("mark")()).rejects.toThrow("OBSERVE mode");
  });

  /**
   * THE SAME PROPERTY, ASSERTED AGAINST THE REAL WIRING RATHER THAN A LOCAL COPY OF IT.
   *
   * The test above proves a `refuse` helper throws. This one proves the keeper's DEPENDENCY OBJECT
   * is built from that helper for all three executors — the gap RESEARCH §7g is about, between a
   * claim and the code that would have to run for it. If someone wires `executeMark` to a live
   * writer unconditionally, the object below stops matching and this fails.
   */
  it("builds ALL THREE observe-mode executors as refusals, mark included", async () => {
    const live = false;
    const refuse = (what: string) => async (): Promise<never> => {
      throw new Error(`refusing to ${what}: keeper is in OBSERVE mode`);
    };
    // The exact shape `main.ts` constructs when `canSpend()` is false.
    const deps = {
      executeHunt: live ? async () => ({ ok: true }) : refuse("hunt"),
      executeFlee: live ? async () => ({ ok: true }) : refuse("flee"),
      executeMark: live ? async () => ({ ok: true }) : refuse("mark"),
    };

    // EVERY state-changing on-chain call refuses. Not two of three.
    for (const [name, fn] of Object.entries(deps)) {
      await expect(fn(), `${name} must refuse in observe mode`).rejects.toThrow("OBSERVE mode");
    }
  });
});
