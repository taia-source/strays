/**
 * A private Anvil per test file.
 *
 * ══ Why this exists ══
 *
 * `anvil_reorg` rewrites history. Measured: it kept the height at `0x5` while replacing
 * block 5's hash. Any suite sharing one node therefore has its blocks silently rewritten
 * underneath it by whichever test reorgs first — which is exactly what happened when
 * `reorg.live.test.ts` was first attempted: it was 1-in-6 flaky on its own and broke
 * `@taia/e2e` when run alongside it.
 *
 * A flaky test is worse than no test, so that file was parked rather than shipped. This is
 * the fixture that makes it shippable.
 *
 * ══ Why spawn rather than containerise ══
 *
 * Measured on this machine:
 *
 *   native spawn, `--port 0`   ~40ms to first successful eth_blockNumber
 *   Testcontainers             ~2867ms first (Ryuk startup), ~173ms steady-state
 *
 * and **no Testcontainers module for Foundry or Anvil exists** — `@testcontainers/foundry`,
 * `/anvil`, `/ethereum` and `/hardhat` all 404. Containerising would mean writing that
 * module for a 4x steady-state cost and a cleanup story (Ryuk) that still cannot guarantee
 * removal if the daemon dies.
 *
 * ══ The two traps, both measured ══
 *
 * **`--port 0` and `--silent` are mutually exclusive.** `--port 0` makes the OS assign a
 * free port and Anvil announces it on stdout; `--silent` suppresses that line, leaving the
 * port undiscoverable. `--config-out` carries no port field either. So the port is parsed
 * from stdout, and `--silent` must never be added.
 *
 * **Orphans survive a SIGKILLed parent.** Verified: killing the parent left Anvil serving
 * RPC. Node cannot trap SIGKILL, so no signal handler fixes this — the guard is that the
 * port is OS-assigned and unique per process, so a leaked instance cannot collide with a
 * later run even if it outlives one.
 *
 * ══ Why not key on VITEST_POOL_ID ══
 *
 * The common ecosystem trick derives a port from `VITEST_POOL_ID`. That is a **worker slot
 * index (1..maxWorkers), not a per-file id** — workers are reused across files, so two
 * files running sequentially both get slot 1 and collide. viem's own suite works around it
 * with random jitter, which is a tell. `--port 0` removes the problem rather than
 * randomising around it.
 */

import { type ChildProcess, spawn } from "node:child_process";

/**
 * Every instance this process started, so none is left running when the process ends.
 *
 * Learned the hard way in this session: a run that spawned instances and exited without
 * stopping them left Anvil processes serving RPC afterwards. They cannot collide (the port
 * is OS-assigned) but they hold memory and confuse anyone reading `pgrep`.
 *
 * `exit` covers the normal path; `SIGINT`/`SIGTERM` cover Ctrl-C and a killed runner.
 * SIGKILL is deliberately absent because Node cannot trap it — that case is why the
 * OS-assigned port matters rather than a fixed one.
 */
const live = new Set<ChildProcess>();
let cleanupInstalled = false;

function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const killAll = () => {
    for (const child of live) child.kill("SIGKILL");
    live.clear();
  };
  process.once("exit", killAll);
  process.once("SIGINT", killAll);
  process.once("SIGTERM", killAll);
}

export type AnvilInstance = {
  /** `http://127.0.0.1:<port>` for this instance only. */
  readonly rpcUrl: string;
  readonly port: number;
  /** Terminate it. Safe to call twice. */
  stop(): Promise<void>;
};

export type AnvilOptions = {
  /** Extra CLI args. `--port 0` is always applied and cannot be overridden. */
  readonly args?: readonly string[];
  /** How long to wait for the port announcement. Default 20s. */
  readonly timeoutMs?: number;
  /** Binary to run. Default resolves from PATH via the standard Foundry location. */
  readonly bin?: string;
};

/**
 * Foundry installs to ~/.foundry/bin, which is not always on PATH for a test runner
 * spawned from an editor or a hook. Falling back to the standard location means a test
 * does not silently skip just because the shell environment differs.
 */
const DEFAULT_BIN = process.env.ANVIL_BIN ?? `${process.env.HOME ?? "/root"}/.foundry/bin/anvil`;

/**
 * Start a private Anvil and resolve once it is actually answering.
 *
 * Resolves on the port announcement rather than a fixed sleep: a sleep is either slower
 * than needed or occasionally too short, and "occasionally too short" is precisely the
 * flakiness this fixture exists to remove.
 */
export function startAnvil(options: AnvilOptions = {}): Promise<AnvilInstance> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  // --port 0 is not optional: it is what makes instances collision-free.
  const args = ["--port", "0", ...(options.args ?? [])];

  if (args.includes("--silent")) {
    throw new Error(
      "--silent suppresses the port announcement that --port 0 depends on, leaving the instance " +
        "undiscoverable. Measured: --config-out carries no port field either",
    );
  }

  return new Promise<AnvilInstance>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.bin ?? DEFAULT_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(`could not spawn anvil: ${error}`));
      return;
    }

    installCleanup();
    live.add(child);

    let settled = false;
    let stdout = "";
    let stderr = "";

    const stop = async (): Promise<void> => {
      live.delete(child);
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      // Give the OS a tick to release the port before a caller starts another instance.
      await new Promise((r) => setTimeout(r, 10));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stop();
      reject(
        new Error(
          `anvil did not announce a port within ${timeoutMs}ms.\nstdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString();
      const match = /Listening on 127\.0\.0\.1:(\d+)/.exec(stdout);
      if (!match?.[1]) return;

      settled = true;
      clearTimeout(timer);
      const port = Number.parseInt(match[1], 10);
      resolve({ rpcUrl: `http://127.0.0.1:${port}`, port, stop });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`anvil failed to start: ${error.message}`));
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`anvil exited with code ${code} before announcing a port.\n${stderr}`));
    });
  });
}

/**
 * Whether an Anvil binary is available at all.
 *
 * Returns a reason rather than a bare boolean so a caller can fail with something
 * actionable instead of a silent skip — the failure mode this repo treats as a bug.
 */
export async function anvilAvailable(bin = DEFAULT_BIN): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(`anvil binary not found (tried "${bin}")`));
    child.on("exit", (code) =>
      resolve(code === 0 ? undefined : `"${bin} --version" exited ${code}`),
    );
  });
}
