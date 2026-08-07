/**
 * Dependency provenance — the supply-chain check for agent-written code.
 *
 * ══ Why this is specifically an agent problem ══
 *
 * Frontier models hallucinate package names at **4.6–6.1%**, and 127 invented names were
 * produced identically by five different models — 53 of them still registrable months
 * later. That is a targetable surface: an attacker registers the name a model reliably
 * invents, and waits.
 *
 * A human typing `expres` gets an error. An agent confidently importing a plausible name
 * gets whatever an attacker put there.
 *
 * ══ What already protects us, and what does not ══
 *
 * A package that does not exist fails at install — verified: pnpm reports "not in the npm
 * registry". So pure hallucination is already loud.
 *
 * **The dangerous case is a name that DOES resolve because someone registered it.** That
 * installs silently. Nothing in the existing gate looks at it, so this does:
 *
 *   - published in the last N days → nobody has audited it
 *   - almost no downloads → nobody is using it, so nobody would notice
 *   - one recent version and nothing else → the shape of a squat, not a library
 *
 * None of these is proof. Together they are a good enough signal to make a human look,
 * which is the entire job.
 */

export type PackageFacts = {
  readonly name: string;
  // `| undefined` is explicit because `exactOptionalPropertyTypes` distinguishes an
  // ABSENT property from one set to undefined — and a registry that omits a date is a
  // real case, not a type-level nicety.
  /** ISO date of the first publish. */
  readonly firstPublished?: string | undefined;
  /** ISO date of the version being installed. */
  readonly versionPublished?: string | undefined;
  readonly weeklyDownloads?: number | undefined;
  readonly versionCount?: number | undefined;
  readonly deprecated?: boolean | undefined;
  /** Whether the registry knows it at all. */
  readonly exists: boolean;
};

export type TrustLevel = "trusted" | "review" | "blocked";

export type ProvenanceVerdict = {
  readonly name: string;
  readonly level: TrustLevel;
  /** Every reason, so a reviewer sees the whole picture rather than the first trigger. */
  readonly reasons: readonly string[];
};

export type ProvenancePolicy = {
  /** A package younger than this has had no time to be audited. Default 30 days. */
  readonly minAgeDays: number;
  /** Below this, nobody would notice it misbehaving. Default 1000/week. */
  readonly minWeeklyDownloads: number;
  /** Names we vouch for regardless — our own scope, and pinned first-party deps. */
  readonly allowlist: readonly string[];
};

export const DEFAULT_POLICY: ProvenancePolicy = {
  minAgeDays: 30,
  minWeeklyDownloads: 1_000,
  allowlist: [],
};

const DAY_MS = 86_400_000;

function daysSince(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : (now - t) / DAY_MS;
}

/**
 * Judge one dependency.
 *
 * `blocked` is reserved for things that cannot be right — a package the registry does not
 * know, or one the maintainer has deprecated. Everything else is `review`: this check
 * asks a human to look, it does not pretend to decide.
 */
export function assessPackage(
  facts: PackageFacts,
  policy: ProvenancePolicy = DEFAULT_POLICY,
  now: number = Date.now(),
): ProvenanceVerdict {
  const reasons: string[] = [];

  if (policy.allowlist.includes(facts.name)) {
    return { name: facts.name, level: "trusted", reasons: ["explicitly allowlisted"] };
  }

  if (!facts.exists) {
    return {
      name: facts.name,
      level: "blocked",
      reasons: [
        "the registry does not know this package — it was probably invented, and the name may be registrable by someone else",
      ],
    };
  }

  if (facts.deprecated) {
    return { name: facts.name, level: "blocked", reasons: ["the maintainer has deprecated it"] };
  }

  const age = daysSince(facts.firstPublished, now);
  if (age !== undefined && age < policy.minAgeDays) {
    reasons.push(
      `first published ${Math.floor(age)} day(s) ago — under the ${policy.minAgeDays}-day floor, so nobody has had time to audit it`,
    );
  }

  if (facts.weeklyDownloads !== undefined && facts.weeklyDownloads < policy.minWeeklyDownloads) {
    reasons.push(
      `${facts.weeklyDownloads} weekly downloads — below ${policy.minWeeklyDownloads}, so misbehaviour would go unnoticed`,
    );
  }

  // A real library accretes versions. One version is the shape of a placeholder.
  //
  // This used to be qualified with `age < 365`, on the theory that an old single-version
  // package is a stable little utility. **That was wrong, and npm `k6` is the proof.**
  // Measured against the live registry:
  //
  //   { name: "k6", versionCount: 1, firstPublished: "2017-06-13",
  //     weeklyDownloads: 198111 }        -> assessPackage said: level "trusted"
  //
  // It is a dummy package published once in 2017, described by its own author as
  // "Dummy package for autocompleting k6 scripts", with **no `bin` and no dependencies**.
  // The real k6 is a Go binary that cannot be installed from npm at all. Two hundred
  // thousand downloads a week are people — and agents — installing it believing they got
  // a load-testing tool. An agent told to "add load testing" would install this, find no
  // binary, and may well report success.
  //
  // Age is therefore the wrong axis: an abandoned one-version package with heavy download
  // traffic is MORE dangerous than a new one, because the traffic reads as legitimacy.
  if (facts.versionCount !== undefined && facts.versionCount <= 1) {
    const published = facts.firstPublished
      ? ` (published ${facts.firstPublished.slice(0, 10)})`
      : "";
    reasons.push(
      `only one published version${published} — the shape of a placeholder, not a maintained library. ` +
        "A high download count does not redeem this: npm's `k6` has one version from 2017, no binary, and ~198k weekly downloads from people who wanted the Go tool of the same name",
    );
  }

  return {
    name: facts.name,
    level: reasons.length > 0 ? "review" : "trusted",
    reasons: reasons.length > 0 ? reasons : ["nothing unusual"],
  };
}

export type SupplyResult = {
  readonly ok: boolean;
  readonly blocked: readonly ProvenanceVerdict[];
  readonly review: readonly ProvenanceVerdict[];
  readonly trusted: number;
};

export function assessAll(
  packages: readonly PackageFacts[],
  policy: ProvenancePolicy = DEFAULT_POLICY,
  now: number = Date.now(),
): SupplyResult {
  const verdicts = packages.map((p) => assessPackage(p, policy, now));
  const blocked = verdicts.filter((v) => v.level === "blocked");
  const review = verdicts.filter((v) => v.level === "review");
  return {
    // Only `blocked` fails the gate. `review` is a prompt for a human, and a check that
    // blocks on every young package would be disabled within a week.
    ok: blocked.length === 0,
    blocked,
    review,
    trusted: verdicts.filter((v) => v.level === "trusted").length,
  };
}

/** Fetch the facts this check needs. Injected so it can be tested without a network. */
export type RegistryLookup = (name: string) => Promise<PackageFacts>;

/** Live npm lookup. Kept tiny and dependency-free — it is one GET per package. */
export async function npmLookup(
  name: string,
  fetchFn: typeof fetch = fetch,
): Promise<PackageFacts> {
  const res = await fetchFn(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (res.status === 404) return { name, exists: false };
  if (!res.ok) throw new Error(`registry returned ${res.status} for ${name}`);

  const body = (await res.json()) as {
    time?: Record<string, string>;
    versions?: Record<string, unknown>;
    "dist-tags"?: { latest?: string };
    deprecated?: string;
  };

  const time = body.time ?? {};
  const latest = body["dist-tags"]?.latest;
  const versions = Object.keys(body.versions ?? {});

  return {
    name,
    exists: true,
    firstPublished: time.created,
    versionPublished: latest ? time[latest] : undefined,
    versionCount: versions.length,
    deprecated: body.deprecated !== undefined,
  };
}

export function formatSupply(result: SupplyResult): string {
  if (result.ok && result.review.length === 0) {
    return `all ${result.trusted} dependencies look established`;
  }

  const lines: string[] = [];
  if (result.blocked.length > 0) {
    lines.push(`BLOCKED — ${result.blocked.length} dependency(ies) must not be installed:`);
    for (const v of result.blocked) {
      lines.push(`  ✗ ${v.name}`);
      for (const r of v.reasons) lines.push(`      ${r}`);
    }
    lines.push("");
  }
  if (result.review.length > 0) {
    lines.push(`REVIEW — ${result.review.length} dependency(ies) a human should look at:`);
    for (const v of result.review) {
      lines.push(`  ? ${v.name}`);
      for (const r of v.reasons) lines.push(`      ${r}`);
    }
  }
  return lines.join("\n");
}
