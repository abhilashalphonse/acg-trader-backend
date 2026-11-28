'use strict';
// Offline report accepts only sanitized audit attributes and provider totals.
// Byte shares are exact for final serialized message content. Token shares
// are a byte-weighted allocation of aggregate provider usage, not tokenizer
// measurements; punctuation/numbers/Unicode can have different densities.
const fs=require('node:fs');
const {fields}=require('../src/modules/ai/intelligence/workspace-prompt-audit');
const valid=n=>Number.isSafeInteger(n)&&n>=0;
function summarizePromptAudit(rows){
  if(!Array.isArray(rows))throw Error('Expected sanitized completion records');
  const groups=new Map();
  let missing=0;
  for(const row of rows){
    if(!row||row.aiOutcome!=='ANSWERED'||!valid(row.aiInputTokens))continue;
    if(row.aiPromptAuditVersion!==1||!valid(row.aiPromptContentBytes)||row.aiPromptContentBytes===0||
       !fields.every(f=>valid(row['aiPrompt'+f+'Bytes']))||
       fields.reduce((n,f)=>n+row['aiPrompt'+f+'Bytes'],0)!==row.aiPromptContentBytes){missing++;continue;}
    const profile=['STRUCTURE','MARKET_OVERVIEW','BOS','FVG','LIQUIDITY','QUOTE','SESSION','CALENDAR','FULL'].includes(row.aiPromptProfile)?row.aiPromptProfile:'UNCLASSIFIED';
    for(const key of ['ALL',profile]){
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(row);
    }
  }
  return {missingAuditSamples:missing,groups:Object.fromEntries([...groups].map(([profile,rows])=>{
    const totalBytes=rows.reduce((n,r)=>n+r.aiPromptContentBytes,0);
    const tokens=rows.reduce((n,r)=>n+r.aiInputTokens,0);
    return [profile,{samples:rows.length,meanProviderInputTokens:tokens/rows.length,meanContentBytes:totalBytes/rows.length,
      categories:Object.fromEntries(fields.map(f=>{
        const key='aiPrompt'+f+'Bytes',sum=rows.reduce((n,r)=>n+r[key],0);
        return [f,{meanBytes:sum/rows.length,contentByteShare:sum/totalBytes,
          meanByteWeightedTokenProxy:rows.reduce((n,r)=>n+r.aiInputTokens*r[key]/r.aiPromptContentBytes,0)/rows.length}];
      }))}];
  }))};
}
if(require.main===module){
  try{
    if(process.argv.length!==3)throw Error('Usage: node scripts/ai-workspace-prompt-audit.js sanitized-completions.json');
    const rows=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    console.log(JSON.stringify({method:'EXACT_MESSAGE_CONTENT_BYTES; BYTE_WEIGHTED_TOKEN_PROXY_NOT_TOKENIZER_COUNTS; PROVIDER_FRAMING_NOT_SEPARATELY_ATTRIBUTABLE',...summarizePromptAudit(rows)},null,2));
  }catch{console.error('Invalid prompt audit input');process.exitCode=1;}
}
module.exports={summarizePromptAudit};
