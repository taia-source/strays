import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertKnownHook,
  canonicalHook,
  HOOK_PRIMARY,
  HOOK_SECONDARY,
  isKnownHook,
  KNOWN_HOOKS,
} from "./hook.js";

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHAT THIS FILE IS DEFENDING, IN ONE PARAGRAPH ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * RESEARCH §7d re-measured the pad by reconstructing every token's poolId against both candidate
 * hooks and matching against the pad's own `pool` field: 67 tokens on 0x75A54357…, 44 on
 * 0xEfe66981…, 3 unmatched. The v1 vault hardcoded the first one as an immutable, so it could not
 * address the pools of LEVCAT, INTERN or Seriouscat at all — three of the four highest-volume
 * names — and the failure presented as an empty inner revert wrapped in `UnexpectedRevertBytes`,
 * which is indistinguishable from an RPC hiccup. That is why it hid.
 *
 * The other half is security: a v4 hook runs INSIDE the swap with the pool's permissions, so an
 * arbitrary hook is an arbitrary contract on the money path. `TAKE_ALL` stops proceeds going to a
 * named recipient; it cannot stop a swap that simply consumes the input. The allowlist is what
 * stops that, on both sides of the wire.
 */

describe("the two hooks, and their measured shares of the pad (RESEARCH §7d)", () => {
  it("there are exactly TWO, and the set is closed", () => {
    expect(KNOWN_HOOKS).toHaveLength(2);
    expect(KNOWN_HOOKS[0]).toBe(HOOK_PRIMARY);
    expect(KNOWN_HOOKS[1]).toBe(HOOK_SECONDARY);
  });

  it("they are the measured addresses, character for character", () => {
    // Typed out rather than derived, because these are the addresses the chain compares against
    // and a constant that agrees with itself proves nothing.
    expect(HOOK_PRIMARY).toBe("0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC");
    expect(HOOK_SECONDARY).toBe("0xEfe669814e5Eec33406Bd50ffa8331618D076aEc");
  });

  it("they are DIFFERENT addresses — the v1 assumption that there was one is what broke", () => {
    expect(HOOK_PRIMARY.toLowerCase()).not.toBe(HOOK_SECONDARY.toLowerCase());
  });

  it("both are well-formed 20-byte addresses", () => {
    for (const hook of KNOWN_HOOKS) {
      expect(hook).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});

describe("isKnownHook — the allowlist, on the keeper side", () => {
  it("ADMITS the primary hook", () => {
    expect(isKnownHook(HOOK_PRIMARY)).toBe(true);
  });

  it("ADMITS the second hook — the 44 tokens v1 could not trade", () => {
    // Both directions. A suite that only proved the refusal would pass just as happily against the
    // single-hook rule this replaces, which is the entire thing being fixed.
    expect(isKnownHook(HOOK_SECONDARY)).toBe(true);
  });

  it("REFUSES an arbitrary address", () => {
    expect(isKnownHook("0x000000000000000000000000000000000000dEaD")).toBe(false);
    // An address one character off is a different contract, and reads as a typo rather than as an
    // attack — which is exactly why it must be refused rather than fuzzily matched.
    expect(isKnownHook(`${HOOK_PRIMARY.slice(0, -1)}0`)).toBe(false);
  });

  it("REFUSES a missing, empty or non-string hook rather than defaulting to the primary", () => {
    // Defaulting IS the v1 bug. A token whose hook we failed to read is a token whose pool we
    // cannot address; guessing produces a revert with empty bytes that looks like an RPC problem.
    for (const bad of [undefined, null, "", "0x", 42 as unknown as string, {} as unknown as string]) {
      expect(isKnownHook(bad as string | undefined | null)).toBe(false);
    }
  });

  it("is CASE-INSENSITIVE, because the API and the RPC disagree about EIP-55 casing", () => {
    // An allowlist that a lowercase address fails refuses every legitimate trade from one data
    // source while passing tests written against the other.
    expect(isKnownHook(HOOK_PRIMARY.toLowerCase())).toBe(true);
    expect(isKnownHook(HOOK_SECONDARY.toLowerCase())).toBe(true);
    expect(isKnownHook(HOOK_SECONDARY.toUpperCase())).toBe(true);
  });

  it("tolerates surrounding whitespace from a trimmed API field", () => {
    expect(isKnownHook(`  ${HOOK_SECONDARY}\n`)).toBe(true);
  });

  it("does NOT throw on bad input — that is `assertKnownHook`'s job", () => {
    // Two functions for two call sites: a total predicate for screening, a throwing one for the
    // money path. A screen that throws would abort the whole candidate loop over one bad token.
    expect(() => isKnownHook("nonsense")).not.toThrow();
  });
});

describe("assertKnownHook — the throwing form, for the path that encodes a swap", () => {
  it("passes both known hooks silently", () => {
    expect(() => assertKnownHook(HOOK_PRIMARY)).not.toThrow();
    expect(() => assertKnownHook(HOOK_SECONDARY)).not.toThrow();
  });

  it("throws on anything else, naming both allowlisted addresses", () => {
    let message = "";
    try {
      assertKnownHook("0x000000000000000000000000000000000000dEaD");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain(HOOK_PRIMARY);
    expect(message).toContain(HOOK_SECONDARY);
    // The message must state the SECURITY reason, not only the correctness one — an operator
    // reading it should learn why this is not a setting they can widen.
    expect(message).toMatch(/runs INSIDE\s+the swap|runs INSIDE the swap/);
    expect(message).toMatch(/TAKE_ALL/);
  });

  it("throws rather than returning false — a boolean here is a check somebody can forget", () => {
    expect(() => assertKnownHook(undefined)).toThrow();
    expect(() => assertKnownHook("")).toThrow();
  });
});

describe("canonicalHook — one spelling, so `===` means what it looks like", () => {
  it("normalises any casing to the constant's own spelling", () => {
    expect(canonicalHook(HOOK_PRIMARY.toLowerCase())).toBe(HOOK_PRIMARY);
    expect(canonicalHook(HOOK_SECONDARY.toUpperCase())).toBe(HOOK_SECONDARY);
    expect(canonicalHook(` ${HOOK_SECONDARY} `)).toBe(HOOK_SECONDARY);
  });

  it("is idempotent", () => {
    expect(canonicalHook(canonicalHook(HOOK_PRIMARY))).toBe(HOOK_PRIMARY);
  });

  it("CANNOT launder an arbitrary address into a canonical-looking one", () => {
    // The dangerous failure for a normaliser: making an unknown value look official. It delegates
    // to `assertKnownHook` first, so there is no path from an arbitrary string to a return value.
    expect(() => canonicalHook("0x000000000000000000000000000000000000dEaD")).toThrow(
      /not one of the two known letscash hooks/,
    );
  });
});

describe("THE KEEPER'S ALLOWLIST AND THE CONTRACT'S ARE THE SAME TWO ADDRESSES", () => {
  /*
   * RESEARCH §7g is about the gap between a claim and the code that would have to run for it.
   * `StrayVault._requireKnownHook` checks two immutables with no setter; this module checks two
   * constants. If they ever diverge, the keeper would confidently send a transaction the contract
   * reverts — real gas, no trade, and a log line saying the hook was fine.
   *
   * The contract source is the authority. This reads it rather than restating it.
   */
  it("both hooks appear in StrayVault.sol", () => {
    const sol = readFileSync(new URL("../../contracts/src/StrayVault.sol", import.meta.url), "utf8");
    for (const hook of KNOWN_HOOKS) {
      expect(sol, `${hook} must be in the contract's allowlist`).toContain(hook);
    }
  });

  it("the contract enforces the allowlist with a function, not a comment", () => {
    const sol = readFileSync(new URL("../../contracts/src/StrayVault.sol", import.meta.url), "utf8");
    expect(sol).toContain("_requireKnownHook");
    // And the keeper's `hunt` call passes a hook at all — the per-trade argument RESEARCH §7d
    // showed was necessary. A contract with a single immutable hook would not have this.
    expect(sol).toMatch(/function hunt\(/);
  });
});
