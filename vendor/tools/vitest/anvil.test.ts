import { describe, expect, it } from "vitest";
import { anvilAvailable, startAnvil } from "./anvil.js";

/**
 * The fixture that makes reorg testing shippable, tested itself.
 *
 * Its whole purpose is isolation, so the load-bearing assertion is that two instances get
 * different ports and cannot see each other's chains.
 */
describe("startAnvil", () => {
  it("reports plainly when the binary is missing rather than skipping", async () => {
    const reason = await anvilAvailable("definitely-not-a-real-binary-name");
    expect(reason, "a missing binary must produce an actionable reason").toContain("not found");
  });

  it("starts and answers on its own port", { timeout: 60_000 }, async () => {
    const unavailable = await anvilAvailable();
    expect(unavailable, unavailable ?? "").toBeUndefined();

    const anvil = await startAnvil();
    try {
      expect(anvil.port).toBeGreaterThan(0);
      const response = await fetch(anvil.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      const body = (await response.json()) as { result?: string };
      expect(body.result, "a fresh anvil starts at block 0").toBe("0x0");
    } finally {
      await anvil.stop();
    }
  });

  /**
   * The assertion the whole fixture exists for.
   *
   * `anvil_reorg` rewrites history — measured, it kept the height at 0x5 while replacing
   * block 5's hash. If two instances shared a port or a chain, one test's reorg would
   * silently rewrite another's blocks, which is exactly the flakiness that got the first
   * attempt at reorg testing parked.
   */
  it("gives each instance a distinct, genuinely separate chain", { timeout: 60_000 }, async () => {
    const unavailable = await anvilAvailable();
    expect(unavailable, unavailable ?? "").toBeUndefined();

    const [a, b] = await Promise.all([startAnvil(), startAnvil()]);
    try {
      expect(a.port, "OS-assigned ports must not collide").not.toBe(b.port);

      const mine = async (url: string, blocks: number) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_mine", params: [blocks] }),
        });
      const height = async (url: string) => {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        });
        return ((await r.json()) as { result: string }).result;
      };

      // Advance ONLY the first chain. The second must be untouched.
      await mine(a.rpcUrl, 7);
      expect(await height(a.rpcUrl)).toBe("0x7");
      expect(await height(b.rpcUrl), "a second instance must not see the first's blocks").toBe(
        "0x0",
      );
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  it("refuses --silent, which would hide the port it depends on", () => {
    // Measured: --silent suppresses the "Listening on" line, and --config-out carries no
    // port field, so the instance would be unreachable rather than merely quiet.
    expect(() => startAnvil({ args: ["--silent"] })).toThrow(/undiscoverable/);
  });

  it("stop() is safe to call twice", { timeout: 60_000 }, async () => {
    const unavailable = await anvilAvailable();
    expect(unavailable, unavailable ?? "").toBeUndefined();

    const anvil = await startAnvil();
    await anvil.stop();
    await expect(anvil.stop()).resolves.toBeUndefined();
  });

  it("fails loudly when the binary cannot start", { timeout: 60_000 }, async () => {
    await expect(startAnvil({ bin: "definitely-not-a-real-binary-name" })).rejects.toThrow(
      /failed to start|could not spawn/,
    );
  });
});
