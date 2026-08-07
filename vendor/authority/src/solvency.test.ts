import { describe, expect, it } from "vitest";
import { judgeGasPriceCap, judgeReimbursement, judgeSolvency } from "./solvency.js";

/**
 * ══ The numbers here are measured, from three shipped bugs ══
 *
 * `ponsball` B14/B15/B16. Every one drained a funded wallet while every spend cap passed,
 * because each individual spend was small, legitimate and well inside every bound.
 *
 *   gas cost per beat        ~0.00003 ETH   =  30_000_000_000_000 wei
 *   refund cap (20% of burn) ~0.00000034 ETH =    340_000_000_000 wei
 *   measured net loss        0.000082 ETH over ONE beat
 *   basefee multiple cap     3x — the fix, because a keeper controls tx.gasprice and not
 *                            block.basefee
 */

const GAS_PER_BEAT = 30_000_000_000_000n;
const CAPPED_REFUND = 340_000_000_000n;
const LOSS_PER_BEAT = 82_000_000_000_000n;

describe("a keeper that is quietly draining", () => {
  /**
   * ══ B14, with its real numbers ══
   *
   * The keeper lost 0.000082 ETH in one beat. Every spend cap passed: a single beat's gas
   * is tiny, well under any per-transaction bound, and the window totals stay small too.
   * Only the balance shows it.
   */
  it("catches the measured loss that every spend cap allowed", () => {
    const verdict = judgeSolvency({
      first: { wei: 10n ** 18n, atSecond: 0 },
      latest: { wei: 10n ** 18n - LOSS_PER_BEAT, atSecond: 60 },
      toleranceWei: 10_000_000_000_000n,
      reserveWei: 10n ** 16n,
    });

    expect(verdict.ok, "a draining keeper was reported healthy").toBe(false);
    expect(verdict.ok || verdict.failure).toBe("draining");
    // The detail must name the cause, or the next person re-derives it from three bugs.
    expect(verdict.ok || verdict.detail).toContain("every spend cap passed");
  });

  it("accepts a balance that held", () => {
    const verdict = judgeSolvency({
      first: { wei: 10n ** 18n, atSecond: 0 },
      latest: { wei: 10n ** 18n, atSecond: 3600 },
      toleranceWei: 1n,
      reserveWei: 10n ** 16n,
    });
    expect(verdict.ok, verdict.ok ? "" : verdict.detail).toBe(true);
  });

  /** B15's fix was verified exactly this way: "keeper balance unchanged" across a claim. */
  it("accepts a balance that grew", () => {
    const verdict = judgeSolvency({
      first: { wei: 10n ** 18n, atSecond: 0 },
      latest: { wei: 10n ** 18n + 5n, atSecond: 60 },
      toleranceWei: 0n,
      reserveWei: 0n,
    });
    expect(verdict.ok).toBe(true);
  });

  it("accepts a fall inside tolerance", () => {
    const verdict = judgeSolvency({
      first: { wei: 1000n, atSecond: 0 },
      latest: { wei: 990n, atSecond: 60 },
      toleranceWei: 10n,
      reserveWei: 0n,
    });
    expect(verdict.ok).toBe(true);
  });

  it("catches a fall one wei past tolerance", () => {
    const verdict = judgeSolvency({
      first: { wei: 1000n, atSecond: 0 },
      latest: { wei: 989n, atSecond: 60 },
      toleranceWei: 10n,
      reserveWei: 0n,
    });
    expect(verdict.ok).toBe(false);
  });

  /**
   * ══ The reserve is checked independently of the trend ══
   *
   * A keeper already too low to send a transaction is broken NOW, whether or not it is
   * still falling. Without this, a flat balance at zero reads as perfectly healthy.
   */
  it("catches a keeper below its reserve even when the balance is flat", () => {
    const verdict = judgeSolvency({
      first: { wei: 5n, atSecond: 0 },
      latest: { wei: 5n, atSecond: 3600 },
      toleranceWei: 10n ** 18n,
      reserveWei: 10n ** 16n,
    });

    expect(verdict.ok, "a keeper that cannot pay for gas was reported healthy").toBe(false);
    expect(verdict.ok || verdict.failure).toBe("below-reserve");
  });

  /** Two readings from the same instant say nothing about a trend. */
  it.each([
    [0, 0],
    [60, 30],
  ])("refuses to conclude from readings at %i and %i", (firstAt, latestAt) => {
    const verdict = judgeSolvency({
      first: { wei: 100n, atSecond: firstAt },
      latest: { wei: 1n, atSecond: latestAt },
      toleranceWei: 0n,
      reserveWei: 0n,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok || verdict.failure).toBe("not-measurable");
  });
});

describe("a reimbursement that covered almost nothing", () => {
  /**
   * ══ B14 exactly ══
   *
   * Gas cost 0.00003 ETH; the cap allowed 0.00000034 ETH back. That is 113 bps — about 1%.
   */
  it("catches the measured 1% refund", () => {
    const verdict = judgeReimbursement({
      gasSpentWei: GAS_PER_BEAT,
      refundedWei: CAPPED_REFUND,
      minCoverageBps: 9_000,
    });

    expect(verdict.ok, "a refund covering ~1% of gas was accepted").toBe(false);
    expect(verdict.ok || verdict.failure).toBe("draining");
    // Naming the WRONG SHAPE matters more than the number: the cap was a fraction of the
    // work's own value, which cannot bound the gas that work cost.
    expect(verdict.ok || verdict.detail).toContain("FRACTION OF THE WORK");
  });

  it("accepts a refund that covered the gas", () => {
    const verdict = judgeReimbursement({
      gasSpentWei: GAS_PER_BEAT,
      refundedWei: GAS_PER_BEAT,
      minCoverageBps: 9_000,
    });
    expect(verdict.ok).toBe(true);
  });

  it("accepts an over-refund, which is not a drain", () => {
    const verdict = judgeReimbursement({
      gasSpentWei: 100n,
      refundedWei: 150n,
      minCoverageBps: 10_000,
    });
    expect(verdict.ok).toBe(true);
  });

  /**
   * Multiply before dividing. At wei scale the reverse rounds every ratio to zero, and a
   * refund of NOTHING would then satisfy any threshold.
   */
  it("does not round a real coverage ratio to zero", () => {
    const verdict = judgeReimbursement({
      gasSpentWei: 30_000_000_000_000n,
      refundedWei: 29_000_000_000_000n,
      minCoverageBps: 9_000,
    });
    expect(verdict.ok, "divide-first would report 0 bps here").toBe(true);
  });

  it("treats zero gas as nothing to reimburse", () => {
    expect(
      judgeReimbursement({ gasSpentWei: 0n, refundedWei: 0n, minCoverageBps: 10_000 }).ok,
    ).toBe(true);
  });

  it("catches a refund of exactly nothing", () => {
    const verdict = judgeReimbursement({
      gasSpentWei: GAS_PER_BEAT,
      refundedWei: 0n,
      minCoverageBps: 1,
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("the gas price cap", () => {
  /**
   * ══ Why a basefee multiple, and not a fixed ceiling ══
   *
   * A keeper sets `tx.gasprice` and cannot set `block.basefee`, so a multiple of basefee is
   * the only bound it cannot inflate its way around. `ponsball` used 3x after removing the
   * fraction-of-spend cap that did not work.
   */
  it("catches a gas price above the basefee multiple", () => {
    const verdict = judgeGasPriceCap({
      gasPriceWei: 400_000_000n,
      baseFeeWei: 58_000_000n,
      maxMultiple: 3,
    });
    expect(verdict.ok, "a keeper could inflate its own refund").toBe(false);
    expect(verdict.ok || verdict.failure).toBe("draining");
  });

  /** ponsball's measured basefee: ~0.058 gwei. */
  it("accepts a gas price at the real measured basefee", () => {
    const verdict = judgeGasPriceCap({
      gasPriceWei: 58_000_000n,
      baseFeeWei: 58_000_000n,
      maxMultiple: 3,
    });
    expect(verdict.ok).toBe(true);
  });

  it("accepts a price exactly at the ceiling", () => {
    const verdict = judgeGasPriceCap({
      gasPriceWei: 174_000_000n,
      baseFeeWei: 58_000_000n,
      maxMultiple: 3,
    });
    expect(verdict.ok).toBe(true);
  });

  it("catches a price one wei past the ceiling", () => {
    const verdict = judgeGasPriceCap({
      gasPriceWei: 174_000_001n,
      baseFeeWei: 58_000_000n,
      maxMultiple: 3,
    });
    expect(verdict.ok).toBe(false);
  });

  /** A zero basefee gives no bound, so the cap would be unenforceable rather than generous. */
  it("refuses to enforce a cap against a zero basefee", () => {
    const verdict = judgeGasPriceCap({ gasPriceWei: 1n, baseFeeWei: 0n, maxMultiple: 3 });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok || verdict.failure).toBe("not-measurable");
  });
});
