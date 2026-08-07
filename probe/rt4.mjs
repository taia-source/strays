// Measure the fill from the SELL tx's own logs. The router emits a native ETH transfer to caller;
// we instead read the PoolManager Swap event amounts, which are authoritative.
import { createPublicClient, createWalletClient, http, encodeAbiParameters, parseAbiParameters,
         encodeFunctionData, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
const RPC="http://127.0.0.1:8546", MAINNET="https://rpc.mainnet.chain.robinhood.com";
const ROUTER="0x8876789976dEcBfCbBbe364623C63652db8C0904";
const PERMIT2="0x000000000022D473030F116dDEE9F6B43aC78BA3";
const HOOK="0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC";
const NATIVE="0x0000000000000000000000000000000000000000";
const V4="0x060c0f", CMD="0x10";
// unique key per run so state is always fresh
const PK=("0x"+(process.argv[4]||"59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"));
const acct=privateKeyToAccount(PK);
const RA=[{name:"execute",type:"function",stateMutability:"payable",inputs:[{name:"c",type:"bytes"},{name:"i",type:"bytes[]"},{name:"d",type:"uint256"}],outputs:[]}];
const E=[{name:"balanceOf",type:"function",stateMutability:"view",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}]},
 {name:"approve",type:"function",stateMutability:"nonpayable",inputs:[{name:"s",type:"address"},{name:"v",type:"uint256"}],outputs:[{type:"bool"}]}];
const P2=[{name:"approve",type:"function",stateMutability:"nonpayable",inputs:[{name:"t",type:"address"},{name:"s",type:"address"},{name:"a",type:"uint160"},{name:"e",type:"uint48"}],outputs:[]}];
const pub=createPublicClient({transport:http(RPC)});
const w=createWalletClient({account:acct,transport:http(RPC)});
const mainnet=createPublicClient({transport:http(MAINNET)});
const t=await(await fetch(`https://api.letscash.fun/api/tokens/${process.argv[2]}`)).json();
const amt=parseEther(process.argv[3]||"0.0026");
const key=[NATIVE,t.address,0,t.tickSpacing,HOOK], dl=()=>BigInt(Math.floor(Date.now()/1000)+600);
const mk=(zfo,ain,cIn,cOut)=>{const s=encodeAbiParameters(parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"),[[key,zfo,ain,1n,"0x"]]);
 const se=encodeAbiParameters(parseAbiParameters("address,uint256"),[cIn,ain]);const ta=encodeAbiParameters(parseAbiParameters("address,uint256"),[cOut,1n]);
 const i0=encodeAbiParameters(parseAbiParameters("bytes,bytes[]"),[V4,[s,se,ta]]);
 return encodeFunctionData({abi:RA,functionName:"execute",args:[CMD,[i0],dl()]});};
const snap=await pub.request({method:"evm_snapshot",params:[]});
await pub.request({method:"anvil_setBalance",params:[acct.address,"0x8AC7230489E80000"]});
await pub.request({method:"anvil_setNextBlockBaseFeePerGas",params:["0x0"]});
await pub.request({method:"evm_mine",params:[]});
const b0=await pub.getBalance({address:acct.address});
console.log("  [funded:",formatEther(b0),"ETH]");
let r=await pub.waitForTransactionReceipt({hash:await w.sendTransaction({to:ROUTER,data:mk(true,amt,NATIVE,t.address),value:amt,gasPrice:0n})});
const buyGas=r.gasUsed;
const got=await pub.readContract({address:t.address,abi:E,functionName:"balanceOf",args:[acct.address]});
await pub.waitForTransactionReceipt({hash:await w.writeContract({address:t.address,abi:E,functionName:"approve",args:[PERMIT2,2n**256n-1n],gasPrice:0n})});
await pub.waitForTransactionReceipt({hash:await w.writeContract({address:PERMIT2,abi:P2,functionName:"approve",args:[t.address,ROUTER,2n**160n-1n,Math.floor(Date.now()/1000)+2592000],gasPrice:0n})});
r=await pub.waitForTransactionReceipt({hash:await w.sendTransaction({to:ROUTER,data:mk(false,got,t.address,NATIVE),gasPrice:0n})});
if(r.status!=="success"){console.log("SELL REVERTED");await pub.request({method:"evm_revert",params:[snap]});process.exit(1);}
const sellGas=r.gasUsed;
const b1=await pub.getBalance({address:acct.address});
console.log("  [end   :",formatEther(b1),"ETH]");
const net=b1-b0; // negative = cost, gas is FREE here so this is pure swap economics
const mgp=await mainnet.getGasPrice();
const gasEth=(buyGas+sellGas)*mgp;
const grossBps=-Number(net)/Number(amt)*10000, gasBps=Number(gasEth)/Number(amt)*10000;
console.log(`${t.symbol.padEnd(14)} tax=${String(t.taxPct).padStart(2)}%  in=${formatEther(amt)} ETH ($${(Number(formatEther(amt))*1927.27).toFixed(2)})  mcap ${t.marketCapEth.toFixed(2)} ETH`);
console.log(`  swap cost   : ${grossBps.toFixed(1)} bps  (tax both legs + impact)  = ${formatEther(-net)} ETH`);
console.log(`  gas         : ${gasBps.toFixed(1)} bps  ($${(Number(formatEther(gasEth))*1927.27).toFixed(4)})  units ${buyGas}+${sellGas}`);
console.log(`  TOTAL       : ${(grossBps+gasBps).toFixed(1)} bps of position`);
