/**
 * Secret-scanner tests.
 *
 * Two halves, and the second matters as much as the first: it must catch the leak that
 * actually happened, AND stay quiet on the hashes that fill a web3 codebase. A scanner
 * that cries wolf gets disabled, and then it protects nothing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyHex64, formatFindings, scanContent, scanFiles, scanPath } from "./secrets.js";

const REAL_LEAK = "/root/work/legacy-git/ponsball/.nixpacks/build.sh";

describe("the leak that actually shipped", () => {
  /**
   * `.nixpacks/build.sh` — a Railway build script recovered from a running container,
   * one line, every env var inlined as a literal --build-arg. Three live private keys, a
   * Postgres password, an Alchemy key and a Privy secret. Tracked, in HEAD, pushed.
   */
  it("catches every category in the real artifact", () => {
    const content = readFileSync(REAL_LEAK, "utf8");

    const result = scanFiles([{ path: ".nixpacks/build.sh", content }]);
    const kinds = new Set(result.findings.map((f) => f.kind));

    expect(kinds.has("dangerous-file"), "the artifact itself must be flagged").toBe(true);
    expect(kinds.has("postgres-url")).toBe(true);
    expect(kinds.has("provider-key-in-url")).toBe(true);
    expect(kinds.has("private-key")).toBe(true);
    expect(result.critical).toBeGreaterThanOrEqual(4);
  });

  it("never reprints the secret it found", () => {
    const content = readFileSync(REAL_LEAK, "utf8");
    const report = formatFindings(scanFiles([{ path: ".nixpacks/build.sh", content }]));
    expect(report).toContain("«redacted»");
    // The known Anvil key is public, but any 64-hex run in the report would be a leak.
    expect(/[a-fA-F0-9]{40,}/.test(report), "no long hex may survive into a report").toBe(false);
  });
});

describe("staying quiet — the half that decides whether anyone keeps the check on", () => {
  const quiet: Array<[string, string, string]> = [
    [
      "events.ts",
      'const TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";',
      "an event topic0",
    ],
    [
      "tx.ts",
      'const txHash = "0xa1705eda33da91b7dc7e0abb8acc44e99bb8cbdd0ecc4c9030c583c593c2a098";',
      "a transaction hash",
    ],
    [
      "pool.ts",
      'const poolId = "0x66b4aa19dcc292589ab1de217b4973513cf40e6bbd974607709f55c88df3fab9";',
      "a pool id",
    ],
    [
      "block.ts",
      'const blockHash = "0x3b1f877c15aee2e5eb1d0607f45871fd3fdfada1b2c3d4e5f60718293a4b5c6d7";',
      "a block hash",
    ],
  ];

  it.each(quiet)("stays quiet on %s containing %s", (file, line) => {
    expect(scanContent(file, line)).toEqual([]);
  });

  /** Anvil prints its mnemonic on every startup. Flagging it trains people to ignore the tool. */
  it("does not flag Anvil's published test key", () => {
    const line = "uint256 pk = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;";
    expect(scanContent("test/Setup.t.sol", line)).toEqual([]);
  });

  it("does not flag an obvious placeholder", () => {
    expect(scanContent("salt.ts", `const salt = "0x${"1".repeat(64)}";`)).toEqual([]);
    expect(scanContent("c.ts", `const empty = "0x${"0".repeat(64)}";`)).toEqual([]);
  });

  it("honours an explicit opt-out for a reviewed line", () => {
    const line =
      "KEEPER_PRIVATE_KEY=0x4c0883a69102937d6231471b5dbb6204fe512961708279fa5b2d0e7e8f4b1234 // secret-scan-ok: rotated fixture";
    expect(scanContent("fixtures.ts", line)).toEqual([]);
  });
});

describe("classifyHex64 — the judgement the scanner rests on", () => {
  it("treats a value named as a key as critical", () => {
    expect(classifyHex64(`DEPLOYER_PRIVATE_KEY=0x${"a".repeat(63)}1`, "x.sh")).toBe("critical");
    expect(classifyHex64(`const signerKey = '0x${"b".repeat(64)}'`, "x.ts")).toBe("critical");
  });

  it("treats a value named as a hash as not a secret", () => {
    expect(classifyHex64(`const txHash = '0x${"c".repeat(63)}2'`, "x.ts")).toBeUndefined();
  });

  /** Unlabelled hex is ambiguous everywhere EXCEPT where env vars get resolved. */
  it("escalates unlabelled hex only inside an env file or build artifact", () => {
    const line = `VALUE=0x${"d".repeat(63)}3`;
    expect(classifyHex64(line, "src/app.ts")).toBeUndefined();
    expect(classifyHex64(line, ".env")).toBe("high");
    expect(classifyHex64(line, "app/.nixpacks/build.sh")).toBe("high");
  });

  /**
   * ══ A REAL BUG, found by covering the hash-name branch ══
   *
   * `HASH_NAME` was `\b(tx|transaction|block|topic|hash|…)\b` tested against the raw line.
   * A `\b` boundary does not exist between `tx` and `Hash` inside `txHash`, and `_` is a
   * word character so `\btx\b` also fails on `TX_HASH`. **Not one of the ordinary ways to
   * name a hash in real code was recognised**, and the branch had never executed.
   *
   * The existing "stays quiet on a transaction hash" tests passed anyway — by accident.
   * They scan `tx.ts`, where an unrecognised value falls through to the final
   * `return undefined` for a completely different reason (not a dangerous path). The
   * hash-name rule was doing nothing.
   *
   * Where it bit: inside a `.env` or a build artifact, which is exactly where unlabelled
   * hex is escalated to `high`. A documented transaction hash in a `.env` was reported as
   * a probable private key — the false-positive noise this module's own header says gets a
   * scanner switched off within a day. Fixed by splitting the line into identifier
   * segments (camelCase, `_`, and the letter/digit join) and matching whole words.
   *
   * These cases are asserted against `.env` deliberately: in a source file they would pass
   * for the wrong reason, which is how the bug survived in the first place.
   */
  it.each([
    ['const txHash = "0x…"', "camelCase"],
    ["TX_HASH=0x…", "SCREAMING_SNAKE"],
    ['const blockHash = "0x…"', "camelCase, two words"],
    ["BLOCK_HASH=0x…", "SCREAMING_SNAKE, two words"],
    ["TRANSACTION_HASH=0x…", "the unabbreviated form"],
    ['const TOPIC0 = "0x…"', "a trailing digit, no separator"],
    ['const merkleRoot = "0x…"', "a merkle root"],
    ['const storageSlot = "0x…"', "a storage slot"],
    ['const commitHash = "0x…"', "a commit hash"],
    ['txHashes = ["0x…"]', "a plural"],
  ])("recognises %s (%s) as a hash even inside a .env", (template) => {
    const line = template.replace(
      "0x…",
      `0x${"a1705eda33da91b7dc7e0abb8acc44e99bb8cbdd0ecc4c9030c583c593c2a098"}`,
    );
    expect(
      classifyHex64(line, ".env"),
      "a documented hash must not be reported as a private key",
    ).toBeUndefined();
    expect(scanContent(".env", line)).toEqual([]);
  });

  /**
   * The control, and the reason the fix could not simply widen the hash list.
   *
   * `root` is a hash word (a merkle root is a hash), so relaxing the boundaries made
   * `rootKey` resolve as a hash and stop being reported — a silent downgrade of a real key
   * name. `KEY_NAME` is consulted first and now carries `root[_]?key`, so the key reading
   * wins. Every one of these must stay critical however the name is spelled.
   */
  it.each(["PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "TX_PRIVATE_KEY", "ROOT_KEY", "MNEMONIC"])(
    "still treats %s as a key, not a hash",
    (name) => {
      expect(
        classifyHex64(
          `${name}=0x${"4c0883a69102937d6231471b5dbb6204fe512961708279fa5b2d0e7e8f4b1234"}`,
          ".env",
        ),
      ).toBe("critical");
    },
  );

  it.each(["signerKey", "keeperKey", "rootKey"])("still treats a camelCase %s as a key", (name) => {
    const line = `const ${name} = "0x${"4c0883a69102937d6231471b5dbb6204fe512961708279fa5b2d0e7e8f4b1234"}";`;
    expect(classifyHex64(line, "src/deploy.ts")).toBe("critical");
  });

  it("says nothing about a line with no 64-hex value in it at all", () => {
    expect(classifyHex64("const x = 1;", ".env")).toBeUndefined();
    // 63 hex digits is not a key — the word boundary must hold, or every truncated hash
    // in the tree becomes a finding and the scanner gets switched off.
    expect(classifyHex64(`KEY=0x${"a".repeat(63)}`, ".env")).toBeUndefined();
  });

  /**
   * The zero-padded placeholder rule, distinct from the all-same-digit rule above it.
   *
   * The existing placeholder test uses `0x000…0`, which is caught one line earlier by the
   * all-identical check — so the leading-zeros rule had never fired on its own. It exists
   * for the shapes that are NOT all-identical: a left-padded small integer or a
   * hand-written bytes32 constant. Without it those read as unlabelled hex and, inside a
   * `.env`, would be escalated to `high` — noise in exactly the file people scan most.
   */
  it("dismisses a zero-padded value that is not all the same digit", () => {
    const padded = `0x${"0".repeat(50)}abcdef01234567`;
    expect(classifyHex64(`VALUE=${padded}`, ".env")).toBeUndefined();
    expect(scanContent(".env", `VALUE=${padded}`)).toEqual([]);
  });

  /**
   * A key name still wins over the zero-padding rule.
   *
   * The control for the test above: `PRIVATE_KEY=0x000…` must stay critical. A developer
   * who pastes a real key over a zero placeholder without renaming the variable is exactly
   * the case that leaks, and the name check runs first for that reason.
   */
  it("still flags a zero-padded value that is named as a key", () => {
    expect(classifyHex64(`PRIVATE_KEY=0x${"0".repeat(64)}`, "src/app.ts")).toBe("critical");
  });
});

describe("scanContent reasoning", () => {
  /**
   * The unlabelled-hex reason string, which had never been rendered.
   *
   * `classifyHex64` was tested directly for the `high` verdict, but nothing had driven
   * `scanContent` down the path where the finding carries *no* variable name — so the
   * sentence a reviewer actually reads for the most ambiguous class of finding had never
   * been produced. It has to explain WHY an unnamed value is suspicious here and not
   * elsewhere, or the reviewer has no basis to overrule it.
   */
  it("explains an unlabelled hex finding by the file it lives in", () => {
    const findings = scanContent(".env", `VALUE=0x${"d".repeat(63)}3`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.kind).toBe("private-key");
    expect(findings[0]?.reason).toContain("unlabelled 64-hex value");
    expect(findings[0]?.reason).toContain("keys are resolved into plain text");
    expect(findings[0]?.redacted, "the value must never survive into the report").not.toMatch(
      /[a-fA-F0-9]{40,}/,
    );
  });

  it("names the variable when there is one to name", () => {
    const findings = scanContent("deploy.ts", `const deployerKey = "0x${"e".repeat(64)}";`);
    expect(findings[0]?.severity).toBe("critical");
    expect(findings[0]?.reason).toContain('assigned to "deployerKey"');
    expect(findings[0]?.reason).toContain("it is a key, not a hash");
  });
});

describe("dangerous paths", () => {
  it.each([
    [".nixpacks/build.sh", "build artifact"],
    [".env", "real env file"],
    ["apps/web/.env.production", "real env file"],
    ["keys/deployer.pem", "private key file"],
    [".claude/settings.json", "agent settings"],
  ])("flags %s (%s)", (path) => {
    expect(scanPath(path)?.severity).toBe("critical");
  });

  it.each([[".env.example"], [".env.sample"], ["src/app.ts"], ["README.md"]])(
    "allows %s",
    (path) => {
      expect(scanPath(path)).toBeUndefined();
    },
  );
});

describe("credential patterns", () => {
  it.each([
    ["postgres-url", "DATABASE_URL=postgresql://user:hunter2@db.example.com:5432/app"],
    ["redis-url", "REDIS_URL=redis://default:s3cr3tpass@redis.example.com:6379"],
    ["aws-access-key", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"],
    ["github-token", "GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["anthropic-key", "ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz123456"],
    [
      "provider-key-in-url",
      "RPC=https://eth-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz123456",
    ],
  ])("detects a %s", (kind, line) => {
    const found = scanContent("config.ts", line);
    expect(found.map((f) => f.kind)).toContain(kind);
  });

  it("detects a BIP-39-shaped mnemonic", () => {
    const line = "MNEMONIC=test test test test test test test test test test test junk";
    expect(scanContent(".env.local", line).some((f) => f.kind === "mnemonic")).toBe(true);
  });
});

describe("formatFindings", () => {
  it("says so plainly when nothing was found", () => {
    expect(formatFindings(scanFiles([{ path: "a.ts", content: "const x = 1;" }]))).toBe(
      "no secrets found",
    );
  });

  it("tells the reader that rotation, not deletion, is the fix", () => {
    const report = formatFindings(
      scanFiles([{ path: ".env", content: "DATABASE_URL=postgres://u:p@h/db" }]),
    );
    expect(report).toMatch(/Rotate anything real/);
    expect(report).toMatch(/does NOT remove it from git history/);
  });
});
