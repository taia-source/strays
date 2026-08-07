/**
 * A mock wallet injected into the page — no browser extension involved.
 *
 * ══ Why not Synpress ══
 *
 * Synpress drives the real MetaMask extension. That is the right tool for a small smoke
 * suite and the wrong one for the main suite: it is slow, it needs a downloaded extension,
 * and it is low-velocity (v4.1.2 shipped 2026-01-10, ~6.5 months stale at time of
 * writing). It also cannot run headless in every environment.
 *
 * Injecting an EIP-1193 provider backed by an Anvil account removes the extension
 * entirely. It is faster, deterministic, and — critically for a system that generates
 * projects — it has no dependency that can go stale underneath us.
 *
 * The real MetaMask path stays worthwhile for a handful of smoke tests, because a mock
 * cannot catch an extension-specific incompatibility. That is a deliberate 80/20, not an
 * oversight.
 *
 * ══ The part everyone misses: EIP-6963 ══
 *
 * Setting `window.ethereum` alone is no longer enough. Modern connectors (wagmi,
 * RainbowKit) discover wallets via EIP-6963, and the spec requires the wallet to dispatch
 * `eip6963:announceProvider` **twice**:
 *
 *   1. once on load, unprompted
 *   2. again every time the dapp dispatches `eip6963:requestProvider`
 *
 * Miss the second and the wallet is invisible to any connector that mounts after the
 * initial announcement — which is most of them, since React mounts after page load. The
 * failure looks like "connect button does nothing", with no error.
 */

/** Anvil's first default account. The mnemonic is public, so this is not a secret. */
export const ANVIL_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
export const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const ANVIL_CHAIN_ID = 31337;

export type MockWalletConfig = {
  /** Account the dapp will see as connected. */
  readonly address: `0x${string}`;
  readonly chainId: number;
  /** Where the provider forwards real RPC calls. */
  readonly rpcUrl: string;
  /** Shown in wallet-selection UIs. */
  readonly name?: string;
  readonly rdns?: string;
  /**
   * Auto-approve `eth_sendTransaction` and signing requests.
   *
   * Default true, because a mock that prompts has no one to answer it. Set false to test
   * the rejection path — which is worth testing, since a user declining is a normal flow
   * that apps routinely handle badly.
   */
  readonly autoApprove?: boolean;
};

/**
 * Browser-side script that installs the provider.
 *
 * Returned as a string for `page.addInitScript`, so it runs before any app code and the
 * wallet exists before React mounts. Written as a self-contained IIFE with no imports —
 * it executes in the page, not in Node.
 */
export function mockWalletScript(config: MockWalletConfig): string {
  const {
    address,
    chainId,
    rpcUrl,
    name = "Taia Test Wallet",
    rdns = "dev.taia.testwallet",
    autoApprove = true,
  } = config;

  return `(() => {
  const ADDRESS = ${JSON.stringify(address)};
  const CHAIN_ID = ${JSON.stringify(chainId)};
  const RPC_URL = ${JSON.stringify(rpcUrl)};
  const AUTO_APPROVE = ${autoApprove ? "true" : "false"};
  let currentChainId = "0x" + CHAIN_ID.toString(16);

  let requestId = 0;
  const listeners = new Map();
  // Every request is recorded so a test can assert WHAT the app asked for, not just that
  // something happened. This is how you catch an app that silently requests the wrong chain.
  const calls = [];

  async function rpc(method, params) {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params: params ?? [] }),
    });
    const json = await res.json();
    if (json.error) {
      const err = new Error(json.error.message);
      err.code = json.error.code;
      throw err;
    }
    return json.result;
  }

  const provider = {
    isMetaMask: true,
    isTaiaMock: true,

    async request({ method, params }) {
      calls.push({ method, params: params ?? [] });

      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [ADDRESS];
        case "eth_chainId":
          return currentChainId;
        case "net_version":
          return String(Number.parseInt(currentChainId, 16));
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain": {
          const requested = params?.[0]?.chainId;
          if (requested && requested !== currentChainId) {
            currentChainId = requested;
            for (const h of listeners.get("chainChanged") ?? []) h(currentChainId);
          }
          return null;
        }
        case "wallet_getPermissions":
        case "wallet_requestPermissions":
          return [{ parentCapability: "eth_accounts" }];

        case "eth_sendTransaction":
        case "personal_sign":
        case "eth_sign":
        case "eth_signTypedData":
        case "eth_signTypedData_v4": {
          if (!AUTO_APPROVE) {
            // The shape MetaMask uses for a user rejection. Apps branch on code 4001,
            // so a generic Error would take a different path than production.
            const err = new Error("User rejected the request.");
            err.code = 4001;
            throw err;
          }
          if (method === "eth_sendTransaction") {
            const tx = { ...(params?.[0] ?? {}) };
            if (!tx.from) tx.from = ADDRESS;
            // Anvil signs for its own unlocked accounts, so this really executes.
            return await rpc("eth_sendTransaction", [tx]);
          }
          return await rpc(method, params);
        }

        default:
          return await rpc(method, params);
      }
    },

    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return provider;
    },
    removeListener(event, handler) {
      listeners.get(event)?.delete(handler);
      return provider;
    },

    // Test hooks. Namespaced so they cannot collide with a real wallet's surface.
    __taia: {
      calls: () => calls.slice(),
      reset: () => { calls.length = 0; },
      emit: (event, payload) => {
        for (const h of listeners.get(event) ?? []) h(payload);
      },
    },
  };

  window.ethereum = provider;

  // EIP-6963. The detail object must be frozen per the spec, and the announcement must
  // fire BOTH on load and on every request — a connector mounting after page load only
  // ever sees the response to its own request.
  const detail = Object.freeze({
    info: Object.freeze({
      uuid: "00000000-0000-4000-8000-000000000001",
      name: ${JSON.stringify(name)},
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
      rdns: ${JSON.stringify(rdns)},
    }),
    provider,
  });

  const announce = () =>
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));

  // EIP-6963 is a race: mipd (which wagmi uses by default) may dispatch
  // requestProvider before or after this script runs. Announcing once loses the race
  // intermittently and produces "connector sometimes not found" — announce on all three.
  window.addEventListener("eip6963:requestProvider", announce);
  window.addEventListener("DOMContentLoaded", announce);
  announce();
})();`;
}

/**
 * Minimal Playwright surface this package needs.
 *
 * Typed structurally rather than importing `@playwright/test`, so consumers are not forced
 * to install Playwright to use the rest of the package (or to typecheck it).
 */
export type PageLike = {
  addInitScript(script: string | { content: string }): Promise<void>;
  evaluate<T>(fn: string): Promise<T>;
};

/** Install the wallet. Must be called BEFORE the first navigation. */
export async function installMockWallet(page: PageLike, config: MockWalletConfig): Promise<void> {
  await page.addInitScript(mockWalletScript(config));
}

/** Anvil defaults, for the common local case. */
export function anvilWallet(rpcUrl = "http://127.0.0.1:8545"): MockWalletConfig {
  return { address: ANVIL_ACCOUNT, chainId: ANVIL_CHAIN_ID, rpcUrl };
}

export type RpcCall = { readonly method: string; readonly params: readonly unknown[] };

/**
 * Every RPC the app made, in order.
 *
 * Lets a test assert on intent rather than side effects — e.g. that the app requested the
 * chain it claims to support. An app that silently asks for the wrong chain still
 * "works" until a user has funds on the other one.
 */
export function walletCalls(page: PageLike): Promise<RpcCall[]> {
  return page.evaluate<RpcCall[]>("window.ethereum.__taia.calls()");
}

export function resetWalletCalls(page: PageLike): Promise<void> {
  return page.evaluate<void>("window.ethereum.__taia.reset()");
}
