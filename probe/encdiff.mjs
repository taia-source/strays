// Diff the CONTRACT's encoding against viem's — the same viem encoding that produced a swap
// which landed on mainnet. openhood's recorded failure: a hand-rolled encoder was silently wrong
// because ExactInputSingleParams contains a `bytes` member making the struct DYNAMIC.
import { encodeAbiParameters, parseAbiParameters, parseEther } from "viem";
const NATIVE="0x0000000000000000000000000000000000000000";
const HOOK="0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC";
const TOKEN="0x8Cbab44d14554bc86b272220DBe7Dd95F91D4ccc";
const V4="0x060c0f";
const amt=parseEther("0.0026"), minOut=1n, ts=200;

const swap=encodeAbiParameters(parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"),
  [[[NATIVE,TOKEN,0,ts,HOOK],true,amt,minOut,"0x"]]);
const settle=encodeAbiParameters(parseAbiParameters("address,uint256"),[NATIVE,amt]);
const take=encodeAbiParameters(parseAbiParameters("address,uint256"),[TOKEN,minOut]);
const viemInput=encodeAbiParameters(parseAbiParameters("bytes,bytes[]"),[V4,[swap,settle,take]]);

const sol=process.argv[2];
console.log("viem len:",viemInput.length,"  sol len:",sol.length);
if(viemInput.toLowerCase()===sol.toLowerCase()){ console.log("\n*** BYTE-FOR-BYTE MATCH ***"); process.exit(0); }
console.log("\n!!! MISMATCH !!!");
const a=viemInput.slice(2), b=sol.slice(2);
for(let i=0;i<Math.max(a.length,b.length);i+=64){
  const wa=a.slice(i,i+64), wb=b.slice(i,i+64);
  const mark = wa===wb ? "    " : " >> ";
  console.log(`${mark}[${String(i/64).padStart(2)}] viem ${wa}`);
  if(wa!==wb) console.log(`     [${String(i/64).padStart(2)}] sol  ${wb}`);
}
