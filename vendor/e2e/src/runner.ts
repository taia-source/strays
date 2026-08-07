/**
 * Turns a manifest into an executed flow, with on-chain assertions and a narrated video.
 *
 * Playwright is typed structurally rather than imported, so this package does not force
 * Playwright on every consumer and can be unit-tested without a browser. The consuming
 * project passes its real `page`.
 */

import type { ChainExpectation, Flow, FlowStep, ProbeSpec } from "./manifest.js";
import type { ChainClient, Expectation, StateProbe } from "./onchain.js";
import {
  assertDeltas,
  formatDeltas,
  nativeBalance,
  nftBalance,
  readsUint,
  snapshot,
  tokenBalance,
  totalSupply,
} from "./onchain.js";
import {
  describeFailures,
  type PerceivableFailure,
  perceivableByRoleScript,
} from "./perceivable.js";

/** The slice of Playwright's `Page` this runner uses. */
export type RunnerPage = {
  goto(url: string): Promise<unknown>;
  getByRole(role: string, options?: { name?: string | RegExp }): Locator;
  /**
   * Optional, and only used to strengthen `expectVisible`. When absent, that step falls
   * back to Playwright's own (weaker) notion of visible — see `assertPerceivable`.
   */
  evaluate?: (script: string, arg?: unknown) => Promise<unknown>;
  screencast?: {
    showChapter(
      title: string,
      options?: { description?: string; duration?: number },
    ): Promise<void>;
  };
};

export type Locator = {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  waitFor(options?: { state?: "visible" | "attached" }): Promise<void>;
};

/** Build the live probes a flow declared. */
export function buildProbes(specs: readonly ProbeSpec[]): StateProbe[] {
  return specs.map((spec) => {
    switch (spec.kind) {
      case "nativeBalance":
        return nativeBalance(spec.address, spec.label);
      case "tokenBalance":
        return tokenBalance(spec.token, spec.holder, spec.label);
      case "totalSupply":
        return totalSupply(spec.token, spec.label);
      case "nftBalance":
        return nftBalance(spec.collection, spec.holder, spec.label);
      case "uint":
        return readsUint({ contract: spec.contract, getter: spec.getter, label: spec.label });
      default:
        // Unreachable while the union is exhaustive, but a manifest is JSON from outside
        // the type system — an unknown kind must fail loudly rather than yield undefined.
        throw new Error(`unknown probe kind: ${JSON.stringify(spec)}`);
    }
  });
}

/** Manifest expectations (JSON, string amounts) → runtime expectations (bigint). */
export function buildExpectations(
  expectations: readonly ChainExpectation[],
): Record<string, Expectation> {
  const out: Record<string, Expectation> = {};
  for (const e of expectations) {
    switch (e.expect) {
      case "increased":
      case "decreased":
      case "unchanged":
        out[e.probe] = { kind: e.expect };
        break;
      case "exactly":
      case "atLeast":
        if (e.by === undefined) {
          throw new Error(`expectation on "${e.probe}" uses ${e.expect} without a "by" amount`);
        }
        out[e.probe] = { kind: e.expect, by: BigInt(e.by) };
        break;
    }
  }
  return out;
}

/**
 * Strengthen a `waitFor({ state: "visible" })` into "a human could actually see this".
 *
 * Measured, in a real Chromium: Playwright reports `isVisible() === true` for an element
 * at `left:-9999px`, at `opacity:0`, removed by `clip-path:inset(100%)`, and fully behind
 * an opaque overlay. Its definition is "has a box and is not `visibility:hidden`". So
 * `expectVisible` alone could pass on a success message no user can see — the assertion
 * meant to prove the UI works being the one that lies.
 *
 * ── Why this goes through `page.evaluate` and a role lookup ──
 *
 * The obvious implementation is `locator.evaluate(SCRIPT)`. It silently returns
 * `undefined`. Measured across every variant: `locator.evaluate` with a string body,
 * `handle.evaluate` with a string body, and `page.evaluate(string, handle)` ALL yield
 * `undefined` — string-form functions are only honoured by `page.evaluate` when the
 * script is self-contained and takes no element argument. Since this package injects
 * scripts as strings (so it needs no browser to be unit-tested), the element has to be
 * re-found inside the page rather than passed in.
 *
 * Degrades rather than breaks: a page without `evaluate` (a hand-rolled test double)
 * keeps the old behaviour. Real Playwright always has it.
 */
export async function assertPerceivable(
  page: RunnerPage,
  role: string,
  name: string,
): Promise<void> {
  if (typeof page.evaluate !== "function") return;

  const label = `${role} "${name}"`;
  const raw = (await page.evaluate(perceivableByRoleScript(role, name))) as
    | { perceivable: boolean; failures: readonly PerceivableFailure[]; topElementAtCentre?: string }
    | undefined;

  // A script that could not resolve the element must not be read as a pass. `waitFor`
  // already proved it exists, so `undefined` here means the check itself failed to run —
  // silently treating that as success is the exact failure mode this module exists for.
  if (!raw) {
    throw new Error(`could not evaluate perceivability for ${label} — the check did not run`);
  }
  if (raw.perceivable) return;

  throw new Error(
    describeFailures({
      selector: label,
      failures: raw.failures,
      topElementAtCentre: raw.topElementAtCentre,
    }),
  );
}

export type StepLog = { readonly step: FlowStep; readonly ok: boolean; readonly error?: string };

/**
 * Execute one step.
 *
 * `chapter` is narration for the video and asserts nothing — it exists so the handoff
 * artifact explains itself rather than being a silent screen recording. Everything else
 * targets by **accessible role and name**, never a CSS selector, so an agent redesigning
 * the UI does not break the test.
 */
export async function runStep(page: RunnerPage, step: FlowStep): Promise<void> {
  switch (step.action) {
    case "chapter":
      // Optional: only present when a video is being recorded.
      await page.screencast?.showChapter(
        step.title,
        step.description ? { description: step.description } : undefined,
      );
      return;
    case "click":
      await page.getByRole(step.role, { name: step.name }).click();
      return;
    case "fill":
      await page.getByRole(step.role, { name: step.name }).fill(step.value);
      return;
    case "expectVisible": {
      const locator = page.getByRole(step.role, { name: step.name });
      await locator.waitFor({ state: "visible" });
      await assertPerceivable(page, step.role, step.name);
      return;
    }
    case "expectText":
      await page.getByRole("status", { name: step.text }).waitFor({ state: "visible" });
      // Same reasoning as expectVisible: a status the user cannot see is not a status.
      await assertPerceivable(page, "status", step.text);
      return;
  }
}

export type FlowResult = {
  readonly flow: string;
  readonly ok: boolean;
  readonly steps: readonly StepLog[];
  /** Present unless the flow failed before the chain could be re-read. */
  readonly chain?: ReturnType<typeof assertDeltas>;
  readonly report: string;
};

/**
 * Run a flow: snapshot the chain, drive the UI, re-snapshot, assert the delta.
 *
 * The chain is captured **before and after** rather than only after, because "supply is
 * 1000" proves nothing — "supply went from 900 to 1000" is the claim worth testing.
 */
export async function runFlow(options: {
  readonly page: RunnerPage;
  readonly client: ChainClient;
  readonly flow: Flow;
  readonly baseUrl: string;
}): Promise<FlowResult> {
  const { page, client, flow, baseUrl } = options;

  const probes = buildProbes(flow.probes);
  const before = await snapshot(client, probes);

  const steps: StepLog[] = [];
  let failed = false;

  await page.goto(`${baseUrl}${flow.path}`);

  for (const step of flow.steps) {
    if (failed) {
      steps.push({ step, ok: false, error: "skipped after an earlier step failed" });
      continue;
    }
    try {
      await runStep(page, step);
      steps.push({ step, ok: true });
    } catch (error) {
      failed = true;
      steps.push({
        step,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failed) {
    return {
      flow: flow.name,
      ok: false,
      steps,
      report: formatFlowReport(flow.name, steps, undefined),
    };
  }

  const after = await snapshot(client, probes);
  const chain = assertDeltas(before, after, buildExpectations(flow.expectations));

  return {
    flow: flow.name,
    ok: chain.ok,
    steps,
    chain,
    report: formatFlowReport(flow.name, steps, chain),
  };
}

function formatFlowReport(
  name: string,
  steps: readonly StepLog[],
  chain: ReturnType<typeof assertDeltas> | undefined,
): string {
  const lines = [`flow: ${name}`];

  for (const s of steps) {
    const label =
      s.step.action === "chapter"
        ? `chapter "${s.step.title}"`
        : "name" in s.step
          ? `${s.step.action} ${s.step.role} "${s.step.name}"`
          : s.step.action;
    lines.push(`  ${s.ok ? "✓" : "✗"} ${label}${s.error ? ` — ${s.error}` : ""}`);
  }

  lines.push("");
  if (!chain) {
    lines.push(
      "  chain state was NOT verified — the UI flow failed first, so nothing was asserted on chain",
    );
  } else {
    lines.push(formatDeltas(chain));
  }

  return lines.join("\n");
}
