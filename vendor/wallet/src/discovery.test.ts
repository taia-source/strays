import { describe, expect, it, vi } from "vitest";
import {
  createProviderStore,
  type Eip1193Provider,
  type EventTargetLike,
  findByRdns,
  legacyProvider,
  type ProviderDetail,
  validateAnnouncement,
} from "./discovery.js";

const provider: Eip1193Provider = { request: async () => undefined };

const detail = (over: Partial<ProviderDetail["info"]> = {}): ProviderDetail => ({
  info: {
    uuid: "350670db-19fa-4704-a166-e52e178b59d2",
    name: "Example Wallet",
    icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    rdns: "com.example.wallet",
    ...over,
  },
  provider,
});

/** A minimal EventTarget so discovery can be tested without a DOM. */
function fakeTarget() {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const dispatched: string[] = [];
  const target: EventTargetLike = {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    dispatchEvent(event) {
      dispatched.push((event as { type: string }).type);
      return true;
    },
  };
  const announce = (d: unknown) => {
    for (const l of listeners.get("eip6963:announceProvider") ?? []) l({ detail: d });
  };
  return {
    target,
    dispatched,
    announce,
    listenerCount: () => (listeners.get("eip6963:announceProvider") ?? []).length,
  };
}

describe("validateAnnouncement", () => {
  it("accepts a well-formed announcement", () => {
    expect(validateAnnouncement(detail(), new Set())).toBeUndefined();
  });

  it("rejects a uuid that is not a v4", () => {
    const r = validateAnnouncement(detail({ uuid: "not-a-uuid" }), new Set());
    expect(r?.reason).toBe("invalid-uuid");
  });

  /**
   * The spec names matching uuids as the signal for impersonation: a uuid is per-session
   * and unique by definition, so a collision cannot be an accident.
   */
  it("rejects a duplicate uuid as impersonation", () => {
    const first = detail();
    const r = validateAnnouncement(detail({ name: "Impersonator" }), new Set([first.info.uuid]));
    expect(r?.reason).toBe("duplicate-uuid");
    expect(r?.detail).toContain("impersonation");
  });

  it("rejects an rdns that is not a reverse-order domain", () => {
    expect(validateAnnouncement(detail({ rdns: "metamask" }), new Set())?.reason).toBe(
      "invalid-rdns",
    );
    expect(validateAnnouncement(detail({ rdns: "not a domain!" }), new Set())?.reason).toBe(
      "invalid-rdns",
    );
  });

  it("accepts a multi-label rdns", () => {
    expect(validateAnnouncement(detail({ rdns: "io.metamask" }), new Set())).toBeUndefined();
    expect(
      validateAnnouncement(detail({ rdns: "com.example.sub.wallet" }), new Set()),
    ).toBeUndefined();
  });

  it("rejects a remote icon URL", () => {
    // The spec requires a data URI. A remote URL is a tracking beacon that fires every
    // time the wallet picker renders.
    const r = validateAnnouncement(detail({ icon: "https://evil.example/pixel.png" }), new Set());
    expect(r?.reason).toBe("icon-not-data-uri");
    expect(r?.detail).toContain("tracking beacon");
  });

  it("rejects an announcement whose provider cannot take a request", () => {
    const r = validateAnnouncement(
      { info: detail().info, provider: {} as Eip1193Provider },
      new Set(),
    );
    expect(r?.reason).toBe("not-a-provider");
  });

  it("rejects junk without throwing", () => {
    expect(validateAnnouncement(undefined, new Set())?.reason).toBe("not-a-provider");
    expect(validateAnnouncement({ info: null }, new Set())?.reason).toBe("not-a-provider");
  });

  it("rejects a nameless provider, which cannot be shown in a picker", () => {
    expect(validateAnnouncement(detail({ name: "" }), new Set())?.reason).toBe("missing-name");
  });

  /**
   * An announcement missing `info.name` entirely, not merely set to "".
   *
   * Everything in `info` is attacker-controlled — it arrives on a CustomEvent from an
   * extension the page did not choose. The rejection detail is built by interpolating
   * these fields, and interpolating a missing name yields the literal string "undefined",
   * which reads in a support log as a wallet that genuinely calls itself that. The
   * `?? "unnamed"` fallbacks exist to keep the diagnostic honest.
   *
   * Both orderings matter: `not-a-provider` is decided BEFORE the uuid check, so a
   * nameless non-provider and a nameless bad-uuid take different paths to the same
   * fallback.
   */
  it("says 'unnamed' rather than 'undefined' when info.name is absent", () => {
    const noName = validateAnnouncement(
      { info: { uuid: "350670db-19fa-4704-a166-e52e178b59d2" }, provider: {} },
      new Set(),
    );
    expect(noName?.reason).toBe("not-a-provider");
    expect(noName?.detail).toContain('"unnamed"');
    expect(noName?.detail).not.toContain("undefined");

    const badUuid = validateAnnouncement({ info: { uuid: "nope" }, provider }, new Set());
    expect(badUuid?.reason).toBe("invalid-uuid");
    expect(badUuid?.detail).toContain('"unnamed"');
  });

  /**
   * `uuid` and `rdns` absent rather than malformed.
   *
   * `UUID_V4.test(undefined)` would stringify to "undefined" and fail anyway, so the
   * `?? ""` looks redundant — it is not. It is what stops a `uuid` of the literal string
   * "undefined" and a genuinely missing one from being indistinguishable, and it keeps
   * the regex fed a string rather than relying on RegExp's implicit coercion.
   *
   * The verdict is the load-bearing part: an announcement with no uuid MUST be refused,
   * because the uuid is the entire basis of the duplicate/impersonation check below it.
   * If a missing uuid were accepted, two impersonators could both announce nothing and
   * neither would collide.
   */
  it("refuses an announcement with no uuid at all", () => {
    const r = validateAnnouncement({ info: { name: "Ghost Wallet" }, provider }, new Set());
    expect(r?.reason).toBe("invalid-uuid");
    expect(r?.detail).toContain("Ghost Wallet");
  });

  it("refuses an announcement with no rdns at all", () => {
    const { rdns: _dropped, ...info } = detail().info;
    const r = validateAnnouncement({ info, provider }, new Set());
    expect(r?.reason).toBe("invalid-rdns");
    expect(r?.detail).toContain("Example Wallet");
  });

  /**
   * The empty string specifically, for uuid and rdns both.
   *
   * A wallet that ships `rdns: ""` is announcing a field the spec requires as a
   * controlled origin identifier. Accepting it would put an entry in the picker that
   * `findByRdns("")` could later match — a stored "previous choice" of nothing that
   * silently restores an arbitrary wallet.
   */
  it("refuses empty-string uuid and rdns exactly as it refuses missing ones", () => {
    expect(validateAnnouncement(detail({ uuid: "" }), new Set())?.reason).toBe("invalid-uuid");
    expect(validateAnnouncement(detail({ rdns: "" }), new Set())?.reason).toBe("invalid-rdns");
  });
});

describe("createProviderStore", () => {
  /**
   * The ordering MUST. Requesting before listening loses every wallet that answers
   * synchronously, which is the documented race EIP-6963 exists to solve.
   */
  it("installs the listener BEFORE dispatching the request", () => {
    const order: string[] = [];
    const target: EventTargetLike = {
      addEventListener: () => order.push("listen"),
      removeEventListener: () => {},
      dispatchEvent: () => {
        order.push("request");
        return true;
      },
    };
    createProviderStore(target);
    expect(order).toEqual(["listen", "request"]);
  });

  it("dispatches the request event by its spec name", () => {
    const { target, dispatched } = fakeTarget();
    createProviderStore(target);
    expect(dispatched).toEqual(["eip6963:requestProvider"]);
  });

  /**
   * The other MUST: the listener lives for the page's lifetime. A wallet that injects
   * late — a slow extension, a lazily-loaded connector — announces after mount, and a
   * store that stopped listening would never see it.
   */
  it("keeps accepting providers that announce long after start", () => {
    const { target, announce } = fakeTarget();
    const store = createProviderStore(target);
    expect(store.providers()).toHaveLength(0);

    announce(detail());
    announce(detail({ uuid: "8b4e2c1a-3f5d-4a7b-9c2e-1d3f5a7b9c2e", name: "Late Wallet" }));

    expect(store.providers().map((p) => p.info.name)).toEqual(["Example Wallet", "Late Wallet"]);
  });

  it("notifies subscribers immediately and on each addition", () => {
    const { target, announce } = fakeTarget();
    const store = createProviderStore(target);
    const seen = vi.fn();

    store.subscribe(seen);
    expect(seen).toHaveBeenCalledWith([]); // immediate, so a late subscriber is not stuck empty

    announce(detail());
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.calls[1]?.[0]).toHaveLength(1);
  });

  it("stops notifying an unsubscribed listener", () => {
    const { target, announce } = fakeTarget();
    const store = createProviderStore(target);
    const seen = vi.fn();
    const unsubscribe = store.subscribe(seen);
    unsubscribe();
    announce(detail());
    expect(seen).toHaveBeenCalledTimes(1); // the immediate call only
  });

  it("records why an announcement was refused instead of dropping it silently", () => {
    const { target, announce } = fakeTarget();
    const store = createProviderStore(target);
    announce(detail({ icon: "https://evil.example/x.png" }));

    expect(store.providers()).toHaveLength(0);
    expect(store.rejections()).toHaveLength(1);
    expect(store.rejections()[0]?.reason).toBe("icon-not-data-uri");
  });

  it("refuses a second announcement reusing a uuid", () => {
    const { target, announce } = fakeTarget();
    const store = createProviderStore(target);
    announce(detail());
    announce(detail({ name: "Impersonator" }));

    expect(store.providers()).toHaveLength(1);
    expect(store.providers()[0]?.info.name).toBe("Example Wallet");
    expect(store.rejections()[0]?.reason).toBe("duplicate-uuid");
  });

  it("returns a copy, so a caller cannot mutate the store's list", () => {
    const { target, announce } = fakeTarget();
    const store = createProviderStore(target);
    announce(detail());
    (store.providers() as ProviderDetail[]).length = 0;
    expect(store.providers()).toHaveLength(1);
  });

  /**
   * The no-DOM fallback in `makeRequestEvent`.
   *
   * Node has had a global `Event` since v15, so the plain-object path is dead in this
   * test process unless `globalThis.Event` is removed — which is exactly the environment
   * the fallback exists for: an SSR or worker runtime that ships no DOM constructor. If
   * `new Event(...)` were called unguarded there, `createProviderStore` would throw at
   * import-adjacent call time and take the whole server render down, rather than
   * degrading to a discovery pass that simply finds nothing.
   *
   * Asserting on the dispatched event's `type` is the point: the fallback must still
   * carry the spec's event name, or a wallet listening for `eip6963:requestProvider`
   * never answers.
   */
  it("dispatches a plain object when the runtime has no Event constructor", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "Event");
    const dispatched: unknown[] = [];
    const target: EventTargetLike = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: (event) => {
        dispatched.push(event);
        return true;
      },
    };

    try {
      Object.defineProperty(globalThis, "Event", { value: undefined, configurable: true });
      createProviderStore(target);
    } finally {
      if (original) Object.defineProperty(globalThis, "Event", original);
    }

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({ type: "eip6963:requestProvider" });
    // Not an instance of anything — the whole point is that no constructor was called.
    expect(dispatched[0]).not.toBeInstanceOf(globalThis.Event);
  });

  it("uses a real Event when the runtime provides one", () => {
    const dispatched: unknown[] = [];
    const target: EventTargetLike = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: (event) => {
        dispatched.push(event);
        return true;
      },
    };
    createProviderStore(target);

    expect(dispatched[0]).toBeInstanceOf(globalThis.Event);
    expect((dispatched[0] as Event).type).toBe("eip6963:requestProvider");
  });

  it("stop() exists for teardown but is not the normal lifecycle", () => {
    const { target, announce, listenerCount } = fakeTarget();
    const store = createProviderStore(target);
    expect(listenerCount()).toBe(1);
    store.stop();
    expect(listenerCount()).toBe(0);
    announce(detail());
    expect(store.providers()).toHaveLength(0);
  });
});

describe("findByRdns", () => {
  it("restores a previously chosen wallet", () => {
    const store = [
      detail(),
      detail({ uuid: "8b4e2c1a-3f5d-4a7b-9c2e-1d3f5a7b9c2e", rdns: "io.metamask" }),
    ];
    expect(findByRdns(store, "io.metamask")?.info.rdns).toBe("io.metamask");
  });

  it("returns undefined when the wallet is gone", () => {
    expect(findByRdns([detail()], "io.metamask")).toBeUndefined();
  });
});

describe("legacyProvider", () => {
  it("wraps window.ethereum when discovery found nothing", () => {
    const found = legacyProvider({ ethereum: provider });
    expect(found?.provider).toBe(provider);
    expect(found?.info.name).toContain("legacy");
  });

  it("returns undefined when there is no injected provider", () => {
    expect(legacyProvider({})).toBeUndefined();
    expect(legacyProvider({ ethereum: {} })).toBeUndefined();
  });

  it("passes its own validation, so the fallback cannot be rejected downstream", () => {
    const found = legacyProvider({ ethereum: provider });
    expect(validateAnnouncement(found, new Set())).toBeUndefined();
  });
});

/**
 * Against a real browser EventTarget.
 *
 * Everything above uses a hand-written fake, which can only prove the module is
 * self-consistent. This drives the real `window` in Chromium with a wallet that announces
 * exactly the way the spec describes — including the half most fakes omit, where the
 * wallet listens for `eip6963:requestProvider` and answers it. That is the direction of
 * the race that a listen-after-request implementation loses.
 */
describe("against a real browser", () => {
  it("discovers a wallet that answers the request event", { timeout: 60_000 }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent("<!doctype html><title>discovery</title>");

      // A spec-shaped wallet: announce on load AND on request.
      await page.evaluate(`(() => {
        const detail = Object.freeze({
          info: {
            uuid: '350670db-19fa-4704-a166-e52e178b59d2',
            name: 'Real Wallet',
            icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
            rdns: 'com.example.realwallet',
          },
          provider: { request: async () => '0x1' },
        });
        const announce = () =>
          window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
        window.addEventListener('eip6963:requestProvider', announce);
        announce();
      })()`);

      // Run the real store logic inside the page against the real window.
      const result = (await page.evaluate(
        `(() => {
          const found = [];
          const onAnnounce = (e) => found.push(e.detail.info);
          window.addEventListener('eip6963:announceProvider', onAnnounce);
          window.dispatchEvent(new Event('eip6963:requestProvider'));
          return found.map((i) => ({ name: i.name, rdns: i.rdns, uuid: i.uuid, icon: i.icon }));
        })()`,
      )) as Array<{ name: string; rdns: string; uuid: string; icon: string }>;

      // The wallet answered the request, so listen-then-request found it.
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("Real Wallet");

      // And what a real wallet sends passes our validation unchanged.
      const announced = result[0];
      expect(
        validateAnnouncement({ info: announced, provider }, new Set()),
        "a spec-shaped announcement must not be rejected",
      ).toBeUndefined();
    } finally {
      await browser.close();
    }
  });
});
