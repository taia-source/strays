// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StrayVault} from "../src/StrayVault.sol";

/// Exposes the internal encoder so its bytes can be compared against the encoding that viem
/// produces and that a real landed mainnet swap used.
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

contract EncodingTest is Test {
    EncoderHarness h;
    address constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant HOOK_A = 0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC;
    address constant HOOK_B = 0xEfe669814e5Eec33406Bd50ffa8331618D076aEc;
    address constant TOKEN = 0x8Cbab44d14554bc86b272220DBe7Dd95F91D4ccc;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function setUp() public {
        h = new EncoderHarness(address(0xBEEF), address(0xCAFE), ROUTER, PERMIT2, HOOK_A, HOOK_B);
    }

    /// Dump the encoding so it can be diffed against viem's output offline.
    function test_dumpEncoding() public view {
        bytes memory b = h.encode(TOKEN, HOOK_A, int24(200), true, 0.0026 ether, 1);
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
        bytes memory got = h.encode(TOKEN, HOOK_A, int24(200), true, 0.0026 ether, 1);
        assertEq(keccak256(got), keccak256(EXPECTED), "encoding drifted from the proven mainnet bytes");
    }

    /**
     * ══ THE HOOK IS A VARIABLE NOW, SO IT MUST BE PINNED AT BOTH OF ITS VALUES ══
     *
     * RESEARCH §7d's transferable lesson is not "there were two hooks". It is:
     *
     *     *"A single-sample verification of a two-valued field cannot fail. The reconstruction
     *      matched BECAUSE THE SAMPLE WAS HOMOGENEOUS, not because the derivation was right."*
     *
     * Every PoolKey check in the whole build started from a token that happened to be on hook A —
     * §2's derivation, the fork tests, the live-fire trades — so the field was never exercised at
     * its second value and the bug hid for the entire project.
     *
     * `test_encodingMatchesProvenViemBytes` above is exactly such a single sample: it pins hook A
     * only. So this test encodes the SAME swap against hook B and asserts the two encodings differ
     * in EXACTLY the hook word and nowhere else. That is stronger than a second golden vector,
     * because it proves the hook reaches the PoolKey rather than being dropped — an encoder that
     * ignored the argument and hardcoded hook A would produce identical bytes and fail here.
     */
    function test_encodingCarriesTheHookArgumentIntoThePoolKey() public view {
        bytes memory a = h.encode(TOKEN, HOOK_A, int24(200), true, 0.0026 ether, 1);
        bytes memory b = h.encode(TOKEN, HOOK_B, int24(200), true, 0.0026 ether, 1);

        assertEq(a.length, b.length, "changing the hook changed the encoding's LENGTH");
        assertTrue(keccak256(a) != keccak256(b), "the hook argument is being IGNORED by the encoder");

        // Exactly one 32-byte word differs, and it is the hooks field of the PoolKey.
        uint256 diffWords = 0;
        uint256 diffAt = type(uint256).max;
        for (uint256 w = 0; w * 32 < a.length; w++) {
            bool same = true;
            for (uint256 i = w * 32; i < (w + 1) * 32 && i < a.length; i++) {
                if (a[i] != b[i]) {
                    same = false;
                    break;
                }
            }
            if (!same) {
                diffWords++;
                diffAt = w;
            }
        }
        assertEq(diffWords, 1, "changing the hook perturbed more than the hooks field");

        // And that word really is the hook, decoded rather than located by eye.
        bytes32 wordA;
        bytes32 wordB;
        uint256 off = diffAt * 32;
        assembly {
            wordA := mload(add(add(a, 0x20), off))
            wordB := mload(add(add(b, 0x20), off))
        }
        assertEq(address(uint160(uint256(wordA))), HOOK_A, "word A is not hook A");
        assertEq(address(uint160(uint256(wordB))), HOOK_B, "word B is not hook B");
    }

    bytes constant EXPECTED =
        hex"000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003060c0f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008cbab44d14554bc86b272220dbe7dd95f91d4ccc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c800000000000000000000000075a54357d9c78a2db19004a5fdc76c50f9242aec000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000093cafac6a80000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000093cafac6a800000000000000000000000000000000000000000000000000000000000000000400000000000000000000000008cbab44d14554bc86b272220dbe7dd95f91d4ccc0000000000000000000000000000000000000000000000000000000000000001";
}
