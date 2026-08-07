/**
 * Placeholder tests, built from two failures that actually shipped.
 */
import { describe, expect, it } from "vitest";
import {
  checkReadyToShip,
  type DeployManifest,
  findPlaceholders,
  formatPlaceholders,
  verifyAgainstManifest,
} from "./placeholders.js";

const OURS = "0xD7b792680eE6c7207EFdd31Ae1d0E68a1d5797FF" as const;
const SOMEONE_ELSES = "0x6d0881c04e6b87C190580221ea0504cf9b193Ea0" as const;
const ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2" as const;

const manifest: DeployManifest = {
  chainId: 4663,
  addresses: { token: OURS },
  external: { router: ROUTER },
};

describe("findPlaceholders — the obvious kind", () => {
  /** This shipped: a deployed page put the literal string "TBA" on the clipboard. */
  it("catches a literal TBA stand-in", () => {
    const hits = findPlaceholders("index.html", "const CA='TBA';");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("literal-tba");
  });

  it("catches the zero address", () => {
    const hits = findPlaceholders("config.ts", `const token = "0x${"0".repeat(40)}";`);
    expect(hits[0]?.kind).toBe("zero-address");
  });

  it("catches a burn address used as a contract", () => {
    const hits = findPlaceholders(
      "c.ts",
      'const c = "0x000000000000000000000000000000000000dEaD";',
    );
    expect(hits[0]?.kind).toBe("burn-address");
  });

  it("catches an unresolved marker about an address", () => {
    expect(findPlaceholders("a.ts", "// TODO: set the real token address")[0]?.kind).toBe(
      "todo-marker",
    );
  });

  it("does not fire on ordinary words containing the letters", () => {
    expect(findPlaceholders("a.ts", "const established = 1; // notable")).toEqual([]);
  });

  /** Test fixtures legitimately use the zero address; an unsilenceable check gets deleted. */
  it("respects an explicit opt-out", () => {
    expect(
      findPlaceholders("t.ts", `const zero = "0x${"0".repeat(40)}"; // placeholder-ok: fixture`),
    ).toEqual([]);
  });
});

describe("verifyAgainstManifest — the dangerous kind", () => {
  /**
   * THE case that matters. A pre-launch stand-in held a valid, checksummed, currently-live
   * address belonging to somebody else's token. Every syntax check passes it. The only
   * thing wrong is that nothing in this project deployed it.
   */
  it("catches a real address that this project never deployed", () => {
    const hits = verifyAgainstManifest("env.ts", `TOKEN=${SOMEONE_ELSES}`, manifest);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("unknown-address");
    expect(hits[0]?.reason).toMatch(/somebody else's contract/);
  });

  it("accepts an address this project deployed", () => {
    expect(verifyAgainstManifest("env.ts", `TOKEN=${OURS}`, manifest)).toEqual([]);
  });

  it("accepts a declared external dependency", () => {
    expect(verifyAgainstManifest("swap.ts", `const router = "${ROUTER}";`, manifest)).toEqual([]);
  });

  it("is case-insensitive, since checksums vary by source", () => {
    expect(verifyAgainstManifest("env.ts", `TOKEN=${OURS.toLowerCase()}`, manifest)).toEqual([]);
  });

  it("does not double-report the zero address", () => {
    expect(verifyAgainstManifest("c.ts", `a = "0x${"0".repeat(40)}"`, manifest)).toEqual([]);
  });
});

describe("checkReadyToShip", () => {
  it("passes a clean codebase", () => {
    const result = checkReadyToShip(
      [{ path: "a.ts", source: `const token = "${OURS}";` }],
      manifest,
    );
    expect(result.ok).toBe(true);
  });

  it("fails and reports every problem at once", () => {
    const result = checkReadyToShip(
      [
        { path: "ui.ts", source: "const CA='TBA';" },
        { path: "env.ts", source: `TOKEN=${SOMEONE_ELSES}` },
      ],
      manifest,
    );
    expect(result.ok).toBe(false);
    expect(result.placeholders).toHaveLength(2);
  });

  it("works without a manifest, catching only the syntactic kind", () => {
    const result = checkReadyToShip([{ path: "env.ts", source: `TOKEN=${SOMEONE_ELSES}` }]);
    expect(result.ok, "no manifest means the dangerous kind is invisible").toBe(true);
  });
});

describe("formatPlaceholders", () => {
  it("names file and line so the fix is mechanical", () => {
    const out = formatPlaceholders(findPlaceholders("index.html", "\nconst CA='TBA';"));
    expect(out).toContain("index.html:2");
    expect(out).toContain("literal-tba");
  });

  it("says so plainly when there is nothing to report", () => {
    expect(formatPlaceholders([])).toBe("no placeholders found");
  });
});

/**
 * Local-chain addresses: known-wrong rather than merely unknown.
 *
 * Anvil and Hardhat derive accounts from a published mnemonic, and a contract deployed
 * first by account #0 always lands at 0x5FbDB2… — so these appear in every tutorial,
 * every scaffold, and (until this check) this repo's own EXAMPLE_MANIFEST.
 *
 * The failure is silent and total: on a real chain nothing is deployed there, a read
 * returns empty, a transfer goes to an address nobody controls, and nothing throws.
 */
describe("local-chain addresses", () => {
  const ANVIL_FIRST_DEPLOY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const ANVIL_ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

  it("flags the first Anvil deploy address", () => {
    const found = findPlaceholders("config.ts", `export const TOKEN = "${ANVIL_FIRST_DEPLOY}";`);
    const finding = found.find((p) => p.kind === "local-chain-address");
    expect(finding).toBeDefined();
    expect(finding?.reason).toContain("first contract deployed by Anvil");
    expect(finding?.reason).toContain("nothing throws");
  });

  it("flags Anvil account addresses", () => {
    expect(
      findPlaceholders("c.ts", `const TREASURY = "${ANVIL_ACCOUNT_0}";`).some(
        (p) => p.kind === "local-chain-address",
      ),
    ).toBe(true);
  });

  it("is case-insensitive, since checksums vary by source", () => {
    const lower = findPlaceholders("c.ts", `a = "${ANVIL_FIRST_DEPLOY.toLowerCase()}"`);
    expect(lower.some((p) => p.kind === "local-chain-address")).toBe(true);
  });

  it("names each address separately when a line carries several", () => {
    const found = findPlaceholders(
      "c.ts",
      `const PAIR = ["${ANVIL_FIRST_DEPLOY}", "${ANVIL_ACCOUNT_0}"];`,
    ).filter((p) => p.kind === "local-chain-address");
    expect(found).toHaveLength(2);
    expect(found[0]?.reason).not.toBe(found[1]?.reason);
  });

  it("does NOT flag an ordinary mainnet address", () => {
    // Without this the check could 'pass' by flagging every address it sees.
    const found = findPlaceholders(
      "c.ts",
      `const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";`,
    );
    expect(found.filter((p) => p.kind === "local-chain-address")).toEqual([]);
  });

  it("respects placeholder-ok, so local test fixtures stay usable", () => {
    // A check that cannot be silenced gets disabled wholesale instead of locally.
    const found = findPlaceholders("t.ts", `const A = "${ANVIL_FIRST_DEPLOY}"; // placeholder-ok`);
    expect(found).toEqual([]);
  });
});
