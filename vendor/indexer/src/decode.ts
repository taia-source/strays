/**
 * The decode surface: which events this build can read, and proving it matches the
 * contracts.
 *
 * Two failure modes live here, and both are SILENT. Neither raises an error, fails a
 * deploy, or shows up in a green test suite:
 *
 *   1. A handler registered against a wrong event signature indexes nothing. viem decodes
 *      positionally, so a transposed argument silently stores wrong values. A real bug
 *      from the seed project: `Sold(tokensIn, quoteOut)` was declared with the arguments
 *      reversed and every curve sell stored transposed numbers. No exception, no crash.
 *
 *   2. An event the contracts emit but nothing decodes is simply absent. Also real:
 *      `MarketMakerDeployed` was emitted from day one and never indexed, so the volume
 *      half of every engine sat funded and idle. Deploy green, lag 0, money doing nothing.
 *
 * The fix for both is mechanical, so it belongs in the gate rather than in review.
 */
import { toEventSelector } from "viem";

/** One event this build decodes: its human-readable signature and its topic0. */
export type DecodedEvent = {
  readonly signature: string;
  readonly topic0: `0x${string}`;
};

/**
 * An event the contracts emit that we deliberately do NOT index, plus why.
 *
 * A reason is mandatory. The point is to force the omission to be a decision someone
 * wrote down, rather than an accident nobody noticed.
 */
export type IgnoredEvent = {
  readonly name: string;
  readonly reason: string;
};

export type CoverageResult = {
  readonly ok: boolean;
  /** Emitted by the contracts, neither decoded nor explicitly ignored. */
  readonly undecoded: readonly string[];
  /** Ignored without a stated reason — treated as a failure. */
  readonly unexplained: readonly string[];
};

/** Minimal shape of a Foundry/solc ABI entry. */
export type AbiEventEntry = {
  readonly type: string;
  readonly name?: string;
  readonly anonymous?: boolean;
  readonly inputs?: ReadonlyArray<{ readonly type: string; readonly name?: string }>;
};

/** Canonical `Name(type1,type2)` signature for an ABI event entry. */
export function eventSignature(entry: AbiEventEntry): string {
  const args = (entry.inputs ?? []).map((i) => i.type).join(",");
  return `${entry.name ?? ""}(${args})`;
}

/**
 * A stable fingerprint of everything this build can decode.
 *
 * Stored alongside the cursor. When it changes, history was indexed with a narrower
 * surface and must be re-read — the targeted alternative to a full re-index. Sorted so
 * declaration order does not spuriously invalidate a database.
 */
export function decodeFingerprint(events: readonly DecodedEvent[]): string {
  return [...events]
    .map((e) => e.topic0)
    .sort()
    .join(",");
}

/**
 * Build the decode surface from signatures, computing each topic0 rather than trusting a
 * hand-copied constant.
 *
 * A hardcoded topic0 that drifts from its signature is precisely the transposition bug
 * above; deriving it makes that class impossible.
 */
export function defineDecodeSurface(signatures: readonly string[]): DecodedEvent[] {
  const seen = new Map<`0x${string}`, string>();
  return signatures.map((signature) => {
    const topic0 = toEventSelector(signature);
    const clash = seen.get(topic0);
    if (clash !== undefined && clash !== signature) {
      throw new Error(`topic0 collision: "${signature}" and "${clash}" both hash to ${topic0}`);
    }
    seen.set(topic0, signature);
    return { signature, topic0 };
  });
}

/**
 * Assert every event the contracts emit is either decoded or explicitly ignored.
 *
 * `deploymentEvents` may never be ignored: missing one means child contracts are never
 * discovered, which is the failure that leaves a funded engine idle while every health
 * check reports green.
 */
export function checkCoverage(options: {
  readonly abis: readonly AbiEventEntry[];
  readonly decoded: readonly DecodedEvent[];
  readonly ignored?: readonly IgnoredEvent[];
  readonly deploymentEvents?: readonly string[];
}): CoverageResult {
  const { abis, decoded, ignored = [], deploymentEvents = [] } = options;

  const decodedTopics = new Set(decoded.map((d) => d.topic0));
  const ignoredByName = new Map(ignored.map((i) => [i.name, i.reason]));

  const undecoded: string[] = [];
  const unexplained: string[] = [];

  for (const entry of abis) {
    if (entry.type !== "event" || entry.anonymous === true) continue;
    const name = entry.name ?? "";
    const signature = eventSignature(entry);
    const topic0 = toEventSelector(signature);

    if (decodedTopics.has(topic0)) continue;

    const reason = ignoredByName.get(name);
    if (reason === undefined) {
      undecoded.push(signature);
      continue;
    }
    if (reason.trim() === "") {
      unexplained.push(signature);
      continue;
    }
    if (deploymentEvents.includes(name)) {
      // Deliberately not ignorable at any price.
      undecoded.push(`${signature} (deployment events cannot be ignored: "${reason}")`);
    }
  }

  return { ok: undecoded.length === 0 && unexplained.length === 0, undecoded, unexplained };
}

/**
 * Verify each declared signature still hashes to the topic0 we filter on.
 *
 * Cheap, and it closes the transposition class: if a signature is edited without updating
 * its topic0 (or vice versa), this fails at build time instead of corrupting a table.
 */
export function checkSignatureDrift(events: readonly DecodedEvent[]): {
  readonly ok: boolean;
  readonly drifted: readonly string[];
} {
  const drifted = events
    .filter((e) => toEventSelector(e.signature) !== e.topic0)
    .map(
      (e) => `${e.signature} declares ${e.topic0} but hashes to ${toEventSelector(e.signature)}`,
    );
  return { ok: drifted.length === 0, drifted };
}
