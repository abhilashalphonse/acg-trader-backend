'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildWorkspaceBody,projectAccount}=require('../src/modules/ai/providers/funded-workspace-context');
const descriptor={modelId:'fixture',maxInputTokens:32768,maxOutputTokens:2048};
const now=1795824000000;
function frame(timeframe,count){
  const closedCandles=Array.from({length:count},(_,i)=>{
    const p=90123.12345678901+i*.123456789;
    return [now-(count-i)*1800000,p,p+.123456789,p-.123456789,p+.0123456789];
  });
  const observations=[
    {type:'STRUCTURE_SUMMARY',bias:'BULLISH',status:'AVAILABLE',totals:{events:6,zones:4}},
    ...Array.from({length:6},(_,i)=>({type:'STRUCTURE_EVENT',kind:'BOS',direction:'BULLISH',atMs:now-i*1800000,level:90123.123456789,close:90124.123456789,referenceId:'a'.repeat(64),referenceConfirmedAtMs:now-86400000})),
    ...Array.from({length:4},(_,i)=>({type:'FVG_ZONE',direction:'BULLISH',lower:90123.123456789,upper:90124.123456789,formedAtMs:now-i*1800000,id:'b'.repeat(64),touchState:'UNTOUCHED'})),
    ...Array.from({length:12},(_,i)=>({type:'LIQUIDITY_REFERENCE',side:'BUY_SIDE',level:90125.123456789,confirmedAtMs:now-i*1800000,id:'c'.repeat(64)})),
    ...['LAST_CLOSED_PRICE','OBSERVED_RANGE_HIGH','OBSERVED_RANGE_LOW'].map(kind=>({type:'FACT',kind,value:90123.123456789,unit:'PRICE'}))
  ];
  return {timeframe,asOfMs:now,status:'AVAILABLE',coverage:{status:'COVERAGE_DEFECT',scheduleHash:'d'.repeat(64),missingOpenBuckets:3},quality:{inputCount:count,closedCount:count,gaps:3},freshness:{state:'LATEST_EXPECTED_UTC_BUCKET',latestClosedAtMs:now},candleColumns:['openTimeMs','open','high','low','close'],availableClosedBars:count,closedCandles,observations,
    limitations:['HISTORICAL_ONLY','NOT_EXECUTABLE'],advanced:{methodVersion:'advanced-market-intelligence-v1',throughMs:now,source:'VALIDATED_CONTIGUOUS_CLOSED_BARS',bars:count,referencePrice:90123.123456789,regime:{state:'TRENDING_UP',bars:20},dealingRange:{high:90130,low:90100},liquidity:{levels:Array.from({length:8},(_,i)=>({kind:i<2?'EXTERNAL_RANGE_BOUNDARY':'INTERNAL_SWING',side:'BUY_SIDE',level:90123+i}))},displacements:Array.from({length:3},()=>({direction:'BULLISH',atMs:now,close:90123}))}};
}
function fixture(){
  const money='123456789012345678901234.123456789012345678';
  const row={currency:'USD',accountType:'DEMO',leverage:100,updatedAt:new Date(now),state:{balance:money,equity:money,freeMargin:money},riskPolicy:{}};
  const positions=Array.from({length:21},()=>({symbol:'BTCUSD',side:'BUY',openVolume:money,entryPrice:money,stopLoss:money,takeProfit:money,margin:money,contractSize:money,openedAt:new Date(now)}));
  const orders=Array.from({length:21},()=>({symbol:'BTCUSD',side:'SELL',type:'LIMIT',status:'PENDING',requestedVolume:money,limitPrice:money,stopPrice:money,stopLoss:money,takeProfit:money,expiresAt:new Date(now)}));
  const account=projectAccount(row,positions,orders,now);
  const market={schemaVersion:'adaptive-market-v1',symbol:'BTCUSD',provider:'twelve-data',selectedTimeframe:'30m',asOfMs:now,quote:{status:'RECENT_PROVIDER_EVENT',bid:90123,ask:90124,observedAtMs:now},instrument:{digits:2},frames:['30m','5m','15m','1h','4h','1d'].map((t,i)=>frame(t,i===0?128:64)),economicCalendar:{dataStatus:'FRESH',events:[{title:'Synthetic USD release',timestamp:new Date(now+3600000).toISOString()}]}};
  return {market,account};
}
test('large six-frame BTCUSD evidence with populated account fits existing wire budget',()=>{
  const {market,account}=fixture(), before=JSON.stringify({market,account});
  const question='Analyse the current BTCUSD market structure, BOS and FVG.';
  const history=Array.from({length:6},(_,i)=>({role:i%2?'assistant':'user',text:'Trading context '.repeat(200)}));
  const body=buildWorkspaceBody(descriptor,{question,history,market,account});
  assert.ok(Buffer.byteLength(JSON.stringify(body),'utf8')+4096<=descriptor.maxInputTokens);
  assert.equal(body.reasoning_effort,'low');assert.equal(body.max_completion_tokens,2048);
  const data=JSON.parse(body.messages[1].content);
  assert.equal(data.question,question);
  assert.deepEqual(data.market.quote,market.quote);
  assert.deepEqual(data.market.economicCalendar,market.economicCalendar);
  assert.deepEqual(data.market.instrument,market.instrument);
  assert.deepEqual(data.account.state,account.state);
  assert.deepEqual(data.market.frames.map(x=>x.timeframe),market.frames.map(x=>x.timeframe));
  assert.ok(data.market.frames[0].closedCandles.length>=12);
  assert.ok(data.market.frames[0].observations.some(x=>x.type==='STRUCTURE_EVENT'));
  assert.ok(data.market.frames[0].observations.some(x=>x.type==='FVG_ZONE'));
  assert.ok(data.market.frames.some(x=>x.omittedClosedBars>0));
  for(const [i,f] of data.market.frames.entries()){
    const original=market.frames[i];
    assert.deepEqual(f.quality,original.quality);
    assert.deepEqual(f.freshness,original.freshness);
    assert.deepEqual(f.closedCandles,original.closedCandles.slice(original.closedCandles.length-f.closedCandles.length));
    assert.equal(f.omittedClosedBars??0,original.closedCandles.length-f.closedCandles.length);
    assert.equal(f.omittedObservations??0,original.observations.length-f.observations.length);
  }
  assert.equal(JSON.stringify({market,account}),before);
  assert.equal(data.account.omittedPositions??0,account.positions.length-data.account.positions.length);
  assert.equal(data.account.omittedPendingOrders??0,account.pendingOrders.length-data.account.pendingOrders.length);
});
test('impossible budget still fails closed without widening cap',()=>{
  const {market,account}=fixture();
  assert.throws(()=>buildWorkspaceBody({...descriptor,maxInputTokens:4096},{question:'Analyse BTCUSD.',history:[],market,account}),{code:'AI_WORKSPACE_CONTEXT_BUDGET'});
});
