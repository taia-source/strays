/**
 * Invented data shipped as real.
 *
 * ══ Measured ══
 *
 * A deployed page displayed a holder table:
 *
 *     0x1111111111111111111111111111111111111111    0.00017298
 *     0x2222222222222222222222222222222222222222    0.00010708
 *     0x3333333333333333333333333333333333333333    0.00007825
 *     0x4444444444444444444444444444444444444444    0.00003706
 *
 * None of those addresses exists. The amounts were invented. The page passed every test,
 * every browser check and a live deploy, because the FUNCTION computing the split was correct
 * and well tested — it was fed a constant array, and a constant array cannot fail a test.
 *
 * ══ Why this is worth a check of its own ══
 *
 * This is the most dangerous single defect an agent produces, because it is indistinguishable
 * from success at every level except a human recognising the numbers. A blank table reads as
 * broken. A table of plausible fake rows reads as working.
 *
 * ══ What is NOT flagged ══
 *
 * Test files and fixtures, obviously — a fixture is supposed to be invented. The zero address
 * and the burn address are real, meaningful values. And a single repeated-nibble address in a
 * comment explaining a format is documentation. So detection requires an address pattern in
 * shipped source, and reports the file so a human decides.
 */

/** A finding: data that looks invented, in code that ships. */
export type PlaceholderFinding = {
  readonly file: string;
  readonly line: number;
  readonly kind:
    | "repeated-nibble-address"
    | "sequential-address"
    | "lorem"
    | "example-domain"
    | "todo-marker";
  /** The offending text, trimmed. */
  readonly text: string;
  readonly detail: string;
};

/**
 * Addresses that are real and meaningful, and must never be flagged.
 *
 * The zero address means "none" throughout Ethereum, and `0x…dEaD` is the conventional burn
 * target. Both are repeated-nibble patterns, and flagging them would fire on correct code —
 * the fastest way to get a checker disabled.
 */
const MEANINGFUL_ADDRESSES: readonly string[] = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  "0x00000000000000000000000000000000000000ff",
  // Uniswap V3's canonical sentinel, and other well-known non-fake constants can be added
  // here as they are MEASURED to appear, never speculatively.
];

/**
 * An address whose 40 hex characters are one nibble repeated.
 *
 * `0x1111…1111`, `0xaaaa…aaaa`. Nobody generates these; they are typed by hand when someone
 * needs an address-shaped thing and has no real one.
 */
function isRepeatedNibble(address: string): boolean {
  const body = address.slice(2).toLowerCase();
  if (body.length !== 40) return false;
  const first = body[0];
  if (first === undefined) return false;
  return [...body].every((character) => character === first);
}

/**
 * An address that counts: `0x1234…`, `0xabcd…`, or long ascending runs.
 *
 * Weaker than the repeated-nibble signal and deliberately narrow — a real address can begin
 * `0x1234` by chance, so this requires a run long enough that chance is not the explanation.
 */
function isSequential(address: string): boolean {
  const body = address.slice(2).toLowerCase();
  let run = 1;
  let longest = 1;
  for (let index = 1; index < body.length; index++) {
    const previous = Number.parseInt(body[index - 1] ?? "", 16);
    const current = Number.parseInt(body[index] ?? "", 16);
    if (Number.isNaN(previous) || Number.isNaN(current)) return false;
    run = current === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  // 8 ascending hex digits has probability ~16^-7 by chance. A real address will not.
  return longest >= 8;
}

const ADDRESS_PATTERN = /0x[0-9a-fA-F]{40}/g;

/**
 * Scan one file's source for invented data.
 *
 * Line numbers are 1-based so a report is clickable.
 */
export function findPlaceholders(input: {
  readonly file: string;
  readonly source: string;
}): readonly PlaceholderFinding[] {
  const findings: PlaceholderFinding[] = [];
  const lines = input.source.split("\n");

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    for (const match of line.matchAll(ADDRESS_PATTERN)) {
      const address = match[0];
      if (MEANINGFUL_ADDRESSES.includes(address.toLowerCase())) continue;

      if (isRepeatedNibble(address)) {
        findings.push({
          file: input.file,
          line: lineNumber,
          kind: "repeated-nibble-address",
          text: address,
          detail:
            `${address} is one nibble repeated 40 times — nobody generates that. A deployed ` +
            "page displayed four such addresses with invented balances and passed every test, " +
            "because the function computing them was correct and the data was a constant",
        });
        continue;
      }

      if (isSequential(address)) {
        findings.push({
          file: input.file,
          line: lineNumber,
          kind: "sequential-address",
          text: address,
          detail: `${address} counts upward through hex, which a real address does not`,
        });
      }
    }

    if (/\blorem ipsum\b/i.test(line)) {
      findings.push({
        file: input.file,
        line: lineNumber,
        kind: "lorem",
        text: line.trim().slice(0, 80),
        detail: "placeholder prose shipped as copy",
      });
    }

    // `example.com` is reserved by RFC 2606 precisely so it can never be a real service.
    if (/\bexample\.(com|org|net)\b/i.test(line)) {
      findings.push({
        file: input.file,
        line: lineNumber,
        kind: "example-domain",
        text: line.trim().slice(0, 80),
        detail: "example.com is reserved by RFC 2606 and can never resolve to a real service",
      });
    }

    /** A single-token marker. Line-scoped because these never wrap. */
    if (/\b(TODO|FIXME|XXX|HACK)\b/.test(line)) {
      findings.push({
        file: input.file,
        line: lineNumber,
        kind: "todo-marker",
        text: line.trim().slice(0, 100),
        detail: "a marker admitting unfinished work in shipped source",
      });
    }
  }

  findings.push(...findAdmissions(input));
  return findings;
}

/**
 * Prose admitting the code does not work.
 *
 * ══ Why this cannot be line-scoped ══
 *
 * The measured case, from a deployed worker:
 *
 *     // The decision layer is complete and tested, but the chain I/O that would feed it is NOT
 *     // wired up: reading enrolments, claimable fees, holder balances...
 *
 * "NOT" ends one line and "wired up" begins the next, across a comment marker. A line-by-line
 * scan sees neither half and reports the file clean — which is what happened: the first
 * version of this checker missed the exact comment it was written for.
 *
 * So the source is normalised — comment markers and newlines collapsed to spaces — and matched
 * as continuous prose. The admission was HONEST and the service still did nothing; honesty in
 * a comment is not functionality.
 */
export function findAdmissions(input: {
  readonly file: string;
  readonly source: string;
}): readonly PlaceholderFinding[] {
  // Strip comment leaders and collapse whitespace so a wrapped sentence reads as one.
  const prose = input.source.replace(/^\s*(\/\/|\*|\/\*)/gm, " ").replace(/\s+/g, " ");

  const admissions: readonly RegExp[] = [
    /\bnot (?:yet )?(?:wired|implemented|hooked|connected|functional|working|done)\b/i,
    /\bis (?:a )?no-?op\b/i,
    /\bdoes nothing\b/i,
    /\bplaceholder (?:for|until|implementation)\b/i,
    /\bfake (?:data|response|implementation)\b/i,
    /\bmock(?:ed)? (?:data|response)\b/i,
    /\bhard-?coded (?:for now|until|placeholder)\b/i,
    /\bwill be (?:implemented|wired|replaced)\b/i,
  ];

  const findings: PlaceholderFinding[] = [];
  for (const pattern of admissions) {
    const match = pattern.exec(prose);
    if (match === null) continue;

    /**
     * Reported at line 1 rather than at a guessed location.
     *
     * The match is against normalised prose, so its index does not map back to a line. Naming
     * a wrong line is worse than naming none — someone reads that line, sees nothing, and
     * distrusts the checker. The quoted phrase is what makes it findable.
     */
    findings.push({
      file: input.file,
      line: 1,
      kind: "todo-marker",
      text: match[0],
      detail:
        `the source admits "${match[0]}". This was measured: a deployed worker documented as ` +
        '"NOT wired up" across a line break, which a line-by-line scan could not see. The ' +
        "comment was accurate and the service still did nothing",
    });
    // One finding per file for this class: the same admission is often restated, and eight
    // findings for one unfinished module reads as eight problems.
    break;
  }

  return findings;
}

/**
 * Whether a path is exempt.
 *
 * A fixture is supposed to be invented, so tests, fixtures and specs are exempt — but the
 * exemption is by PATH and narrow. A file named `mock-data.ts` under `src/` is not a test; it
 * is invented data with a candid name, which is exactly what shipped.
 */
export function isExemptPath(path: string): boolean {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(path) ||
    /\.spec\.[cm]?[jt]sx?$/.test(path) ||
    /\.live-spec\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)__(fixtures|mocks|tests)__?(\/|$)/.test(path) ||
    /(^|\/)(test|tests|e2e)(\/|$)/.test(path)
  );
}

/** Verdict over a whole tree. */
export type PlaceholderVerdict = {
  readonly ok: boolean;
  readonly findings: readonly PlaceholderFinding[];
  /** Files actually scanned, so a pass over zero files cannot read as a pass. */
  readonly filesScanned: number;
};

/**
 * Judge a whole tree.
 *
 * Reports `filesScanned` because a checker handed an empty list returns no findings, and "no
 * findings over nothing" must not be reportable as clean — the same reason `assessLayout`
 * names its viewports.
 */
export function assessPlaceholders(
  files: readonly { readonly path: string; readonly source: string }[],
): PlaceholderVerdict {
  const scanned = files.filter((file) => !isExemptPath(file.path));
  const findings = scanned.flatMap((file) =>
    findPlaceholders({ file: file.path, source: file.source }),
  );

  return { ok: findings.length === 0, findings, filesScanned: scanned.length };
}

/** A report someone will actually read. */
export function formatPlaceholders(verdict: PlaceholderVerdict): string {
  if (verdict.filesScanned === 0) {
    return "NO FILES SCANNED for placeholder data — this is not a pass";
  }

  if (verdict.ok) {
    return `no invented data in ${verdict.filesScanned} shipped file(s)`;
  }

  const lines = [
    `INVENTED DATA in ${verdict.findings.length} place(s) across ${verdict.filesScanned} shipped file(s):`,
  ];
  for (const finding of verdict.findings) {
    lines.push(`  ${finding.file}:${finding.line} [${finding.kind}] ${finding.text}`);
    lines.push(`    ${finding.detail}`);
  }
  return lines.join("\n");
}
