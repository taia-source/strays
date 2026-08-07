#!/usr/bin/env node
/**
 * THE SABOTAGE HARNESS.
 *
 * Coverage is not evidence. A test that executes a line proves the line ran, not that anything
 * would notice if the line were wrong. So for every check the suite claims to enforce, this script
 * BREAKS the code that check guards and requires the suite to go red.
 *
 * If a sabotage passes, the check is decoration — and the rule is to fix the check, not the
 * sabotage.
 *
 * Each entry is a literal find/replace in a source file. The harness applies one, runs the whole
 * suite, records whether it failed (which is the desired outcome), and restores the file.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** @type {Array<{id:string, file:string, what:string, find:string, replace:string}>} */
const SABOTAGES = [
  {
    id: "S1",
    file: "src/eligible.ts",
    what: "Remove the taxPct === 1 hard filter entirely (RULE 1). A 10% token becomes huntable.",
    find: "  if (token.taxPct !== cfg.requiredTaxPct) {",
    replace: "  if (false) {",
  },
  {
    id: "S2",
    file: "src/eligible.ts",
    what: "Loosen the tax filter from === to <=, which admits taxPct 0 (a failed API read).",
    find: "  if (token.taxPct !== cfg.requiredTaxPct) {",
    replace: "  if (token.taxPct > cfg.requiredTaxPct) {",
  },
  {
    id: "S3",
    file: "src/cost.ts",
    what: "Default gasPriceWei instead of refusing it — openhood's exact failure.",
    find: "  if (args.gasPriceWei === undefined || args.gasPriceWei === null || args.gasPriceWei <= 0n) {",
    replace: "  if (false) {",
  },
  {
    id: "S4",
    file: "src/cost.ts",
    what: "Charge the tax on ONE leg only, halving the modelled cost.",
    find: "  const exitTaxWei = (args.positionWei * taxBps) / BPS_DENOMINATOR;",
    replace: "  const exitTaxWei = 0n;",
  },
  {
    /*
     * NOTE: the FIRST version of this sabotage was a no-op and is recorded in SABOTAGE.md as
     * such. It appended `args = {...args, gasPriceWei: args.gasPriceWei > 0n ? args.gasPriceWei
     * : ANVIL}` AFTER the guard — but the guard had already thrown for every non-positive value,
     * so the ternary could only ever take its first branch. The suite was right to stay green;
     * the sabotage tested nothing. This version REPLACES the guard with the fallback, which is
     * what openhood actually did.
     */
    id: "S5",
    file: "src/cost.ts",
    what: "Replace the gas-price guard with a hardcoded anvil fallback — openhood's code, verbatim.",
    find: "  if (args.gasPriceWei === undefined || args.gasPriceWei === null || args.gasPriceWei <= 0n) {",
    replace:
      "  // @ts-expect-error sabotage: default instead of refusing\n  args = { ...args, gasPriceWei: args.gasPriceWei > 0n ? args.gasPriceWei : 1_019_000_000n };\n  if (false) {",
  },
  {
    id: "S6",
    file: "src/bar.ts",
    what: "Drop EDGE_MULTIPLE to 1 — the bar becomes cost, cleared by a third of a typical move.",
    find: "export const EDGE_MULTIPLE = 2n;",
    replace: "export const EDGE_MULTIPLE = 1n;",
  },
  {
    id: "S7",
    file: "src/bar.ts",
    what: "Remove the bar entirely: everything clears.",
    find: "  const clears = args.expectedGainWei > 0n && args.expectedGainWei >= requiredWei;",
    replace: "  const clears = true;",
  },
  {
    id: "S8",
    file: "src/bar.ts",
    what: "Remove the non-positive-gain guard, so 0 >= 0 fires a trade at zero cost.",
    find: "  const clears = args.expectedGainWei > 0n && args.expectedGainWei >= requiredWei;",
    replace: "  const clears = args.expectedGainWei >= requiredWei;",
  },
  {
    id: "S9",
    file: "src/risk.ts",
    what: "DELETE THE STOP LOSS — it never fires. This is meridian's actual state.",
    find: "  const fired = moveBps <= -args.stopLossBps;",
    replace: "  const fired = false;",
  },
  {
    id: "S10",
    file: "src/risk.ts",
    what: "Widen the stop by 10x so it effectively never fires on a real move.",
    find: "  const fired = moveBps <= -args.stopLossBps;",
    replace: "  const fired = moveBps <= -args.stopLossBps * 10n;",
  },
  {
    id: "S11",
    file: "src/risk.ts",
    what: "Remove the drawdown halt — a losing stray keeps hunting to zero.",
    find: "  if (dd >= cfg.maxDrawdownBps) {",
    replace: "  if (false) {",
  },
  {
    id: "S12",
    file: "src/risk.ts",
    what: "Let minOut return zero — a free MEV sandwich (RESEARCH §7c).",
    find: "  if (args.expectedOut <= 0n) {",
    replace: "  if (false) {",
  },
  {
    id: "S13",
    file: "src/risk.ts",
    what: "Accept a non-durable ledger — meridian's 'spend since last boot' (RESEARCH §7f).",
    find: "  if (!ledger.durable) {",
    replace: "  if (false) {",
  },
  {
    id: "S14",
    file: "src/risk.ts",
    what: "Make the memory ledger amnesiac: ignore the seed, so a restart loses all spend history.",
    find: "  const records: SpendRecord[] = [...seed];",
    replace: "  const records: SpendRecord[] = [];",
  },
  {
    id: "S15",
    file: "src/risk.ts",
    what: "Remove the window spend cap.",
    find: "  if (spent + sizeWei > cfg.maxSpendPerWindowWei) {",
    replace: "  if (false) {",
  },
  {
    id: "S16",
    file: "src/risk.ts",
    what: "Remove the count cap, so a retry storm under the value cap passes.",
    find: "  if (count + 1 > cfg.maxEntriesPerWindow) {",
    replace: "  if (false) {",
  },
  {
    id: "S17",
    file: "src/risk.ts",
    what: "MAKE THE EXIT REFUSABLE — mayExit returns false. The invariant the brief names.",
    find: "export function mayExit(): true {\n  return true;\n}",
    replace:
      "export function mayExit(): true {\n  // @ts-expect-error sabotage: an exit must never be refusable\n  return false;\n}",
  },
  {
    id: "S18",
    file: "src/decide.ts",
    what: "GATE THE EXIT BEHIND THE DRAWDOWN HALT — a halted stray can no longer sell.",
    find: "  if (state.position !== undefined) {",
    replace: "  if (state.position !== undefined && drawdownBps(state) < cfg.risk.maxDrawdownBps) {",
  },
  {
    id: "S19",
    file: "src/decide.ts",
    what: "Evaluate ENTRY before EXIT, so risk gates get a chance to run first.",
    find: "    if (stop.fired) {",
    replace: "    if (stop.fired && state.compartmentWei > 0n) {",
  },
  {
    id: "S20",
    file: "src/signal.ts",
    what: "Count the window from the SAMPLE COUNT, not the clock — openhood's 12x units bug.",
    find: "  const elapsedSeconds = last.atSeconds - first.atSeconds;",
    replace: "  const elapsedSeconds = (n - 1) * 3600;",
  },
  {
    id: "S21",
    file: "src/signal.ts",
    what: "Port openhood's 1440-minute lookback and 53bps sigma — the wrong asset class.",
    find: "export const SIGMA_1H_BPS = 157n;",
    replace: "export const SIGMA_1H_BPS = 53n;",
  },
  {
    id: "S22",
    file: "src/signal.ts",
    what: "Remove the long-only guard, so a crash is treated as an entry signal.",
    find: "  const isBreakout = moveBps >= thresholdBps && moveBps > 0n;",
    replace: "  const isBreakout = moveBps >= thresholdBps || moveBps <= -thresholdBps;",
  },
  {
    id: "S23",
    file: "src/signal.ts",
    what: "Remove the take-profit cost floor, so a target that cannot pay for its exit is allowed.",
    find: "  const takeProfitBps = TAKE_PROFIT_BPS > costFloorBps ? TAKE_PROFIT_BPS : costFloorBps;",
    replace: "  const takeProfitBps = TAKE_PROFIT_BPS;",
  },
  {
    id: "S24",
    file: "src/eligible.ts",
    what: "Remove the minimum-liquidity floor.",
    find: "  if (token.marketCapWei < cfg.minMarketCapWei) {",
    replace: "  if (false) {",
  },
  {
    id: "S25",
    file: "src/eligible.ts",
    what: "Remove the minimum-holders floor.",
    find: "  if (!Number.isInteger(token.holders) || token.holders < cfg.minHolders) {",
    replace: "  if (false) {",
  },
  {
    id: "S26",
    file: "src/eligible.ts",
    what: "Remove the age bounds.",
    find: "  if (token.ageSeconds < cfg.minAgeSeconds) {",
    replace: "  if (false) {",
  },
  {
    id: "S27",
    file: "src/eligible.ts",
    what: "Let assertHuntableTax accept any configured tier, so config can overrule arithmetic.",
    find: "  if (cfg.requiredTaxPct !== HUNTABLE_TAX_PCT) {",
    replace: "  if (false) {",
  },
  {
    id: "S28",
    file: "src/decide.ts",
    what: "Skip the eligibility filter in decide, so RULE 1 stops at the module boundary.",
    find: "    if (!eligibility.ok) {",
    replace: "    if (false && !eligibility.ok) {",
  },
  {
    id: "S29",
    file: "src/decide.ts",
    what: "Force a sale when the mark price is unreadable — a failed read becomes a realised loss.",
    find: "    if (market.markPriceWei === undefined || market.markPriceWei <= 0n) {",
    replace: "    if (false) {",
  },
  {
    id: "S30",
    file: "src/cost.ts",
    what: "Reintroduce openhood's 5bps pool fee, which RESEARCH §2 proved is zero here.",
    find: "  const totalWei = entryTaxWei + exitTaxWei + entryGasWei + exitGasWei;",
    replace:
      "  const totalWei =\n    entryTaxWei + exitTaxWei + entryGasWei + exitGasWei + (args.positionWei * 5n) / 10_000n;",
  },

  /*
   * ══ THE "TWO MECHANISMS" CLASS ══
   *
   * S12 escaped because two independent guards rejected the same input, so deleting either one
   * alone was invisible. These sabotages delete exactly ONE half of every such pair in the
   * codebase, to find any others of the same shape.
   */
  {
    id: "S31",
    file: "src/risk.ts",
    what: "S12's PAIR: delete the SECOND minOut guard (the rounded-to-zero one) instead of the first.",
    find: "  if (minOut <= 0n) {",
    replace: "  if (false) {",
  },
  {
    id: "S32",
    file: "src/risk.ts",
    what: "Delete only the 100%-slippage guard; the rounding guard may still cover it.",
    find: "  if (args.slippageBps < 0n || args.slippageBps >= BPS_DENOMINATOR) {",
    replace: "  if (false) {",
  },
  {
    id: "S33",
    file: "src/eligible.ts",
    what: "Delete only the non-integer taxPct guard; the !== comparison may still cover it.",
    find: "  if (!Number.isInteger(token.taxPct)) {",
    replace: "  if (false) {",
  },
  {
    id: "S34",
    file: "src/signal.ts",
    what: "Delete only the zero-elapsed-time guard; the isqrt path may still produce no signal.",
    find: "  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {",
    replace: "  if (false) {",
  },
  {
    id: "S35",
    file: "src/signal.ts",
    what: "Delete only the <2-points guard; the undefined-point guard may still cover it.",
    find: "  if (n < 2) {",
    replace: "  if (false) {",
  },
  {
    id: "S36",
    file: "src/risk.ts",
    what: "Delete only the compartment-affordability clamp; maxPositionWei may still cover it.",
    find: "  const affordable = capped > state.compartmentWei ? state.compartmentWei : capped;",
    replace: "  const affordable = capped;",
  },
  {
    id: "S37",
    file: "src/cost.ts",
    what: "Delete only the positive-position guard; a bps division by zero may throw anyway.",
    find: "  if (args.positionWei <= 0n) {",
    replace: "  if (false) {",
  },
];

const run = () => {
  try {
    execFileSync("./node_modules/.bin/vitest", ["run", "--reporter=dot"], {
      cwd: HERE,
      stdio: "pipe",
      encoding: "utf8",
    });
    return { failed: false, output: "" };
  } catch (e) {
    return { failed: true, output: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
};

const only = process.argv[2];
const results = [];

for (const s of SABOTAGES) {
  if (only && s.id !== only) continue;
  const path = join(HERE, s.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(s.find)) {
    results.push({ ...s, caught: null, note: "PATTERN NOT FOUND — sabotage could not be applied" });
    console.log(`${s.id}  ??  PATTERN NOT FOUND in ${s.file}`);
    continue;
  }
  writeFileSync(path, original.replace(s.find, s.replace));
  let caught = false;
  let failCount = 0;
  try {
    const r = run();
    caught = r.failed;
    const m = /Tests\s+(\d+) failed/.exec(r.output);
    failCount = m ? Number(m[1]) : 0;
  } finally {
    writeFileSync(path, original);
  }
  results.push({ ...s, caught, failCount });
  console.log(
    `${s.id}  ${caught ? "CAUGHT" : "*** PASSED — CHECK IS DECORATION ***"}  ` +
      `${caught ? `(${failCount} tests failed)` : ""}  ${s.what}`,
  );
}

const escaped = results.filter((r) => r.caught === false);
console.log(`\n${results.length - escaped.length}/${results.length} sabotages caught.`);
if (escaped.length > 0) {
  console.log("\nESCAPED:");
  for (const e of escaped) console.log(`  ${e.id}  ${e.file}  ${e.what}`);
  process.exitCode = 1;
}
writeFileSync(join(HERE, "sabotage-results.json"), JSON.stringify(results, null, 2));
