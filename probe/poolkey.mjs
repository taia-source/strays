// Derive the v4 poolId for a live letscash token and check it matches the API's `pool`.
// If it matches, we know the exact PoolKey (incl. hook + tickSpacing) to encode swaps with.
import { encodeAbiParameters, parseAbiParameters, keccak256 } from "viem";

const API = "https://api.letscash.fun/api";
const HOOK = "0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC";
const NATIVE = "0x0000000000000000000000000000000000000000";

const addr = process.argv[2] || "0x8Cbab44d14554bc86b272220DBe7Dd95F91D4ccc";
const t = await (await fetch(`${API}/tokens/${addr}`)).json();
console.log(`token ${t.symbol}  tax ${t.taxPct}%  tickSpacing ${t.tickSpacing}  pool(API) ${t.pool}`);

// v4 PoolId = keccak256(abi.encode(PoolKey)) — PoolKey is a STATIC struct so plain encode.
// fee: for hooked pools letscash uses dynamic fee flag or a static? try candidates.
const candidates = [];
for (const fee of [0, 100, 500, 3000, 10000, 0x800000 /* DYNAMIC_FEE_FLAG */]) {
  const enc = encodeAbiParameters(
    parseAbiParameters("(address,address,uint24,int24,address)"),
    [[NATIVE, t.address, fee, t.tickSpacing, HOOK]]
  );
  const id = keccak256(enc);
  candidates.push({ fee, id });
  if (id.toLowerCase() === t.pool.toLowerCase()) {
    console.log(`\n*** MATCH *** fee=${fee} (0x${fee.toString(16)})  poolId=${id}`);
  }
}
console.log("\nall candidates:");
for (const c of candidates) console.log(`  fee=${String(c.fee).padStart(8)} -> ${c.id}`);
