'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fitFocusedContext,targets}=require('../src/modules/ai/intelligence/workspace-profile-budget');
const {compactWorkspaceWireEvidence}=require('../src/modules/ai/intelligence/workspace-wire-compaction');
const {measureWorkspacePrompt}=require('../src/modules/ai/intelligence/workspace-prompt-audit');
const end=1795836600000;
function fixture(profile='STRUCTURE'){
 const data={question:'Analyse the chart',history:[],knowledge:[],account:null,
   market:{schemaVersion:'adaptive-market-v1',contextSelection:{profile},selectedTimeframe:'5m',
    quote:{status:'UNAVAILABLE'},economicCalendar:{dataStatus:'FRESH',events:[]},
    frames:['5m','1m','30m','4h'].map((timeframe,i)=>({
     timeframe,status:'HISTORICAL_ONLY',quality:{status:'RECENT_CLOSED_BAR',gaps:i===3?1:0,exclusions:{synthetic:0},contiguousCount:64},
     freshness:{state:'LATEST_EXPECTED_UTC_BUCKET'},coverage:{outOfSessionBars:0},
     closedCandles:[[end-300000,59940,59950,59930,59941]],
     observations:[{type:'STRUCTURE_EVENT',kind:'BOS',level:59941.16}],
     advanced:{methodVersion:'advanced-market-intelligence-v1',regime:{state:'RANGING'},dealingRange:{high:60250,low:59834},
       displacements:Array.from({length:3},(_,j)=>({direction:'BULLISH',atMs:end-j*300000,open:59941,close:59961,high:59965,low:59938})),
       liquidity:{levels:['BUY_SIDE','SELL_SIDE'].flatMap(side=>[
         {side,kind:'EXTERNAL_RANGE_BOUNDARY',level:side==='BUY_SIDE'?60250:59834},
         ...Array.from({length:3},(_,j)=>({side,kind:'INTERNAL_SWING',level:59940+j,confirmedAtMs:end-j*300000,state:'UNBREACHED_SINCE_CONFIRMATION',distance:j}))
       ])}}
    }))}};
 const body={messages:[{role:'system',content:'Policy'},{role:'user',content:JSON.stringify(data)}],response_format:{type:'json_schema'}};
 return {data,body};
}
function finalize(data,body){compactWorkspaceWireEvidence(data.market);body.messages[1].content=JSON.stringify(data);return {...body,stream:true,stream_options:{include_usage:true}};}
test('focused wire target preserves selected and uncertain frames and reports omission counts',()=>{
 const {data,body}=fixture();
 // Force the soft path with opaque synthetic metadata; essential content can
 // exceed a target, and is never sacrificed merely to fit it.
 body.messages[0].content='x'.repeat(targets.STRUCTURE);
 const original=structuredClone(data);
 fitFocusedContext(data,body);
 assert.deepEqual(data.market.frames[0],original.market.frames[0]);
 assert.deepEqual(data.market.frames[3],original.market.frames[3]);
 for(const i of [1,2]){
  const f=data.market.frames[i],old=original.market.frames[i];
  assert.deepEqual(f.observations,old.observations);
  assert.deepEqual(f.closedCandles,old.closedCandles);
  assert.deepEqual(f.advanced.regime,old.advanced.regime);
  assert.deepEqual(f.advanced.dealingRange,old.advanced.dealingRange);
  assert.deepEqual(f.advanced.displacements,old.advanced.displacements.slice(-1));
  assert.equal(f.advanced.omittedDisplacements,2);
  assert.equal(f.advanced.liquidity.levels.length,4);
  assert.equal(f.advanced.omittedLiquidityLevels,4);
 }
 assert.deepEqual(data.market.quote,original.market.quote);
 assert.deepEqual(data.market.economicCalendar,original.market.economicCalendar);
 const previous=measureWorkspacePrompt(finalize(original,structuredClone(body)));
 const current=measureWorkspacePrompt(finalize(data,body));
 assert.ok(current.aiPromptWireBytes<previous.aiPromptWireBytes);
 assert.equal(current.aiPromptTargetWireBytes,22000);
 assert.equal(current.aiPromptTargetExceeded,1);
});
test('liquidity intent preserves supporting liquidity records; under-target and financial contexts are unchanged',()=>{
 const {data,body}=fixture('LIQUIDITY'),original=structuredClone(data);
 fitFocusedContext(data,body);assert.deepEqual(data,original);
 body.messages[0].content='x'.repeat(targets.LIQUIDITY);
 fitFocusedContext(data,body);
 for(const [i,f] of data.market.frames.entries())assert.deepEqual(f.advanced.liquidity,original.market.frames[i].advanced.liquidity);
 const risk=fixture('STRUCTURE');risk.data.account={source:'PERSISTED_ACCOUNT_SNAPSHOT'};
 risk.body.messages[0].content='x'.repeat(targets.STRUCTURE);
 const before=structuredClone(risk.data);fitFocusedContext(risk.data,risk.body);assert.deepEqual(risk.data,before);
 const full=fixture('FULL'),old=structuredClone(full.data);fitFocusedContext(full.data,full.body);assert.deepEqual(full.data,old);
});
