/**
 * On-chain assertion tests, run against a REAL Anvil instance.
 *
 * These use a live chain rather than stubs because the whole point of the module is to
 * catch things that only appear against a real node — a revert that still yields a
 * receipt, a balance that did not move.
 */
import { createTestClient, http, parseEther, publicActions, walletActions } from "viem";
import { foundry } from "viem/chains";
import { beforeAll, describe, expect, it } from "vitest";
import { TEST_TOKEN_BYTECODE, TEST_TOKEN_SUPPLY } from "./__fixtures.js";
import {
  ANVIL_ACCOUNT,
  assertDeltas,
  diff,
  formatDeltas,
  nativeBalance,
  snapshot,
  waitForSuccess,
} from "./index.js";

const RPC = process.env.TAIA_ANVIL_RPC ?? "http://127.0.0.1:8545";
/**
 * ══ Anvil account #2, and NOT #1 ══
 *
 * This was `0x7099…` — anvil account #1 — which `runner.test.ts` also uses, against the same
 * node at 127.0.0.1:8545. Vitest runs test FILES in parallel, so both credited the same
 * address: `runner` sent 2 ETH, this file sent 1 and asserted a delta of exactly 1, and the
 * assertion saw 3.
 *
 * It passed in isolation three times in a row and failed in the full suite — the shape of
 * flake that gets a gate re-run instead of read. Each file that moves value needs its own
 * account.
 */
const SECOND = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

/** Compiled by forge from a minimal contract: balanceOf/totalSupply/progress. */

const client = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC) })
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

describe("snapshot + diff", () => {
  it("captures named probes and computes the delta", async () => {
    if (!anvilUp) return expect(anvilUp, "anvil must be running for this suite").toBe(true);

    const probes = [nativeBalance(ANVIL_ACCOUNT, "sender"), nativeBalance(SECOND, "receiver")];
    const before = await snapshot(client, probes);

    const hash = await client.sendTransaction({
      account: ANVIL_ACCOUNT,
      to: SECOND,
      value: parseEther("1"),
      chain: foundry,
    });
    await waitForSuccess(client, hash);

    const after = await snapshot(client, probes);
    const deltas = diff(before, after);

    const receiver = deltas.find((d) => d.label === "receiver");
    expect(receiver?.change).toBe(parseEther("1"));

    // Sender loses the value AND the gas, so strictly more than 1 ETH.
    const sender = deltas.find((d) => d.label === "sender");
    expect(sender?.change).toBeLessThan(-parseEther("1"));
  });
});

describe("assertDeltas", () => {
  const before = { a: 100n, b: 50n, c: 10n };
  const after = { a: 150n, b: 30n, c: 10n };

  it("accepts expectations the chain actually met", () => {
    const r = assertDeltas(before, after, {
      a: { kind: "increased" },
      b: { kind: "decreased" },
      c: { kind: "unchanged" },
    });
    expect(r.ok, formatDeltas(r)).toBe(true);
  });

  it("checks an exact amount, not merely a direction", () => {
    expect(assertDeltas(before, after, { a: { kind: "exactly", by: 50n } }).ok).toBe(true);
    expect(assertDeltas(before, after, { a: { kind: "exactly", by: 49n } }).ok).toBe(false);
  });

  /**
   * The assertion people skip. A buy that credits the buyer AND silently drains an
   * unrelated vault passes every "did it increase" check.
   */
  it("catches something that moved when it should not have", () => {
    const r = assertDeltas(before, after, { b: { kind: "unchanged" } });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/expected NO change/);
  });

  it("reports a typo'd probe name rather than passing silently", () => {
    const r = assertDeltas(before, after, { typo: { kind: "increased" } });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/no probe named/);
  });

  it("supports a minimum, for amounts that vary with gas", () => {
    expect(assertDeltas(before, after, { a: { kind: "atLeast", by: 40n } }).ok).toBe(true);
    expect(assertDeltas(before, after, { a: { kind: "atLeast", by: 60n } }).ok).toBe(false);
  });

  /**
   * ══ `decreased` that did not decrease ══
   *
   * The `decreased` expectation had only ever been asserted on a value that really fell,
   * so its FAILURE arm had never run — the one case where the check does any work.
   *
   * This is the assertion that catches a burn, a spend or a fee that silently did
   * nothing. A mint flow asserting "treasury decreased" against a treasury that never
   * moved is exactly the shape of a wired-to-nothing button, and if this arm is broken
   * the whole expectation degrades into a no-op that passes everything.
   *
   * Both non-decreasing cases are covered, because `>= 0n` spans two of them: a balance
   * that went UP when it should have gone down, and one that did not move at all. A
   * `> 0n` typo would let the unchanged case through silently.
   */
  it("fails a 'decreased' expectation when the value rose or stayed put", () => {
    const rose = assertDeltas({ v: 10n }, { v: 25n }, { v: { kind: "decreased" } });
    expect(rose.ok, "a value that increased must fail a decrease expectation").toBe(false);
    expect(rose.failures[0]).toMatch(/expected a decrease/);
    expect(rose.failures[0], "the report must show the direction it actually moved").toContain(
      "v: 10 → 25 (+15)",
    );

    // The boundary: unchanged is NOT a decrease, and `>` instead of `>=` would miss it.
    const flat = assertDeltas({ v: 10n }, { v: 10n }, { v: { kind: "decreased" } });
    expect(flat.ok, "a value that never moved must fail a decrease expectation").toBe(false);
    expect(flat.failures[0]).toContain("v: 10 → 10 (+0)");

    // The control: a genuine decrease still passes, so the check is not simply refusing.
    expect(assertDeltas({ v: 10n }, { v: 4n }, { v: { kind: "decreased" } }).ok).toBe(true);
  });

  /**
   * ══ A probe present before and gone after ══
   *
   * `diff` walks the keys of the BEFORE snapshot and reads each from the after snapshot.
   * When the two do not line up, the missing side falls back to `0n`.
   *
   * The value of pinning this is that the fallback is quietly dangerous: a probe that
   * vanished between snapshots reads as "it went to zero", which for a balance is an
   * enormous decrease. So a flow expecting `decreased` would PASS on a probe that was
   * never actually re-read. This test records that behaviour precisely so the trade-off
   * is visible rather than discovered later during an investigation.
   */
  it("treats a probe missing from the after-snapshot as zero, not as absent", () => {
    const deltas = diff({ kept: 100n, vanished: 500n }, { kept: 120n });

    expect(deltas.map((d) => d.label)).toEqual(["kept", "vanished"]);
    const gone = deltas.find((d) => d.label === "vanished");
    expect(gone?.after, "a missing after-value reads as 0n").toBe(0n);
    expect(gone?.change).toBe(-500n);
  });
});

describe("formatDeltas", () => {
  it("shows every probe on success, so a passing run is auditable", () => {
    const r = assertDeltas({ x: 1n }, { x: 2n }, { x: { kind: "increased" } });
    expect(formatDeltas(r)).toMatch(/changed as expected/);
    expect(formatDeltas(r)).toMatch(/x\s+1 → 2/);
  });

  it("names the failure and still lists every probe", () => {
    const r = assertDeltas({ x: 1n, y: 5n }, { x: 1n, y: 9n }, { x: { kind: "increased" } });
    const out = formatDeltas(r);
    expect(out).toMatch(/ON-CHAIN ASSERTION FAILED/);
    expect(out).toMatch(/all probes:/);
    expect(out).toMatch(/y\s+5 → 9/);
  });
});

describe("waitForSuccess", () => {
  /**
   * A reverted transaction STILL produces a receipt. Code that only awaits the receipt
   * treats a revert as success — and the UI shows a spinner ending, which is exactly how
   * a broken flow looks like a working one.
   */
  it("throws on a reverted transaction instead of returning quietly", async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);

    // Call a non-existent function on an EOA-free address with data — reverts on Anvil.
    const hash = await client.sendTransaction({
      account: ANVIL_ACCOUNT,
      to: "0x000000000000000000000000000000000000dEaD",
      data: "0xdeadbeef",
      gas: 100_000n,
      chain: foundry,
    });

    // Sending data to an address with no code succeeds; assert the helper reports honestly.
    await expect(waitForSuccess(client, hash)).resolves.toBeUndefined();
  });

  /**
   * ══ The throw itself, against a transaction that genuinely reverted ══
   *
   * The test above is a control: it proves the helper does not cry wolf on a transaction
   * that merely *looked* odd (data sent to a codeless address succeeds on the EVM). But
   * it meant the actual revert branch — the entire reason this function exists — had
   * never executed. A `waitForSuccess` that never throws is indistinguishable from a bare
   * `waitForTransactionReceipt`, which is precisely the bug it was written to prevent.
   *
   * So this drives a REAL revert: the fixture's `transfer` has a
   * `require(balanceOf[msg.sender] >= amount, "insufficient")`, and the second Anvil
   * account holds no tokens. The transaction is mined, it produces a receipt, and its
   * status is `reverted`.
   *
   * `gas` is set explicitly because estimation would reject the call before it is ever
   * sent — and a transaction that never reaches the chain produces no receipt, which
   * would test nothing at all.
   *
   * The message must carry the hash and the block: a revert discovered later is
   * investigated by looking the transaction up, and "assertion failed" sends nobody
   * anywhere.
   */
  it("throws on a REAL revert, which still produced a receipt", async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);
    const { deployContract } = await import("viem/actions");

    const abi = [
      { type: "constructor", inputs: [], stateMutability: "nonpayable" },
      {
        type: "function",
        name: "transfer",
        inputs: [{ type: "address" }, { type: "uint256" }],
        outputs: [{ type: "bool" }],
        stateMutability: "nonpayable",
      },
    ] as const;

    const deployHash = await deployContract(client, {
      abi,
      bytecode: TEST_TOKEN_BYTECODE,
      account: ANVIL_ACCOUNT,
      chain: foundry,
    });
    const token = (await client.waitForTransactionReceipt({ hash: deployHash }))
      .contractAddress as `0x${string}`;

    // SECOND holds zero tokens, so the require() fails on chain.
    const hash = await client.writeContract({
      address: token,
      abi,
      functionName: "transfer",
      args: [ANVIL_ACCOUNT, 1n],
      account: SECOND,
      chain: foundry,
      gas: 200_000n, // Skip estimation, which would refuse to send a reverting call.
    });

    // The receipt exists and is a normal, mined receipt — this is the trap.
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status, "the fixture must actually revert for this test to mean anything").toBe(
      "reverted",
    );

    await expect(
      waitForSuccess(client, hash),
      "a reverted transaction must throw, not return quietly",
    ).rejects.toThrow(/REVERTED/);

    // The message has to be actionable: which transaction, and where to find it.
    await expect(waitForSuccess(client, hash)).rejects.toThrow(
      new RegExp(`transaction ${hash} REVERTED in block ${receipt.blockNumber}`),
    );
    await expect(waitForSuccess(client, hash)).rejects.toThrow(/the flow did not do what the UI/);
  });
});

describe("probes", () => {
  it("reads an ERC-20 balance and total supply from a real contract", async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);

    // Minimal ERC-20: constructor mints 1000 to deployer. Compiled bytecode inlined so the
    // test needs no build step — it exercises the real readContract path either way.
    const { deployContract } = await import("viem/actions");
    const abi = [
      { type: "constructor", inputs: [], stateMutability: "nonpayable" },
      {
        type: "function",
        name: "balanceOf",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }],
        stateMutability: "view",
      },
      {
        type: "function",
        name: "totalSupply",
        inputs: [],
        outputs: [{ type: "uint256" }],
        stateMutability: "view",
      },
    ] as const;

    let token: `0x${string}`;
    try {
      const hash = await deployContract(client, {
        abi,
        bytecode: TEST_TOKEN_BYTECODE,
        account: ANVIL_ACCOUNT,
        chain: foundry,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      token = receipt.contractAddress as `0x${string}`;
    } catch (error) {
      // Fail loudly. This was previously a bare `return`, which silently passed whenever
      // the deploy broke — a hidden skip contradicting this project's loudest rule.
      throw new Error(`the probe fixture must deploy; a failed deploy is a real bug: ${error}`);
    }

    const { tokenBalance, totalSupply } = await import("./onchain.js");
    const state = await snapshot(client, [
      tokenBalance(token, ANVIL_ACCOUNT, "held"),
      totalSupply(token, "supply"),
    ]);
    expect(state.supply).toBeGreaterThan(0n);
    expect(state.held).toBe(state.supply);
  });

  it("builds probes with the labels callers give them", async () => {
    const { tokenBalance, totalSupply, nftBalance, readsUint } = await import("./onchain.js");
    const t = "0x1111111111111111111111111111111111111111" as const;
    expect(tokenBalance(t, ANVIL_ACCOUNT).label).toBe("tokenBalance");
    expect(tokenBalance(t, ANVIL_ACCOUNT, "mine").label).toBe("mine");
    expect(totalSupply(t).label).toBe("totalSupply");
    expect(nftBalance(t, ANVIL_ACCOUNT).label).toBe("nftBalance");
    expect(readsUint({ contract: t, getter: "progress" }).label).toBe("progress");
    expect(readsUint({ contract: t, getter: "progress", label: "curve" }).label).toBe("curve");
  });

  it("reads a custom uint getter from a real contract", async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);
    const { deployContract } = await import("viem/actions");
    const { readsUint } = await import("./onchain.js");

    const abi = [
      { type: "constructor", inputs: [], stateMutability: "nonpayable" },
      {
        type: "function",
        name: "progress",
        inputs: [],
        outputs: [{ type: "uint256" }],
        stateMutability: "view",
      },
    ] as const;
    const hash = await deployContract(client, {
      abi,
      bytecode: TEST_TOKEN_BYTECODE,
      account: ANVIL_ACCOUNT,
      chain: foundry,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const contract = receipt.contractAddress as `0x${string}`;

    // Any view function returning a uint — a curve's progress, an XP counter, a reserve.
    const probe = readsUint({ contract, getter: "progress", label: "curveProgress" });
    expect(await probe.read(client)).toBe(42n);
  });

  /**
   * ══ A getter that takes arguments ══
   *
   * A coverage audit found the `inputs` mapping in `readsUint` had never run: every
   * existing test used a no-arg getter, so a probe for something like `priceAt(uint256)`
   * or `balanceOf(address)` had never been constructed at all.
   *
   * The fixture's `balanceOf(address)` returns a uint, so it exercises the arg path end
   * to end — the ABI is built with one input, encoded, and read from a live chain.
   *
   * Note this deliberately asserts the VALUE, not merely that it resolved. An ABI built
   * with the wrong arity encodes a call that silently reads the wrong slot, and a probe
   * returning a plausible-but-wrong number is worse than one that throws.
   */
  it("builds a probe for a getter that takes arguments", async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);
    const { deployContract } = await import("viem/actions");
    const { readsUint } = await import("./onchain.js");

    const hash = await deployContract(client, {
      abi: [{ type: "constructor", inputs: [], stateMutability: "nonpayable" }] as const,
      bytecode: TEST_TOKEN_BYTECODE,
      account: ANVIL_ACCOUNT,
      chain: foundry,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const contract = receipt.contractAddress as `0x${string}`;

    const probe = readsUint({
      contract,
      getter: "balanceOf",
      args: [ANVIL_ACCOUNT],
      label: "holderBalance",
    });
    expect(probe.label).toBe("holderBalance");
    /**
     * A NUMERIC argument must still build a `uint256` input.
     *
     * Sabotage established this is needed: making every argument an `address` passed all
     * 14 tests, because none used a numeric argument — swapping one wrong assumption for
     * another would have gone unnoticed.
     *
     * Asserted directly on `solidityTypeOf`, the unit that makes the decision. A live
     * call cannot distinguish the cases here: the fixture's `balanceOf` is a
     * `mapping(address => uint256)` getter, so a uint argument builds a selector that
     * does not exist and reverts — correct behaviour that proves nothing about encoding.
     */
    const { solidityTypeOf } = await import("./onchain.js");
    expect(solidityTypeOf(1n), "a bigint is a uint256").toBe("uint256");
    expect(solidityTypeOf(42), "a number is a uint256").toBe("uint256");
    expect(solidityTypeOf(ANVIL_ACCOUNT), "a 20-byte hex string is an address").toBe("address");
    expect(solidityTypeOf(true), "a boolean is a bool").toBe("bool");
    // A hex string that is NOT 20 bytes is not an address — a bytes32 hash, say.
    expect(solidityTypeOf(`0x${"ab".repeat(32)}`), "a 32-byte value is not an address").toBe(
      "uint256",
    );
    // The deployer holds the entire supply — a wrong-arity ABI would read a different
    // slot and return something else entirely.
    expect(await probe.read(client)).toBe(TEST_TOKEN_SUPPLY);
  });

  /**
   * ══ The probe closure, actually called ══
   *
   * A coverage audit found `nftBalance`'s `read` had never executed — earlier tests
   * asserted only its `label`, so the ABI and the call itself were unverified. A probe
   * that builds a wrong call is worse than no probe: `assertDelta` would report "no
   * change" for a transfer that really happened, and a broken flow would read as passing.
   *
   * ERC-721's `balanceOf(address)` has the same signature as ERC-20's, so the fixture
   * exercises the real call path — the ABI encoding, the read, and the returned type.
   */
  it("calls the nftBalance probe against a real contract", async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);
    const { deployContract } = await import("viem/actions");
    const { nftBalance } = await import("./onchain.js");

    const hash = await deployContract(client, {
      abi: [{ type: "constructor", inputs: [], stateMutability: "nonpayable" }] as const,
      bytecode: TEST_TOKEN_BYTECODE,
      account: ANVIL_ACCOUNT,
      chain: foundry,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const collection = receipt.contractAddress as `0x${string}`;

    const probe = nftBalance(collection, ANVIL_ACCOUNT);
    // The deployer holds the whole supply, so a non-zero read proves the call landed.
    expect(await probe.read(client)).toBeGreaterThan(0n);

    // And an address that holds nothing reads zero rather than reverting — the case
    // that would otherwise surface as a probe failure mid-flow.
    const empty = nftBalance(collection, "0x000000000000000000000000000000000000dEaD");
    expect(await empty.read(client)).toBe(0n);
  });
});
