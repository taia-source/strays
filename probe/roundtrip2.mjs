// Round trip measured by ETH balance delta, gas accounted separately. Fresh account each run.
import { createPublicClient, createWalletClient, http, encodeAbiParameters, parseAbiParameters,
         encodeFunctionData, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
const RPC="http://127.0.0.1:8546";
const ROUTER="0x8876789976dEcBfCbBbe364623C63652db8C0904";
const PERMIT2="0x000000000022D473030F116dDEE9F6B43aC78BA3";
const HOOK="0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC";
const NATIVE="0x0000000000000000000000000000000000000000";
const V4="0x060c0f", CMD="0x10";
const acct=privateKeyToAccount(process.argv[4]||"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const RA=[{name:"execute",type:"function",stateMutability:"payable",inputs:[{name:"c",type:"bytes"},{name:"i",type:"bytes[]"},{name:"d",type:"uint256"}],outputs:[]}];
const E=[{name:"balanceOf",type:"function",stateMutability:"view",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}]},{name:"approve",type:"function",stateMutability:"nonpayable",inputs:[{name:"s",type:"address"},{name:"v",type:"uint256"}],outputs:[{type:"bool"}]}];
const P2=[{name:"approve",type:"function",stateMutability:"nonpayable",inputs:[{name:"t",type:"address"},{name:"s",type:"address"},{name:"a",type:"uint160"},{name:"e",type:"uint48"}],outputs:[]}];
const pub=createPublicClient({transport:http(RPC)}), w=createWalletClient({account:acct,transport:http(RPC)});
const t=await(await fetch(`https://api.letscash.fun/api/tokens/${process.argv[2]}`)).json();
const amt=parseEther(process.argv[3]||"0.0026");
const key=[NATIVE,t.address,0,t.tickSpacing,HOOK], dl=()=>BigInt(Math.floor(Date.now()/1000)+600);
const mk=(zfo,ain,cIn,cOut)=>{const s=encodeAbiParameters(parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"),[[key,zfo,ain,1n,"0x"]]);
 const se=encodeAbiParameters(parseAbiParameters("address,uint256"),[cIn,ain]);const ta=encodeAbiParameters(parseAbiParameters("address,uint256"),[cOut,1n]);
 const i0=encodeAbiParameters(parseAbiParameters("bytes,bytes[]"),[V4,[s,se,ta]]);
 return encodeFunctionData({abi:RA,functionName:"execute",args:[CMD,[i0],dl()]});};
// pre-approve so approval gas isn't in the round trip (one-time cost, amortized)
await pub.waitForTransactionReceipt({hash:await w.writeContract({address:t.address,abi:E,functionName:"approve",args:[PERMIT2,2n**256n-1n]})});
await pub.waitForTransactionReceipt({hash:await w.writeContract({address:PERMIT2,abi:P2,functionName:"approve",args:[t.address,ROUTER,2n**160n-1n,Math.floor(Date.now()/1000)+2592000]})});
const b0=await pub.getBalance({address:acct.address});
let r=await pub.waitForTransactionReceipt({hash:await w.sendTransaction({to:ROUTER,data:mk(true,amt,NATIVE,t.address),value:amt})});
const g1=r.gasUsed*r.effectiveGasPrice;
const got=await pub.readContract({address:t.address,abi:E,functionName:"balanceOf",args:[acct.address]});
r=await pub.waitForTransactionReceipt({hash:await w.sendTransaction({to:ROUTER,data:mk(false,got,t.address,NATIVE)})});
if(r.status!=="success"){console.log("SELL REVERTED");process.exit(1);}
const g2=r.gasUsed*r.effectiveGasPrice;
const b1=await pub.getBalance({address:acct.address});
const netIncl=b1-b0, gasTot=g1+g2, gross=netIncl+gasTot;
console.log(`${t.symbol.padEnd(12)} tax=${String(t.taxPct).padStart(2)}%  in=${formatEther(amt)} ETH`);
console.log(`  tokens bought : ${got}`);
console.log(`  gross (ex gas): ${(Number(gross)/Number(amt)*10000).toFixed(1)} bps   ${formatEther(gross)} ETH`);
console.log(`  gas both legs : ${(Number(gasTot)/Number(amt)*10000).toFixed(1)} bps   ${formatEther(gasTot)} ETH  ($${(Number(formatEther(gasTot))*1927.27).toFixed(4)})`);
console.log(`  TOTAL COST    : ${(-Number(netIncl)/Number(amt)*10000).toFixed(1)} bps of position`);
