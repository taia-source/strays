import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { authorise, emptyState, type SpendPolicy, type SpendState } from "./bounds.js";

/**
 * Properties for spend bounds.
 *
 * The whole value of this module is that a cap holds for inputs nobody imagined — a decimal
 * error produces an amount no example test would think to write. So the domain is swept
 * rather than sampled by hand.
 */

const NOW = 1_800_000_000;
const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

/** Amounts across the whole uint256 range — a decimal error lands anywhere in it. */
const amount = fc.bigInt({ min: 1n, max: (1n << 256n) - 1n });

const policyArb: fc.Arbitrary<SpendPolicy> = fc
  .tuple(
    fc.bigInt({ min: 1n, max: 10n ** 24n }),
    fc.bigInt({ min: 1n, max: 10n ** 24n }),
    fc.integer({ min: 1, max: 86_400 }),
    fc.integer({ min: 1, max: 100 }),
  )
  .map(([a, b, windowSeconds, maxCallsPerWindow]) => ({
    // per-transaction <= per-window, as a rearrangement rather than a dependent generator
    maxPerTransaction: a <= b ? a : b,
    maxPerWindow: a <= b ? b : a,
    windowSeconds,
    maxCallsPerWindow,
    allowedRecipients: new Set([RECIPIENT]),
    allowedTokens: new Set([TOKEN]),
  }));

const stateArb: fc.Arbitrary<SpendState> = fc
  .tuple(fc.bigInt({ min: 0n, max: 10n ** 24n }), fc.nat({ max: 200 }))
  .map(([spentInWindow, countInWindow]) => ({
    spentInWindow,
    countInWindow,
    windowStartSeconds: NOW,
    executedKeys: new Set<string>(),
  }));

describe("spend bound invariants", () => {
  /**
   * The safety property: **an authorised transfer never breaches a cap.** This is the whole
   * contract, asserted over the full uint256 domain rather than the amounts someone pictured.
   */
  it("never authorises anything that exceeds a configured cap", () => {
    fc.assert(
      fc.property(
        policyArb,
        stateArb,
        amount,
        fc.string({ minLength: 1 }),
        (policy, state, amt, key) => {
          const decision = authorise({
            intent: { amount: amt, token: TOKEN, recipient: RECIPIENT, idempotencyKey: key },
            policy,
            state,
            nowSeconds: NOW,
          });
          if (!decision.allowed) return;
          expect(amt).toBeLessThanOrEqual(policy.maxPerTransaction);
          expect(decision.next.spentInWindow).toBeLessThanOrEqual(policy.maxPerWindow);
          expect(decision.next.countInWindow).toBeLessThanOrEqual(policy.maxCallsPerWindow);
        },
      ),
    );
  });

  /**
   * Monotonicity: if an amount is refused, every larger amount is refused too.
   *
   * A comparison written with the wrong operator can pass an exact-value example test and
   * still admit a whole band of over-spends. This catches that without recomputing the cap.
   */
  it("never authorises a larger amount than one it refused", () => {
    fc.assert(
      fc.property(
        policyArb,
        fc.tuple(amount, amount).map(([a, b]) => (a <= b ? ([a, b] as const) : ([b, a] as const))),
        (policy, [smaller, larger]) => {
          const decide = (amt: bigint) =>
            authorise({
              intent: { amount: amt, token: TOKEN, recipient: RECIPIENT, idempotencyKey: "k" },
              policy,
              state: emptyState(NOW),
              nowSeconds: NOW,
            }).allowed;

          fc.pre(!decide(smaller));
          expect(decide(larger), "a larger spend cannot be safer than a smaller one").toBe(false);
        },
      ),
    );
  });

  /**
   * Idempotency keys are consumed exactly once. Without this a retry loop re-executes the
   * same payment — an agent stuck retrying can submit it hundreds of times in seconds.
   */
  it("never authorises the same key twice", () => {
    fc.assert(
      fc.property(policyArb, fc.string({ minLength: 1 }), (policy, key) => {
        const first = authorise({
          intent: { amount: 1n, token: TOKEN, recipient: RECIPIENT, idempotencyKey: key },
          policy,
          state: emptyState(NOW),
          nowSeconds: NOW,
        });
        if (!first.allowed) return;
        const second = authorise({
          intent: { amount: 1n, token: TOKEN, recipient: RECIPIENT, idempotencyKey: key },
          policy,
          state: first.next,
          nowSeconds: NOW,
        });
        expect(second.allowed, "a replayed key must never be authorised twice").toBe(false);
      }),
    );
  });

  /**
   * A sequence can never spend past the window cap however it is interleaved. Single-step
   * invariants can hold while a sequence drifts, and nobody writes the ten-step example.
   */
  it("keeps a whole sequence inside the window cap", () => {
    fc.assert(
      fc.property(
        policyArb,
        fc.array(amount, { minLength: 1, maxLength: 30 }),
        (policy, amounts) => {
          let state = emptyState(NOW);
          amounts.forEach((amt, i) => {
            const decision = authorise({
              intent: { amount: amt, token: TOKEN, recipient: RECIPIENT, idempotencyKey: `k${i}` },
              policy,
              state,
              nowSeconds: NOW,
            });
            if (decision.allowed) state = decision.next;
          });
          expect(state.spentInWindow).toBeLessThanOrEqual(policy.maxPerWindow);
          expect(state.countInWindow).toBeLessThanOrEqual(policy.maxCallsPerWindow);
        },
      ),
    );
  });

  /**
   * The rate-limit boundary, pinned exactly.
   *
   * Sabotage showed the direction properties do NOT catch an off-by-one here: widening the
   * limit by a single call kept all of them green, because they only assert that the count
   * stays under the cap, never where the cap sits. Direction properties catch operator
   * inversions and are structurally blind to fencepost errors — the same lesson the swap
   * ceiling taught.
   *
   * So both sides are asserted: the last permitted call is authorised, and the next one is
   * refused.
   */
  it("permits exactly maxCallsPerWindow calls and refuses the next", () => {
    fc.assert(
      fc.property(policyArb, (policy) => {
        const attempt = (countInWindow: number) =>
          authorise({
            intent: {
              amount: 1n,
              token: TOKEN,
              recipient: RECIPIENT,
              idempotencyKey: `k${countInWindow}`,
            },
            policy,
            state: { ...emptyState(NOW), countInWindow },
            nowSeconds: NOW,
          });

        // The last slot must be usable, or the limit is off by one in the strict direction.
        fc.pre(policy.maxPerWindow >= BigInt(policy.maxCallsPerWindow));
        expect(
          attempt(policy.maxCallsPerWindow - 1).allowed,
          "the final call must be permitted",
        ).toBe(true);
        expect(
          attempt(policy.maxCallsPerWindow).allowed,
          "one past the limit must be refused",
        ).toBe(false);
      }),
    );
  });

  /** An unconfigured allowlist must always fail closed, for every amount. */
  it("always fails closed with no allowlist", () => {
    fc.assert(
      fc.property(policyArb, amount, (policy, amt) => {
        const decision = authorise({
          intent: { amount: amt, token: TOKEN, recipient: RECIPIENT, idempotencyKey: "k" },
          policy: { ...policy, allowedRecipients: new Set() },
          state: emptyState(NOW),
          nowSeconds: NOW,
        });
        expect(decision.allowed).toBe(false);
      }),
    );
  });
});
