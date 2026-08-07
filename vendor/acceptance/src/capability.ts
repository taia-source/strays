/**
 * What the user asked for, as something a machine can check.
 *
 * ══ The failure that forced this to exist ══
 *
 * A generated project passed 747 of its own tests, 24 browser checks and two clean Railway
 * deploys. It was the wrong product:
 *
 *   - no text input anywhere, so a user could not enter the token the service is FOR
 *   - four hardcoded holder addresses (0x1111…, 0x2222…, 0x3333…, 0x4444…) with invented
 *     balances, displayed as if real
 *   - no persistence, so an enrolment survived only until a page reload
 *   - no contracts, in a product that takes custody of fees
 *
 * Every check passed because every check measured whether the code does what the code says.
 * Nothing asked whether the artifact was what was REQUESTED. The prompt said users bring
 * "their pons tokens launchpad creator fees" — a sentence that requires an input, a proof of
 * ownership, somewhere to store the enrolment, and something holding the money.
 *
 * ══ Why the spec could not have caught it ══
 *
 * `RunSpec` carries six fields: name, chainId, tokens, kind, web, indexer. Not one of them
 * can express "a user can enrol a token". The requirement was discarded at extraction and
 * nothing downstream could miss it, because nothing downstream knew about it.
 *
 * ══ Deterministic first, judge last ══
 *
 * PRDBench measured LLM-as-judge agreement with human annotators at **81.56%, σ 27.83%**
 * across 282 cases — and found that one bad verdict corrupts later ones through shared
 * context. A stage built on a judge alone would be a rubber stamp that occasionally lies.
 *
 * So a capability carries **executable evidence**: a file that must exist, a symbol that must
 * be exported, a selector that must appear in a rendered page, an HTTP route that must answer.
 * Those are decidable. A judge is reserved for the residue and never overrides a hard verdict.
 */

/** How a capability's presence is decided. Ordered from most to least reliable. */
export type EvidenceKind =
  /** A path exists in the generated tree. Fully decidable. */
  | "file"
  /** A symbol is exported from the project's own source. Fully decidable. */
  | "export"
  /** Source anywhere in the project matches a pattern. Decidable, weaker: presence ≠ wiring. */
  | "source"
  /**
   * A file PATH matches a pattern. Fully decidable.
   *
   * Distinct from `file`, which is an exact path, and from `source`, which searches contents.
   * Needed for "a route exists somewhere under a directory whose exact location depends on the
   * framework" — `app/app/page.tsx`, `pages/app.tsx`, `routes/app.tsx` are the same fact.
   *
   * Added after writing a path pattern as `source` evidence and watching it fail: the pattern
   * matched the path perfectly and `source` never looks at paths.
   */
  | "path"
  /** An element matching a selector exists in the RENDERED page. Decidable, and strong. */
  | "rendered"
  /** An HTTP route answers with an acceptable status. Decidable against a live service. */
  | "route"
  /**
   * The rendered page contains a sentence of at least N words. Fully decidable.
   *
   * Exists because "the page explains itself" is the requirement most likely to be handed to
   * a judge, and the common failure is decidable without one: the measured page rendered 392
   * characters of visible text, every one a label or a number.
   */
  | "prose"
  /**
   * A human or a judge must look.
   *
   * Deliberately last and deliberately rare. Every capability that can be expressed as one of
   * the above must be — see the alignment numbers in the module docstring.
   */
  | "judgement";

/** One piece of checkable evidence that a capability is present. */
export type Evidence = {
  readonly kind: EvidenceKind;
  /**
   * What to look for. A path, an export name, a regex source, a CSS selector, or a route.
   *
   * A string rather than a union so the checker stays data-driven: capabilities are derived
   * from a prompt at runtime, and a closed set of shapes could not express an unanticipated
   * requirement.
   */
  readonly target: string;
  /** Why this proves the capability, in the words a failure report should use. */
  readonly rationale: string;
};

/**
 * Something the user must be able to DO, or the product must have.
 *
 * Phrased as an action wherever possible. "A user can enter a token address" is checkable;
 * "good UX" is not, and a capability that cannot fail is not a capability.
 */
export type Capability = {
  /** Stable id, kebab-case. Used to correlate a finding with the requirement it came from. */
  readonly id: string;
  /** The requirement in the user's terms, quoting the prompt where possible. */
  readonly statement: string;
  /**
   * Whether shipping without this is a defect or a gap.
   *
   * `required` blocks a deploy. `expected` is reported loudly and does not block — the
   * distinction matters because a prompt implies far more than it demands, and a stage that
   * blocks on everything implied gets turned off.
   */
  readonly level: "required" | "expected";
  /**
   * Evidence that would settle it. ALL must hold.
   *
   * A conjunction rather than a disjunction on purpose: "there is an input somewhere" and
   * "the input is wired to something" are both needed, and satisfying either alone is the
   * exact shape of the failure this package exists to catch.
   */
  readonly evidence: readonly Evidence[];
  /** Where this came from, so a disputed capability can be traced to its sentence. */
  readonly source: string;
};

/**
 * The trigger words that imply a capability, and what they imply.
 *
 * ══ Why a table and not a model call ══
 *
 * These are the requirements a prompt implies WITHOUT SAYING SO, and they recur across every
 * product of a kind. "Users" implies someone must be able to identify themselves. "Their
 * token" implies an input and an ownership check. A model asked to derive capabilities
 * produces the ones the prompt states and misses the ones it assumes — which is precisely
 * how a service "for users' tokens" shipped with no way to name a token.
 *
 * So the table covers the implied set deterministically, and a model is asked only for what
 * is specific to this prompt. Every entry below was derived from a MEASURED omission, not
 * from imagination.
 */
export const IMPLIED_CAPABILITIES: readonly {
  readonly when: RegExp;
  readonly capability: Omit<Capability, "source">;
}[] = [
  {
    /**
     * Any product where a user supplies a token, address, or identifier of their own.
     *
     * The measured failure: a cashback service for "their pons tokens" shipped with no text
     * input of any kind. The user could connect a wallet and then do nothing.
     */
    when: /\b(their|users?['’]?s?|my|customers?['’]?s?)\s+\w*\s*(token|contract|address|pool|wallet)/i,
    capability: {
      id: "user-supplies-identifier",
      statement:
        "A user can enter the token or address the service acts on. Without an input, a " +
        "product 'for users' tokens' has no way to learn which token.",
      level: "required",
      evidence: [
        {
          kind: "rendered",
          target: "input[type=text], input:not([type]), textarea, [contenteditable=true]",
          rationale:
            "an editable field must exist in the rendered page — asserting on source is not " +
            "enough, because a framework can render a component to nothing",
        },
        {
          kind: "source",
          // The value must go somewhere. An input bound to nothing is decoration.
          target: "onChange|onInput|bind:value|v-model|formAction",
          rationale: "the field must be bound to a handler, or what is typed goes nowhere",
        },
      ],
    },
  },
  {
    /**
     * Anything a user enrols, configures, or subscribes must outlive a page reload.
     *
     * Measured: enrolments lived in React `useState` and nowhere else, so the keeper read its
     * watchlist from an environment variable a user cannot set.
     */
    /**
     * ══ Widened after it missed the case it was written for ══
     *
     * The first version keyed on "enrol|register|subscribe". The measured prompt said
     * "a cashback agent that **users use as a service** for their tokens" and never used any
     * of those words — so the rule that exists to catch missing persistence did not fire on
     * the project whose persistence was missing.
     *
     * The real trigger is **per-user state**: the moment a product distinguishes one user's
     * setup from another's, that setup has to outlive a page. "users use as a service",
     * "each user", "their token" all imply it; none of them says "enrol".
     */
    /**
     * ══ Widened twice, both times after it missed a real case ══
     *
     * v1 keyed on enrol|register|subscribe. The measured prompt said "users use as a service"
     * and never used any of them, so the rule missed the project whose persistence was missing.
     * Widened to per-user state.
     *
     * v2 added state that outlives a REQUEST rather than a user. A bridge showing transfer
     * status, or a page showing order history, has state to keep and names no user at all —
     * and `~/work/arcway/` is exactly that: a USDC bridge whose first commit had no database,
     * with Postgres arriving a day later only because Ibrahim asked for it.
     *
     * Still silent on a bare "a bridge over CCTP v2", and that is honest: nothing in that
     * sentence says anything must be remembered.
     */
    when: /\b(enrol|enroll|register|subscribe|sign\s?up|onboard|persist)\w*\b|\b(?:each|per|every)\s+user\b|\busers?\s+(?:use|can|may|get|have|bring)\b|\bfor\s+(?:their|each|every)\b|\b(history|transactions?|orders?|positions?|status|track|tracking|pending|queue|records?|receipts?)\b|\bin\s+(?:transit|flight|progress)\b/i,
    capability: {
      id: "state-outlives-a-reload",
      statement:
        "What a user sets up survives a page reload and a service restart. Component state " +
        "is not persistence.",
      level: "required",
      evidence: [
        {
          kind: "source",
          target: "DATABASE_URL|createClient|drizzle|prisma|kysely|postgres|sqlite|redis",
          rationale:
            "some store must be reachable from the code — without one, an enrolment exists " +
            "only in the tab that made it",
        },
      ],
    },
  },
  {
    /**
     * A product that holds, splits, or forwards money either has contracts or has custody.
     *
     * Not a demand for contracts — custody is a legitimate design. It is a demand that the
     * choice be VISIBLE, because it was silently custody: no contracts, and no UI saying so.
     */
    /**
     * ══ Keyed on value MOVING, not on fee vocabulary ══
     *
     * The first version listed fee|deposit|treasury|payout|cashback|revenue|custody|escrow.
     * Measured against prompts for products that plainly move user funds:
     *
     *     "a bridge from Base to Arc for USDC over CCTP v2"   MISS
     *     "let people swap tokens on base"                    MISS
     *
     * Both miss. A bridge holds a user's USDC in transit and a swap routes it through a
     * contract, and the rule that exists to force the trust model into the open fired on
     * neither.
     *
     * That is not hypothetical. `~/work/arcway/` IS that bridge: its first commit was 214
     * files and 35,934 lines with **zero .sol files**, and the router arrived a day later
     * only because Ibrahim asked for it. A cashback service did the same.
     *
     * So the trigger is any verb that moves value. A read-only product — an indexer, an
     * explorer, a docs site — still fires on none of them.
     */
    when: /\b(fees?|deposits?|prepaid|treasury|payouts?|cashback|revenue|custody|escrow|bridges?|swaps?|stakes?|staking|vaults?|yield|lends?|borrows?|withdraws?|transfers?|sends?|pays?|paid|claims?|rewards?|liquidity|pools?|mints?|buys?|sells?|trades?)\b/i,
    capability: {
      id: "custody-is-explicit",
      statement:
        "A product that holds user funds either ships the contracts that hold them, or states " +
        "plainly that an operator key does. Silence is the one unacceptable answer.",
      level: "required",
      evidence: [
        {
          kind: "source",
          // Either real contracts, or text that tells the user who holds their money.
          target: "pragma solidity|custodial|non-custodial|operator (?:key|wallet)|we hold|trust",
          rationale:
            "either contracts exist, or the interface says who holds the funds. A product " +
            "that takes deposits and explains neither has hidden its trust model",
        },
      ],
    },
  },
  {
    /**
     * A product with a web surface must explain itself before asking for a wallet.
     *
     * Measured: the shipped page opened directly onto a control panel — no name beyond a
     * title bar, no sentence describing what the service does, no fee disclosure. A visitor
     * could not tell what they were connecting to.
     */
    /**
     * ══ Keyed on a HUMAN, not on the word "web" ══
     *
     * The first version matched web|site|page|app|frontend|landing|ui|dashboard. Measured
     * against five prompts that plainly describe a user-facing product:
     *
     *     "a cashback agent that users use as a service for their tokens"   MISS
     *     "let holders claim their rewards"                                 MISS
     *     "a terminal for traders to watch their positions"                 MISS
     *     "users connect and stake their tokens"                            MISS
     *     "a place where creators enrol tokens"                             MISS
     *
     * All five. The rule that exists to catch an unexplained interface fired on none of the
     * prompts most likely to produce one — including the real prompt once trimmed of its
     * design words.
     *
     * So it now triggers on a PERSON being involved: someone who connects, claims, enrols,
     * views or is otherwise named as a user. That is what implies an interface needing an
     * explanation, and it is what those five prompts all have and the word list all missed.
     */
    when: /\b(web|site|page|app|frontend|landing|ui|dashboard|terminal|interface|screen)\b|\b(users?|holders?|creators?|traders?|customers?|visitors?|anyone|people)\b|\b(connect|claim|enrol|enroll|stake|deposit|withdraw|mint|swap|browse|view|watch)\b/i,
    capability: {
      id: "explains-itself",
      statement:
        "A visitor who has never seen this product can tell what it does, and what it costs, " +
        "before being asked to connect a wallet.",
      level: "required",
      evidence: [
        {
          kind: "rendered",
          target: "h1, h2, [role=heading]",
          rationale: "a heading naming the product must be rendered, not merely a <title>",
        },
        {
          /**
           * ══ Prose, measured deterministically ══
           *
           * The failing page rendered 392 characters of visible text, and every one of them
           * was a label or a number: "MODE DEPOSIT FEE-SHARE BALANCE 0.010000 ETH RUNS UNTIL
           * SPENT STATUS ACTIVE". A visitor could not tell what the product was.
           *
           * So the check is for SENTENCES, not for characters — a run of words long enough to
           * be an explanation. This decides the common case before a judge is consulted, which
           * matters because judge alignment measures 81.56%.
           */
          kind: "prose",
          target: "12",
          rationale:
            "at least one sentence of 12+ words must be visible. The failing page had 392 " +
            "characters of visible text, all of it labels and numbers, and explained nothing",
        },
        {
          kind: "judgement",
          target: "does the visible text state what the service does and what it charges?",
          rationale:
            "the part that resists a selector — consulted only after the prose check above " +
            "has already failed a page with no explanation at all",
        },
      ],
    },
  },
  {
    /**
     * ══ `/` is the marketing page, not the app ══
     *
     * `explains-itself` asks whether SOME page explains the product. This asks whether the
     * page a stranger lands on does — and they are different questions. A product can have a
     * perfectly good docs page at `/about` and still open onto a control panel.
     *
     * Measured: a deployed service rendered 388 characters of visible text at `/`, every one
     * of them a label or a number — "MODE DEPOSIT FEE-SHARE BALANCE 0.010000 ETH RUNS UNTIL
     * SPENT STATUS ACTIVE". A visitor could not tell what the product was, and `explains-
     * itself` passed on it once a heading existed.
     *
     * Same trigger as `explains-itself`: any product with a human in it. The app belongs at
     * `/app` or behind connect; `/` is the only page most people ever see.
     */
    when: /\b(web|site|page|app|frontend|landing|ui|dashboard|terminal|interface|screen)\b|\b(users?|holders?|creators?|traders?|customers?|visitors?|anyone|people)\b|\b(connect|claim|enrol|enroll|stake|deposit|withdraw|mint|swap|browse|view|watch)\b/i,
    capability: {
      id: "landing-page-explains-the-product",
      statement:
        "The page at `/` is a landing page: it names the product, says what it does and what " +
        "it costs, and offers the way in. The app itself lives elsewhere.",
      level: "required",
      evidence: [
        {
          /**
           * Checked at `/` SPECIFICALLY, not "some rendered page".
           *
           * `checkEvidence` searches every rendered route for a selector, which is right for a
           * capability that can live anywhere and wrong for this one — the whole point is
           * WHICH page carries it.
           */
          kind: "route",
          target: "/",
          rationale: "`/` must answer at all before anything about it can be judged",
        },
        {
          kind: "prose",
          target: "20",
          rationale:
            "a landing page carries a longer sentence than an app screen: 20+ words, against " +
            "the 12 that `explains-itself` asks of any page. The measured failure rendered 388 " +
            "characters at `/` without a single sentence",
        },
        {
          kind: "rendered",
          target: "h1, h2, [role=heading]",
          rationale: "a heading naming the product, rendered rather than only in <title>",
        },
        {
          kind: "path",
          /**
           * A route or page file other than the root, so `/` is not the only thing that exists.
           * A product whose entire surface is one screen has no landing page — it has a screen
           * that someone called a landing page.
           *
           * `path`, not `source`: this is about where a file IS, and `source` searches contents.
           * Written as `source` first, and it failed against a tree that plainly had the route.
           */
          /**
           * `/app/page` was in this list and was a FALSE POSITIVE: it matches Next's own root
           * page at `app/page.tsx`, so the check passed on the exact single-screen structure it
           * exists to reject. Caught by testing it against the tree that actually shipped.
           *
           * Every alternative below now requires a segment named `app` NESTED under a router
           * directory, which the root page cannot satisfy.
           */
          target: "app/app/|src/app/app/|routes/app[./]|pages/app[./]",
          rationale:
            "the application must live somewhere other than `/`. A single screen doing both " +
            "jobs is the control panel that shipped",
        },
      ],
    },
  },
  {
    /**
     * Any product taking a percentage must show the arithmetic on real numbers.
     *
     * A stated fee with no worked example is the shape that produces disputes.
     */
    /**
     * `\b` must not follow `%`.
     *
     * The first version was `/\b(\d+\s?%|percent|…)\b/` and could NEVER match a percentage:
     * `%` is a non-word character, so a trailing `\b` requires a word character after it.
     * `10% of money` failed. The rule was dead on every prompt that stated a fee as a
     * percentage — which is every prompt this rule exists for.
     */
    when: /\d+\s?%|\b(percent|bps|basis\s?points|split|share|cut)\b/i,
    capability: {
      id: "fee-arithmetic-is-visible",
      statement:
        "The fee split is shown as numbers a user can check against their own amount, not " +
        "only as a percentage.",
      level: "expected",
      evidence: [
        {
          /**
           * Checked in SOURCE rather than as a selector.
           *
           * The first version used `target: "*"`, which matches every page with any element
           * — no check at all. What matters is that an amount is COMPUTED from the rate:
           * arithmetic on the fee, not a hardcoded string. A rate multiplied by a value is
           * the shape; `10%` printed alone is not.
           */
          kind: "source",
          target: "(bps|BPS|_BPS)\\b|\\*\\s*\\d+n?\\s*/|toFixed|formatUnits|formatEther",
          rationale:
            "an amount must be derived from the rate, not printed as a percentage — a stated " +
            "fee with no worked example is the shape that produces disputes",
        },
      ],
    },
  },
  {
    /**
     * A worker that acts on a schedule must expose whether it is working.
     *
     * Measured across two projects: a keeper reported its decisions only to stdout, so the
     * only way to learn whether the service functioned was to read Railway logs.
     */
    when: /\b(keeper|worker|cron|schedule|automat\w+|bot|agent|indexer|monitor)\b/i,
    capability: {
      id: "background-work-is-observable",
      statement:
        "A user or operator can see whether the background worker is running and what it last " +
        "did, without reading platform logs.",
      level: "expected",
      evidence: [
        {
          kind: "source",
          target: "/api/|/health|status|lastRun|heartbeat",
          rationale: "some surface must report worker state",
        },
      ],
    },
  },
];
