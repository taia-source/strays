/**
 * Tests for the SURVIVORSHIP-FREE COLLECTOR's decoders.
 *
 * These are small functions and it would be easy to treat them as too simple to test. They are not,
 * for one reason: **every one of them decides the IDENTITY of a token or a pool, and an identity
 * bug here is silent.** It does not throw, it does not produce a NaN, and it does not look wrong in
 * a log line. It produces a plausible-looking hex string that simply never matches anything, and
 * the corpus it builds is then wrong in a way no downstream assertion can see.
 *
 * That is not hypothetical. `addressFromWord` shipped with a fixed `slice(24)`, which is correct
 * for a 64-char word cut out of `log.data` and off by two for a 66-char `0x`-prefixed topic. It
 * produced 42-hex-digit "addresses" that lowercased fine, compared equal to themselves, and matched
 * ZERO of the 461 known tokens — so the collector reported "launched-but-never-listed: 3202 of
 * 3202" and the entire survivorship comparison silently evaluated to "nothing survived". The fix is
 * to read the LAST 40 characters; these tests pin both input shapes so it cannot regress.
 */

import { describe as suite, expect, it } from "vitest";
import {
  addressFromWord,
  decodeLaunchedLog,
  hookFromInitializeLog,
  hookFromLaunchedLog,
} from "./forward.js";

/** A real `TokenLaunched` log from block 0x5e0053, copied verbatim from the chain. */
const REAL_LAUNCH = {
  topics: [
    "0x17091df68f499cf4e20dcfc5d42f064dd22359e785b77691c4c4ed0322608897",
    "0x0000000000000000000000006e17153e7b0ae7387d9b44f56291a4ef02cb14cc",
    "0x000000000000000000000000d7839366b045e4e083e75e806c46940eb0e3d9ff",
    "0x1ae17e1a30b02526decbe704c4cb3169cac5b568165a6619e5ca7b249b73af35",
  ],
  data:
    "0x0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "000000000000000000000000efe669814e5eec33406bd50ffa8331618d076aec" +
    "000000000000000000000000d7839366b045e4e083e75e806c46940eb0e3d9ff",
  blockNumber: "0x5e0053",
  blockTimestamp: "0x6a5104fb",
};

suite("addressFromWord — the identity bug that erased the whole comparison", () => {
  it("reads a 0x-PREFIXED topic (66 chars) correctly", () => {
    // This is the case the original `slice(24)` got wrong, and getting it wrong matched nothing.
    expect(addressFromWord("0x0000000000000000000000006e17153e7b0ae7387d9b44f56291a4ef02cb14cc")).toBe(
      "0x6e17153e7b0ae7387d9b44f56291a4ef02cb14cc",
    );
  });

  it("reads a BARE 64-char data word correctly", () => {
    expect(addressFromWord("000000000000000000000000efe669814e5eec33406bd50ffa8331618d076aec")).toBe(
      "0xefe669814e5eec33406bd50ffa8331618d076aec",
    );
  });

  it("always returns exactly 42 characters, whichever shape it is fed", () => {
    // The bug produced a 44-char string. Length alone would have caught it.
    const prefixed = addressFromWord(
      "0x0000000000000000000000006e17153e7b0ae7387d9b44f56291a4ef02cb14cc",
    );
    const bare = addressFromWord("000000000000000000000000efe669814e5eec33406bd50ffa8331618d076aec");
    expect(prefixed).toHaveLength(42);
    expect(bare).toHaveLength(42);
  });

  it("lowercases, so a checksummed address and a topic compare equal", () => {
    // `series.json` stores checksummed addresses; the chain gives lowercase topics. The join
    // between the two corpora is this comparison, so the normalisation is load-bearing.
    const fromChain = addressFromWord(
      "0x000000000000000000000000A80F5E49D874F58F015280CF08CC6E28B6BF75CC",
    );
    expect(fromChain).toBe("0xa80f5e49d874f58f015280cf08cc6e28b6bf75cc".toLowerCase());
  });

  it("refuses a word too short to contain an address rather than padding one", () => {
    // Padding would fabricate a token identity, which is the failure this whole file exists for.
    expect(() => addressFromWord("0xdeadbeef")).toThrow(/shorter than the 40/);
  });
});

suite("decodeLaunchedLog", () => {
  it("takes the token from topic1 and the pool from topic3", () => {
    const d = decodeLaunchedLog(REAL_LAUNCH);
    expect(d.address).toBe("0x6e17153e7b0ae7387d9b44f56291a4ef02cb14cc");
    expect(d.poolId).toBe("0x1ae17e1a30b02526decbe704c4cb3169cac5b568165a6619e5ca7b249b73af35");
  });

  it("carries the REAL block timestamp, never an inferred one", () => {
    // Launch time defines the train/test split for this family. Inferring it from block number
    // would fabricate the split itself.
    const d = decodeLaunchedLog(REAL_LAUNCH);
    expect(d.launchTs).toBe(0x6a5104fb);
    expect(d.launchBlock).toBe(0x5e0053);
  });

  it("throws rather than inventing a launch time when blockTimestamp is absent", () => {
    const { blockTimestamp: _drop, ...noTs } = REAL_LAUNCH;
    expect(() => decodeLaunchedLog(noTs)).toThrow(/blockTimestamp/);
  });

  it("throws rather than guessing when a topic is missing", () => {
    expect(() =>
      decodeLaunchedLog({ ...REAL_LAUNCH, topics: [REAL_LAUNCH.topics[0] ?? ""] }),
    ).toThrow(/topic1|topic3/);
  });
});

suite("the two fee hooks — read per pool, never assumed", () => {
  it("reads the hook from a TokenLaunched log's 4th data word", () => {
    expect(hookFromLaunchedLog(REAL_LAUNCH)).toBe("0xefe669814e5eec33406bd50ffa8331618d076aec");
  });

  it("reads the hook from an Initialize log's 3rd data word", () => {
    // A real Initialize log: fee, tickSpacing, hooks, sqrtPriceX96, tick.
    const init = {
      data:
        "0x00000000000000000000000000000000000000000000000000000000000ed026" +
        "00000000000000000000000000000000000000000000000000000000000000c8" +
        "00000000000000000000000075a54357d9c78a2db19004a5fdc76c50f9242aec" +
        "0000000000000000000000000000000000556b01f39a28e4cf45225361696d00" +
        "00000000000000000000000000000000000000000000000000000000030cb800",
    };
    expect(hookFromInitializeLog(init)).toBe("0x75a54357d9c78a2db19004a5fdc76c50f9242aec");
  });

  it("distinguishes the two known hooks rather than collapsing them", () => {
    // The bug this guards against hard-coded ONE hook and silently lost every pool on the other,
    // which hid the pad's best tokens. Both must decode to distinct, correct values.
    const A = "0x75a54357d9c78a2db19004a5fdc76c50f9242aec";
    const B = "0xefe669814e5eec33406bd50ffa8331618d076aec";
    expect(A).not.toBe(B);
    expect(hookFromLaunchedLog(REAL_LAUNCH)).toBe(B);
    expect(
      hookFromLaunchedLog({
        data: `${"0".repeat(64 * 3)}${"0".repeat(24)}${A.slice(2)}${"0".repeat(64)}`,
      }),
    ).toBe(A);
  });
});
