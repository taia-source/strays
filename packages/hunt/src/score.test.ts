import { describe, expect, it } from "vitest";
import {
  depthQualityBps,
  momentumQualityBps,
  rankCandidates,
  scoreCandidate,
  type ScoreInput,
  SEED_MARKET_CAP_WEI,
} from "./score.js";

const GAS = 29_474_000n;
const POSITION = 2_500_000_000_000_000n;

function input(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    address: "0xCatDay",
    taxPct: 1,
    positionWei: POSITION,
    gasPriceWei: GAS,
    expectedMoveBps: 900n,
    marketCapWei: 5_000_000_000_000_000_000n,
    volumeAllTimeWei: 1_000_000_000_000_000_000n,
    buyRatioBps: 6500n,
    holders: 120,
    ...overrides,
  };
}

describe("TAX AS A COST TERM — the rebuild's central claim", () => {
  /*
   * ══ THE ARITHMETIC THAT REPLACED `taxPct === 1` ══
   *
   * Measured round trips: 1% = 231bps, 3% = 624bps, 5% = 1008bps, 10% = 1938bps. Each tier is
   * required to clear its OWN bar rather than being admitted or refused by tier.
   */
  it("subtracts each tier's OWN measured cost from the expected move", () => {
    const move = 3000n;
    const costs = [1, 3, 5, 10].map((taxPct) => {
      const s = scoreCandidate(input({ taxPct, expectedMoveBps: move }));
      return { taxPct, costBps: s.costBps, netEdgeBps: s.netEdgeBps };
    });
    // Costs must be monotonically increasing in tax, and match the measured tiers within rounding.
    expect(costs[0]?.costBps).toBeGreaterThan(200n);
    expect(costs[0]?.costBps).toBeLessThan(260n);
    expect(costs[3]?.costBps).toBeGreaterThan(1900n);
    expect(costs[3]?.costBps).toBeLessThan(2100n);
    // Net edge falls as tax rises, on an IDENTICAL move. That is the whole idea.
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]?.netEdgeBps).toBeLessThan(costs[i - 1]?.netEdgeBps ?? 0n);
    }
  });

  it("A 5%-TAX TOKEN THAT MOVES 30% BEATS A 1%-TAX TOKEN THAT MOVES 2%", () => {
    // The objection that overturned the old rule, asserted directly as arithmetic.
    const fiveBig = scoreCandidate(input({ address: "0xFive", taxPct: 5, expectedMoveBps: 3000n }));
    const oneSmall = scoreCandidate(input({ address: "0xOne", taxPct: 1, expectedMoveBps: 200n }));

    expect(fiveBig.netEdgeBps).toBeGreaterThan(oneSmall.netEdgeBps);
    // And the small 1% move does not even cover its own cost, so it is not tradeable at all.
    expect(oneSmall.netEdgeBps).toBeLessThan(0n);
    expect(fiveBig.netEdgeBps).toBeGreaterThan(0n);

    const ranked = rankCandidates([oneSmall, fiveBig]);
    expect(ranked[0]?.address).toBe("0xFive");
  });

  it("a high-tax token whose move does NOT cover its tax scores negative", () => {
    // The other direction — the tax term has to actually bind, or it is decoration.
    const s = scoreCandidate(input({ taxPct: 10, expectedMoveBps: 900n }));
    expect(s.netEdgeBps).toBeLessThan(0n);
  });

  it("cost is subtracted BEFORE the quality multipliers, never after", () => {
    /*
     * The ordering bug this file exists to prevent: if quality were applied to the GROSS move and
     * cost subtracted afterwards, a high-tax token with a big move could outrank a low-tax token
     * that is genuinely more profitable net.
     *
     * Proof: a negative net edge multiplied by any quality in [0,1] must stay negative. If cost
     * were subtracted last, perfect quality would leave the gross move intact and turn positive.
     */
    const s = scoreCandidate(
      input({ taxPct: 10, expectedMoveBps: 900n, buyRatioBps: 7500n, marketCapWei: 50n * SEED_MARKET_CAP_WEI }),
    );
    expect(s.depthBps).toBe(10_000n);
    expect(s.momentumBps).toBe(10_000n);
    expect(s.totalBps).toBeLessThan(0n);
    expect(s.totalBps).toBe(s.netEdgeBps);
  });

  it("a negative edge is passed through UNSCALED — quality may not shrink a loss toward zero", () => {
    /*
     * ══ THIS TEST EXISTS BECAUSE A SABOTAGE ESCAPED ══
     *
     * S47 multiplied a NEGATIVE net edge by the depth quality and the suite stayed green. The
     * test above could not catch it because it used PERFECT quality (10000 = identity), so
     * scaling by it was a no-op. With PARTIAL quality the difference is visible.
     *
     * Why it matters: ranking orders losers too, and a loss scaled toward zero sorts ABOVE an
     * unscaled smaller loss. That inverts the ordering of exactly the candidates we are trying
     * hardest to avoid — a deep, liquid, actively-bought token that cannot cover its tax would
     * outrank a shallow one that also cannot, purely because its quality was better.
     */
    const s = scoreCandidate(
      input({
        taxPct: 10,
        expectedMoveBps: 900n,
        // Partial quality on BOTH axes, so any scaling changes the number.
        buyRatioBps: 5625n,
        marketCapWei: SEED_MARKET_CAP_WEI + SEED_MARKET_CAP_WEI / 4n,
        volumeAllTimeWei: 10n ** 17n,
      }),
    );
    expect(s.netEdgeBps).toBeLessThan(0n);
    expect(s.depthBps).toBeGreaterThan(0n);
    expect(s.depthBps).toBeLessThan(10_000n);
    expect(s.momentumBps).toBeGreaterThan(0n);
    expect(s.momentumBps).toBeLessThan(10_000n);
    // The load-bearing assertion: UNSCALED. Any multiplication would move it toward zero.
    expect(s.totalBps).toBe(s.netEdgeBps);
  });

  it("ranks two unprofitable candidates by TRUE loss, not by quality", () => {
    // The consequence of the above, stated as behaviour: the better-quality loser must not
    // outrank the smaller loser.
    const bigLossGoodQuality = scoreCandidate(
      input({
        address: "0xDeepLoser",
        taxPct: 10,
        expectedMoveBps: 100n,
        buyRatioBps: 7400n,
        marketCapWei: 20n * SEED_MARKET_CAP_WEI,
      }),
    );
    const smallLossPoorQuality = scoreCandidate(
      input({
        address: "0xShallowLoser",
        taxPct: 1,
        expectedMoveBps: 100n,
        buyRatioBps: 5100n,
        marketCapWei: SEED_MARKET_CAP_WEI + 1n,
        volumeAllTimeWei: 1n,
      }),
    );
    expect(bigLossGoodQuality.netEdgeBps).toBeLessThan(smallLossPoorQuality.netEdgeBps);
    expect(rankCandidates([bigLossGoodQuality, smallLossPoorQuality])[0]?.address).toBe(
      "0xShallowLoser",
    );
  });

  it("reports the bar THIS tier must clear, so the log explains the refusal", () => {
    const ten = scoreCandidate(input({ taxPct: 10 }));
    const one = scoreCandidate(input({ taxPct: 1 }));
    // EDGE_MULTIPLE is 2, so the bar is ~2x the round trip: ~3876bps at 10%, ~462bps at 1%.
    expect(ten.requiredBps).toBeGreaterThan(3800n);
    expect(one.requiredBps).toBeGreaterThan(450n);
    expect(one.requiredBps).toBeLessThan(480n);
    expect(ten.arithmetic).toMatch(/tax 10%/);
  });

  it("REFUSES to score at a zero gas price — no default anywhere (RESEARCH §7a)", () => {
    expect(() => scoreCandidate(input({ gasPriceWei: 0n }))).toThrow(/gasPriceWei is REQUIRED/);
  });
});

describe("quality multipliers — they may only DISCOUNT an edge, never create one", () => {
  it("are bounded to [0, 10000] so they cannot inflate an edge", () => {
    // A multiplier above 1.0 would let a quality signal manufacture profit from nothing. The
    // clamp is what makes "the worst a wrong quality model can do is decline a good trade" true.
    const huge = depthQualityBps({
      marketCapWei: 1_000_000n * SEED_MARKET_CAP_WEI,
      volumeAllTimeWei: 10n ** 24n,
      positionWei: POSITION,
    });
    expect(huge).toBe(10_000n);
    expect(momentumQualityBps({ buyRatioBps: 10_000n })).toBe(10_000n);
  });

  it("a positive edge is never increased by quality", () => {
    const s = scoreCandidate(input({ buyRatioBps: 7500n, marketCapWei: 99n * SEED_MARKET_CAP_WEI }));
    expect(s.netEdgeBps).toBeGreaterThan(0n);
    expect(s.totalBps).toBeLessThanOrEqual(s.netEdgeBps);
  });
});

describe("depth quality — MEASURED: market cap above the seed predicts sellability 15/15", () => {
  it("scores ZERO at exactly the seed market cap — 84 of 100 tokens sit there", () => {
    // The pad seeds every launch at 1.356 ETH. At the seed, nobody has bought, and the measured
    // sellable rate at or below it was 1/85.
    expect(
      depthQualityBps({
        marketCapWei: SEED_MARKET_CAP_WEI,
        volumeAllTimeWei: 10n ** 18n,
        positionWei: POSITION,
      }),
    ).toBe(0n);
  });

  it("scores ZERO with no volume, whatever the market cap says", () => {
    // Volume ~0 was sellable 0/47. Market cap alone is not confirmation.
    expect(
      depthQualityBps({
        marketCapWei: 100n * SEED_MARKET_CAP_WEI,
        volumeAllTimeWei: 0n,
        positionWei: POSITION,
      }),
    ).toBe(0n);
  });

  it("takes the WEAKER of the two measurements, not the flattering one", () => {
    // A token with real volume but a seed-level market cap must not score on volume alone —
    // two independent measurements have to agree before depth is credited.
    const volumeOnly = depthQualityBps({
      marketCapWei: SEED_MARKET_CAP_WEI,
      volumeAllTimeWei: 10n ** 19n,
      positionWei: POSITION,
    });
    const capOnly = depthQualityBps({
      marketCapWei: 10n * SEED_MARKET_CAP_WEI,
      volumeAllTimeWei: 0n,
      positionWei: POSITION,
    });
    expect(volumeOnly).toBe(0n);
    expect(capOnly).toBe(0n);
  });

  it("rises with both, and a deeper token outranks a shallower one", () => {
    const shallow = depthQualityBps({
      marketCapWei: SEED_MARKET_CAP_WEI + SEED_MARKET_CAP_WEI / 10n,
      volumeAllTimeWei: 10n ** 17n,
      positionWei: POSITION,
    });
    const deep = depthQualityBps({
      marketCapWei: 5n * SEED_MARKET_CAP_WEI,
      volumeAllTimeWei: 10n ** 19n,
      positionWei: POSITION,
    });
    expect(deep).toBeGreaterThan(shallow);
    expect(shallow).toBeGreaterThan(0n);
  });

  it("returns 0 for a non-positive position rather than dividing by zero", () => {
    expect(
      depthQualityBps({ marketCapWei: 10n ** 19n, volumeAllTimeWei: 10n ** 19n, positionWei: 0n }),
    ).toBe(0n);
  });
});

describe("momentum quality — ASSUMED to predict return, and weighted accordingly", () => {
  it("scores ZERO at or below 50% buys — a token being distributed is not ranked", () => {
    expect(momentumQualityBps({ buyRatioBps: 5000n })).toBe(0n);
    expect(momentumQualityBps({ buyRatioBps: 3300n })).toBe(0n);
  });

  it("rises linearly above 50% and saturates at 75%", () => {
    // Measured buy-ratio range on live tokens was 0.33..0.73, so saturation sits just past it.
    expect(momentumQualityBps({ buyRatioBps: 6250n })).toBe(5000n);
    expect(momentumQualityBps({ buyRatioBps: 7500n })).toBe(10_000n);
    expect(momentumQualityBps({ buyRatioBps: 9000n })).toBe(10_000n);
  });

  it("the MEASURED CASHDOG figure (65% buys) scores in the middle of the range", () => {
    expect(momentumQualityBps({ buyRatioBps: 6500n })).toBe(6000n);
  });
});

describe("rankCandidates — the arithmetic picks the winner, not arrival order", () => {
  it("orders best-first by total score", () => {
    const a = scoreCandidate(input({ address: "0xA", expectedMoveBps: 900n }));
    const b = scoreCandidate(input({ address: "0xB", expectedMoveBps: 5000n }));
    const c = scoreCandidate(input({ address: "0xC", expectedMoveBps: 2000n }));
    expect(rankCandidates([a, b, c]).map((s) => s.address)).toEqual(["0xB", "0xC", "0xA"]);
  });

  it("is INDEPENDENT of input order — the LLM may reorder candidates and cannot change the winner", () => {
    /*
     * DESIGN §5: the model's only reachable influence is the ORDER of candidates. With a score,
     * that influence must be nil. This is the test that keeps it nil.
     */
    const a = scoreCandidate(input({ address: "0xA", expectedMoveBps: 900n }));
    const b = scoreCandidate(input({ address: "0xB", expectedMoveBps: 5000n }));
    const c = scoreCandidate(input({ address: "0xC", expectedMoveBps: 2000n }));
    const forward = rankCandidates([a, b, c]).map((s) => s.address);
    const reversed = rankCandidates([c, b, a]).map((s) => s.address);
    const shuffled = rankCandidates([b, a, c]).map((s) => s.address);
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it("breaks exact ties on ADDRESS, deterministically", () => {
    // Without a tiebreak, sort stability decides the winner and arrival order leaks back in.
    const x = scoreCandidate(input({ address: "0xZZZ" }));
    const y = scoreCandidate(input({ address: "0xAAA" }));
    expect(x.totalBps).toBe(y.totalBps);
    expect(rankCandidates([x, y]).map((s) => s.address)).toEqual(["0xAAA", "0xZZZ"]);
    expect(rankCandidates([y, x]).map((s) => s.address)).toEqual(["0xAAA", "0xZZZ"]);
  });

  it("does not mutate the array it is given", () => {
    const a = scoreCandidate(input({ address: "0xA", expectedMoveBps: 900n }));
    const b = scoreCandidate(input({ address: "0xB", expectedMoveBps: 5000n }));
    const original = [a, b];
    rankCandidates(original);
    expect(original.map((s) => s.address)).toEqual(["0xA", "0xB"]);
  });

  it("handles an empty list without throwing", () => {
    expect(rankCandidates([])).toEqual([]);
  });
});

describe("edge cases that must not silently misbehave", () => {
  it("clamps a negative quality term to zero rather than letting it flip the sign", () => {
    // `momentumQualityBps` cannot go negative through its own arithmetic, but the clamp is the
    // guarantee that no quality term can ever turn a positive edge negative — which would be a
    // quality signal vetoing a trade the cost model approved.
    expect(momentumQualityBps({ buyRatioBps: -1000n })).toBe(0n);
    expect(
      depthQualityBps({ marketCapWei: 0n, volumeAllTimeWei: 0n, positionWei: 1000n }),
    ).toBe(0n);
  });

  it("orders equal scores from DIFFERENT addresses both ways round the tiebreak", () => {
    // Exercises both branches of the address comparator, so neither direction is assumed.
    const a = scoreCandidate(input({ address: "0xAAA" }));
    const b = scoreCandidate(input({ address: "0xBBB" }));
    expect(rankCandidates([a, b])[0]?.address).toBe("0xAAA");
    expect(rankCandidates([b, a])[0]?.address).toBe("0xAAA");
    // And an identical address compares equal rather than throwing or reordering.
    expect(rankCandidates([a, a]).length).toBe(2);
  });
});
