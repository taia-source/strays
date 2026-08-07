/**
 * Arbitrum Nitro chain config — formatters viem does NOT ship.
 *
 * viem has `chainConfig` for celo, linea, tempo, zksync and op-stack. It has NONE for
 * Arbitrum: even `arbitrum` (42161) itself is a plain `defineChain` with no formatters.
 * So Nitro's extra RPC fields come back on the wire but are invisible to TypeScript.
 *
 * Field shapes below were read off LIVE responses from chain 4663 on 2026-07-27, not
 * from documentation:
 *
 *   eth_getBlockByNumber  → l1BlockNumber, sendRoot, sendCount
 *   eth_getTransactionReceipt → l1BlockNumber, gasUsedForL1
 *   transactions          → no Nitro-specific fields (so no `transaction` formatter)
 *
 * `gasUsedForL1` is the L1 data-fee component of a tx. On an L2 where the L1 fee usually
 * dominates, cost accounting that ignores it is simply wrong.
 */
import { defineBlock, defineTransactionReceipt, hexToBigInt } from "viem";

/** Nitro block extras. `sendRoot`/`sendCount` relate to the L2→L1 outbox. */
type NitroBlockOverrides = {
  l1BlockNumber?: `0x${string}` | undefined;
  sendRoot?: `0x${string}` | undefined;
  sendCount?: `0x${string}` | undefined;
};

/** Nitro receipt extras. */
type NitroReceiptOverrides = {
  l1BlockNumber?: `0x${string}` | undefined;
  gasUsedForL1?: `0x${string}` | undefined;
};

/**
 * Spread into `defineChain` to type Nitro's extra fields.
 *
 * Deliberately NOT setting `blockTime` here — it is per-chain (4663 is 100ms, Arbitrum One
 * is 250ms), unlike op-stack where 2s is a family constant.
 */
export const nitroChainConfig = {
  formatters: {
    block: /*#__PURE__*/ defineBlock({
      format(args: NitroBlockOverrides) {
        return {
          l1BlockNumber: args.l1BlockNumber ? hexToBigInt(args.l1BlockNumber) : undefined,
          sendRoot: args.sendRoot,
          sendCount: args.sendCount ? hexToBigInt(args.sendCount) : undefined,
        };
      },
    }),
    transactionReceipt: /*#__PURE__*/ defineTransactionReceipt({
      format(args: NitroReceiptOverrides) {
        return {
          l1BlockNumber: args.l1BlockNumber ? hexToBigInt(args.l1BlockNumber) : undefined,
          gasUsedForL1: args.gasUsedForL1 ? hexToBigInt(args.gasUsedForL1) : undefined,
        };
      },
    }),
  },
} as const;

/** ArbSys precompile — present on every Nitro chain. */
export const ARB_SYS_ADDRESS = "0x0000000000000000000000000000000000000064" as const;

/**
 * Minimal ArbSys ABI. `arbBlockNumber()` is the L2 clock.
 *
 * THIS IS THE ONE THAT BITES. On a Nitro chain the two block clocks diverge by millions:
 *
 *   eth_blockNumber / ArbSys.arbBlockNumber()  → L2 clock (~100ms/block on 4663)
 *   Solidity's NUMBER opcode (block.number)    → L1 clock (~12s/block)
 *
 * Measured on 4663, 2026-07-27: L2 20,842,235 vs L1 25,625,059 — 4.78M apart.
 * A 300-block window is ~30 SECONDS on the L2 clock and ~1 HOUR on the L1 clock.
 *
 * Two shipped bugs came from confusing them: a 5-day wallet cap where 1 hour was intended,
 * and a "restrictions last 11.5 days" claim that was really 2 L1 blocks (~25s).
 *
 * If a contract compares against block.number, off-chain code MUST supply the L1 height.
 */
export const arbSysAbi = [
  {
    type: "function",
    name: "arbBlockNumber",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;
