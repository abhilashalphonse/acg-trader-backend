'use strict';
const crypto = require('node:crypto');
const { TIMEFRAME_MS, TWELVE_DATA_HISTORY_INTERVALS } = require('../../market-data/market.constants');
const SOURCES = Object.freeze(['BACKFILL','CANONICAL_BACKFILL','LIVE','LIVE_RECONCILED','HYDRATED','CORRECTION']);
const PROVIDERS = Object.freeze(['twelve-data','accelpix']);
const MAX_BARS = 256;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function invalid(code) { const error = new Error('Market evidence rejected'); error.code=code; throw error; }
function freeze(value) {
  if (value && typeof value==='object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
// Internal trusted-server input only. Not a public tool or a proof of origin.
// asOfMs must be the evaluation clock, not a model-supplied timestamp.
function createCandleEvidence({symbol,timeframe,asOfMs,candles}={}) {
  if (typeof symbol!=='string'||!/^[A-Z0-9._-]{1,32}$/.test(symbol)||
      !Object.hasOwn(TWELVE_DATA_HISTORY_INTERVALS,timeframe)||
      !Number.isSafeInteger(asOfMs)||asOfMs<=0||asOfMs>8640000000000000||
      !Array.isArray(candles)||candles.length>MAX_BARS) invalid('INVALID_EVIDENCE_INPUT');
  const step=TIMEFRAME_MS[timeframe];
  const bars=[], exclusions={incomplete:0,synthetic:0};
  let prior=-1;
  for(const raw of candles){
    if(!raw||raw.symbol!==symbol||raw.timeframe!==timeframe||
        !Number.isSafeInteger(raw.openTimeMs)||raw.openTimeMs<0||
        !Number.isSafeInteger(raw.closeTimeMs)||raw.closeTimeMs!==raw.openTimeMs+step||
        raw.openTimeMs<=prior||raw.openTimeMs>asOfMs) invalid('INVALID_CANDLE_SCOPE_OR_TIME');
    if(prior>=0 && raw.openTimeMs<prior+step) invalid('OVERLAPPING_CANDLES');
    prior=raw.openTimeMs;
    if(typeof raw.complete!=='boolean'||typeof raw.synthetic!=='boolean') invalid('UNKNOWN_CANDLE_STATE');
    if(raw.complete&&raw.closeTimeMs>asOfMs) invalid('FUTURE_CLOSED_CANDLE');
    if(raw.synthetic){exclusions.synthetic++;continue;}
    if(!raw.complete){exclusions.incomplete++;continue;}
    const {open,high,low,close}=raw;
    if(![open,high,low,close].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=1e12)||
        high<Math.max(open,close)||low>Math.min(open,close)) invalid('INVALID_OHLC');
    if(!SOURCES.includes(raw.source)||!PROVIDERS.includes(raw.provider)) invalid('UNKNOWN_PROVENANCE');
    bars.push({openTimeMs:raw.openTimeMs,closeTimeMs:raw.closeTimeMs,open,high,low,close,
      source:raw.source,provider:raw.provider});
  }
  // Do not silently bridge missing/synthetic candles or session breaks. We do not
  // infer whether a gap is a legitimate closure, a provider outage or missing data.
  let start=0, gaps=0;
  for(let i=1;i<bars.length;i++) if(bars[i].openTimeMs!==bars[i-1].closeTimeMs||bars[i].provider!==bars[i-1].provider){start=i;gaps++;}
  const last=bars.at(-1);
  const tail=candles.at(-1);
  // A trailing synthetic bar means a known hole, even if the last real bar is recent.
  const trailingSynthetic=Boolean(tail?.synthetic||candles.some(b=>b.synthetic&&(!last||b.openTimeMs>last.openTimeMs)));
  const ageMs=last?asOfMs-last.closeTimeMs:null;
  const snapshot={schemaVersion:'candle-evidence-v1',symbol,timeframe,asOfMs,stepMs:step,
    bars,quality:{inputCount:candles.length,closedCount:bars.length,exclusions,gaps,
      contiguousStart:start,contiguousCount:bars.length-start,latestClosedAtMs:last?.closeTimeMs??null,ageMs,
      status:!last?'NO_DATA':trailingSynthetic||ageMs>step?'NOT_CURRENT':'RECENT_CLOSED_BAR',
      continuityVerified:false,calendarVerified:false,providerIdentityVerified:false}};
  return freeze({...snapshot,evidenceId:digest(snapshot)});
}
module.exports={createCandleEvidence,MAX_BARS,digest,freeze};
