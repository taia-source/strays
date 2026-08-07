import { type AnvilInstance, anvilAvailable, startAnvil } from "@taia/tools/anvil";
import { createTestClient, http, publicActions, walletActions } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlockWindow, detectReorg } from "./reorg.js";

/**
 * Reorg handling against a **real reorg**, not a constructed one.
 *
 * ══ Why this file exists ══
 *
 * `reorg.test.ts` builds `BlockRef`s by hand and asserts `detectReorg` classifies them
 * correctly. That tests the *logic* and nothing about the *chain* — every hash in it was
 * written by the same person who wrote the assertion, so it cannot catch a wrong assumption
 * about what a reorg actually does to a node.
 *
 * `anvil_reorg` makes the real thing reachable. Verified before building on it, because the
 * parameter shape is not what viem's typed helpers suggest — it takes **positional** args
 * `[depth, tx_block_pairs]`, and the object form returns "Invalid parameters":
 *
 *   params [2,[]]                        -> OK
 *   params {depth:2, tx_block_pairs:[]}  -> Invalid parameters were provided
 *
 * And it produces a genuine reorg rather than a rewind. Measured, block by block, at
 * `depth: 3` with head 329:
 *
 *   head 329 -> after reorg 329          the HEIGHT is unchanged
 *   block 326: 0xc01717ab -> 0xc01717ab  same      <- common ancestor
 *   block 327: 0x58ba3fef -> 0xdef49c3c  CHANGED
 *   block 328: 0x5512cb0a -> 0xb38e65b7  CHANGED
 *   block 329: 0xfebf0e55 -> 0x062a53a6  CHANGED
 *
 * **The block numbers stayed the same and the hashes changed.** That is exactly the case
 * the whole design rests on — "key events on block hash, never block number, because a
 * reorg reuses the number with different content" — and until now nothing proved a real
 * node behaves that way.
 *
 * The precise semantics, which the first draft of these tests got wrong: `depth: N`
 * rewrites the **top N blocks**, so `head - N` remains canonical and is the common
 * ancestor. Asserting against a block inside the rewritten range is what matters; a test
 * pointed at `head - 1` passes or fails depending on the depth, which is how the first run
 * produced a confusing "hash unchanged" result.
 *
 * ══ Two documented limitations, stated rather than discovered later ══
 *
 * **1. `anvil_reorg` is not reliably repeatable within one node session.** Measured over
 * four consecutive trials on the same node:
 *
 *   trial 1: tip hash changed      trial 3: tip hash changed
 *   trial 2: tip hash UNCHANGED    trial 4: tip hash UNCHANGED
 *
 * It alternates — a reorg leaves the node in a state where the next call is a no-op, and
 * the head number does not advance between paired trials. Wrapping each trial in
 * `evm_snapshot`/`evm_revert` improved it to 3 of 4, not to 4 of 4.
 *
 * So these tests **verify the reorg actually happened before asserting on it**, via
 * `reorgOrSkip`. A test that silently passes when its precondition did not occur is worse
 * than no test: it reports coverage that does not exist. When the precondition fails the
 * test states so explicitly rather than passing quietly.
 *
 * **2. There is an open upstream bug (alloy#3116, filed 2025-10-31)** where logs from
 * transactions passed via `tx_block_pairs` cannot be fetched after the reorg executes. So
 * an indexer could appear to handle a reorg correctly while the logs it needs are absent.
 * These tests therefore drive the reorg with `tx_block_pairs: []` and assert on **block
 * identity**, which is unaffected — the layer `BlockWindow` actually depends on.
 */

/**
 * A PRIVATE anvil for this file.
 *
 * The first attempt at these tests shared the repo-wide node. `anvil_reorg` rewrites
 * history — it keeps the height and replaces block hashes — so it silently rewrote the
 * blocks other suites were mid-assertion on. The result was 1-in-6 flaky here and broke
 * `@taia/e2e` outright, so the file was parked rather than shipped.
 *
 * With its own instance (~40ms to start, OS-assigned port) the reorg cannot reach anything
 * else, and these tests become deterministic.
 */
let anvil: AnvilInstance | undefined;
let client: ReturnType<typeof makeClient>;

function makeClient(rpcUrl: string) {
  // cacheTime 0 is load-bearing, not tidiness. viem caches block reads, and a reorg
  // REUSES the block number with different content — so a cached read returns the
  // pre-reorg hash and the test concludes "no reorg happened" when one did. Measured: the
  // same sequence driven with raw fetch reorged on the first attempt while the cached
  // client reported UNCHANGED indefinitely.
  return createTestClient({
    chain: foundry,
    mode: "anvil",
    transport: http(rpcUrl),
    cacheTime: 0,
  })
    .extend(publicActions)
    .extend(walletActions);
}

let anvilUp = false;

beforeAll(async () => {
  const unavailable = await anvilAvailable();
  // A missing binary must be loud. A silent skip here would report coverage of the single
  // most important indexer invariant while testing nothing.
  expect(unavailable, unavailable ?? "").toBeUndefined();

  anvil = await startAnvil();
  client = makeClient(anvil.rpcUrl);

  // A private node starts at block 0. The shared node always had history lying around,
  // which silently hid the fact that these tests assume some — `head - 3n` underflows at
  // genesis. Establish a floor once so each test can reorg beneath its own blocks.
  await client.request({ method: "anvil_mine", params: [32] } as never);
  expect(await client.getBlockNumber()).toBeGreaterThan(30n);
  anvilUp = true;
}, 60_000);

afterAll(async () => {
  await anvil?.stop();
});

/** Read a block as the `BlockRef` the window stores. */
async function refAt(blockNumber: bigint) {
  const block = await client.getBlock({ blockNumber });
  return { number: block.number, hash: block.hash, parentHash: block.parentHash };
}

/**
 * Trigger a reorg and confirm it actually took effect.
 *
 * Returns the pre-reorg tip hash when the chain genuinely changed, and `undefined` when
 * `anvil_reorg` was a no-op — which it is on roughly every other call. Callers must treat
 * `undefined` as "precondition not met" and say so, never as a pass.
 */
async function reorgOrSkip(depth: number, attempts = 5): Promise<`0x${string}` | undefined> {
  for (let i = 0; i < attempts; i++) {
    const head = await client.getBlockNumber();
    const before = (await refAt(head)).hash;
    await client.request({ method: "anvil_reorg", params: [depth, []] } as never);
    if ((await refAt(head)).hash !== before) return before;
    await mine(depth + 1);
  }
  return undefined;
}

/**
 * Build a window over the pre-reorg chain, reorg, and return both — atomically enough that
 * the window always describes the chain the reorg acted on.
 *
 * The first version captured the window *before* calling `reorgOrSkip`, which retries by
 * mining fresh blocks. On a retry the window then described a chain that no longer existed,
 * and the test failed roughly 1 run in 3. A flaky test is worse than no test: it trains
 * people to re-run until green. Capturing inside the retry loop removes the race entirely.
 */
async function windowThenReorg(
  span: bigint,
  depth: number,
  capacity = 16,
): Promise<{ window: BlockWindow; head: bigint } | undefined> {
  for (let i = 0; i < 5; i++) {
    const head = await client.getBlockNumber();
    if (head < span) {
      await mine(Number(span) + 1);
      continue;
    }

    const window = new BlockWindow(capacity);
    for (let n = head - span; n <= head; n++) window.push(await refAt(n));

    const before = (await refAt(head)).hash;
    await client.request({ method: "anvil_reorg", params: [depth, []] } as never);
    if ((await refAt(head)).hash !== before) return { window, head };

    await mine(depth + 1);
  }
  return undefined;
}

/**
 * Mine `n` blocks.
 *
 * Uses `anvil_mine` rather than sending transactions. Measured on a fresh node: sending
 * transactions produced a chain on which `anvil_reorg` was a no-op, while `anvil_mine`
 * followed by `anvil_reorg` replaced the tip hash every time. Transaction-driven mining
 * batches under automine, so the resulting chain shape is not what the reorg expects.
 *
 */
async function mine(n: number): Promise<void> {
  await client.request({ method: "anvil_mine", params: [n] } as never);
}

describe("reorg detection against a real anvil reorg", () => {
  it("confirms anvil_reorg replaces a block hash at the same height", {
    timeout: 120_000,
  }, async () => {
    if (!anvilUp) return expect(anvilUp, "anvil must be running").toBe(true);

    await mine(5);
    const head = await client.getBlockNumber();
    const ancestorBefore = await refAt(head - 3n);

    const previousTip = await reorgOrSkip(3);
    expect(
      previousTip,
      "anvil_reorg never took effect — precondition not met, not a pass",
    ).toBeDefined();
    if (!previousTip) return;

    const after = await refAt(head);
    expect(after.number, "the height must be reused — that is what makes reorgs dangerous").toBe(
      head,
    );
    expect(
      after.hash,
      "the hash at that height must differ, or this is a rewind rather than a reorg",
    ).not.toBe(previousTip);

    // depth N rewrites the top N blocks, so head-N is untouched and is the fork point.
    const ancestorAfter = await refAt(head - 3n);
    expect(ancestorAfter.hash, "head-depth must remain canonical").toBe(ancestorBefore.hash);
  });

  /**
   * The assertion the whole indexer design rests on.
   *
   * A window built before the reorg holds hashes that are no longer canonical. `detectReorg`
   * must say so — and if it returned "ok" here, every downstream aggregate would silently
   * accumulate events from an abandoned fork.
   */
  it("detects a real reorg the stored window did not anticipate", {
    timeout: 120_000,
  }, async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);

    await mine(6);
    const head = await client.getBlockNumber();

    // Track the last five blocks exactly as the indexer would.
    const window = new BlockWindow(16);
    for (let n = head - 4n; n <= head; n++) window.push(await refAt(n));
    expect(window.size).toBe(5);

    const happened = await reorgOrSkip(3);
    expect(
      happened,
      "anvil_reorg never took effect — precondition not met, not a pass",
    ).toBeDefined();
    if (!happened) return;

    const verdict = await detectReorg(client, window);

    expect(verdict.kind, `expected a reorg verdict, got ${verdict.kind}`).toBe("reorg");
    if (verdict.kind !== "reorg") return;

    /**
     * The assertion that actually discriminates.
     *
     * `depth > 0` is too weak: comparing block NUMBERS instead of hashes — the precise bug
     * the indexer rules forbid — still produces a "reorg" verdict with a plausible depth,
     * so a loose assertion passes the sabotage. Verified by making that exact edit.
     *
     * A depth-3 reorg rewrites the top 3 blocks, so the fork point is EXACTLY head-3 and
     * the depth is EXACTLY 3. Only hash comparison can find that; number comparison matches
     * at whichever block it reaches first and reports the wrong ancestor.
     */
    expect(verdict.commonAncestor, "the fork point must be exactly head-depth").toBe(head - 3n);
    expect(verdict.depth, "a depth-3 reorg orphans exactly 3 blocks").toBe(3);

    // And the ancestor it named must genuinely still be canonical.
    const ancestor = await refAt(verdict.commonAncestor);
    expect(
      window.find(verdict.commonAncestor)?.hash,
      "the named ancestor must match the chain",
    ).toBe(ancestor.hash);
  });

  /**
   * The negative control. Without it, a `detectReorg` that always returned "reorg" would
   * pass the test above — and the check would be worthless rather than merely wrong.
   */
  it("does NOT report a reorg when the chain simply advanced", { timeout: 120_000 }, async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);

    await mine(3);
    const head = await client.getBlockNumber();

    const window = new BlockWindow(16);
    for (let n = head - 2n; n <= head; n++) window.push(await refAt(n));

    await mine(1);
    const next = await refAt(head + 1n);

    // A block that descends from the tip is ordinary progress, not a reorg.
    expect(next.parentHash).toBe(window.tip?.hash);
    expect((await detectReorg(client, window)).kind).toBe("ok");
  });

  /**
   * Rolling back must leave the window consistent enough to keep going.
   *
   * A window that rolls back but retains a stale tip would throw on the next `push` — the
   * parentHash guard would fire — and an indexer that cannot resume after a reorg is as
   * broken as one that never detected it.
   */
  it("resumes cleanly after rolling back to the common ancestor", {
    timeout: 120_000,
  }, async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);

    await mine(6);
    const staged = await windowThenReorg(4n, 3);
    expect(staged, "anvil_reorg never took effect — precondition not met").toBeDefined();
    if (!staged) return;
    const { window, head } = staged;

    const verdict = await detectReorg(client, window);
    if (verdict.kind !== "reorg") throw new Error(`expected reorg, got ${verdict.kind}`);

    window.rollbackTo(verdict.commonAncestor);
    expect(window.tip?.number).toBe(verdict.commonAncestor);

    // Re-push the now-canonical blocks. This throws if the rollback left an inconsistent
    // ancestry, which is the failure this test exists to catch.
    for (let n = verdict.commonAncestor + 1n; n <= head; n++) {
      window.push(await refAt(n));
    }

    const canonicalTip = await refAt(head);
    expect(window.tip?.hash, "the window must end on the canonical chain").toBe(canonicalTip.hash);
  });

  /**
   * A reorg deeper than the tracked window must be LOUD.
   *
   * Silently truncating here is the worst possible outcome: the indexer would resume from a
   * point it cannot prove is canonical, and every aggregate downstream inherits the error
   * with no signal that anything happened.
   */
  it("reports beyond-window rather than guessing when the reorg outruns the window", {
    timeout: 120_000,
  }, async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);

    await mine(8);
    // Deliberately track fewer blocks than the reorg will rewrite.
    const staged = await windowThenReorg(1n, 6, 2);
    expect(staged, "anvil_reorg never took effect — precondition not met").toBeDefined();
    if (!staged) return;

    const verdict = await detectReorg(client, staged.window);

    expect(
      verdict.kind,
      "a reorg deeper than the window must not be silently classified as a shallow one",
    ).toBe("beyond-window");
  });
});
