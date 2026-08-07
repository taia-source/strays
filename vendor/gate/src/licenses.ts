/**
 * License compliance — for a codebase an agent assembles from other people's work.
 *
 * ══ What is actually in the tree ══
 *
 * Surveyed across the installed dependency graph:
 *
 *   164 unique packages
 *     135  MIT          9  ISC          8  Apache-2.0     6  BSD-3-Clause
 *       2  MPL-2.0      2  MIT OR Apache-2.0    1  BSD-2-Clause    1  (MIT AND Zlib)
 *   packages with NO declared license: 0
 *
 * So npm dependencies are not the risk here. **Vendored source is.** Found in the archive:
 *
 *   vendor/openzeppelin-contracts-5.6.1/   — 226 .sol files, no LICENSE file anywhere
 *
 * The nuance matters, and the earlier note in ALIGNMENT was imprecise: all 226 files carry
 * `// SPDX-License-Identifier: MIT`, and the vendored `package.json` says `"license":
 * "MIT"`. The license is declared *per file*; what is missing is the top-level LICENSE
 * text. MIT requires the copyright notice and permission notice to be retained, so
 * stripping the LICENSE file while copying the code is a real, if small, compliance gap —
 * and exactly the kind of thing that happens when code is copied rather than installed.
 *
 * ══ Why an agent makes this worse ══
 *
 * An agent asked to "add a token contract" may copy source into the repo rather than
 * declaring a dependency. Copying is invisible to `pnpm ls`, to `npm audit`, and to every
 * SBOM tool that reads the lockfile. Vendored code is precisely the code no dependency
 * scanner sees.
 *
 * ══ Copyleft ══
 *
 * The point is not that copyleft is bad — it is that **AGPL in a hosted service has real
 * obligations**, and that fact should surface at install time, not in a letter. This is
 * live, not hypothetical: the natural tool for the load-testing work above (k6) is
 * AGPL-3.0, which is part of why `autocannon` (MIT) was chosen instead.
 */

/** SPDX identifiers whose obligations need a deliberate decision before shipping. */
export const COPYLEFT = [
  "AGPL-1.0",
  "AGPL-3.0",
  "GPL-2.0",
  "GPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "SSPL-1.0",
  "OSL-3.0",
  "EUPL-1.2",
] as const;

/** Weak copyleft: file-level obligations only, fine to link against in a service. */
const WEAK_COPYLEFT = new Set(["MPL-2.0", "EPL-2.0", "CDDL-1.0", "LGPL-2.1", "LGPL-3.0"]);

export type LicenseVerdict = "permissive" | "weak-copyleft" | "strong-copyleft" | "unknown";

export type PackageLicense = {
  readonly name: string;
  readonly version?: string;
  /** As declared. `undefined` when nothing declares one. */
  readonly license?: string | undefined;
  /** True when the code was copied into the repo rather than installed. */
  readonly vendored?: boolean;
};

/**
 * Classify one declaration.
 *
 * A disjunction (`"MIT OR Apache-2.0"`) is classified by its most permissive option,
 * because the consumer picks — measured in the tree above, 2 packages use this form.
 */
export function classifyLicense(license: string | undefined): LicenseVerdict {
  if (!license?.trim()) return "unknown";

  const text = license.trim();
  const upper = text.toUpperCase();

  // "SEE LICENSE IN <file>" and "UNLICENSED" are npm conventions that say nothing about
  // the terms. Treating them as known would be exactly the false comfort to avoid.
  if (upper.includes("SEE LICENSE IN") || upper === "UNLICENSED") return "unknown";

  const parts = text
    .replace(/[()]/g, " ")
    .split(/\s+OR\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length > 1) {
    const verdicts = parts.map((p) => classifyLicense(p));
    if (verdicts.includes("permissive")) return "permissive";
    if (verdicts.includes("weak-copyleft")) return "weak-copyleft";
    if (verdicts.includes("strong-copyleft")) return "strong-copyleft";
    return "unknown";
  }

  // A conjunction ("MIT AND Zlib") must satisfy every term, so take the strictest.
  const conjuncts = text
    .replace(/[()]/g, " ")
    .split(/\s+AND\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);

  const single = (id: string): LicenseVerdict => {
    const normalized = id.replace(/-only$|-or-later$|\+$/i, "").toUpperCase();
    if (COPYLEFT.some((c) => c.toUpperCase() === normalized)) {
      return WEAK_COPYLEFT.has(normalized) ? "weak-copyleft" : "strong-copyleft";
    }
    if (WEAK_COPYLEFT.has(normalized)) return "weak-copyleft";
    if (
      /^(MIT|ISC|BSD-[23]-CLAUSE|BSD|APACHE-2\.0|UNLICENSE|CC0-1\.0|0BSD|ZLIB|PYTHON-2\.0|BLUEOAK-1\.0\.0|WTFPL|ARTISTIC-2\.0)$/.test(
        normalized,
      )
    ) {
      return "permissive";
    }
    return "unknown";
  };

  if (conjuncts.length > 1) {
    const verdicts = conjuncts.map(single);
    if (verdicts.includes("unknown")) return "unknown";
    if (verdicts.includes("strong-copyleft")) return "strong-copyleft";
    if (verdicts.includes("weak-copyleft")) return "weak-copyleft";
    return "permissive";
  }

  return single(text);
}

export type LicenseFinding = {
  readonly severity: "blocking" | "review";
  readonly package: string;
  readonly detail: string;
};

export type LicensePolicy = {
  /** Strong copyleft blocks by default: an AGPL dependency in a hosted service has real obligations. */
  readonly blockStrongCopyleft: boolean;
  /** Packages accepted despite their license, each with a written reason. */
  readonly accepted?: Readonly<Record<string, string>>;
};

export const DEFAULT_LICENSE_POLICY: LicensePolicy = { blockStrongCopyleft: true };

export type LicenseResult = {
  readonly ok: boolean;
  readonly findings: readonly LicenseFinding[];
  readonly counts: Readonly<Record<LicenseVerdict, number>>;
};

export function assessLicenses(
  packages: readonly PackageLicense[],
  policy: LicensePolicy = DEFAULT_LICENSE_POLICY,
): LicenseResult {
  const findings: LicenseFinding[] = [];
  const counts: Record<LicenseVerdict, number> = {
    permissive: 0,
    "weak-copyleft": 0,
    "strong-copyleft": 0,
    unknown: 0,
  };

  for (const pkg of packages) {
    const verdict = classifyLicense(pkg.license);
    counts[verdict] += 1;

    const label = pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
    const reason = policy.accepted?.[pkg.name];
    if (reason !== undefined && reason.trim() !== "") continue;

    if (verdict === "unknown") {
      findings.push({
        severity: "review",
        package: label,
        detail: pkg.license
          ? `declares "${pkg.license}", which is not a recognised SPDX identifier — the terms are unknown until someone reads them`
          : "declares no license at all — with no grant, the default is that you have no right to use it",
      });
      continue;
    }

    if (verdict === "strong-copyleft" && policy.blockStrongCopyleft) {
      findings.push({
        severity: "blocking",
        package: label,
        detail:
          `is ${pkg.license} — strong copyleft. In a hosted service this carries real ` +
          "obligations (AGPL's network clause reaches users over HTTP). Accept it deliberately, with a reason, or replace it",
      });
      continue;
    }

    // Vendored code is invisible to every lockfile-based scanner, so it gets flagged even
    // when its license is fine — the obligation to retain the notice still applies.
    if (pkg.vendored) {
      findings.push({
        severity: "review",
        package: label,
        detail:
          `is vendored (copied into the repo, not installed) under ${pkg.license} — ` +
          "no dependency scanner or SBOM built from the lockfile will ever see it, and " +
          "permissive licenses still require the copyright notice to be retained",
      });
    }
  }

  return { ok: !findings.some((f) => f.severity === "blocking"), findings, counts };
}

/**
 * Check that vendored source keeps the notice its license requires.
 *
 * Built from a real case: `vendor/openzeppelin-contracts-5.6.1/` holds 226 `.sol` files,
 * every one carrying `SPDX-License-Identifier: MIT`, with **no LICENSE file anywhere**.
 * MIT requires the copyright and permission notice to be retained, so per-file SPDX tags
 * alone do not discharge the obligation.
 */
export function checkVendoredNotice(dir: {
  readonly path: string;
  readonly hasLicenseFile: boolean;
  readonly declaredLicense?: string | undefined;
  readonly fileCount: number;
}): LicenseFinding | undefined {
  if (dir.hasLicenseFile) return undefined;

  const verdict = classifyLicense(dir.declaredLicense);
  return {
    severity: "review",
    package: dir.path,
    detail:
      `${dir.fileCount} vendored file(s) declare ${dir.declaredLicense ?? "no license"}` +
      (verdict === "unknown"
        ? " and carry no LICENSE file — nothing in the tree states the terms"
        : ", but no LICENSE file was copied with them. The per-file SPDX tag records the license; it does not reproduce the notice the license requires you to retain"),
  };
}

export function formatLicenses(result: LicenseResult): string {
  const c = result.counts;
  const lines = [
    result.ok ? "licenses: passed" : "LICENSE CHECK FAILED",
    `  ${c.permissive} permissive · ${c["weak-copyleft"]} weak copyleft · ${c["strong-copyleft"]} strong copyleft · ${c.unknown} unknown`,
  ];

  const blocking = result.findings.filter((f) => f.severity === "blocking");
  const review = result.findings.filter((f) => f.severity === "review");

  if (blocking.length > 0) {
    lines.push("", `  blocking (${blocking.length}):`);
    lines.push(...blocking.map((f) => `    ✗ ${f.package} ${f.detail}`));
  }
  if (review.length > 0) {
    lines.push("", `  review (${review.length}):`);
    lines.push(...review.map((f) => `    ? ${f.package} ${f.detail}`));
  }
  return lines.join("\n");
}
