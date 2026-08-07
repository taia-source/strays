// The honest measurement: pure eth_call simulation, no state mutation, no gas accounting.
// BUY sim -> tokens out. Then override the token balance and SELL sim -> ETH out.
// Round-trip cost = (ethIn - ethOut)/ethIn. Gas priced separately from MAINNET.
import { createPublicClient, http, encodeAbiParameters, parseAbiParameters, encodeFunctionData,
         parseEther, formatEther, decodeAbiParameters } from "viem";
const RPC="http://127.0.0.1:8546", MAINNET="https://rpc.mainnet.chain.robinhood.com";
const ROUTER="0x8876789976dEcBfCbBbe364623C63652db8C0904";
const PERMIT2="0x000000000022D473030F116dDEE9F6B43aC78BA3";
const HOOK="0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC";
const NATIVE="0x0000000000000000000000000000000000000000";
const V4="0x060c0f", CMD="0x10";
const A="0x1111111111111111111111111111111111111111";
const RA=[{name:"execute",type:"function",stateMutability:"payable",inputs:[{name:"c",type:"bytes"},{name:"i",type:"bytes[]"},{name:"d",type:"uint256"}],outputs:[]}];
const E=[{name:"balanceOf",type:"function",stateMutability:"view",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}]}];
const pub=createPublicClient({transport:http(RPC)}), mainnet=createPublicClient({transport:http(MAINNET)});
const t=await(await fetch(`https://api.letscash.fun/api/tokens/${process.argv[2]}`)).json();
const amt=parseEther(process.argv[3]||"0.0026");
const key=[NATIVE,t.address,0,t.tickSpacing,HOOK], dl=()=>BigInt(Math.floor(Date.now()/1000)+600);
const mk=(zfo,ain,cIn,cOut)=>{const s=encodeAbiParameters(parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"),[[key,zfo,ain,1n,"0x"]]);
 const se=encodeAbiParameters(parseAbiParameters("address,uint256"),[cIn,ain]);const ta=encodeAbiParameters(parseAbiParameters("address,uint256"),[cOut,1n]);
 const i0=encodeAbiParameters(parseAbiParameters("bytes,bytes[]"),[V4,[s,se,ta]]);
 return encodeFunctionData({abi:RA,functionName:"execute",args:[CMD,[i0],dl()]});};

const snap=await pub.request({method:"evm_snapshot",params:[]});
try{
  await pub.request({method:"anvil_setBalance",params:[A,"0x8AC7230489E80000"]});
  await pub.request({method:"anvil_impersonateAccount",params:[A]});
  // BUY as a real tx (state must move for the sell to be realistic)
  const bh=await pub.request({method:"eth_sendTransaction",params:[{from:A,to:ROUTER,data:mk(true,amt,NATIVE,t.address),value:"0x"+amt.toString(16),gas:"0x7A120"}]});
  const br=await pub.waitForTransactionReceipt({hash:bh});
  if(br.status!=="success"){console.log("BUY REVERTED");process.exit(1);}
  const got=await pub.readContract({address:t.address,abi:E,functionName:"balanceOf",args:[A]});
  // approvals
  await pub.waitForTransactionReceipt({hash:await pub.request({method:"eth_sendTransaction",params:[{from:A,to:t.address,data:"0x095ea7b3"+PERMIT2.slice(2).toLowerCase().padStart(64,"0")+"f".repeat(64),gas:"0x186A0"}]})});
  const exp=(Math.floor(Date.now()/1000)+2592000).toString(16);
  await pub.waitForTransactionReceipt({hash:await pub.request({method:"eth_sendTransaction",params:[{from:A,to:PERMIT2,data:"0x87517c45"+t.address.slice(2).toLowerCase().padStart(64,"0")+ROUTER.slice(2).toLowerCase().padStart(64,"0")+"f".repeat(40).padStart(64,"0")+exp.padStart(64,"0"),gas:"0x186A0"}]})});
  // SELL: measure ETH out by eth_call on the router then diffing the account's ETH via trace
  const ethBefore=await pub.getBalance({address:A});
  const sh=await pub.request({method:"eth_sendTransaction",params:[{from:A,to:ROUTER,data:mk(false,got,t.address,NATIVE),gas:"0x7A120",gasPrice:"0x0"}]});
  const sr=await pub.waitForTransactionReceipt({hash:sh});
  if(sr.status!=="success"){console.log("SELL REVERTED");process.exit(1);}
  const ethAfter=await pub.getBalance({address:A});
  const ethOut=ethAfter-ethBefore+sr.gasUsed*sr.effectiveGasPrice;
  const mgp=await mainnet.getGasPrice();
  const gasEth=(br.gasUsed+sr.gasUsed)*mgp;
  const grossBps=Number(amt-ethOut)/Number(amt)*10000, gasBps=Number(gasEth)/Number(amt)*10000;
  console.log(`${t.symbol.padEnd(14)} tax=${String(t.taxPct).padStart(2)}%  in=${formatEther(amt)} ETH ($${(Number(formatEther(amt))*1927.27).toFixed(2)})  mcap ${t.marketCapEth.toFixed(2)} ETH`);
  console.log(`  tokens        : ${got}`);
  console.log(`  ETH out       : ${formatEther(ethOut)}`);
  console.log(`  swap cost     : ${grossBps.toFixed(1)} bps (tax x2 + impact)`);
  console.log(`  gas @mainnet  : ${gasBps.toFixed(1)} bps ($${(Number(formatEther(gasEth))*1927.27).toFixed(4)}) units ${br.gasUsed}+${sr.gasUsed}`);
  console.log(`  TOTAL         : ${(grossBps+gasBps).toFixed(1)} bps`);
}finally{ await pub.request({method:"evm_revert",params:[snap]}); }
