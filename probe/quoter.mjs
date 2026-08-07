// Does the v4 quoter actually answer for a letscash pool? eth_call only, nothing spent.
import { createPublicClient, http, parseAbi, parseEther, formatEther } from "viem";
const RPC="https://rpc.mainnet.chain.robinhood.com";
const QUOTER="0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94";
const HOOK="0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC";
const NATIVE="0x0000000000000000000000000000000000000000";
const ABI=parseAbi(["function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes) params) returns (uint256 amountOut, uint256 gasEstimate)"]);
const c=createPublicClient({transport:http(RPC)});
const TOKEN=process.argv[2]||"0x29E2430F97430e3cCeF7119872E27659d78A4acc";
const amt=parseEther("0.0012");
try{
  const {result}=await c.simulateContract({address:QUOTER,abi:ABI,functionName:"quoteExactInputSingle",
    args:[[[NATIVE,TOKEN,0,200,HOOK],true,amt,"0x"]]});
  const out=Array.isArray(result)?result[0]:result;
  console.log("QUOTER WORKS. in",formatEther(amt),"ETH -> out",out.toString(),"units");
  console.log("implied ETH per token:", (Number(formatEther(amt))/Number(out)*1e18).toExponential(4));
}catch(e){ console.log("QUOTER FAILED:", String(e.shortMessage||e.message).slice(0,200)); }
