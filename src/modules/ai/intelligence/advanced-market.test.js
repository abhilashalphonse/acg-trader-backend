'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {analyzeStructure}=require('./structure-liquidity');
const {analyzeSessionRange}=require('./session-range');
const {summarizeTimeframeStructure}=require('./timeframe-structure');
const {analyzeMarketCandles}=require('./market-facts');
const start=Date.UTC(2026,0,5,10);
function input(rows,timeframe='1m',step=60000,asOfMs=start+rows.length*step){
  return {symbol:'XAUUSD',timeframe,asOfMs,candles:rows.map(([open,high,low,close],i)=>({
    symbol:'XAUUSD',timeframe,openTimeMs:start+i*step,closeTimeMs:start+(i+1)*step,
    open,high,low,close,complete:true,synthetic:false,source:'BACKFILL',provider:'twelve-data'
  }))};
}
const rows=[
  [100,103,97,100],[100,104,96,101],[101,110,90,102],
  [102,105,95,103],[103,106,94,104],[104,112,101,106],
  [106,115,105,112],[112,113,95,100],[100,112,93,105],
  [105,118,104,116],[116,117,88,89]
];
test('causal pivot, sweep, initial break, continuation BOS and reversal proxy',()=>{
  const x=analyzeStructure(input(rows));
  const events=x.events.filter(e=>['LIQUIDITY_SWEEP_PROXY','INITIAL_BREAK','BOS','MSS_PROXY'].includes(e.kind));
  assert.deepEqual(events.map(e=>e.kind),['LIQUIDITY_SWEEP_PROXY','INITIAL_BREAK','BOS','MSS_PROXY']);
  assert.equal(events[0].side,'BUY_SIDE');assert.equal(events[0].level,'110');
  assert.equal(events[0].referenceConfirmedAtMs,start+5*60000);
  assert.equal(events[1].direction,'BULLISH');assert.equal(events[2].level,'115');
  assert.equal(events[3].direction,'BEARISH');assert.equal(x.bias,'BEARISH');
  assert.ok(events.every(e=>e.atMs>e.referenceConfirmedAtMs));
  assert.ok(Object.isFrozen(x.events[0]));
  assert.equal(analyzeStructure(input(rows.slice(0,4))).pivots.length,0);
  assert.equal(analyzeStructure(input(rows.slice(0,5))).events.length,0);
  for(let n=1;n<=rows.length;n++){
    const prefix=analyzeStructure(input(rows.slice(0,n)));
    assert.deepEqual(prefix.events,x.events.filter(e=>e.atMs<=start+n*60000));
  }
});
test('strict equal swing highs are potential references, not actual resting orders',()=>{
  const x=analyzeStructure(input([
    [100,102,99,100],[100,105,99,103],[103,110,100,104],[104,106,100,103],
    [103,104,99,102],[102,105,100,103],[103,110,101,104],[104,106,101,103],[103,105,100,102]
  ]));
  assert.equal(x.equalLevels.length,1);assert.equal(x.equalLevels[0].level,'110');
  assert.equal(x.equalLevels[0].side,'BUY_SIDE');
});
test('bullish FVG near-edge, partial depth, distal touch and close invalidation are distinct',()=>{
  const series=[[100,101,99,100],[102,104,102,103],[105,106,104,105],
    [105,106,104,105],[105,105,103,104],[104,104,101,102],[102,103,99,100]];
  const get=n=>analyzeStructure(input(series.slice(0,n))).zones.find(g=>g.formedAtMs===start+3*60000);
  assert.equal(get(3).touchState,'UNTOUCHED');assert.equal(get(4).touchState,'NEAR_EDGE_TOUCHED');
  assert.equal(get(5).touchState,'PARTIAL_DEPTH');assert.equal(get(6).touchState,'DISTAL_TOUCHED');
  assert.equal(get(6).invalidatedAtMs,null);assert.equal(get(7).invalidationType,'CLOSE_BEYOND_DISTAL');
  const gap=analyzeStructure(input([...series.slice(0,3),[99,100,98,99]])).zones[0];
  assert.equal(gap.invalidationType,'GAP_THROUGH_UNOBSERVED');assert.equal(gap.touchState,'UNTOUCHED');
  const bear=analyzeStructure(input([[105,106,104,105],[103,103,102,103],[100,101,99,100],[100,104,100,103]])).zones[0];
  assert.equal(bear.direction,'BEARISH');assert.equal(bear.touchState,'DISTAL_TOUCHED');
  assert.equal(bear.invalidatedAtMs,null);
});
test('synthetic and incomplete bars cannot create events or carry old structure across a gap',()=>{
  const x=input(rows);
  x.candles[8].synthetic=true;x.candles[8].source='SYNTHETIC';
  x.candles[10].complete=false;
  const a=analyzeStructure(x);
  assert.equal(a.events.length,0);assert.equal(a.status,'INSUFFICIENT_BARS');
  assert.equal(a.bias,'UNESTABLISHED');
});
test('session windows report observed ranges and missing bars without claiming venue verification',()=>{
  const x=input(rows.slice(0,4));
  const window={startMs:start,endMs:start+4*60000};
  const a=analyzeSessionRange(x,window);
  assert.equal(a.status,'OBSERVED_WINDOW_COMPLETE');assert.equal(a.observedRange.high,'110');assert.equal(a.observedRange.low,'90');
  assert.equal(a.window.venueVerified,false);
  const y=input(rows.slice(0,3));
  assert.equal(analyzeSessionRange(y,window).status,'OBSERVED_WINDOW_IN_PROGRESS');
  x.candles.splice(1,1);
  assert.equal(analyzeSessionRange(x,window).status,'PARTIAL_OR_MIXED_DATA');
  assert.equal(analyzeSessionRange(x,window).missingBuckets,1);
  assert.throws(()=>analyzeSessionRange(x,{...window,startMs:start+1}),{code:'INVALID_SESSION_WINDOW'});
});
test('multi-timeframe alignment abstains on unqualified data and compares same-as-of evidence',()=>{
  const asOf=start+35*60000;
  const seriesFor=(data,tf,step)=>{
    const x=input(data,tf,step,asOf);
    // Shift aligned history so last candle closes at shared as-of.
    const offset=asOf-(start+data.length*step);
    x.candles=x.candles.map(c=>({...c,openTimeMs:c.openTimeMs+offset,closeTimeMs:c.closeTimeMs+offset}));
    return {timeframe:tf,analysis:analyzeMarketCandles(x),structure:analyzeStructure(x),coverage:{status:'MATCHES_CONFIGURED_CALENDAR'}};
  };
  const a=seriesFor(rows.slice(0,7),'1m',60000),b=seriesFor(rows.slice(0,7),'5m',300000);
  const compare=series=>summarizeTimeframeStructure({symbol:'XAUUSD',asOfMs:asOf,series});
  assert.equal(compare([a,b]).alignment,'ALIGNED_BULLISH_BREAK_HISTORY');
  assert.equal(compare([a,seriesFor(rows,'5m',300000)]).alignment,'MIXED_STRUCTURE');
  assert.equal(compare([a,{...b,coverage:{status:'UNKNOWN'}}]).alignment,'INSUFFICIENT_QUALIFIED_FRAMES');
  assert.equal(compare([a,{...b,structure:{...b.structure,asOfMs:asOf-1}}]).alignment,'INSUFFICIENT_QUALIFIED_FRAMES');
  assert.equal(compare([a]).alignment,'INSUFFICIENT_QUALIFIED_FRAMES');
});
