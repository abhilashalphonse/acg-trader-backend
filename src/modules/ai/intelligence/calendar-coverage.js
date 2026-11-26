'use strict';
const {TIMEFRAME_MS,candleBucketOpenTimeMs}=require('../../market-data/market.constants');
const {isInstrumentSessionOpen,parseClock}=require('../../instruments/session-calendar');
const {scheduleHash}=require('../../instruments/schedule-identity');
const {freeze}=require('./candle-evidence');
const LIMIT=4096;
const minute=60000;
function validSessions(s){return Array.isArray(s)&&s.length<=32&&s.every(x=>x&&Array.isArray(x.days)&&x.days.length>0&&x.days.every(d=>Number.isInteger(d)&&d>=0&&d<=6)&&parseClock(x.open)!=null&&parseClock(x.close)!=null&&x.open!==x.close);}
function validDate(d){return typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;}
function validSchedule(i){
  if(!i||i.status!=='ACTIVE'||typeof i.timezone!=='string'||i.timezone.length>80||
    !Number.isSafeInteger(i.scheduleVersion)||i.scheduleVersion<1||!validSessions(i.tradingSessions)||!i.tradingSessions.length||
    !Array.isArray(i.tradingHolidays)||i.tradingHolidays.length>512||!i.tradingHolidays.every(validDate)||
    !Array.isArray(i.sessionOverrides)||i.sessionOverrides.length>512||
    !i.sessionOverrides.every(o=>o&&validDate(o.date)&&typeof o.closed==='boolean'&&validSessions(o.sessions)&&(o.closed?o.sessions.length===0:o.sessions.length>0))||
    new Set(i.sessionOverrides.map(o=>o.date)).size!==i.sessionOverrides.length)return false;
  try{new Intl.DateTimeFormat('en-US',{timeZone:i.timezone});return true;}catch{return false;}
}
function classifyCoverage(evidence,instrument){
  const unknown=reason=>freeze({status:'UNKNOWN',reason,calendarSource:'CONFIGURED_INSTRUMENT_ONLY',calendarVerified:false,coverageVerified:false});
  if(!validSchedule(instrument)||instrument.symbol!==evidence.symbol)return unknown('SCHEDULE_UNAVAILABLE');
  // Only Twelve Data UTC buckets in this increment; do not assume NSE
  // session-aligned or other providers share the same boundaries.
  if(instrument.provider!=='twelve-data')return unknown('BUCKET_CONTRACT_UNSUPPORTED');
  const {bars,timeframe,asOfMs}=evidence,step=TIMEFRAME_MS[timeframe];
  if(!bars.length)return unknown('NO_CLOSED_BARS');
  if(bars.some(b=>b.provider!==instrument.provider||candleBucketOpenTimeMs(b.openTimeMs,timeframe)!==b.openTimeMs))return unknown('BUCKET_OR_PROVIDER_MISMATCH');
  let probes=0;
  function overlaps(from,to){
    for(let t=from;t<to;t+=minute){
      if(++probes>LIMIT)throw Error('budget');
      if(isInstrumentSessionOpen(instrument,t))return true;
    }
    return false;
  }
  const result={status:'MATCHES_CONFIGURED_CALENDAR',calendarSource:'CONFIGURED_INSTRUMENT_ONLY',calendarVerified:false,coverageVerified:false,
    scheduleVersion:instrument.scheduleVersion,scheduleHash:scheduleHash(instrument),
    firstOpenTimeMs:bars[0].openTimeMs,asOfMs,missingOpenBuckets:0,closedGapBuckets:0,outOfSessionBars:0,probes:0};
  const currentOpen=candleBucketOpenTimeMs(asOfMs,timeframe);
  try{
    const times=new Set(bars.map(b=>b.openTimeMs));
    for(let t=bars[0].openTimeMs;t<currentOpen;t+=step){
      if(t+step>asOfMs)break;
      const expected=overlaps(t,t+step),present=times.has(t);
      if(expected&&!present)result.missingOpenBuckets++;
      if(!expected&&present)result.outOfSessionBars++;
      if(!expected&&!present)result.closedGapBuckets++;
    }
  }catch{return unknown('CALENDAR_PROBE_BUDGET_OR_ERROR');}
  result.probes=probes;
  if(result.outOfSessionBars||result.missingOpenBuckets)result.status='COVERAGE_DEFECT';
  // Matching configured schedule is not independent verification of holidays,
  // completeness within a bar, market provider identity or external data rights.
  return freeze(result);
}
module.exports={classifyCoverage,validSchedule,LIMIT};
