/**
 * THE TWO POOL HOOKS. There are exactly two, the vault could only reach one, and that cost us
 * three of the four highest-volume names on the pad.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHY A HOOK ADDRESS IS SUDDENLY A FIELD ON A CANDIDATE ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * RESEARCH §7d re-measured the pad by reconstructing every token's poolId against BOTH candidate
 * hooks and matching the result against the pad's own `pool` field:
 *
 *   0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC    67 tokens    5194 Ξ / 24h
 *   0xEfe669814e5Eec33406Bd50ffa8331618D076aEc    44 tokens    1359 Ξ / 24h
 *                                                  3 unmatched
 *
 * **LEVCAT, INTERN and Seriouscat are all on the second hook.** The v1 vault hardcoded the first
 * one as an immutable and built every PoolKey with it, so for 44 of 111 tokens it addressed a pool
 * that does not exist. The failure mode is the reason this hid for so long: an empty inner revert
 * wrapped in `UnexpectedRevertBytes`, which reads exactly like a transient RPC problem and not like
 * "you are asking about the wrong pool".
 *
 * So the hook is now **per token and per trade**: `TokenSnapshot.hook` carries it, `decide()`
 * passes it through onto the entry decision, and the keeper hands it to `hunt`. A pool is
 * (currency0, currency1, fee, tickSpacing, HOOKS) — addressing it with four fifths of the key is
 * not addressing it at all. `tickSpacing` was already per-token for exactly this reason
 * (RESEARCH §2: *"it varies per launch config and MUST be read per token. It is not a constant."*)
 * and the hook is the same class of fact, discovered later.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHY IT IS AN ALLOWLIST AND NOT A FREE PARAMETER ══
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `StrayVault.sol`'s header states the risk this bounds, and it is the most dangerous argument in
 * that contract:
 *
 *   *"A v4 hook runs INSIDE the swap with the pool's permissions; an attacker-controlled hook
 *   paired with an attacker-controlled token is a pool whose 'swap' can do anything, including
 *   returning nothing. `TAKE_ALL` still prevents proceeds being sent to a named recipient — but it
 *   cannot prevent a swap that simply consumes the input."*
 *
 * The contract enforces this with two immutables and no setter (`_requireKnownHook`). This module
 * is the SAME allowlist on the keeper side, and it exists for a reason that is not redundancy: the
 * contract's revert is a wasted transaction with real gas attached, while a keeper-side refusal
 * costs nothing and produces a log line naming the token. Defence in depth here is cheap and the
 * two layers fail differently — a keeper bug is caught by the contract, and a contract we have not
 * yet redeployed is protected by the keeper.
 *
 * **Neither layer is allowed to be the only one.** RESEARCH §7g is about precisely the gap between
 * a claim and the code that would have to run for it, so `hook.test.ts` asserts the constants match
 * the contract's immutables character for character.
 */

/**
 * The higher-volume hook. 67 tokens, 5194 Ξ of 24h volume at the time of measurement.
 *
 * This is the address v1 hardcoded. It was not a wrong guess — it is genuinely the larger of the
 * two — it was a wrong ASSUMPTION that there was only one.
 */
export const HOOK_PRIMARY = "0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC";

/**
 * The second hook. 44 tokens, 1359 Ξ of 24h volume — and LEVCAT, INTERN and Seriouscat.
 *
 * Lower total volume, higher-value names. A filter that dropped this hook dropped 40% of the pad by
 * count and three of the four biggest movers by name, which is why the count and the volume are
 * both recorded above: neither number alone would have made the case.
 */
export const HOOK_SECONDARY = "0xEfe669814e5Eec33406Bd50ffa8331618D076aEc";

/**
 * Every hook a stray may trade through. **Exactly two, and not extensible at runtime.**
 *
 * A `readonly` tuple rather than a mutable array because a module-level array a caller can `push`
 * to is an allowlist a caller can defeat, and the whole point of an allowlist is that the set is
 * closed. Adding a third hook is a code change, a review, and a contract redeploy — which is the
 * correct cost for widening this.
 */
export const KNOWN_HOOKS: readonly [string, string] = [HOOK_PRIMARY, HOOK_SECONDARY];

/**
 * Is this one of the two hooks the vault will accept?
 *
 * CASE-INSENSITIVE, deliberately. The pad's API, the RPC and our own constants disagree about
 * EIP-55 checksum casing depending on which one produced the string, and an allowlist that a
 * lowercase address fails is an allowlist that refuses every legitimate trade from one data source
 * while looking correct in tests written against the other. The comparison is on the address VALUE,
 * which is what the chain compares too.
 *
 * Pure and total: no throw, no I/O. `assertKnownHook` is the throwing version for the money path.
 */
export function isKnownHook(hook: string | undefined | null): boolean {
  if (typeof hook !== "string") return false;
  const normalised = hook.trim().toLowerCase();
  return KNOWN_HOOKS.some((known) => known.toLowerCase() === normalised);
}

/**
 * Refuse an unknown hook on the money path, loudly.
 *
 * Throws rather than returning false because the call sites that need this are the ones that are
 * about to encode a swap. A boolean at that point is a value somebody can forget to check;
 * `StrayVault` makes the same choice with `_requireKnownHook` and a revert.
 */
export function assertKnownHook(hook: string | undefined | null): void {
  if (!isKnownHook(hook)) {
    throw new Error(
      `refusing to trade through hook ${String(hook)} — it is not one of the two known letscash ` +
        `hooks (${HOOK_PRIMARY} with 67 tokens, ${HOOK_SECONDARY} with 44). A v4 hook runs INSIDE ` +
        "the swap with the pool's permissions, so an arbitrary hook paired with an arbitrary token " +
        "is a pool whose swap can consume the input and return nothing. TAKE_ALL prevents proceeds " +
        "going to a named recipient; it cannot prevent that. StrayVault enforces the same two-entry " +
        "allowlist on chain via _requireKnownHook, and this check exists so the refusal costs a log " +
        "line rather than a reverted transaction",
    );
  }
}

/**
 * Normalise a hook to the exact casing the constants use, or throw.
 *
 * Useful where a string is about to be compared with `===` (a slot's stored hook against a
 * candidate's, say), because two spellings of the same address comparing unequal is a bug that
 * looks like a data problem. Refuses unknown hooks by delegating to `assertKnownHook`, so this can
 * never launder an arbitrary address into a canonical-looking one.
 */
export function canonicalHook(hook: string): string {
  assertKnownHook(hook);
  const normalised = hook.trim().toLowerCase();
  const match = KNOWN_HOOKS.find((known) => known.toLowerCase() === normalised);
  // Unreachable: `assertKnownHook` above throws on anything `find` would miss. Kept as a
  // total-function guarantee rather than a `!` assertion, because a non-null assertion is a claim
  // and this is a check.
  if (match === undefined) throw new Error(`unreachable: ${hook} passed the allowlist but has no canonical form`);
  return match;
}
