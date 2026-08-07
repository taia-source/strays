/**
 * Load `/root/.env` into `process.env` before any test runs.
 *
 * ══ Why this exists ══
 *
 * The live tests resolve their endpoint through `rpcUrl(id)`, which reads
 * `TAIA_RPC_<chainId>` and otherwise falls back to the chain's **public** RPC. Nothing in
 * the repo ever loaded the env file, so that override could never apply — every "live"
 * test has been hitting the public endpoint regardless of what `.env` contained.
 *
 * The symptom was a live test failing about **1 run in 5** with:
 *
 *   SSL routines:ssl3_read_bytes:ssl/tls alert handshake failure (SSL alert 40)
 *
 * A rate-limited public endpoint dropping TLS handshakes. The fix was believed to be in
 * place already — it was not, because the variable in `.env` was named
 * `ROBINHOOD_RPC_URL` while the code reads `TAIA_RPC_4663`, and nothing bridged the two.
 *
 * ── Deliberately not `dotenv` ──
 *
 * This is ~15 lines against a 30-line dependency, and every dependency in this repo has
 * to justify itself against the supply-chain check in `@taia/gate`. Existing variables are
 * never overwritten, so real CI secrets always win over the local file.
 */

import { existsSync, readFileSync } from "node:fs";

/** Where the operator's credentials live. Overridable for tests of this loader itself. */
export const ENV_PATH = process.env.TAIA_ENV_FILE ?? "/root/.env";

/** Parse `KEY=value` lines, ignoring comments, blanks, and `export ` prefixes. */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    // Strip one layer of matching quotes; leave inner content untouched so a value
    // containing '#' is not truncated as a comment.
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Apply the file to `process.env`.
 *
 * Never overwrites: a variable already set (in CI, or by the caller) is authoritative,
 * and a local file silently replacing a CI secret would be a genuinely nasty bug.
 */
export function applyEnv(
  vars: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (env[key] === undefined || env[key] === "") {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

if (existsSync(ENV_PATH)) {
  applyEnv(parseEnv(readFileSync(ENV_PATH, "utf8")));
}
