import { describe, expect, it } from "vitest";
import type { Capability } from "./capability.js";
import { compileTarget, impliedCapabilities, isCheckable, mergeCapabilities } from "./derive.js";

function capability(over: Partial<Capability> = {}): Capability {
  return {
    id: "c",
    statement: "s",
    level: "required",
    evidence: [{ kind: "file", target: "a.ts", rationale: "r" }],
    source: "test",
    ...over,
  };
}

/**
 * ══ Closing sabotage survivors ══
 *
 * Each test below was written because a sabotage of the guard it covers passed the suite.
 * The guard existed and nothing checked it.
 */
describe("a capability must be decidable", () => {
  /** Sabotage survivor: removing the blank-target check changed nothing. */
  it("rejects evidence whose target is blank", () => {
    const verdict = isCheckable(
      capability({ evidence: [{ kind: "file", target: "   ", rationale: "r" }] }),
    );
    expect(verdict.ok, "a blank target matches nothing and decides nothing").toBe(false);
    expect(verdict.ok === false && verdict.detail).toContain("no target");
  });

  it("rejects a capability with no id", () => {
    expect(isCheckable(capability({ id: "" })).ok).toBe(false);
  });

  it("accepts a capability with one decidable piece", () => {
    expect(isCheckable(capability()).ok).toBe(true);
  });

  /** A judgement is fine alongside something decidable. */
  it("accepts a capability mixing decidable evidence with a judgement", () => {
    expect(
      isCheckable(
        capability({
          evidence: [
            { kind: "file", target: "a.ts", rationale: "r" },
            { kind: "judgement", target: "good?", rationale: "r" },
          ],
        }),
      ).ok,
    ).toBe(true);
  });
});

describe("merging stated and implied capabilities", () => {
  /**
   * Sabotage survivor: taking the incoming level rather than the stricter one passed.
   *
   * It matters because a model extracting requirements will call something "expected" that the
   * measured table knows is fatal — and the merge would silently downgrade it.
   */
  it("keeps required when a duplicate arrives as expected", () => {
    const merged = mergeCapabilities(
      [capability({ id: "same", level: "expected" })],
      [capability({ id: "same", level: "required" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.level, "a model downgraded a measured requirement").toBe("required");
  });

  it("keeps required regardless of which side it came from", () => {
    const merged = mergeCapabilities(
      [capability({ id: "same", level: "required" })],
      [capability({ id: "same", level: "expected" })],
    );
    expect(merged[0]?.level).toBe("required");
  });

  it("unions the evidence of a duplicate, because more evidence is stricter", () => {
    const merged = mergeCapabilities(
      [capability({ id: "same", evidence: [{ kind: "file", target: "a", rationale: "r" }] })],
      [capability({ id: "same", evidence: [{ kind: "file", target: "b", rationale: "r" }] })],
    );
    expect(merged[0]?.evidence).toHaveLength(2);
  });

  it("records both sources so a merged capability is traceable", () => {
    const merged = mergeCapabilities(
      [capability({ id: "same", source: "stated in the prompt" })],
      [capability({ id: "same", source: 'implied by "their token"' })],
    );
    expect(merged[0]?.source).toContain("stated in the prompt");
    expect(merged[0]?.source).toContain("their token");
  });

  it("sorts by id so two runs produce identical reports", () => {
    const forward = mergeCapabilities([capability({ id: "b" }), capability({ id: "a" })], []);
    const reverse = mergeCapabilities([capability({ id: "a" }), capability({ id: "b" })], []);
    expect(forward.map((c) => c.id)).toEqual(["a", "b"]);
    expect(forward).toEqual(reverse);
  });
});

describe("the implied-capability table", () => {
  /**
   * Sabotage survivors: disabling the custody and explains-itself rules passed the suite,
   * because only the regression test exercised them and it asserted on the OTHER rules.
   * Each rule now has a test of its own naming its level.
   */
  it.each([
    ["takes a 10% fee from deposits", "custody-is-explicit", "required"],
    ["build me a web dashboard", "explains-itself", "required"],
    ["users bring their token", "user-supplies-identifier", "required"],
    ["each user funds their own costs", "state-outlives-a-reload", "required"],
    ["a keeper claims fees on a schedule", "background-work-is-observable", "expected"],
    ["we take 10% and split the rest", "fee-arithmetic-is-visible", "expected"],
  ])("%s implies %s at level %s", (prompt, id, level) => {
    const found = impliedCapabilities(prompt);
    const match = found.find((capability) => capability.id === id);
    expect(
      match,
      `"${prompt}" should imply ${id}; got ${found.map((c) => c.id).join(", ")}`,
    ).toBeDefined();
    expect(match?.level).toBe(level);
  });

  /**
   * ══ The percentage regex that could never match ══
   *
   * The first version was `/\b(\d+\s?%|…)\b/` — a trailing `\b` after `%` requires a word
   * character, so `10% of money` never matched and the rule was dead on every prompt stating
   * a fee as a percentage.
   */
  it.each(["10%", "10 %", "we take 10% of inflow", "a 2.5% cut"])(
    "matches the percentage in %s",
    (prompt) => {
      expect(
        impliedCapabilities(prompt).map((c) => c.id),
        "a trailing \\b after % can never match",
      ).toContain("fee-arithmetic-is-visible");
    },
  );

  /**
   * ══ Persistence is implied by per-user state, not by the word "enrol" ══
   *
   * The first version keyed on enrol/register/subscribe. The measured prompt said "users use
   * as a service" and never used any of them, so the rule missed the project whose persistence
   * was missing.
   */
  it.each([
    "a service that users use for their tokens",
    "each user pays their own costs",
    "every user gets a dashboard",
    "users can bring any token",
    "a cost for each user",
  ])("implies persistence from %s, without the word enrol", (prompt) => {
    expect(impliedCapabilities(prompt).map((c) => c.id)).toContain("state-outlives-a-reload");
  });

  it("quotes the phrase that triggered each capability", () => {
    const found = impliedCapabilities("users bring their pons token to the service");
    const match = found.find((c) => c.id === "user-supplies-identifier");
    expect(match?.source).toContain("their pons token");
  });

  /** A prompt with no product words implies nothing, and that is honest rather than a pass. */
  it("implies nothing from a prompt about nothing", () => {
    expect(impliedCapabilities("hello")).toHaveLength(0);
  });

  /** Every entry in the table must itself be checkable, or it can never fail. */
  it("ships no rule that cannot fail", () => {
    const everyRule = impliedCapabilities(
      "users bring their token, each user funds it, we take 10% of fees, " +
        "a keeper runs on a schedule, with a web dashboard",
    );
    expect(everyRule.length).toBeGreaterThanOrEqual(6);
    for (const rule of everyRule) {
      const verdict = isCheckable(rule);
      expect(verdict.ok, `${rule.id}: ${verdict.ok === false ? verdict.detail : ""}`).toBe(true);
    }
  });
});

describe("compiling a model-supplied pattern", () => {
  it("compiles a valid pattern", () => {
    expect(compileTarget("onChange|onInput")).toBeDefined();
  });

  /** Untrusted input: an invalid pattern must return undefined, never throw. */
  it.each(["([unclosed", "a{2,1}", "(?<"])(
    "returns undefined for %s rather than throwing",
    (bad) => {
      expect(compileTarget(bad)).toBeUndefined();
    },
  );

  it("matches case-insensitively, so DATABASE_URL and database_url both count", () => {
    expect(compileTarget("database_url")?.test("const x = DATABASE_URL")).toBe(true);
  });
});

/**
 * ══ The explains-itself trigger keyed on "web" and missed every real case ══
 *
 * Measured against five prompts that plainly describe a user-facing product: ALL FIVE missed.
 * The rule that exists to catch an unexplained interface fired on none of the prompts most
 * likely to produce one.
 */
describe("a product with a human in it needs an explanation", () => {
  it.each([
    "a cashback agent that users use as a service for their tokens",
    "let holders claim their rewards",
    "a terminal for traders to watch their positions",
    "users connect and stake their tokens",
    "a place where creators enrol tokens",
    "anyone can mint",
    "somewhere people browse listings",
  ])("implies explains-itself from %s, which never says 'web'", (prompt) => {
    expect(
      impliedCapabilities(prompt).map((capability) => capability.id),
      "a rule keyed on the word 'web' misses every prompt that describes a user instead",
    ).toContain("explains-itself");
  });

  /**
   * The other direction matters as much: a headless job has no interface to explain, and
   * demanding a heading from a cron would be the kind of false positive that gets a rule
   * deleted.
   */
  it.each([
    "an indexer that writes logs to postgres",
    "a cron that reconciles balances nightly",
    "a library for decoding calldata",
  ])("does not demand an explanation from %s", (prompt) => {
    expect(impliedCapabilities(prompt).map((capability) => capability.id)).not.toContain(
      "explains-itself",
    );
  });
});

/**
 * ══ Value moving, not fee vocabulary ══
 *
 * `custody-is-explicit` listed fee|deposit|treasury|payout|cashback|revenue|custody|escrow.
 * Measured: a bridge and a swap both MISSED, and both move a user's funds.
 *
 * Not hypothetical. `~/work/arcway/` is a USDC bridge whose first commit was 214 files and
 * 35,934 lines with **zero .sol files** — the router arrived a day later, only because
 * Ibrahim asked. A cashback service did the same. Two of two projects shipped a first version
 * with no contracts and no stated custody model.
 */
describe("a product that moves value must state who holds it", () => {
  it.each([
    "a bridge from Base to Arc for USDC over CCTP v2",
    "let people swap tokens on base",
    "a vault where users deposit and earn yield",
    "a launchpad that mints tokens",
    "users stake and claim rewards",
    "a cashback agent for their pons tokens creator fees",
    "somewhere to lend and borrow",
    "a page to buy and sell",
  ])("implies custody-is-explicit from %s", (prompt) => {
    expect(
      impliedCapabilities(prompt).map((capability) => capability.id),
      "a product moving user funds did not have to state its trust model",
    ).toContain("custody-is-explicit");
  });

  /**
   * A read-only product holds nothing, and demanding a custody statement from an indexer is
   * the kind of false positive that gets a rule deleted.
   */
  it.each([
    "an indexer that writes logs to postgres",
    "a block explorer showing recent blocks",
    "a documentation site for our api",
    "a dashboard showing chain stats",
  ])("does not demand a custody statement from %s", (prompt) => {
    expect(impliedCapabilities(prompt).map((capability) => capability.id)).not.toContain(
      "custody-is-explicit",
    );
  });
});

/**
 * ══ State that outlives a request, not only state that belongs to a user ══
 *
 * The persistence rule was widened once already, from enrol|register|subscribe to per-user
 * state. It still missed a bridge showing transfer status — which has state to keep and names
 * no user at all. Arcway is exactly that, and its Postgres arrived a day after the first
 * commit.
 */
describe("state that has to outlive a request", () => {
  it.each([
    "a bridge from Base to Arc for USDC, users see transfer status",
    "a place to see your order history",
    "shows pending transactions",
    "track your positions",
    "a queue of transfers in transit",
  ])("implies persistence from %s", (prompt) => {
    expect(impliedCapabilities(prompt).map((capability) => capability.id)).toContain(
      "state-outlives-a-reload",
    );
  });

  /**
   * ══ Honest about what it still misses ══
   *
   * A bare "a bridge over CCTP v2" says nothing about remembering anything, so the rule stays
   * silent. Pinned as a KNOWN limit rather than left to be discovered as a bug: widening far
   * enough to catch it would fire on every prompt.
   */
  it("stays silent on a bare bridge prompt, which is a known limit", () => {
    expect(
      impliedCapabilities("a bridge from Base to Arc for USDC over CCTP v2").map(
        (capability) => capability.id,
      ),
      "if this now fires, the rule was widened and this test should be updated deliberately",
    ).not.toContain("state-outlives-a-reload");
  });
});

/**
 * ══ `/` is the marketing page, not the app ══
 *
 * `explains-itself` asks whether SOME page explains the product. This asks whether the page a
 * stranger lands on does — different questions, and a product can pass the first while failing
 * this one.
 *
 * Measured: a deployed service rendered 388 characters at `/`, every one a label or a number,
 * and `explains-itself` passed on it once a heading existed.
 */
describe("the landing page a stranger arrives on", () => {
  it.each([
    "a web app where users connect and stake",
    "a dashboard for traders",
    "let holders claim their rewards",
    "a terminal anyone can use",
  ])("is required for %s", (prompt) => {
    expect(impliedCapabilities(prompt).map((capability) => capability.id)).toContain(
      "landing-page-explains-the-product",
    );
  });

  /** A headless job has no page to land on. */
  it.each(["an indexer that writes logs to postgres", "a cron that reconciles balances nightly"])(
    "is not required for %s",
    (prompt) => {
      expect(impliedCapabilities(prompt).map((capability) => capability.id)).not.toContain(
        "landing-page-explains-the-product",
      );
    },
  );

  it("is required, not merely expected", () => {
    const found = impliedCapabilities("a web app where users connect").find(
      (capability) => capability.id === "landing-page-explains-the-product",
    );
    expect(found?.level).toBe("required");
  });

  /**
   * A longer sentence than `explains-itself` asks of any page: 20 words against 12. A landing
   * page carries more than a screen does, and the measured failure had 388 characters at `/`
   * without one sentence.
   */
  it("asks for a longer sentence than a generic page does", () => {
    const found = impliedCapabilities("a web app where users connect").find(
      (capability) => capability.id === "landing-page-explains-the-product",
    );
    const prose = found?.evidence.find((piece) => piece.kind === "prose");
    expect(prose?.target).toBe("20");
  });

  /** The app must live somewhere other than `/`, or `/` is the app wearing a label. */
  it("requires the app to live somewhere other than the root", () => {
    const found = impliedCapabilities("a web app where users connect").find(
      (capability) => capability.id === "landing-page-explains-the-product",
    );
    const path = found?.evidence.find((piece) => piece.kind === "path");
    expect(path, "nothing checks that the app is not simply at /").toBeDefined();
    expect(path?.target).toContain("app");
  });

  it("checks `/` specifically, not whichever route happened to render", () => {
    const found = impliedCapabilities("a web app where users connect").find(
      (capability) => capability.id === "landing-page-explains-the-product",
    );
    expect(found?.evidence.find((piece) => piece.kind === "route")?.target).toBe("/");
  });
});
