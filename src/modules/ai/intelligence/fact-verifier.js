'use strict';
const {analyzeMarketCandles}=require('./market-facts');
// Claims must be exact references to recomputed facts. The server owns input.
// This verifies structured numeric claims, not arbitrary prose or forecasts.
function verifyMarketClaims(input,claims){
  const analysis=analyzeMarketCandles(input);
  if(!Array.isArray(claims)||claims.length<1||claims.length>32)return {verified:false,code:'INVALID_CLAIMS'};
  const allowed=new Map(analysis.facts.map(f=>[f.factId,f]));
  const seen=new Set(),verified=[];
  for(const claim of claims){
    if(!claim||typeof claim!=='object'||Object.getPrototypeOf(claim)!==Object.prototype||
       Object.keys(claim).length!==4||!['evidenceId','factId','kind','value'].every(k=>Object.hasOwn(claim,k))||
       claim.evidenceId!==analysis.evidence.evidenceId||typeof claim.factId!=='string'||seen.has(claim.factId))
      return {verified:false,code:'INVALID_FACT_REFERENCE'};
    const fact=allowed.get(claim.factId);
    if(!fact||claim.kind!==fact.kind||claim.value!==fact.value)return {verified:false,code:'FACT_MISMATCH'};
    seen.add(claim.factId);verified.push(fact);
  }
  return {verified:true,evidenceId:analysis.evidence.evidenceId,quality:analysis.evidence.quality,
    analysisScope:analysis.analysisScope,limitations:analysis.limitations,facts:verified};
}
module.exports={verifyMarketClaims};
