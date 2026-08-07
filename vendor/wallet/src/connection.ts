/**
 * Connection lifecycle — reconnection, account changes, and chain switching.
 *
 * Every rule here comes from documented wallet behaviour rather than from taste.
 *
 * ══ Never auto-connect on page load ══
 *
 * MetaMask's guidance is explicit. On load use `eth_accounts`, which is **silent** and
 * returns whatever is already permitted; use `eth_requestAccounts` **only from a user
 * gesture**, because it opens a popup. wagmi shipped this backwards once — calling
 * `eth_requestAccounts` on reconnect — and had to fix it.
 *
 * ══ `disconnect` does not mean the user disconnected ══
 *
 * EIP-1193's `disconnect` fires when the provider "cannot service RPC requests to any
 * chain at all" — a **network** condition. MetaMask's own docs say it "only happens due
 * to network connectivity issues". A developer who expected it when removing the site
 * from the connected-sites UI filed a bug; it was closed as per-spec.
 *
 * The signal for an actual user disconnect is `accountsChanged` with `[]` — and that is
 * **ambiguous with a locked wallet**, which emits exactly the same thing. Disambiguating
 * needs `wallet_getPermissions`. `interpretAccountsChanged` returns that ambiguity instead
 * of guessing, because guessing produces a UI that says "you disconnected" when the user
 * merely locked their wallet.
 *
 * ══ `accounts[0]` goes stale even when the account set does not ══
 *
 * `eth_accounts` returns accounts **most-recently-used first**, so `accounts[0]` is the
 * *selected* account. Its identity changes when the user switches accounts even though the
 * permitted set is unchanged. wagmi shipped a fix for precisely this. Cache the array and
 * you display, and sign with, the wrong address.
 *
 * ══ A resolved chain switch is not a completed chain switch ══
 *
 * MetaMask calls `net_version` against the target chain; if that call fails it **still
 * switches but never emits `chainChanged`**. The issue is closed as not-planned, so it is
 * live behaviour. Never treat the promise resolving as proof — re-read `eth_chainId`.
 */

import type { Eip1193Provider } from "./discovery.js";
import { diagnose, isChainNotAdded, type WalletDiagnosis } from "./errors.js";

/** What `accountsChanged` with an empty array might mean. It is genuinely ambiguous. */
export type AccountsMeaning =
  | { readonly kind: "accounts"; readonly accounts: readonly string[]; readonly selected: string }
  | { readonly kind: "disconnected-or-locked"; readonly detail: string };

/**
 * Interpret an `accountsChanged` payload without pretending to know more than it says.
 *
 * An empty array means the site lost access **or** the wallet is locked. Only
 * `wallet_getPermissions` separates them, so this reports the ambiguity rather than
 * inventing a verdict.
 */
export function interpretAccountsChanged(accounts: readonly string[]): AccountsMeaning {
  const first = accounts[0];
  if (accounts.length === 0 || !first) {
    return {
      kind: "disconnected-or-locked",
      detail:
        "accountsChanged fired with an empty array. This means the site lost access OR the wallet is simply locked — the two are indistinguishable here. Call wallet_getPermissions to tell them apart before telling the user they disconnected",
    };
  }
  return { kind: "accounts", accounts: [...accounts], selected: first };
}

/**
 * Read the currently selected account, silently.
 *
 * `eth_accounts` never prompts. Always re-read rather than caching: the array is ordered
 * most-recently-used first, so `accounts[0]` changes identity on an account switch even
 * when the permitted set is identical.
 */
export async function currentAccount(provider: Eip1193Provider): Promise<string | undefined> {
  const accounts = (await provider.request({ method: "eth_accounts" })) as string[] | undefined;
  return accounts?.[0];
}

/**
 * Restore a connection on page load.
 *
 * Silent by construction: it can only ever call `eth_accounts`. A caller that wants a
 * popup must invoke `connect` from a real user gesture.
 */
export async function reconnect(
  provider: Eip1193Provider,
): Promise<{ readonly connected: boolean; readonly account?: string }> {
  const account = await currentAccount(provider);
  return account ? { connected: true, account } : { connected: false };
}

/**
 * Connect. **Call only from a user gesture.**
 *
 * `eth_requestAccounts` opens the wallet UI, so calling it on load is both bad UX and the
 * documented cause of a request that outlives the page — see -32002 in `errors.ts`.
 */
export async function connect(
  provider: Eip1193Provider,
): Promise<
  | { readonly ok: true; readonly account: string }
  | { readonly ok: false; readonly diagnosis: WalletDiagnosis }
> {
  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const account = accounts?.[0];
    if (!account) {
      return {
        ok: false,
        diagnosis: {
          code: undefined,
          action: "request-permission",
          userMessage: "No account was shared. Choose an account in your wallet.",
          reasoning: "eth_requestAccounts resolved with an empty array",
          retryable: true,
        },
      };
    }
    return { ok: true, account };
  } catch (error) {
    return { ok: false, diagnosis: diagnose(error) };
  }
}

export type SwitchResult =
  | { readonly ok: true; readonly chainId: number }
  | { readonly ok: false; readonly diagnosis: WalletDiagnosis; readonly needsAdd: boolean };

/** Parse `eth_chainId`, which is hex, and which some wallets return as a number anyway. */
export function parseChainId(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, value.startsWith("0x") ? 16 : 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Switch chains, then **verify** by re-reading.
 *
 * The verification is the point. MetaMask can switch without emitting `chainChanged` when
 * its `net_version` probe against the target fails, so a UI waiting on the event hangs
 * while a UI trusting the resolved promise shows the wrong network. Neither is safe alone;
 * re-reading `eth_chainId` is.
 */
export async function switchChain(
  provider: Eip1193Provider,
  chainId: number,
): Promise<SwitchResult> {
  const hex = `0x${chainId.toString(16)}`;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hex }],
    });
  } catch (error) {
    return { ok: false, diagnosis: diagnose(error), needsAdd: isChainNotAdded(error) };
  }

  // Resolution is not proof. Re-read.
  const actual = parseChainId(await provider.request({ method: "eth_chainId" }));
  if (actual !== chainId) {
    return {
      ok: false,
      needsAdd: false,
      diagnosis: {
        code: undefined,
        action: "retry",
        userMessage: `Your wallet is still on a different network. Switch to it manually and retry.`,
        retryable: true,
        reasoning:
          `wallet_switchEthereumChain resolved but eth_chainId still reports ${actual}, not ${chainId}. ` +
          "MetaMask can switch without emitting chainChanged when its net_version probe fails, so neither the resolved promise nor the event is proof — only re-reading is",
      },
    };
  }

  return { ok: true, chainId };
}

/**
 * Subscribe to wallet events, returning one unsubscribe.
 *
 * Uses `removeListener` with the exact references it added, never `removeAllListeners`.
 * MetaMask warns explicitly that `removeAllListeners` tears down listeners the application
 * did not install — on a shared provider that silently breaks any other library.
 */
export function watch(
  provider: Eip1193Provider,
  handlers: {
    readonly onAccounts?: (meaning: AccountsMeaning) => void;
    readonly onChain?: (chainId: number | undefined) => void;
    readonly onDisconnect?: (detail: string) => void;
  },
): () => void {
  const accountsListener = (accounts: readonly string[]) =>
    handlers.onAccounts?.(interpretAccountsChanged(accounts ?? []));
  const chainListener = (chainId: unknown) => handlers.onChain?.(parseChainId(chainId));
  const disconnectListener = () =>
    handlers.onDisconnect?.(
      "EIP-1193 disconnect: the wallet cannot reach ANY chain. This is a network condition, not the user disconnecting — do not clear the session because of it",
    );

  provider.on?.("accountsChanged", accountsListener as never);
  provider.on?.("chainChanged", chainListener as never);
  provider.on?.("disconnect", disconnectListener as never);

  return () => {
    provider.removeListener?.("accountsChanged", accountsListener as never);
    provider.removeListener?.("chainChanged", chainListener as never);
    provider.removeListener?.("disconnect", disconnectListener as never);
  };
}
