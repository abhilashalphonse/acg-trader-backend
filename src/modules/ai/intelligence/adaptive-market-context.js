'use strict';
// Workspace-only context projection. Existing reference-only verification
// contracts remain unchanged. Never hydrate provider history or mutate trading.
const {createTrustedContextAssembler,quoteEvidence}=require('./trusted-context');
const {compilePromptPackage}=require('./prompt-compiler');
const {TIMEFRAME_MS,candleBucketOpenTimeMs}=require('../../market-data/market.constants');
const {validSchedule}=require('./calendar-coverage');
const {scheduleHash}=require('../../instruments/schedule-identity');
const {isInstrumentSessionOpen,zonedParts,zonedDateTimeToUtcMs,activeSessionOpenTimeMs,nextSessionOpenTimeMs}=require('../../instruments/session-calendar');
const {isDeepStrictEqual}=require('node:util');
const {decimalToNumber}=require('../../market-data/market.utils');
const {analyzeAdvancedMarket,quoteRangeLocation}=require('./advanced-market-intelligence');
const FRAME_ORDER=['1m','5m','15m','30m','1h','4h','1d','1w'];
const FRAME_PLAN={
  '1m':['5m','15m','1h'],'5m':['1m','30m','4h'],'15m':['5m','1h','4h'],
  '30m':['5m','15m','1h','4h','1d'],'1h':['15m','4h','1d'],
  '4h':['30m','1h','1d'],'1d':['4h','1w','1h'],'1w':['1d','4h']
};
function planFrames(selected,available){
  if(!FRAME_ORDER.includes(selected)||!available.includes(selected))throw Error('Unsupported workspace timeframe');
  return [selected,...(FRAME_PLAN[selected]||[]).filter(t=>available.includes(t))];
}
const validPrice=v=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=1e12;
function ohlcValid(b){return [b?.open,b?.high,b?.low,b?.close].every(validPrice)&&b.high>=Math.max(b.open,b.close)&&b.low<=Math.min(b.open,b.close);}
function activeBar(raw,{symbol,timeframe,provider,asOfMs}){
  if(!raw||raw.symbol!==symbol||raw.timeframe!==timeframe||raw.provider!==provider||raw.complete!==false||
    typeof raw.synthetic!=='boolean'||!ohlcValid(raw)||raw.openTimeMs!==candleBucketOpenTimeMs(asOfMs,timeframe)||
    raw.closeTimeMs!==raw.openTimeMs+TIMEFRAME_MS[timeframe])return null;
  return {openTimeMs:raw.openTimeMs,closeTimeMs:raw.closeTimeMs,open:raw.open,high:raw.high,low:raw.low,close:raw.close,
    synthetic:raw.synthetic,complete:false,source:'TERMINAL_ACTIVE_CANDLE',observedAtMs:asOfMs};
}
function candleFreshness({timeframe,bars,asOfMs,instrument}){
  const currentOpen=candleBucketOpenTimeMs(asOfMs,timeframe),last=bars.at(-1);
  const open=validSchedule(instrument)?isInstrumentSessionOpen(instrument,asOfMs):null;
  // A recent closed candle remains current until the next expected close.
  // For session gaps report uncertainty, not stale by wall-clock age alone.
  const latest=last?.closeTimeMs??null;
  let state=!last?'NO_CLOSED_BARS':latest===currentOpen?'LATEST_EXPECTED_UTC_BUCKET':open===false?'MARKET_CLOSED':'CHECK_COVERAGE';
  if(last&&latest<currentOpen&&open===true&&timeframe!=='1d'&&timeframe!=='1w'&&validSchedule(instrument)){
    const prior=currentOpen-TIMEFRAME_MS[timeframe];
    if(isInstrumentSessionOpen(instrument,prior)&&isInstrumentSessionOpen(instrument,currentOpen-1))state='MISSING_RECENT_CLOSED_BUCKET';
  }
  return {state,latestClosedAtMs:latest,currentBucketOpenMs:currentOpen,nextBucketCloseMs:currentOpen+TIMEFRAME_MS[timeframe],marketOpen:open,
    closedAgeMs:latest===null?null:asOfMs-latest};
}
function terminalQuote(raw,instrument,asOfMs){
  // The gateway's REST recovery has a distinct source tag. Preserve it.
  const source=raw?.source;
  const supported=source===instrument.provider||source===instrument.provider+'-rest';
  const q=quoteEvidence(supported?{...raw,source:instrument.provider}:raw,instrument,asOfMs);
  const result={...q,originalSource:typeof source==='string'&&supported?source:null,observedAtMs:asOfMs};
  if(q.status==='RECENT_PROVIDER_EVENT')return {...result,sessionVerification:'MATCHES_CONFIGURED_SCHEDULE'};
  if(q.reason!=='SESSION_CLOSED_OR_UNKNOWN')return result;
  const calendarKnown=validSchedule(instrument);
  const configuredOpen=calendarKnown?isInstrumentSessionOpen(instrument,asOfMs):null;
  const providerTimeOpen=calendarKnown?isInstrumentSessionOpen(instrument,raw.providerTimestampMs):null;
  const sessionVerification=!calendarKnown?'SCHEDULE_UNAVAILABLE':
    configuredOpen===false||providerTimeOpen===false?'CONFIGURED_SESSION_CLOSED':
    raw.sessionOpen!==true?'FEED_SESSION_NOT_OPEN':'SESSION_UNVERIFIED';
  // quoteEvidence has already checked identity and timing before rejecting the
  // session. Prices are checked below because the strict gate checks them later.
  // Do not export this fallback for a known closed session, stale feed, closed
  // feed flag, mismatched source, missing timestamps or invalid bid/ask.
  if(!calendarKnown&&raw.sessionOpen===true&&supported&&validPrice(raw.bid)&&validPrice(raw.ask)&&raw.ask>=raw.bid&&typeof raw.isSyntheticSpread==='boolean'){
    return {...result,sessionVerification,observedQuote:{
      status:'RECENT_OBSERVATION_SESSION_UNVERIFIED',bid:raw.bid,ask:raw.ask,
      source,providerTimestampMs:raw.providerTimestampMs,receivedAtMs:raw.receivedAtMs,
      ageMs:asOfMs-raw.providerTimestampMs,validUntilMs:raw.providerTimestampMs+instrument.maxQuoteAgeMs,
      isSyntheticSpread:raw.isSyntheticSpread,executable:false
    }};
  }
  return {...result,sessionVerification};
}
function sessionClocks(asOfMs){
  return [['TOKYO','Asia/Tokyo',9,18],['LONDON','Europe/London',8,17],['NEW_YORK','America/New_York',8,17]].map(([name,timezone,start,end])=>{
    const local=zonedParts(asOfMs,timezone);
    const at=hour=>zonedDateTimeToUtcMs({...local,hour,minute:0},timezone);
    const openMs=at(start),closeMs=at(end),weekday=local.weekday>=1&&local.weekday<=5;
    return {name,timezone,openMs,closeMs,state:!weekday?'WEEKEND':asOfMs<openMs?'UPCOMING':asOfMs<closeMs?'IN_WINDOW':'ENDED',
      minutesToOpen:weekday&&asOfMs<openMs?Math.ceil((openMs-asOfMs)/60000):null,definition:'CONVENTIONAL_FX_LOCAL_CLOCK_NOT_VENUE_SESSION'};
  });
}
function windowRange(bars,startMs,endMs,timeframe,asOfMs){
  const step=TIMEFRAME_MS[timeframe],through=Math.min(endMs,candleBucketOpenTimeMs(asOfMs,timeframe));
  if(startMs%step!==0||endMs%step!==0||through<=startMs)return null;
  const selected=bars.filter(b=>b.openTimeMs>=startMs&&b.closeTimeMs<=through);
  const expected=(through-startMs)/step;
  if(!selected.length)return {startMs,endMs,observedBars:0,expectedBars:expected,status:'NO_DATA'};
  return {startMs,endMs,observedBars:selected.length,expectedBars:expected,status:selected.length===expected?'COMPLETE_OBSERVED_BUCKETS':'PARTIAL',
    high:Math.max(...selected.map(b=>b.high)),low:Math.min(...selected.map(b=>b.low)),firstOpenTimeMs:selected[0].openTimeMs,lastCloseTimeMs:selected.at(-1).closeTimeMs};
}
function sizingSpecifications(i){
  const decimal=value=>value==null?null:String(value);
  return {...Object.fromEntries(['pipSize','contractSize','minVolume','maxVolume','volumeStep','marginRate','commissionPerLot','commissionPerLotPerSide','commissionRate'].map(k=>[k,decimal(i[k])])),
    quoteCurrency:i.quoteCurrency??null,pnlCurrency:i.pnlCurrency||i.quoteCurrency||null,marginCurrency:i.marginCurrency||i.quoteCurrency||null,defaultLeverage:i.defaultLeverage??null};
}
function compactReference(r){
  // Keep factual values and timestamps, omit redundant hashes; original
  // reference-only path still retains its signed reference IDs.
  return {type:r.type,...r.data};
}
async function readAdaptiveMarket({source,runtime,scope,workspace,authorize,now=Date.now}){
  const frames=planFrames(workspace.timeframe,runtime.timeframes||[]);
  if(await authorize()!==true)throw Error('Workspace denied');
  const start=now(),instrument=await source.instrument(workspace.symbol);
  if(!instrument)throw Error('Instrument unavailable');
  // Parallel independent historical reads with explicit per-frame cutoffs.
  // One unavailable secondary frame must not masquerade as confirmation.
  const results=await Promise.all(frames.map(async(timeframe,index)=>{
    try{
      const limit=index===0?128:(timeframe==='1d'||timeframe==='1w'?60:64);
      const request={scope,symbol:workspace.symbol,timeframes:[timeframe],limit,sessionWindows:[]};
      const assembler=createTrustedContextAssembler({source,authorize:async r=>isDeepStrictEqual(r,request)&&await authorize()});
      const chart=await assembler.assemble(request);
      const projected=compilePromptPackage({scope,profile:'STRUCTURE',question:'Describe the chart context.',context:chart,nowMs:now()}).payload.data.evidence;
      const series=chart.series[0],bars=series.analysis?.evidence?.bars??[];
      const {quality,coverage,limitations}=projected.frames[0];
      // All validated closed bars, including segments before scheduled gaps.
      // Compact tuples keep the exact OHLC sequence accessible to the LLM.
      const tuples=bars.map(b=>[b.openTimeMs,b.open,b.high,b.low,b.close]);
      return {timeframe,asOfMs:chart.asOfMs,status:series.status,coverage,quality,
        freshness:candleFreshness({timeframe,bars,asOfMs:chart.asOfMs,instrument}),
        candleColumns:['openTimeMs','open','high','low','close'],closedCandles:tuples,
        historyLimit:limit,availableClosedBars:bars.length,
        observations:projected.references.filter(r=>r.type!=='QUOTE_OBSERVATION'&&r.type!=='CROSS_TIMEFRAME').map(compactReference),
        limitations,advanced:series.analysis?analyzeAdvancedMarket({evidence:series.analysis.evidence,structure:series.structure,tickSize:decimalToNumber(instrument.tickSize,null)}):null,activeCandle:null,bars};
    }catch(e){
      if(index===0)throw e;
      return {timeframe,status:'UNAVAILABLE',reason:'SECONDARY_FRAME_NOT_VALIDATED',bars:[],closedCandles:[],observations:[]};
    }
  }));
  if(await authorize()!==true)throw Error('Workspace denied');
  const finalInstrument=await source.instrument(workspace.symbol);
  if(!finalInstrument||finalInstrument.provider!==instrument.provider||finalInstrument.providerSymbol!==instrument.providerSymbol||
    finalInstrument.scheduleVersion!==instrument.scheduleVersion||finalInstrument.maxQuoteAgeMs!==instrument.maxQuoteAgeMs||
    scheduleHash(finalInstrument)!==scheduleHash(instrument))throw Error('Instrument changed');
  const raw=source.quote(workspace.symbol),asOfMs=now();
  if(asOfMs-start>=10000)throw Error('Context expired');
  const quote=terminalQuote(raw,finalInstrument,asOfMs);
  const clocks=sessionClocks(asOfMs);
  const intraday=results.find(r=>['30m','15m','1h'].includes(r.timeframe)&&r.bars.length);
  const ranges=intraday?clocks.map(c=>({name:c.name,range:windowRange(intraday.bars,c.openMs,c.closeMs,intraday.timeframe,asOfMs)})):null;
  const utcDay=Math.floor(asOfMs/86400000)*86400000;
  const daily=results.find(r=>r.timeframe==='1d'&&r.bars.length);
  const previousDay=daily?.bars.at(-1)??null;
  return {schemaVersion:'adaptive-market-v1',symbol:workspace.symbol,provider:instrument.provider,asOfMs,quoteStatus:quote.status,quote,
    selectedTimeframe:workspace.timeframe,requestedTimeframes:frames,
    instrument:{sizingSpecifications:sizingSpecifications(finalInstrument),assetClass:instrument.assetClass??null,quoteCurrency:instrument.quoteCurrency??null,digits:instrument.digits??null,
      pipSize:decimalToNumber(instrument.pipSize,null),tickSize:decimalToNumber(instrument.tickSize,null),contractSize:decimalToNumber(instrument.contractSize,null),
      defaultLeverage:instrument.defaultLeverage??null,marketOpen:validSchedule(finalInstrument)?isInstrumentSessionOpen(finalInstrument,asOfMs):null,
      timezone:finalInstrument.timezone,sessionOpenMs:validSchedule(finalInstrument)?activeSessionOpenTimeMs(finalInstrument,asOfMs):null,
      nextOpenMs:validSchedule(finalInstrument)?nextSessionOpenTimeMs(finalInstrument,asOfMs):null},
    sessionClocks:clocks,sessionRanges:ranges,sessionRangeTimeframe:intraday?.timeframe??null,
    previousClosedDailyBar:previousDay?{openTimeMs:previousDay.openTimeMs,high:previousDay.high,low:previousDay.low,close:previousDay.close}:null,
    observedUtcDayRange:intraday?windowRange(intraday.bars,utcDay,utcDay+86400000,intraday.timeframe,asOfMs):null,
    frames:results.map(({bars,...r})=>({...r,quoteRangeLocation:quoteRangeLocation(r.advanced,quote),activeCandle:activeBar(runtime.candleEngine?.getCurrent(workspace.symbol,r.timeframe),
      {symbol:workspace.symbol,timeframe:r.timeframe,provider:instrument.provider,asOfMs})})),
    limitations:['READ_ONLY','NON_ATOMIC_MARKET_SNAPSHOT','CLOSED_BARS_NOT_EXECUTABLE','SESSION_CLOCKS_ARE_CONVENTIONS','NO_NEWS_CONTEXT']};
}
module.exports={planFrames,activeBar,candleFreshness,terminalQuote,sessionClocks,windowRange,readAdaptiveMarket,FRAME_ORDER};
