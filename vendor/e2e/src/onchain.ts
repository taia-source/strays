/**
 * On-chain assertions for E2E tests.
 *
 * **This is the difference between "the UI rendered" and "the app works."**
 *
 * A test that clicks Buy and asserts a success toast proves the frontend can render a
 * success toast. It passes when the transaction silently reverted, when the app called
 * the wrong contract, and when the button was wired to nothing. Every one of those has
 * shipped in a real project.
 *
 * The assertion that means something is: **balances, supply or pool state actually
 * changed on chain, by the amount expected.** That is what these helpers make cheap
 * enough that nobody skips it.
 *
 * Deliberately generic. A launchpad, a trading dashboard and an NFT mint all reduce to
 * "capture state → act → assert the delta", so nothing here knows what kind of app it is
 * testing.
 */
import type { Chain, Client, Transport } from "viem";
import { getBalance, readContract, waitForTransactionReceipt } from "viem/actions";

export type ChainClient = Client<Transport, Chain | undefined>;

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
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

const ERC721_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ownerOf",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
] as const;

/**
 * A snapshot of whatever this test cares about.
 *
 * Values are captured by name so the delta assertion can report *which* one moved wrongly
 * — "nativeBalance changed by 0, expected -1000000000000000" is actionable in a way that
 * "assertion failed" is not.
 */
export type StateSnapshot = Readonly<Record<string, bigint>>;

export type StateProbe = {
  readonly label: string;
  read(client: ChainClient): Promise<bigint>;
};

/** Native balance (ETH and equivalents). */
export function nativeBalance(address: `0x${string}`, label = "nativeBalance"): StateProbe {
  return { label, read: (client) => getBalance(client, { address }) };
}

export function tokenBalance(
  token: `0x${string}`,
  holder: `0x${string}`,
  label = "tokenBalance",
): StateProbe {
  return {
    label,
    read: (client) =>
      readContract(client, {
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [holder],
      }),
  };
}

export function totalSupply(token: `0x${string}`, label = "totalSupply"): StateProbe {
  return {
    label,
    read: (client) =>
      readContract(client, { address: token, abi: ERC20_ABI, functionName: "totalSupply" }),
  };
}

export function nftBalance(
  collection: `0x${string}`,
  holder: `0x${string}`,
  label = "nftBalance",
): StateProbe {
  return {
    label,
    read: (client) =>
      readContract(client, {
        address: collection,
        abi: ERC721_ABI,
        functionName: "balanceOf",
        args: [holder],
      }),
  };
}

/**
 * The Solidity type for an argument, inferred from its JavaScript value.
 *
 * ══ Why this is not just `uint256` ══
 *
 * The original built every input as `uint256`. That works for `priceAt(uint256)` and
 * fails for `balanceOf(address)` — which is the single most common uint getter there is.
 * Measured against a live contract, the wrong ABI produced:
 *
 *     ContractFunctionRevertedError: The contract function "balanceOf" reverted.
 *
 * The failure surfaces at flow time, long after the probe was written, and reads as a
 * contract problem rather than a probe problem. Only three argument shapes occur in
 * practice, and all three are distinguishable from the value itself.
 */
export function solidityTypeOf(value: unknown): string {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return "address";
  if (typeof value === "boolean") return "bool";
  return "uint256";
}

/** Any view function returning a uint — pool reserves, a curve's progress, an XP counter. */
export function readsUint(options: {
  readonly contract: `0x${string}`;
  readonly getter: string;
  readonly label?: string;
  readonly args?: readonly unknown[];
}): StateProbe {
  const abi = [
    {
      type: "function",
      name: options.getter,
      // Inferred per argument, not assumed uint256 — see solidityTypeOf. Assuming
      // uint256 makes balanceOf(address) revert at flow time.
      inputs: (options.args ?? []).map((arg) => ({ type: solidityTypeOf(arg) })),
      outputs: [{ type: "uint256" }],
      stateMutability: "view",
    },
  ] as const;
  return {
    label: options.label ?? options.getter,
    read: (client) =>
      readContract(client, {
        address: options.contract,
        abi,
        functionName: options.getter,
        args: (options.args ?? []) as never,
      }) as Promise<bigint>,
  };
}

export async function snapshot(
  client: ChainClient,
  probes: readonly StateProbe[],
): Promise<StateSnapshot> {
  const entries = await Promise.all(
    probes.map(async (p) => [p.label, await p.read(client)] as const),
  );
  return Object.fromEntries(entries);
}

export type Delta = {
  readonly label: string;
  readonly before: bigint;
  readonly after: bigint;
  readonly change: bigint;
};

export function diff(before: StateSnapshot, after: StateSnapshot): Delta[] {
  return Object.keys(before).map((label) => {
    // `?? 0n` on `before` is unreachable: the label came from `Object.keys(before)`, so
    // the lookup always hits. It satisfies noUncheckedIndexedAccess only. The `after`
    // fallback below IS reachable — `after` is a separate snapshot that may be missing a
    // probe the first one captured.
    const b = before[label] ?? 0n;
    const a = after[label] ?? 0n;
    return { label, before: b, after: a, change: a - b };
  });
}

export type Expectation =
  | { readonly kind: "increased" }
  | { readonly kind: "decreased" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "exactly"; readonly by: bigint }
  | { readonly kind: "atLeast"; readonly by: bigint };

export type AssertionResult = {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly deltas: readonly Delta[];
};

/**
 * Assert the chain moved the way the flow claims it did.
 *
 * **`unchanged` matters as much as `increased`.** A buy that increases the buyer's token
 * balance *and* silently drains an unrelated vault passes a naive test. Asserting what
 * must NOT move is how you catch that.
 */
export function assertDeltas(
  before: StateSnapshot,
  after: StateSnapshot,
  expectations: Readonly<Record<string, Expectation>>,
): AssertionResult {
  const deltas = diff(before, after);
  const failures: string[] = [];

  for (const [label, expectation] of Object.entries(expectations)) {
    const delta = deltas.find((d) => d.label === label);
    if (!delta) {
      failures.push(`no probe named "${label}" was captured — check the snapshot probes`);
      continue;
    }

    const { change } = delta;
    const detail = `${label}: ${delta.before} → ${delta.after} (${change >= 0n ? "+" : ""}${change})`;

    switch (expectation.kind) {
      case "increased":
        if (change <= 0n) failures.push(`${detail} — expected an increase`);
        break;
      case "decreased":
        if (change >= 0n) failures.push(`${detail} — expected a decrease`);
        break;
      case "unchanged":
        if (change !== 0n) failures.push(`${detail} — expected NO change`);
        break;
      case "exactly":
        if (change !== expectation.by)
          failures.push(`${detail} — expected exactly ${expectation.by}`);
        break;
      case "atLeast":
        if (change < expectation.by)
          failures.push(`${detail} — expected at least ${expectation.by}`);
        break;
    }
  }

  return { ok: failures.length === 0, failures, deltas };
}

/**
 * Wait for a transaction and fail loudly if it reverted.
 *
 * A reverted transaction still produces a receipt, so code that only awaits the receipt
 * treats a revert as success. The UI usually shows a spinner ending, which is exactly how
 * a broken flow looks like a working one.
 */
export async function waitForSuccess(
  client: ChainClient,
  hash: `0x${string}`,
  timeoutMs = 30_000,
): Promise<void> {
  const receipt = await waitForTransactionReceipt(client, { hash, timeout: timeoutMs });
  if (receipt.status !== "success") {
    throw new Error(
      `transaction ${hash} REVERTED in block ${receipt.blockNumber} — the flow did not do what the UI implied`,
    );
  }
}

/** Readable report. Shows every probe, not only failures, so a passing run is auditable. */
export function formatDeltas(result: AssertionResult): string {
  const lines = result.deltas.map(
    (d) =>
      `  ${d.label.padEnd(20)} ${d.before} → ${d.after}  (${d.change >= 0n ? "+" : ""}${d.change})`,
  );
  if (result.ok) return ["on-chain state changed as expected:", ...lines].join("\n");
  return [
    "ON-CHAIN ASSERTION FAILED:",
    ...result.failures.map((f) => `  ✗ ${f}`),
    "",
    "all probes:",
    ...lines,
  ].join("\n");
}
