import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assessConfig,
  checkDependencies,
  checkInsecureUrls,
  checkPemValue,
  checkPlaceholders,
  checkRequired,
  DEPRECATED_PACKAGES,
  formatConfig,
  parseRawEnv,
} from "./config.js";

/** A real PEM, so the tests below are about actual crypto rather than a shape. */
const { publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const REAL_PEM = publicKey.toString();
const ESCAPED_PEM = REAL_PEM.replace(/\n/g, "\\n");

describe("parseRawEnv", () => {
  it("keeps quotes, because the quoting is what decides correctness", () => {
    const entries = parseRawEnv('A="quoted"\nB=bare');
    expect(entries).toEqual([
      { key: "A", rawValue: '"quoted"' },
      { key: "B", rawValue: "bare" },
    ]);
  });

  it("ignores comments, blanks and malformed keys", () => {
    expect(parseRawEnv("# note\n\n=novalue\n1BAD=x\nOK=1")).toEqual([{ key: "OK", rawValue: "1" }]);
  });

  it("handles an export prefix", () => {
    expect(parseRawEnv("export A=1")[0]?.key).toBe("A");
  });
});

/**
 * The bug this module exists for, verified against Node's own parser rather than asserted.
 *
 * Measured on the operator's live .env: PRIVY_VERIFICATION_KEY is an unquoted PEM holding
 * literal \n. As dotenv would load it, createPublicKey FAILS with
 * "error:1E08010C:DECODER routines::unsupported"; after repair it parses. That is a total
 * authentication outage reported as "invalid or expired token".
 */
describe("the PEM newline bug", () => {
  it("proves an escaped, unquoted PEM does not parse", () => {
    expect(() => createPublicKey(ESCAPED_PEM)).toThrow();
  });

  it("proves the repaired value does parse", () => {
    expect(() => createPublicKey(ESCAPED_PEM.replace(/\\n/g, "\n"))).not.toThrow();
  });

  it("flags exactly that combination", () => {
    const finding = checkPemValue({ key: "PRIVY_VERIFICATION_KEY", rawValue: ESCAPED_PEM });
    expect(finding?.severity).toBe("critical");
    expect(finding?.detail).toContain("invalid or expired token");
    expect(finding?.fix).toContain('PRIVY_VERIFICATION_KEY="');
  });

  it("accepts the same PEM once it is double-quoted", () => {
    // dotenv converts \n inside double quotes, so this loads correctly.
    expect(checkPemValue({ key: "K", rawValue: `"${ESCAPED_PEM}"` })).toBeUndefined();
  });

  it("accepts a PEM carrying real newlines", () => {
    expect(checkPemValue({ key: "K", rawValue: REAL_PEM })).toBeUndefined();
  });

  it("flags a single-line PEM with no newlines of any kind", () => {
    const stripped = REAL_PEM.replace(/\n/g, "");
    const finding = checkPemValue({ key: "K", rawValue: stripped });
    expect(finding?.severity).toBe("critical");
    expect(finding?.detail).toContain("no newlines at all");
  });

  it("ignores values that are not PEMs", () => {
    expect(checkPemValue({ key: "API_KEY", rawValue: "abc\\ndef" })).toBeUndefined();
  });

  it("catches a private key PEM, not only a public one", () => {
    const priv = "-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----";
    expect(checkPemValue({ key: "K", rawValue: priv })?.severity).toBe("critical");
  });
});

describe("checkDependencies", () => {
  /**
   * The deprecation their own prior code already migrated past — and the trap in doing so:
   * the method name changed too, so a copy-paste migration compiles and fails at runtime.
   */
  it("flags @privy-io/server-auth and names the method change", () => {
    const findings = checkDependencies({ "@privy-io/server-auth": "^1.32.5" });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("verifyAccessToken");
    expect(findings[0]?.fix).toContain("@privy-io/node");
  });

  it("flags WalletConnect v1, which cannot connect at all", () => {
    expect(checkDependencies({ "@walletconnect/web3-provider": "^1.8.0" })[0]?.detail).toContain(
      "relay is gone",
    );
  });

  it("says nothing about current packages", () => {
    expect(checkDependencies({ viem: "2.55.10", "@privy-io/node": "0.28.0" })).toEqual([]);
  });

  it("gives every deprecated entry a replacement and a reason", () => {
    for (const [name, entry] of Object.entries(DEPRECATED_PACKAGES)) {
      expect(entry.replacement, name).toBeTruthy();
      expect(entry.note.length, name).toBeGreaterThan(10);
    }
  });
});

describe("checkRequired", () => {
  it("names the silent consequence, not just the absence", () => {
    const findings = checkRequired(new Set(["A"]), [
      { key: "B", consequence: "the API falls back to the public RPC and rate-limits under load" },
    ]);
    expect(findings[0]?.detail).toContain("falls back to the public RPC");
  });

  it("says nothing when everything is present", () => {
    expect(checkRequired(new Set(["A", "B"]), [{ key: "A", consequence: "x" }])).toEqual([]);
  });
});

describe("checkPlaceholders", () => {
  it("catches values someone meant to replace", () => {
    const findings = checkPlaceholders(
      parseRawEnv("A=your_api_key_here\nB=changeme\nC=TBA\nD=<fill-me>"),
    );
    expect(findings.map((f) => f.key).sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("does not fire on a real value that merely starts with similar letters", () => {
    // "yourbank" is a plausible real hostname; flagging it trains people to ignore this.
    expect(checkPlaceholders(parseRawEnv("A=https://yourbank.example.com"))).toEqual([]);
  });

  it("ignores an empty value, whose absence is already loud", () => {
    expect(checkPlaceholders(parseRawEnv("A="))).toEqual([]);
  });
});

describe("checkInsecureUrls", () => {
  it("flags http to a remote host", () => {
    const findings = checkInsecureUrls(parseRawEnv("API=http://api.example.com"));
    expect(findings[0]?.detail).toContain("mixed content");
  });

  it("does not flag localhost, which is normal in development", () => {
    expect(
      checkInsecureUrls(parseRawEnv("A=http://localhost:8545\nB=http://127.0.0.1:3000")),
    ).toEqual([]);
  });

  it("does not flag https", () => {
    expect(checkInsecureUrls(parseRawEnv("A=https://api.example.com"))).toEqual([]);
  });
});

describe("assessConfig", () => {
  it("passes a clean configuration", () => {
    const result = assessConfig({
      envContent: 'KEY="value"\nURL=https://api.example.com',
      dependencies: { viem: "2.55.10" },
    });
    expect(result.ok).toBe(true);
    expect(formatConfig(result)).toContain("no problems found");
  });

  it("fails on the PEM bug and reports the fix", () => {
    const result = assessConfig({ envContent: `PRIVY_VERIFICATION_KEY=${ESCAPED_PEM}` });
    expect(result.ok).toBe(false);
    expect(formatConfig(result)).toContain("fix:");
  });

  it("does not fail the gate on warnings alone", () => {
    // A deprecated dependency is a migration to plan, not a reason to block a deploy.
    const result = assessConfig({ dependencies: { "@privy-io/server-auth": "^1.32.5" } });
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
  });

  it("reports critical and warning findings together", () => {
    const result = assessConfig({
      envContent: `K=${ESCAPED_PEM}\nAPI=http://remote.example.com`,
      dependencies: { "@privy-io/server-auth": "^1.32.5" },
    });
    expect(result.ok).toBe(false);
    const text = formatConfig(result);
    expect(text).toContain("CONFIG FAILED");
    expect(text).toContain("Warnings");
  });

  it("explains why these are dangerous rather than merely listing them", () => {
    const result = assessConfig({ envContent: `K=${ESCAPED_PEM}` });
    expect(formatConfig(result)).toContain("blames something else");
  });

  it("works with no inputs at all", () => {
    expect(assessConfig({})).toEqual({ ok: true, findings: [] });
  });

  /**
   * `required` is the one input `assessConfig` never wired up in a test — every case above
   * passed `envContent` and `dependencies` only, so the branch that folds `checkRequired`
   * into the findings had never run through the top-level entry point.
   *
   * It matters because this is the check with the quietest failure: a variable read with a
   * fallback means the service boots against the wrong endpoint rather than crashing. The
   * consequence text is the whole value of the finding, so it is asserted end-to-end here,
   * not just on `checkRequired` in isolation.
   */
  it("folds missing required variables into the assessment", () => {
    const result = assessConfig({
      envContent: "PRESENT=1",
      required: [
        { key: "PRESENT", consequence: "never fires — it is set" },
        { key: "ABSENT_RPC_URL", consequence: "the API falls back to the public RPC" },
      ],
    });
    expect(result.ok, "a missing required variable is critical").toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.key).toBe("ABSENT_RPC_URL");
    expect(result.findings[0]?.detail).toContain("falls back to the public RPC");
  });

  it("sees a required variable as present when the env declares it", () => {
    // The `present` set is built from the parsed entries; if that wiring broke, every
    // required variable would be reported missing and the gate would cry wolf on a
    // correct config.
    const result = assessConfig({
      envContent: 'DATABASE_URL="postgres://localhost/app"',
      required: [{ key: "DATABASE_URL", consequence: "no persistence" }],
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });
});

describe("formatConfig", () => {
  /**
   * The warnings-only rendering, which had never executed.
   *
   * Every prior formatter test produced at least one critical finding, so the branch that
   * skips the "CONFIG FAILED" header — and the one that omits the blank separator line
   * because nothing precedes the warnings — were both untested. This is the exact output a
   * developer sees on the *passing* run that still has something to say, so an unrendered
   * branch here means the first person to hit it is the first to ever run it.
   */
  it("renders warnings alone without a failure header or a leading blank line", () => {
    const result = assessConfig({
      envContent: "API=http://remote.example.com",
      dependencies: { "@privy-io/server-auth": "^1.32.5" },
    });
    expect(result.ok, "warnings alone must not fail the gate").toBe(true);

    const text = formatConfig(result);
    expect(text).not.toContain("CONFIG FAILED");
    expect(text).toContain("Warnings (2):");
    expect(text).toContain("! API is an http:// URL");
    expect(text).toContain("! @privy-io/server-auth is deprecated");
    // No separator before the heading, because nothing was printed above it.
    expect(text.split("\n")[0]).toBe("Warnings (2):");
  });

  it("separates criticals from warnings with a blank line when both are present", () => {
    const text = formatConfig(assessConfig({ envContent: `K=${ESCAPED_PEM}\nAPI=http://x.com` }));
    const lines = text.split("\n");
    const warningsAt = lines.indexOf("Warnings (1):");
    expect(warningsAt).toBeGreaterThan(0);
    expect(lines[warningsAt - 1], "the separator only appears when something precedes it").toBe("");
  });
});
