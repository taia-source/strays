import { describe, expect, it } from "vitest";
import {
  authorise,
  type Decision,
  emptyState,
  formatDecision,
  type SpendPolicy,
  STATE_COMMIT_RULE,
} from "./bounds.js";

const NOW = 1_800_000_000;
const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const policy: SpendPolicy = {
  maxPerTransaction: 100n,
  maxPerWindow: 500n,
  windowSeconds: 3600,
  maxCallsPerWindow: 5,
  allowedRecipients: new Set([RECIPIENT]),
  allowedTokens: new Set([TOKEN]),
};

const intent = (over: Partial<Parameters<typeof authorise>[0]["intent"]> = {}) => ({
  amount: 10n,
  token: TOKEN,
  recipient: RECIPIENT,
  idempotencyKey: "op-1",
  ...over,
});

const denied = (d: Decision) => (d.allowed ? [] : d.denials.map((x) => x.reason));

describe("spend bounds", () => {
  it("authorises a transfer inside every bound", () => {
    const decision = authorise({
      intent: intent(),
      policy,
      state: emptyState(NOW),
      nowSeconds: NOW,
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.next.spentInWindow).toBe(10n);
      expect(decision.next.countInWindow).toBe(1);
    }
  });

  /**
   * The bound that would have stopped the largest confirmed agent loss.
   *
   * Lobstar Wilde meant to send ~4 SOL and sent 5% of total supply on a decimal error. No
   * detection layer flags that — the agent believed it was correct — but a ceiling refuses it.
   */
  it("refuses a decimal-error-sized transfer", () => {
    const decision = authorise({
      intent: intent({ amount: 100_000_000n }),
      policy,
      state: emptyState(NOW),
      nowSeconds: NOW,
    });
    expect(denied(decision)).toContain("per-transaction-cap");
    expect(formatDecision(decision)).toContain("decimal error until proven otherwise");
  });

  it("refuses a recipient the agent was told about by an outsider", () => {
    const decision = authorise({
      intent: intent({ recipient: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
      policy,
      state: emptyState(NOW),
      nowSeconds: NOW,
    });
    expect(denied(decision)).toContain("recipient-not-allowed");
  });

  /**
   * An unconfigured allowlist must HALT, not allow everything. A missing config becoming
   * an unbounded agent is the failure this direction of default prevents.
   */
  it("fails closed when no allowlist is configured", () => {
    const decision = authorise({
      intent: intent(),
      policy: { ...policy, allowedRecipients: new Set() },
      state: emptyState(NOW),
      nowSeconds: NOW,
    });
    expect(denied(decision)).toContain("no-allowlist");
  });

  it("refuses a duplicate idempotency key", () => {
    const state = { ...emptyState(NOW), executedKeys: new Set(["op-1"]) };
    expect(denied(authorise({ intent: intent(), policy, state, nowSeconds: NOW }))).toContain(
      "duplicate",
    );
  });

  it("refuses an intent with no idempotency key at all", () => {
    const decision = authorise({
      intent: intent({ idempotencyKey: "  " }),
      policy,
      state: emptyState(NOW),
      nowSeconds: NOW,
    });
    expect(denied(decision)).toContain("malformed");
  });

  /**
   * A count limit catches what value caps cannot: a retry storm of small transfers that
   * stays under every value ceiling while making hundreds of calls.
   */
  it("rate-limits by call count even when every transfer is tiny", () => {
    const state = { ...emptyState(NOW), countInWindow: 5, spentInWindow: 5n };
    const decision = authorise({
      intent: intent({ amount: 1n, idempotencyKey: "op-6" }),
      policy,
      state,
      nowSeconds: NOW,
    });
    expect(denied(decision)).toContain("rate-limit");
  });

  it("refuses when the window total would be exceeded", () => {
    const state = { ...emptyState(NOW), spentInWindow: 495n, countInWindow: 1 };
    const decision = authorise({
      intent: intent({ amount: 10n, idempotencyKey: "op-2" }),
      policy,
      state,
      nowSeconds: NOW,
    });
    expect(denied(decision)).toContain("window-cap");
  });

  it("resets the window once it has elapsed", () => {
    const state = { ...emptyState(NOW), spentInWindow: 500n, countInWindow: 5 };
    const decision = authorise({
      intent: intent({ idempotencyKey: "op-later" }),
      policy,
      state,
      nowSeconds: NOW + 3601,
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.next.spentInWindow).toBe(10n);
  });

  /**
   * A caller must not be able to un-spend by presenting an earlier clock. The window
   * resets forward only.
   */
  it("does not reset the window when the clock moves backwards", () => {
    const state = { ...emptyState(NOW), spentInWindow: 495n, countInWindow: 1 };
    const decision = authorise({
      intent: intent({ amount: 10n, idempotencyKey: "op-2" }),
      policy,
      state,
      nowSeconds: NOW - 10_000,
    });
    expect(denied(decision)).toContain("window-cap");
  });

  it("reports every bound exceeded, not just the first", () => {
    const decision = authorise({
      intent: intent({
        amount: 100_000n,
        recipient: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        token: "0x0000000000000000000000000000000000000001",
        idempotencyKey: "",
      }),
      policy,
      state: emptyState(NOW),
      nowSeconds: NOW,
    });
    // Correcting one at a time IS the retry storm these bounds exist to stop.
    expect(denied(decision).length).toBeGreaterThanOrEqual(4);
  });

  it("refuses a zero or negative amount", () => {
    expect(
      denied(
        authorise({
          intent: intent({ amount: 0n }),
          policy,
          state: emptyState(NOW),
          nowSeconds: NOW,
        }),
      ),
    ).toContain("malformed");
  });

  it("states the commit-before-signing rule, which is the documented race", () => {
    expect(STATE_COMMIT_RULE).toContain("BEFORE signing");
    expect(STATE_COMMIT_RULE).toContain("time-of-check");
  });
});
