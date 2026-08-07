/**
 * Secret detection, built from a leak that actually happened.
 *
 * ══ The incident this exists to prevent ══
 *
 * A prior project committed `.nixpacks/build.sh` — a Railway build script recovered from
 * a running container. It was a single line containing the whole `docker build`
 * invocation with **every env var inlined as a literal `--build-arg`**: three live EOA
 * private keys, a Postgres password, an Alchemy key and a Privy app secret. Tracked, in
 * HEAD, pushed.
 *
 * The generalisable lesson: **platform-recovered build artifacts bake resolved env vars
 * into plain text**, and "recover the source from the running container" is a routine
 * move. Scanning only `.env` would have missed all of it.
 *
 * ══ The hard part: a private key looks like a hash ══
 *
 * `0x` + 64 hex is a private key, a transaction hash, a block hash, a bytes32 storage
 * slot, an event topic0, or a keccak digest. **Regex alone cannot tell them apart**, and
 * a scanner that flags all of them gets switched off within a day.
 *
 * So this uses CONTEXT, not just shape:
 *   - the variable name it is assigned to (`PRIVATE_KEY=`, `--build-arg DEPLOYER_KEY=`)
 *   - known-public constants (Anvil's default accounts are published, not secrets)
 *   - the file it lives in (a build artifact is far more suspicious than a test fixture)
 *
 * A finding carries its reasoning, so a human can overrule it in one line rather than
 * disabling the check.
 */

export type Severity = "critical" | "high" | "medium";

export type Finding = {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly severity: Severity;
  /** Why this is believed to be a secret. Never bare "match found". */
  readonly reason: string;
  /** The line with the secret value masked. Never the secret itself. */
  readonly redacted: string;
};

/**
 * Publicly published keys that are not secrets.
 *
 * Anvil and Hardhat derive accounts from a well-known mnemonic printed on every startup.
 * Flagging them trains people to ignore the scanner, which is worse than not scanning.
 */
const KNOWN_PUBLIC_KEYS = new Set([
  // Anvil / Hardhat account #0 and #1
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
]);

/**
 * Names that make a 64-hex value a key rather than a hash.
 *
 * Matches SCREAMING_SNAKE (`DEPLOYER_PRIVATE_KEY`) and camelCase (`signerKey`) alike —
 * a key is no less a key for being declared in TypeScript rather than a shell script.
 *
 * `root[_]?key` is here because `root` is also a HASH_WORD (a merkle root is a hash), and
 * this list is consulted FIRST — so `rootKey` resolves as a key rather than being dismissed
 * by its `root` segment. Without it, `ROOT_KEY=0x…` in a `.env` reads as a merkle root.
 */
const KEY_NAME =
  /\b([A-Za-z0-9_]*(?:private[_]?key|priv[_]?key|secret[_]?key|signer[_]?key|deployer[_]?key|keeper[_]?key|root[_]?key|mnemonic)[A-Za-z0-9_]*)\b/i;
/**
 * Words that make a 64-hex value legitimately a hash.
 *
 * ══ The bug the segment split below fixes ══
 *
 * This was matched with `\b(tx|hash|block|…)\b` against the raw line, which does NOT match
 * `txHash`, `blockHash` or `TX_HASH`. There is no word boundary between `tx` and `Hash`
 * inside an identifier, and `_` is a word character, so `\btx\b` fails on `TX_HASH` too.
 * Those are the ordinary ways to name a hash in real code, and none of them was recognised.
 *
 * The consequence was live and one-directional. In an ordinary source file the value fell
 * through to the final `return undefined` and looked correct by accident — which is why
 * the existing "stays quiet on a transaction hash" tests passed. But inside a `.env` or a
 * build artifact, the exact files where unlabelled hex is escalated, a documented
 * transaction hash was reported as a probable private key at `high`. That is precisely the
 * noise this module's own header says gets a scanner switched off within a day.
 */
const HASH_WORDS = new Set([
  "tx",
  "transaction",
  "block",
  "topic",
  "hash",
  "digest",
  "root",
  "salt",
  "commit",
  "selector",
  "slot",
]);

/**
 * Split a line into identifier segments: `const txHash` -> `const`, `tx`, `hash`;
 * `BLOCK_HASH` -> `block`, `hash`; `TOPIC0` -> `topic`, `0`. Splitting on camelCase, on
 * `_`, and on the letter/digit join is what lets a whole-word set work on identifiers,
 * which a `\b` boundary cannot do.
 *
 * A trailing plural is stripped so `txHashes` reads as `hashes` -> `hash`.
 */
function hasHashWord(line: string): boolean {
  const segments = line
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((s) => s.toLowerCase().replace(/s$/, ""));
  return segments.some((s) => HASH_WORDS.has(s));
}

const HEX64 = /\b(?:0x)?(?<hex>[a-fA-F0-9]{64})\b/d;

const PATTERNS: ReadonlyArray<{
  readonly kind: string;
  readonly severity: Severity;
  readonly regex: RegExp;
  readonly reason: string;
}> = [
  {
    kind: "postgres-url",
    severity: "critical",
    regex: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/,
    reason: "a Postgres connection string with an embedded password",
  },
  {
    kind: "mongodb-url",
    severity: "critical",
    regex: /mongodb(?:\+srv)?:\/\/[^:\s]+:[^@\s]+@/,
    reason: "a MongoDB connection string with an embedded password",
  },
  {
    kind: "redis-url",
    severity: "high",
    regex: /redis(?:s)?:\/\/[^:\s]*:[^@\s]+@/,
    reason: "a Redis URL with an embedded password",
  },
  {
    kind: "provider-key-in-url",
    severity: "critical",
    regex:
      /https?:\/\/[^\s"']*\.(?:alchemy|infura|quiknode|quicknode|ankr)\.[^\s"']*\/(?:v\d+\/)?[A-Za-z0-9_-]{20,}/i,
    reason: "an RPC provider API key embedded in a URL path",
  },
  {
    kind: "aws-access-key",
    severity: "critical",
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    reason: "an AWS access key id",
  },
  {
    kind: "openai-key",
    severity: "critical",
    regex: /\bsk-[A-Za-z0-9]{20,}\b/,
    reason: "an OpenAI-style API key",
  },
  {
    kind: "anthropic-key",
    severity: "critical",
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
    reason: "an Anthropic API key",
  },
  {
    kind: "github-token",
    severity: "critical",
    regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    reason: "a GitHub token",
  },
  {
    kind: "bearer-token",
    severity: "medium",
    regex: /\bBearer\s+[A-Za-z0-9._-]{30,}\b/,
    reason: "a hardcoded bearer token",
  },
  {
    kind: "mnemonic",
    severity: "critical",
    regex: /\b(?:[a-z]{3,8}\s+){11}[a-z]{3,8}\b/,
    reason: "a 12-word sequence consistent with a BIP-39 mnemonic",
  },
];

/**
 * Files whose mere presence is the finding.
 *
 * A build artifact recovered from a container has resolved env vars baked in by
 * construction. It should never be committed, whatever it appears to contain.
 */
const DANGEROUS_PATHS = [
  {
    pattern: /(^|\/)\.nixpacks\//,
    reason: "a platform build artifact — these bake RESOLVED env vars into plain text",
  },
  { pattern: /(^|\/)\.env$/, reason: "a real env file (only .env.example belongs in a repo)" },
  { pattern: /(^|\/)\.env\.(?!example|sample|template)/, reason: "a real env file" },
  { pattern: /\.pem$|\.key$|(^|\/)id_rsa$|(^|\/)id_ed25519$/, reason: "a private key file" },
  {
    pattern: /(^|\/)\.claude\/settings\.json$/,
    reason:
      "an agent settings file — permission allowlists have leaked credentials embedded in command strings",
  },
];

/** Mask a value so a finding can be reported without reprinting the secret. */
function redact(line: string): string {
  return line
    .replace(/(0x)?[a-fA-F0-9]{40,}/g, "«redacted»")
    .replace(/:\/\/([^:\s]+):([^@\s]+)@/g, "://$1:«redacted»@")
    .replace(/\b(sk-[A-Za-z0-9-]{3}|gh[pousr]_|AKIA|ASIA)[A-Za-z0-9_-]{10,}/g, "$1«redacted»")
    .replace(/(=|\s)[A-Za-z0-9_-]{32,}/g, "$1«redacted»")
    .trim()
    .slice(0, 160);
}

/**
 * Decide whether a 64-hex value is a key or a hash.
 *
 * This is the judgement the whole scanner rests on. Getting it wrong in one direction
 * leaks a key; in the other it produces noise until someone disables the check.
 */
export function classifyHex64(line: string, filePath: string): Finding["severity"] | undefined {
  // Typed so the named group is non-optional. TypeScript's lib declares `groups` as
  // `| undefined` for every regex, since it cannot know a pattern contains one — but this
  // pattern's `(?<hex>…)` is mandatory, so a successful exec always populates it. Stating
  // that here removes the fallback rather than suppressing the branch it would create.
  const match = HEX64.exec(line) as (RegExpExecArray & { groups: { hex: string } }) | null;
  if (!match) return undefined;

  /**
   * The 64 hex characters, read from a **named** group.
   *
   * This was `(match[2] ?? "")`, and that fallback was unreachable — group 2 is the
   * mandatory `([a-fA-F0-9]{64})`, so a successful `exec` always yields a string. But
   * `noUncheckedIndexedAccess` treats every numeric index as optional, so the `?? ""`
   * existed purely to compile, leaving a branch no test could reach.
   *
   * A named group carries a non-optional type through `groups`, so the fallback is gone
   * rather than suppressed — the same choice made in `findSaturation` and in
   * `assessFrames` in `@taia/ui`.
   */
  const value = match.groups.hex.toLowerCase();
  if (KNOWN_PUBLIC_KEYS.has(value)) return undefined;

  const named = KEY_NAME.test(line);

  // A KEY NAME beats every heuristic below. Order matters: checking the placeholder
  // shape first would dismiss `signerKey = 0xbbbb…bb` as a dummy, and a developer who
  // pastes a real key over a dummy without renaming the variable is exactly the case
  // that leaks. Found by a test that asserted the camelCase form.
  if (named) return "critical";

  // Unnamed: all-same-digit or zero-padded values are placeholders, not keys.
  if (/^(.)\1{63}$/.test(value)) return undefined;
  if (/^0{40,}/.test(value)) return undefined;

  if (hasHashWord(line)) return undefined;

  // Unlabelled 64-hex in a build artifact or env file is far more likely to be a key.
  if (DANGEROUS_PATHS.some((p) => p.pattern.test(filePath))) return "high";

  // Elsewhere it is probably a hash. Reporting every one of these is how a scanner
  // gets turned off, so stay quiet and rely on the name-based rule above.
  return undefined;
}

export function scanContent(filePath: string, content: string): Finding[] {
  const findings: Finding[] = [];

  content.split("\n").forEach((line, index) => {
    if (line.includes("secret-scan-ok")) return;
    const lineNo = index + 1;

    for (const p of PATTERNS) {
      if (p.regex.test(line)) {
        findings.push({
          file: filePath,
          line: lineNo,
          kind: p.kind,
          severity: p.severity,
          reason: p.reason,
          redacted: redact(line),
        });
      }
    }

    const hexSeverity = classifyHex64(line, filePath);
    if (hexSeverity) {
      const named = KEY_NAME.exec(line)?.[1];
      findings.push({
        file: filePath,
        line: lineNo,
        kind: "private-key",
        severity: hexSeverity,
        reason: named
          ? `64-hex value assigned to "${named}" — that name means it is a key, not a hash`
          : "unlabelled 64-hex value in a build artifact or env file, where keys are resolved into plain text",
        redacted: redact(line),
      });
    }
  });

  return findings;
}

/** Flag a file whose presence alone is the problem. */
export function scanPath(filePath: string): Finding | undefined {
  for (const { pattern, reason } of DANGEROUS_PATHS) {
    if (pattern.test(filePath)) {
      return {
        file: filePath,
        line: 0,
        kind: "dangerous-file",
        severity: "critical",
        reason: `${reason} — it must not be committed`,
        redacted: filePath,
      };
    }
  }
  return undefined;
}

export type ScanResult = {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly critical: number;
};

export function scanFiles(
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
): ScanResult {
  const findings: Finding[] = [];

  for (const file of files) {
    const pathFinding = scanPath(file.path);
    if (pathFinding) findings.push(pathFinding);
    findings.push(...scanContent(file.path, file.content));
  }

  const critical = findings.filter((f) => f.severity === "critical").length;
  return { ok: findings.length === 0, findings, critical };
}

/** Report. Never prints a secret — only its location and why it was flagged. */
export function formatFindings(result: ScanResult): string {
  if (result.ok) return "no secrets found";

  const lines = [
    `SECRETS DETECTED — ${result.findings.length} finding(s), ${result.critical} critical`,
    "",
  ];
  for (const f of result.findings) {
    lines.push(
      `  ${f.severity.toUpperCase().padEnd(8)} ${f.file}${f.line > 0 ? `:${f.line}` : ""}  [${f.kind}]`,
    );
    lines.push(`           ${f.reason}`);
    lines.push(`           ${f.redacted}`);
  }
  lines.push("");
  lines.push("  Rotate anything real before doing anything else. Removing it from the working");
  lines.push("  tree does NOT remove it from git history, and a pushed secret is already public.");
  return lines.join("\n");
}
