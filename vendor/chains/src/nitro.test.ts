/**
 * Nitro formatter unit tests — pure, no network.
 *
 * `chains.test.ts` proves the formatters work against the live chain. These prove the
 * ABSENT-field branches, which the live chain never exercises because it always returns
 * these fields. That matters: the same formatters are meant to be reusable on any Nitro
 * rollup, and a chain that omits `sendRoot` must not crash the client.
 */
import { describe, expect, it } from "vitest";
import { nitroChainConfig } from "./nitro.js";

const { block, transactionReceipt } = nitroChainConfig.formatters;

describe("nitro block formatter", () => {
  it("converts hex fields to bigint and passes sendRoot through", () => {
    const out = block.format({
      l1BlockNumber: "0x18701c5",
      sendRoot: `0x${"ab".repeat(32)}`,
      sendCount: "0x2ab",
    } as never);

    expect(out.l1BlockNumber).toBe(25_625_029n);
    expect(out.sendCount).toBe(683n);
    expect(out.sendRoot).toBe(`0x${"ab".repeat(32)}`);
  });

  it("yields undefined for absent fields instead of throwing", () => {
    const out = block.format({} as never);
    expect(out.l1BlockNumber).toBeUndefined();
    expect(out.sendRoot).toBeUndefined();
    expect(out.sendCount).toBeUndefined();
  });

  /** `0x0` is falsy-looking as a string but a legitimate value. Guard the ternary. */
  it("treats a zero-valued hex field as present", () => {
    const out = block.format({ l1BlockNumber: "0x0", sendCount: "0x0" } as never);
    expect(out.l1BlockNumber).toBe(0n);
    expect(out.sendCount).toBe(0n);
  });
});

describe("nitro receipt formatter", () => {
  it("converts gasUsedForL1 and l1BlockNumber to bigint", () => {
    const out = transactionReceipt.format({
      gasUsedForL1: "0x1234",
      l1BlockNumber: "0x18701c5",
    } as never);

    expect(out.gasUsedForL1).toBe(4660n);
    expect(out.l1BlockNumber).toBe(25_625_029n);
  });

  it("yields undefined for absent fields instead of throwing", () => {
    const out = transactionReceipt.format({} as never);
    expect(out.gasUsedForL1).toBeUndefined();
    expect(out.l1BlockNumber).toBeUndefined();
  });
});
