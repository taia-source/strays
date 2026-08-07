import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildIdentity,
  decideResume,
  estimateReindexSeconds,
  normaliseSource,
} from "./durability.js";

/**
 * ══ Measured numbers from fletchdotclick ══
 *
 *   start block          3,857,265
 *   re-index span        ~1.6M blocks, ~30 minutes — and it CANNOT be turned off
 *   lock hold on drain   1–2 minutes on a Railway redeploy
 *   identity length      first 12 hex of the hash
 *
 * The consequence recorded verbatim: *"a new launch's tx succeeded on-chain but didn't show
 * or trade on the site."* Every test here is about preventing that window, or about not
 * opening it for no reason.
 */

const START_BLOCK = 3_857_265n;
const HEAD_BLOCK = START_BLOCK + 1_600_000n;
const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

describe("normalising source before hashing it", () => {
  /**
   * ══ The 30-minute comment ══
   *
   * Hashing raw source means adding a comment forces a full re-index. That is a fingerprint
   * of the FILE where what is wanted is a fingerprint of the CODE.
   */
  it("ignores a comment, which would otherwise cost a re-index", () => {
    const before = "const x = 1;\nconst y = 2;";
    const after = "// explain x\nconst x = 1;\n/* and y */\nconst y = 2;";
    expect(normaliseSource(after), "a comment changed the identity").toBe(normaliseSource(before));
  });

  it("ignores reformatting", () => {
    expect(normaliseSource("const   x=1;\n\n\nconst y = 2;")).toBe(
      normaliseSource("const x=1; const y = 2;"),
    );
  });

  /** A rename CAN change what is decoded, so it must change the identity. */
  it("does not ignore a rename", () => {
    expect(normaliseSource("const x = 1;")).not.toBe(normaliseSource("const y = 1;"));
  });

  it("does not ignore a changed value", () => {
    expect(normaliseSource("const from = 100n;")).not.toBe(normaliseSource("const from = 200n;"));
  });

  /**
   * A URL contains `//`, and a naive line-comment strip truncates it — which would make two
   * different endpoints hash identically.
   */
  it("does not mistake a url for a comment", () => {
    const a = normaliseSource('const rpc = "https://alpha.example/rpc";');
    const b = normaliseSource('const rpc = "https://beta.example/rpc";');
    expect(a, "two different endpoints hashed the same").not.toBe(b);
  });
});

describe("the build identity", () => {
  const sources = {
    "config.ts": "export const startBlock = 3857265n;",
    "schema.ts": "export const table = 'events';",
    "handlers.ts": "export function onEvent() {}",
  };

  it("is stable across runs", () => {
    const first = buildIdentity({ sources, namespace: "fletch", hash: sha256 });
    const second = buildIdentity({ sources, namespace: "fletch", hash: sha256 });
    expect(first).toBe(second);
  });

  /** Caller order must not matter, or two identical builds get different schemas. */
  it("does not depend on key order", () => {
    const reordered = {
      "handlers.ts": sources["handlers.ts"],
      "config.ts": sources["config.ts"],
      "schema.ts": sources["schema.ts"],
    };
    expect(buildIdentity({ sources: reordered, namespace: "fletch", hash: sha256 })).toBe(
      buildIdentity({ sources, namespace: "fletch", hash: sha256 }),
    );
  });

  /** The whole point: a comment must not produce a new schema. */
  it("survives a comment being added to any file", () => {
    const commented = { ...sources, "handlers.ts": "// handle it\nexport function onEvent() {}" };
    expect(
      buildIdentity({ sources: commented, namespace: "fletch", hash: sha256 }),
      "a comment triggered a 30-minute re-index",
    ).toBe(buildIdentity({ sources, namespace: "fletch", hash: sha256 }));
  });

  it("changes when a handler changes", () => {
    const changed = { ...sources, "handlers.ts": "export function onEvent() { store(); }" };
    expect(buildIdentity({ sources: changed, namespace: "fletch", hash: sha256 })).not.toBe(
      buildIdentity({ sources, namespace: "fletch", hash: sha256 }),
    );
  });

  /** Two projects sharing a database must not collide on identical code. */
  it("separates projects by namespace", () => {
    expect(buildIdentity({ sources, namespace: "alpha", hash: sha256 })).not.toBe(
      buildIdentity({ sources, namespace: "beta", hash: sha256 }),
    );
  });

  /** 12 hex characters, as fletchdotclick settled on. */
  it("is short enough to read in a schema name", () => {
    const identity = buildIdentity({ sources, namespace: "fletch", hash: sha256 });
    expect(identity).toMatch(/^fletch_[0-9a-f]{12}$/);
  });

  it("survives a file being absent from the record", () => {
    expect(() => buildIdentity({ sources: {}, namespace: "x", hash: sha256 })).not.toThrow();
  });
});

describe("deciding whether to resume", () => {
  const base = {
    identity: "fletch_abc123456789",
    locked: false,
    waitedSeconds: 0,
    maxWaitSeconds: 180,
  };

  it("resumes when the identity matches", () => {
    const decision = decideResume({ ...base, stored: base.identity });
    expect(decision.kind).toBe("resume");
  });

  /**
   * ══ B13 ══
   *
   * A FIXED name failed with "Schema was previously used by a different app"; a RANDOM one
   * re-indexed unchanged code. A derived name gets a clean schema only when the code moved.
   */
  it("takes a fresh schema when the code changed, rather than reusing the old one", () => {
    const decision = decideResume({ ...base, stored: "fletch_older00000000" });
    expect(decision.kind).toBe("fresh-schema");
    expect(decision.kind === "fresh-schema" && decision.schema).toBe(base.identity);
  });

  it("takes a fresh schema when nothing is stored yet", () => {
    const decision = decideResume({ ...base, stored: undefined });
    expect(decision.kind).toBe("fresh-schema");
  });

  /**
   * ══ B14 — the one that left the indexer permanently dead ══
   *
   * On a redeploy the OLD container holds the lock for 1–2 minutes while draining. Both
   * containers are behaving correctly. Exiting here leaves an empty API behind a green
   * deployment.
   */
  it("waits for a held lock rather than exiting", () => {
    const decision = decideResume({
      ...base,
      stored: base.identity,
      locked: true,
      waitedSeconds: 30,
    });
    expect(decision.kind, "a normal redeploy killed the indexer").toBe("wait");
  });

  it.each([0, 60, 119])("keeps waiting at %is, inside the measured drain window", (waited) => {
    const decision = decideResume({
      ...base,
      stored: base.identity,
      locked: true,
      waitedSeconds: waited,
    });
    expect(decision.kind).toBe("wait");
  });

  /** A hold past the drain window is a stuck container, not a handover. */
  it("halts once the wait is exhausted", () => {
    const decision = decideResume({
      ...base,
      stored: base.identity,
      locked: true,
      waitedSeconds: 180,
    });
    expect(decision.kind).toBe("halt");
  });

  /**
   * ══ Order matters ══
   *
   * The lock is checked BEFORE the identity. A draining container still holds the OLD
   * schema, so comparing identity first would see a mismatch and trigger a re-index that
   * was never needed — turning a clean handover into 30 minutes of stale data.
   */
  it("waits rather than re-indexing when the lock is held AND the identity differs", () => {
    const decision = decideResume({
      ...base,
      stored: "fletch_older00000000",
      locked: true,
      waitedSeconds: 10,
    });
    expect(decision.kind, "a draining container triggered an unnecessary re-index").toBe("wait");
  });
});

describe("stating the cost of a re-index", () => {
  /** fletchdotclick: ~1.6M blocks in ~30 minutes ≈ 890 blocks/second. */
  it("estimates the measured span at the measured rate", () => {
    const seconds = estimateReindexSeconds({
      fromBlock: START_BLOCK,
      headBlock: HEAD_BLOCK,
      blocksPerSecond: 890,
    });
    // ~1800 seconds, which is the 30 minutes recorded.
    expect(seconds).toBeGreaterThan(1_500);
    expect(seconds).toBeLessThan(2_100);
  });

  it("is zero when there is nothing to scan", () => {
    expect(
      estimateReindexSeconds({
        fromBlock: HEAD_BLOCK,
        headBlock: HEAD_BLOCK,
        blocksPerSecond: 890,
      }),
    ).toBe(0);
  });

  it("is zero rather than negative when the head is behind", () => {
    expect(
      estimateReindexSeconds({
        fromBlock: HEAD_BLOCK,
        headBlock: START_BLOCK,
        blocksPerSecond: 890,
      }),
    ).toBe(0);
  });

  /** A rate of zero cannot finish, and saying "0 seconds" would be the opposite of true. */
  it.each([0, -1])("reports an impossible rate of %i as infinite", (rate) => {
    expect(
      estimateReindexSeconds({
        fromBlock: START_BLOCK,
        headBlock: HEAD_BLOCK,
        blocksPerSecond: rate,
      }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});
