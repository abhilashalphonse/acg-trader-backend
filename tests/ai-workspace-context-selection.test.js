'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classifyWorkspaceQuestion,selectWorkspaceEvidence}=require('../src/modules/ai/intelligence/workspace-context-selection');
const {buildWorkspaceBody}=require('../src/modules/ai/providers/funded-workspace-context');
const descriptor={modelId:'fixture',maxInputTokens:32768,maxOutputTokens:2048};
test('standalone explicit queries classify conservatively, all other intents keep full context',()=>{
  for(const [q,p] of [
    ['Analyse the current BTCUSD market structure.','STRUCTURE'],
    ['What is the current price of BTCUSD?','QUOTE'],
    ['Find the recent FVGs on BTCUSD','FVG'],
    ['Identify the latest BOS','BOS'],
    ['Analyse my account and chart.','FULL'],
    ['Analyse market structure and FVGs','FULL'],
    ['Calculate the position size','FULL'],
    ['What about the previous level?','FULL'],
    ['BTCUSD ഇപ്പോൾ എങ്ങനെയാണ്?','FULL']
  ])assert.equal(classifyWorkspaceQuestion(q),p,q);
  assert.equal(classifyWorkspaceQuestion('Find the recent FVGs',[{role:'user',text:'Review my account'}]),'FULL');
});
function fixture(){
 const bars=Array.from({length:64},(_,i)=>[1795824000000+i*300000,59000+i,59001+i,58999+i,59000+i]);
 const observations=[{type:'STRUCTURE_SUMMARY',bias:'MIXED'},{type:'STRUCTURE_EVENT',kind:'BOS',level:59012},{type:'FVG_ZONE',lower:59001,upper:59002},{type:'LIQUIDITY_REFERENCE',level:59003},{type:'FACT',kind:'LAST_CLOSED_PRICE',value:59063},{type:'FACT',kind:'SMA_20',value:59042}];
 return {schemaVersion:'adaptive-market-v1',symbol:'BTCUSD',provider:'twelve-data',selectedTimeframe:'5m',quote:{status:'UNAVAILABLE',reason:'QUOTE_STALE'},instrument:{digits:2},economicCalendar:{dataStatus:'FRESH',events:[]},frames:['5m','1m','30m','4h'].map(timeframe=>({timeframe,closedCandles:bars.map(b=>[...b]),availableClosedBars:64,observations:structuredClone(observations),quality:{gaps:1,closedCount:64},freshness:{state:'CHECK_COVERAGE'},activeCandle:{complete:false},advanced:{methodVersion:'advanced-market-intelligence-v1',regime:{state:'RANGING'},dealingRange:{high:59063,low:58999}}}))};
}
test('structure projection reduces wire bytes, retains quote, calendar, coverage and latest exact observations',()=>{
 const market=fixture(),original=JSON.stringify(market);
 const q='Analyse the current BTCUSD market structure.';
 const focused=buildWorkspaceBody(descriptor,{question:q,history:[],market,account:null});
 const data=JSON.parse(focused.messages[1].content);
 assert.equal(data.market.contextSelection.profile,'STRUCTURE');
 assert.equal(data.market.frames[0].closedCandles.length,48);
 assert.equal(data.market.frames[1].closedCandles.length,16);
 for(const [i,f] of data.market.frames.entries()){
   assert.deepEqual(f.closedCandles,market.frames[i].closedCandles.slice(-f.closedCandles.length));
   assert.equal(f.omittedClosedBars,64-f.closedCandles.length);
   assert.deepEqual(f.quality,market.frames[i].quality);
   assert.deepEqual(f.freshness,market.frames[i].freshness);
   assert.deepEqual(f.activeCandle,market.frames[i].activeCandle);
   assert.ok(f.observations.some(o=>o.type==='STRUCTURE_EVENT'));
   assert.ok(f.observations.some(o=>o.type==='FVG_ZONE'));
 }
 assert.deepEqual(data.market.quote,market.quote);
 assert.deepEqual(data.market.economicCalendar,market.economicCalendar);
 assert.equal(JSON.stringify(market),original);
 const full=buildWorkspaceBody(descriptor,{question:q,history:[{role:'user',text:'Review all relevant evidence'}],market,account:null});
 assert.ok(Buffer.byteLength(JSON.stringify(focused))<Buffer.byteLength(JSON.stringify(full)));
});
test('quote focus cannot convert stale quote into a live quote',()=>{
 const data={market:fixture(),knowledge:[{id:'EVIDENCE_QUALITY'},{id:'RISK_BOUNDARY'},{id:'FVG'}]};
 const quote=structuredClone(data.market.quote);
 selectWorkspaceEvidence(data,'QUOTE');
 assert.deepEqual(data.market.quote,quote);
 assert.equal(data.market.frames[0].closedCandles.length,1);
 assert.equal(data.market.frames[1].closedCandles.length,0);
 assert.equal(data.market.frames[1].omittedClosedBars,64);
 assert.equal(data.knowledge.length,2);
});
