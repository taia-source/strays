/**
 * Limiter tests.
 *
 * The point of these is to prove the cap is REAL — observed peak concurrency, not just
 * "the code looks like a semaphore". A limiter that silently allows more than its permit
 * count is worse than none, because it reads as protection while providing none.
 */
import { describe, expect, it } from "vitest";
import { costOf, createLimiter, DEFAULT_LIMITS, limitedFetch, Semaphore } from "./limiter.js";

/** Tracks peak simultaneous execution so the cap can be asserted, not assumed. */
function tracker() {
  let active = 0;
  let peak = 0;
  return {
    peak: () => peak,
    task:
      (ms = 1) =>
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, ms));
        active -= 1;
        return active;
      },
  };
}

describe("costOf", () => {
  it("classifies log and trace methods as expensive", () => {
    expect(costOf("eth_getLogs")).toBe("expensive");
    expect(costOf("debug_traceTransaction")).toBe("expensive");
    expect(costOf("trace_filter")).toBe("expensive");
  });

  it("classifies ordinary reads as cheap", () => {
    expect(costOf("eth_blockNumber")).toBe("cheap");
    expect(costOf("eth_call")).toBe("cheap");
    expect(costOf("eth_getBlockByNumber")).toBe("cheap");
  });

  it("treats unknown methods as cheap rather than blocking them", () => {
    expect(costOf("eth_someFutureMethod")).toBe("cheap");
  });
});

describe("Semaphore", () => {
  it("rejects a nonsensical permit count instead of allowing unlimited work", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  /** The core guarantee. 50 tasks, 3 permits, peak must never exceed 3. */
  it("never runs more than its permit count at once", async () => {
    const sem = new Semaphore(3);
    const t = tracker();
    await Promise.all(Array.from({ length: 50 }, () => sem.run(t.task())));
    expect(t.peak()).toBe(3);
  });

  it("serialises completely with a single permit", async () => {
    const sem = new Semaphore(1);
    const t = tracker();
    await Promise.all(Array.from({ length: 10 }, () => sem.run(t.task())));
    expect(t.peak()).toBe(1);
  });

  /** A throwing task must not leak its permit, or the pool drains to zero and deadlocks. */
  it("releases the permit when the task throws", async () => {
    const sem = new Semaphore(2);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        sem.run(async () => {
          if (i % 2 === 0) throw new Error("boom");
          return i;
        }),
      ),
    );
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
    // Pool must be fully restored, not partially drained.
    const t = tracker();
    await Promise.all(Array.from({ length: 4 }, () => sem.run(t.task())));
    expect(t.peak()).toBe(2);
  });

  it("reports in-flight and queued counts", async () => {
    const sem = new Semaphore(1);
    expect(sem.inFlight).toBe(0);
    let release: (() => void) | undefined;
    const held = sem.run(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await Promise.resolve();
    expect(sem.inFlight).toBe(1);
    const queued = sem.run(async () => undefined);
    await Promise.resolve();
    expect(sem.queued).toBe(1);
    release?.();
    await Promise.all([held, queued]);
    expect(sem.inFlight).toBe(0);
  });

  /**
   * A double-release would inflate the permit count and silently raise real concurrency
   * above the cap — the exact bug that makes a limiter look like it works.
   */
  it("ignores a double release", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    const t = tracker();
    await Promise.all(Array.from({ length: 5 }, () => sem.run(t.task())));
    expect(t.peak()).toBe(1);
  });
});

describe("createLimiter", () => {
  /**
   * The measured reason two budgets exist: on 4663, 100 concurrent cheap calls returned
   * zero 429s while 40 concurrent getLogs produced 23. One shared cap is wrong in both
   * directions.
   */
  it("keeps expensive and cheap budgets independent", async () => {
    const limiter = createLimiter({ expensive: 2, cheap: 8 });
    const exp = tracker();
    const cheap = tracker();

    await Promise.all([
      ...Array.from({ length: 20 }, () => limiter.run("eth_getLogs", exp.task(2))),
      ...Array.from({ length: 20 }, () => limiter.run("eth_blockNumber", cheap.task(2))),
    ]);

    expect(exp.peak()).toBe(2);
    expect(cheap.peak()).toBe(8);
  });

  it("does not let expensive work starve cheap reads", async () => {
    const limiter = createLimiter({ expensive: 1, cheap: 4 });
    const order: string[] = [];

    await Promise.all([
      ...Array.from({ length: 5 }, () =>
        limiter.run("eth_getLogs", async () => {
          await new Promise((r) => setTimeout(r, 5));
          order.push("logs");
        }),
      ),
      ...Array.from({ length: 5 }, () =>
        limiter.run("eth_blockNumber", async () => {
          order.push("cheap");
        }),
      ),
    ]);

    // Cheap reads finish while the single expensive permit is still cycling.
    expect(order.slice(0, 5).every((o) => o === "cheap")).toBe(true);
  });

  it("exposes live stats", () => {
    expect(createLimiter(DEFAULT_LIMITS).stats()).toEqual({ expensive: 0, cheap: 0 });
  });
});

describe("limitedFetch", () => {
  it("caps concurrency of expensive calls made through fetch", async () => {
    const limiter = createLimiter({ expensive: 2, cheap: 10 });
    const t = tracker();
    const fetchFn = limitedFetch(limiter, (async () => {
      await t.task(2)();
      return new Response("{}");
    }) as typeof fetch);

    await Promise.all(
      Array.from({ length: 12 }, () =>
        fetchFn("https://rpc.example", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [] }),
        }),
      ),
    );

    expect(t.peak()).toBe(2);
  });

  /**
   * A batch containing one expensive call costs the server as much as an expensive call,
   * so it must draw from the expensive budget — not slip through as cheap.
   */
  it("charges a mixed batch at its most expensive member", async () => {
    const limiter = createLimiter({ expensive: 1, cheap: 10 });
    const t = tracker();
    const fetchFn = limitedFetch(limiter, (async () => {
      await t.task(2)();
      return new Response("{}");
    }) as typeof fetch);

    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_getLogs", params: [] },
    ]);

    await Promise.all(
      Array.from({ length: 6 }, () =>
        fetchFn("https://rpc.example", { method: "POST", body: batch }),
      ),
    );

    expect(t.peak()).toBe(1);
  });

  it("treats an unparseable body as cheap rather than throwing", async () => {
    const limiter = createLimiter({ expensive: 1, cheap: 4 });
    const fetchFn = limitedFetch(limiter, (async () => new Response("{}")) as typeof fetch);
    const res = await fetchFn("https://rpc.example", { method: "POST", body: "not json" });
    expect(res.ok).toBe(true);
  });
});
