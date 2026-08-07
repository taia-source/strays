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
 * That is worth having and it proves nothing about the real venue: the pad's hooks and
 * `revenueSplitter` are UNVERIFIED on Blockscout (RESEARCH §1b), every swap routes through them,
 * and their behaviour is observable but not auditable.
 *
 * So the swap path is exercised against the REAL UniversalRouter, the REAL hooks, and REAL live
 * letscash pools, on a fork of mainnet 4663 at head. If the contract's encoding is wrong, or a
 * hook rejects a contract caller, or `TAKE_ALL` settles somewhere other than to us, it fails here
 * rather than on mainnet with a user's money in it.
 *
 * ══ WHY THIS FILE NOW TESTS BOTH HOOKS, AND WHY V1'S VERSION COULD NOT HAVE ══
 *
 * RESEARCH §7d, on how a two-hook pad was mistaken for a one-hook pad for the entire build:
 *
 *     *"Every PoolKey check ever run started from a token that happened to be on the first hook:
 *      §2 derived the key from CatDay, the fork tests used CatDay, and the live-fire trades used
 *      Yourcoin and CASHDOG. A single-sample verification of a two-valued field cannot fail."*
 *
 * **This file was part of that failure.** It used one token, on one hook, and passed — which is
 * exactly why it could not report that 44 tokens and 1,359Ξ of daily volume were unreachable.
 *
 * So every swap test below runs against BOTH hooks, and `test_fork_hookBTokensWereUnreachableInV1`
 * demonstrates the V1 failure directly by building the wrong PoolKey on purpose and observing the
 * revert. A fix nobody watched fail is a fix nobody has evidence for.
 *
 * Run with:
 *   forge test --match-contract ForkSwap --fork-url $ROBINHOOD_RPC_URL
 */
contract ForkSwapTest is Test {
    // Real addresses on chain 4663, all from `api.letscash.fun/api/config` and cross-checked on
    // Blockscout. See RESEARCH.md §1b.
    address constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    /**
     * THE TWO HOOKS. Both re-measured 2026-08-07 by reconstructing each token's poolId against
     * both candidates and matching the pad's own `pool` field: 67 tokens on A, 44 on B, 3 that
     * match neither (USDG, LAC, LETSBANK — the non-pad quote assets).
     */
    address constant HOOK_A = 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC;
    address constant HOOK_B = 0xEfe669814e5Eec33406Bd50ffa8331618D076aEc;

    /**
     * A live 1%-tax token on HOOK A. Tax tier matters: RESEARCH §3b measured the round trip at
     * 199bps here and 1938bps on a 10%-tax token.
     *
     * `tickSpacing` is 200 for this pool and is NOT guaranteed constant across the pad: it varies
     * per launch config and must be read per token.
     */
    address constant TOKEN_A = 0x8Cbab44d14554bc86b272220DBe7Dd95F91D4ccc; // CatDay, hook A

    /**
     * A live 1%-tax token on HOOK B — **the half of the pad V1 could not reach at all.**
     *
     * LEVCAT is one of the three names Ibrahim pointed at directly (RESEARCH §7d), 1,178 holders
     * and 308Ξ of 24h volume at the time of measurement, and the deployed V1 vault cannot trade a
     * single wei of it.
     */
    address constant TOKEN_B = 0x02C2FaEdb05cc1dDd40738a975f57d217ad33ecc; // LEVCAT, hook B

    int24 constant TICK_SPACING = 200;

    StrayVault vault;
    address house = makeAddr("house");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    bytes32 constant A = keccak256("fork-stray");

    function setUp() public {
        vault = new StrayVault(house, keeper, ROUTER, PERMIT2, HOOK_A, HOOK_B, POOL_MANAGER);
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

    // ══ THE ROUND TRIP, ON BOTH HOOKS ═══════════════════════════════════════════════════════

    function _roundTrip(address token, address hook, string memory label)
        internal
        returns (uint256 costBps)
    {
        bytes32 id = keccak256(abi.encodePacked("rt", token, hook));
        address user = makeAddr(label);
        vm.deal(user, 1 ether);
        vm.prank(user);
        vault.adopt{value: 0.02 ether}(id);

        uint256 stakeBefore = vault.stakeOf(id);
        uint256 spend = 0.0026 ether; // ~$5, the intended position size

        vm.prank(keeper);
        uint256 slot = vault.hunt(id, token, hook, spend, 1, TICK_SPACING);

        (address held, uint256 bal) = vault.holdingOf(id, slot);
        assertEq(held, token, "not holding the token after a buy");
        assertGt(bal, 0, "the buy returned no tokens");
        assertEq(vault.stakeOf(id), stakeBefore - spend, "stake was not debited by exactly the spend");

        // The watermark was seeded from the MEASURED fill against the REAL pool.
        uint256 peak = vault.positionAt(id, slot).peakPriceWei;
        assertEq(peak, (spend * 1e18) / bal, "the entry watermark does not match the measured fill");
        assertGt(peak, 0, "a zero entry price would make every trailing stop meaningless");

        console.log(label);
        console.log("  bought (raw units):", bal);
        console.log("  entry price wei/token:", peak);

        vm.prank(keeper);
        vault.flee(id, slot, 1);

        (address heldAfter,) = vault.holdingOf(id, slot);
        assertEq(heldAfter, address(0), "still holding after a sell");

        uint256 stakeAfter = vault.stakeOf(id);
        // The round trip costs the pad's tax on both legs, so the stake MUST come back lower.
        // A round trip that returned more than it spent would mean the tax was not charged, which
        // would mean we are not actually trading the pool we think we are.
        assertLt(stakeAfter, stakeBefore, "a round trip returned MORE than it cost - tax not charged?");

        costBps = ((stakeBefore - stakeAfter) * 10_000) / spend;
        console.log("  round-trip cost, bps of position:", costBps);
    }

    /**
     * HOOK A — the hook V1 knew about. This is the regression check: the new per-trade hook
     * argument must reproduce V1's measured 199bps exactly, or the encoding drifted.
     */
    function test_fork_roundTripOnHookA() public onlyForked {
        uint256 costBps = _roundTrip(TOKEN_A, HOOK_A, "HOOK A / CatDay");
        // RESEARCH §3b measured 199bps of swap cost on this tier (2x the 1% tax, impact
        // negligible at $5). Bounds are wide enough to absorb pool drift but tight enough that a
        // wrong-tier pool or a missing tax would fail.
        assertGt(costBps, 150, "cost is implausibly low - are we trading the right pool?");
        assertLt(costBps, 400, "cost is far above the measured 199bps for a 1% tax token");
    }

    /**
     * ══ HOOK B — THE TEST THAT COULD NOT HAVE EXISTED BEFORE THIS CONTRACT CHANGE ══
     *
     * A live round trip on LEVCAT, on the second hook. V1 cannot execute this at all: its
     * `_encodeSwap` builds every PoolKey with its single immutable hook, so this swap addresses an
     * uninitialised pool and reverts with an empty inner revert wrapped in `UnexpectedRevertBytes`.
     *
     * This passing is the whole justification for the redeploy — it roughly doubles the reachable
     * market and adds the most liquid names on the pad.
     */
    function test_fork_roundTripOnHookB() public onlyForked {
        uint256 costBps = _roundTrip(TOKEN_B, HOOK_B, "HOOK B / LEVCAT");
        assertGt(costBps, 150, "cost is implausibly low - are we trading the right pool?");
        assertLt(costBps, 400, "cost is far above the measured 199bps for a 1% tax token");
    }

    /**
     * ══ THE V1 FAILURE, REPRODUCED ON PURPOSE ══
     *
     * RESEARCH §7d was found from a live probe returning an implausible number, not from a test.
     * So the failure is demonstrated here rather than described: a hook-B token bought with hook A
     * — which is exactly the PoolKey the deployed V1 builds for LEVCAT — must REVERT.
     *
     * Without this, "the hook must be per-trade" would rest on prose. With it, the claim is that
     * one specific call fails and another specific call succeeds, both observed on the same fork
     * in the same test run.
     */
    function test_fork_hookBTokensWereUnreachableInV1() public onlyForked {
        vm.prank(alice);
        vault.adopt{value: 0.02 ether}(A);

        // THE V1 BEHAVIOUR: LEVCAT with the only hook V1 knows. The pool does not exist.
        vm.prank(keeper);
        vm.expectRevert();
        vault.hunt(A, TOKEN_B, HOOK_A, 0.0026 ether, 1, TICK_SPACING);

        // THE V2 BEHAVIOUR: the same token, the right hook, on the same block. It works.
        vm.prank(keeper);
        uint256 slot = vault.hunt(A, TOKEN_B, HOOK_B, 0.0026 ether, 1, TICK_SPACING);
        (address held, uint256 bal) = vault.holdingOf(A, slot);
        assertEq(held, TOKEN_B, "the correct hook did not produce a position");
        assertGt(bal, 0, "the correct hook bought nothing");
        console.log("LEVCAT bought via hook B (raw units):", bal);
    }

    /**
     * THE CUSTODY CLAIM, OBSERVED ON THE REAL ROUTER — on both hooks.
     *
     * `TAKE_ALL` has no recipient field, so proceeds settle to the caller. This asserts they land
     * in the VAULT and that neither the keeper nor the house received anything — a leak to either
     * would still pass a test that only checked the swap returned.
     *
     * Run against BOTH hooks because the hooks are different unverified contracts with different
     * bytecode (27,857 and 22,769 bytes), and "hook A does not steal" is not evidence about hook B.
     */
    function test_fork_proceedsLandInTheVaultOnBothHooks() public onlyForked {
        vm.prank(alice);
        vault.adopt{value: 0.02 ether}(A);

        vm.prank(keeper);
        uint256 sa = vault.hunt(A, TOKEN_A, HOOK_A, 0.0026 ether, 1, TICK_SPACING);
        vm.prank(keeper);
        uint256 sb = vault.hunt(A, TOKEN_B, HOOK_B, 0.0026 ether, 1, TICK_SPACING);

        assertGt(IERC20Min(TOKEN_A).balanceOf(address(vault)), 0, "hook A tokens did not land in the vault");
        assertGt(IERC20Min(TOKEN_B).balanceOf(address(vault)), 0, "hook B tokens did not land in the vault");
        for (uint256 i = 0; i < 2; i++) {
            address tok = i == 0 ? TOKEN_A : TOKEN_B;
            assertEq(IERC20Min(tok).balanceOf(keeper), 0, "THE KEEPER RECEIVED TOKENS");
            assertEq(IERC20Min(tok).balanceOf(house), 0, "THE HOUSE RECEIVED TOKENS");
            assertEq(IERC20Min(tok).balanceOf(alice), 0, "tokens went to the user rather than the vault");
        }

        uint256 ethBefore = address(vault).balance;
        vm.prank(keeper);
        vault.flee(A, sa, 1);
        vm.prank(keeper);
        vault.flee(A, sb, 1);

        assertGt(address(vault).balance, ethBefore, "ETH proceeds did not return to the vault");
        assertEq(keeper.balance, 0, "THE KEEPER RECEIVED ETH");
        assertEq(house.balance, 0.02 ether * 2000 / 10_000, "the house received more than its energy fee");
    }

    /**
     * ══ THE MULTI-POSITION CLAIM, ON THE REAL VENUE, ACROSS BOTH HOOKS ══
     *
     * §10.5 measured that eight slots is what turns a non-significant result (t=1.16) into a
     * significant one (t 2.38-2.72 on 20/20 seeds). This asserts a stray can actually hold several
     * live positions at once against real pools — mixed across both hooks, which is the case the
     * mock cannot speak to — and that each keeps its own basis and watermark.
     */
    function test_fork_concurrentPositionsAcrossBothHooks() public onlyForked {
        vm.prank(alice);
        vault.adopt{value: 0.05 ether}(A);
        uint256 stakeBefore = vault.stakeOf(A);

        vm.prank(keeper);
        uint256 sa = vault.hunt(A, TOKEN_A, HOOK_A, 0.0026 ether, 1, TICK_SPACING);
        vm.prank(keeper);
        uint256 sb = vault.hunt(A, TOKEN_B, HOOK_B, 0.0026 ether, 1, TICK_SPACING);

        assertEq(vault.openPositionCount(A), 2, "two live positions were not held at once");
        assertEq(vault.stakeOf(A), stakeBefore - 0.0052 ether, "stake was not debited once per position");

        StrayVault.Position memory pa = vault.positionAt(A, sa);
        StrayVault.Position memory pb = vault.positionAt(A, sb);
        assertEq(pa.token, TOKEN_A);
        assertEq(pa.hook, HOOK_A, "slot A recorded the wrong hook");
        assertEq(pb.token, TOKEN_B);
        assertEq(pb.hook, HOOK_B, "slot B recorded the wrong hook");
        assertGt(pa.peakPriceWei, 0, "no watermark on slot A");
        assertGt(pb.peakPriceWei, 0, "no watermark on slot B");

        console.log("CatDay  entry wei/token:", pa.peakPriceWei);
        console.log("LEVCAT  entry wei/token:", pb.peakPriceWei);

        // Closing ONE must not disturb the other, against real liquidity.
        vm.prank(keeper);
        vault.flee(A, sa, 1);
        assertEq(vault.openPositionCount(A), 1, "closing one position closed both");
        assertEq(vault.positionAt(A, sb).token, TOKEN_B, "the surviving position was corrupted");
        assertEq(
            vault.positionAt(A, sb).peakPriceWei,
            pb.peakPriceWei,
            "closing another slot moved this slot's watermark"
        );

        vm.prank(keeper);
        vault.flee(A, sb, 1);
        assertEq(vault.openPositionCount(A), 0);
    }

    /**
     * THE WATERMARK AGAINST REAL PRICES.
     *
     * Seeded from the real fill, raised by `mark`, and — the property that matters — NOT lowered
     * by a later report. This is the trailing stop's reference surviving a real round trip.
     */
    function test_fork_watermarkTracksRealFillsAndOnlyRises() public onlyForked {
        vm.prank(alice);
        vault.adopt{value: 0.02 ether}(A);

        vm.prank(keeper);
        uint256 slot = vault.hunt(A, TOKEN_B, HOOK_B, 0.0026 ether, 1, TICK_SPACING);
        uint256 entry = vault.positionAt(A, slot).peakPriceWei;
        assertGt(entry, 0, "no entry watermark against a real pool");

        vm.prank(keeper);
        vault.mark(A, slot, entry * 2);
        assertEq(vault.positionAt(A, slot).peakPriceWei, entry * 2, "mark did not raise");

        vm.prank(keeper);
        vault.mark(A, slot, entry / 2);
        assertEq(
            vault.positionAt(A, slot).peakPriceWei,
            entry * 2,
            "a real-price report LOWERED the watermark - the trailing stop would be disarmed"
        );

        // And the exit is not gated by any of it.
        vm.prank(keeper);
        vault.flee(A, slot, 1);
        assertEq(vault.openPositionCount(A), 0, "the watermark blocked a real exit");
    }

    /// The user can always get out, even on the real venue, even mid-position.
    function test_fork_withdrawAfterARealRoundTrip() public onlyForked {
        vm.prank(alice);
        vault.adopt{value: 0.02 ether}(A);

        vm.prank(keeper);
        uint256 slot = vault.hunt(A, TOKEN_A, HOOK_A, 0.0026 ether, 1, TICK_SPACING);
        vm.prank(keeper);
        vault.flee(A, slot, 1);

        uint256 before = alice.balance;
        vm.prank(alice);
        vault.withdraw(A);

        assertGt(alice.balance, before, "the user could not withdraw after a real round trip");
        assertEq(vault.stakeOf(A), 0, "stake not cleared");
        // The round trip lost money to tax, so the house must have taken NO rake.
        assertEq(house.balance, 0.02 ether * 2000 / 10_000, "house took a rake on a losing round trip");
    }

    /// An arbitrary hook must be refused BEFORE any ETH reaches the router, on the real venue too.
    function test_fork_arbitraryHookRefusedOnChain() public onlyForked {
        vm.prank(alice);
        vault.adopt{value: 0.02 ether}(A);
        uint256 stakeBefore = vault.stakeOf(A);

        vm.prank(keeper);
        vm.expectRevert(StrayVault.UnknownHook.selector);
        vault.hunt(A, TOKEN_A, makeAddr("evil-hook"), 0.0026 ether, 1, TICK_SPACING);

        assertEq(vault.stakeOf(A), stakeBefore, "stake moved on a refused hook");
        assertEq(vault.openPositionCount(A), 0, "a position was opened for a refused hook");
    }

    /// A 10%-tax token costs ~1938bps to round trip. Measured here so the strategy's tax handling
    /// is justified by this project's own on-chain evidence, not only by the API.
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
            uint256 slot = vault.hunt(id, tokens[i], HOOK_A, 0.0026 ether, 1, TICK_SPACING);
            vm.prank(keeper);
            vault.flee(id, slot, 1);

            uint256 costBps = ((before - vault.stakeOf(id)) * 10_000) / 0.0026 ether;
            console.log("tax %:", taxes[i]);
            console.log("  round-trip bps:", costBps);
        }
    }
}
