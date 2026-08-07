import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  assessHealth,
  checkLag,
  DEFAULT_LAG_POLICY,
  formatHealth,
  type HealthCheck,
  probeDependency,
  REQUIRED_ENDPOINTS,
} from "./health.js";

describe("probeDependency", () => {
  it("passes a reachable dependency", async () => {
    const c = await probeDependency({ name: "db", check: async () => true, required: true });
    expect(c.status).toBe("pass");
  });

  it("fails a required dependency that is down", async () => {
    const c = await probeDependency({ name: "db", check: async () => false, required: true });
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("cannot serve correct answers");
  });

  it("only warns for an optional dependency", async () => {
    // A cache being down is degradation, not an outage. Failing readiness here would pull
    // a working service out of rotation.
    const c = await probeDependency({ name: "cache", check: async () => false, required: false });
    expect(c.status).toBe("warn");
  });

  it("treats a throwing probe as a failure, never as unknown", async () => {
    // Treating an exception as "inconclusive" is how a broken dependency gets reported
    // healthy. The message is kept so the cause is not lost.
    const c = await probeDependency({
      name: "db",
      check: async () => {
        throw new Error("ECONNREFUSED 5432");
      },
      required: true,
    });
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("ECONNREFUSED 5432");
  });

  /**
   * A throwing *optional* probe: same "never unknown" rule, but it must not pull a working
   * service out of rotation.
   *
   * Both statuses in the catch block come from `probe.required`, and only the required
   * side had been tested — so a version that hard-coded "fail" there would have passed the
   * suite while turning every cache hiccup into a 503. That is the muted-health-check
   * failure this module exists to prevent, arriving through the back door.
   */
  it("only warns when an optional probe throws", async () => {
    const c = await probeDependency({
      name: "cache",
      check: async () => {
        throw new Error("ETIMEDOUT 6379");
      },
      required: false,
    });
    expect(c.status, "a degraded cache is not a readiness failure").toBe("warn");
    expect(c.detail).toContain("ETIMEDOUT 6379");
    expect(assessHealth([c]).ready).toBe(true);
  });

  /**
   * A rejection that is not an Error at all.
   *
   * Real cases: `Promise.reject("timeout")` in a hand-rolled client, and drivers that
   * throw plain objects. `error.message` on those is `undefined`, so a report that read it
   * directly would say "probe threw: undefined" — a failure with its cause erased, which
   * is the one thing a health check must never do.
   */
  it("keeps the cause when a probe rejects with a non-Error", async () => {
    const c = await probeDependency({
      name: "db",
      check: () => Promise.reject("connection pool exhausted"),
      required: true,
    });
    expect(c.status).toBe("fail");
    expect(c.detail).toBe("probe threw: connection pool exhausted");
    expect(c.detail).not.toContain("undefined");
  });
});

describe("checkLag", () => {
  it("passes a current indexer", () => {
    const c = checkLag({ chainHead: 1000n, indexedHead: 998n, blockTimeSeconds: 0.1 });
    expect(c.status).toBe("pass");
  });

  /**
   * The reason lag is judged in time rather than blocks.
   *
   * The identical block count is healthy on a fast chain and a catastrophe on a slow one.
   * A threshold expressed in blocks silently encodes an assumption about one chain.
   */
  it("reads the same block count differently per chain", () => {
    const blocks = { chainHead: 20_000n, indexedHead: 10_000n }; // 10,000 behind

    // 100ms blocks (chain 4663): 1,000s behind — past the fail ceiling.
    expect(checkLag({ ...blocks, blockTimeSeconds: 0.1 }).status).toBe("fail");

    // 1ms per block would be 10s behind — fine.
    expect(checkLag({ ...blocks, blockTimeSeconds: 0.001 }).status).toBe("pass");
  });

  it("warns between the target and the ceiling", () => {
    // 600 blocks * 0.1s = 60s: over the 30s target, under the 300s ceiling.
    const c = checkLag({ chainHead: 1000n, indexedHead: 400n, blockTimeSeconds: 0.1 });
    expect(c.status).toBe("warn");
  });

  it("fails past the ceiling and says answers are out of date", () => {
    const c = checkLag({ chainHead: 100_000n, indexedHead: 50_000n, blockTimeSeconds: 0.1 });
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("quietly out of date");
  });

  it("fails when the indexer is AHEAD of the chain", () => {
    // Not "zero lag" — a mishandled reorg or the wrong chain entirely. Reporting this as
    // healthy would hide a real bug.
    const c = checkLag({ chainHead: 1000n, indexedHead: 1200n, blockTimeSeconds: 0.1 });
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("AHEAD of chain head");
  });

  it("respects a custom policy", () => {
    const c = checkLag(
      { chainHead: 1000n, indexedHead: 900n, blockTimeSeconds: 0.1 },
      { warnSeconds: 5, failSeconds: 8 },
    );
    expect(c.status).toBe("fail");
  });

  it("expresses long lag in minutes rather than a wall of seconds", () => {
    const c = checkLag({ chainHead: 100_000n, indexedHead: 50_000n, blockTimeSeconds: 0.1 });
    expect(c.detail).toContain("minutes");
  });
});

describe("assessHealth", () => {
  const pass: HealthCheck = { name: "a", status: "pass", detail: "" };

  it("is ready when everything passes", () => {
    const r = assessHealth([pass]);
    expect(r.ready).toBe(true);
    expect(r.status).toBe(200);
  });

  it("stays ready when a check only warns", () => {
    // A degraded cache must not pull a working service out of rotation, or the check
    // gets muted and then protects nothing.
    const r = assessHealth([pass, { name: "cache", status: "warn", detail: "" }]);
    expect(r.ready).toBe(true);
    expect(r.status).toBe(200);
  });

  it("returns 503 on any failure", () => {
    const r = assessHealth([pass, { name: "db", status: "fail", detail: "down" }]);
    expect(r.ready).toBe(false);
    expect(r.status).toBe(503);
  });

  it("says remove from rotation, not restart", () => {
    const text = formatHealth(assessHealth([{ name: "db", status: "fail", detail: "down" }]));
    expect(text).toContain("does NOT mean restart");
  });

  /**
   * The ready rendering, which had never run.
   *
   * `formatHealth` was only ever called on a failing report, so the "ready (HTTP 200)"
   * header, the ✓ and ! icons, and the branch that *omits* the remove-from-rotation advice
   * were all untested. The last one is the load-bearing part: printing "remove from
   * rotation" under a healthy report would be actively misleading to whoever is reading it
   * at 3am.
   */
  it("renders a ready report with per-status icons and no rotation advice", () => {
    const text = formatHealth(
      assessHealth([
        { name: "db", status: "pass", detail: "reachable" },
        { name: "cache", status: "warn", detail: "unreachable — degraded" },
      ]),
    );
    expect(text.split("\n")[0]).toBe("ready (HTTP 200)");
    expect(text).toContain("✓ db: reachable");
    expect(text).toContain("! cache: unreachable — degraded");
    expect(text, "a healthy service must not be told to leave rotation").not.toContain(
      "remove from rotation",
    );
  });

  it("marks a failing check with ✗", () => {
    const text = formatHealth(assessHealth([{ name: "db", status: "fail", detail: "down" }]));
    expect(text.split("\n")[0]).toBe("NOT READY (HTTP 503)");
    expect(text).toContain("✗ db: down");
  });

  it("names all three required endpoints with what each is for", () => {
    expect(REQUIRED_ENDPOINTS.map((e) => e.path)).toEqual(["/health", "/ready", "/metrics"]);
    expect(REQUIRED_ENDPOINTS.every((e) => e.onFailure.length > 0)).toBe(true);
  });
});

/**
 * The measurement that motivated the module, run as a test.
 *
 * A shallow `/health` returns 200 while the database is down and the indexer is 50,000
 * blocks behind. A readiness endpoint built from these checks returns 503 on the same
 * state. Asserting both against a real HTTP server keeps the claim honest.
 */
describe("against a real server", () => {
  async function withServer<T>(
    handler: Parameters<typeof createServer>[1],
    fn: (base: string) => Promise<T>,
  ): Promise<T> {
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      server.close();
    }
  }

  it("shows a shallow /health passing while everything is broken", async () => {
    let dbUp = true;
    let indexedHead = 1_000_000n;
    const chainHead = 1_000_000n;

    await withServer(
      (req, res) => {
        if (req.url === "/health") {
          // The endpoint most projects ship: proves only that the process accepted a socket.
          res.writeHead(200);
          return res.end("OK");
        }
        const report = assessHealth([
          { name: "db", status: dbUp ? "pass" : "fail", detail: dbUp ? "up" : "down" },
          checkLag({ chainHead, indexedHead, blockTimeSeconds: 0.1 }),
        ]);
        res.writeHead(report.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ready: report.ready, checks: report.checks }));
      },
      async (base) => {
        const healthyReady = await fetch(`${base}/ready`);
        expect(healthyReady.status).toBe(200);

        // Break it: database down, indexer 50,000 blocks (~83 min) behind.
        dbUp = false;
        indexedHead = chainHead - 50_000n;

        const shallow = await fetch(`${base}/health`);
        expect(shallow.status, "the shallow probe cannot see any of this").toBe(200);

        const ready = await fetch(`${base}/ready`);
        expect(ready.status).toBe(503);

        const body = (await ready.json()) as { ready: boolean; checks: HealthCheck[] };
        expect(body.ready).toBe(false);
        expect(body.checks.filter((c) => c.status === "fail")).toHaveLength(2);
      },
    );
  });

  it("uses the documented default policy for the lag ceiling", () => {
    // Guards the constant the test above depends on: 50,000 blocks at 0.1s is 5,000s,
    // which must exceed failSeconds for that assertion to mean anything.
    expect(50_000 * 0.1).toBeGreaterThan(DEFAULT_LAG_POLICY.failSeconds);
  });
});
