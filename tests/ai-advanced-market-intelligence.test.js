'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createCandleEvidence}=require('../src/modules/ai/intelligence/candle-evidence');
const {analyzeStructure}=require('../src/modules/ai/intelligence/structure-liquidity');
const {analyzeAdvancedMarket,quoteRangeLocation}=require('../src/modules/ai/intelligence/advanced-market-intelligence');
const start=Date.UTC(2026,10,27,0,0),step=60000;
function fixture(closes,mutate=(b)=>b){
  const candles=closes.map((close,i)=>{
    const open=i?closes[i-1]:close-.1;
    return mutate({symbol:'TEST',timeframe:'1m',openTimeMs:start+i*step,closeTimeMs:start+(i+1)*step,
      open,high:Math.max(open,close)+.1,low:Math.min(open,close)-.1,close,complete:true,synthetic:false,source:'BACKFILL',provider:'twelve-data'},i);
  });
  return {symbol:'TEST',timeframe:'1m',asOfMs:Math.max(...candles.map(b=>b.closeTimeMs)),candles};
}
function report(input){return analyzeAdvancedMarket({evidence:createCandleEvidence(input),structure:analyzeStructure(input),tickSize:.01});}
test('regime distinguishes directional and non-directional observations',()=>{
  assert.equal(report(fixture(Array.from({length:24},(_,i)=>100+i))).regime.state,'TRENDING_UP');
  assert.equal(report(fixture(Array.from({length:24},(_,i)=>150-i))).regime.state,'TRENDING_DOWN');
  assert.equal(report(fixture(Array.from({length:24},(_,i)=>100+i%2))).regime.state,'COMPRESSION');
  assert.equal(report(fixture([100,101])).regime.state,'INSUFFICIENT_BARS');
});
test('range boundaries, equilibrium and price location use observed extrema',()=>{
  const r=report(fixture(Array.from({length:48},(_,i)=>100+i)));
  assert.equal(r.dealingRange.bars,48);assert.equal(r.dealingRange.location,'PREMIUM');
  const {high,low}=r.dealingRange;
  const mid=(high+low)/2;
  const q=quoteRangeLocation(r,{status:'RECENT_PROVIDER_EVENT',bid:mid-.01,ask:mid+.01,observedAtMs:123,isSyntheticSpread:true});
  assert.equal(q.location,'EQUILIBRIUM');assert.equal(q.region,'MIDDLE_40_PERCENT');
  assert.equal(quoteRangeLocation(r,{status:'UNAVAILABLE'}),null);
  assert.equal(r.liquidity.levels.filter(l=>l.kind==='EXTERNAL_RANGE_BOUNDARY').length,2);
  assert.equal(r.liquidity.definition,'PRICE_STRUCTURE_PROXY_NOT_OBSERVED_ORDERS');
});
test('displacement requires directional body, range and close location relative to preceding bars',()=>{
  const series=Array.from({length:24},(_,i)=>100+i%2*.2);
  series[20]=103;series[21]=103.1;series[22]=103;series[23]=103.1;
  const r=report(fixture(series));
  const d=r.displacements.find(x=>x.atMs===start+21*step);
  assert.ok(d);assert.equal(d.direction,'BULLISH');assert.equal(d.baselineThroughMs,start+20*step);
  const prefix=report(fixture(series.slice(0,21)));
  assert.deepEqual(prefix.displacements.at(-1),d);
  assert.ok(!report(fixture(Array.from({length:24},(_,i)=>100+i%2*.2),(b,i)=>i===20?{...b,high:b.high+10}:b)).displacements.length);
});
test('gap prevents historical patterns from crossing unverified missing intervals',()=>{
  const r=report(fixture(Array.from({length:30},(_,i)=>100+i),(b,i)=>i>=25?{...b,openTimeMs:b.openTimeMs+step,closeTimeMs:b.closeTimeMs+step}:b));
  assert.equal(r.bars,5);assert.equal(r.regime.state,'INSUFFICIENT_BARS');assert.equal(r.dealingRange,null);assert.deepEqual(r.displacements,[]);
});
test('clusters only use confirmed internal pivots, with later close breaks removed',()=>{
  const input=fixture(Array.from({length:40},(_,i)=>100+[0,1,2,1,0,-1,-2,-1][i%8]),(b,i)=>({...b,high:b.high+i*.0001,low:b.low-i*.0001}));
  const e=createCandleEvidence(input);
  const structure={evidenceId:e.evidenceId,pivots:[
    {side:'HIGH',level:101.5,pivotOpenTimeMs:start+31*step,confirmedAtMs:start+34*step},
    {side:'HIGH',level:101.51,pivotOpenTimeMs:start+32*step,confirmedAtMs:start+35*step},
    {side:'LOW',level:99,pivotOpenTimeMs:start+29*step,confirmedAtMs:start+32*step},
    {side:'HIGH',level:101,pivotOpenTimeMs:start+37*step,confirmedAtMs:start+50*step}]};
  const r=analyzeAdvancedMarket({evidence:e,structure,tickSize:.02});
  const cluster=r.liquidity.levels.find(l=>l.kind==='INTERNAL_CLUSTER');
  assert.ok(cluster);assert.equal(cluster.touches,2);assert.equal(cluster.side,'BUY_SIDE');
  assert.ok(!r.liquidity.levels.some(l=>l.kind==='INTERNAL_SWING'&&l.level===99));
  assert.throws(()=>analyzeAdvancedMarket({evidence:e,structure:{evidenceId:'other'}}));
});
