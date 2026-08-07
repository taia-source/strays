/**
 * Chain definition tests.
 *
 * These hit the live chain deliberately. A chain definition that typechecks but lies about
 * the chain is worse than no definition — it is the failure mode this package exists to
 * prevent. Set `TAIA_RPC_<id>` to point at a provider endpoint in CI.
 */
import { createPublicClient, http } from "viem";
import { describe, expect, it } from "vitest";
import {
  chains,
  getMeta,
  requireOwnRpc,
  resolveRpc,
  robinhoodNitro,
  rpcUrl,
  type SupportedChainId,
} from "./chains.js";
import { ARB_SYS_ADDRESS, arbSysAbi } from "./nitro.js";

const ids = Object.keys(chains).map(Number) as SupportedChainId[];

/** Only mainnets are probed by default; testnets are opt-in via TAIA_TEST_TESTNETS=1. */
const liveIds = ids.filter((id) => !chains[id].testnet || process.env.TAIA_TEST_TESTNETS === "1");

function clientFor(id: SupportedChainId) {
  return createPublicClient({ chain: chains[id], transport: http(rpcUrl(id)) });
}

/**
 * A client typed to ONE chain, for the Nitro-formatter assertions below.
 *
 * `clientFor` takes any `SupportedChainId`, so `chains[id]` is a union — and once BSC (56)
 * joined the registry that union included a chain with no formatters, making
 * `block.l1BlockNumber` a type error (TS2339) in tests that had compiled for weeks.
 *
 * The error was correct and worth keeping: a union-typed client genuinely cannot promise a
 * field only one member defines. Narrowing here rather than casting keeps the formatter
 * types being *proven* — a `as any` would have silenced the compiler and quietly stopped
 * this file from testing what it claims to.
 */
function nitroClientFor(chain: typeof robinhoodNitro) {
  return createPublicClient({ chain, transport: http(rpcUrl(chain.id)) });
}

describe.each(liveIds)("chain %i", (id) => {
  const chain = chains[id];
  const chainMeta = getMeta(id);

  it("declares an id matching the live chain", async () => {
    const live = await clientFor(id).getChainId();
    expect(live).toBe(chain.id);
  });

  /**
   * THE STACK ASSERTION.
   *
   * A comment in a legacy repo called this chain "an OP-Stack L2". It is Arbitrum Nitro.
   * That one wrong word drove cap math off the wrong block clock and produced a 5-day
   * window where 1 hour was intended, plus a retracted "11.5 day" restriction claim.
   *
   * Asserting the chain ID alone would not have caught it. This does.
   */
  it("runs the client stack it claims to", async () => {
    const match = chainMeta.clientVersionMatch;
    if (!match) return;
    const version = await clientFor(id).request({ method: "web3_clientVersion" });
    expect(version.toLowerCase()).toContain(match);
  });

  it("has a reachable multicall3 if one is declared", async () => {
    const address = chain.contracts?.multicall3?.address;
    if (!address) return;
    const code = await clientFor(id).getCode({ address });
    expect(code, `multicall3 not deployed at ${address}`).toBeDefined();
    expect(code?.length ?? 0).toBeGreaterThan(2);
  });
});

describe("nitro formatters", () => {
  it("surfaces l1BlockNumber and sendRoot as typed values", async () => {
    const block = await nitroClientFor(robinhoodNitro).getBlock();

    // Typed by our formatter — viem alone returns these untyped.
    const l1: bigint | undefined = block.l1BlockNumber;
    const sendRoot: `0x${string}` | undefined = block.sendRoot;

    expect(typeof l1).toBe("bigint");
    expect(sendRoot).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  /**
   * The clock divergence, asserted rather than described.
   *
   * If this ever fails, either the chain stopped being Nitro or our block-clock model is
   * wrong — both are things we must find out from a test, not from a mispriced window.
   */
  it("reports an L1 clock FAR APART from the L2 clock — in either direction", async () => {
    const client = nitroClientFor(robinhoodNitro);
    const [block, l2Number] = await Promise.all([client.getBlock(), client.getBlockNumber()]);

    const l1 = block.l1BlockNumber;
    expect(l1).toBeDefined();
    if (l1 === undefined) return;

    // ── The DIRECTION expired; the DISTANCE is the real invariant ─────────────────────────
    // This asserted `l1 > l2`, which was true when 4663 was young. Measured 2026-08-02:
    //   L2 25,917,506   l1BlockNumber 25,667,340   -> L2 is 250,166 AHEAD
    // At 100ms L2 blocks against 12s L1 blocks the L2 count was always going to overtake, so
    // the ordering was a fact with an expiry date rather than a property of the stack.
    //
    // What actually matters — and what the two production bugs this test exists to prevent both
    // violated — is that the clocks are NOT interchangeable. A window sized in one and read in
    // the other is off by a quarter of a million blocks, whichever way round they happen to sit
    // today. So the assertion is on the DISTANCE, which is stable, not on the order.
    expect(Math.abs(Number(l1) - Number(l2Number))).toBeGreaterThan(100_000);
    expect(getMeta(robinhoodNitro.id).blockClock).toBe("nitro");
  });

  it("ArbSys.arbBlockNumber() tracks eth_blockNumber, not the L1 height", async () => {
    const client = clientFor(robinhoodNitro.id);
    const [arbBlock, ethBlock] = await Promise.all([
      client.readContract({
        address: ARB_SYS_ADDRESS,
        abi: arbSysAbi,
        functionName: "arbBlockNumber",
      }),
      client.getBlockNumber(),
    ]);

    // Same clock, so only a few blocks of drift between the two calls.
    const drift = arbBlock > ethBlock ? arbBlock - ethBlock : ethBlock - arbBlock;
    expect(drift).toBeLessThan(500n);
  });
});

/**
 * ══ The silent fallback ══
 *
 * `rpcUrl` returns the public endpoint when `TAIA_RPC_<id>` is unset. Verified:
 *
 *     TAIA_RPC_4663 unset  ->  https://rpc.mainnet.chain.robinhood.com
 *
 * That endpoint has no archive data and is rate-limited, so a backfill against it returns
 * FEWER LOGS rather than an error. A dropped or typo'd env var must therefore be visible,
 * not inferred from a slow test suite.
 */
describe("where an RPC URL came from", () => {
  it("reports an override as an override", () => {
    const resolved = resolveRpc(4663, { TAIA_RPC_4663: "https://example.invalid/key" });
    expect(resolved.source).toBe("override");
    expect(resolved.url).toBe("https://example.invalid/key");
  });

  it("reports the public default as the public default, rather than hiding it", () => {
    const resolved = resolveRpc(4663, {});
    expect(resolved.source, "the fallback was indistinguishable from a real override").toBe(
      "public-default",
    );
  });

  /** An empty string is a dropped env var, not a configured endpoint. */
  it("treats an empty override as unset", () => {
    expect(resolveRpc(4663, { TAIA_RPC_4663: "" }).source).toBe("public-default");
  });

  /** A neighbouring chain's variable must not satisfy this one. */
  it("does not accept another chain's override", () => {
    expect(resolveRpc(4663, { TAIA_RPC_8453: "https://example.invalid" }).source).toBe(
      "public-default",
    );
  });

  it("refuses the public default where archive data is required", () => {
    expect(() => requireOwnRpc(4663, {})).toThrow(/TAIA_RPC_4663/);
  });

  /** The error must explain the consequence, or it reads as a missing-config nag. */
  it("explains that the fallback loses data silently", () => {
    expect(() => requireOwnRpc(4663, {})).toThrow(/FEWER logs|archive/i);
  });

  it("returns the override when one is set", () => {
    expect(requireOwnRpc(4663, { TAIA_RPC_4663: "https://example.invalid/k" })).toBe(
      "https://example.invalid/k",
    );
  });

  /**
   * The suite this repo runs is a live one, so the env must actually be loaded. If this
   * fails, every live test in the gate is quietly running against the public endpoint —
   * which is where the flakiness fixed in b5130e7 came from.
   */
  it("has a real override loaded in this very test run", () => {
    expect(
      resolveRpc(4663, process.env).source,
      "TAIA_RPC_4663 is not loaded, so the gate's live tests are on the public endpoint",
    ).toBe("override");
  });
});
