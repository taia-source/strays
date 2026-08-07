/**
 * Spending bounds for an agent that holds keys.
 *
 * ══ The threat model, corrected by the incident record ══
 *
 * The obvious framing is "defend against prompt injection". That is half right, and the
 * half it misses is the larger half. The two largest confirmed single-agent losses:
 *
 *   Grok / Bankr      2026-05-04  ~$155k   prompt injection via a public reply
 *   Lobstar Wilde     2026-02-22  ~$250k   **a decimal error**, not an injection
 *
 * Lobstar Wilde's author published a postmortem arguing explicitly that it was *not*
 * injection: a session crash reset the agent's wallet state, and a token-decimal parsing
 * error scaled a ~4 SOL transfer into **5% of total supply** — sold off within 15 minutes.
 *
 * So the danger is **untrusted input reaching a signer, where "untrusted" includes
 * *malformed*, not only malicious.** An injection classifier would not have caught Lobstar
 * Wilde. A per-transaction cap and a destination allowlist would have caught both.
 *
 * ══ Why bounds rather than detection ══
 *
 * No reliable prompt-injection detection exists. Simon Willison's assessment of 95%-accurate
 * guardrails is that in security terms this is "very much a failing grade" — and an agent
 * makes thousands of decisions.
 *
 * Nor can you out-race a drain. Gnosis Pay (2026-06-01, ~$1.8M) had **world-class** incident
 * response — root cause identified in 1h49m — and the attacker still had the entire window.
 * Modern drains route through private mempools, so there is no pending transaction to react
 * to. A human-in-the-loop pause loses by construction.
 *
 * **A cap is not a detection mechanism. It is a loss ceiling that requires nobody to be
 * watching.** That is the whole argument for this module.
 *
 * ══ Why state is passed in, not held here ══
 *
 * Lobstar Wilde's spend accounting died with its session. If the budget lives in agent
 * memory, a crash resets "spent" to zero and the cap silently reopens. So every function
 * here is pure and takes the prior state explicitly — the caller is forced to decide where
 * that state durably lives, and the honest answer is on chain or in a database, never in
 * the process that is being constrained.
 */

/** A proposed transfer, as a typed intent rather than prose. */
export type SpendIntent = {
  /** Wei, or the token's smallest unit. Never a decimal string. */
  readonly amount: bigint;
  readonly token: string;
  readonly recipient: string;
  /** Unique per logical action. The dedup key that defeats retry storms. */
  readonly idempotencyKey: string;
};

/** What has already been spent. Supplied by the caller from durable storage. */
export type SpendState = {
  /** Total spent inside the current window, in the same unit as the caps. */
  readonly spentInWindow: bigint;
  /** When the window began, in seconds. */
  readonly windowStartSeconds: number;
  /** Idempotency keys already executed. */
  readonly executedKeys: ReadonlySet<string>;
  /** Transfers executed inside the current window. */
  readonly countInWindow: number;
};

export type SpendPolicy = {
  /** Hard ceiling on any single transfer. The bound that catches a decimal error. */
  readonly maxPerTransaction: bigint;
  /** Ceiling across the whole window. */
  readonly maxPerWindow: bigint;
  /** Window length in seconds. */
  readonly windowSeconds: number;
  /**
   * Count-based rate limit, distinct from the value caps.
   *
   * Zodiac Roles v2 models these separately for good reason: `WithinAllowance` caps a
   * value while `CallWithinAllowance` decrements once per call. A retry storm can stay
   * under every value cap while making hundreds of calls, and only a count catches it.
   */
  readonly maxCallsPerWindow: number;
  /** Recipients this agent may pay. Empty means "no allowlist configured", which halts. */
  readonly allowedRecipients: ReadonlySet<string>;
  /** Tokens this agent may move. */
  readonly allowedTokens: ReadonlySet<string>;
};

export type Denial = {
  readonly reason:
    | "per-transaction-cap"
    | "window-cap"
    | "rate-limit"
    | "recipient-not-allowed"
    | "token-not-allowed"
    | "duplicate"
    | "no-allowlist"
    | "malformed";
  readonly detail: string;
};

export type Decision =
  | { readonly allowed: true; readonly next: SpendState }
  | { readonly allowed: false; readonly denials: readonly Denial[] };

/**
 * Decide whether a transfer may proceed, and produce the next state if so.
 *
 * Returns **every** reason it was refused rather than the first. An agent that fixes one
 * denial and retries produces exactly the retry storm this is meant to bound; telling it
 * everything at once means one correction rather than a loop.
 */
export function authorise(options: {
  readonly intent: SpendIntent;
  readonly policy: SpendPolicy;
  readonly state: SpendState;
  readonly nowSeconds: number;
}): Decision {
  const { intent, policy, state, nowSeconds } = options;
  const denials: Denial[] = [];

  // A window that has elapsed resets the counters — but only ever forward. A caller
  // passing a stale window must not be able to un-spend by rewinding the clock.
  const windowElapsed = nowSeconds - state.windowStartSeconds >= policy.windowSeconds;
  const spentInWindow = windowElapsed ? 0n : state.spentInWindow;
  const countInWindow = windowElapsed ? 0 : state.countInWindow;
  const windowStartSeconds = windowElapsed ? nowSeconds : state.windowStartSeconds;

  if (intent.amount <= 0n) {
    denials.push({
      reason: "malformed",
      detail: `amount is ${intent.amount} — a transfer of zero or less is never a legitimate intent`,
    });
  }

  if (!intent.idempotencyKey.trim()) {
    denials.push({
      reason: "malformed",
      detail:
        "no idempotency key. Without one, a retry loop re-executes the same transfer — an " +
        "agent stuck retrying can submit the same payment hundreds of times in seconds",
    });
  } else if (state.executedKeys.has(intent.idempotencyKey)) {
    denials.push({
      reason: "duplicate",
      detail: `idempotency key ${intent.idempotencyKey} has already executed — this is a repeat, not a new transfer`,
    });
  }

  /**
   * The per-transaction cap. This is the bound that catches a decimal error.
   *
   * Lobstar Wilde meant to send ~4 SOL and sent 5% of total supply. No detection layer
   * would have flagged that as suspicious — the agent believed it was correct — but any
   * ceiling on a single transfer would have refused it.
   */
  if (intent.amount > policy.maxPerTransaction) {
    const multiple = policy.maxPerTransaction > 0n ? intent.amount / policy.maxPerTransaction : 0n;
    denials.push({
      reason: "per-transaction-cap",
      detail:
        `${intent.amount} exceeds the per-transaction ceiling of ${policy.maxPerTransaction}` +
        (multiple > 1n ? ` — ${multiple}x over` : "") +
        ". A single transfer this far outside the norm is a decimal error until proven otherwise",
    });
  }

  if (spentInWindow + intent.amount > policy.maxPerWindow) {
    denials.push({
      reason: "window-cap",
      detail:
        `${spentInWindow} already spent this window; ${intent.amount} more would exceed the ` +
        `${policy.maxPerWindow} ceiling`,
    });
  }

  if (countInWindow + 1 > policy.maxCallsPerWindow) {
    denials.push({
      reason: "rate-limit",
      detail:
        `${countInWindow} transfers already this window, limit ${policy.maxCallsPerWindow}. ` +
        "A count limit catches a retry storm that stays under every value cap",
    });
  }

  // An unconfigured allowlist must HALT rather than allow everything. Defaulting open is
  // how a missing config becomes an unbounded agent.
  if (policy.allowedRecipients.size === 0) {
    denials.push({
      reason: "no-allowlist",
      detail:
        "no recipient allowlist is configured. An empty allowlist means 'not yet decided', " +
        "never 'anyone' — this fails closed deliberately",
    });
  } else if (!policy.allowedRecipients.has(intent.recipient.toLowerCase())) {
    denials.push({
      reason: "recipient-not-allowed",
      detail:
        `${intent.recipient} is not an allowed recipient. Both large agent losses on record ` +
        "sent funds to an address supplied by an outside party",
    });
  }

  if (policy.allowedTokens.size > 0 && !policy.allowedTokens.has(intent.token.toLowerCase())) {
    denials.push({
      reason: "token-not-allowed",
      detail: `${intent.token} is not an allowed token`,
    });
  }

  if (denials.length > 0) return { allowed: false, denials };

  return {
    allowed: true,
    next: {
      spentInWindow: spentInWindow + intent.amount,
      windowStartSeconds,
      countInWindow: countInWindow + 1,
      executedKeys: new Set([...state.executedKeys, intent.idempotencyKey]),
    },
  };
}

/** A fresh state, for a caller starting with no history. */
export function emptyState(nowSeconds: number): SpendState {
  return {
    spentInWindow: 0n,
    windowStartSeconds: nowSeconds,
    executedKeys: new Set(),
    countInWindow: 0,
  };
}

/**
 * Where the accounting actually lives, and why it matters.
 *
 * Off-chain aggregation has a documented race. Privy's own docs state that "aggregation
 * values are updated **after** a request is successfully signed, not before. This means
 * multiple concurrent requests may all pass policy evaluation before any of their values
 * are recorded."
 *
 * That is a time-of-check/time-of-use gap, and a retry storm is precisely the workload
 * that exploits it: an agent firing concurrent signs can pass an off-chain cap arbitrarily
 * many times. Zodiac Roles v2 mutates its allowance in the same transaction as the call
 * and cannot be raced this way.
 *
 * So `authorise` is deliberately pure: it cannot promise atomicity it does not control.
 * The caller must commit `next` **before** signing, and this constant exists to make the
 * requirement impossible to miss.
 */
export const STATE_COMMIT_RULE =
  "commit the returned state BEFORE signing, not after. Committing afterwards leaves a " +
  "time-of-check/time-of-use gap that concurrent retries pass straight through — Privy " +
  "documents exactly this race in its own stateful policies";

export function formatDecision(decision: Decision): string {
  if (decision.allowed) return "authorised";

  return [
    `REFUSED — ${decision.denials.length} bound(s) exceeded:`,
    ...decision.denials.map((d) => `  ✗ [${d.reason}] ${d.detail}`),
    "",
    "  Every reason is listed rather than the first, so a caller corrects once instead of",
    "  retrying against each in turn — which is itself the retry storm these bounds exist for.",
  ].join("\n");
}
