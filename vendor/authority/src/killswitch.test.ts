import { describe, expect, it } from "vitest";
import {
  canExecute,
  DEFENCE_LAYERS,
  type Halt,
  halt,
  type PendingAction,
  resume,
  validateDelayPolicy,
} from "./killswitch.js";

const NOW = 1_800_000_000;
const running: Halt = { status: "running", reason: "", atSeconds: NOW };
const policy = { delaySeconds: 300 };
const pending: PendingAction<string> = { id: "a1", action: "transfer", queuedAtSeconds: NOW };

describe("delay window", () => {
  it("refuses execution inside the veto window and says how long is left", () => {
    const check = canExecute({ pending, policy, halt: running, nowSeconds: NOW + 100 });
    expect(check.ready).toBe(false);
    if (!check.ready) expect(check.waitSeconds).toBe(200);
  });

  it("allows execution once the window has elapsed", () => {
    expect(canExecute({ pending, policy, halt: running, nowSeconds: NOW + 300 }).ready).toBe(true);
  });

  it("refuses a vetoed action however long it has waited", () => {
    const vetoed = { ...pending, vetoedReason: "recipient looked wrong" };
    const check = canExecute({ pending: vetoed, policy, halt: running, nowSeconds: NOW + 100_000 });
    expect(check.ready).toBe(false);
    if (!check.ready) expect(check.reason).toContain("vetoed");
  });

  /**
   * The ordering that matters: an action queued BEFORE a halt must not execute after it
   * merely because its timer elapsed. That is precisely the case a kill switch exists for.
   */
  it("does not let an action outlive a halt by waiting out its timer", () => {
    const paused = halt("suspected compromise", NOW + 10);
    const check = canExecute({ pending, policy, halt: paused, nowSeconds: NOW + 100_000 });
    expect(check.ready).toBe(false);
    if (!check.ready) expect(check.reason).toContain("do not survive it");
  });

  /**
   * A backwards clock is not permission to execute early. Refusing beats guessing which
   * reading is correct.
   */
  it("refuses rather than guessing when the clock moves backwards", () => {
    const future: PendingAction<string> = { ...pending, queuedAtSeconds: NOW + 10_000 };
    const check = canExecute({ pending: future, policy, halt: running, nowSeconds: NOW });
    expect(check.ready).toBe(false);
  });
});

describe("policy validation", () => {
  it("refuses a zero delay, which is a pause wearing a delay's name", () => {
    const problem = validateDelayPolicy({ delaySeconds: 0 });
    expect(problem).toContain("1h49m");
  });

  it("accepts a real delay", () => {
    expect(validateDelayPolicy({ delaySeconds: 1 })).toBeUndefined();
  });
});

describe("halt and resume", () => {
  it("requires a reason", () => {
    expect(() => halt("  ", NOW)).toThrow(/must state a reason/);
  });

  it("resumes from paused", () => {
    expect(resume(halt("routine", NOW), NOW + 1).status).toBe("running");
  });

  /**
   * A terminal stop must not be reversible from inside the system — the caller may be the
   * thing that went wrong.
   */
  it("refuses to resume from a terminal stop", () => {
    expect(() => resume(halt("key compromise", NOW, true), NOW + 1)).toThrow(
      /never from inside it/,
    );
  });
});

describe("defence layering", () => {
  /**
   * The layer that needs nobody awake must come first. Anything depending on human
   * reaction time loses to a private-mempool drain.
   */
  it("puts the human-independent layer first", () => {
    expect(DEFENCE_LAYERS[0]?.requiresHuman).toBe(false);
    expect(DEFENCE_LAYERS[0]?.layer).toContain("bounds");
  });

  it("ranks pause below the delay window", () => {
    const delay = DEFENCE_LAYERS.findIndex((l) => l.layer.includes("delay"));
    const pause = DEFENCE_LAYERS.findIndex((l) => l.layer === "pause");
    expect(delay).toBeLessThan(pause);
  });

  it("gives every layer a stated reason", () => {
    for (const l of DEFENCE_LAYERS) expect(l.why.length).toBeGreaterThan(30);
  });
});
