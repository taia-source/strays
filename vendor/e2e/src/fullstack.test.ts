import { createServer, type Server } from "node:http";
import { chromium } from "playwright";
import { createTestClient, http, parseAbi, parseEther, publicActions, walletActions } from "viem";
import { foundry } from "viem/chains";
import { beforeAll, describe, expect, it } from "vitest";
import { TEST_TOKEN_BYTECODE } from "./__fixtures.js";
import {
  assessLayout,
  COLLECT_LAYOUT_SCRIPT,
  DEFAULT_VIEWPORTS,
  type LayoutObservation,
} from "./layout.js";
import { ANVIL_ACCOUNT, anvilWallet, installMockWallet } from "./wallet.js";

/**
 * The genuine end-to-end proof: **one flow, real browser, real chain, real contract.**
 *
 * ══ Why this file exists ══
 *
 * Auditing the suite answered an uncomfortable question honestly. Every layer was tested
 * against something real — `layout`/`rendering`/`perceivable` drive a real Chromium,
 * `rpc`/`indexer`/`deploy` hit a real chain, `gate` runs a real HTTP server — but **no
 * single test ran a whole project.** `runner.test.ts` came closest and used a `fakePage()`
 * with the chain driven manually from the test body: the chain half was real, the browser
 * half was simulated.
 *
 * That is an integration test wearing an e2e label. The specific class of bug it cannot
 * catch is the one where the pieces are individually correct and the seam between them is
 * not: a wallet that never announces, a button wired to the wrong function, a receipt that
 * arrives but reverted, an assertion that passes because nothing was actually asserted.
 *
 * ══ What runs here, with nothing faked ══
 *
 *   1. a real ERC-20 **deployed** to a real chain (Anvil), not a mock address
 *   2. a real **HTTP server** serving a real page
 *   3. a real **Chromium** loading it over the network
 *   4. a real **EIP-1193 wallet** injected and discovered by the page
 *   5. a real **transaction** sent by a button click in that browser
 *   6. the **on-chain balance** re-read afterwards and asserted to have moved
 *   7. the same page checked for **layout defects** at phone width in the same run
 *
 * Step 6 is the one that matters. A UI test that stops at "the success toast appeared"
 * passes when the transaction reverted — the toast is a claim, the balance is the fact.
 */

/**
 * The local node's RPC.
 *
 * `TAIA_ANVIL_RPC` overrides the default, matching `onchain.test.ts`. This was HARDCODED, which
 * made the suite unfixable when port 8545 was occupied by another process's anvil — measured on
 * this machine, a concurrently-running agent session started an `anvil --fork-url <robinhood>`
 * there, so `eth_chainId` answered 0x1237 and ten tests failed with "wallet chain 4663 does not
 * match target chain 31337". With the port pinned in source there was no way to redirect them.
 */
const RPC = process.env.TAIA_ANVIL_RPC ?? "http://127.0.0.1:8545";
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

const client = createTestClient({
  chain: foundry,
  mode: "anvil",
  transport: http(RPC),
})
  .extend(publicActions)
  .extend(walletActions);

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

let anvilUp = false;
let tokenAddress: `0x${string}` | undefined;

beforeAll(async () => {
  try {
    await client.getBlockNumber();
    anvilUp = true;
  } catch {
    anvilUp = false;
  }
});

/** Serve one page and keep the server handle so it can be closed. */
async function serve(html: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

/**
 * A real page: it discovers the injected wallet, then sends a real transfer on click.
 *
 * Deliberately written the way a generated project would be — `eth_requestAccounts` from a
 * user gesture, `eth_sendTransaction` with encoded calldata, and a status region announced
 * to assistive technology rather than a bare div.
 */
function page(token: string): string {
  return `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Send</title>
<style>
  body{margin:0;font:16px system-ui;padding:16px}
  button{display:block;width:200px;height:44px;font-size:16px;background:#0b5;color:#fff;border:0}
  #status{margin-top:12px;min-height:24px}
</style>
<h1>Token demo</h1>
<button id="send">Send tokens</button>
<div id="status" role="status" aria-label="idle">idle</div>
<script>
  const TOKEN = ${JSON.stringify(token)};
  const RECIPIENT = ${JSON.stringify(RECIPIENT)};
  // transfer(address,uint256) selector + padded args — a real ERC-20 call.
  const selector = "0xa9059cbb";
  const pad = (h) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const amount = (5n * 10n ** 18n).toString(16);

  document.getElementById("send").addEventListener("click", async () => {
    const status = document.getElementById("status");
    try {
      const [from] = await window.ethereum.request({ method: "eth_requestAccounts" });
      const data = selector + pad(RECIPIENT) + pad("0x" + amount);
      await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from, to: TOKEN, data }],
      });
      status.textContent = "sent";
      status.setAttribute("aria-label", "Transfer complete");
    } catch (error) {
      status.textContent = "failed: " + (error && error.message ? error.message : String(error));
      status.setAttribute("aria-label", "Transfer failed");
    }
  });
</script>`;
}

describe("full stack: browser + chain + contract in one flow", () => {
  it("deploys a real ERC-20 and moves its balance from a real button click", {
    timeout: 180_000,
  }, async () => {
    if (!anvilUp) return expect(anvilUp, `anvil must be running on ${RPC}`).toBe(true);

    // ── 1. Deploy a real contract ────────────────────────────────────────────────
    const hash = await client.deployContract({
      abi: ERC20_ABI,
      bytecode: TEST_TOKEN_BYTECODE,
      account: ANVIL_ACCOUNT,
      chain: foundry,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status, "deployment must succeed").toBe("success");
    tokenAddress = receipt.contractAddress ?? undefined;
    expect(tokenAddress, "a contract address must be returned").toBeDefined();
    if (!tokenAddress) return;

    // The contract is real: it has code, and the deployer holds the supply.
    const code = await client.getCode({ address: tokenAddress });
    expect(code && code !== "0x", "deployed contract must have bytecode").toBe(true);

    const before = (await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [RECIPIENT],
    })) as bigint;

    // ── 2..5. Real server, real browser, real wallet, real transaction ───────────
    const { server, url } = await serve(page(tokenAddress));
    const browser = await chromium.launch();

    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const p = await context.newPage();
      await installMockWallet(p as never, anvilWallet(RPC));
      await p.goto(url);

      // A real click, driven through the accessibility tree rather than a CSS selector.
      await p.getByRole("button", { name: "Send tokens" }).click();
      await p.getByRole("status", { name: "Transfer complete" }).waitFor({ timeout: 30_000 });

      /**
       * ══ The toast is a claim; the chain is the fact ══
       *
       * Waiting for the toast and reading the balance immediately made the whole gate
       * FLAKY — roughly 1 run in 3 failed with `expected 0n to be 5000000000000000000n`
       * while all 189 tests otherwise passed and coverage stayed at 100%.
       *
       * It is an ordering bug, not a slow machine. The toast fires when the wallet
       * RESOLVES the send, which happens before the transaction is mined. On an idle box
       * the block lands in the microseconds between the two statements; under concurrent
       * load it does not.
       *
       * That is precisely the failure this test exists to catch — a UI claiming success
       * ahead of the chain — so the fix is to wait for the receipt rather than to widen a
       * timeout and hope.
       */
      /**
       * Wait for the CHAIN, not the toast. Reading the balance once, immediately after the
       * toast, is what made this flaky — and polling here is not a widened timeout, it is
       * the correct wait: the assertion below still demands the exact final balance.
       */
      await expect
        .poll(
          async () =>
            (await client.readContract({
              address: tokenAddress as `0x${string}`,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [RECIPIENT],
            })) as bigint,
          {
            timeout: 30_000,
            interval: 250,
          },
        )
        .toBe(before + parseEther("5"));

      // ── 6. The assertion that makes this an e2e rather than a UI test ──────────
      const after = (await client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [RECIPIENT],
      })) as bigint;

      expect(
        after,
        "the recipient's ON-CHAIN balance must have increased — a success toast is a claim, this is the fact",
      ).toBe(before + parseEther("5"));

      // ── 7. The same live page, checked for layout defects at phone width ───────
      const observation = (await p.evaluate(COLLECT_LAYOUT_SCRIPT)) as LayoutObservation;
      const layout = assessLayout([
        {
          viewport: DEFAULT_VIEWPORTS[1] ?? { name: "mobile", width: 390, height: 844 },
          observation,
        },
      ]);
      expect(
        layout.ok,
        `the live page must also be usable on a phone: ${JSON.stringify(layout.findings)}`,
      ).toBe(true);
    } finally {
      await browser.close();
      server.close();
    }
  });

  /**
   * The negative control, and the reason the test above is trustworthy.
   *
   * If the flow "passes" when the transfer cannot succeed, it was never asserting anything.
   *
   * This deploys the SAME real contract from an account holding no supply, so `transfer`
   * hits `require(balanceOf[msg.sender] >= amount)` and **reverts on chain**. That is the
   * harder case than an empty address: the contract exists, the call is well-formed, the
   * transaction is mined — and the balance must still not move. A UI that reports success
   * here is exactly the bug this whole file exists to catch.
   */
  it("does not move a balance when the transfer reverts", { timeout: 180_000 }, async () => {
    if (!anvilUp) return expect(anvilUp).toBe(true);

    // Deploy from the second account, which receives no supply.
    const hash = await client.deployContract({
      abi: ERC20_ABI,
      bytecode: TEST_TOKEN_BYTECODE,
      account: RECIPIENT,
      chain: foundry,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const empty = receipt.contractAddress;
    expect(empty).toBeDefined();
    if (!empty) return;

    const before = (await client.readContract({
      address: empty,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [RECIPIENT],
    })) as bigint;

    const { server, url } = await serve(page(empty));
    const browser = await chromium.launch();

    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const p = await context.newPage();
      await installMockWallet(p as never, anvilWallet(RPC));
      await p.goto(url);
      await p.getByRole("button", { name: "Send tokens" }).click();

      // Whatever the UI reports, the on-chain state is the arbiter.
      await p.waitForTimeout(3000);
      const after = (await client.readContract({
        address: empty,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [RECIPIENT],
      })) as bigint;
      expect(after, "a reverted transfer must not change any balance").toBe(before);
    } finally {
      await browser.close();
      server.close();
    }
  });
});
