'use strict';
// Offline benchmark: accepts sanitized completion attributes only. No network,
// database, prompts, account records or provider calls. Costs are estimates at
// the configured staff-pilot billing rates, not actual provider invoices.
const fs=require('node:fs');
const valid=(n)=>Number.isSafeInteger(n)&&n>=0;
const intents=new Set(['STRUCTURE','QUOTE','FVG','BOS','MARKET_OVERVIEW','LIQUIDITY','SETUP','ACCOUNT_RISK','SIZING','CALENDAR','SESSION','EDUCATION','FOLLOW_UP','FULL']);
function summarize(rows){
  if(!Array.isArray(rows))throw Error('Expected array of sanitized completion records');
  const groups=new Map();
  for(const r of rows){
    if(!r||r.aiOutcome!=='ANSWERED'||!valid(r.aiInputTokens)||!valid(r.aiOutputTokens))continue;
    const intent=intents.has(r.aiIntent)?r.aiIntent:'UNCLASSIFIED';
    for(const name of ['ALL',intent]){
      if(!groups.has(name))groups.set(name,[]);
      groups.get(name).push(r);
    }
  }
  const stats=values=>{
    const v=values.filter(valid).sort((a,b)=>a-b);
    if(!v.length)return null;
    const quantile=p=>v[Math.max(0,Math.ceil(p*v.length)-1)];
    return {n:v.length,mean:v.reduce((a,b)=>a+b,0)/v.length,p50:quantile(.5),p95:quantile(.95)};
  };
  return Object.fromEntries([...groups].map(([name,v])=>[name,{
    successfulRequests:v.length,inputTokens:stats(v.map(r=>r.aiInputTokens)),outputTokens:stats(v.map(r=>r.aiOutputTokens)),
    durationMs:stats(v.map(r=>r.aiDurationMs)),firstDeltaMs:stats(v.filter(r=>r.aiStreamRequested===true&&valid(r.aiDeltaCount)&&r.aiDeltaCount>0).map(r=>r.aiFirstDeltaMs)),
    streamedResponses:v.filter(r=>r.aiStreamRequested===true&&valid(r.aiDeltaCount)&&r.aiDeltaCount>0).length,
    accountUsedCount:v.filter(r=>r.aiAccountUsed===true).length,accountUsageKnownCount:v.filter(r=>typeof r.aiAccountUsed==='boolean').length,
    estimatedMeanCostUsd:v.reduce((a,r)=>a+r.aiInputTokens*100000+r.aiOutputTokens*500000,0)/v.length/1e12
  }]));
}
if(require.main===module){
  try{
    if(process.argv.length!==3)throw Error('Usage: node scripts/ai-workspace-benchmark.js sanitized-completions.json');
    const rows=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    console.log(JSON.stringify({costBasis:'CONFIGURED_PILOT_RATES_NOT_PROVIDER_INVOICE',groups:summarize(rows)},null,2));
  }catch(e){console.error('Benchmark failed: '+e.message);process.exitCode=1;}
}
module.exports={summarize};
