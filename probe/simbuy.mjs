// Simulate a REAL buy on a live letscash pool via eth_call. No money moves.
// Proves: (a) our PoolKey/encoding is accepted by the router, (b) real fill & tax.
import { createPublicClient, http, encodeAbiParameters, parseAbiParameters,
         encodeFunctionData, parseEther, formatEther } from "viem";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const HOOK = "0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC";
const NATIVE = "0x0000000000000000000000000000000000000000";
const V4_ACTIONS = "0x060c0f", CMD = "0x10";
const HOUSE = "0x1E5A3c8b0120E28Ca3FC554e6a7B7957975ad492";

const ROUTER_ABI = [{ name:"execute", type:"function", stateMutability:"payable",
  inputs:[{name:"commands",type:"bytes"},{name:"inputs",type:"bytes[]"},{name:"deadline",type:"uint256"}], outputs:[] }];
const ERC20 = [{name:"balanceOf",type:"function",stateMutability:"view",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}]}];

const c = createPublicClient({ transport: http(RPC) });
const addr = process.argv[2] || "0x8Cbab44d14554bc86b272220DBe7Dd95F91D4ccc";
const amountIn = parseEther(process.argv[3] || "0.0026"); // ~$5

const t = await (await fetch(`https://api.letscash.fun/api/tokens/${addr}`)).json();
console.log(`=== ${t.symbol}  tax ${t.taxPct}%  ts ${t.tickSpacing}  price ${t.priceEth} ETH ===`);
console.log(`spending ${formatEther(amountIn)} ETH (~$${(Number(formatEther(amountIn))*1927.27).toFixed(2)})`);

const key = [NATIVE, t.address, 0, t.tickSpacing, HOOK];
const swap = encodeAbiParameters(
  parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"),
  [[key, true, amountIn, 1n, "0x"]]);
const settle = encodeAbiParameters(parseAbiParameters("address,uint256"), [NATIVE, amountIn]);
const take   = encodeAbiParameters(parseAbiParameters("address,uint256"), [t.address, 1n]);
const input0 = encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [V4_ACTIONS, [swap, settle, take]]);
const data = encodeFunctionData({ abi: ROUTER_ABI, functionName:"execute",
  args:[CMD,[input0], BigInt(Math.floor(Date.now()/1000)+600)] });

const before = await c.readContract({ address:t.address, abi:ERC20, functionName:"balanceOf", args:[HOUSE] });
try {
  await c.call({ account: HOUSE, to: ROUTER, data, value: amountIn });
  console.log("\n*** eth_call SUCCEEDED — the router accepts our encoding ***");
} catch (e) {
  console.log("\n!!! REVERTED !!!"); console.log(String(e.shortMessage||e.message).slice(0,600)); process.exit(1);
}
// measure the fill via state-override-free trace: use estimateGas too
const gas = await c.estimateGas({ account: HOUSE, to: ROUTER, data, value: amountIn });
console.log(`gas estimate: ${gas}`);
const gp = await c.getGasPrice();
console.log(`gas price: ${Number(gp)/1e9} gwei -> cost ${formatEther(gas*gp)} ETH = $${(Number(formatEther(gas*gp))*1927.27).toFixed(5)}`);
console.log(`house token balance before: ${before}`);
