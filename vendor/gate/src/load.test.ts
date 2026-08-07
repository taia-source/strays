import { createServer, type Server } from "node:http";
import autocannon from "autocannon";
import { describe, expect, it } from "vitest";
import {
  type AutocannonLike,
  assessLoad,
  DEFAULT_THRESHOLDS,
  extractMetrics,
  findSaturation,
  formatLoad,
  type LoadStage,
} from "./load.js";

const base: AutocannonLike = {
  latency: { p50: 10, p90: 40, p97_5: 80, p99: 120 },
  requests: { average: 1000, total: 5000 },
  non2xx: 0,
  errors: 0,
  timeouts: 0,
};

describe("extractMetrics", () => {
  it("interpolates p95 between the p90 and p97_5 autocannon actually reports", () => {
    // autocannon has no p95 key. Reading result.latency.p95 yields undefined, and
    // `undefined < threshold` is false — a threshold that can never fire.
    const m = extractMetrics(base);
    expect(m.p95).toBeGreaterThan(m.p90);
    expect(m.p95).toBeLessThan(80);
  });

  it("is exact when p90 and p97_5 coincide", () => {
    const m = extractMetrics({ ...base, latency: { p50: 5, p90: 30, p97_5: 30, p99: 30 } });
    expect(m.p95).toBe(30);
  });

  it("counts HTTP 500s as failures even though autocannon calls errors zero", () => {
    // The measured trap: errors 0, non2xx 82, on a server failing 2% of requests.
    const m = extractMetrics({
      ...base,
      non2xx: 82,
      errors: 0,
      requests: { average: 1366, total: 4098 },
    });
    expect(m.failedRequests).toBe(82);
    expect(m.errorRate).toBeCloseTo(82 / 4098, 5);
  });

  it("adds socket errors and timeouts to bad statuses", () => {
    const m = extractMetrics({ ...base, non2xx: 10, errors: 5, timeouts: 3 });
    expect(m.failedRequests).toBe(18);
  });

  /**
   * A run that produced nothing at all — the shape autocannon returns when the target
   * refused every connection, or when the URL was wrong.
   *
   * This is the case where the module must be loudest and is most tempted to be silent.
   * Every field falls back, and the one that decides the outcome is `errorRate`: computing
   * `0 / 0` yields `NaN`, and **every comparison against NaN is false**, so
   * `metrics.errorRate > thresholds.maxErrorRate` would not fire and a run that never
   * reached the server would report a clean error rate. The `total > 0` guard is what
   * makes the sample-size finding the only complaint, which is the honest one.
   */
  it("does not turn a zero-request run into NaN metrics", () => {
    const m = extractMetrics({ latency: {}, requests: { average: 0, total: 0 } });
    expect(m).toEqual({
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      requestsPerSecond: 0,
      totalRequests: 0,
      failedRequests: 0,
      errorRate: 0,
    });
    expect(Number.isNaN(m.errorRate), "NaN would silently pass every threshold").toBe(false);

    const result = assessLoad({ latency: {}, requests: { average: 0, total: 0 } });
    expect(result.ok, "a run that measured nothing is not a pass").toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.detail).toContain("the test did not really run");
  });

  /**
   * A histogram missing `p97_5` — the interpolation must degrade to the reported `p90`
   * rather than to zero. Falling back to 0 there would make `p95` *lower* than `p90` and
   * hand the gate a latency budget it could never fail.
   */
  it("falls back to p90 when p97_5 is absent, never to zero", () => {
    const m = extractMetrics({ latency: { p90: 250 }, requests: { average: 100, total: 1000 } });
    expect(m.p95).toBe(250);
    expect(m.p95).toBeGreaterThanOrEqual(m.p90);
  });
});

describe("assessLoad", () => {
  it("passes a healthy run", () => {
    const result = assessLoad(base);
    expect(result.ok).toBe(true);
    expect(formatLoad(result)).toContain("load: passed");
  });

  it("fails on an error rate above the ceiling", () => {
    const result = assessLoad({ ...base, non2xx: 500 });
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.detail).toContain("a 500 is a request that succeeded");
  });

  it("fails on p95 over budget", () => {
    const result = assessLoad({
      ...base,
      latency: { p50: 100, p90: 800, p97_5: 900, p99: 1000 },
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.detail.includes("p95"))).toBe(true);
  });

  it("treats a slow p99 as advisory, never blocking", () => {
    // p99 is noise-dominated at small sample sizes; blocking on it produces false failures.
    const result = assessLoad({ ...base, latency: { p50: 10, p90: 40, p97_5: 80, p99: 9000 } });
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.severity === "advisory")).toBe(true);
  });

  it("refuses to call a too-small run a pass", () => {
    const result = assessLoad({ ...base, requests: { average: 10, total: 12 } });
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.detail).toContain("the test did not really run");
  });

  it("does not gate latency on a run too small to measure it", () => {
    // Below the floor the only complaint should be the sample size, not a percentile
    // derived from a handful of requests.
    const result = assessLoad({
      ...base,
      requests: { average: 10, total: 12 },
      latency: { p50: 900, p90: 3000, p97_5: 4000, p99: 5000 },
    });
    expect(result.findings.filter((f) => f.detail.includes("p95"))).toHaveLength(0);
  });
});

describe("findSaturation", () => {
  it("says plainly when there is not enough data", () => {
    expect(
      findSaturation([{ connections: 10, requestsPerSecond: 100, p95: 5, errorRate: 0 }]).kneeAt,
    ).toBeUndefined();
  });

  it("finds the knee where throughput stops rising", () => {
    const stages: LoadStage[] = [
      { connections: 10, requestsPerSecond: 1000, p95: 10, errorRate: 0 },
      { connections: 20, requestsPerSecond: 1900, p95: 12, errorRate: 0 },
      { connections: 40, requestsPerSecond: 1950, p95: 45, errorRate: 0 },
    ];
    const s = findSaturation(stages);
    expect(s.kneeAt?.connections).toBe(20);
    expect(s.detail).toContain("buys latency rather than work");
  });

  it("says the knee is above the tested range rather than inventing one", () => {
    const stages: LoadStage[] = [
      { connections: 10, requestsPerSecond: 1000, p95: 10, errorRate: 0 },
      { connections: 20, requestsPerSecond: 2000, p95: 11, errorRate: 0 },
    ];
    const s = findSaturation(stages);
    expect(s.kneeAt).toBeUndefined();
    expect(s.detail).toContain("ABOVE the range tested");
  });

  /**
   * A stage that served zero requests per second — the target was down, or the first rung
   * of the ramp never connected.
   *
   * `(cur - prev) / prev` is a division by zero here: it yields `Infinity` for any positive
   * `cur` and, worse, `NaN` when `cur` is also 0. `NaN < 0.1` is **false**, so a ramp whose
   * every stage measured nothing would walk to the end and report "throughput was still
   * climbing" — a confident statement about a service that never answered. The explicit
   * `: 1` treats an unmeasurable step as "still improving" instead, so the run falls
   * through to the honest "the saturation point is above the range tested" verdict.
   */
  it("does not divide by a zero-throughput stage", () => {
    const s = findSaturation([
      { connections: 10, requestsPerSecond: 0, p95: 0, errorRate: 1 },
      { connections: 20, requestsPerSecond: 0, p95: 0, errorRate: 1 },
    ]);
    expect(s.kneeAt, "a knee derived from NaN would be a fabricated measurement").toBeUndefined();
    expect(s.detail).toContain("ABOVE the range tested");
    expect(s.detail).not.toContain("NaN");
    expect(s.detail).not.toContain("Infinity");
  });

  /**
   * ══ The case where the guard actually changes the answer ══
   *
   * The test above documents the guard's purpose correctly and does not prove it: with both
   * stages at 0 rps, guarded yields `1` and unguarded yields `NaN`, and **both are `>= 0.1`**,
   * so control flow is identical and every assertion passes either way. Verified by deleting
   * the guard entirely — all 24 tests stayed green. An adversarial review caught it.
   *
   * Throughput that goes 0 → negative is the discriminator, and it is not a contrived
   * input: a stage's rate is reported by the harness, and a failed or aborted rung can
   * arrive as a negative rate.
   *
   *     guarded:   prev.rps > 0 is false -> gain = 1        -> 1 < 0.1 is false, NO knee
   *     unguarded: (-5 - 0) / 0          -> gain = -Infinity -> knee reported at a stage
   *                                                             that never served a request
   *
   * So without the guard the module invents a saturation point from a division by zero —
   * exactly the fabricated measurement the sibling test claims to prevent.
   */
  it("does not fabricate a knee when throughput goes from zero to negative", () => {
    const s = findSaturation([
      { connections: 10, requestsPerSecond: 0, p95: 0, errorRate: 1 },
      { connections: 20, requestsPerSecond: -5, p95: 0, errorRate: 1 },
    ]);
    expect(
      s.kneeAt,
      "-Infinity < 0.1 would report a knee at a stage that served nothing",
    ).toBeUndefined();
    expect(s.detail).not.toContain("Infinity");
  });

  it("keeps measuring after a zero stage recovers", () => {
    // The 0 -> 900 step is treated as improvement, so the knee is found at the real one.
    const s = findSaturation([
      { connections: 10, requestsPerSecond: 0, p95: 0, errorRate: 0 },
      { connections: 20, requestsPerSecond: 900, p95: 12, errorRate: 0 },
      { connections: 40, requestsPerSecond: 920, p95: 60, errorRate: 0 },
    ]);
    expect(s.kneeAt?.connections).toBe(20);
  });

  it("sorts stages so an out-of-order run still reads correctly", () => {
    const s = findSaturation([
      { connections: 40, requestsPerSecond: 1950, p95: 45, errorRate: 0 },
      { connections: 10, requestsPerSecond: 1000, p95: 10, errorRate: 0 },
      { connections: 20, requestsPerSecond: 1900, p95: 12, errorRate: 0 },
    ]);
    expect(s.kneeAt?.connections).toBe(20);
  });
});

/**
 * Against a real HTTP server driven by real autocannon.
 *
 * This is what makes the constants above trustworthy: the `non2xx`-vs-`errors` distinction
 * and the missing `p95` key are both properties of autocannon's actual output, and both
 * are asserted here rather than taken on faith.
 */
describe("against a real server", () => {
  async function run(handler: Parameters<typeof createServer>[1], seconds = 2) {
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      return await autocannon({
        url: `http://127.0.0.1:${port}`,
        connections: 10,
        duration: seconds,
      });
    } finally {
      server.close();
    }
  }

  it("passes a fast, healthy server", { timeout: 60_000 }, async () => {
    const raw = await run((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const result = assessLoad(raw as unknown as AutocannonLike);
    expect(result.ok, formatLoad(result)).toBe(true);
    expect(result.metrics.totalRequests).toBeGreaterThan(DEFAULT_THRESHOLDS.minRequests);
  });

  it("confirms autocannon reports no p95 key", { timeout: 60_000 }, async () => {
    const raw = await run((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const latency = (raw as unknown as { latency: Record<string, number> }).latency;
    expect(latency.p95, "if autocannon ever adds p95, drop the interpolation").toBeUndefined();
    expect(latency.p90).toBeDefined();
    expect(latency.p97_5).toBeDefined();
  });

  it("catches a server returning 500s that autocannon calls zero errors", {
    timeout: 60_000,
  }, async () => {
    let n = 0;
    const raw = await run((_req, res) => {
      n += 1;
      // Fail 1 in 10 — comfortably over the 1% ceiling.
      if (n % 10 === 0) {
        res.writeHead(500);
        return res.end("boom");
      }
      res.writeHead(200);
      res.end("ok");
    });

    // The trap, asserted directly against the real tool.
    expect((raw as unknown as { errors: number }).errors).toBe(0);
    expect((raw as unknown as { non2xx: number }).non2xx).toBeGreaterThan(0);

    const result = assessLoad(raw as unknown as AutocannonLike);
    expect(result.ok, "a server failing 10% of requests must not pass").toBe(false);
    expect(formatLoad(result)).toContain("failed");
  });
});

describe("formatLoad advisory section", () => {
  const metrics = {
    p50: 10,
    p90: 20,
    p95: 25,
    p99: 40,
    requestsPerSecond: 500,
    totalRequests: 5000,
    failedRequests: 0,
    errorRate: 0,
  };

  /**
   * A coverage audit found the advisory section had never rendered — the existing tests
   * covered clean and blocking results only. `p99` is advisory by design (below a few
   * thousand requests it is noise), so this is the branch that carries that nuance to
   * the reader, and it had never once executed.
   */
  it("renders the advisory section", () => {
    const text = formatLoad({
      ok: true,
      metrics,
      findings: [{ severity: "advisory", detail: "p99 40ms is above the 30ms target" }],
    });
    expect(text).toContain("advisory (1)");
    expect(text).toContain("· p99 40ms");
    expect(text).toContain("load: passed");
  });

  /**
   * Blocking and advisory carry different markers so severity survives a skim.
   *
   * Asserted on the section headings rather than the bullet text: the metrics line
   * already contains `· p90 … · p99`, so searching for a bare `· p99` matches there
   * first and compares the wrong positions entirely. The first version of this test did
   * exactly that and failed — the formatter was right.
   */
  it("separates blocking from advisory", () => {
    const text = formatLoad({
      ok: false,
      metrics,
      findings: [
        { severity: "blocking", detail: "error rate 5% exceeds 1%" },
        { severity: "advisory", detail: "p99 is noisy at this sample size" },
      ],
    });
    expect(text).toContain("LOAD FAILED");
    expect(text).toContain("✗ error rate 5% exceeds 1%");
    expect(text).toContain("· p99 is noisy at this sample size");
    expect(text.indexOf("blocking (1)")).toBeLessThan(text.indexOf("advisory (1)"));
  });

  /**
   * The interpolation caveat is conditional, and only the "shown" side had run.
   *
   * When p90 and p97_5 coincide the interpolated p95 is exact, and printing "p95 is
   * interpolated" would be an unnecessary hedge on a number that is not estimated at all.
   * Printing it unconditionally is the easy mistake, and it teaches readers to discount a
   * figure that is in fact exact — so the omission is asserted, not just the presence.
   */
  it("only warns that p95 is interpolated when it actually is", () => {
    const estimated = formatLoad(assessLoad(base));
    expect(estimated).toContain("p95 is interpolated");

    const exact = formatLoad(
      assessLoad({ ...base, latency: { p50: 5, p90: 30, p97_5: 30, p99: 30 } }),
    );
    expect(exact, "p95 == p90 here, so there is nothing to caveat").not.toContain(
      "p95 is interpolated",
    );
    expect(exact).toContain("p95 ~30ms");
  });
});
