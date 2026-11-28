'use strict';
// Conservative, deterministic routing for standalone, explicitly phrased
// questions. Unknown, multilingual, compound and conversational follow-ups
// retain full context. A client cannot select or expand a server profile.
const patterns={
  STRUCTURE:/^(?:analyse|analyze|review|describe|summari[sz]e) (?:the )?(?:current )?(?:[a-z0-9._/-]+ )?market structure[?.!]?$/i,
  QUOTE:/^(?:what(?: is|'s) (?:the )?(?:current |live )?(?:price|bid|ask|spread)(?: (?:of|for) [a-z0-9._/-]+)?|(?:show|give) (?:me )?(?:the )?(?:current |live )?(?:price|bid|ask|spread)(?: (?:of|for) [a-z0-9._/-]+)?)[?.!]?$/i,
  FVG:/^(?:show|find|identify|analyse|analyze|list) (?:me )?(?:the )?(?:current |recent )?(?:fvgs?|fair value gaps)(?: (?:on|in|for) (?:the )?[a-z0-9._/-]+(?: chart)?)?[?.!]?$/i,
  BOS:/^(?:show|find|identify|analyse|analyze|list) (?:me )?(?:the )?(?:current |recent |latest )?(?:bos|breaks? of structure)(?: (?:on|in|for) (?:the )?[a-z0-9._/-]+(?: chart)?)?[?.!]?$/i
};
const sizing=/\b(?:lot size|position siz(?:e|ing)|margin required|required margin|how many lots)\b/i;
const multi=/\b(?:and|also|but|then|compare|versus|vs|account|balance|equity|position|order|risk|margin|calendar|news|entry|stop|target|detailed|comprehensive|all|every)\b/i;
function classifyWorkspaceQuestion(question,history=[]){
  if(typeof question!=='string'||!Array.isArray(history)||history.length)return 'FULL';
  const q=question.trim().replace(/\s+/g,' ');
  // Any ambiguous or compound request fails open to the already authorized
  // full snapshot, never to broader permissions or another instrument.
  if(multi.test(q)||sizing.test(q))return 'FULL';
  for(const [profile,pattern] of Object.entries(patterns))if(pattern.test(q))return profile;
  return 'FULL';
}
const knowledgeIds={
  STRUCTURE:['EVIDENCE_QUALITY','RISK_BOUNDARY','MARKET_STRUCTURE','MULTI_TIMEFRAME','LIQUIDITY','FVG'],
  BOS:['EVIDENCE_QUALITY','RISK_BOUNDARY','MARKET_STRUCTURE','MULTI_TIMEFRAME','LIQUIDITY'],
  FVG:['EVIDENCE_QUALITY','RISK_BOUNDARY','MARKET_STRUCTURE','FVG','MULTI_TIMEFRAME'],
  QUOTE:['EVIDENCE_QUALITY','RISK_BOUNDARY']
};
function selectWorkspaceEvidence(data,profile){
  if(profile==='FULL'||!data.market||data.market.schemaVersion!=='adaptive-market-v1')return;
  const market=data.market;
  // Input has already been cloned by the request builder. Derived summaries,
  // price precision, quote, active bars, coverage and calendar are not altered.
  const primary=market.selectedTimeframe;
  const cap=profile==='QUOTE'?[1,0]:[48,16];
  const types=profile==='FVG'?new Set(['STRUCTURE_SUMMARY','FVG_ZONE','STRUCTURE_EVENT']):
    profile==='BOS'?new Set(['STRUCTURE_SUMMARY','STRUCTURE_EVENT','LIQUIDITY_REFERENCE','EQUAL_LEVEL']):
    profile==='STRUCTURE'?new Set(['STRUCTURE_SUMMARY','STRUCTURE_EVENT','FVG_ZONE','LIQUIDITY_REFERENCE','EQUAL_LEVEL']):new Set();
  const priceFacts=new Set(['LAST_CLOSED_PRICE','OBSERVED_RANGE_HIGH','OBSERVED_RANGE_LOW']);
  for(const frame of market.frames){
    const selected=frame.timeframe===primary,limit=cap[selected?0:1];
    if(Array.isArray(frame.closedCandles)&&frame.closedCandles.length>limit){
      const count=frame.closedCandles.length-limit;
      frame.closedCandles.splice(0,count);
      frame.omittedClosedBars=(frame.omittedClosedBars??0)+count;
    }
    if(Array.isArray(frame.observations)){
      const before=frame.observations.length;
      frame.observations=frame.observations.filter(o=>o.type==='FACT'&&priceFacts.has(o.kind)||types.has(o.type));
      frame.omittedObservations=(frame.omittedObservations??0)+before-frame.observations.length;
    }
    if(profile==='QUOTE'&&frame.advanced){
      // Historical fallback retains summaries, not duplicated detailed patterns.
      const {methodVersion,throughMs,source,bars,referencePrice,regime,dealingRange}=frame.advanced;
      frame.advanced={methodVersion,throughMs,source,bars,referencePrice,regime,dealingRange,detailsOmitted:true};
    }
  }
  market.contextSelection={profile,scope:'QUESTION_FOCUSED_PROJECTION',omittedEvidenceIsNotAbsent:true};
  data.knowledge=data.knowledge.filter(k=>knowledgeIds[profile].includes(k.id));
}
module.exports={classifyWorkspaceQuestion,selectWorkspaceEvidence};
