import { describe, expect, it } from "vitest";
import {
  type AgeConfig,
  DEFAULT_AGE,
  ENTRY_SWAP_INDEX,
  MAX_ENTRY_SWAP_INDEX,
  MEASURED_MEDIAN_NET_BPS,
  measuredMedianNetBps,
  withinEntryWindow,
} from "./age.js";

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE EVIDENCE THIS FILE PINS, AND THE HYPOTHESIS IT REFUSES TO OVERSELL ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * RESULTS §10.4 / STATE.md ROUND 4, measured on held-out tokens — tokens that launched later than
 * every token used to choose the rule:
 *
 *     entry at swap    5      10      20      50     100     200     500
 *     median net   +9,791  +5,838  +4,410    +696    −845  −1,748  −3,302
 *
 * Monotone, crossing zero between swap 50 and 100. Swaps 200 and 500 were NEVER in the search
 * space. A single threshold that works is what a search over five values produces by chance; a
 * monotone gradient is much harder to produce by chance, and that ordering is the strongest single
 * piece of evidence in four rounds.
 *
 * **What it is not:** `assessOverfitting` at 183 cumulative trials returns `credible: false`.
 * n=72, a 1.74-day median held-out span, a cost model incomplete in the OPTIMISTIC direction, and
 * a Welch t against matched random of 2.30–2.69 that clears t>3 on ZERO of 20 seeds. These tests
 * assert that the code SAYS so, because a comment that oversells is a comment that will be trusted.
 */

describe("the measured dose-response — the ordering is the evidence", () => {
  it("is MONOTONE DECREASING across all seven doses", () => {
    // The claim in one assertion. If a future edit retunes any entry in the table so the ordering
    // breaks, the argument that justifies the whole strategy no longer holds and this goes red.
    for (let i = 1; i < MEASURED_MEDIAN_NET_BPS.length; i++) {
      const prev = MEASURED_MEDIAN_NET_BPS[i - 1];
      const here = MEASURED_MEDIAN_NET_BPS[i];
      if (prev === undefined || here === undefined) throw new Error("unreachable");
      expect(here[0], "doses must be ordered by swap index").toBeGreaterThan(prev[0]);
      expect(here[1], `median at swap ${String(here[0])} must be below swap ${String(prev[0])}`)
        .toBeLessThan(prev[1]);
    }
  });

  it("crosses zero between swap 50 and swap 100 — which is where the ceiling sits", () => {
    expect(measuredMedianNetBps(50)).toBeGreaterThan(0n);
    expect(measuredMedianNetBps(100)).toBeLessThan(0n);
    expect(MAX_ENTRY_SWAP_INDEX).toBe(50);
  });

  it("holds the measured numbers, not round ones", () => {
    expect(measuredMedianNetBps(5)).toBe(9791n);
    expect(measuredMedianNetBps(20)).toBe(4410n);
    expect(measuredMedianNetBps(500)).toBe(-3302n);
  });

  it("includes the two doses that were NEVER in the search space", () => {
    // 200 and 500 are out-of-sample confirmation of the ORDERING rather than of a level, and they
    // are the reason this is reported as a gradient rather than as a tuned threshold.
    const doses = MEASURED_MEDIAN_NET_BPS.map(([d]) => d);
    expect(doses).toContain(200);
    expect(doses).toContain(500);
  });

  it("EVERY dose inside the shipped window has a POSITIVE median", () => {
    // The window is not allowed to admit a dose the measurement says loses money.
    for (const [dose, median] of MEASURED_MEDIAN_NET_BPS) {
      if (dose >= ENTRY_SWAP_INDEX && dose <= MAX_ENTRY_SWAP_INDEX) {
        expect(median, `swap ${String(dose)} is inside the window and must be positive`)
          .toBeGreaterThan(0n);
      }
    }
  });

  it("the shipped entry dose's median dwarfs the round trip — §10.7's whole point", () => {
    // "The toll never was the binding constraint. The holding period was." 208bps is 4.7% of
    // +4,410bps; the refuted momentum family had +145bps of edge against the same 208.
    const roundTripBps = 208n;
    expect(measuredMedianNetBps(ENTRY_SWAP_INDEX)).toBeGreaterThan(roundTripBps * 20n);
  });
});

describe("measuredMedianNetBps — which dose a token is priced at", () => {
  it("uses the nearest measured dose AT OR BELOW the swap count", () => {
    expect(measuredMedianNetBps(20)).toBe(4410n);
    expect(measuredMedianNetBps(34)).toBe(4410n); // rounds DOWN to swap 20, not up to 50
    expect(measuredMedianNetBps(49)).toBe(4410n);
    expect(measuredMedianNetBps(50)).toBe(696n);
  });

  it("prices anything below the earliest dose at that dose", () => {
    expect(measuredMedianNetBps(0)).toBe(9791n);
    expect(measuredMedianNetBps(4)).toBe(9791n);
  });

  it("prices anything past the last dose at that dose, which is NEGATIVE", () => {
    // It will fail the cost bar, correctly — though `withinEntryWindow` has already refused it.
    expect(measuredMedianNetBps(10_000)).toBe(-3302n);
    expect(measuredMedianNetBps(10_000)).toBeLessThan(0n);
  });

  it("is a MEDIAN, not the mean — the mean at swap 20 is +37,727bps", () => {
    // §10.4: the top 1% of positions carry 31.9% of all profit. Sizing a bar against the mean
    // would be sizing it against a tail we have no reason to expect on any particular ticket.
    expect(measuredMedianNetBps(20)).toBeLessThan(37_727n / 5n);
  });
});

describe("withinEntryWindow — the entry gate, indexed by SWAPS not by seconds", () => {
  it("ADMITS a token at exactly the entry dose — the boundary is inclusive", () => {
    const v = withinEntryWindow(ENTRY_SWAP_INDEX);
    expect(v.inWindow).toBe(true);
    expect(v.swapCount).toBe(ENTRY_SWAP_INDEX);
  });

  it("ADMITS everything inside the window, including the ceiling", () => {
    for (const n of [20, 21, 35, 49, 50]) {
      expect(withinEntryWindow(n).inWindow, `swap ${String(n)}`).toBe(true);
    }
  });

  it("REFUSES one swap too early, and says the earlier dose measured BETTER", () => {
    /*
     * The honest refusal. Swap 5 has a +9,791bps median against swap 20's +4,410, so "too early"
     * is not a claim that earlier is worse — it is a claim about SELLABILITY: 68 of 72 held-out
     * tokens pass `sellableBefore` at swap 20, and that has not been measured earlier.
     * `RESEARCH-PROFITABLE-AGENTS.md` §9 names this overlap as the strategy's kill condition.
     */
    const v = withinEntryWindow(ENTRY_SWAP_INDEX - 1);
    expect(v.inWindow).toBe(false);
    expect(v.reason).toMatch(/19 realised swaps < the 20-swap entry point/);
    expect(v.reason).toMatch(/\+9,791bps median at swap 5/);
    expect(v.reason).toMatch(/sell-simulation gate|cannot exit|absorbed a sell/);
  });

  it("REFUSES one swap too late, and names the sign change", () => {
    const v = withinEntryWindow(MAX_ENTRY_SWAP_INDEX + 1);
    expect(v.inWindow).toBe(false);
    expect(v.reason).toMatch(/51 realised swaps > the 50-swap ceiling/);
    expect(v.reason).toMatch(/crosses zero between/);
    expect(v.reason).toMatch(/GRADIENT, not a threshold/);
  });

  it("REFUSES the far-out doses that confirm the gradient", () => {
    for (const n of [100, 200, 500, 5000]) {
      expect(withinEntryWindow(n).inWindow, `swap ${String(n)}`).toBe(false);
    }
  });

  it("REFUSES a failed read rather than treating it as swap 0", () => {
    // Swap 0 is the earliest and most attractive dose, so coercing a failed read to it would make
    // every unreadable token look maximally attractive — the worst possible default.
    for (const bad of [-1, 1.5, Number.NaN, undefined as unknown as number]) {
      const v = withinEntryWindow(bad);
      expect(v.inWindow, String(bad)).toBe(false);
      expect(v.reason).toMatch(/not a count of realised swaps/);
    }
  });

  it("the admission reason states the evidence AND the caveat, in the same sentence", () => {
    /*
     * The requirement that this file will not soften. §10.6 says `credible: false` at 183
     * cumulative trials, and a log line that reports +4,410bps without that is a log line an
     * operator will read as a promise.
     */
    const v = withinEntryWindow(ENTRY_SWAP_INDEX);
    expect(v.reason).toMatch(/\+4,410bps/);
    expect(v.reason).toMatch(/OUT-OF-SAMPLE POSITIVE, NOT PROVEN/);
    expect(v.reason).toMatch(/credible:false/);
    expect(v.reason).toMatch(/183 cumulative trials/);
    expect(v.reason).toMatch(/incomplete in the\s+optimistic direction|optimistic direction/);
    // It must NOT claim significance it does not have.
    expect(v.reason).not.toMatch(/proven strategy|statistically significant/i);
  });
});

describe("the window is CONFIG, because a constant decide() reads cannot be swept", () => {
  it("defaults to swaps 20 through 50", () => {
    expect(DEFAULT_AGE.entrySwapIndex).toBe(20);
    expect(DEFAULT_AGE.maxEntrySwapIndex).toBe(50);
    expect(ENTRY_SWAP_INDEX).toBe(20);
  });

  it("honours a different window, so the dose-response can be re-run against the real rule", () => {
    // §10.1's mechanical finding: three backtest rounds never tested this family because
    // `replay.ts` drives the real `decide()` and `decide()` had "no notion of enter at swap N of a
    // token's life". The search space was bounded by the harness, not by the evidence.
    const early: AgeConfig = { entrySwapIndex: 5, maxEntrySwapIndex: 10 };
    expect(withinEntryWindow(5, early).inWindow).toBe(true);
    expect(withinEntryWindow(20, early).inWindow).toBe(false);
  });

  it("REFUSES an empty window — a gate nothing can pass is a broken strategy", () => {
    // DESIGN, on the cost bar: "a bar nothing can clear is indistinguishable from a broken
    // strategy; a bar everything clears is not a bar." The same test, applied here.
    expect(() => withinEntryWindow(20, { entrySwapIndex: 50, maxEntrySwapIndex: 20 })).toThrow(
      /the window\s+is empty|window is empty/,
    );
  });

  it("REFUSES a nonsensical bound rather than silently clamping it", () => {
    expect(() => withinEntryWindow(20, { entrySwapIndex: -1, maxEntrySwapIndex: 50 })).toThrow(
      /non-negative integer/,
    );
    expect(() => withinEntryWindow(20, { entrySwapIndex: 2.5, maxEntrySwapIndex: 50 })).toThrow();
  });
});

describe("purity", () => {
  it("reads no clock — the gate is a count, and the count arrives as data", () => {
    // The substantive difference from `eligible.ts`'s `minAgeSeconds`: that asks how long a token
    // has EXISTED, this asks how much it has been TRADED. RESEARCH §3d measured that 40% of the
    // pad has never traded at all, so a token can be a day old and sit at swap 0.
    const a = withinEntryWindow(25);
    const b = withinEntryWindow(25);
    expect(a).toEqual(b);
  });

  it("the same swap count always gives the same verdict, 50 times over", () => {
    const results = Array.from({ length: 50 }, () => withinEntryWindow(25));
    for (const r of results) expect(r).toEqual(results[0]);
  });
});
