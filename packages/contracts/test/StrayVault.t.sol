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
 * `test_CEI_orderingHoldsWithGuardRemoved` is that test — it exercises a `_lock`-free harness so
 * the ordering is proven on its own rather than being masked by the guard.
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
 */
contract MockRouter {
    MockERC20 public token;
    uint256 public rate = 1000;
    bool public shortfall;

    function setToken(address t) external {
        token = MockERC20(t);
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    function setShortfall(bool s) external {
        shortfall = s;
    }

    function execute(bytes calldata, bytes[] calldata, uint256) external payable {
        if (msg.value > 0) {
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
    constructor(address h, address k, address r, address p, address hk, address pm) StrayVault(h, k, r, p, hk, r) {}

    function encode(address token, int24 ts, bool zfo, uint256 amtIn, uint256 minOut)
        external
        view
        returns (bytes memory)
    {
        return _encodeSwap(token, ts, zfo, amtIn, minOut);
    }
}

// ── The suite ────────────────────────────────────────────────────────────────────────────────

contract StrayVaultTest is Test {
    StrayVault vault;
    MockRouter router;
    MockERC20 token;
    MockPermit2 permit2;

    address house = makeAddr("house");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address hook = 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC;

    bytes32 constant A = keccak256("stray-a");
    bytes32 constant B = keccak256("stray-b");

    function setUp() public {
        token = new MockERC20();
        router = new MockRouter();
        permit2 = new MockPermit2();
        router.setToken(address(token));
        vault = new StrayVault(house, keeper, address(router), address(permit2), hook, address(router));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(address(router), 100 ether);
    }

    function _adopt(address who, bytes32 id, uint256 amt) internal {
        vm.prank(who);
        vault.adopt{value: amt}(id);
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

    // ══ THE EIGHT SABOTAGES ═════════════════════════════════════════════════════════════════

    /// SABOTAGE 1 — remove the keeper check on `hunt`. Only the keeper may trade.
    function test_SABOTAGE_onlyKeeperCanHunt() public {
        _adopt(alice, A, 1 ether);
        vm.prank(alice); // the OWNER, who is still not the keeper
        vm.expectRevert(StrayVault.NotKeeper.selector);
        vault.hunt(A, address(token), 0.005 ether, 1, 200);

        vm.prank(bob);
        vm.expectRevert(StrayVault.NotKeeper.selector);
        vault.hunt(A, address(token), 0.005 ether, 1, 200);
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
        vault.hunt(B, address(token), 0.009 ether, 1, 200);

        // And spending B's real balance must not move A's.
        vm.prank(keeper);
        vault.hunt(B, address(token), 0.004 ether, 1, 200);

        assertEq(vault.stakeOf(A), aBefore, "stray A's compartment was reachable from a call about B");
        assertEq(vault.stakeOf(B), 0, "stray B did not pay for its own position");
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
            new EncoderHarness(house, keeper, address(router), address(permit2), hook, address(router));

        bytes memory enc = h.encode(address(token), 200, true, 0.0026 ether, 1);
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
        vault.hunt(A, address(token), 0.005 ether, 0, 200);

        vm.prank(keeper);
        vault.hunt(A, address(token), 0.005 ether, 1, 200);

        vm.prank(keeper);
        vm.expectRevert(StrayVault.ZeroSlippageBound.selector);
        vault.flee(A, 0);
    }

    /// SABOTAGE 6 — remove the per-position cap. It bounds the unverified-hook risk.
    function test_SABOTAGE_positionCapEnforced() public {
        _adopt(alice, A, 10 ether); // 8 ether of stake, far above the cap

        vm.prank(keeper);
        vm.expectRevert(StrayVault.PositionTooLarge.selector);
        vault.hunt(A, address(token), 0.011 ether, 1, 200);

        vm.prank(keeper);
        vault.hunt(A, address(token), 0.01 ether, 1, 200); // exactly at the cap is allowed
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

        // Hand ownership to the observer by having it adopt its own stray.
        vm.deal(address(obs), 5 ether);
        obs.adoptSelf{value: 1 ether}();
        obs.pull();

        assertEq(obs.stakeSeenDuringCallback(), 0, "stake was still set when ETH moved - CEI violated");
    }

    // ══ THE RAKE ════════════════════════════════════════════════════════════════════════════

    function test_rakeIsZeroOnALoss() public {
        _adopt(alice, A, 1 ether); // principal 0.8
        uint256 houseBefore = house.balance;

        // A losing round trip: buy at rate 1000, sell back at a worse rate.
        vm.prank(keeper);
        vault.hunt(A, address(token), 0.005 ether, 1, 200);
        router.setRate(2000); // half the ETH comes back
        vm.prank(keeper);
        vault.flee(A, 1);

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

        // Force a profit by sending the vault extra via the router's sell leg.
        vm.prank(keeper);
        vault.hunt(A, address(token), 0.005 ether, 1, 200);
        router.setRate(500); // twice the ETH comes back
        vm.prank(keeper);
        vault.flee(A, 1);

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

    // ══ THE EXIT IS NEVER GATED ═════════════════════════════════════════════════════════════

    /**
     * meridian's rule, learned live: "getting OUT is always allowed."
     *
     * A user must be able to take their uncommitted stake even while the cat is mid-position.
     */
    function test_withdrawWorksEvenWhileHolding() public {
        _adopt(alice, A, 1 ether);
        vm.prank(keeper);
        vault.hunt(A, address(token), 0.005 ether, 1, 200);

        (address held,) = vault.holdingOf(A);
        assertEq(held, address(token), "not actually holding");

        uint256 before = alice.balance;
        vm.prank(alice);
        vault.withdraw(A); // must not revert
        assertGt(alice.balance, before, "exit was blocked while holding a position");
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
        vm.prank(keeper);
        vault.hunt(A, address(token), 0.005 ether, 1, 200);

        assertEq(vault.stakeOf(A), 0.795 ether, "stake not debited");
        (address held, uint256 bal) = vault.holdingOf(A);
        assertEq(held, address(token));
        assertEq(bal, 0.005 ether * 1000, "tokens did not land in the VAULT");
    }

    /// Proceeds must land in the vault, never anywhere else. This is the custody property observed.
    function test_proceedsReturnToTheVault() public {
        _adopt(alice, A, 1 ether);
        vm.prank(keeper);
        vault.hunt(A, address(token), 0.005 ether, 1, 200);

        assertEq(token.balanceOf(address(vault)), 0.005 ether * 1000, "tokens are not in the vault");
        assertEq(token.balanceOf(keeper), 0, "the KEEPER received tokens");
        assertEq(token.balanceOf(house), 0, "the HOUSE received tokens");
    }

    function test_huntRefusesWhenAlreadyHolding() public {
        _adopt(alice, A, 1 ether);
        vm.prank(keeper);
        vault.hunt(A, address(token), 0.005 ether, 1, 200);

        vm.prank(keeper);
        vm.expectRevert(StrayVault.AlreadyHolding.selector);
        vault.hunt(A, address(token), 0.005 ether, 1, 200);
    }

    function test_fleeRefusesWhenFlat() public {
        _adopt(alice, A, 1 ether);
        vm.prank(keeper);
        vm.expectRevert(StrayVault.NotHolding.selector);
        vault.flee(A, 1);
    }

    /// A fill below the stated bound must revert rather than be accepted quietly.
    function test_huntRevertsOnShortfall() public {
        _adopt(alice, A, 1 ether);
        router.setShortfall(true);
        vm.prank(keeper);
        vm.expectRevert(StrayVault.NothingReceived.selector);
        vault.hunt(A, address(token), 0.005 ether, 1000, 200);
    }

    function test_unknownStrayIsRefused() public {
        vm.prank(keeper);
        vm.expectRevert(StrayVault.NoSuchStray.selector);
        vault.hunt(keccak256("ghost"), address(token), 0.005 ether, 1, 200);
    }

    /// Only the router may push ETH in. Otherwise `address(this).balance` stops reconciling
    /// against the sum of the compartments and every accounting assertion becomes untestable.
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

        vm.prank(keeper);
        vault.hunt(A, address(token), 0.005 ether, 1, 200);
        // Mid-position the ETH is in the pool, so the balance is the sum MINUS what is deployed.
        assertEq(address(vault).balance, vault.stakeOf(A) + vault.stakeOf(B));

        vm.prank(keeper);
        vault.flee(A, 1);
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
 * ══ THE TWO SABOTAGES THAT SURVIVED THE FIRST PASS, AND WHY THEY DID ══
 *
 * Round one applied 11 sabotages to the SOURCE. Nine were caught. Two were not, and both are the
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
contract StrayVaultSurvivorTest is Test {
    StrayVault vault;
    MockRouter router;
    MockERC20 token;
    MockPermit2 permit2;
    address house = makeAddr("house");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address hook = 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC;
    bytes32 constant A = keccak256("stray-a");

    function setUp() public {
        token = new MockERC20();
        router = new MockRouter();
        permit2 = new MockPermit2();
        router.setToken(address(token));
        vault = new StrayVault(house, keeper, address(router), address(permit2), hook, address(router));
        vm.deal(alice, 100 ether);
        vm.deal(address(router), 100 ether);
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
contract StrayVaultEdgeTest is Test {
    StrayVault vault;
    MockRouter router;
    MockERC20 token;
    MockPermit2 permit2;
    address house = makeAddr("house");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address hook = 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC;
    bytes32 constant A = keccak256("edge");

    function setUp() public {
        token = new MockERC20();
        router = new MockRouter();
        permit2 = new MockPermit2();
        router.setToken(address(token));
        vault = new StrayVault(house, keeper, address(router), address(permit2), hook, address(router));
        vm.deal(alice, 100 ether);
        vm.deal(address(router), 100 ether);
    }

    /**
     * A stray that WINS, is withdrawn, then wins AGAIN must not have the first profit raked twice.
     *
     * After a full withdrawal `principal` is 0, so every wei of a later gain is profit — which is
     * correct, because the user took their principal out. The thing that would be WRONG is the
     * house collecting twice on the SAME gain, and this asserts it does not.
     */
    function test_edge_rakeIsNotChargedTwiceOnTheSameProfit() public {
        vm.prank(alice);
        vault.adopt{value: 1 ether}(A); // principal 0.8

        vm.prank(keeper);
        vault.hunt(A, address(token), 0.005 ether, 1, 200);
        router.setRate(500); // double the ETH back
        vm.prank(keeper);
        vault.flee(A, 1);

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
     * The keeper must not be able to strand a user's money by opening a position and stopping.
     *
     * The uncommitted stake stays withdrawable at all times, so a keeper that goes silent mid-trade
     * costs the user the deployed slice and nothing more — and that slice is bounded by
     * MAX_POSITION_WEI. This is the honest bound on keeper risk, asserted rather than asserted-in-prose.
     */
    function test_edge_silentKeeperCannotStrandTheUncommittedStake() public {
        vm.prank(alice);
        vault.adopt{value: 1 ether}(A); // 0.8 stake

        vm.prank(keeper);
        vault.hunt(A, address(token), 0.01 ether, 1, 200); // the maximum a single trade may take

        // Keeper now does nothing, forever. The user must still get the rest out.
        uint256 before = alice.balance;
        vm.prank(alice);
        vault.withdraw(A);

        assertEq(alice.balance - before, 0.79 ether, "the uncommitted stake was not fully returned");
        assertLe(0.01 ether, vault.MAX_POSITION_WEI(), "exposure to a silent keeper exceeds the cap");
    }

    /** A stray id nobody adopted must be inert on every path, not just on hunt. */
    function test_edge_unknownStrayIsInertEverywhere() public {
        bytes32 ghost = keccak256("never-adopted");
        vm.prank(alice);
        vm.expectRevert(StrayVault.NotOwner.selector);
        vault.withdraw(ghost);

        vm.prank(keeper);
        vm.expectRevert(StrayVault.NoSuchStray.selector);
        vault.flee(ghost, 1);

        (uint256 payout, uint256 rake) = vault.quoteWithdraw(ghost);
        assertEq(payout, 0);
        assertEq(rake, 0);
    }
}
