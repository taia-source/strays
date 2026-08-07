// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Historical replay harness.
 *
 * Walks REAL historical blocks while the strategy's own state persists, so a strategy can
 * be measured against genuine pool state rather than a modelled price series.
 *
 * ══ Why vm.rollFork and not Anvil ══
 *
 * Fork with Anvil and mine locally and you are on a synthetic chain — you never see real
 * block N+1 state. `anvil_reset` with a new fork block gives you fresh state but destroys
 * your positions, and the usual workaround (an off-chain virtual portfolio, positions
 * re-established via setStorageAt) reintroduces exactly the modelling error the fork
 * existed to remove.
 *
 * `vm.rollFork` is different: Foundry's persistent-account model keeps this contract and
 * msg.sender alive across the roll, while protocol contracts are re-read from the real
 * chain at the new block.
 *
 * ══ Verified, not assumed ══
 *
 * Foundry 1.7.1 against mainnet, 2026-07-27: 12 blocks at 500-block intervals reading live
 * Uniswap V3 slot0 — sqrtPriceX96 and liquidity moved per block, portfolio state
 * accumulated across all rolls, 848ms total.
 *
 * The stale-hot-slot bug (foundry#5739) — where a slot read before the roll kept its old
 * value afterwards, silently producing wrong numbers — is FIXED in 1.7.1: a rolled read
 * matches a fresh fork at the same block exactly. Re-check this on any Foundry upgrade;
 * it is the one failure here that is silent.
 *
 * ══ What this measures, and what it does not ══
 *
 * It measures EXECUTION COST — realized slippage from real tick state, gas, revert rates.
 * That is real engineering and the numbers mean something.
 *
 * It does NOT measure profitability. Replay shows what happened to a price path the
 * strategy did not move; it says nothing about how the market reacts to your size. Pair
 * every run with the honesty guards in this package before anyone reads a Sharpe ratio.
 */
interface IVm {
    function createSelectFork(string calldata urlOrAlias, uint256 block_) external returns (uint256);
    function rollFork(uint256 blockNumber) external;
    function envString(string calldata name) external view returns (string memory);
}

abstract contract Replay {
    IVm internal constant vm = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// Blocks visited, in order. Sanity-checkable after a run.
    uint256[] public visitedBlocks;

    /**
     * Replay `steps` samples, `interval` blocks apart, starting at `startBlock`.
     *
     * `onBlock` is called once per sample with the current block already rolled to. State
     * written there persists across rolls — that is the whole point.
     */
    function replay(
        string memory rpcEnvVar,
        uint256 startBlock,
        uint256 interval,
        uint256 steps
    ) internal {
        require(interval > 0, "interval must be positive");
        require(steps > 0, "need at least one step");

        vm.createSelectFork(vm.envString(rpcEnvVar), startBlock);

        for (uint256 i = 0; i < steps; i++) {
            uint256 target = startBlock + (i * interval);
            if (i > 0) vm.rollFork(target);
            visitedBlocks.push(target);
            onBlock(target, i);
        }
    }

    /// Implemented by the strategy under test. Called once per sampled block.
    function onBlock(uint256 blockNumber, uint256 step) internal virtual;

    function blocksVisited() external view returns (uint256) {
        return visitedBlocks.length;
    }
}
