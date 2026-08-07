import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `outputFileTracingRoot` is PINNED to the workspace root.
 *
 * Without it Next infers the root from the lockfile it can find, and in a pnpm workspace that
 * inference decides where `standalone/` nests — locally it produced `standalone/apps/web/server.js`
 * and on Railway it produced something else, so the start command pointed at a path that did not
 * exist and the container crashed with MODULE_NOT_FOUND while the BUILD had reported success.
 *
 * Railway's own rule is that SUCCESS means the build shipped, not that anything serves. This is
 * that distinction with a stack trace.
 */
export default {
  output: "standalone",
  reactStrictMode: true,
  outputFileTracingRoot: join(here, "../.."),
};
