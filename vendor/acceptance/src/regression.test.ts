import { describe, expect, it } from "vitest";
import {
  assessAcceptance,
  checkCapability,
  checkEvidence,
  formatAcceptance,
  type ProjectView,
} from "./check.js";
import { impliedCapabilities, mergeCapabilities } from "./derive.js";
import { assessPlaceholders, formatPlaceholders } from "./placeholder.js";

/**
 * ══ The test this package exists for ══
 *
 * Everything else here checks the mechanism. This one reconstructs what a real generated
 * project actually shipped, and asserts the stage would have refused it.
 *
 * That project passed:
 *   - 747 of its own tests
 *   - biome, knip, tsc strict, coverage thresholds
 *   - 24 browser checks at two viewports (contrast, layout, overflow, a11y, no console errors)
 *   - two clean Railway deploys with a live healthcheck
 *
 * And it was the wrong product. If this file ever passes while asserting the project is fine,
 * the package has stopped doing its job.
 */

/** The prompt, as it was actually given. Trimmed but not paraphrased. */
const PROMPT = `use fletchdotclick cashback mode and ponsball engines on how they are offered
as services to create a cashback agent that users use as a service for their pons tokens
launchpad creator fees, really cool, pixel-art design, neural network web design, no scroll
agent feel web design, easiest possible ui and ux, minimalistic, privy to connect, etcs,
whatever cost for this service to run for each user must be self funded by user prepaid or
perp mode, also 10% of money in from users goes to a tres wallet for the team, fully
functionality e2e and token ready to be deployed on pons and everything set up on railway`;

/**
 * The holder table the deployed page actually displayed.
 *
 * These four addresses were on a public URL, with those amounts, rendered as real data.
 */
const SHIPPED_SCREEN = `
const HOLDERS: readonly HolderBalance[] = [
  { address: "0x1111111111111111111111111111111111111111", balance: 4_200n },
  { address: "0x2222222222222222222222222222222222222222", balance: 2_600n },
  { address: "0x3333333333333333333333333333333333333333", balance: 1_900n },
  { address: "0x4444444444444444444444444444444444444444", balance: 900n },
];

export function Screen(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<ServiceMode>("funded");
  return <main>{/* mode toggle, split panel, holder table */}</main>;
}
`;

/** The worker, with its honest comment about doing nothing. */
const SHIPPED_WORKER = `
async function tick(): Promise<void> {
  // The decision layer is complete and tested, but the chain I/O that would feed it is NOT
  // wired up: reading enrolments, claimable fees, holder balances and the basefee all need
  // an RPC endpoint and a funded wallet, and this build deploys nothing and moves no funds.
  void keeper;
}
`;

/** What the project contained, as the acceptance stage would have seen it. */
const SHIPPED: ProjectView = {
  files: [
    { path: "apps/web/app/screen.tsx", source: SHIPPED_SCREEN },
    {
      path: "apps/web/app/page.tsx",
      source: "export default function Page() { return <Screen/>; }",
    },
    { path: "apps/web/app/wallet.ts", source: "export const CHAIN_ID = 4663;" },
    {
      path: "apps/web/app/api/health/route.ts",
      source: "export async function GET() { return Response.json({status:'ok'}); }",
    },
    { path: "apps/indexer/src/index.ts", source: SHIPPED_WORKER },
    {
      path: "apps/indexer/src/keeper.ts",
      source: "export function runTick() { /* pure decision layer */ }",
    },
  ],
  /**
   * What the real browser saw. Taken from the actual probe: a heading, buttons, a canvas —
   * and no input of any kind, which is the defect.
   */
  rendered: {
    "/": {
      selectorsPresent: ["h1", "button", "canvas", "main", "header", "footer", "section"],
      visibleText:
        "PONS CASHBACK CONNECT MODE DEPOSIT FEE-SHARE BALANCE 0.010000 ETH RUNS UNTIL SPENT " +
        "STATUS ACTIVE SPLIT OF 0.000446 ETH TREASURY 10% CASHBACK HOLDERS 4 PAID 1 FILTERED " +
        "CHAIN 4663 NOT CONNECTED",
    },
  },
  routes: { "/api/health": 200, "/": 200 },
};

describe("the project that passed everything and was wrong", () => {
  it("refuses it", () => {
    const result = assessAcceptance({
      capabilities: mergeCapabilities([], impliedCapabilities(PROMPT)),
      view: SHIPPED,
    });

    expect(
      result.ok,
      `the stage accepted a project with no token input:\n${formatAcceptance(result)}`,
    ).toBe(false);
  });

  /**
   * The specific, load-bearing miss: a service for "their pons tokens" with no way to name a
   * token. This is the finding that would have stopped the deploy.
   */
  it("names the missing token input as the reason", () => {
    const result = assessAcceptance({
      capabilities: mergeCapabilities([], impliedCapabilities(PROMPT)),
      view: SHIPPED,
    });

    expect(result.missing).toContain("user-supplies-identifier");

    const report = formatAcceptance(result);
    expect(report).toContain("user-supplies-identifier");
    // The report must quote the prompt phrase that implied it, or the finding is unarguable
    // in the wrong direction — someone will assume the checker invented the requirement.
    expect(report).toContain("their pons token");
  });

  it("catches that an enrolment would not survive a reload", () => {
    const result = assessAcceptance({
      capabilities: mergeCapabilities([], impliedCapabilities(PROMPT)),
      view: SHIPPED,
    });
    expect(result.missing).toContain("state-outlives-a-reload");
  });

  /**
   * The product took deposits and a 10% cut with no contracts and no statement that an
   * operator key held the funds. Either answer is acceptable; silence is not.
   */
  it("catches undisclosed custody", () => {
    const result = assessAcceptance({
      capabilities: mergeCapabilities([], impliedCapabilities(PROMPT)),
      view: SHIPPED,
    });
    expect(result.missing).toContain("custody-is-explicit");
  });

  it("catches the four invented holder addresses", () => {
    const verdict = assessPlaceholders(
      SHIPPED.files.map((file) => ({ path: file.path, source: file.source })),
    );

    expect(verdict.ok, formatPlaceholders(verdict)).toBe(false);
    const addresses = verdict.findings
      .filter((finding) => finding.kind === "repeated-nibble-address")
      .map((finding) => finding.text);
    expect(addresses).toHaveLength(4);
    expect(addresses[0]).toBe("0x1111111111111111111111111111111111111111");
  });

  /**
   * The worker's comment was HONEST — it said plainly that the chain I/O was not wired. It was
   * still a deployed service that did nothing, and honesty in a comment is not functionality.
   */
  it("catches the admitted no-op in the deployed worker", () => {
    const verdict = assessPlaceholders([
      { path: "apps/indexer/src/index.ts", source: SHIPPED_WORKER },
    ]);
    expect(verdict.findings.some((finding) => finding.kind === "todo-marker")).toBe(true);
  });

  /**
   * ══ The counter-test ══
   *
   * A fixed version must PASS, or the stage is just a wall. Same prompt, a project that
   * actually does the things: an input bound to a handler, a database, a stated custody model.
   */
  it("accepts a version that has what the prompt required", () => {
    const fixed: ProjectView = {
      files: [
        {
          path: "apps/web/app/enrol.tsx",
          source: `export function Enrol() {
            const [token, setToken] = useState("");
            return <input value={token} onChange={(event) => setToken(event.target.value)} />;
          }`,
        },
        {
          path: "apps/web/app/db.ts",
          source: `import { drizzle } from "drizzle-orm"; export const db = drizzle(process.env.DATABASE_URL);`,
        },
        {
          path: "apps/web/app/about.tsx",
          source: `export const COPY = "This service is non-custodial: your fees are held by a contract, never by us.";`,
        },
        {
          /**
           * The app lives at `/app`, so `/` is free to be a landing page. Added when
           * `landing-page-explains-the-product` landed: a product whose entire surface is one
           * screen has no landing page, it has a screen someone called one.
           */
          path: "apps/web/app/app/page.tsx",
          source: "export default function App() { return <Enrol/>; }",
        },
        {
          path: "apps/web/app/api/status/route.ts",
          source: "export async function GET() { return Response.json({ lastRun: 0 }); }",
        },
      ],
      rendered: {
        "/": {
          selectorsPresent: [
            "h1, h2, [role=heading]",
            "h1",
            "input[type=text], input:not([type]), textarea, [contenteditable=true]",
            "button",
            "*",
          ],
          /**
           * A 20+ word lead sentence, because that is what the landing-page check asks for and
           * what real landing copy looks like. The earlier version here was three short
           * sentences with a 13-word longest — enough for `explains-itself` (12) and correctly
           * short for a page a stranger arrives on.
           */
          visibleText:
            "Pons Cashback turns the creator fees your launchpad token earns into automatic " +
            "payouts for the people holding it, without you doing anything. We take 10% of " +
            "what comes in; the rest funds gas and the cashback itself. Non-custodial: a " +
            "contract holds the fees, never our key. Enter your token to begin.",
        },
      },
      routes: { "/": 200, "/api/status": 200 },
    };

    const result = assessAcceptance({
      capabilities: mergeCapabilities([], impliedCapabilities(PROMPT)),
      view: fixed,
      // The one judgement in the implied set, answered.
      judgements: {
        "does the visible text state what the service does and what it charges?": true,
      },
    });

    expect(result.ok, formatAcceptance(result)).toBe(true);
  });
});

/**
 * ══ The prose check against the real page's real text ══
 *
 * This is the visible text the deployed page actually rendered, verbatim from the browser
 * probe. 392 characters, and not one sentence. A character-count threshold would pass it.
 */
describe("the page that rendered 392 characters and explained nothing", () => {
  const REAL_VISIBLE_TEXT =
    "PONS CASHBACK CONNECT MODE DEPOSIT FEE-SHARE BALANCE 0.010000 ETH RUNS UNTIL SPENT " +
    "STATUS ACTIVE SPLIT OF 0.000446 ETH TREASURY 10% 0.000044 KEEPER GAS 0.000006 CASHBACK " +
    "0.000395 CLAIM IS ECONOMIC HOLDERS — 4 PAID, 1 FILTERED 0x1111…1111 0.00017298 " +
    "0x2222…2222 0.00010708 0x3333…3333 0.00007825 0x4444…4444 0.00003706 DUST 0.00000000 " +
    "ETH ROLLS INTO THE NEXT CYCLE CHAIN 4663 NOT CONNECTED";

  it("has plenty of characters", () => {
    // Stated so the reason a length check fails is explicit rather than implied. 388
    // characters of rendered text, and a character threshold at any sane value passes it.
    expect(REAL_VISIBLE_TEXT.length).toBeGreaterThan(350);
  });

  it("fails the prose check anyway, because labels are not sentences", () => {
    const verdict = checkEvidence(
      {
        kind: "prose",
        target: "12",
        rationale: "a sentence must exist",
      },
      { files: [], rendered: { "/": { selectorsPresent: [], visibleText: REAL_VISIBLE_TEXT } } },
    );

    expect(verdict.held, verdict.detail).toBe(false);
    expect(verdict.detail).toContain("labels and numbers");
  });

  /** Real prose from the same product's fixed copy passes. */
  it("passes on a sentence that actually explains the product", () => {
    const verdict = checkEvidence(
      { kind: "prose", target: "12", rationale: "a sentence must exist" },
      {
        files: [],
        rendered: {
          "/": {
            selectorsPresent: [],
            visibleText:
              "Pons Cashback turns your launchpad creator fees into automatic payouts for the " +
              "people holding your token.",
          },
        },
      },
    );
    expect(verdict.held, verdict.detail).toBe(true);
  });
});

/**
 * ══ The real `/` that shipped, against the landing-page check ══
 *
 * Verbatim from the browser probe of the deployed service: 388 characters at `/`, every one a
 * label or a number, and the app was the only thing there. `explains-itself` passed on this
 * once a heading existed — which is why a separate check for the page a stranger lands on
 * exists at all.
 */
describe("the control panel that was served at /", () => {
  const REAL_LANDING_TEXT =
    "PONS CASHBACK CONNECT MODE DEPOSIT FEE-SHARE BALANCE 0.010000 ETH RUNS UNTIL SPENT " +
    "STATUS ACTIVE SPLIT OF 0.000446 ETH TREASURY 10% 0.000044 KEEPER GAS 0.000006 CASHBACK " +
    "0.000395 CLAIM IS ECONOMIC HOLDERS — 4 PAID, 1 FILTERED CHAIN 4663 NOT CONNECTED";

  const capabilities = mergeCapabilities(
    [],
    impliedCapabilities("a web app where each user brings their token for cashback"),
  );

  const landing = capabilities.find(
    (capability) => capability.id === "landing-page-explains-the-product",
  );

  it("was implied by the prompt", () => {
    expect(landing, "the landing-page capability was never derived").toBeDefined();
  });

  it("refuses the page that actually shipped", () => {
    const verdict = checkCapability(landing as never, {
      files: [{ path: "apps/web/app/page.tsx", source: "export default function Page() {}" }],
      rendered: {
        "/": {
          selectorsPresent: ["h1", "button", "canvas", "main", "header", "footer", "section"],
          visibleText: REAL_LANDING_TEXT,
        },
      },
      routes: { "/": 200 },
    });

    expect(verdict.present, "a control panel passed as a landing page").toBe(false);
    // It had a heading and answered 200 — the failures are the ones that matter.
    const failed = verdict.verdicts
      .filter((piece) => !piece.held)
      .map((piece) => piece.evidence.kind);
    expect(failed, "the prose check should reject a page of labels").toContain("prose");
    expect(failed, "the app was the only thing at /").toContain("path");
  });

  /** It had a heading and answered — so a weaker check would have passed it. */
  it("would have passed a heading-and-status check", () => {
    const verdict = checkCapability(landing as never, {
      files: [{ path: "apps/web/app/page.tsx", source: "" }],
      rendered: {
        "/": { selectorsPresent: ["h1, h2, [role=heading]"], visibleText: REAL_LANDING_TEXT },
      },
      routes: { "/": 200 },
    });
    const held = verdict.verdicts.filter((piece) => piece.held).map((piece) => piece.evidence.kind);
    expect(held, "the heading was genuinely there").toContain("rendered");
    expect(held, "the route genuinely answered").toContain("route");
    expect(verdict.present).toBe(false);
  });
});
