/**
 * Supply-chain tests, including live npm lookups.
 *
 * The threat is specific to agent-written code: models hallucinate package names at
 * 4.6-6.1%, and attackers register the ones they reliably invent.
 */
import { describe, expect, it } from "vitest";
import { assessAll, assessPackage, DEFAULT_POLICY, formatSupply, npmLookup } from "./supply.js";

const NOW = Date.parse("2026-07-27T00:00:00Z");
const established = {
  name: "viem",
  exists: true,
  firstPublished: "2022-01-01T00:00:00Z",
  weeklyDownloads: 2_000_000,
  versionCount: 900,
};

describe("assessPackage", () => {
  it("trusts an established, widely-used package", () => {
    const v = assessPackage(established, DEFAULT_POLICY, NOW);
    expect(v.level).toBe("trusted");
  });

  /**
   * The hallucination case. Verified separately that pnpm already fails loudly here —
   * this exists so the reason is stated rather than left as a bare install error.
   */
  it("blocks a package the registry does not know", () => {
    const v = assessPackage({ name: "taia-not-real-93481", exists: false }, DEFAULT_POLICY, NOW);
    expect(v.level).toBe("blocked");
    expect(v.reasons[0]).toMatch(/probably invented/);
    expect(v.reasons[0]).toMatch(/registrable by someone else/);
  });

  it("blocks a deprecated package", () => {
    const v = assessPackage({ ...established, deprecated: true }, DEFAULT_POLICY, NOW);
    expect(v.level).toBe("blocked");
  });

  /** THE dangerous case: the name resolves because an attacker registered it. */
  it("flags a package published days ago with no users", () => {
    const v = assessPackage(
      {
        name: "vlem",
        exists: true,
        firstPublished: "2026-07-20T00:00:00Z",
        weeklyDownloads: 3,
        versionCount: 1,
      },
      DEFAULT_POLICY,
      NOW,
    );
    expect(v.level).toBe("review");
    expect(v.reasons.some((r) => /day\(s\) ago/.test(r))).toBe(true);
    expect(v.reasons.some((r) => /go unnoticed/.test(r))).toBe(true);
    expect(v.reasons.some((r) => /one published version/.test(r))).toBe(true);
  });

  it("does not flag a young package that is already widely used", () => {
    const v = assessPackage(
      {
        name: "hot-new-lib",
        exists: true,
        firstPublished: "2026-07-20T00:00:00Z",
        weeklyDownloads: 500_000,
        versionCount: 12,
      },
      DEFAULT_POLICY,
      NOW,
    );
    // Young, but heavily used and iterating — only the age reason should fire.
    expect(v.reasons.filter((r) => r !== "nothing unusual")).toHaveLength(1);
  });

  it("honours an allowlist for our own packages", () => {
    const v = assessPackage(
      { name: "@taia/chains", exists: false },
      { ...DEFAULT_POLICY, allowlist: ["@taia/chains"] },
      NOW,
    );
    expect(v.level).toBe("trusted");
  });

  /**
   * This test previously asserted the OPPOSITE — that an old single-version package is
   * trusted, on the theory that it is a stable little utility. The live npm `k6` disproved
   * it: one version from 2017, no binary, ~198k weekly downloads, and it is not the tool
   * anyone installing it wants. See the `npm k6` block below.
   *
   * The judgement changed deliberately. `review` is not a block — it asks a human to look
   * once, which is a fair price for the class of package that is most often a trap.
   */
  it("asks for review on a single-version package however old it is", () => {
    const v = assessPackage(
      {
        name: "stable-tiny-util",
        exists: true,
        firstPublished: "2019-01-01T00:00:00Z",
        weeklyDownloads: 50_000,
        versionCount: 1,
      },
      DEFAULT_POLICY,
      NOW,
    );
    expect(v.level).toBe("review");
    expect(v.reasons.join(" ")).toContain("only one published version");
  });

  /**
   * A registry entry with no publish date — a real case, not a type-level nicety: private
   * registries and mirrors routinely omit `time`, and `dist-tags.latest` can point at a
   * version `time` never recorded.
   *
   * The rule is that a *missing* date must not be read as a *recent* one, and equally must
   * not be read as an old one. `daysSince` returns undefined and the age reason simply does
   * not fire — the other signals still do. Getting this wrong in either direction is bad:
   * treating `undefined` as 0 days would flag every package on a mirror as brand new
   * (noise, and the check gets disabled), while a numeric fallback of a large value would
   * silently clear a genuinely fresh squat.
   */
  it("does not invent an age when the registry reports no publish date", () => {
    const v = assessPackage(
      { name: "mirrored-lib", exists: true, weeklyDownloads: 4, versionCount: 40 },
      DEFAULT_POLICY,
      NOW,
    );
    expect(v.level).toBe("review");
    expect(
      v.reasons.some((r) => /day\(s\) ago/.test(r)),
      "no date means no age claim",
    ).toBe(false);
    expect(v.reasons.some((r) => /go unnoticed/.test(r))).toBe(true);
  });

  it("treats an unparseable publish date as no date rather than as day zero", () => {
    // `Date.parse("not-a-date")` is NaN, and `(now - NaN) / DAY_MS` is NaN. `NaN <
    // minAgeDays` is false, so a naive version would quietly skip the age check anyway —
    // but `Math.floor(NaN)` in the reason string would have printed "NaN day(s) ago" if the
    // comparison ever flipped. The explicit NaN guard makes the omission deliberate.
    const v = assessPackage(
      { name: "odd-lib", exists: true, firstPublished: "sometime last year", versionCount: 40 },
      DEFAULT_POLICY,
      NOW,
    );
    expect(v.level).toBe("trusted");
    expect(v.reasons.join(" ")).not.toContain("NaN");
  });

  it("omits the publish date from the single-version reason when there is none", () => {
    // The "(published …)" clause is conditional; emitting it empty would render
    // "one published version (published undefined)" in the report a human reads.
    const v = assessPackage(
      { name: "no-date-single", exists: true, versionCount: 1, weeklyDownloads: 50_000 },
      DEFAULT_POLICY,
      NOW,
    );
    expect(v.level).toBe("review");
    const reason = v.reasons.join(" ");
    expect(reason).toContain("only one published version —");
    expect(reason).not.toContain("published undefined");
  });

  it("dates the single-version reason when the registry does supply one", () => {
    const v = assessPackage(
      { name: "k6", exists: true, versionCount: 1, firstPublished: "2017-06-13T14:49:57.984Z" },
      DEFAULT_POLICY,
      NOW,
    );
    expect(v.reasons.join(" ")).toContain("(published 2017-06-13)");
  });

  it("allowlisting is the escape hatch for a known-good single-version package", () => {
    // The cost of the stricter rule must be payable in one line, or it gets reverted.
    const v = assessPackage(
      { name: "stable-tiny-util", exists: true, versionCount: 1, weeklyDownloads: 50_000 },
      { ...DEFAULT_POLICY, allowlist: ["stable-tiny-util"] },
      NOW,
    );
    expect(v.level).toBe("trusted");
  });
});

describe("assessAll", () => {
  /** Only `blocked` fails. A gate that blocks every young package gets disabled. */
  it("fails on blocked but merely reports review", () => {
    const result = assessAll(
      [
        established,
        { name: "ghost", exists: false },
        { name: "fresh", exists: true, firstPublished: "2026-07-26T00:00:00Z", weeklyDownloads: 1 },
      ],
      DEFAULT_POLICY,
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.blocked).toHaveLength(1);
    expect(result.review).toHaveLength(1);
    expect(result.trusted).toBe(1);
  });

  it("passes cleanly when everything is established", () => {
    const result = assessAll([established], DEFAULT_POLICY, NOW);
    expect(result.ok).toBe(true);
    expect(formatSupply(result)).toMatch(/all 1 dependencies look established/);
  });
});

describe("live registry", () => {
  it("resolves a real package with real dates and versions", async () => {
    const facts = await npmLookup("viem");
    expect(facts.exists).toBe(true);
    expect(facts.versionCount ?? 0).toBeGreaterThan(100);
    expect(Date.parse(facts.firstPublished ?? "")).toBeLessThan(NOW);
    expect(assessPackage(facts, DEFAULT_POLICY).level).toBe("trusted");
  });

  /** The hallucination case, against the real registry. */
  it("reports a nonexistent package as blocked", async () => {
    const facts = await npmLookup("taia-definitely-not-a-real-package-93481");
    expect(facts.exists).toBe(false);
    expect(assessPackage(facts, DEFAULT_POLICY).level).toBe("blocked");
  });

  it("surfaces a registry error rather than treating it as absence", async () => {
    const failing: typeof fetch = async () => new Response("boom", { status: 500 });
    await expect(npmLookup("anything", failing)).rejects.toThrow(/returned 500/);
  });

  it("reports a 404 as a package that does not exist", async () => {
    // Distinct from the 500 above: 404 is an answer, not a failure. Throwing here would
    // turn "this package was invented" into "the registry is down", and the caller would
    // lose the one finding that must block.
    const missing: typeof fetch = async () => new Response("", { status: 404 });
    await expect(npmLookup("taia-invented", missing)).resolves.toEqual({
      name: "taia-invented",
      exists: false,
    });
  });

  /**
   * A registry document missing `time`, `versions` and `dist-tags`.
   *
   * Private registries, Verdaccio proxies and partially-replicated mirrors all serve
   * documents like this, and the live-npm tests above can never produce one. Every field
   * has to degrade to `undefined` rather than throw: a `TypeError` reading
   * `body.time.created` would abort the whole supply-chain stage, and an aborted stage is
   * indistinguishable from a stage that found nothing — the failure mode this gate exists
   * to eliminate.
   */
  it("survives a registry document with no time, versions or dist-tags", async () => {
    const sparse: typeof fetch = async () =>
      new Response(JSON.stringify({ name: "sparse-lib" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const facts = await npmLookup("sparse-lib", sparse);
    expect(facts).toEqual({
      name: "sparse-lib",
      exists: true,
      firstPublished: undefined,
      versionPublished: undefined,
      versionCount: 0,
      deprecated: false,
    });
    // Zero versions is <= 1, so the placeholder rule still fires on the degraded document
    // rather than the package sliding through as trusted.
    expect(assessPackage(facts, DEFAULT_POLICY, NOW).level).toBe("review");
  });

  it("resolves the publish date of the version dist-tags actually points at", async () => {
    // `time` holds every version plus `created`/`modified`. Reading `created` as the
    // installed version's date would date a 2016 package's newest release to 2016.
    const doc: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          time: {
            created: "2016-01-01T00:00:00.000Z",
            "1.0.0": "2016-01-01T00:00:00.000Z",
            "2.3.0": "2026-05-05T00:00:00.000Z",
          },
          versions: { "1.0.0": {}, "2.3.0": {} },
          "dist-tags": { latest: "2.3.0" },
          deprecated: "use something else",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const facts = await npmLookup("two-version-lib", doc);
    expect(facts.firstPublished).toBe("2016-01-01T00:00:00.000Z");
    expect(facts.versionPublished).toBe("2026-05-05T00:00:00.000Z");
    expect(facts.versionCount).toBe(2);
    expect(facts.deprecated, "a deprecation message means deprecated").toBe(true);
    expect(assessPackage(facts, DEFAULT_POLICY, NOW).level).toBe("blocked");
  });

  it("leaves the version date unknown when nothing is tagged latest", async () => {
    const doc: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          time: { created: "2020-01-01T00:00:00.000Z" },
          versions: { "1.0.0": {} },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const facts = await npmLookup("untagged", doc);
    expect(facts.versionPublished).toBeUndefined();
    expect(facts.firstPublished).toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("formatSupply", () => {
  it("separates must-not-install from please-look", () => {
    const out = formatSupply(
      assessAll(
        [
          { name: "ghost", exists: false },
          {
            name: "fresh",
            exists: true,
            firstPublished: "2026-07-26T00:00:00Z",
            weeklyDownloads: 1,
          },
        ],
        DEFAULT_POLICY,
        NOW,
      ),
    );
    expect(out).toMatch(/BLOCKED/);
    expect(out).toMatch(/REVIEW/);
  });

  /**
   * Each section on its own, which only the both-present case had ever exercised.
   *
   * The headings carry the whole action: "must not be installed" versus "a human should
   * look at". A run with only review items must not print a BLOCKED heading over them —
   * that reads as a hard stop and gets the check tuned down — and a run with only blocked
   * items must not print an empty REVIEW heading.
   */
  it("prints only the review section when nothing is blocked", () => {
    const out = formatSupply(
      assessAll(
        [{ name: "fresh", exists: true, firstPublished: "2026-07-26T00:00:00Z" }],
        DEFAULT_POLICY,
        NOW,
      ),
    );
    expect(out).toContain("REVIEW — 1 dependency(ies) a human should look at:");
    expect(out).toContain("? fresh");
    expect(out).not.toContain("BLOCKED");
  });

  it("prints only the blocked section when nothing needs review", () => {
    const out = formatSupply(assessAll([{ name: "ghost", exists: false }], DEFAULT_POLICY, NOW));
    expect(out).toContain("BLOCKED — 1 dependency(ies) must not be installed:");
    expect(out).toContain("✗ ghost");
    expect(out).toContain("probably invented");
    expect(out).not.toContain("REVIEW");
  });

  /**
   * The summary line is only correct when nothing needs review — a result that is `ok` but
   * carries review items must NOT read as "all N dependencies look established", because
   * that sentence is what a person skims and believes.
   */
  it("does not call a tree established while a package is awaiting review", () => {
    const out = formatSupply(
      assessAll(
        [established, { name: "fresh", exists: true, firstPublished: "2026-07-26T00:00:00Z" }],
        DEFAULT_POLICY,
        NOW,
      ),
    );
    expect(out).not.toContain("look established");
    expect(out).toContain("REVIEW");
  });
});

/**
 * The real npm `k6`, from the live registry on 2026-07-28.
 *
 * This is the case that proved the age qualifier was wrong. It is a dummy package
 * published ONCE in 2017 — its own description is "Dummy package for autocompleting k6
 * scripts" — with no `bin` and no dependencies. The real k6 is a Go binary that cannot be
 * installed from npm at all, yet this gets ~198,000 downloads a week.
 *
 * Before the fix `assessPackage` returned `level: "trusted", reasons: ["nothing unusual"]`
 * because the one-version rule only applied to packages under a year old. An agent told to
 * "add load testing" installs this, gets no binary, and may report success.
 */
describe("npm k6 — the package that is not the tool", () => {
  const K6 = {
    name: "k6",
    exists: true,
    firstPublished: "2017-06-13T14:49:57.984Z",
    versionPublished: "2017-06-13T14:49:57.984Z",
    versionCount: 1,
    weeklyDownloads: 198_111,
    deprecated: false,
  };

  it("is flagged for review despite being old and heavily downloaded", () => {
    const verdict = assessPackage(K6);
    expect(verdict.level, "a 2017 one-version dummy must not be trusted").toBe("review");
    expect(verdict.reasons.join(" ")).toContain("only one published version");
  });

  it("does not let download volume launder a placeholder", () => {
    // 198k weekly downloads clears every popularity floor. Popularity is evidence of
    // people being confused, not of the package being what they wanted.
    const verdict = assessPackage({ ...K6, weeklyDownloads: 5_000_000 });
    expect(verdict.level).toBe("review");
  });

  it("still trusts an established package with a real release history", () => {
    // The control: without this, the rule above could 'pass' by flagging everything.
    const verdict = assessPackage({
      name: "autocannon",
      exists: true,
      firstPublished: "2016-01-01T00:00:00.000Z",
      versionPublished: "2024-10-14T00:00:00.000Z",
      versionCount: 120,
      weeklyDownloads: 760_000,
      deprecated: false,
    });
    expect(verdict.level).toBe("trusted");
  });
});
