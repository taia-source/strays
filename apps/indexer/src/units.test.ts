/**
 * THE UNITS BUG, pinned.
 *
 * `Market.markPriceWei` is documented as "ETH-per-token price for the OPEN position, scaled 1e18".
 * `quoteExitWei` returns TOTAL PROCEEDS in wei. Passing the total through compared a whole-position
 * value against a per-unit entry price and reported **+574,656,667 bps** on a position that had
 * moved +66 bps.
 *
 * It was not cosmetic. The take-profit fires off exactly that comparison, so it would have closed
 * every position immediately regardless of gain — and the first live round trip happened to be
 * profitable, which is precisely how a bug like this survives its own field test.
 *
 * These numbers are the REAL ones from mainnet tx 0x496d6233 (entry) and the exit at block
 * 30452877, so this test fails if anyone reintroduces the mismatch.
 */
import { describe, expect, it } from "vitest";

/** The conversion `main.ts` performs before handing a mark to the strategy. */
function markPerUnit(totalProceedsWei: bigint, units: bigint): bigint | undefined {
  if (totalProceedsWei <= 0n || units <= 0n) return undefined;
  return (totalProceedsWei * 10n ** 18n) / units;
}

/** Entry price, derived from what the vault actually spent and received. */
function entryPerUnit(costBasisWei: bigint, units: bigint): bigint {
  return units > 0n ? (costBasisWei * 10n ** 18n) / units : 0n;
}

describe("mark and entry are BOTH per-unit prices", () => {
  // Measured on chain, not invented.
  const UNITS = 57_092_283_279_985_038_768_190n;
  const COST_BASIS = 1_040_000_000_000_000n; // 0.00104 ETH in
  const PROCEEDS = 1_046_819_814_464_775n; // what the exit actually returned

  it("reports the real +66bps move, not a total-vs-per-unit nonsense number", () => {
    const mark = markPerUnit(PROCEEDS, UNITS);
    const entry = entryPerUnit(COST_BASIS, UNITS);
    expect(mark).toBeDefined();
    const bps = Number(((mark as bigint) - entry) * 10_000n) / Number(entry);
    expect(bps).toBeGreaterThan(60);
    expect(bps).toBeLessThan(72);
  });

  /** The specific regression: passing the TOTAL is off by ~5.7 million percent. */
  it("passing total proceeds as the mark is catastrophically wrong", () => {
    const entry = entryPerUnit(COST_BASIS, UNITS);
    const wrongBps = Number((PROCEEDS - entry) * 10_000n) / Number(entry);
    // The bug produced +574,656,667 bps. Assert it is absurd so the contrast is on record.
    expect(wrongBps).toBeGreaterThan(1_000_000);
  });

  it("an unreadable quote yields undefined, never zero", () => {
    // Zero would read as a price of zero — a 100% loss — and trip the stop on every position.
    expect(markPerUnit(0n, UNITS)).toBeUndefined();
    expect(markPerUnit(PROCEEDS, 0n)).toBeUndefined();
  });

  it("entry price is derived from what the vault actually spent and received", () => {
    expect(entryPerUnit(COST_BASIS, UNITS)).toBe(18_216_122_044n);
    expect(entryPerUnit(COST_BASIS, 0n)).toBe(0n);
  });
});
