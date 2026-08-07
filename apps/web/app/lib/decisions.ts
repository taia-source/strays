/**
 * The decision feed, read from the vault's own events.
 *
 * Reading EVENTS rather than a database is deliberate for this page: the events are the chain's
 * own record, so nothing here can drift from what actually happened. An indexer mirror exists for
 * speed, but the authoritative surface for "prove the cat did this" must be the chain.
 *
 * ══ WHAT WAS WRONG HERE, AND WHY IT WAS THE SAME BUG TWICE ══
 *
 * Ibrahim: *"why not showing pnls in logs and what token it bought?"* A row read
 * `HUNT bought 561427.711 units for 0.0012 ETH`. Both halves of his complaint were the same defect:
 * the events carry the information and this module decoded it and dropped it on the floor.
 *
 *   - `Entered(strayId, token, ethIn, tokensOut, tickSpacing)` — `token` was decoded into `a.token`
 *     and never read, so a trade row could not say WHAT was bought.
 *   - `Exited(strayId, token, tokensIn, ethOut)` — `ethOut` was rendered on its own, next to an
 *     `ethIn` four rows above it, and the subtraction that turns those two numbers into the only
 *     figure a reader actually wants was left to the reader.
 *
 * So this module now carries the token address on every trade row and PAIRS each exit with the
 * entry that opened it. The pairing is the substance: a `sold back for 0.00117 ETH` row is not
 * information, and `−0.0000239 ETH (−199 bps)` is.
 *
 * ══ WHY THE PnL IS ON THE EXIT ROW AND NOWHERE ELSE ══
 *
 * A position that is still OPEN has no realised PnL, and the number it would have if closed right
 * now is a MARK, not a result — it needs a live price, which this module deliberately does not
 * fetch. `DESIGN.md` §9 bans presenting a projection as an outcome, and an unrealised mark drawn in
 * the same amber as a closed win is exactly that. An open entry therefore carries `pnl: null` and
 * renders as "open", which is the true statement.
 *
 * ══ AND WHY A LOSS IS COMPUTED THE SAME WAY AS A WIN ══
 *
 * §9: **no hidden losses.** There is no floor, no `Math.max(0, …)`, and no branch that treats a
 * negative differently from a positive anywhere below. The only real round trip on chain at the
 * time of writing is a LOSS — 0.0012 ETH in, 0.00117612 ETH out, −199 bps, which is the pad's own
 * 1% tax charged on both legs — and the page has to say so as loudly as it would say a gain. A PnL
 * column that has never been exercised against a losing trade is a column nobody has tested.
 */
import { createPublicClient, http, parseAbi, formatEther } from "viem";
import { CHAIN_ID, RPC_URL, VAULT_ADDRESS, VAULT_DEPLOY_BLOCK } from "./config";

/**
 * The realised result of one closed round trip, in the two units that answer different questions.
 *
 * `eth` answers "how much money", `bps` answers "how bad was it" — and they are not
 * interchangeable. A 0.00002 ETH loss sounds like nothing until it is stated as −199 bps on a
 * position, and a large ETH loss on a large position may be a smaller proportional hit than a small
 * one. Both are shown for that reason.
 */
export type RoundTrip = {
  /** `ethOut - ethIn`, signed, in ETH. Negative is a loss and is never clamped. */
  readonly eth: number;
  /** The same result as basis points of the amount risked. `null` when `ethIn` was 0. */
  readonly bps: number | null;
  readonly ethIn: number;
  readonly ethOut: number;
  /** The block the position was OPENED in, so a reader can find the other half of the pair. */
  readonly openedAtBlock: bigint;
};

export type DecisionRow = {
  readonly strayId: `0x${string}`;
  readonly action: "hunt" | "flee" | "adopt" | "withdraw";
  readonly rationale: string;
  readonly outcome: "landed" | "failed";
  readonly txHash: `0x${string}` | null;
  readonly block: bigint;
  readonly at: number;
  /** The traded token, on `hunt` and `flee` rows. `null` on adopt/withdraw, which trade nothing. */
  readonly token: `0x${string}` | null;
  /**
   * The realised result, on a `flee` row that could be paired with its entry.
   *
   * `null` on every other row, and that covers two genuinely different cases which the renderer
   * must not merge: an OPEN position (a `hunt` with no matching `flee` yet) and an UNPAIRABLE exit
   * (an exit whose entry predates the scan window). Neither may be drawn as a zero — a zero is a
   * break-even trade, which is a claim, and we do not have the evidence for it.
   */
  readonly pnl: RoundTrip | null;
  /** True on a `hunt` row whose position is still open at the head block. */
  readonly open: boolean;
};

const ABI = parseAbi([
  "event Adopted(bytes32 indexed strayId, address indexed owner, uint256 stake, uint256 energyFee)",
  "event Entered(bytes32 indexed strayId, address indexed token, uint256 ethIn, uint256 tokensOut, int24 tickSpacing)",
  "event Exited(bytes32 indexed strayId, address indexed token, uint256 tokensIn, uint256 ethOut)",
  "event Withdrawn(bytes32 indexed strayId, address indexed owner, uint256 paid, uint256 rake)",
]);

const client = createPublicClient({
  transport: http(RPC_URL),
  chain: {
    id: CHAIN_ID, name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  },
});

/** A stray+token pair. One cat's position in one token — the unit a round trip closes over. */
function positionKey(strayId: string, token: string): string {
  return `${strayId.toLowerCase()}:${token.toLowerCase()}`;
}

/** `formatEther` then `Number`, for arithmetic. Wei is exact; a display figure does not need to be. */
function ethNum(wei: bigint): number {
  return Number(formatEther(wei));
}

/**
 * Trim a float to a fixed width without the trailing-zero noise.
 *
 * `toFixed` alone gives `0.00002388000`; `Number()` round-trips it back to `0.00002388`. Trades on
 * this chain are ~0.001 ETH, so eight places is where the significant digits actually live —
 * `toFixed(4)` would render every single trade on the page as `0.0000`.
 */
function trimEth(n: number): string {
  const s = n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" || s === "" ? "0" : s;
}

export async function recentDecisions(limit = 100): Promise<{
  rows: readonly DecisionRow[]; block: bigint; at: number;
}> {
  const at = Date.now();
  const block = await client.getBlockNumber();
  // Same rule as chain.ts: the vault did not exist before its deploy block.
  const logs = await client.getLogs({ address: VAULT_ADDRESS, events: ABI, fromBlock: VAULT_DEPLOY_BLOCK, toBlock: block });

  /*
   * ══ THE PAIRING PASS ══
   *
   * `getLogs` returns ascending by block, which is what makes a single forward pass correct: when
   * an `Exited` is reached, every `Entered` that could have opened it has already been seen.
   *
   * The open lot per stray+token is a STACK, and the exit pops the most recent entry (LIFO). The
   * vault takes one position per stray at a time, so in practice the stack is never deeper than
   * one — but a queue and a stack differ the moment that assumption breaks, and popping the LATEST
   * entry keeps a re-entered position pairing with the leg that actually funded it rather than with
   * a months-old opening. Getting this wrong would silently mis-attribute a PnL, which is worse
   * than showing none: a wrong number is indistinguishable from a right one.
   *
   * An exit with an EMPTY stack keeps `pnl: null`. That is the entry-predates-the-scan-window case,
   * and inventing a cost basis of zero for it would render a total loss of the position as a total
   * PROFIT of the exit proceeds — the single most dangerous possible defect on this page.
   */
  const open = new Map<string, { ethIn: bigint; block: bigint }[]>();
  /** Row index of each still-open entry, so the `open` flag can be set after the pass. */
  const openRowIndex = new Map<string, number[]>();

  const rows: DecisionRow[] = logs.map((l, i) => {
    const name = (l as { eventName?: string }).eventName ?? "";
    const a = (l as { args: Record<string, unknown> }).args;
    const base = {
      strayId: a.strayId as `0x${string}`,
      outcome: "landed" as const,
      txHash: l.transactionHash,
      block: l.blockNumber ?? 0n,
      at,
      token: null,
      pnl: null,
      open: false,
    };

    if (name === "Entered") {
      const token = a.token as `0x${string}`;
      const ethIn = a.ethIn as bigint;
      const key = positionKey(base.strayId, token);
      const lots = open.get(key) ?? [];
      lots.push({ ethIn, block: base.block });
      open.set(key, lots);
      const idx = openRowIndex.get(key) ?? [];
      idx.push(i);
      openRowIndex.set(key, idx);
      return {
        ...base,
        action: "hunt" as const,
        // The token NAME is resolved in the page, which can await it; this stays a pure chain read.
        rationale: `bought ${formatEther(a.tokensOut as bigint).slice(0, 10)} units for ${formatEther(ethIn)} ETH`,
        token,
      };
    }

    if (name === "Exited") {
      const token = a.token as `0x${string}`;
      const ethOut = a.ethOut as bigint;
      const key = positionKey(base.strayId, token);
      const lots = open.get(key);
      const lot = lots !== undefined && lots.length > 0 ? lots.pop() : undefined;
      if (lot !== undefined) {
        // This entry is now CLOSED, so it must not also be reported as open.
        const idx = openRowIndex.get(key);
        if (idx !== undefined) idx.pop();
      }
      const pnl: RoundTrip | null =
        lot === undefined
          ? null
          : {
              eth: ethNum(ethOut - lot.ethIn),
              // Guarded: a zero-cost entry cannot be expressed in bps, and `0/0` is `NaN`, which
              // renders as the string "NaN" in a PnL column. `null` renders as "—" instead.
              bps: lot.ethIn === 0n ? null : Number(((ethOut - lot.ethIn) * 10000n * 1000n) / lot.ethIn) / 1000,
              ethIn: ethNum(lot.ethIn),
              ethOut: ethNum(ethOut),
              openedAtBlock: lot.block,
            };
      return {
        ...base,
        action: "flee" as const,
        rationale: `sold back for ${formatEther(ethOut)} ETH`,
        token,
        pnl,
      };
    }

    if (name === "Withdrawn") {
      return {
        ...base,
        action: "withdraw" as const,
        rationale: `owner withdrew ${formatEther(a.paid as bigint)} ETH, rake ${formatEther(a.rake as bigint)}`,
      };
    }

    return {
      ...base,
      action: "adopt" as const,
      rationale: `adopted with ${formatEther((a.stake ?? 0n) as bigint)} ETH of stake`,
    };
  });

  // Whatever is still on a stack after the pass never closed. Flagged so the renderer can say
  // "open" rather than leaving a trade row that looks like it simply has no result.
  for (const idx of openRowIndex.values()) {
    for (const i of idx) {
      const r = rows[i];
      if (r !== undefined) rows[i] = { ...r, open: true };
    }
  }

  rows.sort((x, y) => Number(y.block - x.block));
  return { rows: rows.slice(0, limit), block, at };
}

/** `+0.00012 ETH` / `−0.00002388 ETH`. The sign is always explicit — an unsigned PnL is ambiguous. */
export function formatPnlEth(eth: number): string {
  // U+2212 MINUS, not a hyphen: at 11px a hyphen-minus in front of a figure is easy to miss, and
  // "did this lose money" is the one question this page exists to answer at a glance.
  return `${eth >= 0 ? "+" : "−"}${trimEth(Math.abs(eth))} ETH`;
}

/** `+31 bps` / `−199 bps`, rounded to whole basis points. */
export function formatPnlBps(bps: number): string {
  return `${bps >= 0 ? "+" : "−"}${Math.abs(bps).toFixed(0)} bps`;
}
