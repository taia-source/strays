/**
 * Sign-In with Ethereum (EIP-4361) — the replay protection viem does not provide.
 *
 * ══ The specific gap ══
 *
 * viem ships `viem/siwe` and it is good: it builds and parses messages and verifies
 * signatures. But **`verifySiweMessage` only checks that the nonce equals the one you pass
 * in.** It does not generate, store, track, or invalidate nonces. So a correct-looking
 * integration that calls `verifySiweMessage` and nothing else accepts **the same signature
 * forever** — replay protection is entirely the caller's job, and this module is that job.
 *
 * ══ The two failures that make SIWE worthless when missed ══
 *
 * **1. Nonce not server-issued and single-use.** The nonce must be generated server-side,
 * stored, and **invalidated on use**. A client-supplied nonce proves nothing; a nonce that
 * is checked but never consumed makes every captured signature a permanent credential.
 *
 * **2. Domain not bound.** The spec: the `domain` — and `scheme` if present — "MUST
 * correspond to the origin from where the signing request was made". Verifying only the
 * signature lets a phishing site collect a signature for its own origin and replay it
 * against your backend. The signature is perfectly valid; it was just never meant for you.
 *
 * Also commonly skipped: honouring `expiration-time` and `not-before` server-side, and
 * binding the session to the **address** rather than to resolved resources like an ENS
 * name, which can change hands.
 */

/** Issued nonces. Injected so this is testable and so storage stays the caller's choice. */
export type NonceStore = {
  issue(nonce: string, expiresAt: number): Promise<void>;
  /** Consume atomically: true only the FIRST time. This is the replay defence. */
  consume(nonce: string): Promise<boolean>;
};

/**
 * EIP-4361 requires at least 8 alphanumeric characters. This uses more, from a CSPRNG.
 *
 * `Math.random` is not acceptable here: a predictable nonce is the same vulnerability as
 * no nonce, since an attacker can request a signature for a value you are about to issue.
 */
export function generateNonce(bytes = 16): string {
  const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto;
  if (!crypto?.getRandomValues) {
    throw new Error(
      "no CSPRNG available — refusing to generate a SIWE nonce with a predictable source, which would be equivalent to having no nonce",
    );
  }
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A simple in-memory store. Correct for one process; use Redis or a table across many. */
export function createMemoryNonceStore(now: () => number = Date.now): NonceStore & {
  size(): number;
} {
  const issued = new Map<string, number>();

  return {
    async issue(nonce, expiresAt) {
      issued.set(nonce, expiresAt);
    },
    async consume(nonce) {
      const expiresAt = issued.get(nonce);
      if (expiresAt === undefined) return false;
      // Delete before the expiry check so an expired nonce cannot be retried either.
      issued.delete(nonce);
      return expiresAt > now();
    },
    size: () => issued.size,
  };
}

export type SiweFields = {
  readonly domain?: string;
  readonly address?: string;
  readonly uri?: string;
  readonly version?: string;
  readonly chainId?: number;
  readonly nonce?: string;
  readonly issuedAt?: string;
  readonly expirationTime?: string;
  readonly notBefore?: string;
};

export type SiweCheck = {
  readonly ok: boolean;
  readonly problems: readonly string[];
};

/**
 * Everything that must hold **besides** a valid signature.
 *
 * Deliberately does not verify the signature — viem does that well. This covers only what
 * viem leaves to the caller, which is exactly where integrations go wrong.
 */
export async function checkSiwe(options: {
  readonly fields: SiweFields;
  /** The origin YOUR server expects. Not read from the message — that would be circular. */
  readonly expectedDomain: string;
  readonly expectedChainId?: number;
  readonly store: NonceStore;
  readonly now?: number;
}): Promise<SiweCheck> {
  const { fields, expectedDomain, expectedChainId, store } = options;
  const now = options.now ?? Date.now();
  const problems: string[] = [];

  if (fields.version !== "1") {
    problems.push(`version must be "1" per EIP-4361, got ${JSON.stringify(fields.version)}`);
  }

  // Compared against a value the server holds, never against something from the message.
  if (!fields.domain || fields.domain !== expectedDomain) {
    problems.push(
      `domain is "${fields.domain}" but this server is "${expectedDomain}". EIP-4361 requires the domain to match the origin the signature was requested from — without this check a phishing site can replay a signature made for its own origin against you`,
    );
  }

  if (!fields.address || !/^0x[0-9a-fA-F]{40}$/.test(fields.address)) {
    problems.push(`address is missing or malformed: ${JSON.stringify(fields.address)}`);
  }

  if (expectedChainId !== undefined && fields.chainId !== expectedChainId) {
    problems.push(`chainId is ${fields.chainId}, expected ${expectedChainId}`);
  }

  if (!fields.nonce || fields.nonce.length < 8 || !/^[a-zA-Z0-9]+$/.test(fields.nonce)) {
    problems.push(
      `nonce must be at least 8 alphanumeric characters per EIP-4361, got ${JSON.stringify(fields.nonce)}`,
    );
  } else {
    // The single most important line here: consuming is what makes a replay fail.
    const fresh = await store.consume(fields.nonce);
    if (!fresh) {
      problems.push(
        "nonce was not issued by this server, or has already been used. A nonce that is checked but never consumed makes every captured signature a permanent credential",
      );
    }
  }

  if (fields.expirationTime) {
    const expires = Date.parse(fields.expirationTime);
    if (Number.isNaN(expires))
      problems.push(`expirationTime is unparseable: ${fields.expirationTime}`);
    else if (expires <= now) problems.push("the message has expired");
  }

  if (fields.notBefore) {
    const notBefore = Date.parse(fields.notBefore);
    if (Number.isNaN(notBefore)) problems.push(`notBefore is unparseable: ${fields.notBefore}`);
    else if (notBefore > now) problems.push("the message is not valid yet");
  }

  if (!fields.issuedAt || Number.isNaN(Date.parse(fields.issuedAt))) {
    problems.push("issuedAt is required by EIP-4361 and must be a valid timestamp");
  }

  return { ok: problems.length === 0, problems };
}

/**
 * What a session may be keyed on.
 *
 * The spec: a session "MUST be bound to the `address` and not to further resolved
 * resources that may change". An ENS name can be transferred, so a session keyed on one
 * silently transfers with it.
 */
export function sessionKey(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`refusing to key a session on "${address}" — it is not an address`);
  }
  return address.toLowerCase();
}
