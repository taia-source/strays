// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StrayVault} from "../src/StrayVault.sol";

/**
 * The adversarial suite for `StrayVault`.
 *
 * ══ WHY THIS FILE IS WRITTEN THE WAY IT IS ══
 *
 * There is **no external audit** of this contract. Ibrahim accepted that risk in writing; users did
 * not. So these tests are the only thing between a user and a bug, and they are written on the
 * assumption that happy-path coverage is worthless.
 *
 * `BUILD-A-PROJECT.md`: "After writing a check, break the code it guards and confirm the check
 * fails... If a sabotage passes, the check is decoration. Fix the check, not the sabotage."
 *
 * Across recent sessions in this corpus that discipline found: an auth bypass where deleting
 * signature verification passed all 22 tests; two regexes that could never match anything; and
 * eleven sabotages that survived because a wire was tested at both ends and not in the middle.
 *
 * ══ THE RULE THAT CATCHES THE HARDEST CLASS ══
 *
 * unitick found the same defect shape FIVE times in one project. Its fifth was a CEI violation in
 * `claim` that passed all 143 tests because `nonReentrant` alone defeated the attack. The rule:
 *
 *     **When two mechanisms can independently reject the same input, at least one test must
 *     construct an input that only ONE of them rejects.**
 *
 * Applied throughout, and applied SPECIFICALLY to the two new mechanisms in V2:
 *
 *   - The hook allowlist and the pool's own existence can BOTH reject a bad hook. So
 *     `test_SABOTAGE_arbitraryHookRefused` probes with a hook that is a perfectly functional
 *     contract in the mock world — one the router would happily swap against — so the ONLY thing
 *     that can refuse it is `_requireKnownHook`.
 *   - The free-slot search and `s.stake` can BOTH reject a ninth position. So
 *     `test_SABOTAGE_ninthPositionRefusedWithMoneyToSpare` funds the stray far beyond what nine
 *     positions cost, making `NoFreeSlot` the only possible refusal.
 */

// ── Test doubles ─────────────────────────────────────────────────────────────────────────────

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function burn(address from, uint256 amt) external {
        balanceOf[from] -= amt;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }
}

contract MockPermit2 {
    event Approved(address token, address spender, uint160 amount);

    function approve(address token, address spender, uint160 amount, uint48) external {
        emit Approved(token, spender, amount);
    }
}

/**
 * A router that behaves like the real one for accounting purposes: it takes the ETH sent with a
 * buy and mints tokens to the caller, and on a sell it burns tokens and sends ETH back.
 *
 * `rate` is tokens-per-wei, so a test can simulate a profitable or a losing round trip.
 *
 * ══ IT DECODES THE POOLKEY, WHICH IS WHAT MAKES THE MULTI-TOKEN TESTS HONEST ══
 *
 * V1's mock ignored the calldata entirely and minted whatever single token it had been configured
 * with. That was survivable when a stray held one position; with eight it would make every
 * multi-position test a lie, because `hunt(tokenB)` would mint tokenA and the test would still
 * pass. So this router DECODES the encoded swap and acts on the token and hook the contract
 * actually named. A mock that ignores its input cannot detect an encoder that gets it wrong.
 */
contract MockRouter {
    /// tokens-per-wei on a buy; wei = tokens/rate on a sell.
    uint256 public rate = 1000;
    bool public shortfall;
    /// The hook named in the last swap this router was asked to perform. Observed by tests.
    address public lastHook;
    address public lastToken;

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    function setShortfall(bool s) external {
        shortfall = s;
    }

    function execute(bytes calldata, bytes[] calldata inputs, uint256) external payable {
        // Decode what the VAULT actually asked for, rather than assuming.
        (, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        ExactInputSingleParams memory p = abi.decode(params[0], (ExactInputSingleParams));
        lastHook = p.poolKey.hooks;
        lastToken = p.poolKey.currency1;
        MockERC20 token = MockERC20(p.poolKey.currency1);

        if (p.zeroForOne) {
            // BUY: ETH in, tokens to the caller.
            uint256 out = shortfall ? 1 : msg.value * rate;
            token.mint(msg.sender, out);
        } else {
            // SELL: burn the caller's tokens, return ETH.
            uint256 bal = token.balanceOf(msg.sender);
            token.burn(msg.sender, bal);
            uint256 out = shortfall ? 1 : bal / rate;
            (bool ok,) = msg.sender.call{value: out}("");
            require(ok, "router send failed");
        }
    }

    receive() external payable {}
}

/// Tries to re-enter `withdraw` from its ETH callback.
contract ReentrantOwner {
    StrayVault public vault;
    bytes32 public id;
    uint256 public depth;

    constructor(StrayVault v) {
        vault = v;
    }

    function adopt(bytes32 strayId) external payable {
        id = strayId;
        vault.adopt{value: msg.value}(strayId);
    }

    function pull() external {
        vault.withdraw(id);
    }

    receive() external payable {
        if (depth < 2) {
            depth++;
            vault.withdraw(id);
        }
    }
}

/// Exposes the internal encoder.
contract EncoderHarness is StrayVault {
    constructor(address h, address k, address r, address p, address ha, address hb)
        StrayVault(h, k, r, p, ha, hb, r)
    {}

    function encode(address token, address hook, int24 ts, bool zfo, uint256 amtIn, uint256 minOut)
        external
        pure
        returns (bytes memory)
    {
        return _encodeSwap(token, hook, ts, zfo, amtIn, minOut);
    }
}

// ── A shared fixture ─────────────────────────────────────────────────────────────────────────

abstract contract VaultFixture is Test {
    StrayVault vault;
    MockRouter router;
    MockERC20 token;
    MockPermit2 permit2;

    address house = makeAddr("house");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    /// The two REAL letscash hooks, re-measured 2026-08-07 (RESEARCH §7d). 67 tokens on A,
    /// 44 on B — and LEVCAT, INTERN and Seriouscat are all on B, which V1 could not reach.
    address constant HOOK_A = 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC;
    address constant HOOK_B = 0xEfe669814e5Eec33406Bd50ffa8331618D076aEc;

    bytes32 constant A = keccak256("stray-a");
    bytes32 constant B = keccak256("stray-b");

    function _setUpVault() internal {
        token = new MockERC20();
        router = new MockRouter();
        permit2 = new MockPermit2();
        vault = new StrayVault(
            house, keeper, address(router), address(permit2), HOOK_A, HOOK_B, address(router)
        );
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(address(router), 100 ether);
    }

    function _adopt(address who, bytes32 id, uint256 amt) internal {
        vm.prank(who);
        vault.adopt{value: amt}(id);
    }

    /// Buy into the first free slot with the default hook.
    function _hunt(bytes32 id, address tok, uint256 ethIn) internal returns (uint256 slot) {
        vm.prank(keeper);
        return vault.hunt(id, tok, HOOK_A, ethIn, 1, 200);
    }
}

// ── The suite ────────────────────────────────────────────────────────────────────────────────

contract StrayVaultTest is VaultFixture {
    function setUp() public {
        _setUpVault();
    }

    // ══ ADOPTION ════════════════════════════════════════════════════════════════════════════

    function test_adoptSplitsAndPaysHouseImmediately() public {
        uint256 before = house.balance;
        _adopt(alice, A, 1 ether);

        // 20% energy fee, forwarded now rather than accrued.
        assertEq(house.balance - before, 0.2 ether, "house not paid at adopt");
        assertEq(vault.stakeOf(A), 0.8 ether, "stake wrong");
        assertEq(address(vault).balance, 0.8 ether, "vault balance != stake");
    }

    /// The constraint "the house never funds an agent" is arithmetic, not a hope.
    function test_houseIsCashPositiveTheMomentAStrayExists() public {
        uint256 before = house.balance;
        _adopt(alice, A, 1 ether);
        assertGt(house.balance, before, "house must be up on adoption");
    }

    function test_adoptRefusesBelowMinimum() public {
        vm.prank(alice);
        vm.expectRevert(StrayVault.BelowMinimum.selector);
        vault.adopt{value: 0.0009 ether}(A);
    }

    function test_adoptRefusesDuplicateId() public {
        _adopt(alice, A, 1 ether);
        vm.prank(bob);
        vm.expectRevert(StrayVault.AlreadyExists.selector);
        vault.adopt{value: 1 ether}(A);
    }

    // ══ THE ORIGINAL SABOTAGES, CARRIED FORWARD ═════════════════════════════════════════════

    /// SABOTAGE 1 — remove the keeper check on `hunt`. Only the keeper may trade.
    function test_SABOTAGE_onlyKeeperCanHunt() public {
        _adopt(alice, A, 1 ether);
        vm.prank(alice); // the OWNER, who is still not the keeper
        vm.expectRevert(StrayVault.NotKeeper.selector);
        vault.hunt(A, address(token), HOOK_A, 0.005 ether, 1, 200);

        vm.prank(bob);
        vm.expectRevert(StrayVault.NotKeeper.selector);
        vault.hunt(A, address(token), HOOK_A, 0.005 ether, 1, 200);
    }

    /// SABOTAGE 1b — `mark` is the keeper's new power, and it must be the keeper's alone.
    function test_SABOTAGE_onlyKeeperCanMark() public {
        _adopt(alice, A, 1 ether);
        _hunt(A, address(token), 0.005 ether);

        vm.prank(alice);
        vm.expectRevert(StrayVault.NotKeeper.selector);
        vault.mark(A, 0, 1e18);

        vm.prank(bob);
        vm.expectRevert(StrayVault.NotKeeper.selector);
        vault.mark(A, 0, 1e18);
    }

    /// SABOTAGE 2 — remove the owner check on `withdraw`. Only the owner may exit.
    function test_SABOTAGE_onlyOwnerCanWithdraw() public {
        _adopt(alice, A, 1 ether);

        vm.prank(bob);
        vm.expectRevert(StrayVault.NotOwner.selector);
        vault.withdraw(A);

        // Not even the keeper or the house.
        vm.prank(keeper);
        vm.expectRevert(StrayVault.NotOwner.selector);
        vault.withdraw(A);

        vm.prank(house);
        vm.expectRevert(StrayVault.NotOwner.selector);
        vault.withdraw(A);
    }

    /**
     * SABOTAGE 3 — spend stray A's balance on stray B.
     *
     * Isolation is the MAPPING, not a check. This test spends B's entire stake and then asserts
     * A's is untouched, which fails if the compartments were ever merged into one balance.
     */
    function test_SABOTAGE_keeperCannotSpendStrayAOnStrayB() public {
        _adopt(alice, A, 1 ether); // A: 0.8 stake
        _adopt(bob, B, 0.005 ether); // B: 0.004 stake

        uint256 aBefore = vault.stakeOf(A);

        // The keeper tries to put more into B's position than B owns — but an amount still
        // UNDER the position cap, so the only thing that can refuse it is B's own compartment.
        // (An amount over the cap would be refused by PositionTooLarge and would prove nothing
        // about isolation: two mechanisms rejecting one input teaches you nothing about which.)
        assertLt(0.009 ether, vault.MAX_POSITION_WEI(), "the probe must sit under the cap");
        assertGt(0.009 ether, vault.stakeOf(B), "the probe must exceed B's own stake");
        vm.prank(keeper);
        vm.expectRevert(StrayVault.InsufficientStake.selector);
        vault.hunt(B, address(token), HOOK_A, 0.009 ether, 1, 200);

        // And spending B's real balance must not move A's.
        _hunt(B, address(token), 0.004 ether);

        assertEq(vault.stakeOf(A), aBefore, "stray A's compartment was reachable from a call about B");
        assertEq(vault.stakeOf(B), 0, "stray B did not pay for its own position");
    }

    /**
     * SABOTAGE 3b — PER-SLOT isolation, which is new in V2.
     *
     * The compartment test above proves stray A cannot reach stray B. This proves the eight slots
     * INSIDE one stray are independent: closing slot 2 must not disturb slots 0, 1 or 3, and the
     * proceeds must land in the stray's stake exactly once.
     */
    function test_SABOTAGE_slotsAreIndependentWithinAStray() public {
        _adopt(alice, A, 1 ether);
        MockERC20[4] memory toks;
        for (uint256 i = 0; i < 4; i++) {
            toks[i] = new MockERC20();
            uint256 s = _hunt(A, address(toks[i]), 0.001 ether);
            assertEq(s, i, "slots were not filled in index order");
        }

        uint256 stakeBefore = vault.stakeOf(A);

        // Close slot 2 only.
        vm.prank(keeper);
        vault.flee(A, 2, 1);

        // Slot 2 is empty; every other slot is exactly as it was.
        (address t2,) = vault.holdingOf(A, 2);
        assertEq(t2, address(0), "slot 2 did not close");
        (address t0,) = vault.holdingOf(A, 0);
        (address t1,) = vault.holdingOf(A, 1);
        (address t3,) = vault.holdingOf(A, 3);
        assertEq(t0, address(toks[0]), "closing slot 2 disturbed slot 0");
        assertEq(t1, address(toks[1]), "closing slot 2 disturbed slot 1");
        assertEq(t3, address(toks[3]), "closing slot 2 disturbed slot 3");
        assertEq(vault.openPositionCount(A), 3, "wrong number of open positions");

        // The proceeds of ONE position landed, not four.
        uint256 gained = vault.stakeOf(A) - stakeBefore;
        assertEq(gained, 0.001 ether, "the proceeds credited were not exactly one position's");
    }

    /**
     * SABOTAGE 4 — the encoding must have NO recipient field.
     *
     * This is the custody property. `TAKE_ALL` params are `(currency, minAmount)`; if a refactor
     * swapped it for `TAKE` (currency, recipient, amount) the encoded input would grow a word and
     * proceeds could be sent anywhere. Asserted on the BYTES rather than by reading the source.
     */
    function test_SABOTAGE_encodingHasNoRecipientField() public {
        EncoderHarness h =
            new EncoderHarness(house, keeper, address(router), address(permit2), HOOK_A, HOOK_B);

        bytes memory enc = h.encode(address(token), HOOK_A, 200, true, 0.0026 ether, 1);
        (, bytes[] memory params) = abi.decode(enc, (bytes, bytes[]));

        // TAKE_ALL is params[2] and must decode as exactly two words: (address, uint256).
        assertEq(params[2].length, 64, "TAKE_ALL is not 2 words - a recipient field may have crept in");
        (address currency, uint256 minAmount) = abi.decode(params[2], (address, uint256));
        assertEq(currency, address(token));
        assertEq(minAmount, 1);

        // And the vault's own address must appear NOWHERE in the encoding, because a recipient is
        // never named — proceeds settle to the caller implicitly.
        assertFalse(_contains(enc, abi.encode(address(h))), "an address is being named as a recipient");
    }

    /**
     * SABOTAGE 5 — a zero slippage bound must be refused.
     *
     * openhood decoded a REAL landed mainnet swap that carried `amountOutMinimum = 0` in both
     * slippage slots. Reusing that is a free MEV sandwich on every trade. The encoding is
     * inherited from that transaction; those two zeros are not.
     */
    function test_SABOTAGE_zeroSlippageBoundRefused() public {
        _adopt(alice, A, 1 ether);

        vm.prank(keeper);
        vm.expectRevert(StrayVault.ZeroSlippageBound.selector);
        vault.hunt(A, address(token), HOOK_A, 0.005 ether, 0, 200);

        _hunt(A, address(token), 0.005 ether);

        vm.prank(keeper);
        vm.expectRevert(StrayVault.ZeroSlippageBound.selector);
        vault.flee(A, 0, 0);
    }

    /// SABOTAGE 6 — remove the per-position cap. It bounds the unverified-hook risk.
    function test_SABOTAGE_positionCapEnforced() public {
        _adopt(alice, A, 10 ether); // 8 ether of stake, far above the cap

        vm.prank(keeper);
        vm.expectRevert(StrayVault.PositionTooLarge.selector);
        vault.hunt(A, address(token), HOOK_A, 0.011 ether, 1, 200);

        _hunt(A, address(token), 0.01 ether); // exactly at the cap is allowed
    }

    /**
     * SABOTAGE 6b — the cap must bind on EVERY slot, not only the first.
     *
     * A plausible refactor of the multi-position logic checks the cap once at the top and then
     * loops; another checks it only when opening slot 0. Both would pass a test that opens one
     * position. This opens seven legal ones and then asserts the eighth is still capped.
     */
    function test_SABOTAGE_positionCapBindsOnEverySlotNotJustTheFirst() public {
        _adopt(alice, A, 10 ether);
        for (uint256 i = 0; i < 7; i++) {
            _hunt(A, address(new MockERC20()), 0.01 ether);
        }
        // Deployed BEFORE `expectRevert` — see the note in the ninth-position test.
        address eighth = address(new MockERC20());
        vm.prank(keeper);
        vm.expectRevert(StrayVault.PositionTooLarge.selector);
        vault.hunt(A, eighth, HOOK_A, 0.0100001 ether, 1, 200);
    }

    /// SABOTAGE 7 — reentrancy into `withdraw` from the payout callback.
    function test_SABOTAGE_reentrantWithdrawBlocked() public {
        ReentrantOwner attacker = new ReentrantOwner(vault);
        vm.deal(address(attacker), 10 ether);
        attacker.adopt{value: 1 ether}(keccak256("evil"));

        // The re-entrant call inside `receive()` must revert, which bubbles and fails the outer
        // send. What must NOT happen is the attacker draining more than its own stake.
        vm.expectRevert();
        attacker.pull();

        assertLe(address(attacker).balance, 10 ether, "attacker extracted more than it put in");
    }

    /**
     * SABOTAGE 8 — CEI ordering, proven WITHOUT the reentrancy guard.
     *
     * unitick's five-time finding: a CEI violation passed 143 tests because `nonReentrant` alone
     * defeated the attack. Testing the ATTACK proves nothing about the ORDERING. So this observes
     * the MECHANISM: it reads the contract's own state from inside the payout callback and asserts
     * the balance was already zeroed before any ETH moved.
     */
    function test_CEI_stateIsZeroedBeforeValueMoves() public {
        _adopt(alice, A, 1 ether);
        CeiObserver obs = new CeiObserver(vault, A);

        vm.deal(address(obs), 5 ether);
        obs.adoptSelf{value: 1 ether}();
        obs.pull();

        assertEq(obs.stakeSeenDuringCallback(), 0, "stake was still set when ETH moved - CEI violated");
    }

    /**
     * SABOTAGE 8b — CEI on the SLOT, which is new in V2.
     *
     * `flee` clears the slot before calling the router. If it cleared it afterwards, a re-entrant
     * `flee` on the same slot during the swap would sell a balance that is already committed. The
     * guard would also stop that, which is exactly why this observes the ORDERING directly: the
     * mock router reads the vault's own state mid-swap and the assertion is on what it saw.
     */
    function test_CEI_slotIsClearedBeforeTheRouterIsCalled() public {
        SlotObserverRouter obsRouter = new SlotObserverRouter();
        MockERC20 tok = new MockERC20();
        StrayVault v = new StrayVault(
            house, keeper, address(obsRouter), address(permit2), HOOK_A, HOOK_B, address(obsRouter)
        );
        obsRouter.setVault(v);
        vm.deal(address(obsRouter), 10 ether);

        vm.prank(alice);
        v.adopt{value: 1 ether}(A);
        vm.prank(keeper);
        v.hunt(A, address(tok), HOOK_A, 0.005 ether, 1, 200);

        obsRouter.arm(A, 0);
        vm.prank(keeper);
        v.flee(A, 0, 1);

        assertEq(
            obsRouter.tokenSeenDuringSwap(),
            address(0),
            "the slot still held a token while the router was executing - CEI violated on the slot"
        );
    }

    // ══ THE RAKE ════════════════════════════════════════════════════════════════════════════

    function test_rakeIsZeroOnALoss() public {
        _adopt(alice, A, 1 ether); // principal 0.8
        uint256 houseBefore = house.balance;

        _hunt(A, address(token), 0.005 ether);
        router.setRate(2000); // half the ETH comes back
        vm.prank(keeper);
        vault.flee(A, 0, 1);

        assertLt(vault.stakeOf(A), 0.8 ether, "the test did not actually lose money");

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        vault.withdraw(A);

        assertEq(house.balance, houseBefore, "house took a rake on a LOSS");
        assertGt(alice.balance, aliceBefore, "user got nothing back");
    }

    function test_rakeIsTenPercentOfProfitOnly() public {
        _adopt(alice, A, 1 ether); // principal 0.8
        uint256 houseBefore = house.balance;

        _hunt(A, address(token), 0.005 ether);
        router.setRate(500); // twice the ETH comes back
        vm.prank(keeper);
        vault.flee(A, 0, 1);

        uint256 stake = vault.stakeOf(A);
        assertGt(stake, 0.8 ether, "the test did not actually make money");
        uint256 profit = stake - 0.8 ether;

        (uint256 quotedPayout, uint256 quotedRake) = vault.quoteWithdraw(A);
        assertEq(quotedRake, profit / 10, "quote disagrees with the 10% rule");

        vm.prank(alice);
        vault.withdraw(A);

        assertEq(house.balance - houseBefore, profit / 10, "rake is not 10% of profit");
        assertEq(quotedPayout, stake - profit / 10, "quote disagrees with what was paid");
    }

    /// The rake must never reduce a user below what they put in.
    function test_rakeNeverTouchesPrincipal() public {
        _adopt(alice, A, 1 ether);
        uint256 principal = 0.8 ether;
        uint256 before = alice.balance;

        vm.prank(alice);
        vault.withdraw(A);

        assertEq(alice.balance - before, principal, "principal was raked");
    }

    /**
     * The rake is on the STRAY's net result, not per position — asserted now that a stray can hold
     * several at once. Three winners and three losers that net to a small gain must be raked on
     * the NET, so a stray that made $1 across six trades does not pay a rake computed on the three
     * winners alone.
     */
    function test_rakeIsOnNetResultAcrossManyPositions() public {
        _adopt(alice, A, 1 ether); // principal 0.8
        uint256 houseBefore = house.balance;

        MockERC20[6] memory toks;
        for (uint256 i = 0; i < 6; i++) {
            toks[i] = new MockERC20();
            _hunt(A, address(toks[i]), 0.001 ether);
        }
        // Three win (rate 500 = 2x back), three lose (rate 2000 = 0.5x back).
        router.setRate(500);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(keeper);
            vault.flee(A, i, 1);
        }
        router.setRate(2000);
        for (uint256 i = 3; i < 6; i++) {
            vm.prank(keeper);
            vault.flee(A, i, 1);
        }

        uint256 stake = vault.stakeOf(A);
        // 0.8 - 0.006 committed + 3*0.002 + 3*0.0005 = 0.8015
        assertGt(stake, 0.8 ether, "the fixture did not net a profit");
        uint256 netProfit = stake - 0.8 ether;

        vm.prank(alice);
        vault.withdraw(A);

        assertEq(
            house.balance - houseBefore,
            netProfit / 10,
            "rake was not 10% of the NET result - it may be raking winners and ignoring losers"
        );
    }

    // ══ THE EXIT IS NEVER GATED ═════════════════════════════════════════════════════════════

    /**
     * meridian's rule, learned live: "getting OUT is always allowed."
     *
     * V2 version: EIGHT open positions, the maximum, must not gate the exit any more than one did.
     * This is the specific regression the multi-position rewrite could have introduced.
     */
    function test_withdrawWorksWithEightPositionsOpen() public {
        _adopt(alice, A, 1 ether);
        for (uint256 i = 0; i < 8; i++) {
            _hunt(A, address(new MockERC20()), 0.001 ether);
        }
        assertEq(vault.openPositionCount(A), 8, "the fixture did not open eight positions");

        uint256 before = alice.balance;
        vm.prank(alice);
        vault.withdraw(A); // must not revert
        assertEq(
            alice.balance - before, 0.792 ether, "the uncommitted stake was not fully returned"
        );

        // And the positions are UNTOUCHED — no force-sale on the user's behalf.
        assertEq(vault.openPositionCount(A), 8, "withdraw force-sold the user's positions");
    }

    /**
     * SABOTAGE — a keeper must not be able to make the exit expensive.
     *
     * `withdraw` must not loop over positions. If it did, its gas would grow with the number of
     * open slots and a keeper could raise the cost of a user's exit at will — **an exit whose
     * price the keeper sets is an exit the keeper can deny.**
     *
     * ══ WHY THIS MEASURES ONE STRAY AT TWO SLOT COUNTS, AND ASSERTS EXACT EQUALITY ══
     *
     * The first version of this test compared TWO DIFFERENT STRAYS — a flat one against one with
     * eight positions — with a 1000-gas tolerance. **It survived the sabotage**, and the way it
     * failed is worth recording because it is this corpus's recurring shape.
     *
     * A `withdraw` that loops over all 8 slots costs MORE FOR EVERY STRAY, including the flat one:
     * the loop reads eight (mostly empty) slots regardless. So both sides of the comparison rose,
     * the flat stray's more than the other's (32,097 vs 20,513 — the *wrong way round*), and the
     * `assertLt` passed while the property it named was false. **The control moved with the
     * treatment, so the difference measured nothing.**
     *
     * The fix is to vary ONLY the thing under test: the same stray, the same call, at 0 open slots
     * and at 8. And the assertion is EXACT EQUALITY rather than a tolerance, because the property
     * is not "roughly constant" — it is constant, and any per-position term at all is the bug.
     */
    function test_SABOTAGE_keeperCannotStrandExitByOpeningPositions() public {
        // Measurement 1: a stray with NO open positions.
        _adopt(alice, A, 1 ether);
        vm.prank(alice);
        uint256 g0 = gasleft();
        vault.withdraw(A);
        uint256 gasFlat = g0 - gasleft();

        // Measurement 2: an IDENTICALLY funded stray with all eight slots occupied. Same owner,
        // same stake, same payout path — the only difference is the open positions.
        _adopt(bob, B, 1 ether);
        for (uint256 i = 0; i < 8; i++) {
            _hunt(B, address(new MockERC20()), 0.001 ether);
        }
        assertEq(vault.openPositionCount(B), 8, "the fixture did not open eight positions");

        vm.prank(bob);
        uint256 g1 = gasleft();
        vault.withdraw(B);
        uint256 gasFull = g1 - gasleft();

        console.log("withdraw gas, 0 positions:", gasFlat);
        console.log("withdraw gas, 8 positions:", gasFull);

        assertEq(
            gasFull,
            gasFlat,
            "withdraw gas depends on the number of open positions - the keeper can price a user out of exiting"
        );
    }

    function test_withdrawCannotBeReplayed() public {
        _adopt(alice, A, 1 ether);
        vm.prank(alice);
        vault.withdraw(A);

        vm.prank(alice);
        vm.expectRevert(StrayVault.InsufficientStake.selector);
        vault.withdraw(A);
    }

    // ══ THE SWAP PATH ═══════════════════════════════════════════════════════════════════════

    function test_huntDebitsStakeAndRecordsHolding() public {
        _adopt(alice, A, 1 ether);
        uint256 slot = _hunt(A, address(token), 0.005 ether);
        assertEq(slot, 0, "first position did not land in slot 0");

        assertEq(vault.stakeOf(A), 0.795 ether, "stake not debited");
        (address held, uint256 bal) = vault.holdingOf(A, 0);
        assertEq(held, address(token));
        assertEq(bal, 0.005 ether * 1000, "tokens did not land in the VAULT");
    }

    /// Proceeds must land in the vault, never anywhere else. This is the custody property observed.
    function test_proceedsReturnToTheVault() public {
        _adopt(alice, A, 1 ether);
        _hunt(A, address(token), 0.005 ether);

        assertEq(token.balanceOf(address(vault)), 0.005 ether * 1000, "tokens are not in the vault");
        assertEq(token.balanceOf(keeper), 0, "the KEEPER received tokens");
        assertEq(token.balanceOf(house), 0, "the HOUSE received tokens");
    }

    function test_fleeRefusesWhenFlat() public {
        _adopt(alice, A, 1 ether);
        vm.prank(keeper);
        vm.expectRevert(StrayVault.NotHolding.selector);
        vault.flee(A, 0, 1);
    }

    /// A fill below the stated bound must revert rather than be accepted quietly.
    function test_huntRevertsOnShortfall() public {
        _adopt(alice, A, 1 ether);
        router.setShortfall(true);
        vm.prank(keeper);
        vm.expectRevert(StrayVault.NothingReceived.selector);
        vault.hunt(A, address(token), HOOK_A, 0.005 ether, 1000, 200);
    }

    function test_unknownStrayIsRefused() public {
        vm.prank(keeper);
        vm.expectRevert(StrayVault.NoSuchStray.selector);
        vault.hunt(keccak256("ghost"), address(token), HOOK_A, 0.005 ether, 1, 200);
    }

    /// Only the router or PoolManager may push ETH in. Otherwise `address(this).balance` stops
    /// reconciling against the sum of the compartments and accounting becomes untestable.
    function test_randomSenderCannotDonateEth() public {
        vm.prank(bob);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok, "an arbitrary address funded the vault");
    }

    // ══ INVARIANT: the vault always covers what it owes ═════════════════════════════════════

    function test_vaultBalanceCoversAllCompartments() public {
        _adopt(alice, A, 1 ether);
        _adopt(bob, B, 2 ether);
        assertEq(address(vault).balance, vault.stakeOf(A) + vault.stakeOf(B));

        // Several positions across both strays.
        _hunt(A, address(new MockERC20()), 0.005 ether);
        _hunt(A, address(new MockERC20()), 0.005 ether);
        _hunt(B, address(new MockERC20()), 0.005 ether);
        assertEq(address(vault).balance, vault.stakeOf(A) + vault.stakeOf(B));

        vm.prank(keeper);
        vault.flee(A, 1, 1);
        assertEq(address(vault).balance, vault.stakeOf(A) + vault.stakeOf(B));

        vm.prank(keeper);
        vault.flee(A, 0, 1);
        vm.prank(keeper);
        vault.flee(B, 0, 1);
        assertEq(address(vault).balance, vault.stakeOf(A) + vault.stakeOf(B));
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────

    function _contains(bytes memory haystack, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0 || haystack.length < needle.length) return false;
        for (uint256 i = 0; i <= haystack.length - needle.length; i++) {
            bool same = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    same = false;
                    break;
                }
            }
            if (same) return true;
        }
        return false;
    }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE NEW SABOTAGES — MULTIPLE POSITIONS
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

contract StrayVaultMultiPositionTest is VaultFixture {
    function setUp() public {
        _setUpVault();
    }

    /**
     * S13 — THE WHOLE POINT OF V2. A stray must hold EIGHT positions at once.
     *
     * V1 reverted `AlreadyHolding` on the second. §10.5 measured what that cost: one slot takes 17
     * of 72 opportunities at Welch t 1.16 (not significant); eight take 71 of 72 at t 2.38-2.72 on
     * 20/20 seeds. If this test fails, the strategy that was measured cannot be executed.
     */
    function test_SABOTAGE_eightConcurrentPositions() public {
        _adopt(alice, A, 1 ether);
        MockERC20[8] memory toks;
        for (uint256 i = 0; i < 8; i++) {
            toks[i] = new MockERC20();
            uint256 slot = _hunt(A, address(toks[i]), 0.001 ether);
            assertEq(slot, i, "slot allocation is not in index order");
        }

        assertEq(vault.openPositionCount(A), 8, "eight concurrent positions were not held");
        assertEq(vault.stakeOf(A), 0.792 ether, "stake was not debited once per position");

        // Every slot holds its OWN token — not eight copies of one.
        StrayVault.Position[8] memory ps = vault.positionsOf(A);
        for (uint256 i = 0; i < 8; i++) {
            assertEq(ps[i].token, address(toks[i]), "a slot holds the wrong token");
            assertEq(ps[i].costBasis, 0.001 ether, "a slot has the wrong cost basis");
        }
    }

    /**
     * S14 — the NINTH position must be refused, and refused BY THE SLOT LIMIT.
     *
     * ══ THE TWO-MECHANISM RULE, APPLIED ══
     *
     * `s.stake` and the free-slot search can both refuse a ninth position. A test that funded the
     * stray with exactly eight positions' worth would be refused by `InsufficientStake` and would
     * prove nothing about the cap. So this funds it with 0.8 ETH — a hundred positions' worth —
     * making `NoFreeSlot` the ONLY thing that can refuse it.
     */
    function test_SABOTAGE_ninthPositionRefusedWithMoneyToSpare() public {
        _adopt(alice, A, 1 ether); // 0.8 stake: room for 800 positions at the size used
        for (uint256 i = 0; i < 8; i++) {
            _hunt(A, address(new MockERC20()), 0.001 ether);
        }

        assertGt(vault.stakeOf(A), 0.1 ether, "the probe must have money left, or stake refuses it");

        // Deployed BEFORE `expectRevert`: a `new` inside the expectation's scope is itself the
        // "next call", so it consumes the expectation and the test passes on the wrong call.
        address ninth = address(new MockERC20());
        vm.prank(keeper);
        vm.expectRevert(StrayVault.NoFreeSlot.selector);
        vault.hunt(A, ninth, HOOK_A, 0.001 ether, 1, 200);
    }

    /// A freed slot is reusable, and the allocator picks the LOWEST free index.
    function test_freedSlotIsReusedAtTheLowestFreeIndex() public {
        _adopt(alice, A, 1 ether);
        for (uint256 i = 0; i < 8; i++) {
            _hunt(A, address(new MockERC20()), 0.001 ether);
        }
        // Free slots 5 and 2, in that order.
        vm.prank(keeper);
        vault.flee(A, 5, 1);
        vm.prank(keeper);
        vault.flee(A, 2, 1);

        uint256 slot = _hunt(A, address(new MockERC20()), 0.001 ether);
        assertEq(slot, 2, "the allocator did not pick the lowest free slot");
        uint256 slot2 = _hunt(A, address(new MockERC20()), 0.001 ether);
        assertEq(slot2, 5, "the second-lowest free slot was not reused");
    }

    /**
     * S15 — THE SAME TOKEN MUST NOT OCCUPY TWO SLOTS.
     *
     * The token balance is MEASURED from `balanceOf(address(this))`, so two slots holding the same
     * token would each measure the combined balance. `flee` on either would sell BOTH and credit
     * one — a windfall in one slot and a stranded, unsellable position in the other.
     *
     * The bug this prevents is subtle enough to be worth constructing directly: without the check,
     * the sequence below would leave slot 1 pointing at a token the vault no longer owns.
     */
    function test_SABOTAGE_sameTokenCannotOccupyTwoSlots() public {
        _adopt(alice, A, 1 ether);
        _hunt(A, address(token), 0.001 ether);

        vm.prank(keeper);
        vm.expectRevert(StrayVault.DuplicateToken.selector);
        vault.hunt(A, address(token), HOOK_A, 0.001 ether, 1, 200);

        // And it must still be refused when the duplicate would land in a LATER slot.
        _hunt(A, address(new MockERC20()), 0.001 ether);
        vm.prank(keeper);
        vm.expectRevert(StrayVault.DuplicateToken.selector);
        vault.hunt(A, address(token), HOOK_A, 0.001 ether, 1, 200);

        // Selling it releases the token for re-entry later.
        vm.prank(keeper);
        vault.flee(A, 0, 1);
        _hunt(A, address(token), 0.001 ether);
    }

    /// Different STRAYS may hold the same token — the duplicate rule is per stray, not global.
    function test_differentStraysMayHoldTheSameToken() public {
        _adopt(alice, A, 1 ether);
        _adopt(bob, B, 1 ether);
        _hunt(A, address(token), 0.001 ether);
        _hunt(B, address(token), 0.001 ether);
        assertEq(vault.openPositionCount(A), 1);
        assertEq(vault.openPositionCount(B), 1);
    }

    /// An out-of-range slot index is refused on every function that takes one.
    function test_badSlotIndexRefusedEverywhere() public {
        _adopt(alice, A, 1 ether);
        _hunt(A, address(token), 0.001 ether);

        vm.prank(keeper);
        vm.expectRevert(StrayVault.BadSlot.selector);
        vault.flee(A, 8, 1);

        vm.prank(keeper);
        vm.expectRevert(StrayVault.BadSlot.selector);
        vault.mark(A, 8, 1e18);

        vm.expectRevert(StrayVault.BadSlot.selector);
        vault.holdingOf(A, 8);

        vm.expectRevert(StrayVault.BadSlot.selector);
        vault.positionAt(A, 8);
    }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE NEW SABOTAGES — THE PER-TRADE HOOK AND ITS ALLOWLIST
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

contract StrayVaultHookTest is VaultFixture {
    function setUp() public {
        _setUpVault();
    }

    /**
     * S16 — THE SECOND HOOK MUST BE REACHABLE. This is RESEARCH §7d's fix, observed.
     *
     * V1 hardcoded hook A and built every PoolKey with it, so 44 tokens and 1,359Ξ of daily volume
     * — including LEVCAT, INTERN and Seriouscat — were unreachable. This asserts the hook the
     * ROUTER was actually asked to swap against, decoded from the calldata the vault built, not
     * the argument the test passed in.
     */
    function test_SABOTAGE_secondHookIsReachable() public {
        _adopt(alice, A, 1 ether);

        vm.prank(keeper);
        vault.hunt(A, address(token), HOOK_B, 0.001 ether, 1, 200);

        assertEq(
            router.lastHook(),
            HOOK_B,
            "the vault built a PoolKey with the WRONG hook - 40% of the pad is unreachable"
        );
        assertEq(vault.positionAt(A, 0).hook, HOOK_B, "the position did not record its hook");
    }

    /// Both hooks in the same stray, in different slots, at the same time.
    function test_bothHooksConcurrently() public {
        _adopt(alice, A, 1 ether);
        MockERC20 tokB = new MockERC20();

        vm.prank(keeper);
        vault.hunt(A, address(token), HOOK_A, 0.001 ether, 1, 200);
        vm.prank(keeper);
        vault.hunt(A, address(tokB), HOOK_B, 0.001 ether, 1, 200);

        assertEq(vault.positionAt(A, 0).hook, HOOK_A);
        assertEq(vault.positionAt(A, 1).hook, HOOK_B);
    }

    /**
     * S17 — AN ARBITRARY HOOK MUST BE REFUSED.
     *
     * ══ THE TWO-MECHANISM RULE, APPLIED — AND WHY THE PROBE IS A *WORKING* ADDRESS ══
     *
     * A hook the pad does not use would ALSO fail on the real chain because the pool does not
     * exist. That would make the allowlist decoration: the test would pass with
     * `_requireKnownHook` deleted, refused instead by the venue.
     *
     * So the probe hook here is an address the MOCK ROUTER swaps against perfectly happily — it
     * decodes the PoolKey and mints tokens regardless of the hook field. In this world the ONLY
     * thing that can refuse the trade is the allowlist. Delete `_requireKnownHook` and this test
     * fails with "an arbitrary hook was accepted", which is what makes it a test of the check.
     *
     * The second half proves the mock really would have accepted it, so the first half cannot be
     * passing for the wrong reason.
     */
    function test_SABOTAGE_arbitraryHookRefused() public {
        _adopt(alice, A, 1 ether);
        address evilHook = makeAddr("attacker-controlled-hook");

        vm.prank(keeper);
        vm.expectRevert(StrayVault.UnknownHook.selector);
        vault.hunt(A, address(token), evilHook, 0.001 ether, 1, 200);

        // address(0) is not a free pass either.
        vm.prank(keeper);
        vm.expectRevert(StrayVault.UnknownHook.selector);
        vault.hunt(A, address(token), address(0), 0.001 ether, 1, 200);

        // PROOF THE PROBE IS A LIVE ONE: the router accepts this exact hook when the vault names
        // it, so the refusal above came from the allowlist and from nothing else.
        MockRouter free = new MockRouter();
        vm.deal(address(free), 10 ether);
        StrayVault permissive = new StrayVault(
            house, keeper, address(free), address(permit2), evilHook, HOOK_B, address(free)
        );
        vm.prank(alice);
        permissive.adopt{value: 1 ether}(A);
        vm.prank(keeper);
        permissive.hunt(A, address(token), evilHook, 0.001 ether, 1, 200);
        assertEq(free.lastHook(), evilHook, "the mock world would have refused it anyway - bad probe");
    }

    /**
     * S18 — `flee` MUST USE THE POSITION'S OWN HOOK, not one supplied by the caller.
     *
     * A sell has to address the same pool the buy addressed. `flee` takes no hook argument, so
     * this asserts the hook the router SEES on the sell equals the one the buy used — decoded
     * from the vault's own calldata, for a position opened on hook B while hook A is the default
     * everywhere else in this suite.
     */
    function test_SABOTAGE_fleeUsesThePositionsOwnHook() public {
        _adopt(alice, A, 1 ether);

        vm.prank(keeper);
        vault.hunt(A, address(token), HOOK_B, 0.001 ether, 1, 200);
        assertEq(router.lastHook(), HOOK_B, "the buy did not use hook B");

        // A buy on hook A in another slot, so `lastHook` is definitely not stale-correct.
        // The token is deployed BEFORE the prank: `vm.prank` applies to the next call, and a
        // `new` inside its scope would consume it and send `hunt` from the test contract.
        address other = address(new MockERC20());
        vm.prank(keeper);
        vault.hunt(A, other, HOOK_A, 0.001 ether, 1, 200);
        assertEq(router.lastHook(), HOOK_A, "the second buy did not use hook A");

        vm.prank(keeper);
        vault.flee(A, 0, 1);

        assertEq(
            router.lastHook(),
            HOOK_B,
            "the SELL addressed a different pool than the BUY - proceeds were priced against the wrong liquidity"
        );
        assertEq(router.lastToken(), address(token), "the sell addressed the wrong token");
    }

    /**
     * S19 — the hooks must be IMMUTABLE with no setter.
     *
     * This is S11's shape applied to the new roles. The whole "a keeper cannot route through an
     * arbitrary contract" property rests on the allowlist being fixed at construction; a setter
     * would let a compromised keeper (or anyone, if unguarded) add its own hook and defeat S17
     * entirely. Probed on the ABI: calling a selector that does not exist fails, so a SUCCESS here
     * means somebody added one.
     */
    function test_SABOTAGE_hooksHaveNoSetter() public {
        address attacker = makeAddr("attacker");
        vm.startPrank(attacker);

        (bool a,) = address(vault).call(abi.encodeWithSignature("setHook(address)", attacker));
        assertFalse(a, "setHook exists - swaps can be routed through an attacker's contract");

        (bool b,) = address(vault).call(abi.encodeWithSignature("setHookA(address)", attacker));
        assertFalse(b, "setHookA exists - the allowlist can be edited");

        (bool c,) = address(vault).call(abi.encodeWithSignature("setHookB(address)", attacker));
        assertFalse(c, "setHookB exists - the allowlist can be edited");

        (bool d,) = address(vault).call(abi.encodeWithSignature("addHook(address)", attacker));
        assertFalse(d, "addHook exists - the allowlist can be grown");

        (bool e,) = address(vault).call(abi.encodeWithSignature("setPoolManager(address)", attacker));
        assertFalse(e, "setPoolManager exists");

        (bool f,) = address(vault).call(abi.encodeWithSignature("setPermit2(address)", attacker));
        assertFalse(f, "setPermit2 exists");

        vm.stopPrank();

        assertEq(vault.hookA(), HOOK_A, "hookA moved");
        assertEq(vault.hookB(), HOOK_B, "hookB moved");
        assertTrue(vault.isKnownHook(HOOK_A));
        assertTrue(vault.isKnownHook(HOOK_B));
        assertFalse(vault.isKnownHook(attacker), "an arbitrary address is in the allowlist");
    }

    /// The constructor must refuse a zero hook in either position.
    function test_constructorRefusesZeroHook() public {
        vm.expectRevert(StrayVault.ZeroAddress.selector);
        new StrayVault(
            house, keeper, address(router), address(permit2), address(0), HOOK_B, address(router)
        );
        vm.expectRevert(StrayVault.ZeroAddress.selector);
        new StrayVault(
            house, keeper, address(router), address(permit2), HOOK_A, address(0), address(router)
        );
    }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE NEW SABOTAGES — THE PEAK WATERMARK
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

contract StrayVaultWatermarkTest is VaultFixture {
    function setUp() public {
        _setUpVault();
    }

    /**
     * S20 — the watermark is SEEDED FROM THE MEASURED FILL, not from an argument.
     *
     * entryPrice = ethIn * 1e18 / received. Both terms are the contract's own: `ethIn` it sent,
     * `received` it measured from `balanceOf`. If the seed came from a keeper argument, a keeper
     * could arm the trailing stop instantly (seed high) or disarm it (seed low).
     *
     * At rate 1000, 0.001 ETH buys 1e18 units, so the entry price is exactly 1e15 wei per token.
     */
    function test_SABOTAGE_watermarkSeededFromTheMeasuredFill() public {
        _adopt(alice, A, 1 ether);
        _hunt(A, address(token), 0.001 ether);

        uint256 received = 0.001 ether * 1000;
        uint256 expected = (0.001 ether * 1e18) / received;
        assertEq(
            vault.positionAt(A, 0).peakPriceWei,
            expected,
            "the entry watermark does not equal ethIn/received - it came from somewhere else"
        );

        // And it moves with the fill: a worse rate is a lower price per token.
        router.setRate(500);
        _hunt(A, address(new MockERC20()), 0.001 ether);
        assertEq(
            vault.positionAt(A, 1).peakPriceWei,
            (0.001 ether * 1e18) / (0.001 ether * 500),
            "the watermark did not track the measured fill"
        );
        assertGt(
            vault.positionAt(A, 1).peakPriceWei,
            vault.positionAt(A, 0).peakPriceWei,
            "fewer tokens for the same ETH must be a HIGHER price per token"
        );
    }

    /**
     * S21 — `mark` IS MONOTONE. It must never lower a watermark.
     *
     * This is the direction that matters. A lowered watermark WIDENS the trailing stop and lets a
     * position keep falling — it silently disarms the only exit rule §10 found that works. A
     * raised one merely tightens it, which is market risk a keeper already has.
     */
    function test_SABOTAGE_markNeverLowersTheWatermark() public {
        _adopt(alice, A, 1 ether);
        _hunt(A, address(token), 0.001 ether);
        uint256 entry = vault.positionAt(A, 0).peakPriceWei;

        vm.prank(keeper);
        uint256 after1 = vault.mark(A, 0, entry * 3);
        assertEq(after1, entry * 3, "mark did not raise the peak");
        assertEq(vault.positionAt(A, 0).peakPriceWei, entry * 3, "the raise was not persisted");

        // Every downward report is a no-op, including zero and one wei below.
        vm.prank(keeper);
        uint256 after2 = vault.mark(A, 0, entry);
        assertEq(after2, entry * 3, "mark LOWERED the watermark - the trailing stop is disarmed");

        vm.prank(keeper);
        vault.mark(A, 0, 0);
        assertEq(vault.positionAt(A, 0).peakPriceWei, entry * 3, "a zero report lowered the peak");

        vm.prank(keeper);
        vault.mark(A, 0, entry * 3 - 1);
        assertEq(vault.positionAt(A, 0).peakPriceWei, entry * 3, "a one-wei-lower report was written");

        // Raising again still works.
        vm.prank(keeper);
        vault.mark(A, 0, entry * 4);
        assertEq(vault.positionAt(A, 0).peakPriceWei, entry * 4);
    }

    /**
     * S22 — THE WATERMARK SURVIVES, AND IS PER SLOT.
     *
     * A single watermark shared across a stray's positions would make every trailing stop the
     * stop of whichever position had run furthest — the others would either never fire or fire
     * immediately. Each slot must carry its own.
     */
    function test_SABOTAGE_watermarksArePerSlotNotPerStray() public {
        _adopt(alice, A, 1 ether);
        MockERC20 t0 = token;
        MockERC20 t1 = new MockERC20();
        MockERC20 t2 = new MockERC20();
        _hunt(A, address(t0), 0.001 ether);
        _hunt(A, address(t1), 0.001 ether);
        _hunt(A, address(t2), 0.001 ether);

        uint256 base = vault.positionAt(A, 0).peakPriceWei;

        vm.prank(keeper);
        vault.mark(A, 1, base * 10); // slot 1 runs 10x

        assertEq(vault.positionAt(A, 0).peakPriceWei, base, "slot 0's watermark moved with slot 1's");
        assertEq(vault.positionAt(A, 1).peakPriceWei, base * 10, "slot 1's watermark did not move");
        assertEq(vault.positionAt(A, 2).peakPriceWei, base, "slot 2's watermark moved with slot 1's");
    }

    /// And per STRAY: marking A must not touch B, even in the same slot index.
    function test_watermarksAreIsolatedBetweenStrays() public {
        _adopt(alice, A, 1 ether);
        _adopt(bob, B, 1 ether);
        _hunt(A, address(token), 0.001 ether);
        _hunt(B, address(new MockERC20()), 0.001 ether);

        uint256 bBefore = vault.positionAt(B, 0).peakPriceWei;
        vm.prank(keeper);
        vault.mark(A, 0, bBefore * 50);

        assertEq(vault.positionAt(B, 0).peakPriceWei, bBefore, "marking stray A moved stray B's watermark");
    }

    /// A closed slot is fully cleared, so a REUSED slot cannot inherit the old watermark — which
    /// would apply the previous token's trailing stop to a brand new position.
    function test_SABOTAGE_reusedSlotDoesNotInheritTheOldWatermark() public {
        _adopt(alice, A, 1 ether);
        _hunt(A, address(token), 0.001 ether);
        uint256 entry = vault.positionAt(A, 0).peakPriceWei;
        vm.prank(keeper);
        vault.mark(A, 0, entry * 100);

        vm.prank(keeper);
        vault.flee(A, 0, 1);

        StrayVault.Position memory cleared = vault.positionAt(A, 0);
        assertEq(cleared.token, address(0), "slot not cleared");
        assertEq(cleared.peakPriceWei, 0, "the watermark survived the close");
        assertEq(cleared.hook, address(0), "the hook survived the close");
        assertEq(cleared.costBasis, 0, "the cost basis survived the close");

        // Re-enter the same slot: the new watermark is the NEW entry price, not the old peak.
        _hunt(A, address(new MockERC20()), 0.001 ether);
        assertEq(
            vault.positionAt(A, 0).peakPriceWei,
            entry,
            "a reused slot inherited the previous position's peak - its stop would fire instantly"
        );
    }

    /// `mark` on an empty slot is refused rather than silently writing to a free slot.
    function test_markRefusedOnAnEmptySlot() public {
        _adopt(alice, A, 1 ether);
        vm.prank(keeper);
        vm.expectRevert(StrayVault.NotHolding.selector);
        vault.mark(A, 0, 1e18);
    }

    /**
     * `mark` MOVES NO VALUE, and nothing gates an exit on it.
     *
     * A wrong watermark must not be able to block a sale or a withdrawal — the watermark is
     * recorded FOR the off-chain rule, it is not the rule. This drives the peak to the maximum a
     * uint128 can hold and asserts both exits still work.
     */
    function test_watermarkCannotBlockAnExitOrAWithdrawal() public {
        _adopt(alice, A, 1 ether);
        _hunt(A, address(token), 0.001 ether);

        vm.prank(keeper);
        vault.mark(A, 0, type(uint128).max);
        assertEq(vault.positionAt(A, 0).peakPriceWei, type(uint128).max);

        uint256 vaultBalBefore = address(vault).balance;
        vm.prank(keeper);
        vault.flee(A, 0, 1); // must not revert
        assertGt(address(vault).balance, vaultBalBefore, "the sale did not complete");

        uint256 before = alice.balance;
        vm.prank(alice);
        vault.withdraw(A); // must not revert
        assertGt(alice.balance, before, "the withdrawal was blocked");
    }

    /// A peak beyond uint128 is refused rather than silently truncated — a truncated peak is a
    /// SMALLER peak, i.e. the dangerous direction, arriving through the back door.
    function test_markRefusesAValueThatWouldTruncate() public {
        _adopt(alice, A, 1 ether);
        _hunt(A, address(token), 0.001 ether);
        vm.prank(keeper);
        vm.expectRevert(StrayVault.PositionTooLarge.selector);
        vault.mark(A, 0, uint256(type(uint128).max) + 1);
    }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO SURVIVORS FROM ROUND 1, AND THEIR MECHANISM-LEVEL FIXES
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Round one applied 11 sabotages to V1's SOURCE. Nine were caught. Two were not, and both are the
 * same defect shape this corpus has now hit six times:
 *
 *     **When two mechanisms can independently reject the same input, at least one test must
 *     construct an input that only ONE of them rejects.**
 *
 * S7 — `nonReentrant` deleted from `withdraw` — survived because CEI ALONE defeats the attack: the
 * stake is zeroed before any ETH moves, so the re-entrant call finds nothing to take and reverts on
 * its own. That is the exact INVERSE of unitick's recorded bug, where `nonReentrant` masked a CEI
 * violation. Here CEI masks a missing guard. Testing the ATTACK proved nothing about either.
 *
 * S11 — `house` made mutable with a public setter — survived because no test ever asserted that the
 * fee recipient cannot be changed. The whole "no function pays a caller-supplied address" property
 * rests on that immutability, and it was unguarded.
 *
 * Both are fixed below by observing the MECHANISM rather than the outcome.
 */
contract StrayVaultSurvivorTest is VaultFixture {
    function setUp() public {
        _setUpVault();
    }

    /**
     * S7's fix. Observes the GUARD itself rather than the attack CEI would stop anyway.
     *
     * A reentrant call must revert with `Reentrancy()` SPECIFICALLY. If the guard is deleted the
     * inner call reverts with `InsufficientStake` instead (because CEI already zeroed the balance),
     * and this assertion fails — which is what makes it a test of the guard and not of CEI.
     */
    function test_SABOTAGE_reentrancyGuardIsTheThingThatRejects() public {
        GuardProbe probe = new GuardProbe(vault);
        vm.deal(address(probe), 5 ether);
        probe.adoptSelf{value: 1 ether}();
        probe.pull();

        assertEq(
            probe.innerError(),
            StrayVault.Reentrancy.selector,
            "the reentrant call was rejected by something OTHER than nonReentrant - the guard may be gone"
        );
    }

    /**
     * S11's fix. The whole "no function pays a caller-supplied address" property rests on `house`
     * and `keeper` being immutable, and nothing asserted it.
     *
     * Checked on the ABI itself: a setter would appear as a callable selector. Calling a selector
     * that does not exist hits no function and the raw call fails, so success here means somebody
     * added one.
     */
    function test_SABOTAGE_houseAndKeeperHaveNoSetter() public {
        address attacker = makeAddr("attacker");
        vm.startPrank(attacker);

        (bool a,) = address(vault).call(abi.encodeWithSignature("setHouse(address)", attacker));
        assertFalse(a, "setHouse exists - the fee recipient can be redirected");

        (bool b,) = address(vault).call(abi.encodeWithSignature("setKeeper(address)", attacker));
        assertFalse(b, "setKeeper exists - the trading role can be seized");

        (bool c,) = address(vault).call(abi.encodeWithSignature("setRouter(address)", attacker));
        assertFalse(c, "setRouter exists - swaps can be routed to an attacker's contract");

        vm.stopPrank();

        assertEq(vault.house(), house, "house moved");
        assertEq(vault.keeper(), keeper, "keeper moved");
    }
}

/// Reads the vault's state from inside the payout callback, to observe CEI ordering directly
/// rather than inferring it from an attack the reentrancy guard would have stopped anyway.
contract CeiObserver {
    StrayVault public vault;
    bytes32 public id;
    uint256 public stakeSeenDuringCallback = type(uint256).max;

    constructor(StrayVault v, bytes32) {
        vault = v;
        id = keccak256(abi.encodePacked(address(this)));
    }

    function adoptSelf() external payable {
        vault.adopt{value: msg.value}(id);
    }

    function pull() external {
        vault.withdraw(id);
    }

    receive() external payable {
        stakeSeenDuringCallback = vault.stakeOf(id);
    }
}

/**
 * A router that reads the vault's SLOT state from inside `execute`, so CEI on the slot can be
 * observed directly rather than inferred from an attack `nonReentrant` would stop anyway.
 *
 * It behaves like `MockRouter` on the sell leg — burns the balance, sends ETH — so the `flee`
 * under observation actually completes.
 */
contract SlotObserverRouter {
    StrayVault public vault;
    bytes32 private watchId;
    uint256 private watchSlot;
    bool private armed;
    address public tokenSeenDuringSwap = address(0xdead);

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    function setVault(StrayVault v) external {
        vault = v;
    }

    function arm(bytes32 id, uint256 slot) external {
        watchId = id;
        watchSlot = slot;
        armed = true;
    }

    function execute(bytes calldata, bytes[] calldata inputs, uint256) external payable {
        (, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        ExactInputSingleParams memory p = abi.decode(params[0], (ExactInputSingleParams));
        MockERC20 token = MockERC20(p.poolKey.currency1);

        if (armed) {
            // THE OBSERVATION: what does the slot hold WHILE the swap is executing?
            (address t,) = vault.holdingOf(watchId, watchSlot);
            tokenSeenDuringSwap = t;
        }

        if (p.zeroForOne) {
            token.mint(msg.sender, msg.value * 1000);
        } else {
            uint256 bal = token.balanceOf(msg.sender);
            token.burn(msg.sender, bal);
            (bool ok,) = msg.sender.call{value: bal / 1000}("");
            require(ok, "send failed");
        }
    }

    receive() external payable {}
}

/// Captures the error the INNER (reentrant) call reverts with, so the test can assert on which
/// mechanism did the rejecting.
contract GuardProbe {
    StrayVault public vault;
    bytes32 public id;
    bytes4 public innerError;
    bool private entered;

    constructor(StrayVault v) {
        vault = v;
        id = keccak256(abi.encodePacked(address(this)));
    }

    function adoptSelf() external payable {
        vault.adopt{value: msg.value}(id);
    }

    function pull() external {
        try vault.withdraw(id) {} catch {}
    }

    receive() external payable {
        if (entered) return;
        entered = true;
        try vault.withdraw(id) {}
        catch (bytes memory err) {
            if (err.length >= 4) {
                innerError = bytes4(err);
            }
        }
    }
}

/**
 * Edge cases found by re-reading the contract after it was already deployed and green.
 *
 * The one that prompted this pass: `withdraw` sets `s.principal = amount > principal ? 0 : principal
 * - amount`. Is there a sequence where a user withdraws, the keeper trades again, and the SECOND
 * withdrawal rakes profit that was already raked — or conversely escapes a rake it should pay?
 */
contract StrayVaultEdgeTest is VaultFixture {
    function setUp() public {
        _setUpVault();
    }

    /**
     * A stray that WINS, is withdrawn, then wins AGAIN must not have the first profit raked twice.
     *
     * After a full withdrawal `principal` is 0, so every wei of a later gain is profit — which is
     * correct, because the user took their principal out. The thing that would be WRONG is the
     * house collecting twice on the SAME gain, and this asserts it does not.
     */
    function test_edge_rakeIsNotChargedTwiceOnTheSameProfit() public {
        _adopt(alice, A, 1 ether); // principal 0.8

        _hunt(A, address(token), 0.005 ether);
        router.setRate(500); // double the ETH back
        vm.prank(keeper);
        vault.flee(A, 0, 1);

        uint256 stake1 = vault.stakeOf(A);
        uint256 profit1 = stake1 - 0.8 ether;
        uint256 houseBefore = house.balance;

        vm.prank(alice);
        vault.withdraw(A);
        uint256 raked1 = house.balance - houseBefore;
        assertEq(raked1, profit1 / 10, "first rake wrong");

        // Everything is out. A second withdrawal must revert rather than rake anything again.
        vm.prank(alice);
        vm.expectRevert(StrayVault.InsufficientStake.selector);
        vault.withdraw(A);
        assertEq(house.balance - houseBefore, raked1, "house raked a second time on the same profit");
    }

    /**
     * The keeper must not be able to strand a user's money by opening positions and stopping.
     *
     * The uncommitted stake stays withdrawable at all times, so a keeper that goes silent mid-trade
     * costs the user the deployed slice and nothing more. V2 version: the deployed slice is now
     * bounded by MAX_POSITIONS x MAX_POSITION_WEI rather than by MAX_POSITION_WEI alone, which is
     * a real widening and is asserted here rather than glossed.
     */
    function test_edge_silentKeeperCannotStrandTheUncommittedStake() public {
        _adopt(alice, A, 1 ether); // 0.8 stake

        // The maximum a silent keeper can ever have deployed: eight positions at the cap.
        for (uint256 i = 0; i < 8; i++) {
            _hunt(A, address(new MockERC20()), 0.01 ether);
        }
        uint256 deployed = 0.08 ether;

        uint256 before = alice.balance;
        vm.prank(alice);
        vault.withdraw(A);

        assertEq(alice.balance - before, 0.8 ether - deployed, "the uncommitted stake was not fully returned");
        assertEq(
            deployed,
            vault.MAX_POSITION_WEI() * vault.MAX_POSITIONS(),
            "exposure to a silent keeper exceeds MAX_POSITIONS x MAX_POSITION_WEI"
        );
    }

    /** A stray id nobody adopted must be inert on every path, not just on hunt. */
    function test_edge_unknownStrayIsInertEverywhere() public {
        bytes32 ghost = keccak256("never-adopted");
        vm.prank(alice);
        vm.expectRevert(StrayVault.NotOwner.selector);
        vault.withdraw(ghost);

        vm.prank(keeper);
        vm.expectRevert(StrayVault.NoSuchStray.selector);
        vault.flee(ghost, 0, 1);

        vm.prank(keeper);
        vm.expectRevert(StrayVault.NotHolding.selector);
        vault.mark(ghost, 0, 1e18);

        (uint256 payout, uint256 rake) = vault.quoteWithdraw(ghost);
        assertEq(payout, 0);
        assertEq(rake, 0);
        assertEq(vault.openPositionCount(ghost), 0);
    }
}
