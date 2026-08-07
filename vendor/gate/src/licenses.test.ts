import { describe, expect, it } from "vitest";
import {
  assessLicenses,
  checkVendoredNotice,
  classifyLicense,
  DEFAULT_LICENSE_POLICY,
  formatLicenses,
  type PackageLicense,
} from "./licenses.js";

describe("classifyLicense", () => {
  it("recognises the permissive licenses actually in our tree", () => {
    // Measured across 164 installed packages: MIT 135, ISC 9, Apache-2.0 8, BSD-3 6.
    for (const id of ["MIT", "ISC", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "0BSD"]) {
      expect(classifyLicense(id), id).toBe("permissive");
    }
  });

  it("separates strong copyleft from weak", () => {
    expect(classifyLicense("AGPL-3.0")).toBe("strong-copyleft");
    expect(classifyLicense("GPL-3.0")).toBe("strong-copyleft");
    expect(classifyLicense("MPL-2.0")).toBe("weak-copyleft");
    expect(classifyLicense("LGPL-3.0")).toBe("weak-copyleft");
  });

  it("handles the -only / -or-later / + suffixes", () => {
    expect(classifyLicense("GPL-3.0-only")).toBe("strong-copyleft");
    expect(classifyLicense("AGPL-3.0-or-later")).toBe("strong-copyleft");
    expect(classifyLicense("GPL-2.0+")).toBe("strong-copyleft");
  });

  it("takes the most permissive branch of a disjunction", () => {
    // The consumer picks, so "MIT OR GPL" is usable as MIT. Two packages in our tree use
    // the "MIT OR Apache-2.0" form.
    expect(classifyLicense("MIT OR Apache-2.0")).toBe("permissive");
    expect(classifyLicense("GPL-3.0 OR MIT")).toBe("permissive");
  });

  it("takes the strictest branch of a conjunction", () => {
    // "(MIT AND Zlib)" appears once in our tree; every term must be satisfied.
    expect(classifyLicense("(MIT AND Zlib)")).toBe("permissive");
    expect(classifyLicense("MIT AND GPL-3.0")).toBe("strong-copyleft");
  });

  it("treats npm's non-answers as unknown rather than as a pass", () => {
    // "SEE LICENSE IN <file>" and "UNLICENSED" say nothing about the terms. Classifying
    // them as permissive would be exactly the false comfort this check exists to avoid.
    expect(classifyLicense("SEE LICENSE IN LICENSE.md")).toBe("unknown");
    expect(classifyLicense("UNLICENSED")).toBe("unknown");
    expect(classifyLicense(undefined)).toBe("unknown");
    expect(classifyLicense("   ")).toBe("unknown");
  });

  it("does not guess at an unrecognised identifier", () => {
    expect(classifyLicense("Weird-Corp-EULA-1.0")).toBe("unknown");
  });

  /**
   * The disjunction ladder below the permissive rung, which had never been walked.
   *
   * Every prior disjunction test offered a permissive option, so `classifyLicense`
   * returned on the first rung and the three below it never ran. That matters because the
   * consumer picks the *best* option available, and "best" here means least obligation: a
   * choice between MPL-2.0 and GPL-3.0 is a weak-copyleft package, not a strong-copyleft
   * one. Reporting it as strong copyleft would block a dependency that is fine to use, and
   * a gate that blocks things wrongly gets switched off.
   */
  it("picks weak copyleft over strong when no permissive option is offered", () => {
    expect(classifyLicense("MPL-2.0 OR GPL-3.0")).toBe("weak-copyleft");
    expect(classifyLicense("GPL-2.0 OR LGPL-3.0")).toBe("weak-copyleft");
  });

  it("reports strong copyleft when every option is strong", () => {
    expect(classifyLicense("GPL-3.0 OR AGPL-3.0")).toBe("strong-copyleft");
  });

  it("stays unknown when no option in a disjunction is recognised", () => {
    // Two unrecognised names do not add up to a known license. Falling through to
    // "permissive" here would be the single most dangerous misclassification in the file.
    expect(classifyLicense("Weird-Corp-EULA-1.0 OR Other-Corp-EULA")).toBe("unknown");
  });

  /**
   * The conjunction ladder, same story from the opposite direction: every term must be
   * satisfied, so the verdict is the *strictest*. An unrecognised term poisons the whole
   * expression — you cannot claim a package is permissive when one of its required terms
   * is something nobody has read.
   */
  it("lets an unrecognised term poison a conjunction", () => {
    expect(classifyLicense("MIT AND Weird-Corp-EULA-1.0")).toBe("unknown");
  });

  it("takes weak copyleft as the strictest term when nothing stronger is present", () => {
    expect(classifyLicense("MIT AND MPL-2.0")).toBe("weak-copyleft");
  });

  it("prefers strong over weak when a conjunction contains both", () => {
    expect(classifyLicense("MPL-2.0 AND GPL-3.0")).toBe("strong-copyleft");
  });
});

describe("assessLicenses", () => {
  const mit: PackageLicense = { name: "viem", version: "2.55.10", license: "MIT" };

  it("passes an all-permissive tree", () => {
    const r = assessLicenses([mit, { name: "vitest", license: "MIT" }]);
    expect(r.ok).toBe(true);
    expect(r.counts.permissive).toBe(2);
    expect(formatLicenses(r)).toContain("licenses: passed");
  });

  it("blocks strong copyleft and explains the network clause", () => {
    // Live, not hypothetical: k6 is AGPL-3.0, which is part of why autocannon was chosen
    // for the load module.
    const r = assessLicenses([mit, { name: "k6", license: "AGPL-3.0" }]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]?.detail).toContain("network clause");
  });

  it("allows weak copyleft without complaint", () => {
    // MPL-2.0 has file-level obligations only; two packages in our tree use it.
    const r = assessLicenses([{ name: "artillery", license: "MPL-2.0" }]);
    expect(r.ok).toBe(true);
    expect(r.counts["weak-copyleft"]).toBe(1);
  });

  it("flags a missing license with the consequence, not just the fact", () => {
    const r = assessLicenses([{ name: "mystery", license: undefined }]);
    expect(r.findings[0]?.detail).toContain("you have no right to use it");
  });

  /**
   * Declaring *something* unrecognised is a different problem from declaring nothing, and
   * the two get different text — only the "nothing" side had been tested.
   *
   * The distinction is what makes the finding actionable: "no license at all" means you
   * have no grant, whereas "SEE LICENSE IN LICENSE.md" or a bespoke EULA means the terms
   * exist and someone has to go read them. Collapsing both into the same sentence would
   * send a reviewer looking for a file that is not there, or vice versa.
   */
  it("quotes an unrecognised declaration rather than claiming none exists", () => {
    const r = assessLicenses([
      { name: "corp-sdk", version: "3.1.0", license: "SEE LICENSE IN LICENSE.md" },
    ]);
    expect(r.counts.unknown).toBe(1);
    expect(r.findings[0]?.severity).toBe("review");
    expect(r.findings[0]?.package).toBe("corp-sdk@3.1.0");
    expect(r.findings[0]?.detail).toContain('declares "SEE LICENSE IN LICENSE.md"');
    expect(r.findings[0]?.detail).toContain("unknown until someone reads them");
    expect(r.findings[0]?.detail).not.toContain("no license at all");
  });

  /**
   * `blockStrongCopyleft: false` — the deliberate opt-out for a project that has decided
   * copyleft is acceptable. It had never been exercised, so an AGPL package would have
   * kept blocking regardless of the policy and the flag would have been decoration.
   */
  it("lets a project opt out of blocking strong copyleft entirely", () => {
    const r = assessLicenses([{ name: "k6", license: "AGPL-3.0" }], {
      blockStrongCopyleft: false,
    });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.counts["strong-copyleft"]).toBe(1);
  });

  it("still counts a package it was told to accept", () => {
    // The counts are the tree-wide summary; an acceptance suppresses the finding, not the
    // fact that the license is in the tree.
    const r = assessLicenses([{ name: "k6", license: "AGPL-3.0" }], {
      blockStrongCopyleft: true,
      accepted: { k6: "CLI in CI only" },
    });
    expect(r.counts["strong-copyleft"]).toBe(1);
    expect(r.findings).toEqual([]);
  });

  it("uses the bare name when a package declares no version", () => {
    const r = assessLicenses([{ name: "mystery" }]);
    expect(r.findings[0]?.package).toBe("mystery");
  });

  it("honours an acceptance carrying a reason", () => {
    const r = assessLicenses([{ name: "k6", license: "AGPL-3.0" }], {
      blockStrongCopyleft: true,
      accepted: { k6: "used only as a CLI in CI, never linked into shipped code" },
    });
    expect(r.ok).toBe(true);
  });

  it("ignores an acceptance with an empty reason", () => {
    // A reason is mandatory for the same purpose as everywhere else in this gate: it
    // forces the exemption to be a decision someone wrote down.
    const r = assessLicenses([{ name: "k6", license: "AGPL-3.0" }], {
      blockStrongCopyleft: true,
      accepted: { k6: "   " },
    });
    expect(r.ok).toBe(false);
  });

  it("flags vendored code even when its license is fine", () => {
    const r = assessLicenses([
      { name: "openzeppelin-contracts", version: "5.6.1", license: "MIT", vendored: true },
    ]);
    expect(r.ok).toBe(true); // not blocking
    expect(r.findings[0]?.detail).toContain("no dependency scanner");
  });
});

/**
 * The real case this was built from.
 *
 * `vendor/openzeppelin-contracts-5.6.1/` in the archive: 226 `.sol` files, every one
 * carrying `SPDX-License-Identifier: MIT`, and **no LICENSE file anywhere in the tree**.
 * Per-file SPDX tags record the license; they do not reproduce the notice MIT requires to
 * be retained.
 */
describe("checkVendoredNotice", () => {
  it("says nothing when the LICENSE file was copied too", () => {
    expect(
      checkVendoredNotice({
        path: "vendor/openzeppelin-contracts-5.6.1",
        hasLicenseFile: true,
        declaredLicense: "MIT",
        fileCount: 226,
      }),
    ).toBeUndefined();
  });

  it("flags the measured OpenZeppelin case precisely", () => {
    const finding = checkVendoredNotice({
      path: "vendor/openzeppelin-contracts-5.6.1",
      hasLicenseFile: false,
      declaredLicense: "MIT",
      fileCount: 226,
    });
    expect(finding?.severity).toBe("review");
    expect(finding?.detail).toContain("226 vendored file(s)");
    // The distinction that makes this accurate rather than alarmist: the license IS
    // declared, per file. What is missing is the notice.
    expect(finding?.detail).toContain("does not reproduce the notice");
  });

  it("is blunter when nothing declares a license at all", () => {
    const finding = checkVendoredNotice({
      path: "vendor/mystery-lib",
      hasLicenseFile: false,
      declaredLicense: undefined,
      fileCount: 12,
    });
    expect(finding?.detail).toContain("nothing in the tree states the terms");
  });

  it("blocks strong copyleft by default", () => {
    expect(DEFAULT_LICENSE_POLICY.blockStrongCopyleft).toBe(true);
  });
});

describe("formatLicenses findings sections", () => {
  /**
   * ══ The branches nobody had rendered ══
   *
   * A coverage audit found the blocking and review sections of this formatter had never
   * executed: the existing tests formatted only clean results. These are exactly what a
   * developer reads when the gate stops them, so an unrendered branch here means the
   * first time anyone sees this output is the first time it has ever run.
   */
  it("renders the blocking section", () => {
    const text = formatLicenses({
      ok: false,
      findings: [{ severity: "blocking", package: "some-agpl-lib@1.0.0", detail: "AGPL-3.0" }],
      counts: { permissive: 0, "weak-copyleft": 0, "strong-copyleft": 1, unknown: 0 },
    });
    expect(text).toContain("blocking (1)");
    expect(text).toContain("✗ some-agpl-lib@1.0.0");
    expect(text).toContain("AGPL-3.0");
  });

  it("renders the review section", () => {
    const text = formatLicenses({
      ok: true,
      findings: [{ severity: "review", package: "odd-lib@2.0.0", detail: "unknown license" }],
      counts: { permissive: 0, "weak-copyleft": 0, "strong-copyleft": 1, unknown: 1 },
    });
    expect(text).toContain("review (1)");
    expect(text).toContain("? odd-lib@2.0.0");
  });

  /** Both at once, each under its own heading and marker. */
  it("separates blocking from review", () => {
    const text = formatLicenses({
      ok: false,
      findings: [
        { severity: "blocking", package: "a@1", detail: "AGPL-3.0" },
        { severity: "review", package: "b@2", detail: "unknown" },
      ],
      counts: { permissive: 0, "weak-copyleft": 0, "strong-copyleft": 1, unknown: 1 },
    });
    expect(text).toContain("blocking (1)");
    expect(text).toContain("review (1)");
    expect(text.indexOf("✗ a@1")).toBeLessThan(text.indexOf("? b@2"));
  });
});
