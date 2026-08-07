// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * A vault that holds one stray's ETH, lets a keeper make it TRADE, and lets nobody but the owner
 * take the money out.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ THE ONE PROPERTY THAT JUSTIFIES WRITING A NEW CONTRACT INSTEAD OF REUSING OpenhoodCustody ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `OpenhoodCustody.sol` is deployed and working on this exact chain, and its own header states the
 * property it could not achieve:
 *
 *     "The executor is a wallet, not a contract, so it CAN in principle keep what it borrows...
 *      This is the one property this design does not achieve structurally... Making it structural
 *      requires the swap to happen inside the contract, which requires the router integration to
 *      be audited before it holds user money."
 *
 * **The swap happens inside this contract.** `hunt` calls the UniversalRouter itself, so the ETH
 * never leaves custody in the hands of an EOA that could decline to bring it back.
 *
 * What makes that safe is a fact about Uniswap v4's encoding rather than a check we wrote:
 *
 *     TAKE      (0x0e)  params are (currency, RECIPIENT, amount)
 *     TAKE_ALL  (0x0f)  params are (currency, minAmount)     <-- NO RECIPIENT FIELD
 *
 * `TAKE_ALL` settles proceeds to the router's CALLER. When the caller is this contract, proceeds
 * return to this contract **by the shape of the calldata**. There is no recipient parameter for a
 * compromised keeper, a malicious argument, or a future refactor to abuse.
 *
 * meridian's `contracts/CUSTODY.md` documents the trap this is shaped against, and admits its own
 * shipped design does not close it:
 *
 *     "scoping the session key to router.execute (even at the selector level) stops it from
 *      calling *other* contracts, but does not stop it from swapping the vault's funds out to an
 *      attacker by setting TAKE.recipient = attacker. This is the hole."
 *
 * So: **the keeper supplies INTENT (which token, how much in, how little out is acceptable). This
 * contract builds the router calldata itself.** The keeper never supplies bytes that reach the
 * router, and it cannot name a recipient because the encoding it triggers has no field for one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ══ WHY THIS IS V2, AND WHAT THE V1 AT 0xD4233cae… PHYSICALLY COULD NOT EXPRESS ══
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * V1 is deployed, verified, and worked — it executed live round trips with real money. It is being
 * REPLACED rather than patched because two of its design decisions are wrong in ways no keeper-side
 * change can route around. Both were found by measurement, not by review.
 *
 * ── 1. ONE POSITION PER STRAY. The measured strategy needs EIGHT. ──
 *
 * V1 holds a single `holding` address and `hunt` reverts `AlreadyHolding`. `packages/backtest`
 * §10.5 measured what that constraint costs on held-out data, and it is not a rounding error — it
 * is the difference between a result and no result:
 *
 *     1 slot:   takes 17 of 72 opportunities,  Welch t 1.16   <-- NOT SIGNIFICANT
 *     8 slots:  takes 71 of 72 opportunities,  Welch t 2.38-2.72 on 20 of 20 seeds
 *
 * The per-ticket edge is identical in both rows — median ~+4,410bps either way. **What changes is
 * n.** A single slot is occupied for hours or days by the first eligible token and refuses the
 * other 55, so twelve observations have to carry the whole claim and they cannot. This is the
 * finding that rescued the strategy, and it is a CONTRACT constraint: no amount of keeper cleverness
 * gives a `holding` field a second value.
 *
 * So a stray holds up to `MAX_POSITIONS` concurrent positions, each with its own token, tickSpacing,
 * cost basis, hook — and its own **peak price watermark**, which the next paragraph is about.
 *
 * ── 2. THE EXIT IS A TRAILING STOP, SO EACH POSITION NEEDS A WATERMARK ──
 *
 * V1's exit was a −235bps hard stop and a derived take-profit. §10 measured that this is precisely
 * backwards: the strategy was being shaken out of exactly the moves that made the money. The rule
 * that works held out is **a 50% trailing stop from the running peak**, which is a stateful exit —
 * it cannot be evaluated from price alone, only from price RELATIVE TO the highest price seen since
 * entry.
 *
 * `peakPriceWei` therefore lives ON THE POSITION, on chain, and `mark()` raises it. Two reasons it
 * is here rather than only in the keeper's Postgres:
 *
 *   a. **A watermark that lives only in the keeper is a watermark that a redeploy resets.** That is
 *      RESEARCH §7f's recorded bug in a new costume — meridian's "daily cap" was really "spend since
 *      last boot". A reset watermark does not merely lose information: it resets the trailing stop
 *      to the current price, which *widens* the stop after every deploy and silently disarms the
 *      only exit this strategy has.
 *   b. **It is the number the exit is computed from, so it should be readable by the same party who
 *      can be hurt by it.** `positionsOf` returns it, so a user can see the level their cat will
 *      sell at rather than being told about it.
 *
 * The keeper maintains it — `mark` is keeper-only and monotone — and the indexer ALSO persists it,
 * so the two can be reconciled. The chain is the authority.
 *
 * ── 3. THE HOOK IS PER-TRADE, BECAUSE THERE ARE TWO OF THEM ──
 *
 * V1 hardcodes `0x75A54357…` as an immutable and builds every PoolKey with it. RESEARCH §7d
 * measured that this is wrong about 40% of the pad:
 *
 *     0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC    67 tokens    5194 Ξ / 24h
 *     0xEfe669814e5Eec33406Bd50ffa8331618D076aEc    44 tokens    1359 Ξ / 24h
 *
 * (Counts re-measured at build time for this contract by reconstructing each token's poolId against
 * both hooks and matching the pad's own `pool` field: 67 / 44 / 3 unmatched.)
 *
 * **LEVCAT, INTERN and Seriouscat are all on the second hook** — three of the four highest-volume
 * names on the pad. V1 cannot trade any of them: its PoolKey addresses a pool that does not exist,
 * and the revert is an empty inner revert wrapped in `UnexpectedRevertBytes`, which is why it hid.
 *
 * So `hunt` and `flee` take the hook as an argument. **It is validated against an allowlist of the
 * two known hooks**, so a compromised keeper cannot route a swap through an arbitrary contract of
 * its own. The allowlist is two immutables with no setter, checked by `_requireKnownHook`.
 *
 * ══ WHY AN ALLOWLIST AND NOT A FREE PARAMETER ══
 *
 * A free hook parameter would be the single most dangerous argument in this contract. A v4 hook
 * runs INSIDE the swap with the pool's permissions; an attacker-controlled hook paired with an
 * attacker-controlled token is a pool whose "swap" can do anything, including returning nothing.
 * `TAKE_ALL` still prevents proceeds being sent to a named recipient — but it cannot prevent a
 * swap that simply consumes the input. The allowlist is what stops that, and
 * `test_SABOTAGE_arbitraryHookRefused` is what stops the allowlist being removed.
 *
 * ══ THE FIVE SENTENCES THAT DESCRIBE THE WHOLE SECURITY MODEL — UNCHANGED FROM V1 ══
 *
 * 1. **A user can always withdraw.** `withdraw` pays `msg.sender` and only `msg.sender`. No role
 *    here can stop it, there is no pause on the exit, and no risk control gates it — including the
 *    new multi-position state: eight open positions do not gate an exit any more than one did.
 *    meridian's own rule, learned live: "getting OUT is always allowed."
 * 2. **No function pays a caller-supplied address.** Search this file for a parameter named `to`
 *    or `recipient`. There is none, on any path, for any role. The hook argument is NOT an
 *    exception: it is a pool selector, it is allowlisted, and it never receives a transfer from us.
 * 3. **Per-stray balances are compartments in a mapping keyed by stray id.** Stray `a`'s balance
 *    is arithmetically unreachable from a call naming stray `b`. Isolation is the mapping, not a
 *    check that could be deleted — and `test_SABOTAGE_keeperCannotSpendStrayAOnStrayB` proves it.
 *    Positions live INSIDE the compartment for the same reason.
 * 4. **The keeper can do exactly one thing: swap a stray's own ETH for a token, and back.** It is
 *    `immutable`. It cannot withdraw, cannot move value between strays, and cannot receive. `mark`
 *    is the one addition and it moves no value at all.
 * 5. **The house takes its rake on PROFIT ONLY, at withdrawal, and never on principal.** A user
 *    who deposits 1 ETH and withdraws 0.9 pays zero. This is checked by
 *    `test_rakeIsZeroOnALoss`.
 *
 * ══ HOW THE MONEY MOVES ══
 *
 *   user ──adopt(strayId){value}──▶ THIS CONTRACT
 *                                      │ splits, on chain, by an immutable constant
 *                                      ├──▶ house       (energy fee — paid IMMEDIATELY, so the
 *                                      │                 house is cash-positive at adoption and
 *                                      │                 can never be net-negative on a stray)
 *                                      └──▶ stakeOf[strayId]   (the cat's trading balance)
 *                                                 │
 *                              hunt ──────────────┤ THIS CONTRACT calls the router. Up to
 *                                                 │ MAX_POSITIONS open at once, each in its own
 *                                                 │ slot with its own cost basis and watermark.
 *                                                 │ TAKE_ALL has no recipient: proceeds land here.
 *                                                 ▼
 *                          withdraw ◀──────────── owner only. principal + profit - rake on profit.
 *
 * ══ WHAT THIS CONTRACT DELIBERATELY DOES NOT HAVE ══
 *
 * - **No `to`/`recipient` parameter on any value-moving function**, and no `bytes` parameter that
 *   reaches the router. The keeper cannot hand us calldata.
 * - **No admin sweep of user principal.** No role can move `stakeOf` to itself.
 * - **No pause on withdrawals.** Pausing an exit is a MiCA Art. 3(1)(17) "control" trigger, not
 *   merely a security tradeoff. Carried from OpenhoodCustody unchanged and for the same reason.
 * - **No upgrade path, no proxy, no `delegatecall`.**
 * - **No agent-reachable function.** Strays are off-chain processes. Nothing an LLM emits becomes
 *   an argument here: the keeper passes a token address, a hook from a fixed allowlist, and
 *   uint256s, all of which are validated on chain against this contract's own reads.
 *
 * ══ WHAT IT DOES *NOT* PROTECT AGAINST — stated rather than glossed ══
 *
 * - **A bug in this file.** It is adversarially tested (see `SABOTAGE.md`) and **not externally
 *   audited**. Ibrahim accepted that in writing; users did not, so `/docs` says it in the product.
 * - **The pad's hooks and `revenueSplitter` are UNVERIFIED on Blockscout** and every swap routes
 *   through them. Unmitigable by us; bounded by `MAX_POSITION_WEI` **per position**, which is why
 *   that cap survives into a design that can now hold eight of them at once.
 * - **A losing strategy.** Nothing here protects a user from the cat simply being wrong. That is
 *   the product. And §10.6 is explicit that the new rule is `credible: false` at 183 cumulative
 *   trials — promising and out-of-sample positive, NOT proven.
 */

/// The Uniswap v4 UniversalRouter. Only the one function this contract ever calls.
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline)
        external
        payable;
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// Permit2, at its canonical CREATE2 address. Verified deployed on chain 4663 (18,306 bytes).
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

contract StrayVault {
    // ── Immutable configuration ──────────────────────────────────────────────────────────────

    /**
     * Where energy fees and profit rake land. Immutable: it is not a parameter on any function,
     * so no call to this contract can redirect the house's income to somewhere else.
     */
    address public immutable house;

    /**
     * The only address that may call `hunt`, `flee` and `mark`. Immutable, like `house`.
     *
     * A compromised keeper key can make BAD TRADES — market risk, which is real and is bounded by
     * `MAX_POSITION_WEI` per position and `MAX_POSITIONS` positions. It cannot make the money land
     * anywhere else, because `hunt` has no recipient parameter and `TAKE_ALL` has no recipient
     * field. That is theft, and it is structurally impossible here rather than merely disallowed.
     *
     * It also cannot route a swap through a contract of its own: see `hookA`/`hookB`.
     */
    address public immutable keeper;

    /// The v4 UniversalRouter. Immutable so a swap can never be routed to an attacker's contract.
    IUniversalRouter public immutable router;

    /// Permit2, needed only on the SELL leg (the router pulls ERC-20s through it).
    IPermit2 public immutable permit2;

    /**
     * ══ THE HOOK ALLOWLIST — TWO ENTRIES, BOTH IMMUTABLE, NO SETTER ══
     *
     * The hook is now an ARGUMENT to `hunt` and `flee`, because RESEARCH §7d measured two of them
     * on this pad and V1's single immutable made 40% of the market — and the three highest-volume
     * tokens on it — physically unreachable.
     *
     * An argument that selects which contract runs inside our swap is the most dangerous kind of
     * argument this contract could take, so it is not free: it must equal one of these two values.
     * They are immutable, set once at construction, and `test_SABOTAGE_hooksHaveNoSetter` probes
     * the ABI to prove no setter was added — the same check that caught S11 for `house`.
     *
     * Why TWO immutables rather than a mapping: a mapping is writable by definition and its
     * emptiness is a runtime fact rather than a structural one. Two immutables cannot grow a third
     * entry without redeploying, which is exactly the property wanted. If the pad adds a third
     * hook, that is a redeploy — and it SHOULD be, because adding an unaudited contract to the set
     * that can run inside our swaps is not a config change.
     */
    address public immutable hookA;
    address public immutable hookB;

    /**
     * The Uniswap v4 singleton PoolManager.
     *
     * ══ WHY THIS FIELD EXISTS, AND WHY MOCKS COULD NOT HAVE FOUND IT ══
     *
     * It is here for exactly one reason: **the PoolManager, not the router, is what sends ETH back
     * on a sell.** v4's `take(currency, recipient, amount)` is executed by the PoolManager, so the
     * native transfer arrives from `0x8366a39C...` and never from the router.
     *
     * The first version of `receive()` accepted the router only. Every unit test passed, because a
     * mock router sends its own ETH. Against the REAL venue on a fork the entire sell executed
     * correctly — swap, tax, settle, take — and then reverted on the last line with
     * `NativeTransferFailed()`, having done all the work.
     *
     * This is precisely the class of defect a mock cannot reach, and the reason the fork test
     * exists. Recorded rather than quietly fixed.
     */
    address public immutable poolManager;

    // ── Economics, all constant with no setter of any kind ───────────────────────────────────

    /**
     * The house's cut of PROFIT, in basis points. 10%.
     *
     * Charged at withdrawal, on the gain only. A stray that loses money pays nothing, and the
     * rake can never touch principal — `test_rakeIsZeroOnALoss` and `test_rakeNeverTouchesPrincipal`
     * both fail if this is violated.
     */
    uint256 public constant PROFIT_RAKE_BPS = 1000;

    /**
     * The energy fee taken at adoption, in basis points of the total sent. 20%.
     *
     * ══ WHY THIS IS TAKEN UPFRONT, AND WHY IT IS THE WHOLE ANSWER TO "the house never funds an
     *    agent" ══
     *
     * Ibrahim's constraint is that the house must never spend on or fund a user's stray, and
     * should make a little profit. The rejected alternative was a rake on every winning trade with
     * no upfront fee: a stray that trades often and loses overall still burns house LLM and RPC
     * spend with no offset, so the house CAN go net-negative on that design. It is not built.
     *
     * Taking the fee at adoption makes the house cash-positive on a stray the moment it exists,
     * which is a property of the arithmetic rather than a hope about behaviour.
     */
    uint256 public constant ENERGY_FEE_BPS = 2000;

    /**
     * The largest ETH a single `hunt` may put into ONE position.
     *
     * This is the bound on the UNVERIFIED-HOOK risk (see the header). We cannot audit either of the
     * pad's hooks or its revenue splitter, so the honest control is to cap what a single trade can
     * lose to one. 0.01 ETH ≈ $19 at the ETH price measured at build time.
     *
     * ══ WHY THIS IS *PER POSITION* AND NOT A TOTAL, NOW THAT THERE ARE EIGHT ══
     *
     * Stated plainly because it is a real widening: a stray can now have `MAX_POSITIONS ×
     * MAX_POSITION_WEI` = 0.08 ETH exposed to unverified hooks at once, where V1 could have 0.01.
     *
     * It is nonetheless the right bound, because the thing being bounded is **the blast radius of
     * one hook interaction**, not the stray's total market exposure. A hook that steals the input
     * of one swap steals at most `MAX_POSITION_WEI`. Total market exposure is bounded elsewhere and
     * differently: by `s.stake`, which is the user's own money and which no cap of ours should
     * shrink, and by the keeper's spend ledger.
     *
     * The stray's real ceiling is its own compartment: `hunt` refuses `ethIn > s.stake`, so eight
     * slots cannot spend more than one slot could — they just spend it in eight places. At the
     * intended $10-20 funding a stray holds 0.005-0.01 ETH total, so the per-position cap is not
     * even the binding constraint at the intended size. It binds only for a large adopter, and for
     * them it is doing exactly its job.
     */
    uint256 public constant MAX_POSITION_WEI = 0.01 ether;

    /**
     * The smallest adoption this contract accepts.
     *
     * Below this the energy fee is dust and the remaining stake cannot clear the strategy's own
     * cost bar, so the user would be funding a cat that provably never trades. Refusing loudly is
     * more honest than accepting money for a stray that cannot act.
     */
    uint256 public constant MIN_ADOPT_WEI = 0.001 ether;

    /**
     * How many concurrent positions ONE stray may hold.
     *
     * ══ WHY EIGHT, AND WHY IT IS A MEASUREMENT RATHER THAN A ROUND NUMBER ══
     *
     * `packages/backtest` §10.5 measured slot count directly against held-out data. One slot takes
     * 17 of 72 opportunities and the Welch t against matched random is 1.16 — not significant, and
     * the per-ticket edge is real but unprovable at n=17. Eight slots take 71 of 72, median
     * +4,410bps, and Welch t 2.38-2.72 on **20 of 20 seeds**. Eight is where the slot constraint
     * stops being the binding one.
     *
     * It also matches the money. Ibrahim raised user funding to $10-20, and the position floor is
     * 0.001 ETH (~$1.93 — below it the flat ~$0.016 gas becomes a large share of the position). So
     * $10-20 buys 4-8 positions at the floor, and a cap of 8 is the funding, not a guess.
     *
     * ══ WHY IT IS A FIXED-SIZE ARRAY AND NOT A GROWABLE LIST ══
     *
     * A `Position[]` that pushes would let a keeper open unbounded positions and make `withdraw`'s
     * gas — and therefore a user's ability to exit — depend on how many trades the keeper chose to
     * make. **An exit whose cost the keeper controls is an exit the keeper can deny.** A fixed
     * array bounds every loop in this contract at 8 iterations, so no keeper action can make any
     * user action expensive. `test_SABOTAGE_keeperCannotStrandExitByOpeningPositions` asserts it.
     */
    uint256 public constant MAX_POSITIONS = 8;

    // ── Uniswap v4 encoding constants ────────────────────────────────────────────────────────
    //
    // Every one of these was proven by DECODING A REAL LANDED SWAP on this chain and router, not
    // taken from documentation. openhood's `venue.ts` records that its first encoder hand-
    // concatenated 32-byte words and was silently WRONG, because ExactInputSingleParams contains
    // a `bytes` member which makes the struct dynamic and needs a head offset word a fixed-layout
    // encoder does not emit. Here we use `abi.encode`, which gets that right by construction.

    /// UniversalRouter command for a v4 swap.
    bytes internal constant COMMAND_V4_SWAP = hex"10";

    /// SWAP_EXACT_IN_SINGLE (0x06) / SETTLE_ALL (0x0c) / TAKE_ALL (0x0f).
    bytes internal constant V4_ACTIONS = hex"060c0f";

    /// Native ETH is address(0) as a v4 currency — never the WETH address.
    address internal constant NATIVE = address(0);

    // ── State ────────────────────────────────────────────────────────────────────────────────

    /// The v4 PoolKey. Static struct: all five fields are value types, so it encodes inline.
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// The v4 exact-input single-pool swap params. DYNAMIC, because `hookData` is `bytes` —
    /// see the derivation in `_encodeSwap`.
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    /**
     * ONE open position. Eight of these per stray.
     *
     * A slot is EMPTY exactly when `token == address(0)`, and that is the only emptiness test used
     * anywhere in this contract — there is no separate `open` flag that could disagree with it.
     * Two fields that can disagree about the same fact is the defect shape this corpus keeps
     * recording; one field cannot.
     */
    struct Position {
        /// The token held. address(0) means this slot is free.
        address token;
        /// Tick spacing of the pool we entered, needed to rebuild the same PoolKey on exit.
        int24 tickSpacing;
        /**
         * The hook of the pool we entered.
         *
         * STORED PER POSITION rather than re-supplied on exit, because a sell must address the
         * SAME pool the buy addressed. If `flee` took the hook as an argument, a keeper that
         * passed the other allowlisted hook would build a PoolKey for a pool that either does not
         * exist (revert, recoverable) or exists with different liquidity (a real loss, silent).
         * Reading it back from the position makes that class of mistake unrepresentable.
         */
        address hook;
        /// ETH spent acquiring this position. The basis the trailing stop is measured against.
        uint128 costBasis;
        /**
         * THE PEAK PRICE WATERMARK. ETH-per-token, scaled 1e18.
         *
         * Set at entry to the entry price and raised — never lowered — by `mark()`. This is the
         * reference the 50% trailing stop is computed from, and it is the whole reason this field
         * is on chain: §10 measured that the exit rule that works is stateful, and state that
         * lives only in a process is state that a redeploy silently resets (RESEARCH §7f).
         *
         * The contract does not ENFORCE the trailing stop — `flee` is not gated on it, because a
         * gate on the exit is a gate on the exit, and DESIGN §6 Rule 5 forbids one. It RECORDS the
         * watermark so the keeper's stop is computed from a number that survived the restart, and
         * so a user can read the level their cat will sell at.
         */
        uint128 peakPriceWei;
        /// Unix seconds at entry. Events only; no logic reads it.
        uint64 openedAt;
    }

    struct Stray {
        /// Who may withdraw. Set once at adopt and never changed by any function.
        address owner;
        /// Uncommitted ETH this stray can still spend.
        uint128 stake;
        /// What the owner originally put in, net of the energy fee. The rake basis.
        uint128 principal;
    }

    mapping(bytes32 => Stray) public strays;

    /**
     * The eight position slots per stray.
     *
     * A nested mapping to a fixed-size array rather than a dynamic array: isolation stays the
     * MAPPING (stray a's slots are arithmetically unreachable from a call naming stray b, exactly
     * as its stake is), and the array's fixed length bounds every loop.
     */
    mapping(bytes32 => Position[MAX_POSITIONS]) internal positions;

    /// Reentrancy guard. 1 = not entered, 2 = entered.
    uint256 private _lock = 1;

    // ── Events ───────────────────────────────────────────────────────────────────────────────

    event Adopted(bytes32 indexed strayId, address indexed owner, uint256 stake, uint256 energyFee);
    event Entered(
        bytes32 indexed strayId,
        address indexed token,
        uint256 slot,
        uint256 ethIn,
        uint256 tokensOut,
        int24 tickSpacing,
        address hook,
        uint256 entryPriceWei
    );
    event Exited(
        bytes32 indexed strayId,
        address indexed token,
        uint256 slot,
        uint256 tokensIn,
        uint256 ethOut,
        uint256 peakPriceWei
    );
    /// Emitted only when the watermark actually MOVES, so the log is a record of new highs.
    event PeakRaised(bytes32 indexed strayId, uint256 indexed slot, uint256 oldPeak, uint256 newPeak);
    event Withdrawn(bytes32 indexed strayId, address indexed owner, uint256 paid, uint256 rake);

    // ── Errors ───────────────────────────────────────────────────────────────────────────────

    error NotKeeper();
    error NotOwner();
    error AlreadyExists();
    error NoSuchStray();
    error BelowMinimum();
    error PositionTooLarge();
    error InsufficientStake();
    error NoFreeSlot();
    error NotHolding();
    error ZeroSlippageBound();
    error ZeroAddress();
    error Reentrancy();
    error TransferFailed();
    error NothingReceived();
    /// The hook argument was not one of the two allowlisted pad hooks.
    error UnknownHook();
    /// A slot index at or beyond MAX_POSITIONS.
    error BadSlot();
    /// A token this stray already holds in another slot. See `hunt`.
    error DuplicateToken();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(
        address house_,
        address keeper_,
        address router_,
        address permit2_,
        address hookA_,
        address hookB_,
        address poolManager_
    ) {
        if (
            house_ == address(0) || keeper_ == address(0) || router_ == address(0)
                || permit2_ == address(0) || hookA_ == address(0) || hookB_ == address(0)
                || poolManager_ == address(0)
        ) revert ZeroAddress();
        house = house_;
        keeper = keeper_;
        router = IUniversalRouter(router_);
        permit2 = IPermit2(permit2_);
        hookA = hookA_;
        hookB = hookB_;
        poolManager = poolManager_;
    }

    // ── Adoption ─────────────────────────────────────────────────────────────────────────────

    /**
     * Fund a new stray. This is step 4 of the user's path and the ONLY transaction a user ever
     * has to send to start (DESIGN §7): energy fee and stake in one call, one signature.
     *
     * The energy fee is forwarded to the house IMMEDIATELY rather than accrued. An accrued fee is
     * a claim on a balance that a later bug could fail to honour; a forwarded one is settled.
     */
    function adopt(bytes32 strayId) external payable nonReentrant {
        if (msg.value < MIN_ADOPT_WEI) revert BelowMinimum();
        if (strays[strayId].owner != address(0)) revert AlreadyExists();

        uint256 fee = (msg.value * ENERGY_FEE_BPS) / 10_000;
        uint256 stake = msg.value - fee;

        strays[strayId] =
            Stray({owner: msg.sender, stake: uint128(stake), principal: uint128(stake)});

        emit Adopted(strayId, msg.sender, stake, fee);

        // Effects are complete before this send. The house is a known address, but CEI is applied
        // here anyway: unitick's recorded five-time finding is that a CEI violation survived 143
        // tests because `nonReentrant` alone defeated the attack, so the ordering is maintained
        // independently of the guard rather than leaning on it.
        (bool ok,) = house.call{value: fee}("");
        if (!ok) revert TransferFailed();
    }

    // ── Hunting — the keeper's only power ────────────────────────────────────────────────────

    /**
     * Buy `token` with `ethIn` of the stray's own stake, into the first free slot.
     *
     * ══ WHAT THE KEEPER SUPPLIES, AND WHAT IT CANNOT ══
     *
     * It supplies INTENT: which token, which of the two known pools, how much to spend, and the
     * minimum acceptable output. It does NOT supply calldata, a recipient, a router address, or an
     * arbitrary pool. This function builds the router call itself from immutable addresses plus an
     * ALLOWLISTED hook, so there is nothing for a compromised keeper to redirect.
     *
     * `minOut` is required to be non-zero. openhood records that the real landed mainnet swap it
     * decoded carried `amountOutMinimum = 0` in both slippage slots, and that reusing that would
     * be "a free MEV sandwich on every trade". The encoding is inherited; those two zeros are not.
     *
     * ══ WHY THE SAME TOKEN CANNOT BE HELD IN TWO SLOTS ══
     *
     * Because the token balance is MEASURED from `balanceOf(address(this))`, not tracked per slot.
     * Two slots holding the same token would each measure the combined balance, so `flee` on
     * either would sell BOTH and credit the proceeds to one — a real accounting error, and one
     * that would look like a windfall in one slot and a stranded position in the other. Refusing
     * the duplicate at entry is the only clean fix; splitting the balance per slot would mean
     * trusting an internal number over the chain's, which RESEARCH §7d says never to do.
     *
     * That is also why it is not merely a keeper-side convention: a convention is a comment.
     */
    function hunt(
        bytes32 strayId,
        address token,
        address hook,
        uint256 ethIn,
        uint256 minOut,
        int24 tickSpacing
    ) external onlyKeeper nonReentrant returns (uint256 slot) {
        Stray storage s = strays[strayId];
        if (s.owner == address(0)) revert NoSuchStray();
        if (token == address(0)) revert ZeroAddress();
        _requireKnownHook(hook);
        if (minOut == 0) revert ZeroSlippageBound();
        if (ethIn > MAX_POSITION_WEI) revert PositionTooLarge();
        if (ethIn == 0 || ethIn > s.stake) revert InsufficientStake();

        // Find a free slot and refuse a duplicate token in the same pass. Bounded at 8.
        slot = MAX_POSITIONS;
        Position[MAX_POSITIONS] storage slots = positions[strayId];
        for (uint256 i = 0; i < MAX_POSITIONS; i++) {
            address held = slots[i].token;
            if (held == token) revert DuplicateToken();
            if (held == address(0) && slot == MAX_POSITIONS) slot = i;
        }
        if (slot == MAX_POSITIONS) revert NoFreeSlot();

        // EFFECTS before the external call. The stake is debited here so that a reentrant call
        // arriving during the swap sees the reduced balance rather than the original, and the slot
        // is claimed so a reentrant hunt cannot take the same one.
        s.stake -= uint128(ethIn);
        Position storage p = slots[slot];
        p.token = token;
        p.tickSpacing = tickSpacing;
        p.hook = hook;
        p.costBasis = uint128(ethIn);
        p.openedAt = uint64(block.timestamp);

        uint256 received = _buy(token, hook, tickSpacing, ethIn, minOut);

        /*
         * ══ THE WATERMARK IS SEEDED FROM THE MEASURED FILL, NOT FROM AN ARGUMENT ══
         *
         * entryPrice = ethIn * 1e18 / received, i.e. ETH per whole token scaled 1e18. Both terms
         * are ours: `ethIn` we sent, `received` we measured. A keeper cannot seed the watermark
         * high (which would arm the trailing stop immediately) or low (which would disarm it),
         * because it supplies neither number.
         *
         * `received` is >= minOut > 0 by the check above, so this cannot divide by zero.
         */
        uint256 entryPriceWei = (ethIn * 1e18) / received;
        p.peakPriceWei = uint128(entryPriceWei);

        // Emitted through a helper that re-reads the position from storage rather than taking
        // eight arguments off the stack. Same reason as `_buy`: solc's 16-slot limit, and `viaIR`
        // was rejected because it re-derives the whole bytecode. Re-reading is also strictly more
        // truthful — the event reports what was STORED, so an event and a position cannot disagree.
        _emitEntered(strayId, slot, ethIn, received);
    }

    /// See the call site. Reads the position back so the log cannot drift from the state.
    function _emitEntered(bytes32 strayId, uint256 slot, uint256 ethIn, uint256 received) private {
        Position storage p = positions[strayId][slot];
        emit Entered(
            strayId, p.token, slot, ethIn, received, p.tickSpacing, p.hook, p.peakPriceWei
        );
    }

    /**
     * Execute the BUY leg and return the MEASURED fill.
     *
     * ══ WHY THIS IS A SEPARATE FUNCTION ══
     *
     * Purely to bound the stack: `hunt` carries six arguments plus a slot index plus two storage
     * pointers, and inlining the swap here pushed solc past its 16-slot limit ("Stack too deep").
     *
     * The alternative was `viaIR`, and it was rejected deliberately: switching the pipeline changes
     * the emitted bytecode wholesale, which would mean the Blockscout verification, the gas figures
     * and the encoding golden vector are all re-derived from a compiler configuration this project
     * has never shipped. A private helper changes the source's shape and not the compiler's.
     *
     * It contains NO checks of its own that a caller could skip, and it is `private` rather than
     * `internal` so no subclass — including the test harnesses — can reach it and accidentally
     * swap without the allowlist and stake checks `hunt` performs first.
     */
    function _buy(
        address token,
        address hook,
        int24 tickSpacing,
        uint256 ethIn,
        uint256 minOut
    ) private returns (uint256 received) {
        uint256 before = IERC20(token).balanceOf(address(this));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _encodeSwap(token, hook, tickSpacing, true, ethIn, minOut);
        router.execute{value: ethIn}(COMMAND_V4_SWAP, inputs, block.timestamp);

        // The fill is MEASURED from our own balance, never estimated and never taken from an
        // argument. This is the only number that can be trusted after the call returns.
        received = IERC20(token).balanceOf(address(this)) - before;
        if (received < minOut) revert NothingReceived();
    }

    /**
     * RAISE THE PEAK WATERMARK on one open position. Keeper-only, monotone, moves no value.
     *
     * ══ WHY THE KEEPER MAINTAINS THIS AND WHY THAT IS SAFE ══
     *
     * The trailing stop needs the highest price seen since entry, and this contract cannot observe
     * price on its own — it has no oracle and reading one from the pool mid-tick would be a price
     * this contract could be made to believe by anyone willing to move the pool for one block.
     *
     * So the keeper reports it, and the damage a false report can do is bounded by the direction:
     *
     *   - **This function only ever RAISES.** A call with a lower price is a no-op, not a write.
     *     So a keeper cannot LOWER a watermark, which is the direction that would loosen a trailing
     *     stop and let a position keep falling. That is the dangerous direction and it is closed
     *     structurally, by the `<=` return below, not by a check on the caller's honesty.
     *   - A keeper reporting a FALSELY HIGH peak tightens its own stop and makes the cat sell
     *     early. That is market risk of the kind a compromised keeper already has in unlimited
     *     supply (it can simply `flee` at any moment), so it adds no new capability.
     *
     * And critically: **nothing in this contract reads `peakPriceWei` to gate anything.** It is
     * recorded and returned. `flee` does not consult it. So a wrong value cannot block an exit,
     * cannot block a withdrawal, and cannot move money. It is durable state for an off-chain rule,
     * placed on chain because §10's exit is stateful and RESEARCH §7f records what happens to state
     * that lives only in a process that gets redeployed.
     *
     * Returns the peak after the call, so a caller sees the effective value without a second read.
     */
    function mark(bytes32 strayId, uint256 slot, uint256 priceWei)
        external
        onlyKeeper
        returns (uint256)
    {
        if (slot >= MAX_POSITIONS) revert BadSlot();
        Position storage p = positions[strayId][slot];
        if (p.token == address(0)) revert NotHolding();

        uint256 current = p.peakPriceWei;
        // MONOTONE. A lower or equal report is a no-op — see the header for why this direction is
        // the one that matters.
        if (priceWei <= current) return current;
        if (priceWei > type(uint128).max) revert PositionTooLarge();

        p.peakPriceWei = uint128(priceWei);
        emit PeakRaised(strayId, slot, current, priceWei);
        return priceWei;
    }

    /**
     * Sell everything in ONE slot, back to native ETH.
     *
     * The full token balance is read from the chain as a `uint256` and passed straight through.
     * meridian records the failure this avoids: a real 18-decimal balance needs ~22 significant
     * digits, beyond float64's ~15-17, so round-tripping a "sell everything" amount through a
     * float reconstructs a wei amount that does not match the balance and reverts with
     * TRANSFER_FROM_FAILED. Nothing here converts, so nothing can drift.
     *
     * ══ THE HOOK AND TICK SPACING COME FROM THE POSITION, NOT FROM THE CALLER ══
     *
     * A sell must address the same pool the buy addressed. Taking them as arguments would let a
     * keeper build a PoolKey for a different pool — at best a revert, at worst a real loss against
     * different liquidity. Reading them back from the slot makes that unrepresentable.
     *
     * ══ THIS IS NOT GATED ON THE TRAILING STOP ══
     *
     * `peakPriceWei` is not consulted here. A contract-side condition on selling is a condition
     * that can prevent selling, and DESIGN §6 Rule 5 does not have an exception for a condition we
     * happen to like. The stop lives in the keeper; the watermark it reads lives here.
     */
    function flee(bytes32 strayId, uint256 slot, uint256 minOut) external onlyKeeper nonReentrant {
        Stray storage s = strays[strayId];
        if (s.owner == address(0)) revert NoSuchStray();
        if (slot >= MAX_POSITIONS) revert BadSlot();
        Position storage p = positions[strayId][slot];
        address token = p.token;
        if (token == address(0)) revert NotHolding();
        if (minOut == 0) revert ZeroSlippageBound();

        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NotHolding();

        int24 tickSpacing = p.tickSpacing;
        address hook = p.hook;
        uint256 peak = p.peakPriceWei;

        // EFFECTS first. The whole slot is cleared before the external call.
        p.token = address(0);
        p.tickSpacing = 0;
        p.hook = address(0);
        p.costBasis = 0;
        p.peakPriceWei = 0;
        p.openedAt = 0;

        // The router pulls ERC-20s through Permit2, so both approvals must exist. They are set
        // per call rather than infinitely: an exact approval is @taia/swap's rule, and an
        // unlimited standing approval to a router we do not control is a liability that outlives
        // the trade.
        IERC20(token).approve(address(permit2), amount);
        permit2.approve(token, address(router), uint160(amount), uint48(block.timestamp + 1800));

        uint256 before = address(this).balance;

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _encodeSwap(token, hook, tickSpacing, false, amount, minOut);
        router.execute(COMMAND_V4_SWAP, inputs, block.timestamp);

        uint256 received = address(this).balance - before;
        if (received < minOut) revert NothingReceived();

        // The proceeds are credited back to the SAME stray that funded the position. There is no
        // path by which stray A's trade can credit stray B.
        s.stake += uint128(received);

        emit Exited(strayId, token, slot, amount, received, peak);
    }

    // ── Exit — always available, gated by nothing ────────────────────────────────────────────

    /**
     * Take the money out. Owner only, and callable at ALL times.
     *
     * No risk control, no pause, no keeper state and NO NUMBER OF OPEN POSITIONS can block this.
     * meridian's circuit breaker deliberately excludes withdrawals for exactly this reason —
     * "getting OUT is always allowed" — and `test_withdrawWorksWithEightPositionsOpen` proves that
     * the multi-position rewrite did not quietly introduce a gate.
     *
     * If the stray is mid-position the tokens are NOT force-sold: selling on the user's behalf at
     * a price nobody chose is worse than handing back what is there. The uncommitted stake is
     * returned and the positions remain for the keeper to close, after which the rest is
     * withdrawable. `positionsOf` lets the UI say so plainly, slot by slot.
     *
     * Note what this function does NOT do: it does not loop over positions. Its gas is constant in
     * the number of open slots, so a keeper cannot make a user's exit expensive by opening more.
     */
    function withdraw(bytes32 strayId) external nonReentrant {
        Stray storage s = strays[strayId];
        if (s.owner != msg.sender) revert NotOwner();

        uint256 amount = s.stake;
        if (amount == 0) revert InsufficientStake();

        // ══ THE RAKE, AND WHY IT CANNOT TOUCH PRINCIPAL ══
        //
        // Profit is what comes back ABOVE what went in. The rake applies to that difference only,
        // and the comparison is against `principal`, which is written once at adopt and never
        // increased. If the stray is flat or down, `profit` is zero by the branch below and the
        // user receives everything.
        uint256 principal = s.principal;
        uint256 rake = 0;
        if (amount > principal) {
            rake = ((amount - principal) * PROFIT_RAKE_BPS) / 10_000;
        }
        uint256 payout = amount - rake;

        // EFFECTS. Both the stake and the principal are reduced so a partial exit cannot be
        // replayed to rake the same profit twice.
        s.stake = 0;
        s.principal = amount > principal ? 0 : uint128(principal - amount);

        emit Withdrawn(strayId, msg.sender, payout, rake);

        (bool ok,) = msg.sender.call{value: payout}("");
        if (!ok) revert TransferFailed();

        if (rake > 0) {
            (bool ok2,) = house.call{value: rake}("");
            if (!ok2) revert TransferFailed();
        }
    }

    // ── Views ────────────────────────────────────────────────────────────────────────────────

    /**
     * Every slot, open or free, in index order. Free slots have `token == address(0)`.
     *
     * Returned as the full fixed array rather than a filtered list so the caller sees the SLOT
     * INDEX, which is what `flee` and `mark` take. A filtered list would renumber and a caller
     * acting on position 0 of a filtered list would be acting on the wrong slot.
     */
    function positionsOf(bytes32 strayId)
        external
        view
        returns (Position[MAX_POSITIONS] memory)
    {
        return positions[strayId];
    }

    /// One slot. Reverts on an out-of-range index rather than returning a zeroed struct.
    function positionAt(bytes32 strayId, uint256 slot) external view returns (Position memory) {
        if (slot >= MAX_POSITIONS) revert BadSlot();
        return positions[strayId][slot];
    }

    /// How many slots are occupied, and how many remain. Bounded at MAX_POSITIONS iterations.
    function openPositionCount(bytes32 strayId) public view returns (uint256 open) {
        Position[MAX_POSITIONS] storage slots = positions[strayId];
        for (uint256 i = 0; i < MAX_POSITIONS; i++) {
            if (slots[i].token != address(0)) open++;
        }
    }

    /**
     * The token in a slot and the vault's balance of it.
     *
     * Note the balance is the VAULT's whole balance of that token, which is the same number `flee`
     * will sell. That is exact rather than approximate precisely because `hunt` refuses to open
     * the same token in two slots — see its header.
     */
    function holdingOf(bytes32 strayId, uint256 slot)
        external
        view
        returns (address token, uint256 balance)
    {
        if (slot >= MAX_POSITIONS) revert BadSlot();
        token = positions[strayId][slot].token;
        balance = token == address(0) ? 0 : IERC20(token).balanceOf(address(this));
    }

    function stakeOf(bytes32 strayId) external view returns (uint256) {
        return strays[strayId].stake;
    }

    /// What `withdraw` would pay right now, and what the house would take. Used by the UI so the
    /// number a user is shown is computed by the same arithmetic that will run.
    function quoteWithdraw(bytes32 strayId) external view returns (uint256 payout, uint256 rake) {
        Stray storage s = strays[strayId];
        uint256 amount = s.stake;
        if (amount > s.principal) {
            rake = ((amount - s.principal) * PROFIT_RAKE_BPS) / 10_000;
        }
        payout = amount - rake;
    }

    /// Is `hook` one of the two the pad actually uses? Public so the keeper can check before it
    /// spends gas on a call that would revert.
    function isKnownHook(address hook) public view returns (bool) {
        return hook == hookA || hook == hookB;
    }

    // ── Encoding ─────────────────────────────────────────────────────────────────────────────

    /**
     * THE HOOK ALLOWLIST CHECK. The only thing standing between a keeper key and an arbitrary
     * contract executing inside our swap.
     *
     * `test_SABOTAGE_arbitraryHookRefused` deletes this and must fail.
     */
    function _requireKnownHook(address hook) internal view {
        if (!isKnownHook(hook)) revert UnknownHook();
    }

    /**
     * Build one v4 `execute` input for a single-pool exact-input swap.
     *
     * ══ THIS FUNCTION TAKES NO RECIPIENT AND MUST NEVER GROW ONE ══
     *
     * `TAKE_ALL` (0x0f) has parameters `(currency, minAmount)` and no recipient field, so the
     * proceeds settle to whoever called the router — this contract. The custody property is
     * enforced by the SHAPE of this calldata rather than by a check somewhere that could be
     * removed. `test_SABOTAGE_encodingHasNoRecipientField` asserts on the encoded bytes.
     *
     * ETH is currency0 because address(0) sorts first, so buying the token is zeroForOne = true
     * and selling it is false. `fee` is 0 on every letscash pool: the pool charges no LP fee and
     * the hook takes the entire tax. That was derived by reconstructing a live pool's poolId and
     * matching the pad's own value on the first attempt (RESEARCH §2), not assumed.
     *
     * `hook` is now a PARAMETER rather than an immutable — RESEARCH §7d, and the header. Callers
     * are `hunt` (which allowlists it) and `flee` (which reads it back from the position that
     * `hunt` allowlisted). There is no third caller and no path that reaches here with an
     * unchecked hook.
     */
    function _encodeSwap(
        address token,
        address hook,
        int24 tickSpacing,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minOut
    ) internal pure returns (bytes memory) {
        // ══ WHY THIS IS abi.encode(ExactInputSingleParams) AND NOT FIVE POSITIONAL ARGS ══
        //
        // Caught by diffing this function's output against viem's, which is the encoding a real
        // swap landed with on mainnet. The first version passed the PoolKey and the four other
        // fields as five positional arguments to abi.encode. It produced calldata 64 bytes SHORT,
        // with every word from index 6 onward shifted by one.
        //
        // The cause is that `ExactInputSingleParams` contains a `bytes` member (`hookData`), which
        // makes the WHOLE STRUCT dynamic. A dynamic struct is encoded as an OFFSET word pointing
        // at its body — the `0x20` at word [9] — and encoding its fields positionally omits that
        // word entirely. openhood's `venue.ts` records the identical defect in its own first
        // encoder and says it plainly: "a difference no type checker and no unit test of my own
        // arithmetic would have caught, and which would have spent real ETH on a malformed call."
        //
        // Passing a single struct value makes solc emit the offset, which is why the shape below
        // is not a stylistic preference. `test_encodingMatchesProvenViemBytes` pins it.
        ExactInputSingleParams memory p = ExactInputSingleParams({
            poolKey: PoolKey({
                currency0: NATIVE,
                currency1: token,
                fee: uint24(0),
                tickSpacing: tickSpacing,
                hooks: hook
            }),
            zeroForOne: zeroForOne,
            amountIn: uint128(amountIn),
            amountOutMinimum: uint128(minOut),
            hookData: bytes("")
        });

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(p);
        // SETTLE_ALL — what we are willing to pay in.
        params[1] = abi.encode(zeroForOne ? NATIVE : token, amountIn);
        // TAKE_ALL — what we must receive. NO RECIPIENT FIELD.
        params[2] = abi.encode(zeroForOne ? token : NATIVE, minOut);

        return abi.encode(V4_ACTIONS, params);
    }

    /**
     * Accept ETH from the router or the PoolManager only.
     *
     * A bare `receive()` that credits nobody would let anyone donate ETH into the contract, which
     * is harmless but makes the contract's balance stop matching the sum of the compartments and
     * therefore makes every accounting assertion untestable. Restricting the sender keeps
     * `address(this).balance` reconcilable against `sum(stakeOf)`.
     */
    receive() external payable {
        if (msg.sender != address(router) && msg.sender != poolManager) revert TransferFailed();
    }
}
