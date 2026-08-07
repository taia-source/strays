/**
 * Environment and configuration validation — the failures that produce a *misleading*
 * error message rather than an obvious one.
 *
 * ══ The bug this was built from, and it is live right now ══
 *
 * `PRIVY_VERIFICATION_KEY` in the operator's `.env` is an **unquoted PEM containing
 * literal `\n`** (backslash-n, two characters) rather than real newlines. Measured with
 * Node's own parser:
 *
 *   as dotenv would load it    -> FAILS: error:1E08010C:DECODER routines::unsupported
 *   after \n repair            -> PARSES OK
 *
 * dotenv only converts `\n` into a newline **inside double quotes**. Unquoted, the value
 * stays malformed, `createPublicKey` refuses it, and offline JWT verification rejects
 * **every token** — while reporting "invalid or expired token". So a working key, a
 * working client and correct code produce a total authentication outage that reads like a
 * user problem. A prior project hit exactly this and left the diagnosis in a comment.
 *
 * That is the signature of everything in this module: **the config is wrong in a way that
 * blames something else.**
 *
 * ══ Why the gate, and not a runtime check ══
 *
 * A runtime check fires when a user tries to log in. This fires before the deploy.
 */

export type ConfigSeverity = "critical" | "warning";

export type ConfigFinding = {
  readonly key: string;
  readonly severity: ConfigSeverity;
  /** What is wrong, and what it will look like when it breaks. */
  readonly detail: string;
  /** The fix, concretely. A finding without one is a complaint. */
  readonly fix: string;
};

/** One line of a `.env` file, kept raw so quoting is still visible. */
export type RawEnvEntry = {
  readonly key: string;
  /** Exactly as written after `=`, quotes included. */
  readonly rawValue: string;
};

/** Parse a `.env` file preserving quotes — the quoting IS the bug in the PEM case. */
export function parseRawEnv(content: string): RawEnvEntry[] {
  const entries: RawEnvEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    entries.push({ key, rawValue: trimmed.slice(eq + 1) });
  }
  return entries;
}

const PEM_MARKER = /-----BEGIN [A-Z ]*(KEY|CERTIFICATE)-----/;

/**
 * The check that motivated the module.
 *
 * A PEM is only usable from a `.env` if it either carries real newlines or is
 * double-quoted so the loader converts its `\n` escapes. Unquoted-with-literal-`\n` is the
 * broken combination, and it is silent until the first token verification fails.
 */
export function checkPemValue(entry: RawEnvEntry): ConfigFinding | undefined {
  const { key, rawValue } = entry;
  if (!PEM_MARKER.test(rawValue)) return undefined;

  const doubleQuoted = rawValue.startsWith('"') && rawValue.trimEnd().endsWith('"');
  const hasLiteralEscape = rawValue.includes("\\n");
  const hasRealNewline = rawValue.includes("\n");

  if (hasRealNewline || doubleQuoted) return undefined;

  if (hasLiteralEscape) {
    return {
      key,
      severity: "critical",
      detail:
        "holds a PEM whose newlines are literal backslash-n and the value is NOT double-quoted. " +
        "dotenv only converts \\n inside double quotes, so the key loads malformed and every " +
        'signature or token verification fails — reported as "invalid or expired token", which ' +
        "blames the user rather than the config. Verified with Node: parsing this value fails " +
        "with DECODER routines::unsupported and succeeds after repair",
      fix: `wrap the value in double quotes: ${key}="-----BEGIN ...\\n...\\n-----END ...-----"  (or replace \\n with real newlines and quote it)`,
    };
  }

  return {
    key,
    severity: "critical",
    detail: "holds a PEM on a single line with no newlines at all — it cannot be parsed",
    fix: `restore the newlines and double-quote the value`,
  };
}

/**
 * Packages whose presence is itself the finding.
 *
 * Deprecation is invisible at runtime: the code keeps working right up until it does not,
 * and by then the migration is urgent rather than planned.
 */
export const DEPRECATED_PACKAGES: Readonly<Record<string, { replacement: string; note: string }>> =
  {
    "@privy-io/server-auth": {
      replacement: "@privy-io/node",
      note:
        "deprecated on npm, last published 2025-09-17. The method name also changed: " +
        "verifyAccessToken, NOT the old verifyAuthToken — so a copy-paste migration compiles and then fails at runtime",
    },
    "@walletconnect/web3-provider": {
      replacement: "@walletconnect/ethereum-provider",
      note: "v1 was sunset; the v1 relay is gone, so this cannot connect at all",
    },
    web3modal: {
      replacement: "@reown/appkit",
      note: "renamed to Reown AppKit",
    },
    request: { replacement: "fetch or undici", note: "deprecated since 2020" },
  };

export function checkDependencies(dependencies: Readonly<Record<string, string>>): ConfigFinding[] {
  return Object.keys(dependencies)
    .filter((name) => DEPRECATED_PACKAGES[name])
    .map((name) => {
      const entry = DEPRECATED_PACKAGES[name];
      return {
        key: name,
        severity: "warning" as const,
        detail: `is deprecated — ${entry?.note}`,
        fix: `migrate to ${entry?.replacement}`,
      };
    });
}

/**
 * Variables whose *absence* is silent.
 *
 * The dangerous case is not a missing value that crashes on boot — that is loud. It is a
 * variable the code reads with a fallback, so the service starts happily against the
 * wrong endpoint or with a feature quietly disabled.
 */
export type RequiredVar = {
  readonly key: string;
  /** What silently happens when it is missing. */
  readonly consequence: string;
};

export function checkRequired(
  present: ReadonlySet<string>,
  required: readonly RequiredVar[],
): ConfigFinding[] {
  return required
    .filter((r) => !present.has(r.key))
    .map((r) => ({
      key: r.key,
      severity: "critical" as const,
      detail: `is not set — ${r.consequence}`,
      fix: `set ${r.key} before deploying`,
    }));
}

/**
 * A value that looks like a placeholder someone meant to replace.
 *
 * Distinct from the address placeholders in `@taia/deploy`: this is env config, and the
 * failure is a service that boots and behaves wrongly rather than a transaction to a dead
 * address.
 */
const PLACEHOLDER = /^(your[_-]?|xxx+$|placeholder|changeme|todo|tba|<.*>$|example)/i;

export function checkPlaceholders(entries: readonly RawEnvEntry[]): ConfigFinding[] {
  return entries
    .filter((e) => {
      const value = e.rawValue.trim().replace(/^["']|["']$/g, "");
      return value !== "" && PLACEHOLDER.test(value);
    })
    .map((e) => ({
      key: e.key,
      severity: "critical" as const,
      detail: `still holds a placeholder value — the service will start and behave as if it is configured`,
      fix: `replace ${e.key} with a real value, or remove it so its absence is loud`,
    }));
}

/**
 * A URL that is http:// where it must not be.
 *
 * Named separately from the secret scanner because the failure differs: this is not a leak
 * but plaintext credentials in transit, and browsers block it outright from an https page.
 */
export function checkInsecureUrls(entries: readonly RawEnvEntry[]): ConfigFinding[] {
  return entries
    .filter((e) => /^https?:\/\//i.test(e.rawValue.trim().replace(/^["']|["']$/g, "")))
    .filter((e) => {
      const value = e.rawValue.trim().replace(/^["']|["']$/g, "");
      if (!value.toLowerCase().startsWith("http://")) return false;
      // localhost over http is normal and flagging it trains people to ignore this.
      return !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i.test(value);
    })
    .map((e) => ({
      key: e.key,
      severity: "warning" as const,
      detail:
        "is an http:// URL to a non-local host — credentials travel in plaintext, and a browser on an https page blocks the request as mixed content",
      fix: `use https:// for ${e.key}`,
    }));
}

export type ConfigResult = {
  readonly ok: boolean;
  readonly findings: readonly ConfigFinding[];
};

export function assessConfig(options: {
  readonly envContent?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly required?: readonly RequiredVar[];
}): ConfigResult {
  const entries = options.envContent ? parseRawEnv(options.envContent) : [];
  const present = new Set(entries.map((e) => e.key));

  const findings: ConfigFinding[] = [
    ...entries.map(checkPemValue).filter((f): f is ConfigFinding => f !== undefined),
    ...checkPlaceholders(entries),
    ...checkInsecureUrls(entries),
    ...(options.dependencies ? checkDependencies(options.dependencies) : []),
    ...(options.required ? checkRequired(present, options.required) : []),
  ];

  return { ok: !findings.some((f) => f.severity === "critical"), findings };
}

export function formatConfig(result: ConfigResult): string {
  if (result.findings.length === 0) return "config: no problems found";

  const critical = result.findings.filter((f) => f.severity === "critical");
  const warnings = result.findings.filter((f) => f.severity === "warning");
  const lines: string[] = [];

  if (critical.length > 0) {
    lines.push(`CONFIG FAILED — ${critical.length} critical:`);
    for (const f of critical) {
      lines.push(`  ✗ ${f.key} ${f.detail}`);
      lines.push(`      fix: ${f.fix}`);
    }
  }
  if (warnings.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Warnings (${warnings.length}):`);
    for (const f of warnings) {
      lines.push(`  ! ${f.key} ${f.detail}`);
      lines.push(`      fix: ${f.fix}`);
    }
  }

  lines.push("");
  lines.push("  Each of these lets the service start. That is what makes them dangerous:");
  lines.push("  the failure surfaces later, as a symptom that blames something else.");
  return lines.join("\n");
}
