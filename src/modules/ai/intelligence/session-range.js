'use strict';
const {createCandleEvidence,digest,freeze}=require('./candle-evidence');
const {candleBucketOpenTimeMs}=require('../../market-data/market.constants');
const {normalizeDecimal}=require('../../../shared/decimal/decimal');
const METHOD='explicit-session-range-v1';
// Window boundaries are supplied by the trusted server. No hardcoded London,
// Asia or New York times: DST/venue/session definitions need separate approval.
function analyzeSessionRange(input,window){
  const e=createCandleEvidence(input);
  const {startMs,endMs}=window||{};
  if(!Number.isSafeInteger(startMs)||!Number.isSafeInteger(endMs)||startMs<0||endMs<=startMs||
    endMs-startMs>86400000||startMs>e.asOfMs||e.stepMs>=86400000||
    candleBucketOpenTimeMs(startMs,e.timeframe)!==startMs||candleBucketOpenTimeMs(endMs,e.timeframe)!==endMs||
    (endMs-startMs)/e.stepMs>256)throw Object.assign(Error('Invalid session window'),{code:'INVALID_SESSION_WINDOW'});
  const through=Math.min(endMs,candleBucketOpenTimeMs(e.asOfMs,e.timeframe));
  const bars=e.bars.filter(b=>b.openTimeMs>=startMs&&b.closeTimeMs<=through);
  const expected=Math.max(0,(through-startMs)/e.stepMs);
  const times=new Set(bars.map(b=>b.openTimeMs));
  let missing=0;
  for(let t=startMs;t<through;t+=e.stepMs)if(!times.has(t))missing++;
  const singleProvider=new Set(bars.map(b=>b.provider)).size===1;
  const range=bars.length?{open:normalizeDecimal(bars[0].open),high:normalizeDecimal(Math.max(...bars.map(b=>b.high))),
    low:normalizeDecimal(Math.min(...bars.map(b=>b.low))),lastClose:normalizeDecimal(bars.at(-1).close),
    firstOpenTimeMs:bars[0].openTimeMs,lastCloseTimeMs:bars.at(-1).closeTimeMs}:null;
  const report={methodVersion:METHOD,evidenceId:e.evidenceId,symbol:e.symbol,timeframe:e.timeframe,asOfMs:e.asOfMs,
    window:{startMs,endMs,source:'EXPLICIT_SERVER_WINDOW',venueVerified:false},windowEnded:e.asOfMs>=endMs,
    expectedElapsedBuckets:expected,observedBars:bars.length,missingBuckets:missing,
    status:!bars.length?'NO_DATA':missing||!singleProvider?'PARTIAL_OR_MIXED_DATA':e.asOfMs<endMs?'OBSERVED_WINDOW_IN_PROGRESS':'OBSERVED_WINDOW_COMPLETE',
    observedRange:singleProvider?range:null,
    limitations:['NO_EXTERNAL_SESSION_VERIFICATION','NO_INTRABAR_COVERAGE_PROOF','NO_ORDER_FLOW_PROOF','NO_EXECUTION_AUTHORITY']};
  return freeze({...report,sessionId:digest(report)});
}
module.exports={analyzeSessionRange,METHOD};
