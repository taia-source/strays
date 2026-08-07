// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StrayVault} from "../src/StrayVault.sol";

/// Exposes the internal encoder so its bytes can be compared against the encoding that viem
/// produces and that a real landed mainnet swap used.
contract EncoderHarness is StrayVault {
    constructor(address h, address k, address r, address p, address hk) StrayVault(h, k, r, p, hk) {}

    function encode(address token, int24 ts, bool zfo, uint256 amtIn, uint256 minOut)
        external
        view
        returns (bytes memory)
    {
        return _encodeSwap(token, ts, zfo, amtIn, minOut);
    }
}

contract EncodingTest is Test {
    EncoderHarness h;
    address constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant HOOK = 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC;
    address constant TOKEN = 0x8Cbab44d14554bc86b272220DBe7Dd95F91D4ccc;

    function setUp() public {
        h = new EncoderHarness(address(0xBEEF), address(0xCAFE), ROUTER, PERMIT2, HOOK);
    }

    /// Dump the encoding so it can be diffed against viem's output offline.
    function test_dumpEncoding() public view {
        bytes memory b = h.encode(TOKEN, int24(200), true, 0.0026 ether, 1);
        console.logBytes(b);
    }

    /**
     * ══ THE TEST THAT CAUGHT A BUG THAT WOULD HAVE SPENT REAL ETH ══
     *
     * These bytes are viem's encoding of the same swap — the encoder whose output was diffed
     * byte-for-byte against a transaction that LANDED on chain 4663. The first version of
     * `_encodeSwap` produced calldata 64 bytes SHORT with every word from index 6 shifted by one,
     * because it passed the PoolKey and four other fields as positional arguments instead of one
     * struct. `ExactInputSingleParams` contains a `bytes` member, which makes the struct DYNAMIC
     * and requires a head-offset word that positional encoding omits.
     *
     * No type checker and no unit test of the arithmetic would have caught it. Only the diff did.
     */
    function test_encodingMatchesProvenViemBytes() public view {
        bytes memory got = h.encode(TOKEN, int24(200), true, 0.0026 ether, 1);
        assertEq(keccak256(got), keccak256(EXPECTED), "encoding drifted from the proven mainnet bytes");
    }

    bytes constant EXPECTED =
        hex"000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003060c0f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008cbab44d14554bc86b272220dbe7dd95f91d4ccc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c800000000000000000000000075a54357d9c78a2db19004a5fdc76c50f9242aec000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000093cafac6a80000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000093cafac6a800000000000000000000000000000000000000000000000000000000000000000400000000000000000000000008cbab44d14554bc86b272220dbe7dd95f91d4ccc0000000000000000000000000000000000000000000000000000000000000001";
}
