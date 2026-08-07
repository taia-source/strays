import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type CursorState, decideStart, MemoryCursorStore } from "./cursor.js";

/**
 * Property-based tests for cursor advancement.
 *
 * ══ Why monotonicity alone is the wrong property ══
 *
 * The obvious property for a checkpoint is "it never goes backwards". That is the property
 * every stream-processing system states — and every one of them also states that it is not
 * sufficient on its own.
 *
 * Kafka Streams derives it as a *consequence* rather than an axiom: stream-time is "the
 * highest timestamp of any record yet polled… As a consequence of the definition, the
 * PartitionGroup's stream-time is non-decreasing". Flink does not put monotonicity in the
 * `WatermarkGenerator` contract at all — generators may emit regressions, and
 * `StatusWatermarkValve` suppresses them downstream. And Kafka offsets are explicitly *not*
 * monotonic: a consumer "can deliberately rewind back to an old offset".
 *
 * The property that actually catches bugs is **gap-freedom**: the union of processed ranges
 * must be contiguous, with no holes and no double-counting. Jepsen's Kafka tests encode
 * exactly this pair — `:nonmonotonic` *and* `:skip`, where skip means "two successive
 * operations by a single process skipped over one or more values". A cursor can advance
 * monotonically and still skip a block, and a monotonicity check will never see it.
 *
 * That distinction matters here more than in a general queue, because this repo's own rule
 * is that aggregates are derived from the event table: a skipped range is a permanently
 * missing row, and a repeated range is a double count.
 *
 * ══ Rewind is a legal operation, not a violation ══
 *
 * `decideStart` deliberately returns positions *below* the cursor for gap repair and
 * decoder changes. So the invariant is not "never move backwards" but "only move backwards
 * for a stated reason" — the same shape as Jepsen's exemption that "rebalances invalidate
 * any assumption of monotonically advancing offsets".
 */

const blockNumber = fc.bigInt({ min: 0n, max: 10n ** 9n });
const ZERO_HASH = `0x${"0".repeat(64)}` as `0x${string}`;

// No override parameter: spreading `Partial<CursorState>` makes every field optional,
// which defeats the exactOptionalPropertyTypes guarantee that `blockHash` is present.
/**
 * A 32-byte hash. `CursorState` keys on block HASH rather than number, so the generator
 * must supply real ones.
 *
 * `fc.hexaString` was removed in fast-check 4 — verified against the installed 4.9.0, whose
 * only string arbitraries are `string`, `base64String` and `stringMatching`. Building the
 * hash from a fixed-length array of hex digits is the current idiom and shrinks cleanly,
 * since shrinking simplifies digits rather than changing the length.
 */
const hexDigit = fc.constantFrom(..."0123456789abcdef".split(""));
const blockHash: fc.Arbitrary<`0x${string}`> = fc
  .array(hexDigit, { minLength: 64, maxLength: 64 })
  .map((digits) => `0x${digits.join("")}` as `0x${string}`);

// No override parameter: spreading `Partial<CursorState>` would make every field optional,
// defeating the exactOptionalPropertyTypes guarantee that `blockHash` is always present.
const cursorArb = (): fc.Arbitrary<CursorState> =>
  fc
    .tuple(
      blockNumber,
      fc.option(blockNumber, { nil: null }),
      fc.option(fc.string(), { nil: null }),
      fc.option(blockHash, { nil: null }),
    )
    .map(([block, scannedFrom, decodeFingerprint, hash]) => ({
      block,
      scannedFrom,
      decodeFingerprint,
      blockHash: hash,
    }));

describe("decideStart", () => {
  /**
   * The safety property: a scan never begins above the block after the cursor.
   *
   * Beginning higher is a **skip** — the blocks between are never read, and because
   * aggregates are derived from the event table, the rows are missing permanently. Nothing
   * downstream reports it, which is why this is asserted over the whole domain rather than
   * a handful of examples.
   */
  it("never starts above the block immediately after the cursor", () => {
    fc.assert(
      fc.property(cursorArb(), blockNumber, fc.string(), (cursor, startBlock, fingerprint) => {
        const decision = decideStart(cursor, startBlock, fingerprint);
        const highestSafe = cursor.block + 1n;
        expect(
          decision.from <= highestSafe || decision.from === startBlock,
          `starting at ${decision.from} would skip blocks after ${cursor.block}`,
        ).toBe(true);
      }),
    );
  });

  /**
   * A backwards move must always carry a reason.
   *
   * Rewinding is legal — gap repair and decoder changes both require it — but a rewind
   * without a stated cause is indistinguishable from a bug, and re-scanning is expensive
   * enough that a silent one hides real breakage.
   */
  it("only moves backwards with a stated reason", () => {
    fc.assert(
      fc.property(cursorArb(), blockNumber, fc.string(), (cursor, startBlock, fingerprint) => {
        const decision = decideStart(cursor, startBlock, fingerprint);
        if (decision.kind === "resume") return;
        expect(decision.reason.length, "a rewind must explain itself").toBeGreaterThan(20);
      }),
    );
  });

  /**
   * Idempotence: deciding twice from the same state gives the same answer.
   *
   * A decision function that depends on hidden state would make restart behaviour
   * unpredictable — the same crash would resume differently on each attempt.
   */
  it("is deterministic for the same inputs", () => {
    fc.assert(
      fc.property(cursorArb(), blockNumber, fc.string(), (cursor, startBlock, fingerprint) => {
        expect(decideStart(cursor, startBlock, fingerprint)).toEqual(
          decideStart(cursor, startBlock, fingerprint),
        );
      }),
    );
  });

  /**
   * A hole beneath the cursor must always be repaired, whatever the fingerprint says.
   *
   * A forward-only cursor can never fill a gap below itself, so this is the one condition
   * that must dominate — including when the decode fingerprint also changed, since
   * resuming would leave the hole permanently.
   */
  it("always repairs a gap beneath the cursor", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(blockNumber, blockNumber, blockNumber)
          // scannedFrom strictly above startBlock is the gap condition; expressed as a
          // rearrangement rather than a dependent generator, for shrinking.
          .map(([a, b, block]) => {
            const [lo, hi] = a <= b ? [a, b] : [b, a];
            return { startBlock: lo, scannedFrom: hi, block } as const;
          }),
        fc.string(),
        ({ startBlock, scannedFrom, block }, fingerprint) => {
          fc.pre(scannedFrom > startBlock && block > 0n);
          const cursor: CursorState = {
            block,
            scannedFrom,
            decodeFingerprint: null,
            blockHash: null,
          };
          const decision = decideStart(cursor, startBlock, fingerprint);
          expect(decision.kind).toBe("repair-gap");
          expect(decision.from).toBe(startBlock);
        },
      ),
    );
  });

  /**
   * A fresh cursor always starts at the configured start block — never at 1, never at the
   * cursor's own zero value. Starting anywhere else silently skips history on first run.
   */
  it("starts a fresh cursor at the configured start block", () => {
    fc.assert(
      fc.property(blockNumber, fc.string(), (startBlock, fingerprint) => {
        const fresh: CursorState = {
          block: 0n,
          scannedFrom: null,
          decodeFingerprint: null,
          blockHash: null,
        };
        const decision = decideStart(fresh, startBlock, fingerprint);
        expect(decision.kind).toBe("resume");
        expect(decision.from).toBe(startBlock);
      }),
    );
  });
});

describe("commit atomicity", () => {
  /**
   * The invariant the whole cursor design exists for: **rows and the cursor advance
   * together, or neither does.**
   *
   * If a commit can partially apply, a crash leaves either a gap (rows written, cursor not
   * advanced → the range is re-scanned and double-counted) or silent loss (cursor advanced,
   * rows missing → the range is never read again). Both are invisible to a green test run.
   *
   * `failAfterRows` simulates a crash part-way through. The property asserts across every
   * failure point in a generated sequence, not just the one someone thought to write down.
   */
  it("leaves the store untouched when a commit fails part-way", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ id: fc.integer({ min: 0, max: 1000 }) }), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.nat({ max: 11 }),
        blockNumber,
        async (rows, failAfter, block) => {
          const store = new MemoryCursorStore<{ id: number }>();
          const before = { ...(await store.read()) };

          store.failAfterRows = failAfter;
          const attempt = store.commit({
            rows,
            fromBlock: block,
            toBlock: block,
            toBlockHash: ZERO_HASH,
            decodeFingerprint: "fp",
          });

          // Either the whole commit lands, or nothing does. A partial state is the bug.
          const failed = await attempt.then(
            () => false,
            () => true,
          );
          const after = await store.read();

          if (failed) {
            expect(after, "a failed commit must leave the cursor exactly as it was").toEqual(
              before,
            );
            expect(store.rows(), "a failed commit must leave no rows behind").toHaveLength(0);
          } else {
            expect(after.block).toBe(block);
            expect(store.rows()).toHaveLength(rows.length);
          }
        },
      ),
    );
  });
});
