/**
 * Client-side concurrency control — the gap viem leaves.
 *
 * viem retries 429s (verified in its source: it honours `Retry-After` and backs off
 * exponentially). What it does not do is *avoid* them. Reacting to a rate limit after the
 * fact still burns the request, and a burst of parallel work will keep tripping it.
 *
 * ══ Why two budgets, not one ══
 *
 * Measured against the 4663 public RPC on 2026-07-27:
 *
 *   eth_blockNumber (cheap)   100 concurrent → 100 ok, zero 429
 *   eth_getLogs     (costly)    2 concurrent → 534 ms
 *                               5 concurrent → 6.1 s
 *                              20 concurrent → 20 ok  (6.8 s)
 *                              40 concurrent → 17 ok, 23× 429
 *
 * The endpoint limits by COMPUTE COST, not request count: a hundred cheap calls sail
 * through while forty expensive ones get throttled. A single global cap is therefore
 * wrong in both directions — set it for `getLogs` and cheap reads crawl; set it for cheap
 * reads and `getLogs` gets throttled.
 *
 * ponsball learned the same thing the hard way and wrote it down (`DECISIONS` D14, and
 * lesson 3 in its sync engine): routing block-timestamp reads through the getLogs
 * throttle "serialised hundreds of ~16 CU calls and stalled ranges for minutes".
 *
 * So: a semaphore per class of call, chosen by RPC method.
 *
 * ══ Why a semaphore and not a token bucket ══
 *
 * A token bucket caps requests per second. A semaphore caps requests in flight. Against a
 * cost-based limiter the in-flight count is what correlates with load — and it is
 * self-regulating: when the endpoint slows down, in-flight work drains more slowly and
 * the caller naturally backs off. A req/s bucket keeps firing into a struggling endpoint
 * at the same rate.
 */

/** How expensive a method is, which decides which budget it draws from. */
export type Cost = "cheap" | "expensive";

/**
 * Methods that cost real work server-side. Everything else is treated as cheap.
 *
 * `eth_getLogs` is the obvious one. Trace and archive-state methods belong here too:
 * they are the calls providers price highest and rate-limit first.
 */
const EXPENSIVE_METHODS = new Set([
  "eth_getLogs",
  "eth_getFilterLogs",
  "eth_newFilter",
  "debug_traceTransaction",
  "debug_traceBlockByNumber",
  "debug_traceBlockByHash",
  "debug_traceCall",
  "trace_block",
  "trace_transaction",
  "trace_filter",
  "trace_call",
  "trace_callMany",
  "trace_replayTransaction",
  "trace_replayBlockTransactions",
]);

export function costOf(method: string): Cost {
  return EXPENSIVE_METHODS.has(method) ? "expensive" : "cheap";
}

export type LimiterConfig = {
  /**
   * Max in-flight expensive calls.
   *
   * Default 4. The measured cliff on the 4663 public endpoint is between 20 and 40, but
   * this default has to be safe on a chain nobody has measured — and latency already
   * degrades badly (534 ms → 6.1 s) well before the cliff. Raise it for a paid endpoint.
   */
  readonly expensive: number;
  /** Max in-flight cheap calls. Default 20; 100 was fine on 4663 but is not a safe default. */
  readonly cheap: number;
};

export const DEFAULT_LIMITS: LimiterConfig = { expensive: 4, cheap: 20 };

/**
 * A counting semaphore. FIFO, so a queued call cannot be starved by later arrivals.
 *
 * Hand-rolled deliberately: this is ~30 lines, it must live inside a `fetchFn` closure,
 * and every candidate library (`p-limit`, `p-queue`, `bottleneck`) would add a dependency
 * to every generated project for less code than this comment block.
 */
export class Semaphore {
  #available: number;
  readonly #permits: number;
  readonly #waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`semaphore needs at least 1 permit, got ${permits}`);
    }
    this.#available = permits;
    this.#permits = permits;
  }

  /** Calls currently holding a permit. */
  get inFlight(): number {
    return this.#permits - this.#available;
  }

  /** Calls waiting for a permit. */
  get queued(): number {
    return this.#waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return this.#release();
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    return this.#release();
  }

  #release(): () => void {
    let released = false;
    return () => {
      // Guard against double-release, which would inflate the permit count and silently
      // raise the real concurrency above the configured cap.
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) next();
      else this.#available += 1;
    };
  }

  /** Run `fn` holding a permit, releasing it even if `fn` throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export type Limiter = {
  /** Route a call to the right budget by method name. */
  run<T>(method: string, fn: () => Promise<T>): Promise<T>;
  /** Current in-flight counts, for assertions and metrics. */
  stats(): { readonly expensive: number; readonly cheap: number };
};

export function createLimiter(config: LimiterConfig = DEFAULT_LIMITS): Limiter {
  const expensive = new Semaphore(config.expensive);
  const cheap = new Semaphore(config.cheap);

  return {
    run(method, fn) {
      return costOf(method) === "expensive" ? expensive.run(fn) : cheap.run(fn);
    },
    stats() {
      return { expensive: expensive.inFlight, cheap: cheap.inFlight };
    },
  };
}

/**
 * Wrap `fetch` so every JSON-RPC call passes through the limiter.
 *
 * This is the seam viem gives us: `http(url, { fetchFn })`. Limiting here rather than at
 * the action layer means EVERY call is covered, including ones viem makes internally.
 *
 * A batch request (a JSON array body) is charged at its most expensive member — one
 * `eth_getLogs` in a batch of a hundred makes the whole batch expensive, which is exactly
 * how the server will experience it.
 */
export function limitedFetch(
  limiter: Limiter,
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const method = methodOf(init?.body);
    return limiter.run(method, () => baseFetch(input, init));
  };
}

/**
 * Best-effort method extraction. Unparseable bodies are treated as cheap.
 *
 * Typed as `unknown` rather than `BodyInit` deliberately: `BodyInit` is a DOM lib type,
 * and pulling `lib: ["dom"]` into a Node package to name one parameter would drag the
 * whole browser surface into every consumer's typechecking.
 */
function methodOf(body: unknown): string {
  if (typeof body !== "string") return "unknown";
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) {
      const methods = parsed
        .map((entry) => (isRpcCall(entry) ? entry.method : "unknown"))
        .filter((m) => costOf(m) === "expensive");
      return methods[0] ?? "unknown";
    }
    return isRpcCall(parsed) ? parsed.method : "unknown";
  } catch {
    return "unknown";
  }
}

function isRpcCall(value: unknown): value is { method: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    typeof (value as { method: unknown }).method === "string"
  );
}
