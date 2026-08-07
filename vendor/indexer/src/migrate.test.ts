/**
 * Migration tests — the property that justifies owning the indexer.
 *
 * Ponder's `build_id` forces a full re-index on ANY schema/handler/config change and
 * cannot be disabled. These assert the alternative: adding an event re-scans only that
 * event, and an unchanged surface costs nothing.
 */
import { describe, expect, it } from "vitest";
import { defineDecodeSurface } from "./decode.js";
import { planBackfill, planMigration, rewritesExistingRows } from "./migrate.js";

const TRANSFER = "Transfer(address,address,uint256)";
const SOLD = "Sold(address,uint256,uint256)";
const BURNED = "Burned(address,uint256)";

describe("planBackfill", () => {
  /** The whole point: an unchanged surface must cost ZERO re-reading. */
  it("plans nothing when the decode surface did not change", () => {
    const surface = defineDecodeSurface([TRANSFER, SOLD]);
    expect(
      planBackfill({ previous: surface, current: surface, startBlock: 100n, cursorBlock: 9_000n }),
    ).toEqual([]);
  });

  it("plans nothing on a fresh database — the forward scan covers it", () => {
    expect(
      planBackfill({
        previous: [],
        current: defineDecodeSurface([TRANSFER]),
        startBlock: 100n,
        cursorBlock: 100n,
      }),
    ).toEqual([]);
  });

  /**
   * `MarketMakerDeployed` shipped exactly this way: correct code, blind data, because the
   * cursor had already passed those blocks.
   */
  it("re-scans history for a newly added event only", () => {
    const plans = planBackfill({
      previous: defineDecodeSurface([TRANSFER]),
      current: defineDecodeSurface([TRANSFER, SOLD]),
      startBlock: 100n,
      cursorBlock: 9_000n,
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]?.signature).toBe(SOLD);
    expect(plans[0]?.fromBlock).toBe(100n);
    expect(plans[0]?.toBlock).toBe(9_000n);
    expect(plans[0]?.reason).toMatch(/blind to it until re-read/);
  });

  it("plans one job per added event, and none for the unchanged ones", () => {
    const plans = planBackfill({
      previous: defineDecodeSurface([TRANSFER]),
      current: defineDecodeSurface([TRANSFER, SOLD, BURNED]),
      startBlock: 1n,
      cursorBlock: 500n,
    });
    expect(plans.map((p) => p.signature).sort()).toEqual([BURNED, SOLD].sort());
  });
});

describe("rewritesExistingRows", () => {
  it("is false when only adding events — new events write new rows", () => {
    expect(
      rewritesExistingRows({
        previous: defineDecodeSurface([TRANSFER]),
        current: defineDecodeSurface([TRANSFER, SOLD]),
      }),
    ).toBe(false);
  });

  it("is true when a handler's interpretation changed", () => {
    const surface = defineDecodeSurface([TRANSFER]);
    expect(
      rewritesExistingRows({ previous: surface, current: surface, changedHandlers: ["Transfer"] }),
    ).toBe(true);
  });

  /** A removed event leaves rows nothing maintains — someone must decide their fate. */
  it("is true when an event was removed from the surface", () => {
    expect(
      rewritesExistingRows({
        previous: defineDecodeSurface([TRANSFER, SOLD]),
        current: defineDecodeSurface([TRANSFER]),
      }),
    ).toBe(true);
  });
});

describe("planMigration", () => {
  it("reports the honest cost of a migration", () => {
    const summary = planMigration({
      previous: defineDecodeSurface([TRANSFER]),
      current: defineDecodeSurface([TRANSFER, SOLD]),
      startBlock: 100n,
      cursorBlock: 1_099n,
    });

    expect(summary.backfills).toHaveLength(1);
    expect(summary.rewritesExisting).toBe(false);
    expect(summary.blocksToRescan).toBe(1_000n);
  });

  it("costs nothing when nothing changed", () => {
    const surface = defineDecodeSurface([TRANSFER, SOLD]);
    const summary = planMigration({
      previous: surface,
      current: surface,
      startBlock: 1n,
      cursorBlock: 10_000_000n,
    });
    expect(summary.blocksToRescan).toBe(0n);
    expect(summary.rewritesExisting).toBe(false);
  });
});
