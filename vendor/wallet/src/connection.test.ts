import { describe, expect, it, vi } from "vitest";
import {
  connect,
  currentAccount,
  interpretAccountsChanged,
  parseChainId,
  reconnect,
  switchChain,
  watch,
} from "./connection.js";
import type { Eip1193Provider } from "./discovery.js";

const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** A provider whose responses are scripted per method. */
function fake(responses: Record<string, unknown | (() => unknown)>): Eip1193Provider & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async request({ method }) {
      calls.push(method);
      const value = responses[method];
      const resolved = typeof value === "function" ? (value as () => unknown)() : value;
      if (resolved instanceof Error) throw resolved;
      return resolved;
    },
  };
}

describe("interpretAccountsChanged", () => {
  it("reports the selected account", () => {
    const meaning = interpretAccountsChanged([ACCOUNT, OTHER]);
    expect(meaning.kind).toBe("accounts");
    if (meaning.kind === "accounts") expect(meaning.selected).toBe(ACCOUNT);
  });

  /**
   * An empty array is genuinely ambiguous — the site lost access, OR the wallet is
   * merely locked. Both emit exactly this. Guessing produces a UI that tells a user they
   * disconnected when they only locked their wallet.
   */
  it("refuses to guess between disconnected and locked", () => {
    const meaning = interpretAccountsChanged([]);
    expect(meaning.kind).toBe("disconnected-or-locked");
    if (meaning.kind === "disconnected-or-locked") {
      expect(meaning.detail).toContain("wallet_getPermissions");
    }
  });
});

describe("currentAccount", () => {
  it("uses the silent eth_accounts, never the prompting call", async () => {
    const provider = fake({ eth_accounts: [ACCOUNT] });
    await currentAccount(provider);
    expect(provider.calls).toEqual(["eth_accounts"]);
    expect(provider.calls).not.toContain("eth_requestAccounts");
  });

  /**
   * eth_accounts returns accounts most-recently-used first, so accounts[0] is the
   * SELECTED account and its identity changes on an account switch even when the
   * permitted set does not. Caching it displays and signs with the wrong address —
   * wagmi shipped a fix for exactly this.
   */
  it("re-reads rather than caching, so an account switch is seen", async () => {
    let accounts = [ACCOUNT, OTHER];
    const provider = fake({ eth_accounts: () => accounts });

    expect(await currentAccount(provider)).toBe(ACCOUNT);
    accounts = [OTHER, ACCOUNT]; // same set, different selection
    expect(await currentAccount(provider)).toBe(OTHER);
  });

  it("returns undefined when nothing is permitted", async () => {
    expect(await currentAccount(fake({ eth_accounts: [] }))).toBeUndefined();
  });
});

describe("reconnect", () => {
  it("cannot prompt, by construction", async () => {
    const provider = fake({ eth_accounts: [ACCOUNT] });
    const result = await reconnect(provider);
    expect(result).toEqual({ connected: true, account: ACCOUNT });
    // MetaMask: "Never auto-connect on page load." wagmi once shipped the opposite.
    expect(provider.calls).not.toContain("eth_requestAccounts");
  });

  it("reports not-connected without throwing", async () => {
    expect(await reconnect(fake({ eth_accounts: [] }))).toEqual({ connected: false });
  });
});

describe("connect", () => {
  it("returns the account on success", async () => {
    const result = await connect(fake({ eth_requestAccounts: [ACCOUNT] }));
    expect(result).toEqual({ ok: true, account: ACCOUNT });
  });

  it("diagnoses a rejection instead of throwing", async () => {
    const result = await connect(
      fake({ eth_requestAccounts: Object.assign(new Error("rejected"), { code: 4001 }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnosis.action).toBe("user-cancelled");
  });

  it("treats an empty result as a failure, not a connection", async () => {
    const result = await connect(fake({ eth_requestAccounts: [] }));
    expect(result.ok).toBe(false);
  });

  it("surfaces a pending request as open-wallet, not retry", async () => {
    const result = await connect(
      fake({ eth_requestAccounts: Object.assign(new Error("already pending"), { code: -32002 }) }),
    );
    if (!result.ok) {
      expect(result.diagnosis.action).toBe("open-wallet");
      expect(result.diagnosis.retryable).toBe(false);
    }
  });
});

describe("parseChainId", () => {
  it("parses hex, decimal strings and numbers", () => {
    expect(parseChainId("0x1237")).toBe(4663);
    expect(parseChainId(4663)).toBe(4663);
    expect(parseChainId("4663")).toBe(4663);
  });

  it("returns undefined for junk", () => {
    expect(parseChainId(undefined)).toBeUndefined();
    expect(parseChainId("not a chain")).toBeUndefined();
  });
});

describe("switchChain", () => {
  it("succeeds when the wallet really switched", async () => {
    const provider = fake({ wallet_switchEthereumChain: null, eth_chainId: "0x1237" });
    expect(await switchChain(provider, 4663)).toEqual({ ok: true, chainId: 4663 });
  });

  it("sends the chainId as hex", async () => {
    const seen: unknown[] = [];
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        seen.push({ method, params });
        return method === "eth_chainId" ? "0x1237" : null;
      },
    };
    await switchChain(provider, 4663);
    expect(seen[0]).toEqual({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x1237" }],
    });
  });

  /**
   * The assertion this module exists for.
   *
   * MetaMask calls net_version against the target chain; if that fails it STILL switches
   * but never emits chainChanged — the issue is closed as not-planned, so it is live
   * behaviour. A UI waiting on the event hangs; a UI trusting the resolved promise shows
   * the wrong network. Only re-reading eth_chainId is safe.
   */
  it("fails when the wallet resolved but did not actually switch", async () => {
    const provider = fake({ wallet_switchEthereumChain: null, eth_chainId: "0x1" });
    const result = await switchChain(provider, 4663);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnosis.reasoning).toContain("resolved but eth_chainId still reports 1");
      expect(result.diagnosis.reasoning).toContain("only re-reading is");
    }
  });

  it("flags needsAdd on a bare 4902", async () => {
    const provider = fake({
      wallet_switchEthereumChain: Object.assign(new Error("unrecognized"), { code: 4902 }),
    });
    const result = await switchChain(provider, 4663);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.needsAdd).toBe(true);
      expect(result.diagnosis.action).toBe("add-chain-first");
    }
  });

  it("flags needsAdd on MetaMask Mobile's nested 4902", async () => {
    const provider = fake({
      wallet_switchEthereumChain: Object.assign(new Error("internal"), {
        code: -32603,
        data: { originalError: { code: 4902 } },
      }),
    });
    const result = await switchChain(provider, 4663);
    if (!result.ok) expect(result.needsAdd).toBe(true);
  });

  it("does not flag needsAdd on a plain rejection", async () => {
    const provider = fake({
      wallet_switchEthereumChain: Object.assign(new Error("rejected"), { code: 4001 }),
    });
    const result = await switchChain(provider, 4663);
    if (!result.ok) {
      expect(result.needsAdd).toBe(false);
      expect(result.diagnosis.action).toBe("user-cancelled");
    }
  });
});

describe("watch", () => {
  function eventful() {
    const handlers = new Map<string, Array<(...a: never[]) => void>>();
    const removed: string[] = [];
    const provider: Eip1193Provider = {
      request: async () => undefined,
      on(event, listener) {
        handlers.set(event, [...(handlers.get(event) ?? []), listener]);
      },
      removeListener(event, listener) {
        removed.push(event);
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((l) => l !== listener),
        );
      },
    };
    const emit = (event: string, ...args: unknown[]) => {
      for (const h of handlers.get(event) ?? []) (h as (...a: unknown[]) => void)(...args);
    };
    return { provider, emit, removed, count: (e: string) => (handlers.get(e) ?? []).length };
  }

  it("reports an account switch through the interpreter", () => {
    const { provider, emit } = eventful();
    const onAccounts = vi.fn();
    watch(provider, { onAccounts });

    emit("accountsChanged", [OTHER, ACCOUNT]);
    expect(onAccounts).toHaveBeenCalledWith({
      kind: "accounts",
      accounts: [OTHER, ACCOUNT],
      selected: OTHER,
    });
  });

  it("passes the empty-array ambiguity through rather than resolving it", () => {
    const { provider, emit } = eventful();
    const onAccounts = vi.fn();
    watch(provider, { onAccounts });
    emit("accountsChanged", []);
    expect(onAccounts.mock.calls[0]?.[0]).toMatchObject({ kind: "disconnected-or-locked" });
  });

  /**
   * `accountsChanged` with NO payload at all.
   *
   * The EIP-1193 type says the listener receives `string[]`, and the fake above dutifully
   * forwards whatever it is given — but a provider is untrusted code on the page, and a
   * wallet emitting the event with no argument is not hypothetical. Without the `?? []`
   * normalisation `interpretAccountsChanged(undefined)` reads `.length` off undefined and
   * the listener throws INSIDE the wallet's own emit loop, which on a shared provider
   * kills every other subscriber's handler for that event too.
   *
   * The assertion is that this arrives as the disconnected-or-locked ambiguity — the same
   * verdict as `[]`, which is the only honest reading of "the wallet told us nothing".
   */
  it("survives an accountsChanged emitted with no payload", () => {
    const { provider, emit } = eventful();
    const onAccounts = vi.fn();
    watch(provider, { onAccounts });

    expect(() => emit("accountsChanged")).not.toThrow();
    expect(onAccounts).toHaveBeenCalledTimes(1);
    expect(onAccounts.mock.calls[0]?.[0]).toEqual({
      kind: "disconnected-or-locked",
      detail: expect.stringContaining("wallet_getPermissions"),
    });
  });

  it("parses the hex chainId from chainChanged", () => {
    const { provider, emit } = eventful();
    const onChain = vi.fn();
    watch(provider, { onChain });
    emit("chainChanged", "0x1237");
    expect(onChain).toHaveBeenCalledWith(4663);
  });

  /**
   * EIP-1193 `disconnect` means "cannot reach ANY chain" — a network condition. A dev who
   * expected it when removing the site from connected-sites filed a bug; it was closed as
   * per-spec. Clearing the session on it logs users out when their wifi drops.
   */
  it("explains that disconnect is a network event, not a user action", () => {
    const { provider, emit } = eventful();
    const onDisconnect = vi.fn();
    watch(provider, { onDisconnect });
    emit("disconnect", { code: 4900 });
    expect(onDisconnect.mock.calls[0]?.[0]).toContain("not the user disconnecting");
  });

  /**
   * MetaMask warns that removeAllListeners tears down listeners the app did not install.
   * On a shared provider that silently breaks any other library on the page.
   */
  it("removes only its own listeners, by reference", () => {
    const { provider, removed, count } = eventful();
    const unwatch = watch(provider, { onAccounts: () => {} });
    expect(count("accountsChanged")).toBe(1);

    unwatch();
    expect(count("accountsChanged")).toBe(0);
    expect(removed).toEqual(["accountsChanged", "chainChanged", "disconnect"]);
  });

  it("does not throw on a provider with no event support", () => {
    const bare: Eip1193Provider = { request: async () => undefined };
    expect(() => watch(bare, { onAccounts: () => {} })()).not.toThrow();
  });
});
