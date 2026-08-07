/**
 * Validation-ladder tests, including live checks against chain 4663.
 *
 * Three of these encode traps found by reading viem's source rather than its docs. Each
 * would have produced a check that silently never fires — worse than no check, because
 * it reads as protection.
 */
import { robinhoodNitro, rpcUrl } from "@taia/chains";
import { createTaiaClient } from "@taia/rpc";
import { describe, expect, it } from "vitest";
import {
  checkChainId,
  checkCrossReference,
  checkHasCode,
  checkShape,
  checkStartBlock,
  checkStartBlockOnChain,
  checkTokenIdentity,
} from "./validate.js";

const client = createTaiaClient({
  chain: robinhoodNitro,
  urls: [rpcUrl(robinhoodNitro.id)],
  limits: { expensive: 1, cheap: 4 },
});

/** Multicall3 — deployed on 4663, verified earlier. A known-good contract. */
const MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11" as const;
/** Well-formed, checksummed, and almost certainly not a contract on this chain. */
const NOT_DEPLOYED = "0x1111111111111111111111111111111111111111" as const;

describe("checkShape", () => {
  it("accepts a well-formed address", () => {
    expect(checkShape(MULTICALL).ok).toBe(true);
  });

  it("rejects a truncated address with a readable reason", () => {
    const r = checkShape("0x1234");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not a 20-byte hex address/);
  });

  it("rejects a literal placeholder", () => {
    expect(checkShape("TBA").ok).toBe(false);
  });
});

describe("checkStartBlock", () => {
  /**
   * Asymmetric: before the deploy is merely slow; AFTER it loses every earlier event
   * permanently, with no error. That asymmetry is the whole point of the check.
   */
  it("fails when the start block is after the deploy block", () => {
    const r = checkStartBlock(500n, 400n);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/lost permanently and nothing will error/);
  });

  it("passes, but flags the waste, when it precedes the deploy", () => {
    const r = checkStartBlock(300n, 400n);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/wasted scanning/);
  });

  it("passes cleanly on an exact match", () => {
    expect(checkStartBlock(400n, 400n).detail).toMatch(/exactly/);
  });
});

describe("live — chain identity", () => {
  it("confirms the RPC is the chain we think it is", async () => {
    const r = await checkChainId(client, robinhoodNitro.id);
    expect(r.ok, r.detail).toBe(true);
  });

  /**
   * The check that makes the rest of the ladder trustworthy: the same address can exist
   * on several chains, so every other assertion is meaningless against the wrong RPC.
   */
  it("catches a config pointing at the wrong network", async () => {
    const r = await checkChainId(client, 1);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/validating the wrong network/);
  });
});

describe("live — contract presence", () => {
  it("confirms a known contract exists on this chain", async () => {
    const r = await checkHasCode(client, MULTICALL);
    expect(r.ok, r.detail).toBe(true);
    expect(r.detail).toMatch(/contract present/);
  });

  /**
   * TRAP, verified in viem 2.55.10 source: `getCode` returns `undefined` for empty code,
   * so the widely-copied `code !== "0x"` idiom is ALWAYS true and the check never fires.
   * This test fails if that regression is ever reintroduced.
   */
  it("reports an address with no code as a probable wrong-network address", async () => {
    const r = await checkHasCode(client, NOT_DEPLOYED);
    expect(r.ok, "an undeployed address must NOT pass").toBe(false);
    expect(r.detail).toMatch(/different network/);
  });
});

describe("live — token identity", () => {
  it("explains clearly when a contract is not an ERC-20", async () => {
    const r = await checkTokenIdentity(client, MULTICALL);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/does not answer as an ERC-20/);
  });
});

describe("live — start block against the chain", () => {
  it("refuses block 0, which forces a full-chain backfill", async () => {
    const r = await checkStartBlockOnChain(client, MULTICALL, 0n);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/full-chain backfill/);
  });

  /**
   * Measured, and it corrected an assumption: this endpoint DOES serve historical
   * `getCode` far back, even though it refuses historical `eth_getBalance`. Archive
   * support is per-method, not a single capability — so the check runs here rather than
   * skipping.
   *
   * ── Why this probes relative to the deploy instead of a fixed offset ──
   *
   * This test used to use `head - 5_000_000n` and was flaky at roughly 1 run in 5, then
   * became permanently wrong. **Chain 4663 produces blocks every 100ms**, so measured
   * against the live chain:
   *
   *   head: 21298314 · 5,000,000 blocks spans 5.81 days
   *   multicall code at head-5,000,000: PRESENT
   *
   * Multicall3 was deployed *before* that window, so the assertion "the contract did not
   * exist here" silently expired as the chain advanced past it. A fixed block offset is a
   * time bomb on a fast chain: it encodes a duration that shrinks every day.
   *
   * So the probe is anchored to the contract's own history — binary-search the first block
   * where it has code, then ask about a block after that. That assertion is true forever,
   * on any chain, at any block time.
   */
  it("detects a start block set after the deploy", async () => {
    const head = await client.getBlockNumber();

    // Find the deploy block by bisection over `getCode`. ~25 calls for a 21M-block chain.
    let lo = 0n;
    let hi = head;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const code = await client.getCode({ address: MULTICALL, blockNumber: mid });
      if (code && code !== "0x") hi = mid;
      else lo = mid + 1n;
    }
    const deployedAt = lo;

    expect(deployedAt, "Multicall3 must exist somewhere in this chain's history").toBeLessThan(
      head,
    );

    // A start block strictly after the deploy means every earlier event is missed.
    const afterDeploy = deployedAt + (head - deployedAt) / 2n;
    const r = await checkStartBlockOnChain(client, MULTICALL, afterDeploy);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/AFTER the deploy|lost permanently/);
  });

  /**
   * The skip path still matters: a pruned endpoint fails the historical call, and a check
   * that reported a correct config as broken would get disabled and then protect nothing.
   */
  it("skips rather than fails when historical reads are unavailable", async () => {
    const pruned = {
      uid: `pruned-${Math.random()}`,
      cacheTime: 0,
      request: async ({ method }: { method: string }) => {
        if (method === "eth_getCode") throw new Error("missing trie node");
        throw new Error(`unexpected ${method}`);
      },
    } as never;
    const r = await checkStartBlockOnChain(pruned, MULTICALL, 1_000n);
    expect(r.ok, "a pruned node must skip, not fail").toBe(true);
    expect(r.detail).toMatch(/not an archive node|skipped/);
  });
});

describe("checkCrossReference — the rung people skip", () => {
  /**
   * The check that catches a wrong-but-real address. Every rung above passes for an
   * address that is a genuine, live contract of the right shape — only asking the
   * contract whether its own state agrees with our config exposes the mismatch.
   *
   * Stubbed at the RPC boundary so the disagreement can actually be staged; a live chain
   * cannot be made to disagree with itself on demand.
   */
  const OURS = "0xD7b792680eE6c7207EFdd31Ae1d0E68a1d5797FF" as const;
  const THEIRS = "0x6d0881c04e6b87C190580221ea0504cf9b193Ea0" as const;

  function stub(returns: `0x${string}` | Error) {
    return {
      uid: `xref-${Math.random()}`,
      cacheTime: 0,
      request: async ({ method }: { method: string }) => {
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        if (returns instanceof Error) throw returns;
        return `0x${returns.slice(2).padStart(64, "0")}`;
      },
    } as never;
  }

  it("passes when on-chain state agrees with config", async () => {
    const r = await checkCrossReference(stub(OURS), {
      contract: THEIRS,
      getter: "token",
      expected: OURS,
      label: "nft.token()",
    });
    expect(r.ok, r.detail).toBe(true);
  });

  it("catches a mismatch and names both values", async () => {
    const r = await checkCrossReference(stub(THEIRS), {
      contract: OURS,
      getter: "token",
      expected: OURS,
      label: "nft.token()",
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/these must match/);
  });

  it("is case-insensitive, since checksums vary by source", async () => {
    const r = await checkCrossReference(stub(OURS.toLowerCase() as `0x${string}`), {
      contract: THEIRS,
      getter: "token",
      expected: OURS,
      label: "nft.token()",
    });
    expect(r.ok, r.detail).toBe(true);
  });

  it("explains a failed read rather than throwing", async () => {
    const r = await checkCrossReference(stub(new Error("execution reverted")), {
      contract: OURS,
      getter: "token",
      expected: OURS,
      label: "nft.token()",
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/could not read token\(\)/);
  });
});
