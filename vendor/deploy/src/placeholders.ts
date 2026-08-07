/**
 * Placeholder detection — the last check before a project ships.
 *
 * Every project passes through a window where addresses are unknown: the contracts are
 * not deployed, the token is not launched, so the code carries stand-ins. Shipping with
 * one still in place is not a hypothetical.
 *
 * ══ Both of these actually shipped ══
 *
 * **The obvious kind.** A deployed landing page carried `const CA='TBA'` behind a
 * copy-to-clipboard button. Clicking it put the literal string `TBA` on the user's
 * clipboard. Loud, harmless, embarrassing.
 *
 * **The dangerous kind.** A project's `TOKEN` env var held a valid, checksummed,
 * currently-live address — belonging to **somebody else's token**. It was a pre-launch
 * stand-in nobody swapped. Every syntax check passes it. It is a real address; it is
 * simply the wrong one, and the failure is silent.
 *
 * So detection needs two halves:
 *
 *   1. syntax — `TBA`, `0x0`, `0xdead`, `TODO` (this module)
 *   2. provenance — an address that is not in the deploy manifest for this project has
 *      no business being in the code (`verifyAgainstManifest`)
 *
 * Only the second catches the dangerous kind.
 */

/** A placeholder found in the codebase. */
export type Placeholder = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly kind: PlaceholderKind;
  /** Why this matters, phrased so the fix is obvious. */
  readonly reason: string;
};

export type PlaceholderKind =
  | "zero-address"
  | "burn-address"
  | "literal-tba"
  | "todo-marker"
  | "local-chain-address"
  | "unknown-address";

const ZERO_ADDRESS = /0x0{40}\b/i;
const BURN_ADDRESS = /0x0{36}de[a4]d\b/i;
/** `TBA`, `TBD`, `CHANGEME`, `REPLACE_ME` as standalone tokens, not inside words. */
const LITERAL_TBA = /\b(TBA|TBD|CHANGEME|CHANGE_ME|REPLACE_?ME|YOUR_[A-Z_]+_HERE)\b/;
const TODO_MARKER = /\b(TODO|FIXME|XXX)\b.*\b(address|token|contract|deploy)\b/i;

/**
 * Addresses that are **deterministic on a local chain and meaningless anywhere else.**
 *
 * These are the most-copied addresses in EVM development. Anvil and Hardhat derive their
 * accounts from a published mnemonic, and a contract deployed first by account #0 always
 * lands at the same address — so `0x5FbDB2…` appears in every tutorial, every scaffold and
 * every example manifest, including one in this repo.
 *
 * The failure is silent and total: on a real chain nothing is deployed there, so a read
 * returns empty and a transfer sends funds to an address nobody controls. Nothing throws.
 *
 * This is distinct from `unknown-address`, which flags an address absent from the deploy
 * manifest. A local-chain address is worse than unknown — it is **known to be wrong**.
 */
const LOCAL_CHAIN_ADDRESSES: ReadonlyMap<string, string> = new Map([
  [
    "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    "the first contract deployed by Anvil/Hardhat account #0",
  ],
  [
    "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
    "the second contract deployed by Anvil/Hardhat account #0",
  ],
  [
    "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
    "the third contract deployed by Anvil/Hardhat account #0",
  ],
  ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "Anvil/Hardhat account #0"],
  ["0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "Anvil/Hardhat account #1"],
  ["0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", "Anvil/Hardhat account #2"],
  ["0x90f79bf6eb2c4f870365e785982e1f101e93b906", "Anvil/Hardhat account #3"],
]);

const ADDRESS = /0x[a-fA-F0-9]{40}\b/g;

/**
 * Scan source text for placeholder values.
 *
 * A line containing `placeholder-ok` is skipped — test fixtures legitimately use the zero
 * address, and a check that cannot be silenced gets disabled wholesale instead.
 */
export function findPlaceholders(file: string, source: string): Placeholder[] {
  const found: Placeholder[] = [];

  source.split("\n").forEach((text, index) => {
    if (text.includes("placeholder-ok")) return;
    const line = index + 1;
    const trimmed = text.trim();

    if (ZERO_ADDRESS.test(text)) {
      found.push({
        file,
        line,
        text: trimmed,
        kind: "zero-address",
        reason: "the zero address is never a real deployment target",
      });
    }
    if (BURN_ADDRESS.test(text)) {
      found.push({
        file,
        line,
        text: trimmed,
        kind: "burn-address",
        reason: "0x…dEaD is a burn sink — valid as a destination, never as a contract to call",
      });
    }
    if (LITERAL_TBA.test(text)) {
      found.push({
        file,
        line,
        text: trimmed,
        kind: "literal-tba",
        reason: "a literal stand-in that was never swapped for the real value",
      });
    }
    if (TODO_MARKER.test(text)) {
      found.push({
        file,
        line,
        text: trimmed,
        kind: "todo-marker",
        reason: "an unresolved marker on an address or contract",
      });
    }

    // Local-chain addresses are checked per-match rather than per-line, because one line
    // can carry several and naming the specific one is what makes the finding actionable.
    for (const match of text.matchAll(ADDRESS)) {
      const what = LOCAL_CHAIN_ADDRESSES.get(match[0].toLowerCase());
      if (!what) continue;
      found.push({
        file,
        line,
        text: trimmed,
        kind: "local-chain-address",
        reason:
          `${match[0]} is ${what} — deterministic on a local chain and meaningless on any real one. ` +
          "On a real chain nothing is deployed there: a read returns empty and a transfer sends funds " +
          "to an address nobody controls, and nothing throws",
      });
    }
  });

  return found;
}

/** Addresses this project legitimately references, produced by its own deploys. */
export type DeployManifest = {
  readonly chainId: number;
  /** name → address, from deploy artifacts and launch results. */
  readonly addresses: Readonly<Record<string, `0x${string}`>>;
  /**
   * Third-party addresses this project intentionally calls — routers, factories, WETH.
   * Must be listed explicitly, because "it is a real address" is exactly the property
   * that makes the dangerous placeholder invisible.
   */
  readonly external?: Readonly<Record<string, `0x${string}`>>;
};

/**
 * Find addresses in the code that the manifest does not account for.
 *
 * **This is the check that catches the dangerous case.** A leftover stand-in pointing at
 * somebody else's live token is syntactically perfect — the only thing wrong with it is
 * that nothing in this project ever deployed it.
 */
export function verifyAgainstManifest(
  file: string,
  source: string,
  manifest: DeployManifest,
): Placeholder[] {
  const known = new Set(
    [...Object.values(manifest.addresses), ...Object.values(manifest.external ?? {})].map((a) =>
      a.toLowerCase(),
    ),
  );

  const found: Placeholder[] = [];

  source.split("\n").forEach((text, index) => {
    if (text.includes("placeholder-ok")) return;
    for (const match of text.matchAll(ADDRESS)) {
      const address = match[0].toLowerCase();
      if (known.has(address)) continue;
      // Zero and burn addresses are reported by findPlaceholders with better reasons.
      if (ZERO_ADDRESS.test(address) || BURN_ADDRESS.test(address)) continue;
      found.push({
        file,
        line: index + 1,
        text: text.trim(),
        kind: "unknown-address",
        reason:
          `${match[0]} is not in the deploy manifest and is not a declared external ` +
          "dependency — it may be a stand-in pointing at somebody else's contract",
      });
    }
  });

  return found;
}

export type ShipCheck = {
  readonly ok: boolean;
  readonly placeholders: readonly Placeholder[];
};

/** Combined gate check. Both halves, because each misses what the other catches. */
export function checkReadyToShip(
  files: ReadonlyArray<{ readonly path: string; readonly source: string }>,
  manifest?: DeployManifest,
): ShipCheck {
  const placeholders = files.flatMap((f) => [
    ...findPlaceholders(f.path, f.source),
    ...(manifest ? verifyAgainstManifest(f.path, f.source, manifest) : []),
  ]);
  return { ok: placeholders.length === 0, placeholders };
}

/** Human-readable report. Names file and line so the fix is mechanical. */
export function formatPlaceholders(placeholders: readonly Placeholder[]): string {
  if (placeholders.length === 0) return "no placeholders found";
  return placeholders
    .map((p) => `${p.file}:${p.line}  [${p.kind}] ${p.reason}\n    ${p.text}`)
    .join("\n");
}
