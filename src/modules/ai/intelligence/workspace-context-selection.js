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
// Phase 6A: separate semantic intent from evidence projection. New intents
// are observed in bounded internal telemetry first; they do not silently
// restrict account, history, market or calendar data before acceptance.
const intentPatterns=Object.freeze({
  MARKET_OVERVIEW:/^(?:(?:what(?: is|'s) happening (?:with|in) (?:the )?(?:market|markets|chart|gold|silver|bitcoin|ethereum|oil|forex|crypto|natural gas|wti oil|brent oil))|(?:(?:analyse|analyze|review|summari[sz]e) (?:the )?(?:current )?(?:market|chart)))[?.!]?$/i,
  LIQUIDITY:/^(?:show|find|identify|list|analyse|analyze) (?:me )?(?:the )?(?:recent |current |potential )?liquidity(?: (?:levels|sweeps|zones|references))?(?: (?:on|for) [a-z0-9._/-]+)?[?.!]?$/i,
  SETUP:/^(?:are there any (?:trading |long |short )?setups|(?:can|should) i (?:enter|buy|sell|go long|go short)(?: (?:a long|a short|here|now|here now))?(?: here| now)?|(?:show|find|identify) (?:me )?(?:the )?(?:potential |current )?(?:trading |long |short )?setups)[?.!]?$/i,
  ACCOUNT_RISK:/^(?:how much risk am i taking|(?:review|analyse|analyze|show) (?:me )?my (?:account|account risk|risk|exposure|positions|balance|equity)|what is my (?:balance|equity|free margin|exposure|account risk))[?.!]?$/i,
  SIZING:/^(?:(?:calculate|compute|show) (?:me )?(?:the |my )?(?:position size|lot size|required margin)|how many lots)[?.!]?$/i,
  CALENDAR:/^(?:what (?:economic )?(?:news|events) (?:are |is )?(?:coming up|today|next)|(?:show|list|check) (?:me )?(?:the )?(?:economic calendar|upcoming economic events|upcoming news))[?.!]?$/i,
  SESSION:/^(?:which (?:trading |market )?session is (?:open|active)|(?:when does|what time does) (?:the )?(?:london|new york|tokyo|asian) session (?:open|close)|(?:show|describe) (?:the )?(?:current )?(?:trading |market )?session)[?.!]?$/i,
  EDUCATION:/^(?:what (?:is|are)|explain|define) (?:the )?(?:bos|mss|fvg|fair value gaps?|break of structure|market structure|liquidity|support and resistance|risk reward|position sizing)[?.!]?$/i
});
// Classify the latest explicit question independently from the presence of
// history. A genuine anaphoric or ambiguous turn remains FOLLOW_UP/FULL.
function classifyWorkspaceIntent(question,history=[]){
  if(typeof question!=='string'||!Array.isArray(history))return 'FULL';
  const q=question.trim().replace(/\s+/g,' ');
  if(!q)return 'FULL';
  const existing=classifyWorkspaceQuestion(q,[]);
  if(existing!=='FULL')return existing;
  for(const [intent,pattern] of Object.entries(intentPatterns))if(pattern.test(q))return intent;
  return history.length?'FOLLOW_UP':'FULL';
}
const focusedProfiles=new Set(['STRUCTURE','MARKET_OVERVIEW','BOS','FVG','LIQUIDITY','QUOTE','SESSION','CALENDAR']);
function marketOnlyHistory(history){
  if(!Array.isArray(history))return false;
  if(history.length===0)return true;
  // Require an intact sequence of self-contained chart questions and replies.
  // Unknown prior goals (including account analysis and strategy constraints)
  // keep full scope. Do not infer permission from the assistant's text.
  if(history.length%2!==0)return false;
  for(let i=0;i<history.length;i+=2){
    if(history[i]?.role!=='user'||history[i+1]?.role!=='assistant'||
      !focusedProfiles.has(classifyWorkspaceIntent(history[i].text,[])))return false;
  }
  return true;
}
function workspaceEvidenceProfile(question,history,market){
  if(!marketOnlyHistory(history))return 'FULL';
  const intent=classifyWorkspaceIntent(question,history);
  if(market?.schemaVersion!=='adaptive-market-v1')return 'FULL';
  return focusedProfiles.has(intent)?intent:'FULL';
}
const knowledgeIds={
  STRUCTURE:['EVIDENCE_QUALITY','RISK_BOUNDARY','MARKET_STRUCTURE','MULTI_TIMEFRAME','LIQUIDITY','FVG'],
  BOS:['EVIDENCE_QUALITY','RISK_BOUNDARY','MARKET_STRUCTURE','MULTI_TIMEFRAME','LIQUIDITY'],
  FVG:['EVIDENCE_QUALITY','RISK_BOUNDARY','MARKET_STRUCTURE','FVG','MULTI_TIMEFRAME'],
  MARKET_OVERVIEW:['EVIDENCE_QUALITY','RISK_BOUNDARY','MARKET_STRUCTURE','MULTI_TIMEFRAME','LIQUIDITY','FVG','INDICATORS'],
  LIQUIDITY:['EVIDENCE_QUALITY','RISK_BOUNDARY','MARKET_STRUCTURE','MULTI_TIMEFRAME','LIQUIDITY'],
  SESSION:['EVIDENCE_QUALITY','RISK_BOUNDARY','SESSION_RANGE','MARKET_STRUCTURE'],
  CALENDAR:['EVIDENCE_QUALITY','RISK_BOUNDARY','SESSION_RANGE'],
  QUOTE:['EVIDENCE_QUALITY','RISK_BOUNDARY']
};
function selectWorkspaceEvidence(data,profile){
  if(!Object.hasOwn(knowledgeIds,profile)||!data.market||data.market.schemaVersion!=='adaptive-market-v1')return;
  const market=data.market;
  // Input has already been cloned by the request builder. Derived summaries,
  // price precision, quote, active bars, coverage and calendar are not altered.
  const primary=market.selectedTimeframe;
  const cap=['QUOTE','CALENDAR'].includes(profile)?[1,0]:profile==='SESSION'?[8,4]:[48,16];
  const types=profile==='FVG'?new Set(['STRUCTURE_SUMMARY','FVG_ZONE','STRUCTURE_EVENT']):
    ['BOS','LIQUIDITY'].includes(profile)?new Set(['STRUCTURE_SUMMARY','STRUCTURE_EVENT','LIQUIDITY_REFERENCE','EQUAL_LEVEL']):
    ['STRUCTURE','MARKET_OVERVIEW'].includes(profile)?new Set(['STRUCTURE_SUMMARY','STRUCTURE_EVENT','FVG_ZONE','LIQUIDITY_REFERENCE','EQUAL_LEVEL']):new Set();
  const priceFacts=new Set(['LAST_CLOSED_PRICE','OBSERVED_RANGE_HIGH','OBSERVED_RANGE_LOW']);
  if(profile==='MARKET_OVERVIEW'){priceFacts.add('SMA_20');priceFacts.add('MEAN_TRUE_RANGE_14');}
  if(profile==='SESSION')types.add('SESSION_RANGE');
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
    if(['QUOTE','CALENDAR','SESSION'].includes(profile)&&frame.advanced){
      // Historical fallback retains summaries, not duplicated detailed patterns.
      const {methodVersion,throughMs,source,bars,referencePrice,regime,dealingRange}=frame.advanced;
      frame.advanced={methodVersion,throughMs,source,bars,referencePrice,regime,dealingRange,detailsOmitted:true};
    }
  }
  market.contextSelection={profile,scope:'QUESTION_FOCUSED_PROJECTION',omittedEvidenceIsNotAbsent:true};
  data.knowledge=data.knowledge.filter(k=>knowledgeIds[profile].includes(k.id));
}
// 6C: keep recent raw context for the primary/lower frame and use a
// smaller exact tail for healthy higher frames with derived full-window
// evidence. This is a projection, never a resampling or price approximation.
const frameRank=['1m','5m','15m','30m','1h','4h','1d','1w'];
const compressionProfiles=new Set(['STRUCTURE','MARKET_OVERVIEW','BOS','FVG','LIQUIDITY']);
function compressSupportingFrames(market){
  if(market?.schemaVersion!=='adaptive-market-v1'||!compressionProfiles.has(market.contextSelection?.profile)||!Array.isArray(market.frames))return;
  const primary=frameRank.indexOf(market.selectedTimeframe);
  if(primary<0)return;
  for(const frame of market.frames){
    const higher=frameRank.indexOf(frame.timeframe)>primary;
    const bars=frame.closedCandles,q=frame.quality,a=frame.advanced;
    // Preserve existing evidence on stale, incomplete, gapped or ambiguous
    // snapshots. Do not shorten the lower confirmation timeframe.
    if(!higher||frame.status!=='HISTORICAL_ONLY'||q?.status!=='RECENT_CLOSED_BAR'||
      q.gaps!==0||q.exclusions?.synthetic!==0||!Number.isSafeInteger(q.contiguousCount)||q.contiguousCount<20||
      frame.freshness?.state!=='LATEST_EXPECTED_UTC_BUCKET'||
      frame.coverage?.outOfSessionBars!==0||!a?.regime||!a?.dealingRange||
      !Array.isArray(bars)||bars.length<=8||!Number.isSafeInteger(frame.availableClosedBars)||
      frame.availableClosedBars<bars.length)continue;
    const priorCount=bars.length;
    frame.closedCandles=bars.slice(-8);
    frame.omittedClosedBars=frame.availableClosedBars-frame.closedCandles.length;
    frame.rawHistoryProjection={mode:'HIGHER_FRAME_SUMMARY_WITH_EXACT_TAIL',omittedAdditionalBars:priorCount-8,
      derivedEvidenceUsesOriginalWindow:true};
  }
}
// Data minimization at the provider boundary. Account permission is not a
// requirement to export every financial record. Only narrow standalone chart
// requests with available market context qualify; never expand the requested
// scope or omit account data for setups, sizing, exposure or follow-ups.
function selectWorkspaceAccount(data,profile,originalHistory=data.history){
  if(data.account&&data.market?.schemaVersion==='adaptive-market-v1'&&
    Array.isArray(data.market.frames)&&data.market.frames.length>0&&
    !data.market.sizingCalculation&&marketOnlyHistory(originalHistory)&&
    focusedProfiles.has(profile))data.account=null;
}
// Provider-only aliases preserve every reference relationship while avoiding
// repeated opaque 64-character SHA-256 IDs. Do not touch trusted snapshots,
// price fields, timestamps, method versions, or arbitrary user text.
function aliasFocusedReferenceIds(market){
  if(!focusedProfiles.has(market?.contextSelection?.profile)||!Array.isArray(market.frames))return;
  const aliases=new Map();
  const fields=['id','referenceId','firstReferenceId','secondReferenceId'];
  for(const frame of market.frames){
    for(const o of frame.observations??[]){
      if(!['LIQUIDITY_REFERENCE','EQUAL_LEVEL','STRUCTURE_EVENT','FVG_ZONE'].includes(o.type))continue;
      for(const key of fields){
        const value=o[key];
        if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))continue;
        if(!aliases.has(value))aliases.set(value,'ref'+(aliases.size+1));
        o[key]=aliases.get(value);
      }
    }
  }
}
module.exports={classifyWorkspaceQuestion,classifyWorkspaceIntent,workspaceEvidenceProfile,selectWorkspaceEvidence,compressSupportingFrames,selectWorkspaceAccount,aliasFocusedReferenceIds};
