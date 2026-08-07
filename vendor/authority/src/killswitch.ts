/**
 * Stopping an agent that is already running.
 *
 * ══ Why a pause button is not a kill switch ══
 *
 * The instinct is a `pause()` a human presses. The incident record says that loses.
 *
 * Gnosis Pay, 2026-06-01: ~$1.8M across 5,281 wallets. Their response was **world-class** —
 * unauthorized transfer detected at 06:17 UTC, root cause identified at 08:06, **1h49m**.
 * The attacker had the entire window regardless. And modern drains route through **private
 * mempools**, so there is no pending transaction to notice in the first place.
 *
 * A human-in-the-loop pause loses by construction. Whatever the reaction time, the drain is
 * one transaction and the response is a human waking up.
 *
 * ══ What actually works ══
 *
 * Three things, in order of how much they depend on someone being awake:
 *
 *   1. **A pre-committed bound** (`bounds.ts`) — needs nobody. It is a loss ceiling.
 *   2. **A delay window** — the agent enqueues; execution waits; a human may veto during
 *      the wait. This *inverts* the race: no reaction speed is required at drain time,
 *      only within the window. Zodiac's Delay Modifier is the on-chain form.
 *   3. **A pause** — useful, but last, and only for what the first two did not bound.
 *
 * A delay is strictly better than a pause for the same human attention, because the human
 * acts *before* the money moves rather than after.
 *
 * ══ The uncomfortable part ══
 *
 * Zodiac Roles v2 and Delay v1.1.0 — the two most-recommended agent-constraint modules —
 * carried a critical ERC-1271 bug from **2023-10-30 to 2026-06-01**, through audits. The
 * verification discarded the success flag of a `staticcall`, so a contract that reverted
 * while returning the magic value produced a forged approval.
 *
 * **Your enforcement layer is itself attack surface.** That is the argument for keeping this
 * module boring: no policy DSL, no expressive conditions, nothing that needs its own audit.
 * Expressiveness cost Gnosis $1.8M.
 */

export type AgentStatus = "running" | "paused" | "stopped";

export type Halt = {
  readonly status: AgentStatus;
  /** Why, recorded so a resume is a decision rather than a reflex. */
  readonly reason: string;
  readonly atSeconds: number;
};

/** A transfer waiting out its delay window. */
export type PendingAction<T> = {
  readonly id: string;
  readonly action: T;
  readonly queuedAtSeconds: number;
  /** Set when a human refuses it during the window. */
  readonly vetoedReason?: string | undefined;
};

export type DelayPolicy = {
  /**
   * How long an action waits before it may execute.
   *
   * The trade is explicit: a longer window gives humans more time to veto and makes the
   * agent less responsive. Zero is not permitted — a delay of zero is a pause, and a pause
   * is the thing that loses the race.
   */
  readonly delaySeconds: number;
};

export type ExecuteCheck =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string; readonly waitSeconds?: number };

/**
 * Whether a queued action may now execute.
 *
 * Four conditions, and the ordering matters: a veto or a halt must dominate the timer, or
 * an action queued before the halt would sail through once its window elapsed — which is
 * precisely the case a kill switch exists for.
 */
export function canExecute<T>(options: {
  readonly pending: PendingAction<T>;
  readonly policy: DelayPolicy;
  readonly halt: Halt;
  readonly nowSeconds: number;
}): ExecuteCheck {
  const { pending, policy, halt, nowSeconds } = options;

  if (pending.vetoedReason !== undefined) {
    return { ready: false, reason: `vetoed: ${pending.vetoedReason}` };
  }

  // Checked BEFORE the timer. An action queued while running must not execute after a
  // halt merely because its window elapsed.
  if (halt.status !== "running") {
    return {
      ready: false,
      reason: `the agent is ${halt.status}: ${halt.reason}. Actions queued before a halt do not survive it`,
    };
  }

  const elapsed = nowSeconds - pending.queuedAtSeconds;
  if (elapsed < policy.delaySeconds) {
    return {
      ready: false,
      reason: `still inside the ${policy.delaySeconds}s veto window`,
      waitSeconds: policy.delaySeconds - elapsed,
    };
  }

  // A clock that went backwards is not a reason to execute early. Treat it as unresolved
  // rather than guessing which reading is right.
  if (elapsed < 0) {
    return {
      ready: false,
      reason: `queued at ${pending.queuedAtSeconds} but now is ${nowSeconds} — the clock moved backwards, refusing rather than guessing`,
    };
  }

  return { ready: true };
}

export function validateDelayPolicy(policy: DelayPolicy): string | undefined {
  if (policy.delaySeconds <= 0) {
    return (
      "a delay of zero is a pause, not a delay. A pause requires a human to react faster " +
      "than a drain — Gnosis Pay identified their root cause in 1h49m, which was world-class " +
      "and still far too slow. A delay inverts that race by letting the human act BEFORE the " +
      "money moves"
    );
  }
  return undefined;
}

/**
 * Stop the agent.
 *
 * `stopped` is deliberately terminal here: `resume` refuses it. Reversing a stop should
 * require whatever process created the agent, not a function call from inside the system
 * that may itself be compromised.
 */
export function halt(reason: string, nowSeconds: number, terminal = false): Halt {
  if (!reason.trim()) {
    throw new Error("a halt must state a reason — a silent stop is indistinguishable from a bug");
  }
  return { status: terminal ? "stopped" : "paused", reason, atSeconds: nowSeconds };
}

export function resume(current: Halt, nowSeconds: number): Halt {
  if (current.status === "stopped") {
    throw new Error(
      `refusing to resume from "stopped" (${current.reason}). A terminal stop is reversed by ` +
        "the process that provisioned the agent, never from inside it — the caller may be the " +
        "thing that went wrong",
    );
  }
  return { status: "running", reason: "resumed", atSeconds: nowSeconds };
}

/**
 * The layering, stated so it is not rediscovered under pressure.
 *
 * Ordered by how much each depends on a human being awake. Anything relying on human
 * reaction time is last, because the evidence says that race is unwinnable.
 */
export const DEFENCE_LAYERS: ReadonlyArray<{
  readonly layer: string;
  readonly requiresHuman: boolean;
  readonly why: string;
}> = [
  {
    layer: "pre-committed bounds",
    requiresHuman: false,
    why: "a loss ceiling that holds while everyone is asleep. Catches both injection and a decimal error",
  },
  {
    layer: "delay window with veto",
    requiresHuman: true,
    why: "inverts the race — the human acts before the money moves, so no reaction speed is needed at drain time",
  },
  {
    layer: "pause",
    requiresHuman: true,
    why: "last resort. Loses to a private-mempool drain, which has no pending transaction to observe",
  },
  {
    layer: "monitoring and alerting",
    requiresHuman: true,
    why: "Gnosis Pay was detected by external monitoring, not by the contract. Budget for it as a component, not an afterthought",
  },
];
