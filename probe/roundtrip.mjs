// Measure a REAL round trip: buy $X, then sell exactly what the buy returned.
// Uses anvil fork of mainnet 4663 so state persists between the two legs.
import { createPublicClient, createWalletClient, http, encodeAbiParameters, parseAbiParameters,
         encodeFunctionData, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.FORK_RPC || "http://127.0.0.1:8546";
const ROUTER="0x8876789976dEcBfCbBbe364623C63652db8C0904";
const PERMIT2="0x000000000022D473030F116dDEE9F6B43aC78BA3";
const HOOK="0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC";
const NATIVE="0x0000000000000000000000000000000000000000";
const V4_ACTIONS="0x060c0f", CMD="0x10";
const PK="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const acct=privateKeyToAccount(PK);

const ROUTER_ABI=[{name:"execute",type:"function",stateMutability:"payable",inputs:[{name:"commands",type:"bytes"},{name:"inputs",type:"bytes[]"},{name:"deadline",type:"uint256"}],outputs:[]}];
const ERC20=[{name:"balanceOf",type:"function",stateMutability:"view",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}]},
 {name:"approve",type:"function",stateMutability:"nonpayable",inputs:[{name:"s",type:"address"},{name:"v",type:"uint256"}],outputs:[{type:"bool"}]}];
const P2=[{name:"approve",type:"function",stateMutability:"nonpayable",inputs:[{name:"token",type:"address"},{name:"spender",type:"address"},{name:"amount",type:"uint160"},{name:"expiration",type:"uint48"}],outputs:[]}];

const pub=createPublicClient({transport:http(RPC)});
const w=createWalletClient({account:acct,transport:http(RPC)});
const addr=process.argv[2], amountIn=parseEther(process.argv[3]||"0.0026");
const t=await(await fetch(`https://api.letscash.fun/api/tokens/${addr}`)).json();
const key=[NATIVE,t.address,0,t.tickSpacing,HOOK];
const dl=()=>BigInt(Math.floor(Date.now()/1000)+600);

function buyData(amt){
  const s=encodeAbiParameters(parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"),[[key,true,amt,1n,"0x"]]);
  const se=encodeAbiParameters(parseAbiParameters("address,uint256"),[NATIVE,amt]);
  const ta=encodeAbiParameters(parseAbiParameters("address,uint256"),[t.address,1n]);
  const i0=encodeAbiParameters(parseAbiParameters("bytes,bytes[]"),[V4_ACTIONS,[s,se,ta]]);
  return encodeFunctionData({abi:ROUTER_ABI,functionName:"execute",args:[CMD,[i0],dl()]});
}
function sellData(amt){
  const s=encodeAbiParameters(parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"),[[key,false,amt,1n,"0x"]]);
  const se=encodeAbiParameters(parseAbiParameters("address,uint256"),[t.address,amt]);
  const ta=encodeAbiParameters(parseAbiParameters("address,uint256"),[NATIVE,1n]);
  const i0=encodeAbiParameters(parseAbiParameters("bytes,bytes[]"),[V4_ACTIONS,[s,se,ta]]);
  return encodeFunctionData({abi:ROUTER_ABI,functionName:"execute",args:[CMD,[i0],dl()]});
}

const eth0=await pub.getBalance({address:acct.address});
console.log("start ETH:",formatEther(eth0));
let h=await w.sendTransaction({to:ROUTER,data:buyData(amountIn),value:amountIn});
let r=await pub.waitForTransactionReceipt({hash:h});
const bought=await pub.readContract({address:t.address,abi:ERC20,functionName:"balanceOf",args:[acct.address]});
const buyGas=r.gasUsed*r.effectiveGasPrice;
console.log(`BUY  ${formatEther(amountIn)} ETH -> ${bought} units   gas ${r.gasUsed}`);

// approvals
let a1=await w.writeContract({address:t.address,abi:ERC20,functionName:"approve",args:[PERMIT2,2n**256n-1n]});
const r1=await pub.waitForTransactionReceipt({hash:a1});
let a2=await w.writeContract({address:PERMIT2,abi:P2,functionName:"approve",args:[t.address,ROUTER,2n**160n-1n,Math.floor(Date.now()/1000)+2592000]});
const r2=await pub.waitForTransactionReceipt({hash:a2});
const apprGas=r1.gasUsed*r1.effectiveGasPrice+r2.gasUsed*r2.effectiveGasPrice;

h=await w.sendTransaction({to:ROUTER,data:sellData(bought)});
r=await pub.waitForTransactionReceipt({hash:h});
if(r.status!=="success"){console.log("SELL REVERTED");process.exit(1);}
const sellGas=r.gasUsed*r.effectiveGasPrice;
const eth1=await pub.getBalance({address:acct.address});
const net=eth1-eth0;
const gross=net+buyGas+apprGas+sellGas;
console.log(`SELL ${bought} units  gas ${r.gasUsed}`);
console.log(`\n=== ROUND TRIP on ${t.symbol} (tax ${t.taxPct}%) at ${formatEther(amountIn)} ETH ===`);
console.log(`  net delta incl gas : ${formatEther(net)} ETH`);
console.log(`  gross (ex gas)     : ${formatEther(gross)} ETH  = ${(Number(gross)/Number(amountIn)*10000).toFixed(0)} bps`);
console.log(`  gas total          : ${formatEther(buyGas+apprGas+sellGas)} ETH`);
console.log(`  TOTAL COST         : ${(-Number(net)/Number(amountIn)*10000).toFixed(0)} bps of position`);
