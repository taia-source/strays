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
 * ══ THE FIVE SENTENCES THAT DESCRIBE THE WHOLE SECURITY MODEL ══
 *
 * 1. **A user can always withdraw.** `withdraw` pays `msg.sender` and only `msg.sender`. No role
 *    here can stop it, there is no pause on the exit, and no risk control gates it. meridian's
 *    own rule, learned live: "getting OUT is always allowed."
 * 2. **No function pays a caller-supplied address.** Search this file for a parameter named `to`
 *    or `recipient`. There is none, on any path, for any role.
 * 3. **Per-stray balances are compartments in a mapping keyed by stray id.** Stray `a`'s balance
 *    is arithmetically unreachable from a call naming stray `b`. Isolation is the mapping, not a
 *    check that could be deleted — and `test_SABOTAGE_keeperCannotSpendStrayAOnStrayB` proves it.
 * 4. **The keeper can do exactly one thing: swap a stray's own ETH for a token, and back.** It is
 *    `immutable`. It cannot withdraw, cannot move value between strays, and cannot receive.
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
 *                              hunt ──────────────┤ THIS CONTRACT calls the router.
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
 *   an argument here: the keeper passes a token address and two uint256s, all of which are
 *   validated on chain against this contract's own reads.
 *
 * ══ WHAT IT DOES *NOT* PROTECT AGAINST — stated rather than glossed ══
 *
 * - **A bug in this file.** It is adversarially tested (see `StrayVault.t.sol`, 8 sabotages) and
 *   **not externally audited**. Ibrahim accepted that in writing; users did not, so `/docs` says
 *   it in the product.
 * - **The pad's `hook` and `revenueSplitter` are UNVERIFIED on Blockscout** and every swap routes
 *   through them. Unmitigable by us; bounded only by `MAX_POSITION_WEI`.
 * - **A losing strategy.** Nothing here protects a user from the cat simply being wrong. That is
 *   the product.
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
     * The only address that may call `hunt`. Immutable for the same reason as `house`.
     *
     * A compromised keeper key can make BAD TRADES — market risk, which is real and is bounded by
     * `MAX_POSITION_WEI` and the strategy's own stop. It cannot make the money land anywhere
     * else, because `hunt` has no recipient parameter and `TAKE_ALL` has no recipient field.
     * That is theft, and it is structurally impossible here rather than merely disallowed.
     */
    address public immutable keeper;

    /// The v4 UniversalRouter. Immutable so a swap can never be routed to an attacker's contract.
    IUniversalRouter public immutable router;

    /// Permit2, needed only on the SELL leg (the router pulls ERC-20s through it).
    IPermit2 public immutable permit2;

    /// The letscash fee hook. Part of every PoolKey on this pad; immutable so a pool cannot be faked.
    address public immutable hook;

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
     *
     * At the intended $5 stake the fee is ~$1.25 on a $6.25 adopt. Measured costs it must cover:
     * gas is ~$0.016 per round trip (RESEARCH §3b) and the LLM is batched across the colony
     * rather than called per cat (DESIGN §5), so the dominant term is RPC and the fee is set well
     * above the modelled burn rather than tuned to it.
     */
    uint256 public constant ENERGY_FEE_BPS = 2000;

    /**
     * The largest ETH a single `hunt` may put into one position.
     *
     * This is the bound on the UNVERIFIED-HOOK risk (see the header). We cannot audit the pad's
     * hook or revenue splitter, so the honest control is to cap what a single trade can lose to
     * one. 0.01 ETH ≈ $19 at the ETH price measured at build time.
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

    struct Stray {
        /// Who may withdraw. Set once at adopt and never changed by any function.
        address owner;
        /// Uncommitted ETH this stray can still spend.
        uint128 stake;
        /// What the owner originally put in, net of the energy fee. The rake basis.
        uint128 principal;
        /// The token currently held, or address(0) when flat.
        address holding;
        /// Tick spacing of the pool we entered, needed to rebuild the same PoolKey on exit.
        int24 tickSpacing;
        /// ETH spent acquiring `holding`. Used only for events; the rake is computed on principal.
        uint128 costBasis;
    }

    mapping(bytes32 => Stray) public strays;

    /// Reentrancy guard. 1 = not entered, 2 = entered.
    uint256 private _lock = 1;

    // ── Events ───────────────────────────────────────────────────────────────────────────────

    event Adopted(bytes32 indexed strayId, address indexed owner, uint256 stake, uint256 energyFee);
    event Entered(
        bytes32 indexed strayId, address indexed token, uint256 ethIn, uint256 tokensOut, int24 tickSpacing
    );
    event Exited(bytes32 indexed strayId, address indexed token, uint256 tokensIn, uint256 ethOut);
    event Withdrawn(bytes32 indexed strayId, address indexed owner, uint256 paid, uint256 rake);

    // ── Errors ───────────────────────────────────────────────────────────────────────────────

    error NotKeeper();
    error NotOwner();
    error AlreadyExists();
    error NoSuchStray();
    error BelowMinimum();
    error PositionTooLarge();
    error InsufficientStake();
    error AlreadyHolding();
    error NotHolding();
    error ZeroSlippageBound();
    error ZeroAddress();
    error Reentrancy();
    error TransferFailed();
    error NothingReceived();

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

    constructor(address house_, address keeper_, address router_, address permit2_, address hook_) {
        if (
            house_ == address(0) || keeper_ == address(0) || router_ == address(0)
                || permit2_ == address(0) || hook_ == address(0)
        ) revert ZeroAddress();
        house = house_;
        keeper = keeper_;
        router = IUniversalRouter(router_);
        permit2 = IPermit2(permit2_);
        hook = hook_;
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

        strays[strayId] = Stray({
            owner: msg.sender,
            stake: uint128(stake),
            principal: uint128(stake),
            holding: address(0),
            tickSpacing: 0,
            costBasis: 0
        });

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
     * Buy `token` with `ethIn` of the stray's own stake.
     *
     * ══ WHAT THE KEEPER SUPPLIES, AND WHAT IT CANNOT ══
     *
     * It supplies INTENT: which token, how much to spend, and the minimum acceptable output. It
     * does NOT supply calldata, a recipient, a router address, or a pool. This function builds
     * the router call itself from immutable addresses, so there is nothing for a compromised
     * keeper to redirect.
     *
     * `minOut` is required to be non-zero. openhood records that the real landed mainnet swap it
     * decoded carried `amountOutMinimum = 0` in both slippage slots, and that reusing that would
     * be "a free MEV sandwich on every trade". The encoding is inherited; those two zeros are not.
     */
    function hunt(bytes32 strayId, address token, uint256 ethIn, uint256 minOut, int24 tickSpacing)
        external
        onlyKeeper
        nonReentrant
    {
        Stray storage s = strays[strayId];
        if (s.owner == address(0)) revert NoSuchStray();
        if (s.holding != address(0)) revert AlreadyHolding();
        if (token == address(0)) revert ZeroAddress();
        if (minOut == 0) revert ZeroSlippageBound();
        if (ethIn > MAX_POSITION_WEI) revert PositionTooLarge();
        if (ethIn == 0 || ethIn > s.stake) revert InsufficientStake();

        // EFFECTS before the external call. The stake is debited here so that a reentrant call
        // arriving during the swap sees the reduced balance rather than the original.
        s.stake -= uint128(ethIn);
        s.holding = token;
        s.tickSpacing = tickSpacing;
        s.costBasis = uint128(ethIn);

        uint256 before = IERC20(token).balanceOf(address(this));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _encodeSwap(token, tickSpacing, true, ethIn, minOut);
        router.execute{value: ethIn}(COMMAND_V4_SWAP, inputs, block.timestamp);

        // The fill is MEASURED from our own balance, never estimated and never taken from an
        // argument. This is the only number that can be trusted after the call returns.
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received < minOut) revert NothingReceived();

        emit Entered(strayId, token, ethIn, received, tickSpacing);
    }

    /**
     * Sell everything this stray holds, back to native ETH.
     *
     * The full token balance is read from the chain as a `uint256` and passed straight through.
     * meridian records the failure this avoids: a real 18-decimal balance needs ~22 significant
     * digits, beyond float64's ~15-17, so round-tripping a "sell everything" amount through a
     * float reconstructs a wei amount that does not match the balance and reverts with
     * TRANSFER_FROM_FAILED. Nothing here converts, so nothing can drift.
     */
    function flee(bytes32 strayId, uint256 minOut) external onlyKeeper nonReentrant {
        Stray storage s = strays[strayId];
        if (s.owner == address(0)) revert NoSuchStray();
        address token = s.holding;
        if (token == address(0)) revert NotHolding();
        if (minOut == 0) revert ZeroSlippageBound();

        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NotHolding();

        int24 tickSpacing = s.tickSpacing;

        // EFFECTS first.
        s.holding = address(0);
        s.tickSpacing = 0;
        s.costBasis = 0;

        // The router pulls ERC-20s through Permit2, so both approvals must exist. They are set
        // per call rather than infinitely: an exact approval is @taia/swap's rule, and an
        // unlimited standing approval to a router we do not control is a liability that outlives
        // the trade.
        IERC20(token).approve(address(permit2), amount);
        permit2.approve(token, address(router), uint160(amount), uint48(block.timestamp + 1800));

        uint256 before = address(this).balance;

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _encodeSwap(token, tickSpacing, false, amount, minOut);
        router.execute(COMMAND_V4_SWAP, inputs, block.timestamp);

        uint256 received = address(this).balance - before;
        if (received < minOut) revert NothingReceived();

        // The proceeds are credited back to the SAME stray that funded the position. There is no
        // path by which stray A's trade can credit stray B.
        s.stake += uint128(received);

        emit Exited(strayId, token, amount, received);
    }

    // ── Exit — always available, gated by nothing ────────────────────────────────────────────

    /**
     * Take the money out. Owner only, and callable at ALL times.
     *
     * No risk control, no pause, no keeper state and no holding can block this. meridian's
     * circuit breaker deliberately excludes withdrawals for exactly this reason — "getting OUT is
     * always allowed" — and `test_withdrawWorksEvenWhileHolding` proves it here.
     *
     * If the stray is mid-position the token is NOT force-sold: selling on the user's behalf at a
     * price nobody chose is worse than handing back what is there. The uncommitted stake is
     * returned and the position remains for the keeper to close, after which the rest is
     * withdrawable. `holdingOf` lets the UI say so plainly.
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

    function holdingOf(bytes32 strayId) external view returns (address token, uint256 balance) {
        token = strays[strayId].holding;
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

    // ── Encoding ─────────────────────────────────────────────────────────────────────────────

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
     */
    function _encodeSwap(
        address token,
        int24 tickSpacing,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minOut
    ) internal view returns (bytes memory) {
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
     * Accept ETH from the router only.
     *
     * A bare `receive()` that credits nobody would let anyone donate ETH into the contract, which
     * is harmless but makes the contract's balance stop matching the sum of the compartments and
     * therefore makes every accounting assertion untestable. Restricting the sender keeps
     * `address(this).balance` reconcilable against `sum(stakeOf)`.
     */
    receive() external payable {
        if (msg.sender != address(router)) revert TransferFailed();
    }
}
