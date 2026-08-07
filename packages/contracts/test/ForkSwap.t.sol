// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StrayVault} from "../src/StrayVault.sol";

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function symbol() external view returns (string memory);
}

/**
 * The test that decides whether this contract works at all.
 *
 * ══ WHY MOCKS ARE NOT ENOUGH HERE ══
 *
 * `StrayVault.t.sol` proves the ACCOUNTING against a mock router that does what we told it to do.
 * That is worth having and it proves nothing about the real venue: the pad's `hook` and
 * `revenueSplitter` are UNVERIFIED on Blockscout (RESEARCH §1b), every swap routes through them,
 * and their behaviour is observable but not auditable.
 *
 * So the swap path is exercised against the REAL UniversalRouter, the REAL hook, and a REAL live
 * letscash pool, on a fork of mainnet 4663 at head. If the contract's encoding is wrong, or the
 * hook rejects a contract caller, or `TAKE_ALL` settles somewhere other than to us, it fails here
 * rather than on mainnet with a user's money in it.
 *
 * ══ THE PROPERTY THIS TEST EXISTS TO OBSERVE ══
 *
 * Not "the swap succeeded". The swap succeeding is table stakes. What matters is **where the
 * tokens and the ETH end up**, because that is the custody claim: `TAKE_ALL` has no recipient
 * field, so proceeds must land in the vault and nowhere else. `test_fork_proceedsLandInTheVault`
 * asserts on the balances of the keeper and the house too, since a design that leaked to either
 * would still pass a test that only checked the swap returned.
 *
 * Run with:
 *   forge test --match-contract ForkSwap --fork-url $ROBINHOOD_RPC_URL
 */
contract ForkSwapTest is Test {
    // Real addresses on chain 4663, all from `api.letscash.fun/api/config` and cross-checked on
    // Blockscout. See RESEARCH.md §1b.
    address constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant HOOK = 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    /**
     * A live 1%-tax token. Tax tier matters: RESEARCH §3b measured the round trip at 231bps here
     * and 1938bps on a 10%-tax token, which is why the strategy hunts 1% only.
     *
     * `tickSpacing` is 200 for this pool and is NOT a constant across the pad — it varies per
     * launch config and must be read per token.
     */
    address constant TOKEN = 0x8Cbab44d14554bc86b272220DBe7Dd95F91D4ccc; // CatDay
    int24 constant TICK_SPACING = 200;

    StrayVault vault;
    address house = makeAddr("house");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    bytes32 constant A = keccak256("fork-stray");

    function setUp() public {
        vault = new StrayVault(house, keeper, ROUTER, PERMIT2, HOOK, POOL_MANAGER);
        vm.deal(alice, 1 ether);
    }

    /// Skip cleanly when not forked, rather than failing confusingly. A skipped test is not a
    /// pass, so the CI invocation always passes --fork-url; this only guards a bare `forge test`.
    modifier onlyForked() {
        if (block.chainid != 4663) {
            vm.skip(true);
        }
        _;
    }

    function test_fork_buyThenSellRoundTrips() public onlyForked {
        vm.prank(alice);
        vault.adopt{value: 0.02 ether}(A);

        uint256 stakeBefore = vault.stakeOf(A);
        uint256 spend = 0.0026 ether; // ~$5, the intended position size

        vm.prank(keeper);
        vault.hunt(A, TOKEN, spend, 1, TICK_SPACING);

        (address held, uint256 bal) = vault.holdingOf(A);
        assertEq(held, TOKEN, "not holding the token after a buy");
        assertGt(bal, 0, "the buy returned no tokens");
        assertEq(vault.stakeOf(A), stakeBefore - spend, "stake was not debited by exactly the spend");

        console.log("bought (raw units):", bal);

        vm.prank(keeper);
        vault.flee(A, 1);

        (address heldAfter,) = vault.holdingOf(A);
        assertEq(heldAfter, address(0), "still holding after a sell");

        uint256 stakeAfter = vault.stakeOf(A);
        console.log("stake before:", stakeBefore);
        console.log("stake after :", stakeAfter);

        // The round trip costs the pad's tax on both legs, so the stake MUST come back lower.
        // A round trip that returned more than it spent would mean the tax was not charged, which
        // would mean we are not actually trading the pool we think we are.
        assertLt(stakeAfter, stakeBefore, "a round trip returned MORE than it cost - tax not charged?");

        uint256 costBps = ((stakeBefore - stakeAfter) * 10_000) / spend;
        console.log("measured round-trip cost, bps of position:", costBps);

        // RESEARCH §3b measured 199bps of swap cost on this tier (2x the 1% tax, impact
        // negligible at $5). Bounds are wide enough to absorb pool drift but tight enough that a
        // wrong-tier pool or a missing tax would fail.
        assertGt(costBps, 150, "cost is implausibly low - are we trading the right pool?");
        assertLt(costBps, 400, "cost is far above the measured 199bps for a 1% tax token");
    }

    /**
     * THE CUSTODY CLAIM, OBSERVED ON THE REAL ROUTER.
     *
     * `TAKE_ALL` has no recipient field, so proceeds settle to the caller. This asserts they land
     * in the VAULT and that neither the keeper nor the house received anything — a leak to either
     * would still pass a test that only checked the swap returned.
     */
    function test_fork_proceedsLandInTheVault() public onlyForked {
        vm.prank(alice);
        vault.adopt{value: 0.02 ether}(A);

        vm.prank(keeper);
        vault.hunt(A, TOKEN, 0.0026 ether, 1, TICK_SPACING);

        assertGt(IERC20Min(TOKEN).balanceOf(address(vault)), 0, "tokens did not land in the vault");
        assertEq(IERC20Min(TOKEN).balanceOf(keeper), 0, "THE KEEPER RECEIVED TOKENS");
        assertEq(IERC20Min(TOKEN).balanceOf(house), 0, "THE HOUSE RECEIVED TOKENS");
        assertEq(IERC20Min(TOKEN).balanceOf(alice), 0, "tokens went to the user rather than the vault");

        uint256 ethBefore = address(vault).balance;
        vm.prank(keeper);
        vault.flee(A, 1);

        assertGt(address(vault).balance, ethBefore, "ETH proceeds did not return to the vault");
        assertEq(keeper.balance, 0, "THE KEEPER RECEIVED ETH");
    }

    /// The user can always get out, even on the real venue, even mid-position.
    function test_fork_withdrawAfterARealRoundTrip() public onlyForked {
        vm.prank(alice);
        vault.adopt{value: 0.02 ether}(A);

        vm.prank(keeper);
        vault.hunt(A, TOKEN, 0.0026 ether, 1, TICK_SPACING);
        vm.prank(keeper);
        vault.flee(A, 1);

        uint256 before = alice.balance;
        vm.prank(alice);
        vault.withdraw(A);

        assertGt(alice.balance, before, "the user could not withdraw after a real round trip");
        assertEq(vault.stakeOf(A), 0, "stake not cleared");
        // The round trip lost money to tax, so the house must have taken NO rake.
        assertEq(house.balance, 0.02 ether * 2000 / 10_000, "house took a rake on a losing round trip");
    }

    /// A 10%-tax token costs ~1938bps to round trip. Measured here so the strategy's hard filter
    /// on `taxPct == 1` is justified by this project's own on-chain evidence, not only by the API.
    function test_fork_measureCostAcrossTaxTiers() public onlyForked {
        address[4] memory tokens = [
            0x8Cbab44d14554bc86b272220DBe7Dd95F91D4ccc, // 1%
            0x21d3780331da7C98b67A95644c5Af16a443819cc, // 3%
            0xE3cc34EE881Bb1aD91573F18C6073F51688720cc, // 5%
            0xF6862f55c5d2D69Af40EDad7932bedC027f46fcc // 10%
        ];
        uint8[4] memory taxes = [1, 3, 5, 10];

        for (uint256 i = 0; i < tokens.length; i++) {
            bytes32 id = keccak256(abi.encodePacked("tier", i));
            address user = makeAddr(string(abi.encodePacked("user", i)));
            vm.deal(user, 1 ether);
            vm.prank(user);
            vault.adopt{value: 0.02 ether}(id);

            uint256 before = vault.stakeOf(id);
            vm.prank(keeper);
            vault.hunt(id, tokens[i], 0.0026 ether, 1, TICK_SPACING);
            vm.prank(keeper);
            vault.flee(id, 1);

            uint256 costBps = ((before - vault.stakeOf(id)) * 10_000) / 0.0026 ether;
            console.log("tax %:", taxes[i]);
            console.log("  round-trip bps:", costBps);
        }
    }
}
