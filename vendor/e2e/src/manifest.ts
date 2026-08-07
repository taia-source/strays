/**
 * The handshake that lets a generic E2E package test a project it has never seen.
 *
 * ══ The problem ══
 *
 * A launchpad, a trading dashboard, an NFT mint and a project type nobody has thought of
 * yet share no selectors, no contracts and no flows. A test suite that hardcodes any of
 * those only works for projects someone anticipated — which is exactly the trap this whole
 * system exists to avoid.
 *
 * ══ The inversion ══
 *
 * The package stays generic; the **project describes itself**. The generator emits an
 * `e2e.manifest.json` saying "here is my core flow, here are my contracts, and here is
 * what must change on chain when the flow succeeds." The runner reads it and tests
 * whatever it says.
 *
 * That means a new project type costs a manifest, not a code change — and the manifest is
 * written by whoever built the project, who is the only one who knows what "working"
 * means for it.
 *
 * ══ Why the on-chain expectations are mandatory ══
 *
 * A manifest that only lists UI steps produces a test that proves the UI rendered. The
 * `expect` block is what makes the run load-bearing: it forces the generator to state, up
 * front, what the chain must do. A flow whose author cannot say what should change on
 * chain is a flow nobody has thought through.
 */

/** One step in a flow, expressed by accessible role and name — never a CSS selector. */
export type FlowStep =
  | { readonly action: "click"; readonly role: AriaRole; readonly name: string }
  | {
      readonly action: "fill";
      readonly role: AriaRole;
      readonly name: string;
      readonly value: string;
    }
  | { readonly action: "expectVisible"; readonly role: AriaRole; readonly name: string }
  | { readonly action: "expectText"; readonly text: string }
  /** Narration for the demo video. No assertion; purely for the human watching. */
  | { readonly action: "chapter"; readonly title: string; readonly description?: string };

/**
 * Roles, not selectors.
 *
 * Role+name binds to semantics, so an agent restyling from Tailwind to CSS modules — or
 * restructuring the DOM entirely — does not break the test. A CSS or XPath selector breaks
 * on both. This single choice is what lets a suite survive the UI being regenerated.
 */
export type AriaRole =
  | "button"
  | "link"
  | "textbox"
  | "heading"
  | "checkbox"
  | "combobox"
  | "dialog"
  | "status"
  | "alert"
  | "img"
  | "list"
  | "listitem"
  | "table"
  | "tab";

/** What must change on chain for the flow to count as successful. */
export type ChainExpectation = {
  /** Probe label, matched against the snapshot probes below. */
  readonly probe: string;
  readonly expect: "increased" | "decreased" | "unchanged" | "exactly" | "atLeast";
  /** Required for `exactly` and `atLeast`. Decimal string, since JSON has no bigint. */
  readonly by?: string;
};

export type ProbeSpec =
  | { readonly kind: "nativeBalance"; readonly label: string; readonly address: `0x${string}` }
  | {
      readonly kind: "tokenBalance";
      readonly label: string;
      readonly token: `0x${string}`;
      readonly holder: `0x${string}`;
    }
  | { readonly kind: "totalSupply"; readonly label: string; readonly token: `0x${string}` }
  | {
      readonly kind: "nftBalance";
      readonly label: string;
      readonly collection: `0x${string}`;
      readonly holder: `0x${string}`;
    }
  | {
      readonly kind: "uint";
      readonly label: string;
      readonly contract: `0x${string}`;
      readonly getter: string;
    };

export type Flow = {
  readonly name: string;
  /** Path to open, relative to baseUrl. */
  readonly path: string;
  readonly steps: readonly FlowStep[];
  /** Chain state captured before and after the steps. */
  readonly probes: readonly ProbeSpec[];
  /** What those probes must show afterwards. At least one is required. */
  readonly expectations: readonly ChainExpectation[];
};

export type E2EManifest = {
  readonly version: 1;
  readonly project: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly baseUrl: string;
  /** Every flow that must work for the project to be considered functional. */
  readonly flows: readonly Flow[];
  /** The single flow recorded as the handoff video. Defaults to the first. */
  readonly demoFlow?: string;
};

export type ValidationIssue = { readonly path: string; readonly problem: string };

/**
 * Validate a manifest before running anything.
 *
 * A malformed manifest should fail immediately with a precise message, not halfway
 * through a browser run with a confusing one. This is also where the "you must state an
 * on-chain expectation" rule is enforced — the rule that stops a manifest degrading into
 * a UI smoke test.
 */
export function validateManifest(manifest: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const m = manifest as Partial<E2EManifest> | null;

  if (!m || typeof m !== "object") {
    return [{ path: "", problem: "manifest is not an object" }];
  }
  if (m.version !== 1) issues.push({ path: "version", problem: "must be 1" });
  if (!m.project) issues.push({ path: "project", problem: "required" });
  if (typeof m.chainId !== "number") issues.push({ path: "chainId", problem: "required, numeric" });
  if (!m.rpcUrl) issues.push({ path: "rpcUrl", problem: "required" });
  if (!m.baseUrl) issues.push({ path: "baseUrl", problem: "required" });

  const flows = m.flows ?? [];
  if (flows.length === 0) {
    issues.push({
      path: "flows",
      problem: "at least one flow is required — a project with no testable flow is not testable",
    });
  }

  flows.forEach((flow, i) => {
    const at = `flows[${i}]`;
    if (!flow.name) issues.push({ path: `${at}.name`, problem: "required" });
    if (!flow.path) issues.push({ path: `${at}.path`, problem: "required" });
    if ((flow.steps ?? []).length === 0) {
      issues.push({ path: `${at}.steps`, problem: "a flow with no steps does nothing" });
    }

    // The rule that keeps this from degrading into a UI smoke test.
    if ((flow.expectations ?? []).length === 0) {
      issues.push({
        path: `${at}.expectations`,
        problem:
          "at least one on-chain expectation is required — without it this only proves the UI rendered, " +
          "which passes when the transaction reverted",
      });
    }

    const probeLabels = new Set((flow.probes ?? []).map((p) => p.label));
    flow.expectations?.forEach((exp, j) => {
      if (!probeLabels.has(exp.probe)) {
        issues.push({
          path: `${at}.expectations[${j}].probe`,
          problem: `"${exp.probe}" does not match any probe in this flow (have: ${[...probeLabels].join(", ") || "none"})`,
        });
      }
      if ((exp.expect === "exactly" || exp.expect === "atLeast") && exp.by === undefined) {
        issues.push({
          path: `${at}.expectations[${j}].by`,
          problem: `"${exp.expect}" requires a "by" amount`,
        });
      }
      if (exp.by !== undefined && !/^-?\d+$/.test(exp.by)) {
        issues.push({
          path: `${at}.expectations[${j}].by`,
          problem: `"${exp.by}" must be a decimal integer string (JSON has no bigint)`,
        });
      }
    });
  });

  if (m.demoFlow && !flows.some((f) => f.name === m.demoFlow)) {
    issues.push({ path: "demoFlow", problem: `"${m.demoFlow}" is not one of the declared flows` });
  }

  // Anvil-local values that survived a copy onto a real chain. Checked here rather than
  // left to the caller because the failure is silent: a probe against an undeployed
  // address reads empty instead of throwing, so the run "passes" against nothing.
  if (typeof m.chainId === "number" && m.rpcUrl && m.baseUrl) {
    for (const problem of assertLocalOnly(m as E2EManifest)) {
      issues.push({ path: "chainId", problem });
    }
  }

  return issues;
}

/** Which flow becomes the handoff video. Falls back to the first declared. */
export function demoFlowOf(manifest: E2EManifest): Flow | undefined {
  if (manifest.demoFlow) return manifest.flows.find((f) => f.name === manifest.demoFlow);
  return manifest.flows[0];
}

/** Readable validation report, naming the exact path so the fix is mechanical. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  if (issues.length === 0) return "manifest is valid";
  return [
    "manifest is INVALID:",
    ...issues.map((i) => `  ${i.path || "(root)"}: ${i.problem}`),
  ].join("\n");
}

/**
 * A worked example, exported so a generator has a concrete shape to copy.
 *
 * Deliberately a token mint: it is the simplest flow that still has a real on-chain
 * consequence, and it shows the two expectations that matter — something increased, and
 * something that must NOT have moved.
 *
 * ⚠ **Every address here is ANVIL-LOCAL and must not survive a copy.**
 *
 * `0x5FbDB2…` is the first contract deployed by Anvil account #0, and `0xf39Fd6…` /
 * `0x70997970…` are Anvil accounts #0 and #1. They are deterministic on a local chain and
 * meaningless on a real one — nothing is deployed there, so a read returns empty and a
 * transfer sends funds to an address nobody controls, **and nothing throws**.
 *
 * `chainId: 31337` is the guard: `assertLocalOnly` refuses this manifest against any other
 * chain, and `@taia/deploy` flags these addresses as `local-chain-address` if they reach a
 * generated project. Copy the SHAPE, never the values.
 */
export const EXAMPLE_MANIFEST: E2EManifest = {
  version: 1,
  project: "example-mint",
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  baseUrl: "http://127.0.0.1:3000",
  demoFlow: "mint",
  flows: [
    {
      name: "mint",
      path: "/",
      probes: [
        {
          kind: "totalSupply",
          label: "supply",
          token: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        },
        {
          kind: "tokenBalance",
          label: "userTokens",
          token: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
          holder: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        },
        {
          kind: "nativeBalance",
          label: "treasury",
          address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        },
      ],
      steps: [
        {
          action: "chapter",
          title: "Connect wallet",
          description: "The app discovers the wallet over EIP-6963",
        },
        { action: "click", role: "button", name: "Connect Wallet" },
        { action: "chapter", title: "Mint a token" },
        { action: "fill", role: "textbox", name: "Amount", value: "1" },
        { action: "click", role: "button", name: "Mint" },
        {
          action: "chapter",
          title: "Verify on chain",
          description: "Supply must actually have increased",
        },
        { action: "expectVisible", role: "status", name: "Confirmed" },
      ],
      expectations: [
        { probe: "supply", expect: "increased" },
        { probe: "userTokens", expect: "increased" },
        // The assertion people skip: a mint must not quietly move the treasury.
        { probe: "treasury", expect: "unchanged" },
      ],
    },
  ],
};

/** Chain ids that are local development networks, where example values are safe. */
const LOCAL_CHAIN_IDS = new Set([31337, 1337]);

/**
 * Refuse a manifest that carries Anvil-local values onto a real chain.
 *
 * `EXAMPLE_MANIFEST` exists to be copied, and a comment is not enforcement — the failure
 * it prevents is silent, because a probe against an undeployed address returns empty
 * rather than throwing. So the check is a function a generated project can call, and
 * `validateManifest` calls it for every manifest.
 *
 * Scoped to addresses: a `chainId` of 31337 with `127.0.0.1` URLs is a correct local
 * manifest, and flagging that would make the check noise.
 */
export function assertLocalOnly(manifest: E2EManifest): string[] {
  if (LOCAL_CHAIN_IDS.has(manifest.chainId)) return [];

  const localAddresses = new Set([
    "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
    "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  ]);

  const problems: string[] = [];
  const seen = new Set<string>();

  for (const match of JSON.stringify(manifest).matchAll(/0x[a-fA-F0-9]{40}/g)) {
    const address = match[0].toLowerCase();
    if (!localAddresses.has(address) || seen.has(address)) continue;
    seen.add(address);
    problems.push(
      `${match[0]} is an Anvil/Hardhat local address but chainId is ${manifest.chainId}. ` +
        "Nothing is deployed there on a real chain: a probe reads empty and a transfer is lost, " +
        "and neither throws. Replace it with the real deployed address",
    );
  }

  // A localhost RPC on a non-local chain id is the same copy-paste mistake, one layer up.
  for (const [field, url] of [
    ["rpcUrl", manifest.rpcUrl],
    ["baseUrl", manifest.baseUrl],
  ] as const) {
    if (/127\.0\.0\.1|localhost/.test(url)) {
      problems.push(
        `${field} points at ${url} but chainId is ${manifest.chainId} — a local URL cannot reach a real chain`,
      );
    }
  }

  return problems;
}
