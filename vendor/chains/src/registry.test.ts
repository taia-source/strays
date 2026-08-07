/**
 * Registry unit tests — pure, no network.
 *
 * `chains.test.ts` proves the definitions match the live chain. This proves the
 * accessors around them behave, including the env-override path that CI depends on
 * (the public RPC has no archive data, so backfill and CI must point elsewhere).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  bscChain,
  chains,
  getChain,
  getMeta,
  robinhoodNitro,
  robinhoodTestnetNitro,
  rpcUrl,
  type SupportedChainId,
} from "./chains.js";

const ids = Object.keys(chains).map(Number) as SupportedChainId[];

describe("registry", () => {
  it("keys every chain by its own id", () => {
    for (const id of ids) {
      expect(getChain(id).id).toBe(id);
    }
  });

  /**
   * Every chain carries meta, and its block clock is one of the two the type allows.
   *
   * This asserted `blockClock === "nitro"` for every chain until BSC (56) was added, and it
   * passed the whole time — because every chain in the registry was a Nitro rollup. That is
   * the shape of a single-chain assumption: correct, green, and encoding "all chains are
   * like the one chain we have".
   *
   * The registry's stated purpose is to be chain-agnostic. A per-chain fact belongs in that
   * chain's own assertion below, never in a loop over every chain.
   */
  it("carries meta for every registered chain", () => {
    for (const id of ids) {
      const m = getMeta(id);
      expect(m.confirmations).toBeGreaterThan(0);
      expect(["nitro", "standard"]).toContain(m.blockClock);
    }
  });

  /** The per-chain facts, stated per chain rather than assumed across the loop above. */
  it("records the block clock each chain actually uses", () => {
    expect(getMeta(robinhoodNitro.id).blockClock).toBe("nitro");
    expect(getMeta(robinhoodTestnetNitro.id).blockClock).toBe("nitro");
    // BSC is an L1: the NUMBER opcode and eth_blockNumber agree, so there is no second clock.
    expect(getMeta(bscChain.id).blockClock).toBe("standard");
  });

  it("marks the testnet as a testnet and the mainnet as not", () => {
    expect(robinhoodTestnetNitro.testnet).toBe(true);
    expect(robinhoodNitro.testnet).toBeFalsy();
  });

  /** 4663 and 46630 are different chains. Confusing them is a documented trap. */
  it("keeps mainnet and testnet ids distinct", () => {
    expect(robinhoodNitro.id).toBe(4663);
    expect(robinhoodTestnetNitro.id).toBe(46630);
  });

  /**
   * Formatters exist exactly where they are needed, and nowhere else.
   *
   * The Nitro chains need them because viem ships no Arbitrum `chainConfig`, so
   * `l1BlockNumber`/`sendRoot`/`gasUsedForL1` would otherwise arrive untyped — that gap is
   * the entire reason this wrapper exists.
   *
   * BSC needs none: its blocks carry no extra fields. Asserting formatters on every chain
   * (as this did before 56 was added) would force a pointless empty formatter onto every
   * future standard chain, which is the opposite of wrapping viem thinly.
   */
  it("attaches the nitro formatters to the nitro chains", () => {
    for (const id of [robinhoodNitro.id, robinhoodTestnetNitro.id]) {
      const chain = getChain(id);
      expect(chain.formatters?.block).toBeDefined();
      expect(chain.formatters?.transactionReceipt).toBeDefined();
    }
  });

  it("does not invent formatters for a standard chain", () => {
    // viem's own bsc definition has none, and spreading it must not add any.
    expect(getChain(bscChain.id).formatters?.block).toBeUndefined();
  });
});

describe("rpcUrl", () => {
  const envKey = `TAIA_RPC_${robinhoodNitro.id}`;

  afterEach(() => {
    delete process.env[envKey];
  });

  it("falls back to the chain's public default", () => {
    delete process.env[envKey];
    expect(rpcUrl(robinhoodNitro.id)).toBe(robinhoodNitro.rpcUrls.default.http[0]);
  });

  it("prefers TAIA_RPC_<id> when set", () => {
    process.env[envKey] = "https://provider.example/key";
    expect(rpcUrl(robinhoodNitro.id)).toBe("https://provider.example/key");
  });

  it("ignores an empty override rather than returning an empty url", () => {
    process.env[envKey] = "";
    expect(rpcUrl(robinhoodNitro.id)).toBe(robinhoodNitro.rpcUrls.default.http[0]);
  });
});
