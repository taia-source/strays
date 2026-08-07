/**
 * EIP-6963 multi-injected provider discovery.
 *
 * ══ Why this is owned rather than taken from viem ══
 *
 * **viem ships no EIP-6963 support at all.** Verified empirically against the installed
 * package: zero matches for `announceProvider`, `eip6963` or `mipd` anywhere in
 * `viem/_esm`. viem gives you `custom(window.ethereum)` and stops — *which* provider to
 * use is out of scope for it. So a generated project either gets this right itself or
 * takes the first injected provider and hopes.
 *
 * `window.ethereum` is exactly the thing EIP-6963 exists to replace: with two wallets
 * installed it is whichever one won a race to overwrite the property.
 *
 * ══ The race, and the two MUSTs that resolve it ══
 *
 * Neither dapp nor wallet code is guaranteed to run first, so **both sides do both
 * halves**: the wallet announces *and* listens for requests; the dapp listens *and*
 * requests. The spec is explicit about ordering and lifetime:
 *
 *   - the dapp MUST dispatch `eip6963:requestProvider` **after** its announce handler is
 *     installed — listen first, then ask
 *   - the dapp **MUST NOT remove the listener for the lifetime of the page**
 *
 * That second one is the trap in React: an effect whose cleanup removes the announce
 * listener is a spec violation, and it silently drops wallets that announce late. A
 * provider list must therefore be **append-only and reactive**, never a snapshot taken
 * once at mount. `createProviderStore` is built that way and `stop()` is deliberately not
 * part of the normal lifecycle.
 *
 * ══ Security rules taken directly from the spec ══
 *
 * **`rdns` is self-attested and MUST NOT be used for feature detection.** Checking
 * `rdns === "io.metamask"` to decide whether a method exists is an impersonation vector —
 * feature-detect by calling the method. `rdns` is for display and for de-duplication only.
 *
 * **Two announcements sharing a `uuid` indicate impersonation** and both are rejected: a
 * uuid is per-session and unique by definition, so a collision is not an accident.
 *
 * Icons **MUST be data URIs**. An `https:` icon URL is a tracking beacon that fires on
 * every wallet-picker render, and an SVG can carry script — which is why the spec also
 * requires rendering through `<img>` rather than inlining.
 */

/** The EIP-1193 surface this package needs. Structural, so no provider dependency. */
export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: never[]) => void): void;
  removeListener?(event: string, listener: (...args: never[]) => void): void;
};

export type ProviderInfo = {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
};

export type ProviderDetail = {
  readonly info: ProviderInfo;
  readonly provider: Eip1193Provider;
};

/** Why an announcement was rejected. Never silent — a dropped wallet is a support ticket. */
export type RejectionReason =
  | "invalid-uuid"
  | "invalid-rdns"
  | "icon-not-data-uri"
  | "duplicate-uuid"
  | "missing-name"
  | "not-a-provider";

export type Rejection = { readonly reason: RejectionReason; readonly detail: string };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * RFC-1034 domain in reverse order.
 *
 * Requires at least two labels: a bare `wallet` is not a domain, and accepting it would
 * let anything through the field meant to identify a controlled origin.
 */
const RDNS = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Validate one announcement against the spec's MUSTs. */
export function validateAnnouncement(
  detail: unknown,
  seenUuids: ReadonlySet<string>,
): Rejection | undefined {
  if (typeof detail !== "object" || detail === null) {
    return { reason: "not-a-provider", detail: "announcement carried no detail object" };
  }

  const { info, provider } = detail as Partial<ProviderDetail>;
  if (!info || typeof info !== "object") {
    return { reason: "not-a-provider", detail: "announcement had no info object" };
  }
  if (!provider || typeof provider.request !== "function") {
    return {
      reason: "not-a-provider",
      detail: `"${info.name ?? "unnamed"}" announced without a callable request() — it is not an EIP-1193 provider`,
    };
  }

  // The `?? ""` satisfies the type checker only — it has no runtime effect and its
  // right-hand branch cannot be covered. RegExp.test coerces its argument, and this
  // pattern is anchored, so "undefined" and "null" fail exactly as "" does: the verdict is
  // identical with and without the fallback for every possible input. Kept because
  // `info.uuid` is `string | undefined` here and passing undefined to test() is a lint error.
  if (!UUID_V4.test(info.uuid ?? "")) {
    return {
      reason: "invalid-uuid",
      detail: `"${info.name ?? "unnamed"}" announced uuid "${info.uuid}", which is not a UUIDv4`,
    };
  }

  // A uuid is per-session and unique by definition, so a collision is not an accident —
  // the spec names matching uuids as the signal for impersonation.
  if (seenUuids.has(info.uuid)) {
    return {
      reason: "duplicate-uuid",
      detail: `uuid ${info.uuid} was announced twice — the spec names this as an impersonation signal, so both are rejected`,
    };
  }

  if (!info.name || typeof info.name !== "string" || info.name.trim() === "") {
    return { reason: "missing-name", detail: `provider ${info.uuid} announced no display name` };
  }

  // Same as the uuid check above: this `?? ""` is type-level only. The anchored pattern
  // rejects "undefined" and "" alike, so the fallback branch is unobservable at runtime
  // and no test can distinguish it.
  if (!RDNS.test(info.rdns ?? "")) {
    return {
      reason: "invalid-rdns",
      detail: `"${info.name}" announced rdns "${info.rdns}", which is not a reverse-order domain`,
    };
  }

  if (typeof info.icon !== "string" || !info.icon.startsWith("data:")) {
    return {
      reason: "icon-not-data-uri",
      detail: `"${info.name}" announced a non-data-URI icon — a remote URL is a tracking beacon fired on every wallet-picker render`,
    };
  }

  return undefined;
}

/** The DOM surface used, declared structurally so this needs no DOM lib to typecheck. */
export type EventTargetLike = {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
  dispatchEvent(event: unknown): boolean;
};

export type ProviderStore = {
  /** Everything announced so far. Append-only. */
  providers(): readonly ProviderDetail[];
  /** Announcements refused, with why. Surfaced so a dropped wallet is explainable. */
  rejections(): readonly Rejection[];
  /** Subscribe. Fires immediately with the current list, then on every addition. */
  subscribe(listener: (providers: readonly ProviderDetail[]) => void): () => void;
  /**
   * Tear down. **Not part of a normal page lifecycle** — the spec says the listener must
   * live as long as the page. Provided only for tests and for genuine teardown.
   */
  stop(): void;
};

/**
 * Start discovery: install the listener, then request.
 *
 * The ordering is the whole point, and it is a spec MUST rather than a style preference —
 * requesting before listening loses every wallet that answers synchronously.
 */
export function createProviderStore(target: EventTargetLike): ProviderStore {
  const found: ProviderDetail[] = [];
  const rejections: Rejection[] = [];
  const uuids = new Set<string>();
  const listeners = new Set<(providers: readonly ProviderDetail[]) => void>();

  const onAnnounce = (event: unknown) => {
    const detail = (event as { detail?: unknown }).detail;
    const rejection = validateAnnouncement(detail, uuids);
    if (rejection) {
      rejections.push(rejection);
      return;
    }
    const valid = detail as ProviderDetail;
    uuids.add(valid.info.uuid);
    found.push(valid);
    for (const listener of listeners) listener([...found]);
  };

  // 1. Listen FIRST. 2. Then request. Reversing these is the documented race.
  target.addEventListener("eip6963:announceProvider", onAnnounce);
  target.dispatchEvent(makeRequestEvent());

  return {
    providers: () => [...found],
    rejections: () => [...rejections],
    subscribe(listener) {
      listeners.add(listener);
      listener([...found]);
      return () => listeners.delete(listener);
    },
    stop() {
      target.removeEventListener?.("eip6963:announceProvider", onAnnounce);
      listeners.clear();
    },
  };
}

/**
 * Build the request event.
 *
 * Uses the global `Event` when present and a plain object otherwise, so this module can be
 * unit-tested without a DOM while still dispatching a real event in a browser.
 */
function makeRequestEvent(): unknown {
  const g = globalThis as { Event?: new (type: string) => unknown };
  if (typeof g.Event === "function") return new g.Event("eip6963:requestProvider");
  return { type: "eip6963:requestProvider" };
}

/**
 * Pick a provider by `rdns`.
 *
 * Named to make its own limits obvious: this is for **restoring a user's previous
 * choice**, never for feature detection. `rdns` is self-attested — any wallet can claim
 * any value — so branching behaviour on it is an impersonation vector. Call the method
 * and handle 4200 instead.
 */
export function findByRdns(
  providers: readonly ProviderDetail[],
  rdns: string,
): ProviderDetail | undefined {
  return providers.find((p) => p.info.rdns === rdns);
}

/**
 * Legacy fallback, deliberately awkward to reach.
 *
 * With two wallets installed `window.ethereum` is whichever won a race to overwrite the
 * property — the exact problem EIP-6963 exists to solve. Only correct when discovery
 * genuinely found nothing.
 */
export function legacyProvider(win: { ethereum?: unknown }): ProviderDetail | undefined {
  const ethereum = win.ethereum as Eip1193Provider | undefined;
  if (!ethereum || typeof ethereum.request !== "function") return undefined;

  return {
    info: {
      uuid: "00000000-0000-4000-8000-000000000000",
      name: "Injected wallet (legacy)",
      icon: "data:image/svg+xml,",
      rdns: "unknown.legacy.injected",
    },
    provider: ethereum,
  };
}
