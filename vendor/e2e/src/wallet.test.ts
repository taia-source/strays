/**
 * Mock wallet tests.
 *
 * The script runs in a browser, so these exercise it in a simulated page context — no
 * Playwright dependency needed to prove the provider contract holds.
 */
import { describe, expect, it, vi } from "vitest";
import { ANVIL_ACCOUNT, ANVIL_CHAIN_ID, anvilWallet, mockWalletScript } from "./wallet.js";

/** Minimal browser globals the injected script touches. */
function runInFakePage(
  script: string,
  rpcHandler?: (method: string, params: unknown[]) => unknown,
) {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const dispatched: Array<{ type: string; detail?: unknown }> = [];

  const win = {
    ethereum: undefined as never,
    addEventListener(type: string, handler: (e: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    dispatchEvent(event: { type: string; detail?: unknown }) {
      dispatched.push({ type: event.type, detail: event.detail });
      for (const h of listeners.get(event.type) ?? []) h(event);
      return true;
    },
  };

  class FakeCustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  }

  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    const result = rpcHandler ? rpcHandler(method, params) : "0xok";
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  });

  // eslint-disable-next-line no-new-func
  new Function("window", "CustomEvent", "Event", "fetch", script)(
    win,
    FakeCustomEvent,
    FakeCustomEvent,
    fetchMock,
  );

  return { win, dispatched, listeners, fetchMock };
}

describe("mockWalletScript — EIP-1193 surface", () => {
  it("reports the configured account and chain without touching the network", async () => {
    const { win, fetchMock } = runInFakePage(mockWalletScript(anvilWallet()));
    const provider = win.ethereum as never as {
      request(a: { method: string }): Promise<unknown>;
    };

    expect(await provider.request({ method: "eth_requestAccounts" })).toEqual([ANVIL_ACCOUNT]);
    expect(await provider.request({ method: "eth_chainId" })).toBe(
      `0x${ANVIL_CHAIN_ID.toString(16)}`,
    );
    expect(
      fetchMock,
      "account and chain must not require an RPC round trip",
    ).not.toHaveBeenCalled();
  });

  it("forwards unknown methods to the RPC", async () => {
    const { win, fetchMock } = runInFakePage(mockWalletScript(anvilWallet()));
    const provider = win.ethereum as never as { request(a: { method: string }): Promise<unknown> };
    await provider.request({ method: "eth_blockNumber" });
    expect(fetchMock).toHaveBeenCalled();
  });

  /** Apps branch on code 4001; a generic Error would take a different path than production. */
  it("rejects with MetaMask's 4001 shape when autoApprove is off", async () => {
    const { win } = runInFakePage(mockWalletScript({ ...anvilWallet(), autoApprove: false }));
    const provider = win.ethereum as never as { request(a: { method: string }): Promise<unknown> };
    await expect(provider.request({ method: "personal_sign" })).rejects.toMatchObject({
      code: 4001,
    });
  });

  it("records every call so a test can assert what the app asked for", async () => {
    const { win } = runInFakePage(mockWalletScript(anvilWallet()));
    const provider = win.ethereum as never as {
      request(a: { method: string }): Promise<unknown>;
      __taia: { calls(): Array<{ method: string }>; reset(): void };
    };
    await provider.request({ method: "eth_chainId" });
    await provider.request({ method: "eth_requestAccounts" });

    expect(provider.__taia.calls().map((c) => c.method)).toEqual([
      "eth_chainId",
      "eth_requestAccounts",
    ]);
    provider.__taia.reset();
    expect(provider.__taia.calls()).toEqual([]);
  });

  it("supports on/removeListener and emitting events", () => {
    const { win } = runInFakePage(mockWalletScript(anvilWallet()));
    const provider = win.ethereum as never as {
      on(e: string, h: (p: unknown) => void): unknown;
      removeListener(e: string, h: (p: unknown) => void): unknown;
      __taia: { emit(e: string, p: unknown): void };
    };

    const seen: unknown[] = [];
    const handler = (p: unknown) => seen.push(p);
    provider.on("chainChanged", handler);
    provider.__taia.emit("chainChanged", "0x1");
    expect(seen).toEqual(["0x1"]);

    provider.removeListener("chainChanged", handler);
    provider.__taia.emit("chainChanged", "0x2");
    expect(seen).toEqual(["0x1"]);
  });
});

describe("EIP-6963 discovery — the part everyone misses", () => {
  it("announces unprompted on load", () => {
    const { dispatched } = runInFakePage(mockWalletScript(anvilWallet()));
    expect(dispatched.filter((d) => d.type === "eip6963:announceProvider")).toHaveLength(1);
  });

  /**
   * THE critical behaviour. A connector that mounts after page load (i.e. every React app)
   * never sees the initial announcement — it dispatches `requestProvider` and waits. Miss
   * this and the wallet is invisible, with no error: the connect button simply does
   * nothing.
   */
  it("re-announces in response to eip6963:requestProvider", () => {
    const { win, dispatched } = runInFakePage(mockWalletScript(anvilWallet()));
    expect(dispatched).toHaveLength(1);

    win.dispatchEvent({ type: "eip6963:requestProvider" });

    const announcements = dispatched.filter((d) => d.type === "eip6963:announceProvider");
    expect(announcements, "a late-mounting connector must still discover the wallet").toHaveLength(
      2,
    );
  });

  it("publishes a frozen detail with every field the spec requires", () => {
    const { dispatched } = runInFakePage(mockWalletScript(anvilWallet()));
    const detail = dispatched[0]?.detail as
      | { info: Record<string, string>; provider: unknown }
      | undefined;

    expect(detail, "an announcement must have been dispatched").toBeDefined();
    expect(Object.isFrozen(detail), "the spec says the detail SHOULD be frozen").toBe(true);
    for (const field of ["uuid", "name", "icon", "rdns"]) {
      expect(detail?.info[field], `info.${field} is required`).toBeTruthy();
    }
    expect(detail?.provider).toBeDefined();
  });

  it("uses the configured name and rdns", () => {
    const { dispatched } = runInFakePage(
      mockWalletScript({ ...anvilWallet(), name: "Demo Wallet", rdns: "com.demo.wallet" }),
    );
    const detail = dispatched[0]?.detail as { info: Record<string, string> } | undefined;
    expect(detail).toBeDefined();
    expect(detail?.info.name).toBe("Demo Wallet");
    expect(detail?.info.rdns).toBe("com.demo.wallet");
  });
});

describe("Playwright-facing helpers", () => {
  function fakePage() {
    const scripts: string[] = [];
    const evaluated: string[] = [];
    return {
      scripts,
      evaluated,
      page: {
        async addInitScript(s: string | { content: string }) {
          scripts.push(typeof s === "string" ? s : s.content);
        },
        async evaluate<T>(fn: string): Promise<T> {
          evaluated.push(fn);
          return [] as unknown as T;
        },
      },
    };
  }

  it("installs the wallet before navigation via addInitScript", async () => {
    const { page, scripts } = fakePage();
    const { installMockWallet } = await import("./wallet.js");
    await installMockWallet(page, anvilWallet());
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("eip6963:announceProvider");
  });

  it("reads and resets the recorded call log through the page", async () => {
    const { page, evaluated } = fakePage();
    const { walletCalls, resetWalletCalls } = await import("./wallet.js");
    await walletCalls(page);
    await resetWalletCalls(page);
    expect(evaluated[0]).toContain("__taia.calls()");
    expect(evaluated[1]).toContain("__taia.reset()");
  });

  it("defaults to the Anvil account, chain and local RPC", () => {
    const w = anvilWallet();
    expect(w.address).toBe(ANVIL_ACCOUNT);
    expect(w.chainId).toBe(ANVIL_CHAIN_ID);
    expect(w.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(anvilWallet("http://host:9999").rpcUrl).toBe("http://host:9999");
  });
});

describe("gaps the reference implementations leave open", () => {
  /**
   * `wallet-mock` — the library most blog posts recommend — literally throws here:
   *   "eth_signTypedData_v4 is not yet supported"
   * That is not a corner case. EIP-712 typed data is how ERC-2612 permit approvals,
   * Seaport listings, 0x/CoW/UniswapX orders and Safe transactions work. A launchpad or
   * trading terminal hits it immediately.
   */
  it("supports EIP-712 typed-data signing", async () => {
    const { win } = runInFakePage(mockWalletScript(anvilWallet()), (method) =>
      method.startsWith("eth_signTypedData") ? "0xsigned" : "0xok",
    );
    const provider = win.ethereum as never as {
      request(a: { method: string; params?: unknown[] }): Promise<unknown>;
    };

    await expect(
      provider.request({ method: "eth_signTypedData_v4", params: [ANVIL_ACCOUNT, "{}"] }),
    ).resolves.toBe("0xsigned");
    await expect(
      provider.request({ method: "eth_signTypedData", params: [ANVIL_ACCOUNT, "{}"] }),
    ).resolves.toBe("0xsigned");
  });

  /**
   * EIP-6963 is a race: mipd may dispatch requestProvider before OR after the init script
   * runs. Announcing only on load loses it intermittently — the classic "connector
   * sometimes not found" flake.
   */
  it("announces on DOMContentLoaded as well as on load and on request", () => {
    const { win, dispatched } = runInFakePage(mockWalletScript(anvilWallet()));
    expect(dispatched).toHaveLength(1);

    win.dispatchEvent({ type: "DOMContentLoaded" });
    win.dispatchEvent({ type: "eip6963:requestProvider" });

    expect(
      dispatched.filter((d) => d.type === "eip6963:announceProvider"),
      "all three triggers must announce, or the race is lost intermittently",
    ).toHaveLength(3);
  });

  /**
   * A no-op `on` means an account- or network-switcher UI never re-renders. Testing
   * "user is on the wrong network → app shows Switch Network" requires a real emit.
   */
  it("emits chainChanged when the app switches chain", async () => {
    const { win } = runInFakePage(mockWalletScript(anvilWallet()));
    const provider = win.ethereum as never as {
      request(a: { method: string; params?: unknown[] }): Promise<unknown>;
      on(e: string, h: (p: unknown) => void): unknown;
    };

    const seen: unknown[] = [];
    provider.on("chainChanged", (c) => seen.push(c));

    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }],
    });

    expect(seen, "a switcher UI cannot re-render without this event").toEqual(["0x2105"]);
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x2105");
  });

  it("does not re-emit when switching to the chain already active", async () => {
    const { win } = runInFakePage(mockWalletScript(anvilWallet()));
    const provider = win.ethereum as never as {
      request(a: { method: string; params?: unknown[] }): Promise<unknown>;
      on(e: string, h: (p: unknown) => void): unknown;
    };
    const seen: unknown[] = [];
    provider.on("chainChanged", (c) => seen.push(c));
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x7a69" }],
    });
    expect(seen).toEqual([]);
  });
});
