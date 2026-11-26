'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCandleEvidence,MAX_BARS}=require('./candle-evidence');
const {analyzeMarketCandles}=require('./market-facts');
const {verifyMarketClaims}=require('./fact-verifier');
const start=Date.UTC(2026,0,1),step=60000;
const bar=(i,price=100,extra={})=>({symbol:'XAUUSD',timeframe:'1m',
  openTimeMs:start+i*step,closeTimeMs:start+(i+1)*step,
  open:price,high:price+1,low:price-1,close:price,
  complete:true,synthetic:false,source:'BACKFILL',provider:'twelve-data',...extra});
const input=(candles,asOfMs=start+candles.length*step)=>({symbol:'XAUUSD',timeframe:'1m',asOfMs,candles});
const get=(a,k)=>a.facts.find(f=>f.kind===k);
const claim=(a,f)=>({evidenceId:a.evidence.evidenceId,factId:f.factId,kind:f.kind,value:f.value});
test('fixed reference series produces deterministic range, SMA and mean true range',()=>{
  const x=input(Array.from({length:20},(_,i)=>bar(i,100+i)));
  const a=analyzeMarketCandles(x);
  assert.equal(get(a,'LAST_CLOSED_PRICE').value,'119');
  assert.equal(get(a,'OBSERVED_RANGE_HIGH').value,'120');
  assert.equal(get(a,'OBSERVED_RANGE_LOW').value,'99');
  assert.equal(get(a,'SMA_20').value,'109.5');
  assert.equal(get(a,'MEAN_TRUE_RANGE_14').value,'2');
  assert.equal(a.evidence.quality.contiguousCount,20);
  assert.deepEqual(a,analyzeMarketCandles(x));
  assert.ok(Object.isFrozen(a.evidence.bars[0]));
  assert.ok(Object.isFrozen(a.facts[0].details));
  assert.equal(a.analysisScope,'HISTORICAL_CLOSED_BARS_ONLY');
});
test('invalid scope, timestamps, OHLC, duplicate, overlap, future and provenance rejected',()=>{
  for(const b of [bar(0,100,{symbol:'EURUSD'}),bar(0,100,{timeframe:'5m'}),
    bar(0,100,{high:99}),bar(0,100,{low:101}),bar(0,100,{close:'100'}),bar(0,100,{close:NaN}),
    bar(0,100,{closeTimeMs:start+1}),bar(0,100,{provider:null}),bar(0,100,{source:'UNKNOWN'}),
    bar(0,100,{complete:undefined}),bar(0,100,{synthetic:undefined})]){
    assert.throws(()=>createCandleEvidence(input([b])));
  }
  assert.throws(()=>createCandleEvidence(input([bar(0),bar(0)])));
  assert.throws(()=>createCandleEvidence(input([bar(1),bar(0)])));
  assert.throws(()=>createCandleEvidence(input([bar(0),bar(1,100,{openTimeMs:start+1,closeTimeMs:start+step+1})])));
  assert.throws(()=>createCandleEvidence(input([bar(0)],start+step-1)),{code:'FUTURE_CLOSED_CANDLE'});
  assert.throws(()=>createCandleEvidence(input(Array.from({length:MAX_BARS+1},(_,i)=>bar(i)))));
  assert.throws(()=>createCandleEvidence({...input([]),timeframe:'1s'}));
});
test('incomplete and synthetic bars are excluded, indicators cannot bridge gaps or provider changes',()=>{
  const bars=Array.from({length:22},(_,i)=>bar(i,100+i));
  bars[19]=bar(19,900,{synthetic:true,source:'SYNTHETIC'});
  bars[21]=bar(21,1000,{complete:false});
  const a=analyzeMarketCandles(input(bars,start+21*step+1));
  assert.deepEqual(a.evidence.quality.exclusions,{incomplete:1,synthetic:1});
  assert.equal(a.evidence.quality.contiguousCount,1);
  assert.equal(get(a,'LAST_CLOSED_PRICE').value,'120');
  assert.equal(get(a,'SMA_20'),undefined);
  assert.equal(get(a,'LAST_THREE_BAR_GAP'),undefined);
  const b=analyzeMarketCandles(input([bar(0),bar(1,100,{provider:'accelpix'}),bar(2)]));
  assert.equal(b.evidence.quality.contiguousCount,1);
  assert.equal(b.evidence.quality.gaps,2);
});
test('missing bars, stale data and empty data are explicitly qualified',()=>{
  const a=analyzeMarketCandles(input([bar(0),bar(2)],start+10*step));
  assert.equal(a.evidence.quality.status,'NOT_CURRENT');
  assert.equal(a.evidence.quality.gaps,1);
  assert.equal(a.evidence.quality.calendarVerified,false);
  assert.equal(a.evidence.quality.continuityVerified,false);
  assert.equal(a.evidence.quality.providerIdentityVerified,false);
  assert.equal(get(a,'LAST_THREE_BAR_GAP'),undefined);
  const b=analyzeMarketCandles(input([bar(0),bar(1,100,{synthetic:true})]));
  assert.equal(b.evidence.quality.status,'NOT_CURRENT');
  const c=analyzeMarketCandles(input([],start));
  assert.equal(c.evidence.quality.status,'NO_DATA');
  assert.deepEqual(c.facts,[]);
});
test('strict swing confirmation requires two closed right candles and rejects ties',()=>{
  const candles=[bar(0,100),bar(1,102),bar(2,110),bar(3,103),bar(4,101)];
  assert.equal(get(analyzeMarketCandles(input(candles.slice(0,4))),'CONFIRMED_SWING_HIGH'),undefined);
  const a=analyzeMarketCandles(input(candles));
  assert.equal(get(a,'CONFIRMED_SWING_HIGH').value,'111');
  assert.equal(get(a,'CONFIRMED_SWING_HIGH').details.confirmationCloseTimeMs,start+5*step);
  candles[3]=bar(3,110);
  assert.equal(get(analyzeMarketCandles(input(candles)),'CONFIRMED_SWING_HIGH'),undefined);
});
test('three-bar gap is strict geometry, with correct bounds and no implied mitigation',()=>{
  const bull=analyzeMarketCandles(input([bar(0,100),bar(1,103),bar(2,105)]));
  assert.equal(get(bull,'LAST_THREE_BAR_GAP').value,'3');
  assert.deepEqual(get(bull,'LAST_THREE_BAR_GAP').details,{direction:'BULLISH',lower:'101',upper:'104',mitigation:'NOT_EVALUATED'});
  const bear=analyzeMarketCandles(input([bar(0,105),bar(1,103),bar(2,100)]));
  assert.equal(get(bear,'LAST_THREE_BAR_GAP').details.direction,'BEARISH');
  assert.equal(get(bear,'LAST_THREE_BAR_GAP').value,'3');
  assert.equal(get(analyzeMarketCandles(input([bar(0,100),bar(1,101),bar(2,102)])),'LAST_THREE_BAR_GAP'),undefined);
});
test('claim verifier rejects fabrication, modified values, wrong scope and duplicates',()=>{
  const x=input([bar(0),bar(1),bar(2)]);
  const a=analyzeMarketCandles(x),c=claim(a,a.facts[0]);
  assert.equal(verifyMarketClaims(x,[c]).verified,true);
  for(const bad of [{...c,value:'999'},{...c,kind:'ENTRY_PRICE'},{...c,evidenceId:'wrong'},
    {...c,factId:'fake'},{...c,extra:'trust me'},null]){
    assert.equal(verifyMarketClaims(x,[bad]).verified,false);
  }
  assert.equal(verifyMarketClaims(x,[c,c]).verified,false);
  assert.equal(verifyMarketClaims({...x,asOfMs:x.asOfMs+1},[c]).verified,false);
  assert.equal(verifyMarketClaims(x,[]).verified,false);
  const changed=input([bar(0),bar(1),bar(2,101)]);
  assert.equal(verifyMarketClaims(changed,[c]).verified,false);
});
