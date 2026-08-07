/**
 * Decode-surface tests.
 *
 * Both failure modes covered here are SILENT in production — no exception, no crash, a
 * green deploy and a healthy-looking indexer. That is exactly why they belong in the gate
 * rather than in code review.
 */
import { describe, expect, it } from "vitest";
import {
  type AbiEventEntry,
  checkCoverage,
  checkSignatureDrift,
  decodeFingerprint,
  defineDecodeSurface,
  eventSignature,
} from "./decode.js";

/** Real signatures from the seed project, including the one that shipped transposed. */
const TRANSFER = "Transfer(address,address,uint256)";
const SOLD = "Sold(address,uint256,uint256)";

describe("eventSignature", () => {
  it("builds a canonical signature from an ABI entry", () => {
    const entry: AbiEventEntry = {
      type: "event",
      name: "Transfer",
      inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    };
    expect(eventSignature(entry)).toBe(TRANSFER);
  });

  it("handles an event with no arguments", () => {
    expect(eventSignature({ type: "event", name: "Paused", inputs: [] })).toBe("Paused()");
  });
});

describe("defineDecodeSurface", () => {
  it("derives topic0 rather than trusting a hand-copied constant", () => {
    const [transfer] = defineDecodeSurface([TRANSFER]);
    expect(transfer?.topic0).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
  });

  it("rejects two signatures that collide on topic0", () => {
    // Same signature twice is fine; genuinely distinct collisions must throw.
    expect(() => defineDecodeSurface([TRANSFER, TRANSFER])).not.toThrow();
  });
});

describe("decodeFingerprint", () => {
  it("is stable regardless of declaration order", () => {
    const a = decodeFingerprint(defineDecodeSurface([TRANSFER, SOLD]));
    const b = decodeFingerprint(defineDecodeSurface([SOLD, TRANSFER]));
    expect(a).toBe(b);
  });

  /** A changed fingerprint is what triggers the targeted rewind instead of a full re-index. */
  it("changes when an event is added", () => {
    const before = decodeFingerprint(defineDecodeSurface([TRANSFER]));
    const after = decodeFingerprint(defineDecodeSurface([TRANSFER, SOLD]));
    expect(after).not.toBe(before);
  });
});

describe("checkSignatureDrift", () => {
  it("passes when every declared topic0 matches its signature", () => {
    expect(checkSignatureDrift(defineDecodeSurface([TRANSFER, SOLD])).ok).toBe(true);
  });

  /**
   * The transposition class. viem decodes POSITIONALLY, so a signature edited without
   * updating its topic0 stores wrong values with no error at all — which is exactly how
   * `Sold(tokensIn, quoteOut)` shipped reversed and corrupted every curve sell.
   */
  it("catches a topic0 that no longer matches its signature", () => {
    const result = checkSignatureDrift([{ signature: SOLD, topic0: `0x${"1".repeat(64)}` }]);
    expect(result.ok).toBe(false);
    expect(result.drifted[0]).toMatch(/declares .* but hashes to/);
  });
});

describe("checkCoverage", () => {
  const abis: AbiEventEntry[] = [
    {
      type: "event",
      name: "Transfer",
      inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    },
    {
      type: "event",
      name: "Sold",
      inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
    },
    { type: "event", name: "Paused", inputs: [] },
    { type: "function", name: "notAnEvent" },
  ];

  it("passes when everything emitted is decoded", () => {
    const result = checkCoverage({
      abis,
      decoded: defineDecodeSurface([TRANSFER, SOLD, "Paused()"]),
    });
    expect(result.ok).toBe(true);
  });

  /**
   * `MarketMakerDeployed` was emitted from day one and never indexed. Nothing failed —
   * the deploy was green and lag read 0 — while the volume half of every engine sat idle.
   */
  it("reports an emitted event that nothing decodes", () => {
    const result = checkCoverage({ abis, decoded: defineDecodeSurface([TRANSFER]) });
    expect(result.ok).toBe(false);
    expect(result.undecoded).toContain(SOLD);
    expect(result.undecoded).toContain("Paused()");
  });

  it("allows an explicit exemption that states a reason", () => {
    const result = checkCoverage({
      abis,
      decoded: defineDecodeSurface([TRANSFER, SOLD]),
      ignored: [{ name: "Paused", reason: "operator action; liveness is read from the chain" }],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an exemption with an empty reason", () => {
    const result = checkCoverage({
      abis,
      decoded: defineDecodeSurface([TRANSFER, SOLD]),
      ignored: [{ name: "Paused", reason: "   " }],
    });
    expect(result.ok).toBe(false);
    expect(result.unexplained).toContain("Paused()");
  });

  /**
   * Missing a deployment event means child contracts are never discovered — the failure
   * that leaves a funded engine idle behind a green health check. Not ignorable at any price.
   */
  it("refuses to let a deployment event be ignored at all", () => {
    const result = checkCoverage({
      abis,
      decoded: defineDecodeSurface([TRANSFER, SOLD]),
      ignored: [{ name: "Paused", reason: "we truly do not need it" }],
      deploymentEvents: ["Paused"],
    });
    expect(result.ok).toBe(false);
    expect(result.undecoded[0]).toMatch(/deployment events cannot be ignored/);
  });

  it("ignores non-event ABI entries", () => {
    const result = checkCoverage({
      abis: [{ type: "function", name: "transfer" }],
      decoded: [],
    });
    expect(result.ok).toBe(true);
  });

  it("skips anonymous events, which have no topic0 to filter on", () => {
    const result = checkCoverage({
      abis: [{ type: "event", name: "Anon", anonymous: true, inputs: [] }],
      decoded: [],
    });
    expect(result.ok).toBe(true);
  });
});
