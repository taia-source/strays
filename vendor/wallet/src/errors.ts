/**
 * Wallet error semantics — the part every dapp gets wrong.
 *
 * ══ Two numbering schemes, constantly confused ══
 *
 * **EIP-1193 `ProviderRpcError`** (4-digit): 4001 user rejected · 4100 unauthorized ·
 * 4200 unsupported method · 4900 disconnected from *all* chains · 4901 disconnected from
 * *the requested* chain.
 *
 * **EIP-1474 JSON-RPC** (negative): -32603 internal · -32602 invalid params · -32002
 * resource unavailable — which EIP-1474 explicitly marks **non-standard**.
 *
 * ══ 4902 is not a standard, and this matters ══
 *
 * EIP-3326 (`wallet_switchEthereumChain`) and EIP-3085 (`wallet_addEthereumChain`) are
 * both **Stagnant**, and **neither defines any error code at all** — EIP-3326 says only
 * that the wallet returns `null` on success "and an error otherwise".
 *
 * 4902 appears in no EIP. Verified against MetaMask's own `@metamask/rpc-errors`
 * `error-constants.ts`: it defines 4001, 4100, 4200, 4900 and 4901 — **4902 is absent**.
 * MetaMask's source passes it as a literal, commented `// To-be-standardized`. Coinbase
 * Wallet SDK labels it `standard: 'EIP-3085'`, which is factually wrong and is a likely
 * source of the belief that it is standardised.
 *
 * The practical consequence: **you cannot rely on 4902 alone.**
 *
 *   - **MetaMask Mobile wraps it in -32603**, so the real code is at
 *     `error.data.originalError.code`. wagmi still ships this unwrap today.
 *   - **WalletConnect relays codes unreliably**, which is why wagmi falls back to a
 *     regex on the message rather than trusting the code.
 *
 * `isChainNotAdded` therefore checks the code, the nested code, *and* the message.
 *
 * ══ -32002 must never be retried ══
 *
 * "Request already pending" lives in the extension and **survives a page reload**, so
 * "reload and try again" makes it strictly worse and the promise can stay pending
 * indefinitely. The only correct response is to tell the user to open their wallet. wagmi
 * itself shipped this backwards once.
 *
 * ══ -32603 carries no meaning ══
 *
 * It is a catch-all wallets stuff revert reasons and internal failures into. Branching on
 * it is how a "chain not added" gets reported as "something went wrong".
 */

/** What the application should actually do. The reason this module exists. */
export type ErrorAction =
  | "user-cancelled"
  | "open-wallet"
  | "add-chain-first"
  | "request-permission"
  | "unsupported"
  | "network-down"
  | "retry"
  | "report";

export type WalletDiagnosis = {
  readonly code: number | undefined;
  readonly action: ErrorAction;
  /** Fit to show a user. Never "Error: -32603". */
  readonly userMessage: string;
  /** Why this action, for a developer reading logs. */
  readonly reasoning: string;
  /** Whether retrying the identical call could possibly help. */
  readonly retryable: boolean;
};

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  data?: { originalError?: { code?: unknown; message?: unknown } } | unknown;
};

/** Read a numeric code from the shapes wallets actually produce. */
export function extractCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as ErrorLike;
  if (typeof e.code === "number") return e.code;

  // MetaMask Mobile nests the real code under data.originalError.
  const nested = (e.data as { originalError?: { code?: unknown } } | undefined)?.originalError
    ?.code;
  return typeof nested === "number" ? nested : undefined;
}

/**
 * Every message a wallet might carry, flattened for matching.
 *
 * Lower-cased on **every** path. The callers' regexes are written lower-case with no `i`
 * flag, so a path that returns the raw text silently matches nothing: `throw "User
 * rejected the request"` — a real shape, since a rejection crossing `postMessage` cannot
 * carry an Error and degrades to its message string — would be classified as an unknown
 * failure and offered a retry, while the identical text inside `{ message }` matched.
 */
function messages(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error ?? "").toLowerCase();
  const e = error as ErrorLike;
  const nested = (e.data as { originalError?: { message?: unknown } } | undefined)?.originalError
    ?.message;
  return [e.message, nested]
    .filter((m) => typeof m === "string")
    .join(" ")
    .toLowerCase();
}

/**
 * Did the user reject this?
 *
 * Code first, message second. WalletConnect relays codes unreliably enough that wagmi
 * matches on the message for that connector — so message matching is a documented
 * necessity here, not laziness.
 */
export function isUserRejection(error: unknown): boolean {
  if (extractCode(error) === 4001) return true;
  const text = messages(error);
  return /user rejected|user denied|user cancell?ed|rejected by user/.test(text);
}

/**
 * Does this mean "the chain is not in the wallet yet"?
 *
 * Three routes, because one is not enough: the top-level code, MetaMask Mobile's nested
 * code under -32603, and the message text for relays that drop codes entirely.
 */
export function isChainNotAdded(error: unknown): boolean {
  if (extractCode(error) === 4902) return true;

  const e = error as ErrorLike | null;
  const nested = (e?.data as { originalError?: { code?: unknown } } | undefined)?.originalError
    ?.code;
  if (nested === 4902) return true;

  const text = messages(error);
  return /unrecognized chain|unrecognised chain|chain.*not.*added|try adding the chain|addethereumchain/.test(
    text,
  );
}

/** Is a request already waiting in the wallet UI? */
export function isRequestPending(error: unknown): boolean {
  if (extractCode(error) === -32002) return true;
  return /already pending|request is pending|already processing/.test(messages(error));
}

/**
 * Turn any wallet error into an action.
 *
 * Ordered by specificity, not by code value: the specific conditions are checked before
 * the catch-alls, because -32603 can *contain* a 4902 and reading the outer code first
 * would report a fixable problem as an unknown failure.
 */
export function diagnose(error: unknown): WalletDiagnosis {
  const code = extractCode(error);

  if (isUserRejection(error)) {
    return {
      code,
      action: "user-cancelled",
      userMessage: "You cancelled the request.",
      reasoning: "EIP-1193 4001, or a message match for relays that drop codes",
      retryable: true,
    };
  }

  if (isRequestPending(error)) {
    return {
      code,
      action: "open-wallet",
      userMessage: "Your wallet is already asking you to approve something — open it to continue.",
      reasoning:
        "-32002. MUST NOT be retried: the pending request lives in the extension and survives a page reload, so retrying or reloading makes it worse and can leave the promise pending forever",
      retryable: false,
    };
  }

  // Before the -32603 catch-all: MetaMask Mobile hides 4902 inside -32603.
  if (isChainNotAdded(error)) {
    return {
      code,
      action: "add-chain-first",
      userMessage: "That network is not in your wallet yet — approve adding it, then retry.",
      reasoning:
        "4902 (or nested under -32603 on MetaMask Mobile). Not standardised: it is in no EIP and absent from MetaMask's own rpc-errors constants, so the code alone cannot be trusted",
      retryable: false,
    };
  }

  switch (code) {
    case 4100:
      return {
        code,
        action: "request-permission",
        userMessage: "Connect your wallet to continue.",
        reasoning: "EIP-1193 4100 — the account or method is not authorised yet",
        retryable: false,
      };
    case 4200:
      return {
        code,
        action: "unsupported",
        userMessage: "Your wallet does not support this action.",
        reasoning: "EIP-1193 4200 — feature-detect by calling and handling this, never by rdns",
        retryable: false,
      };
    case 4900:
      return {
        code,
        action: "network-down",
        userMessage: "Your wallet is offline.",
        reasoning: "EIP-1193 4900 — disconnected from ALL chains",
        retryable: true,
      };
    case 4901:
      return {
        code,
        action: "network-down",
        userMessage: "Your wallet is not connected to this network.",
        reasoning: "EIP-1193 4901 — disconnected from the REQUESTED chain, unlike 4900",
        retryable: true,
      };
    case -32602:
      return {
        code,
        action: "report",
        userMessage: "Something is wrong with this request. Please report it.",
        reasoning:
          "-32602 invalid params — a bug in the dapp, not the user. MetaMask returns this for a malformed wallet_addEthereumChain rather than a dedicated code",
        retryable: false,
      };
    case -32603:
      return {
        code,
        action: "report",
        userMessage: "Your wallet reported an internal error.",
        reasoning:
          "-32603 is a catch-all with no reliable semantics — wallets stuff revert reasons and internal failures into it. Never branch on it; the specific checks above already unwrapped anything meaningful",
        retryable: true,
      };
    default:
      return {
        code,
        action: "report",
        userMessage: "Something went wrong talking to your wallet.",
        reasoning: code === undefined ? "no code on the error" : `unrecognised code ${code}`,
        retryable: true,
      };
  }
}

/**
 * The params MetaMask actually requires for `wallet_addEthereumChain`.
 *
 * EIP-3085 marks `chainName` and `nativeCurrency` optional; **MetaMask requires both**,
 * and rejects violations with -32602 rather than anything specific. Validating before the
 * call turns a confusing wallet popup into a build-time error.
 */
export type AddChainParams = {
  readonly chainId: string;
  readonly chainName: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly rpcUrls: readonly string[];
  readonly blockExplorerUrls?: readonly string[];
};

/** Each field explicitly `| undefined`: `exactOptionalPropertyTypes` distinguishes an
 * ABSENT property from one set to undefined, and a caller building params from optional
 * config produces the latter. */
export type PartialAddChainParams = {
  readonly [K in keyof AddChainParams]?: AddChainParams[K] | undefined;
};

export function validateAddChainParams(params: PartialAddChainParams): string[] {
  const problems: string[] = [];

  if (!params.chainId || !/^0x[0-9a-f]+$/i.test(params.chainId)) {
    problems.push(
      `chainId must be a 0x-prefixed hex string, got ${JSON.stringify(params.chainId)}`,
    );
  }
  if (!params.chainName?.trim()) {
    problems.push("chainName is required by MetaMask even though EIP-3085 marks it optional");
  }

  const currency = params.nativeCurrency;
  if (!currency) {
    problems.push("nativeCurrency is required by MetaMask even though EIP-3085 marks it optional");
  } else {
    if (!currency.symbol || currency.symbol.length < 2 || currency.symbol.length > 6) {
      problems.push(`nativeCurrency.symbol must be 2-6 characters, got "${currency.symbol}"`);
    }
    if (currency.decimals !== 18) {
      // Not a hard MetaMask rule, but a non-18 native currency is nearly always a mistake
      // and silently produces amounts wrong by orders of magnitude.
      problems.push(
        `nativeCurrency.decimals is ${currency.decimals}; native currencies are 18 almost everywhere — confirm this is deliberate`,
      );
    }
  }

  if (!params.rpcUrls || params.rpcUrls.length === 0) {
    problems.push("rpcUrls must contain at least one URL");
  } else {
    for (const url of params.rpcUrls) {
      if (!url.startsWith("https://") && !url.startsWith("wss://")) {
        problems.push(
          `rpcUrls entry "${url}" must be https:// or wss:// — MetaMask rejects http://`,
        );
      }
    }
    // Worth saying out loud: a fallback list here is a false comfort.
    if (params.rpcUrls.length > 1) {
      problems.push(
        "only the FIRST rpcUrls entry is used by MetaMask — later entries are not fallbacks and will never be tried",
      );
    }
  }

  return problems;
}
