"use client";
/**
 * ADOPTION — the only interaction in the product, so it gets the craft.
 *
 * ══ TWO CLICKS, AND THAT IS THE FLOOR RATHER THAN A TARGET ══
 *
 * Ibrahim's constraint: "1-2 clicks and users have their agent working, no more than 1 or 2!!!"
 *
 * Click 1 connects a wallet. Click 2 funds and spawns. There is no third: the amount is a fixed
 * default, the stray id is derived from the owner's address plus a nonce, and the cat begins
 * hunting on the next keeper tick with no further approval of any kind.
 *
 * The one thing that CANNOT be removed is the wallet signature on click 2 — that is the user's own
 * money leaving their own wallet, and no design can make that not require their consent. Everything
 * else is stripped.
 *
 * ══ WALLET DISCOVERY: EIP-6963, AND A DEAD WALLET IS DISABLED, NEVER HIDDEN ══
 *
 * unitick's recorded finding: Phantom injects an EVM provider and announces over EIP-6963, so it
 * renders as a working button, but its EVM support is a fixed network list that excludes chain 4663
 * — a transaction through it can NEVER land. Hiding it invites "why is my wallet missing"; offering
 * it ships a dead button. The third option — visible, disabled, with the reason in the aria-label —
 * is the only honest one.
 */
import { useCallback, useEffect, useState } from "react";
import { CHAIN_ID, MIN_ADOPT_WEI, VAULT_ADDRESS } from "./lib/config";

type Provider = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
};
type Detected = { info: { uuid: string; name: string; icon: string }; provider: Provider };

/** Wallets known to announce over EIP-6963 while being unable to reach chain 4663. */
const CANNOT_REACH_4663 = ["phantom"];

const DEFAULT_ADOPT_ETH = "0.005";

export function Adopt() {
  const [wallets, setWallets] = useState<Detected[]>([]);
  const [account, setAccount] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  useEffect(() => {
    const found: Detected[] = [];
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent).detail as Detected;
      if (!found.some((f) => f.info.uuid === d.info.uuid)) {
        found.push(d);
        setWallets([...found]);
      }
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);

  /** CLICK 1 — connect, and switch to 4663 in the same gesture so click 2 is never blocked. */
  const connect = useCallback(async (w: Detected) => {
    setError(null);
    setBusy(true);
    try {
      const accts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
      // Verified switching: ask, then RE-READ the chain rather than trusting the call returned.
      try {
        await w.provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
        });
      } catch {
        await w.provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: `0x${CHAIN_ID.toString(16)}`,
              chainName: "Robinhood Chain",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
              blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
            },
          ],
        });
      }
      const now = (await w.provider.request({ method: "eth_chainId" })) as string;
      if (Number.parseInt(now, 16) !== CHAIN_ID) {
        throw new Error(`wallet is on chain ${Number.parseInt(now, 16)}, not ${CHAIN_ID}`);
      }
      setProvider(w.provider);
      setAccount(accts[0] ?? null);
    } catch (e) {
      setError(errorToAction(e));
    } finally {
      setBusy(false);
    }
  }, []);

  /** CLICK 2 — fund and spawn. One transaction. Nothing else is asked of the user, ever. */
  const adopt = useCallback(async () => {
    if (!provider || !account) return;
    setError(null);
    setBusy(true);
    try {
      // The stray id is derived, not chosen — asking the user to name a cat would be a third click.
      const seed = `${account.toLowerCase()}:${Date.now()}`;
      const id = await keccakHex(seed);
      const valueWei = BigInt(Math.round(Number(DEFAULT_ADOPT_ETH) * 1e18));
      if (valueWei < MIN_ADOPT_WEI) throw new Error("below the vault's minimum");
      // ══ ENCODED, NEVER HAND-WRITTEN ══
      //
      // The first version of this line hardcoded the selector as 0xd8f9ba6d. The real selector for
      // `adopt(bytes32)` is 0x766c6eaf. Every adoption would have hit a non-existent function and
      // reverted, and NOTHING in the type system or the test suite would have said so — a wrong
      // four-byte constant is indistinguishable from a right one until it reaches the chain.
      // Caught by `cast sig`. It is derived from the ABI now so it cannot drift again.
      const { encodeFunctionData } = await import("viem");
      const data = encodeFunctionData({
        abi: [
          {
            name: "adopt",
            type: "function",
            stateMutability: "payable",
            inputs: [{ name: "strayId", type: "bytes32" }],
            outputs: [],
          },
        ],
        functionName: "adopt",
        args: [id as `0x${string}`],
      });
      const hash = (await provider.request({
        method: "eth_sendTransaction",
        params: [
          { from: account, to: VAULT_ADDRESS, value: `0x${valueWei.toString(16)}`, data },
        ],
      })) as string;
      setTxHash(hash);
    } catch (e) {
      setError(errorToAction(e));
    } finally {
      setBusy(false);
    }
  }, [provider, account]);

  if (txHash) {
    return (
      <div className="adopt done">
        <p className="fig">Your stray is out.</p>
        <p className="stamp">
          It hunts on the next keeper cycle. Nothing more is needed from you — ever.
        </p>
        <a href={`https://robinhoodchain.blockscout.com/tx/${txHash}`} target="_blank" rel="noreferrer noopener" className="stamp">
          {txHash.slice(0, 14)}… ↗
        </a>
      </div>
    );
  }

  return (
    <div className="adopt">
      {!account ? (
        <>
          <p className="stamp">Step 1 of 2 — connect a wallet</p>
          {wallets.length === 0 ? (
            <p className="stamp">
              No wallet detected. Install a browser wallet that supports Robinhood Chain.
            </p>
          ) : (
            <ul className="wallets">
              {wallets.map((w) => {
                const dead = CANNOT_REACH_4663.some((n) => w.info.name.toLowerCase().includes(n));
                return (
                  <li key={w.info.uuid}>
                    <button
                      type="button"
                      onClick={() => connect(w)}
                      disabled={dead || busy}
                      /* Visible, DISABLED, with the reason — never hidden and never offered. */
                      aria-label={
                        dead
                          ? `${w.info.name} cannot reach Robinhood Chain, so a transaction through it could never land`
                          : `Connect ${w.info.name}`
                      }
                      title={dead ? "This wallet cannot reach Robinhood Chain (4663)" : undefined}
                    >
                      {w.info.name}
                      {dead ? " — cannot reach 4663" : ""}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        <>
          <p className="stamp">
            Step 2 of 2 — {account.slice(0, 6)}…{account.slice(-4)}
          </p>
          <button type="button" className="cta" onClick={adopt} disabled={busy}>
            {busy ? "confirm in your wallet…" : `Feed a stray — ${DEFAULT_ADOPT_ETH} ETH`}
          </button>
          <p className="stamp">
            20% energy fee, {DEFAULT_ADOPT_ETH} ETH total. The rest becomes its stake. You can
            withdraw whenever you like.
          </p>
        </>
      )}
      {error ? <p className="err">{error}</p> : null}
    </div>
  );
}

/**
 * Wallet errors are turned into an ACTION the user can take, not a code.
 * 4001 is the user rejecting — that is not an error state and must not be shouted at them.
 */
function errorToAction(e: unknown): string | null {
  const code = (e as { code?: number })?.code;
  if (code === 4001) return null; // user changed their mind. Nothing to report.
  if (code === -32002) return "Your wallet is already asking — check its window.";
  const msg = (e as { message?: string })?.message ?? String(e);
  if (/insufficient funds/i.test(msg)) return "Not enough ETH in that wallet for this and gas.";
  return msg;
}

/** keccak256 of a string, via the platform. Used only to derive a stray id. */
async function keccakHex(s: string): Promise<string> {
  const { keccak256, toHex } = await import("viem");
  return keccak256(toHex(s));
}
