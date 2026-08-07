/**
 * Runner tests, driven against a fake page and a real Anvil.
 *
 * The page is faked so UI failures can be staged deliberately; the CHAIN is real, because
 * the whole value of this runner is that it asserts on-chain deltas rather than DOM state.
 */
import { chromium } from "playwright";
import { createTestClient, http, parseEther, publicActions, walletActions } from "viem";
import { foundry } from "viem/chains";
import { beforeAll, describe, expect, it } from "vitest";
import { EXAMPLE_MANIFEST } from "./manifest.js";
import { buildExpectations, buildProbes, type RunnerPage, runFlow, runStep } from "./runner.js";
import { ANVIL_ACCOUNT } from "./wallet.js";

const SECOND = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const client = createTestClient({
  chain: foundry,
  mode: "anvil",
  transport: http("http://127.0.0.1:8545"),
})
  .extend(publicActions)
  .extend(walletActions);

let anvilUp = false;
beforeAll(async () => {
  try {
    await client.getBlockNumber();
    anvilUp = true;
  } catch {
    anvilUp = false;
  }
});

/** A page that records what it was asked to do, and can be told to fail a step. */
function fakePage(options: { failOn?: string } = {}) {
  const actions: string[] = [];
  const chapters: string[] = [];

  const locator = (label: string) => ({
    async click() {
      if (options.failOn === label) throw new Error(`no element matched ${label}`);
      actions.push(`click:${label}`);
    },
    async fill(value: string) {
      if (options.failOn === label) throw new Error(`no element matched ${label}`);
      actions.push(`fill:${label}=${value}`);
    },
    async waitFor() {
      if (options.failOn === label) throw new Error(`${label} never became visible`);
      actions.push(`wait:${label}`);
    },
  });

  const page: RunnerPage = {
    async goto(url: string) {
      actions.push(`goto:${url}`);
      return undefined;
    },
    getByRole(role: string, opts?: { name?: string | RegExp }) {
      return locator(`${role}/${String(opts?.name ?? "")}`);
    },
    screencast: {
      async showChapter(title: string) {
        chapters.push(title);
      },
    },
  };

  return { page, actions, chapters };
}

describe("buildProbes", () => {
  it("builds a live probe for every declared kind", () => {
    const probes = buildProbes([
      { kind: "nativeBalance", label: "eth", address: ANVIL_ACCOUNT },
      { kind: "tokenBalance", label: "tok", token: ANVIL_ACCOUNT, holder: SECOND },
      { kind: "totalSupply", label: "sup", token: ANVIL_ACCOUNT },
      { kind: "nftBalance", label: "nft", collection: ANVIL_ACCOUNT, holder: SECOND },
      { kind: "uint", label: "prog", contract: ANVIL_ACCOUNT, getter: "progress" },
    ]);
    expect(probes.map((p) => p.label)).toEqual(["eth", "tok", "sup", "nft", "prog"]);
  });

  /**
   * ══ A probe kind the code does not know ══
   *
   * The `default` arm is unreachable through the TypeScript union, and that is exactly
   * why it needs a test: a manifest is JSON read off disk, entirely outside the type
   * system. A generator emitting `"kind": "erc1155Balance"` — or simply a typo like
   * `"totalSuply"` — produces a value TypeScript believes cannot exist.
   *
   * Without the throw, `switch` falls through and `buildProbes` returns `[undefined]`.
   * That is the worst possible outcome: `snapshot` would then fail on
   * `undefined.read`, or worse, a silently absent probe means the expectation naming it
   * reports "no probe named X" — a message pointing at the expectation when the real
   * fault is the probe. Failing here names the actual offender.
   *
   * The message must include the offending object, since "unknown probe kind" alone does
   * not say which of a dozen probes in a manifest is wrong.
   */
  it("throws on an unknown probe kind rather than yielding undefined", () => {
    const rogue = { kind: "erc1155Balance", label: "nope", token: ANVIL_ACCOUNT };

    expect(() => buildProbes([rogue as never])).toThrow(/unknown probe kind/);
    // The whole spec is echoed, so the bad entry is identifiable in a large manifest.
    expect(() => buildProbes([rogue as never])).toThrow(/erc1155Balance/);
    expect(() => buildProbes([rogue as never])).toThrow(/nope/);
  });
});

describe("buildExpectations", () => {
  it("converts string amounts to bigint, since JSON has no bigint", () => {
    const out = buildExpectations([
      { probe: "a", expect: "increased" },
      { probe: "b", expect: "exactly", by: "1000000000000000000" },
      { probe: "c", expect: "atLeast", by: "-5" },
    ]);
    expect(out.a).toEqual({ kind: "increased" });
    expect(out.b).toEqual({ kind: "exactly", by: 1_000_000_000_000_000_000n });
    expect(out.c).toEqual({ kind: "atLeast", by: -5n });
  });

  it("refuses exactly/atLeast without an amount", () => {
    expect(() => buildExpectations([{ probe: "a", expect: "exactly" }])).toThrow(/without a "by"/);
  });
});

describe("runStep", () => {
  it("targets by accessible role and name, never a selector", async () => {
    const { page, actions } = fakePage();
    await runStep(page, { action: "click", role: "button", name: "Mint" });
    await runStep(page, { action: "fill", role: "textbox", name: "Amount", value: "5" });
    expect(actions).toEqual(["click:button/Mint", "fill:textbox/Amount=5"]);
  });

  it("narrates chapters without asserting anything", async () => {
    const { page, chapters, actions } = fakePage();
    await runStep(page, {
      action: "chapter",
      title: "Connect wallet",
      description: "over EIP-6963",
    });
    expect(chapters).toEqual(["Connect wallet"]);
    expect(actions, "a chapter is narration, not an assertion").toEqual([]);
  });

  /** A page with no recorder must still run — video is optional, the flow is not. */
  it("skips narration silently when no video is being recorded", async () => {
    const { page } = fakePage();
    const noVideo: RunnerPage = { goto: page.goto, getByRole: page.getByRole };
    await expect(runStep(noVideo, { action: "chapter", title: "x" })).resolves.toBeUndefined();
  });

  /**
   * ══ expectText, which had never been dispatched ══
   *
   * `expectText` is the only step that does not take a role from the manifest: it asserts
   * on a `status` region specifically, because "the app told the user something" is a
   * different claim from "an element with this text exists somewhere". A `<div>` of
   * matching text in a hidden template would satisfy the latter and not the former.
   *
   * Two things must hold, and both are asserted rather than just "it did not throw":
   * the lookup is scoped to role `status`, and the text is used as the accessible NAME —
   * not as a selector.
   */
  it("resolves expectText against the status role, not an arbitrary element", async () => {
    const { page, actions } = fakePage();
    await runStep(page, { action: "expectText", text: "Order confirmed" });
    expect(actions).toEqual(["wait:status/Order confirmed"]);
  });
});

/**
 * ══ Perceivability when the page cannot be interrogated ══
 *
 * `assertPerceivable` is deliberately a two-tier check, and both tiers had gone
 * unexercised. The distinction between them is subtle and easy to get backwards, so it is
 * pinned here.
 */
describe("assertPerceivable degradation", () => {
  /**
   * A page WITHOUT `evaluate` degrades to Playwright's own visibility check.
   *
   * This is what lets the whole package be unit-tested with a hand-rolled double, and
   * keeps a consumer passing a minimal page object from crashing. The weaker check is a
   * deliberate, documented trade — real Playwright always has `evaluate`, so production
   * runs never take this path.
   *
   * The assertion that makes this meaningful is that `waitFor` still ran: degrading must
   * mean "a weaker assertion", never "no assertion". A `return` placed before the
   * `waitFor` would silently turn expectVisible into a no-op, and this catches that.
   */
  it("falls back to waitFor when the page cannot evaluate scripts", async () => {
    const { page, actions } = fakePage();
    const noEval: RunnerPage = { goto: page.goto, getByRole: page.getByRole };

    await expect(
      runStep(noEval, { action: "expectVisible", role: "status", name: "Confirmed" }),
    ).resolves.toBeUndefined();

    // The weaker check still ran — degradation is not omission.
    expect(actions).toEqual(["wait:status/Confirmed"]);
  });

  /**
   * ══ The failure mode this module exists to prevent, in its own implementation ══
   *
   * A page that HAS `evaluate` but returns `undefined` from it must fail, never pass.
   *
   * This is not hypothetical — it is measured, and recorded in the module docs:
   * `locator.evaluate` with a string body, `handle.evaluate` with a string body, and
   * `page.evaluate(string, handle)` ALL silently return `undefined`. If a future
   * refactor reaches for any of those, every `expectVisible` in every flow starts
   * returning `undefined` and the entire perceivability check evaporates — while the
   * suite stays green.
   *
   * `waitFor` has already proven the element exists by this point, so `undefined` cannot
   * mean "not found". It can only mean the check itself did not run, and treating a
   * check that did not run as a passing check is the exact category of bug this package
   * was built to catch.
   */
  it("throws when the perceivability script returns undefined instead of passing", async () => {
    const { page } = fakePage();
    const blindPage: RunnerPage = {
      goto: page.goto,
      getByRole: page.getByRole,
      // Exactly what a string-body evaluate on the wrong Playwright API yields.
      evaluate: async () => undefined,
    };

    await expect(
      runStep(blindPage, { action: "expectVisible", role: "status", name: "Confirmed" }),
      "a check that did not run must never be read as a pass",
    ).rejects.toThrow(/the check did not run/);

    // The message names which element, so it is actionable in a multi-step flow.
    await expect(
      runStep(blindPage, { action: "expectVisible", role: "status", name: "Confirmed" }),
    ).rejects.toThrow(/status "Confirmed"/);
  });

  /** The control: a script reporting perceivable must still pass, or the above is vacuous. */
  it("passes when the script reports the element is perceivable", async () => {
    const { page } = fakePage();
    const seeing: RunnerPage = {
      goto: page.goto,
      getByRole: page.getByRole,
      evaluate: async () => ({ perceivable: true, failures: [] }),
    };
    await expect(
      runStep(seeing, { action: "expectVisible", role: "status", name: "Confirmed" }),
    ).resolves.toBeUndefined();
  });
});

describe("runFlow", () => {
  it("asserts a REAL on-chain delta, not just that the UI clicked", async () => {
    if (!anvilUp) return expect(anvilUp, "anvil must be running").toBe(true);

    const { page } = fakePage();
    const before = await client.getBalance({ address: SECOND });

    // The "UI" step actually moves value, standing in for a real app action.
    const flow = {
      name: "transfer",
      path: "/",
      probes: [{ kind: "nativeBalance" as const, label: "receiver", address: SECOND }],
      steps: [
        { action: "chapter" as const, title: "Send value" },
        { action: "click" as const, role: "button" as const, name: "Send" },
      ],
      expectations: [{ probe: "receiver", expect: "increased" as const }],
    };

    // Drive the chain between snapshots by wrapping goto.
    const driving: RunnerPage = {
      ...page,
      async goto(url: string) {
        await page.goto(url);
        const hash = await client.sendTransaction({
          account: ANVIL_ACCOUNT,
          to: SECOND,
          value: parseEther("2"),
          chain: foundry,
        });
        await client.waitForTransactionReceipt({ hash });
        return undefined;
      },
    };

    const result = await runFlow({ page: driving, client, flow, baseUrl: "http://app" });

    expect(result.ok, result.report).toBe(true);
    expect(await client.getBalance({ address: SECOND })).toBe(before + parseEther("2"));
    expect(result.report).toMatch(/receiver/);
  });

  /**
   * The failure that matters most: the UI worked, and the chain did not move. A test that
   * only checked the DOM would call this a pass.
   */
  it("fails when the UI succeeds but the chain did not change", async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);

    const { page } = fakePage();
    const flow = {
      name: "does-nothing",
      path: "/",
      probes: [{ kind: "nativeBalance" as const, label: "receiver", address: SECOND }],
      steps: [{ action: "click" as const, role: "button" as const, name: "Send" }],
      expectations: [{ probe: "receiver", expect: "increased" as const }],
    };

    const result = await runFlow({ page, client, flow, baseUrl: "http://app" });

    expect(
      result.steps.every((s) => s.ok),
      "every UI step passed",
    ).toBe(true);
    expect(result.ok, "but the flow must FAIL — nothing happened on chain").toBe(false);
    expect(result.report).toMatch(/expected an increase/);
  });

  it("skips remaining steps after a failure and says the chain was never checked", async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);

    const { page } = fakePage({ failOn: "button/Mint" });
    const flow = {
      name: "broken",
      path: "/",
      probes: [{ kind: "nativeBalance" as const, label: "receiver", address: SECOND }],
      steps: [
        { action: "click" as const, role: "button" as const, name: "Mint" },
        { action: "click" as const, role: "button" as const, name: "Confirm" },
      ],
      expectations: [{ probe: "receiver", expect: "increased" as const }],
    };

    const result = await runFlow({ page, client, flow, baseUrl: "http://app" });

    expect(result.ok).toBe(false);
    expect(result.steps[1]?.error).toMatch(/skipped after an earlier step failed/);
    expect(result.report).toMatch(/chain state was NOT verified/);
  });

  /**
   * ══ A step that rejects with something that is not an Error ══
   *
   * `error instanceof Error ? error.message : String(error)` had only ever taken the
   * Error arm. The other one is not defensive padding: `throw "..."` from page code,
   * a rejected promise carrying a plain object, and — most commonly — Playwright
   * surfacing a DOMException-like value all arrive here as non-Errors.
   *
   * Reading `.message` off a bare string yields `undefined`, so the step log would record
   * `error: undefined` while `ok: false`. The report then prints a step marked failed with
   * no reason beside it, which is the single least useful thing a failure report can do.
   *
   * The chain must also stay unverified: a UI step that blew up in an unusual way is
   * still a UI step that failed, and the run must not proceed to assert deltas as though
   * the flow had completed.
   */
  it("records a non-Error rejection as text rather than losing the reason", async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);

    const { page } = fakePage();
    const throwsString: RunnerPage = {
      ...page,
      getByRole: () => ({
        // Page code doing `throw "boom"` — a string, not an Error.
        async click(): Promise<void> {
          throw "Target closed: the page crashed";
        },
        async fill(): Promise<void> {},
        async waitFor(): Promise<void> {},
      }),
    };

    const result = await runFlow({
      page: throwsString,
      client,
      flow: {
        name: "string-throw",
        path: "/",
        probes: [{ kind: "nativeBalance" as const, label: "receiver", address: SECOND }],
        steps: [{ action: "click" as const, role: "button" as const, name: "Send" }],
        expectations: [{ probe: "receiver", expect: "increased" as const }],
      },
      baseUrl: "http://app",
    });

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.error, "a thrown string must reach the log, not become undefined").toBe(
      "Target closed: the page crashed",
    );
    expect(result.report).toContain("Target closed: the page crashed");
    expect(result.report).toMatch(/chain state was NOT verified/);
  });

  /**
   * ══ How a chapter step is labelled in the report ══
   *
   * The report builder branches three ways on a step, and only the middle arm had ever
   * rendered — every prior report test either failed before reaching a chapter or had
   * none. All three appear in this one flow:
   *
   *   - `chapter`     → labelled by its title
   *   - anything with a `name` → `action role "name"`
   *   - `expectText`  → labelled by its action alone, having neither role nor name
   *
   * Each fallback exists because the alternative renders `undefined`. A chapter has no
   * `role` and no `name`, so the generic arm would print `undefined undefined` beside it;
   * `expectText` carries a `text` rather than a `name`, so the middle arm would do the
   * same. The report is the handoff artifact a human reads to understand what the run
   * did, and a step rendering as `undefined` makes the whole document look broken.
   */
  it("labels every step shape without rendering undefined", async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);

    const { page } = fakePage();
    const result = await runFlow({
      page,
      client,
      flow: {
        name: "narrated",
        path: "/",
        probes: [{ kind: "nativeBalance" as const, label: "receiver", address: SECOND }],
        steps: [
          { action: "chapter" as const, title: "Connect wallet" },
          { action: "click" as const, role: "button" as const, name: "Send" },
          // Neither a chapter nor a `name`-bearing step — the third label arm.
          { action: "expectText" as const, text: "Order confirmed" },
        ],
        // Nothing moves, so the flow fails on chain — but every UI step ran and is logged.
        expectations: [{ probe: "receiver", expect: "unchanged" as const }],
      },
      baseUrl: "http://app",
    });

    expect(result.ok, result.report).toBe(true);
    expect(result.report).toContain('✓ chapter "Connect wallet"');
    expect(result.report).toContain('✓ click button "Send"');
    // The bare-action arm: no role, no name, and no `undefined` filling their place.
    expect(result.report).toContain("✓ expectText");
    expect(result.report).not.toContain('expectText undefined "undefined"');
    expect(result.report, "no step may render as undefined").not.toContain("undefined");
  });

  /**
   * A manifest naming a contract that does not exist must fail loudly at snapshot time, not
   * silently report zeroes and then "pass" an unchanged assertion.
   *
   * ══ WHY THE ADDRESS IS OVERRIDDEN RATHER THAN INHERITED ══
   *
   * This used to run `EXAMPLE_MANIFEST.flows[0]` unmodified, whose token probes point at
   * `0x5FbDB2315678afecb367f032d93F642f64180aa3`. That is not an arbitrary address: it is the
   * address Anvil deterministically assigns to the FIRST contract deployed by the default
   * account. `onchain.test.ts` and `fullstack.test.ts` share this Anvil and both deploy, so
   * whether this test passed depended on whether a sibling file had run first — it passed
   * alone and failed in a full run, which is exactly backwards from what a suite should do.
   *
   * The premise is "no contract at this address", so the test now STATES that premise and
   * asserts it, instead of hoping the chain happens to be in the right state. The address
   * below is derived from this test's own name and can never be a deployment target.
   */
  it("fails loudly when a manifest names a contract that is not deployed", async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);
    const { page } = fakePage();
    const template = EXAMPLE_MANIFEST.flows[0];
    if (!template) throw new Error("example manifest must declare a flow");

    // An address nothing deploys to, so the "not deployed" premise holds under any run order.
    const ABSENT = "0x00000000000000000000000000000000deadbeef" as const;
    expect(
      await client.getCode({ address: ABSENT }),
      "the premise of this test is that nothing is deployed here",
    ).toBeUndefined();

    const flow = {
      ...template,
      probes: template.probes.map((p) => ("token" in p ? { ...p, token: ABSENT } : p)),
    };

    await expect(
      runFlow({ page, client, flow, baseUrl: "http://app" }),
      "a missing contract must throw, never silently read as zero",
    ).rejects.toThrow();
  });
});

/**
 * `expectVisible` must mean "a human could see it", not Playwright's weaker "has a box".
 *
 * Measured in a real Chromium: `isVisible()` is `true` for an element at `left:-9999px`,
 * at `opacity:0`, clipped by `clip-path:inset(100%)`, and fully behind an opaque overlay.
 * A flow asserting `expectVisible` on any of those used to pass while the user saw
 * nothing. These drive the real runner against a real browser to prove it no longer does.
 */
describe("expectVisible in a real browser", () => {
  const PAGE = `<!doctype html>
    <style>
      body{margin:0;font:16px system-ui}
      #cover{position:absolute;top:0;left:0;width:300px;height:60px;background:#fff;z-index:2}
      #hidden-status{position:absolute;top:10px;left:10px;z-index:1}
      #real-status{margin-top:100px}
    </style>
    <div role="status" id="hidden-status" aria-label="Order confirmed">Order confirmed</div>
    <div id="cover"></div>
    <div role="status" id="real-status" aria-label="Genuinely shown">Genuinely shown</div>`;

  async function withPage<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(PAGE);
      return await fn(page);
    } finally {
      await browser.close();
    }
  }

  it("rejects a status message hidden behind an overlay", { timeout: 60_000 }, async () => {
    await withPage(async (page) => {
      // Playwright itself is satisfied — this is precisely the hole.
      expect(await page.locator("#hidden-status").isVisible()).toBe(true);

      await expect(
        runStep(page as unknown as RunnerPage, {
          action: "expectVisible",
          role: "status",
          name: "Order confirmed",
        }),
        "an occluded status must fail expectVisible",
      ).rejects.toThrow(/NOT perceivable/);
    });
  });

  it("still passes a status message that is genuinely shown", { timeout: 60_000 }, async () => {
    // Without this, the check could 'pass' the test above by rejecting everything.
    await withPage(async (page) => {
      await expect(
        runStep(page as unknown as RunnerPage, {
          action: "expectVisible",
          role: "status",
          name: "Genuinely shown",
        }),
      ).resolves.toBeUndefined();
    });
  });
});
