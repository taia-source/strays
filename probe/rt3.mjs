// Round trip measured from ETH RECEIVED vs ETH SPENT via eth_call simulation only.
// Immune to balance bookkeeping and to anvil's wrong gas price. Gas is priced from MAINNET.
import { createPublicClient, http, encodeAbiParameters, parseAbiParameters,
         encodeFunctionData, parseEther, formatEther, decodeEventLog } from "viem";
const RPC="http://127.0.0.1:8546", MAINNET="https://rpc.mainnet.chain.robinhood.com";
const ROUTER="0x8876789976dEcBfCbBbe364623C63652db8C0904";
const PERMIT2="0x000000000022D473030F116dDEE9F6B43aC78BA3";
const HOOK="0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC";
const NATIVE="0x0000000000000000000000000000000000000000";
const V4="0x060c0f", CMD="0x10";
const A="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // fresh anvil acct #1
const RA=[{name:"execute",type:"function",stateMutability:"payable",inputs:[{name:"c",type:"bytes"},{name:"i",type:"bytes[]"},{name:"d",type:"uint256"}],outputs:[]}];
const E=[{name:"balanceOf",type:"function",stateMutability:"view",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}]}];
const pub=createPublicClient({transport:http(RPC)});
const mainnet=createPublicClient({transport:http(MAINNET)});
const t=await(await fetch(`https://api.letscash.fun/api/tokens/${process.argv[2]}`)).json();
const amt=parseEther(process.argv[3]||"0.0026");
const key=[NATIVE,t.address,0,t.tickSpacing,HOOK], dl=()=>BigInt(Math.floor(Date.now()/1000)+600);
const mk=(zfo,ain,cIn,cOut)=>{const s=encodeAbiParameters(parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"),[[key,zfo,ain,1n,"0x"]]);
 const se=encodeAbiParameters(parseAbiParameters("address,uint256"),[cIn,ain]);const ta=encodeAbiParameters(parseAbiParameters("address,uint256"),[cOut,1n]);
 const i0=encodeAbiParameters(parseAbiParameters("bytes,bytes[]"),[V4,[s,se,ta]]);
 return encodeFunctionData({abi:RA,functionName:"execute",args:[CMD,[i0],dl()]});};

// snapshot so the fork is untouched afterwards
const snap=await pub.request({method:"evm_snapshot",params:[]});
await pub.request({method:"anvil_setBalance",params:[A,"0x8AC7230489E80000"]}); // 10 ETH
// BUY (real tx so state moves), then read tokens out
const wallet=(await import("viem")).createWalletClient({account:A,transport:http(RPC)});
let h=await pub.request({method:"eth_sendTransaction",params:[{from:A,to:ROUTER,data:mk(true,amt,NATIVE,t.address),value:"0x"+amt.toString(16)}]});
let r=await pub.waitForTransactionReceipt({hash:h});
const got=await pub.readContract({address:t.address,abi:E,functionName:"balanceOf",args:[A]});
const buyGasUnits=r.gasUsed;
// approvals
await pub.waitForTransactionReceipt({hash:await pub.request({method:"eth_sendTransaction",params:[{from:A,to:t.address,data:"0x095ea7b3"+PERMIT2.slice(2).padStart(64,"0")+"f".repeat(64)}]})});
const p2data="0x87517c45"+t.address.slice(2).padStart(64,"0")+ROUTER.slice(2).padStart(64,"0")+"f".repeat(40).padStart(64,"0")+(Math.floor(Date.now()/1000)+2592000).toString(16).padStart(64,"0");
await pub.waitForTransactionReceipt({hash:await pub.request({method:"eth_sendTransaction",params:[{from:A,to:PERMIT2,data:p2data}]})});
// SELL and measure ETH received from the balance change across JUST the sell tx
const pre=await pub.getBalance({address:A});
h=await pub.request({method:"eth_sendTransaction",params:[{from:A,to:ROUTER,data:mk(false,got,t.address,NATIVE)}]});
r=await pub.waitForTransactionReceipt({hash:h});
if(r.status!=="success"){console.log("SELL REVERTED");process.exit(1);}
const post=await pub.getBalance({address:A});
const ethBack=post-pre+r.gasUsed*r.effectiveGasPrice;
const sellGasUnits=r.gasUsed;
await pub.request({method:"evm_revert",params:[snap]});

const mgp=await mainnet.getGasPrice();
const gasEth=(buyGasUnits+sellGasUnits)*mgp;
const grossBps=Number(amt-ethBack)/Number(amt)*10000;
const gasBps=Number(gasEth)/Number(amt)*10000;
console.log(`${t.symbol.padEnd(14)} tax=${String(t.taxPct).padStart(2)}%  in=${formatEther(amt)} ETH ($${(Number(formatEther(amt))*1927.27).toFixed(2)})`);
console.log(`  ETH back      : ${formatEther(ethBack)}`);
console.log(`  gross cost    : ${grossBps.toFixed(1)} bps  (tax+impact, both legs)`);
console.log(`  gas units     : ${buyGasUnits}+${sellGasUnits}  @ mainnet ${(Number(mgp)/1e9).toFixed(5)} gwei = ${gasBps.toFixed(1)} bps ($${(Number(formatEther(gasEth))*1927.27).toFixed(4)})`);
console.log(`  TOTAL         : ${(grossBps+gasBps).toFixed(1)} bps of position`);
