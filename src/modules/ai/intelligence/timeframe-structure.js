'use strict';
const {TIMEFRAME_MS}=require('../../market-data/market.constants');
const {digest,freeze}=require('./candle-evidence');
const METHOD='cross-timeframe-structure-v1';
// Internal output from the trusted assembler only. Never accept model claims
// as structure reports; labels below are descriptive, not probabilities.
function summarizeTimeframeStructure({symbol,asOfMs,series}={}){
  if(typeof symbol!=='string'||!Number.isSafeInteger(asOfMs)||!Array.isArray(series)||
    series.length<1||series.length>3||new Set(series.map(s=>s.timeframe)).size!==series.length)
    throw Error('Invalid timeframe structure input');
  const frames=series.map(s=>{
    const x=s.structure;
    if(!Object.hasOwn(TIMEFRAME_MS,s.timeframe))throw Error('Invalid timeframe');
    const matched=x&&x.symbol===symbol&&x.timeframe===s.timeframe&&x.asOfMs===asOfMs&&
      x.evidenceId===s.analysis?.evidence?.evidenceId;
    const qualified=matched&&x.status==='OBSERVED_STRUCTURE'&&x.quality.status==='RECENT_CLOSED_BAR'&&
      s.coverage?.status==='MATCHES_CONFIGURED_CALENDAR'&&['BULLISH','BEARISH'].includes(x.bias);
    return {timeframe:s.timeframe,structureId:matched?x.structureId:null,
      bias:qualified?x.bias:'UNQUALIFIED',latestClosedAtMs:matched?x.latestClosedAtMs:null,
      reason:qualified?null:'INSUFFICIENT_STALE_OR_UNQUALIFIED_STRUCTURE'};
  }).sort((a,b)=>TIMEFRAME_MS[b.timeframe]-TIMEFRAME_MS[a.timeframe]);
  const qualified=frames.filter(f=>f.bias!=='UNQUALIFIED');
  const alignment=frames.length<2||qualified.length!==frames.length?'INSUFFICIENT_QUALIFIED_FRAMES':
    new Set(qualified.map(f=>f.bias)).size!==1?'MIXED_STRUCTURE':qualified[0].bias==='BULLISH'?'ALIGNED_BULLISH_BREAK_HISTORY':'ALIGNED_BEARISH_BREAK_HISTORY';
  const report={methodVersion:METHOD,symbol,asOfMs,frames,alignment,
    limitations:['BREAK_HISTORY_NOT_TREND_PREDICTION','CONFIGURED_CALENDAR_ONLY','NO_INDEPENDENT_PROVIDER_IDENTITY_PROOF','NO_EXECUTION_AUTHORITY']};
  return freeze({...report,comparisonId:digest(report)});
}
module.exports={summarizeTimeframeStructure,METHOD};
