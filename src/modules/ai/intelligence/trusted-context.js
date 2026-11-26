'use strict';
const {TWELVE_DATA_HISTORY_INTERVALS}=require('../../market-data/market.constants');
const {isInstrumentSessionOpen}=require('../../instruments/session-calendar');
const {scheduleHash}=require('../../instruments/schedule-identity');
const {digest,freeze}=require('./candle-evidence');
const {analyzeMarketCandles}=require('./market-facts');
const {analyzeStructure}=require('./structure-liquidity');
const {summarizeTimeframeStructure}=require('./timeframe-structure');
const {analyzeSessionRange}=require('./session-range');
const {classifyCoverage,validSchedule}=require('./calendar-coverage');
const MAX_TIMEFRAMES=3,MAX_BARS=128,TTL_MS=10000;
// Process-local replay material, keyed by the actual server-minted object.
// Never serialize or send this material to a model. GC follows context lifetime.
const replayByContext=new WeakMap();
function getContextReplay(context){return replayByContext.get(context)||null;}
function pinInstrument(i){
  return freeze(structuredClone(Object.fromEntries(['symbol','status','chartEnabled','provider','providerSymbol','quoteCurrency','timezone','scheduleVersion','tradingSessions','tradingHolidays','sessionOverrides','maxQuoteAgeMs'].map(k=>[k,i[k]]))));
}
const id=v=>typeof v==='string'&&/^[a-f0-9]{24}$/.test(v);
const clock=v=>Number.isSafeInteger(v)&&v>0&&v<8640000000000000;
function deny(code){const e=new Error('Context unavailable');e.code=code;throw e;}
function quoteEvidence(raw,i,asOfMs){
  const unavailable=reason=>({status:'UNAVAILABLE',reason,executable:false});
  if(!raw)return unavailable('NO_QUOTE');
  if(raw.symbol!==i.symbol||raw.providerSymbol!==i.providerSymbol||raw.source!==i.provider)return unavailable('QUOTE_MAPPING_OR_SOURCE_MISMATCH');
  if(!Number.isSafeInteger(i.maxQuoteAgeMs)||i.maxQuoteAgeMs<1||i.maxQuoteAgeMs>300000||
    !clock(raw.receivedAtMs)||!clock(raw.providerTimestampMs)||raw.providerTimestampMs>raw.receivedAtMs||
    raw.receivedAtMs>asOfMs||raw.isStale!==false)return unavailable('QUOTE_TIME_OR_STATE_UNVERIFIED');
  const ageMs=asOfMs-raw.providerTimestampMs;
  if(ageMs>i.maxQuoteAgeMs)return unavailable('QUOTE_STALE');
  if(!validSchedule(i)||raw.sessionOpen!==true||!isInstrumentSessionOpen(i,asOfMs)||!isInstrumentSessionOpen(i,raw.providerTimestampMs))return unavailable('SESSION_CLOSED_OR_UNKNOWN');
  if(![raw.bid,raw.ask].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=1e12)||raw.ask<raw.bid||
    typeof raw.isSyntheticSpread!=='boolean')return unavailable('INVALID_QUOTE');
  return {status:'RECENT_PROVIDER_EVENT',bid:raw.bid,ask:raw.ask,source:raw.source,providerSymbol:raw.providerSymbol,
    providerTimestampMs:raw.providerTimestampMs,receivedAtMs:raw.receivedAtMs,ageMs,
    validUntilMs:raw.providerTimestampMs+i.maxQuoteAgeMs,isSyntheticSpread:raw.isSyntheticSpread,
    providerIdentityVerified:false,executable:false};
}
// Trusted server composition only. authorize MUST perform fresh session/account,
// AI grant/governance and data-entitlement checks for this exact request.
// No default authorization and no model-facing endpoint. The caller must never
// supply a model or client assertion as the authorize implementation.
function createTrustedContextAssembler({source,authorize,now=Date.now}={}){
  if(!source||typeof authorize!=='function')throw Error('Trusted context authorization and source required');
  return Object.freeze({
    async assemble({scope,symbol,timeframes,limit=MAX_BARS,sessionWindows=[]}={}){
      if(!scope||!['tenantId','actorId','sessionId','accountId'].every(k=>id(scope[k]))||
        typeof symbol!=='string'||!/^[A-Z0-9._-]{1,32}$/.test(symbol)||
        !Array.isArray(timeframes)||timeframes.length<1||timeframes.length>MAX_TIMEFRAMES||
        new Set(timeframes).size!==timeframes.length||!timeframes.every(t=>typeof t==='string'&&Object.hasOwn(TWELVE_DATA_HISTORY_INTERVALS,t))||
        !Number.isSafeInteger(limit)||limit<1||limit>MAX_BARS||
        !Array.isArray(sessionWindows)||sessionWindows.length>3||
        !sessionWindows.every(w=>w&&timeframes.includes(w.timeframe)&&Number.isSafeInteger(w.startMs)&&
          Number.isSafeInteger(w.endMs)&&w.startMs>=0&&w.endMs>w.startMs&&w.endMs-w.startMs<=86400000))
        deny('INVALID_CONTEXT_REQUEST');
      const request=freeze({scope:{tenantId:scope.tenantId,actorId:scope.actorId,sessionId:scope.sessionId,accountId:scope.accountId},
        symbol,timeframes:[...timeframes],limit,sessionWindows:sessionWindows.map(w=>({timeframe:w.timeframe,startMs:w.startMs,endMs:w.endMs}))});
      if(await authorize(request)!==true)deny('CONTEXT_FORBIDDEN');
      const asOfMs=now();if(!clock(asOfMs))deny('INVALID_CONTEXT_CLOCK');
      const sourceInstrument=await source.instrument(symbol);
      const i=sourceInstrument?pinInstrument(sourceInstrument):null;
      if(!i||i.symbol!==symbol||i.status!=='ACTIVE'||i.chartEnabled!==true||
        !['twelve-data','accelpix'].includes(i.provider)||typeof i.providerSymbol!=='string'||!i.providerSymbol||i.providerSymbol.length>128)
        deny('INSTRUMENT_UNAVAILABLE');
      const rawQuote=source.quote(symbol);
      const pinnedQuote=rawQuote?freeze(structuredClone(Object.fromEntries(['symbol','providerSymbol','source','receivedAtMs','providerTimestampMs','isStale','sessionOpen','bid','ask','isSyntheticSpread'].map(k=>[k,rawQuote[k]])))):null;
      const quote=quoteEvidence(pinnedQuote,i,asOfMs);
      const series=[],replaySeries=[];
      for(const timeframe of request.timeframes){
        const rawCandles=await source.candles({symbol,timeframe,asOfMs,limit});
        if(!Array.isArray(rawCandles)||rawCandles.length>limit)deny('SOURCE_LIMIT_VIOLATION');
        const candles=freeze(rawCandles.map(c=>c?Object.fromEntries(['symbol','timeframe','openTimeMs','closeTimeMs','open','high','low','close','complete','synthetic','source','provider'].map(k=>[k,c[k]])):null));
        replaySeries.push({timeframe,candles});
        if(!Array.isArray(candles)||candles.length>limit)deny('SOURCE_LIMIT_VIOLATION');
        if(candles.some(c=>c?.provider!==i.provider))deny('CANDLE_PROVIDER_MISMATCH');
        const analysis=analyzeMarketCandles({symbol,timeframe,asOfMs,candles});
        const coverage=classifyCoverage(analysis.evidence,i);
        // Do not surface facts from bars known to be outside the configured calendar.
        const structure=coverage.outOfSessionBars>0?null:analyzeStructure({symbol,timeframe,asOfMs,candles});
        const sessions=coverage.outOfSessionBars>0?[]:request.sessionWindows.filter(w=>w.timeframe===timeframe)
          .map(w=>analyzeSessionRange({symbol,timeframe,asOfMs,candles},w));
        series.push({timeframe,coverage,structure,sessions,analysis:coverage.outOfSessionBars>0?null:analysis,
          status:coverage.outOfSessionBars>0?'OUT_OF_SESSION_DATA_REJECTED':'HISTORICAL_ONLY'});
      }
      // Recheck mapping and schedule after reads; not a distributed atomic snapshot.
      const endInstrument=await source.instrument(symbol);
      if(!endInstrument||endInstrument.status!==i.status||endInstrument.provider!==i.provider||
        endInstrument.providerSymbol!==i.providerSymbol||endInstrument.scheduleVersion!==i.scheduleVersion||
        endInstrument.maxQuoteAgeMs!==i.maxQuoteAgeMs||scheduleHash(endInstrument)!==scheduleHash(i))
        deny('CONTEXT_SOURCE_CHANGED');
      if(await authorize(request)!==true)deny('CONTEXT_FORBIDDEN');
      const completedAtMs=now();
      if(!clock(completedAtMs)||completedAtMs<asOfMs||completedAtMs>=asOfMs+TTL_MS)deny('CONTEXT_EXPIRED');
      const finalQuote=quote.status==='RECENT_PROVIDER_EVENT'&&completedAtMs>=quote.validUntilMs
        ?{status:'UNAVAILABLE',reason:'QUOTE_EXPIRED_DURING_ASSEMBLY',executable:false}:quote;
      const snapshot={schemaVersion:'trusted-context-v1',scope:request.scope,symbol,
        instrument:{provider:i.provider,providerSymbol:i.providerSymbol,quoteCurrency:i.quoteCurrency??null,
          scheduleVersion:i.scheduleVersion??null,scheduleHash:scheduleHash(i)},
        asOfMs,completedAtMs,expiresAtMs:asOfMs+TTL_MS,quote:finalQuote,series,
        crossTimeframe:summarizeTimeframeStructure({symbol,asOfMs,series}),
        limitations:['NO_EXTERNAL_ENTITLEMENT_IMPLEMENTATION','NO_ATOMIC_CROSS_SERIES_SNAPSHOT','NO_PROVIDER_IDENTITY_PROOF','NO_EXECUTION_AUTHORITY','NO_ACCOUNT_DATA','NO_WORKSPACE_DRAWINGS']};
      const context=freeze({...snapshot,contextId:digest(snapshot)});
      replayByContext.set(context,freeze({request,instrument:i,quote:pinnedQuote,series:replaySeries}));
      return context;
    },
  });
}
module.exports={createTrustedContextAssembler,getContextReplay,quoteEvidence,MAX_TIMEFRAMES,MAX_BARS,TTL_MS};
