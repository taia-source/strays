/**
 * On-chain validation of a deploy manifest.
 *
 * `placeholders.ts` catches values that are *syntactically* wrong or unaccounted-for.
 * This catches the ones that look perfect and are still wrong — which is the failure
 * mode that actually reaches production.
 *
 * ══ Why static checks are not enough ══
 *
 * The most common real failure is **right address, wrong network**. The string is a valid
 * checksummed address, it is in the manifest, it deployed successfully — on a different
 * chain. Nothing textual can see that. `getCode` can: an address with no code on *this*
 * chain is not a contract here, whatever it is elsewhere.
 *
 * The second is **stale-but-plausible**. A prior project's `.env.example` carried live
 * testnet addresses from an earlier deployment. Absent values fail loudly; stale values
 * fail silently, which is strictly worse.
 *
 * ══ The ladder ══
 *
 * Adapted from a validation endpoint in a prior project that got this right. Each rung
 * catches something the one above cannot, and each returns a **human-readable reason** —
 * because "invalid" is useless and "0x1234… has no code on chain 4663, so this is
 * probably a different network's address" is actionable.
 *
 *   1. shape        — is it an address at all
 *   2. has code     — is there a contract here, on THIS chain
 *   3. identity     — does it answer as the thing we think it is (symbol/decimals)
 *   4. cross-ref    — does its own on-chain state agree with our config
 *
 * Rung 4 is the one that catches a wrong-but-real address, and it is the one people skip.
 */
import type { Chain, Client, Transport } from "viem";
import { getChainId, getCode, readContract } from "viem/actions";

export type ChainReader = Client<Transport, Chain | undefined>;

export type CheckResult = {
  readonly ok: boolean;
  /** Human-readable, shown to whoever has to fix it. Never just "invalid". */
  readonly detail: string;
};

const ADDRESS_SHAPE = /^0x[a-fA-F0-9]{40}$/;

/** Rung 1 — shape only. Cheap, no RPC. */
export function checkShape(value: string): CheckResult {
  if (!ADDRESS_SHAPE.test(value.trim())) {
    return { ok: false, detail: `"${value}" is not a 20-byte hex address` };
  }
  return { ok: true, detail: "well-formed address" };
}

/**
 * Rung 2 — is there a contract here, on THIS chain?
 *
 * **This single check catches the most common real failure**: an address deployed on a
 * different network. It is one RPC call and it should never be skipped.
 */
export async function checkHasCode(
  client: ChainReader,
  address: `0x${string}`,
): Promise<CheckResult> {
  // `getCode`, not `getBytecode` (an alias kept for v1 compatibility). And the check is
  // `!code`, NOT `code !== "0x"`: viem normalises empty code to `undefined`, so the
  // widely-copied `code !== "0x"` idiom is ALWAYS true — it silently never fires, which
  // disables the single most valuable assertion here. Verified in viem 2.55.10 source.
  const code = await getCode(client, { address });
  const chainId = client.chain?.id ?? "unknown";
  if (!code) {
    return {
      ok: false,
      detail:
        `no contract code at ${address} on chain ${chainId} — ` +
        "this is very likely an address from a different network",
    };
  }
  return { ok: true, detail: `contract present (${(code.length - 2) / 2} bytes)` };
}

const ERC20_ABI = [
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalSupply",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export type TokenIdentity = {
  readonly symbol: string;
  readonly decimals: number;
  readonly totalSupply: bigint;
};

/**
 * Rung 3 — ask the contract what it is, and show a human the answer.
 *
 * A wrong-but-valid address usually surfaces here as the wrong ticker. That is why the
 * result is returned rather than just a boolean: a person recognising "that says WETH,
 * we launched EMBER" is the check.
 */
export async function checkTokenIdentity(
  client: ChainReader,
  address: `0x${string}`,
  expectedSymbol?: string,
): Promise<CheckResult & { readonly identity?: TokenIdentity }> {
  try {
    const [symbol, decimals, totalSupply] = await Promise.all([
      readContract(client, { address, abi: ERC20_ABI, functionName: "symbol" }),
      readContract(client, { address, abi: ERC20_ABI, functionName: "decimals" }),
      readContract(client, { address, abi: ERC20_ABI, functionName: "totalSupply" }),
    ]);

    const identity: TokenIdentity = { symbol, decimals, totalSupply };

    if (expectedSymbol !== undefined && symbol.toLowerCase() !== expectedSymbol.toLowerCase()) {
      return {
        ok: false,
        detail: `token reports symbol "${symbol}" but the project expects "${expectedSymbol}" — wrong token`,
        identity,
      };
    }

    return { ok: true, detail: `${symbol}, ${decimals} decimals`, identity };
  } catch (error) {
    return {
      ok: false,
      detail:
        `${address} has code but does not answer as an ERC-20 ` +
        `(${error instanceof Error ? error.message.split("\n")[0] : "read failed"})`,
    };
  }
}

/**
 * Rung 4 — does the contract's own state agree with our config?
 *
 * The rung people skip, and the one that catches a wrong-but-real address. If our NFT
 * says its token is X and our config says Y, one of them is wrong and the mismatch is
 * invisible to every check above.
 */
export async function checkCrossReference(
  client: ChainReader,
  options: {
    readonly contract: `0x${string}`;
    readonly getter: string;
    readonly expected: `0x${string}`;
    readonly label: string;
  },
): Promise<CheckResult> {
  const abi = [
    {
      type: "function",
      name: options.getter,
      inputs: [],
      outputs: [{ type: "address" }],
      stateMutability: "view",
    },
  ] as const;

  try {
    const actual = (await readContract(client, {
      address: options.contract,
      abi,
      functionName: options.getter,
    })) as `0x${string}`;

    if (actual.toLowerCase() !== options.expected.toLowerCase()) {
      return {
        ok: false,
        detail:
          `${options.label}: ${options.contract}.${options.getter}() returns ${actual}, ` +
          `but config says ${options.expected} — these must match`,
      };
    }
    return { ok: true, detail: `${options.label}: on-chain state agrees with config` };
  } catch (error) {
    return {
      ok: false,
      detail:
        `${options.label}: could not read ${options.getter}() ` +
        `(${error instanceof Error ? error.message.split("\n")[0] : "read failed"})`,
    };
  }
}

/**
 * Rung 2b — the start block must not be AFTER the deploy block.
 *
 * Asymmetric and worth stating: a start block *before* the deploy is merely slow, one
 * *after* it silently loses every event before it, forever. The indexer never backfills
 * what it was told to skip, and nothing errors.
 */
export function checkStartBlock(startBlock: bigint, deployBlock: bigint): CheckResult {
  if (startBlock > deployBlock) {
    return {
      ok: false,
      detail:
        `start block ${startBlock} is AFTER the deploy block ${deployBlock} — ` +
        `every event in between is lost permanently and nothing will error`,
    };
  }
  if (startBlock < deployBlock) {
    return {
      ok: true,
      detail: `start block ${startBlock} precedes deploy ${deployBlock} — safe, ${deployBlock - startBlock} blocks of wasted scanning`,
    };
  }
  return { ok: true, detail: `start block matches the deploy block exactly` };
}

/**
 * Rung 2c — pin `startBlock` to EXACTLY the deploy block, from the chain itself.
 *
 * The strongest indexer check available, and it is two RPC calls: the contract must have
 * no code one block earlier and code at the start block. graph-node does this at deploy
 * time and rejects a subgraph that fails it; Ponder does not, so we do it ourselves.
 *
 * Needs an ARCHIVE endpoint. A pruned node fails the historical call rather than
 * returning empty — which would invert the assertion and report a correct config as
 * broken. That case is reported separately rather than as a failure.
 */
export async function checkStartBlockOnChain(
  client: ChainReader,
  address: `0x${string}`,
  startBlock: bigint,
): Promise<CheckResult> {
  if (startBlock === 0n) {
    return {
      ok: false,
      detail: "start block 0 forces a full-chain backfill — derive it from the deploy receipt",
    };
  }

  let before: `0x${string}` | undefined;
  let at: `0x${string}` | undefined;
  try {
    [before, at] = await Promise.all([
      getCode(client, { address, blockNumber: startBlock - 1n }),
      getCode(client, { address, blockNumber: startBlock }),
    ]);
  } catch (error) {
    return {
      ok: true,
      detail:
        "could not read historical code — the endpoint is probably not an archive node, " +
        `so this check was skipped rather than failed (${error instanceof Error ? error.message.split("\n")[0] : "read failed"})`,
    };
  }

  if (before) {
    return {
      ok: false,
      detail:
        `the contract already existed at block ${startBlock - 1n} — the start block is AFTER ` +
        "the deploy, so every event before it is lost permanently and nothing will error",
    };
  }
  if (!at) {
    return {
      ok: true,
      detail: `no code yet at block ${startBlock} — start block precedes the deploy, which is safe but wastes scanning`,
    };
  }
  return { ok: true, detail: `start block ${startBlock} is exactly the deploy block` };
}

/**
 * Rung 0 — is the client even talking to the chain we think it is?
 *
 * The same address can exist on several chains (CREATE2, or a forked testnet), so every
 * check above is meaningless if the RPC points somewhere else. Cheap, and it makes the
 * rest of the ladder trustworthy.
 */
export async function checkChainId(client: ChainReader, expected: number): Promise<CheckResult> {
  const actual = await getChainId(client);
  if (actual !== expected) {
    return {
      ok: false,
      detail: `the RPC reports chain ${actual} but the config expects ${expected} — every other check would be validating the wrong network`,
    };
  }
  return { ok: true, detail: `connected to chain ${actual}` };
}
