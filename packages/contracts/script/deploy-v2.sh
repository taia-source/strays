#!/usr/bin/env bash
#
# Deploy StrayVault V2 to Robinhood Chain mainnet (4663) and verify on Blockscout.
#
# ══ WHY THIS IS A SCRIPT AND NOT A COMMAND THAT WAS ALREADY RUN ══
#
# Deployment needs STRAYS_DEPLOYER_PRIVATE_KEY. The agent session that built and tested V2 was
# blocked by its permission system from reading /root/.env or sending value, which is the correct
# outcome: a private key and an outbound transfer are exactly what a human should approve. Rather
# than work around it, the whole deploy is captured here so it is one reviewed command.
#
# ══ COSTS, MEASURED AGAINST THE LIVE CHAIN ══
#
#   deploy gas      1,989,300 units      (estimated with `cast estimate --create`)
#   gas price      ~31,346,000 wei
#   cost @2x        ~1.25e14 wei  =  0.000125 ETH  ~=  $0.24
#
# The deployer held 1,914,318,000,000 wei at build time, which is SHORT by ~1.23e14 wei, so
# step 0 tops it up from the house wallet. Nothing more than the deploy needs is sent: DEPLOYMENTS
# records $8.96 of the $10 policy cap as already spent, and dust left in a deployer is still spent.
#
# ══ WHAT THIS SCRIPT DELIBERATELY DOES NOT DO ══
#
# It does not fund the vault, does not adopt a stray, and does not start the keeper. Ibrahim's
# standing instruction is that the keeper stays stopped. Deploy and verify only.
#
# Usage:  ./script/deploy-v2.sh          (dry run — prints what it would do)
#         ./script/deploy-v2.sh --send   (actually deploys)
set -euo pipefail
cd "$(dirname "$0")/.."

SEND="${1:-}"
set -a; . /root/.env; set +a
R="$ROBINHOOD_RPC_URL"

# ── Constructor arguments. Every one re-verified on chain, never trusted from a doc. ──
ROUTER=0x8876789976dEcBfCbBbe364623C63652db8C0904   # UniversalRouter
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3  # canonical CREATE2 address
HOOK_A=0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC   # 67 tokens, 5194Ξ/24h
HOOK_B=0xEfe669814e5Eec33406Bd50ffa8331618D076aEc   # 44 tokens, 1359Ξ/24h — LEVCAT/INTERN/Seriouscat
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951

HOUSE="$HOUSE_ADDRESS"
KEEPER="$STRAYS_KEEPER_ADDRESS"

echo "── preflight ─────────────────────────────────────────────────────────────"
echo "chain id      $(cast chain-id --rpc-url "$R")"
echo "deployer      $STRAYS_DEPLOYER_ADDRESS"
echo "  balance     $(cast balance "$STRAYS_DEPLOYER_ADDRESS" --rpc-url "$R") wei"
echo "house         $HOUSE"
echo "  balance     $(cast balance "$HOUSE" --rpc-url "$R") wei"
echo "keeper        $KEEPER"

# Both hooks must actually be contracts. A hook that is an EOA would make every PoolKey
# built against it address a pool that cannot exist — RESEARCH §7d's failure, in advance.
for H in "$HOOK_A" "$HOOK_B"; do
  SIZE=$(( $(cast code "$H" --rpc-url "$R" | wc -c) / 2 ))
  echo "hook $H  code $SIZE bytes"
  [ "$SIZE" -gt 100 ] || { echo "FATAL: hook $H has no code"; exit 1; }
done

# The tests are the only thing standing in for an audit. They run again here, against the
# live chain, immediately before the key is used — not "they passed earlier".
echo
echo "── tests ─────────────────────────────────────────────────────────────────"
forge test --no-match-contract ForkSwap
forge test --match-contract ForkSwap --fork-url "$R"

GAS=$(cast estimate --rpc-url "$R" --from "$STRAYS_DEPLOYER_ADDRESS" --create \
  "$(jq -r '.bytecode.object' out/StrayVault.sol/StrayVault.json)$(cast abi-encode \
   'c(address,address,address,address,address,address,address)' \
   "$HOUSE" "$KEEPER" "$ROUTER" "$PERMIT2" "$HOOK_A" "$HOOK_B" "$POOL_MANAGER" | cut -c3-)")
GP=$(cast gas-price --rpc-url "$R")
NEED=$(( GAS * GP * 2 ))
HAVE=$(cast balance "$STRAYS_DEPLOYER_ADDRESS" --rpc-url "$R")
echo
echo "deploy gas    $GAS @ $GP wei  ->  need ~$NEED wei, have $HAVE wei"

if [ "$SEND" != "--send" ]; then
  echo
  echo "DRY RUN. Re-run with --send to deploy."
  exit 0
fi

# ── 0. Top up the deployer, only if short, only by what is missing. ──
if [ "$HAVE" -lt "$NEED" ]; then
  TOPUP=$(( NEED - HAVE + 20000000000000 ))   # + headroom for gas-price drift
  echo
  echo "── funding deployer with $TOPUP wei from the house ──"
  cast send --rpc-url "$R" --private-key "$HOUSE_PRIVATE_KEY" \
    "$STRAYS_DEPLOYER_ADDRESS" --value "$TOPUP"
fi

# ── 1. Deploy. ──
echo
echo "── deploying StrayVault V2 ───────────────────────────────────────────────"
forge create src/StrayVault.sol:StrayVault \
  --rpc-url "$R" \
  --private-key "$STRAYS_DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --constructor-args "$HOUSE" "$KEEPER" "$ROUTER" "$PERMIT2" "$HOOK_A" "$HOOK_B" "$POOL_MANAGER" \
  | tee /tmp/strays-deploy.log

ADDR=$(grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' /tmp/strays-deploy.log | grep -oE '0x[0-9a-fA-F]{40}')
[ -n "$ADDR" ] || { echo "FATAL: could not parse deployed address"; exit 1; }

# ── 2. READ THE CONFIG BACK OFF THE CHAIN. ──
#
# @taia/deploy's rule: an address written down is not an address deployed. Every immutable is
# re-read from the deployed bytecode rather than echoed from what we sent.
echo
echo "── config, read back from chain ──────────────────────────────────────────"
echo "address       $ADDR"
echo "code size     $(( $(cast code "$ADDR" --rpc-url "$R" | wc -c) / 2 )) bytes"
for FN in house keeper router permit2 hookA hookB poolManager; do
  printf '%-13s %s\n' "$FN" "$(cast call "$ADDR" "$FN()(address)" --rpc-url "$R")"
done
for FN in PROFIT_RAKE_BPS ENERGY_FEE_BPS MAX_POSITION_WEI MIN_ADOPT_WEI MAX_POSITIONS; do
  printf '%-18s %s\n' "$FN" "$(cast call "$ADDR" "$FN()(uint256)" --rpc-url "$R")"
done
echo "isKnownHook(A)  $(cast call "$ADDR" 'isKnownHook(address)(bool)' "$HOOK_A" --rpc-url "$R")"
echo "isKnownHook(B)  $(cast call "$ADDR" 'isKnownHook(address)(bool)' "$HOOK_B" --rpc-url "$R")"
echo "isKnownHook(0)  $(cast call "$ADDR" 'isKnownHook(address)(bool)' \
  0x000000000000000000000000000000000000dEaD --rpc-url "$R")   <- must be false"

# ── 3. Verify the source on Blockscout. ──
echo
echo "── verifying on Blockscout ───────────────────────────────────────────────"
forge verify-contract "$ADDR" src/StrayVault.sol:StrayVault \
  --verifier blockscout \
  --verifier-url 'https://robinhoodchain.blockscout.com/api/' \
  --num-of-optimizations 200 \
  --compiler-version 0.8.28 \
  --constructor-args "$(cast abi-encode \
     'c(address,address,address,address,address,address,address)' \
     "$HOUSE" "$KEEPER" "$ROUTER" "$PERMIT2" "$HOOK_A" "$HOOK_B" "$POOL_MANAGER")" \
  --watch

echo
echo "DEPLOYED AND VERIFIED: $ADDR"
echo "https://robinhoodchain.blockscout.com/address/$ADDR"
echo
echo "NOT DONE, DELIBERATELY: the vault is unfunded and the keeper is stopped."
echo "Set STRAYS_VAULT_ADDRESS=$ADDR before the keeper is ever started."
