'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {planFrames,activeBar,candleFreshness,terminalQuote,sessionClocks,windowRange}=require('../src/modules/ai/intelligence/adaptive-market-context');
const {buildWorkspaceBody}=require('../src/modules/ai/providers/funded-workspace-context');
const t=Date.parse('2026-11-27T07:46:00Z'),open=Date.parse('2026-11-27T07:30:00Z');
const instrument={symbol:'EURUSD',status:'ACTIVE',provider:'twelve-data',providerSymbol:'EUR/USD',timezone:'UTC',scheduleVersion:1,
  maxQuoteAgeMs:30000,tradingSessions:[{days:[0,1,2,3,4,5,6],open:'00:00',close:'23:59'}],tradingHolidays:[],sessionOverrides:[]};
test('adaptive market plan includes six relevant frames for M30, only supported frames',()=>{
  assert.deepEqual(planFrames('30m',['1m','5m','15m','30m','1h','4h','1d','1w']),['30m','5m','15m','1h','4h','1d']);
  assert.deepEqual(planFrames('30m',['30m','1h']),['30m','1h']);
  assert.throws(()=>planFrames('30m',['1m']));
});
test('normal 16-minute M30 closed-bar age is not stale',()=>{
  const current=candleFreshness({timeframe:'30m',bars:[{closeTimeMs:open}],asOfMs:t,instrument});
  assert.equal(current.state,'LATEST_EXPECTED_UTC_BUCKET');assert.equal(current.closedAgeMs,16*60000);
  assert.equal(current.nextBucketCloseMs,open+1800000);
  assert.equal(candleFreshness({timeframe:'30m',bars:[{closeTimeMs:open-1800000}],asOfMs:t,instrument}).state,'MISSING_RECENT_CLOSED_BUCKET');
});
test('only current verified active candle is included and it remains unclosed',()=>{
  const raw={symbol:'EURUSD',timeframe:'30m',provider:'twelve-data',openTimeMs:open,closeTimeMs:open+1800000,
    open:1.0975,high:1.0978,low:1.0970,close:1.0974,synthetic:false,complete:false};
  const request={symbol:'EURUSD',timeframe:'30m',provider:'twelve-data',asOfMs:t};
  assert.equal(activeBar(raw,request).complete,false);
  assert.equal(activeBar({...raw,complete:true},request),null);
  assert.equal(activeBar({...raw,provider:'accelpix'},request),null);
  assert.equal(activeBar({...raw,high:1},request),null);
});
test('quote observation uses its own capture time, preserves REST source, rejects old or mismatched quote',()=>{
  const q={symbol:'EURUSD',providerSymbol:'EUR/USD',source:'twelve-data-rest',providerTimestampMs:t-5,receivedAtMs:t-2,
    bid:1.09740,ask:1.09742,isStale:false,sessionOpen:true,isSyntheticSpread:true};
  assert.equal(terminalQuote(q,instrument,t).status,'RECENT_PROVIDER_EVENT');
  assert.equal(terminalQuote(q,instrument,t).originalSource,'twelve-data-rest');
  assert.equal(terminalQuote(q,instrument,t+31000).status,'UNAVAILABLE');
  assert.equal(terminalQuote({...q,providerSymbol:'XAU/USD'},instrument,t).status,'UNAVAILABLE');
});
test('London and New York conventional local clocks respect DST',()=>{
  const london=sessionClocks(Date.parse('2026-11-27T07:47:00Z')).find(x=>x.name==='LONDON');
  assert.equal(london.minutesToOpen,13);
  assert.equal(new Date(london.openMs).toISOString(),'2026-11-27T08:00:00.000Z');
  const summer=sessionClocks(Date.parse('2026-07-10T06:47:00Z')).find(x=>x.name==='LONDON');
  assert.equal(summer.minutesToOpen,13);
  assert.equal(new Date(summer.openMs).toISOString(),'2026-07-10T07:00:00.000Z');
});
test('session range only claims observed buckets and identifies gaps',()=>{
  const bars=[{openTimeMs:open-1800000,closeTimeMs:open,high:1.1,low:1.09}];
  const r=windowRange(bars,open-3600000,open+3600000,'30m',t);
  assert.equal(r.status,'PARTIAL');assert.equal(r.expectedBars,2);assert.equal(r.observedBars,1);
});
test('token pressure removes history and older candle rows explicitly, without modifying source or selected symbol',()=>{
  const frames=planFrames('30m',['1m','5m','15m','30m','1h','4h','1d']).map(timeframe=>({timeframe,availableClosedBars:128,
    closedCandles:Array.from({length:128},(_,i)=>[t-i*60000,1.097123,1.098123,1.096123,1.097623]),
    observations:Array.from({length:20},()=>({type:'FACT',kind:'EXAMPLE',value:'x'.repeat(80)}))}));
  const market={schemaVersion:'adaptive-market-v1',symbol:'EURUSD',selectedTimeframe:'30m',frames};
  const body=buildWorkspaceBody({modelId:'fixture',maxInputTokens:32768,maxOutputTokens:2048},{question:'Review entry',history:[],market,account:null});
  const data=JSON.parse(body.messages[1].content);
  assert.ok(Buffer.byteLength(JSON.stringify(body))+4096<=32768);
  assert.equal(data.market.symbol,'EURUSD');assert.equal(data.market.frames.length,6);
  assert.ok(data.market.frames[0].closedCandles.length>=48);
  assert.ok(data.market.frames.some(f=>f.omittedClosedBars>0));
  assert.equal(frames[0].closedCandles.length,128);
});