import { describe, expect, it } from "vitest";
import {
  diagnose,
  extractCode,
  isChainNotAdded,
  isRequestPending,
  isUserRejection,
  validateAddChainParams,
} from "./errors.js";

describe("extractCode", () => {
  it("reads a top-level code", () => {
    expect(extractCode({ code: 4001 })).toBe(4001);
  });

  /**
   * MetaMask Mobile wraps the real code inside -32603. wagmi still ships this unwrap
   * today, which is how load-bearing it is.
   */
  it("reads the nested code MetaMask Mobile hides under -32603", () => {
    expect(extractCode({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(-32603);
    expect(isChainNotAdded({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(true);
  });

  it("returns undefined rather than throwing on junk", () => {
    expect(extractCode(undefined)).toBeUndefined();
    expect(extractCode("a string")).toBeUndefined();
    expect(extractCode({ code: "4001" })).toBeUndefined();
  });

  /**
   * The nested code is the ONLY usable one.
   *
   * The test above nests 4902 under a numeric -32603, so the top-level `code` short-
   * circuits and the nested read is never what produces the answer. This is the shape
   * where it is: a relay that stringifies the outer code — WalletConnect is documented as
   * unreliable about codes, and JSON-RPC transports that round-trip through a bridge
   * routinely hand back `"-32603"`. With `typeof e.code === "number"` failing, falling
   * through to `data.originalError.code` is the difference between diagnosing
   * "add the chain" and reporting an unknown failure the user cannot act on.
   */
  it("falls through to the nested code when the outer one is not a number", () => {
    const error = { code: "-32603", data: { originalError: { code: 4902 } } };
    expect(extractCode(error)).toBe(4902);
    expect(diagnose(error).action).toBe("add-chain-first");
  });

  it("still returns undefined when the nested code is not a number either", () => {
    expect(
      extractCode({ code: "-32603", data: { originalError: { code: "4902" } } }),
    ).toBeUndefined();
  });
});

describe("isUserRejection", () => {
  it("recognises 4001", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
  });

  /**
   * WalletConnect relays codes unreliably enough that wagmi falls back to a message regex
   * for that connector. Message matching here is a documented necessity, not laziness.
   */
  it("recognises a rejection with no usable code", () => {
    expect(isUserRejection({ message: "User rejected the request" })).toBe(true);
    expect(isUserRejection({ message: "user denied transaction signature" })).toBe(true);
    expect(isUserRejection({ message: "User Cancelled" })).toBe(true);
  });

  it("does not treat an unrelated failure as a rejection", () => {
    expect(isUserRejection({ code: -32603, message: "internal error" })).toBe(false);
  });

  /**
   * A thrown primitive, not an Error object. THIS CAUGHT A REAL BUG.
   *
   * `provider.request` is untrusted code and nothing forces it to reject with an Error.
   * `throw "User rejected the request"` is a real shape: a rejection crossing a
   * `postMessage` boundary — every mobile in-app browser and WalletConnect relay — cannot
   * carry an Error and degrades to its message string.
   *
   * `messages()` returned that primitive path WITHOUT `.toLowerCase()`, while the object
   * path lower-cased before returning. Every caller's regex is written lower-case with no
   * `i` flag, so the capitalised wording MetaMask actually uses matched nothing: a
   * deliberate user cancellation was diagnosed as an unknown failure and offered a retry,
   * re-prompting the user for the thing they just declined. Fixed by lower-casing on both
   * paths.
   *
   * The load-bearing assertion is the last one — the SAME text must classify the same way
   * whether it arrives as a string or inside `{ message }`. That equivalence is what the
   * bug broke, and asserting only the string form would let the asymmetry return.
   */
  it("classifies a rejection thrown as a bare string, with the casing wallets use", () => {
    expect(isUserRejection("User rejected the request")).toBe(true);
    expect(isUserRejection("MetaMask Tx Signature: User denied transaction signature.")).toBe(true);
    expect(diagnose("User rejected the request").action).toBe("user-cancelled");

    // A thrown string must diagnose identically to the same text on an Error object.
    for (const text of [
      "User rejected the request",
      "User Denied Transaction Signature",
      "Request already pending",
      "Unrecognized chain ID. Try adding the chain using wallet_addEthereumChain first.",
    ]) {
      expect(diagnose(text).action, text).toBe(diagnose({ message: text }).action);
    }
  });

  /**
   * The other two classifiers read through the same `messages()` helper, so the casing
   * bug above hit them identically — a pending request thrown as a capitalised string
   * would have been marked retryable, which is the single most harmful misdiagnosis in
   * this module: -32002 survives a page reload and retrying makes it strictly worse.
   */
  it("classifies pending and chain-not-added from capitalised thrown strings too", () => {
    expect(isRequestPending("Request Already Pending")).toBe(true);
    expect(isChainNotAdded("Unrecognized Chain ID. Try Adding The Chain.")).toBe(true);

    const pending = diagnose("Request of type wallet_requestPermissions Already Pending");
    expect(pending.action).toBe("open-wallet");
    expect(pending.retryable).toBe(false);
  });

  it("does not see a rejection in an unrelated primitive", () => {
    expect(isUserRejection("network unreachable")).toBe(false);
    expect(isUserRejection(null)).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
    expect(isUserRejection(4001)).toBe(false); // the NUMBER 4001 is not the CODE 4001
  });
});

describe("isChainNotAdded", () => {
  it("recognises the bare 4902", () => {
    expect(isChainNotAdded({ code: 4902 })).toBe(true);
  });

  it("recognises it nested under -32603", () => {
    expect(isChainNotAdded({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(true);
  });

  it("recognises it from the message when the code is lost in relay", () => {
    expect(
      isChainNotAdded({
        message: "Unrecognized chain ID. Try adding the chain using wallet_addEthereumChain first.",
      }),
    ).toBe(true);
  });

  it("does not fire on an unrelated -32603", () => {
    expect(isChainNotAdded({ code: -32603, message: "internal error" })).toBe(false);
  });
});

describe("isRequestPending", () => {
  it("recognises -32002 and its message form", () => {
    expect(isRequestPending({ code: -32002 })).toBe(true);
    expect(
      isRequestPending({ message: "Request of type wallet_requestPermissions already pending" }),
    ).toBe(true);
  });
});

describe("diagnose", () => {
  it("turns a rejection into a calm message, and allows a retry", () => {
    const d = diagnose({ code: 4001 });
    expect(d.action).toBe("user-cancelled");
    expect(d.retryable).toBe(true);
    expect(d.userMessage).not.toContain("4001");
  });

  /**
   * The most consequential single assertion here.
   *
   * A pending request lives in the extension and survives a page reload, so retrying or
   * reloading makes it worse and can leave the promise pending forever. wagmi shipped this
   * backwards once.
   */
  it("marks a pending request NOT retryable and says to open the wallet", () => {
    const d = diagnose({ code: -32002 });
    expect(d.action).toBe("open-wallet");
    expect(d.retryable).toBe(false);
    expect(d.reasoning).toContain("survives a page reload");
  });

  /**
   * Ordering: the specific checks must run before the -32603 catch-all, because -32603 can
   * CONTAIN a 4902. Reading the outer code first reports a fixable problem as unknown.
   */
  it("sees a nested 4902 rather than reporting the outer -32603", () => {
    const d = diagnose({ code: -32603, data: { originalError: { code: 4902 } } });
    expect(d.action).toBe("add-chain-first");
    expect(d.reasoning).toContain("in no EIP");
  });

  it("distinguishes 4900 from 4901", () => {
    expect(diagnose({ code: 4900 }).reasoning).toContain("ALL chains");
    expect(diagnose({ code: 4901 }).reasoning).toContain("REQUESTED chain");
  });

  it("treats 4200 as a signal to feature-detect, not to check rdns", () => {
    const d = diagnose({ code: 4200 });
    expect(d.action).toBe("unsupported");
    expect(d.reasoning).toContain("never by rdns");
  });

  it("says -32603 carries no meaning rather than inventing one", () => {
    const d = diagnose({ code: -32603, message: "internal" });
    expect(d.action).toBe("report");
    expect(d.reasoning).toContain("catch-all");
  });

  it("blames the dapp for -32602, not the user", () => {
    expect(diagnose({ code: -32602 }).reasoning).toContain("a bug in the dapp");
  });

  it("handles an error with no code at all", () => {
    const d = diagnose(new Error("something broke"));
    expect(d.code).toBeUndefined();
    expect(d.action).toBe("report");
  });

  it("never leaks a raw code into the user-facing message", () => {
    for (const code of [4001, 4100, 4200, 4900, 4901, 4902, -32002, -32602, -32603, 12345]) {
      const d = diagnose({ code });
      expect(d.userMessage, `code ${code}`).not.toMatch(/-?32\d{3}|4\d{3}/);
    }
  });
});

describe("validateAddChainParams", () => {
  const valid = {
    chainId: "0x1237",
    chainName: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.example.com"],
  };

  it("accepts well-formed params", () => {
    expect(validateAddChainParams(valid)).toEqual([]);
  });

  /**
   * EIP-3085 marks these optional; MetaMask requires them and rejects violations with a
   * bare -32602. Catching it here turns a confusing popup into a clear message.
   */
  it("requires the fields MetaMask requires even though the EIP does not", () => {
    expect(validateAddChainParams({ ...valid, chainName: undefined }).join()).toContain(
      "EIP-3085 marks it optional",
    );
    expect(validateAddChainParams({ ...valid, nativeCurrency: undefined }).join()).toContain(
      "EIP-3085 marks it optional",
    );
  });

  it("enforces the 2-6 character symbol rule", () => {
    expect(
      validateAddChainParams({
        ...valid,
        nativeCurrency: { name: "X", symbol: "E", decimals: 18 },
      }).join(),
    ).toContain("2-6 characters");
    expect(
      validateAddChainParams({
        ...valid,
        nativeCurrency: { name: "X", symbol: "TOOLONGSYM", decimals: 18 },
      }).join(),
    ).toContain("2-6 characters");
  });

  it("rejects a non-hex chainId", () => {
    expect(validateAddChainParams({ ...valid, chainId: "4663" }).join()).toContain("hex string");
  });

  it("rejects http:// RPC URLs", () => {
    expect(
      validateAddChainParams({ ...valid, rpcUrls: ["http://rpc.example.com"] }).join(),
    ).toContain("MetaMask rejects http://");
  });

  /**
   * A list here looks like redundancy and is not: only the first entry is ever used, so a
   * "fallback" that will never be tried is a false comfort worth naming.
   */
  it("warns that extra rpcUrls are not fallbacks", () => {
    expect(
      validateAddChainParams({
        ...valid,
        rpcUrls: ["https://a.example", "https://b.example"],
      }).join(),
    ).toContain("not fallbacks");
  });

  /**
   * No RPC URL at all — the case an "is every entry https?" loop silently passes.
   *
   * The per-entry https check iterates `rpcUrls`, and iterating an empty or absent list
   * runs zero times and finds zero problems. So a params object built from config where
   * `RPC_URL` was never set validates clean and goes straight to MetaMask, which answers
   * with a bare -32602 that names nothing. Both the absent and the empty case must be
   * caught by the length guard rather than by the loop.
   */
  it("rejects rpcUrls that is missing or empty, not just malformed", () => {
    expect(validateAddChainParams({ ...valid, rpcUrls: undefined })).toEqual([
      "rpcUrls must contain at least one URL",
    ]);
    expect(validateAddChainParams({ ...valid, rpcUrls: [] })).toEqual([
      "rpcUrls must contain at least one URL",
    ]);
  });

  it("questions a non-18 decimals rather than silently accepting it", () => {
    expect(
      validateAddChainParams({
        ...valid,
        nativeCurrency: { name: "X", symbol: "ETH", decimals: 6 },
      }).join(),
    ).toContain("confirm this is deliberate");
  });
});
