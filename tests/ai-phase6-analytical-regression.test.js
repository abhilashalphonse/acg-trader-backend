'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildWorkspaceBody}=require('../src/modules/ai/providers/funded-workspace-context');
const {projectEconomicCalendar}=require('../src/modules/ai/intelligence/economic-calendar-context');
const descriptor={modelId:'fixture',maxInputTokens:32768,maxOutputTokens:2048};
const end=1795824000000;
function fixture(){
 const account={source:'PERSISTED_ACCOUNT_SNAPSHOT',currency:'USD',leverage:100,updatedAt:'2026-11-27T08:00:00Z',
   state:{balance:'99939.78',equity:'99939.78',freeMargin:'99939.78'},riskPolicy:{},positions:[],pendingOrders:[],positionsTruncated:false,ordersTruncated:false};
 const market={schemaVersion:'adaptive-market-v1',symbol:'XAUUSD',provider:'twelve-data',selectedTimeframe:'5m',asOfMs:end,
   instrument:{digits:2,quoteCurrency:'USD',sizingSpecifications:{pipSize:'0.01',contractSize:'100',volumeStep:'0.01',minVolume:'0.01',maxVolume:'100',
      quoteCurrency:'USD',marginCurrency:'USD',pnlCurrency:'USD',defaultLeverage:50,marginRate:null,commissionPerLotPerSide:'0',commissionRate:'0'}},
   quote:{status:'RECENT_PROVIDER_EVENT',bid:3679.9,ask:3680,observedAtMs:end-100},
   sessionClocks:[{name:'LONDON',state:'CLOSED'}],sessionRanges:[{name:'LONDON',range:{status:'PARTIAL',high:3682,low:3670}}],
   frames:[['5m',300000],['1m',60000],['30m',1800000],['4h',14400000]].map(([timeframe,step])=>({
      timeframe,status:'HISTORICAL_ONLY',asOfMs:end,availableClosedBars:32,
      closedCandles:Array.from({length:32},(_,i)=>[end-(32-i)*step,3670+i/4,3672+i/4,3669+i/4,3671+i/4]),
      quality:{status:'RECENT_CLOSED_BAR',gaps:0,exclusions:{synthetic:0,incomplete:0},contiguousCount:32,closedCount:32},
      freshness:{state:'LATEST_EXPECTED_UTC_BUCKET',latestClosedAtMs:end},coverage:{outOfSessionBars:0},
      activeCandle:{complete:false},
      observations:[{type:'STRUCTURE_SUMMARY',bias:'MIXED'},{type:'STRUCTURE_EVENT',kind:'BOS',level:3674.25},
        {type:'FVG_ZONE',lower:3672.15,upper:3672.75},{type:'LIQUIDITY_REFERENCE',level:3680.25},
        {type:'FACT',kind:'LAST_CLOSED_PRICE',value:3678.75},{type:'FACT',kind:'SMA_20',value:3676.375}],
      advanced:{methodVersion:'advanced-market-intelligence-v1',regime:{state:'RANGING'},
        dealingRange:{high:3679.75,low:3669},liquidity:{levels:[{kind:'EXTERNAL_RANGE_BOUNDARY',level:3679.75}]},displacements:[]}
   }))};
 market.economicCalendar=projectEconomicCalendar({market,nowMs:end,snapshot:{dataStatus:'FRESH',coverageFrom:new Date(end-3600000).toISOString(),coverageTo:new Date(end+86400000).toISOString(),fetchedAt:new Date(end-1000).toISOString(),events:[{title:'Synthetic USD event',currency:'USD',impact:'HIGH',timestamp:new Date(end+1800000).toISOString()}]}});
 return {market,account};
}
function build(question,market,account,history=[]){
 const original=structuredClone({market,account,history});
 const body=buildWorkspaceBody(descriptor,{question,history,market,account});
 assert.deepEqual({market,account,history},original);
 assert.ok(Buffer.byteLength(JSON.stringify(body),'utf8')+4096<=descriptor.maxInputTokens);
 assert.equal(body.store,false);
 assert.equal(body.max_completion_tokens,2048);
 assert.equal(body.tools,undefined);
 return {data:JSON.parse(body.messages[1].content),policy:body.messages[0].content};
}
test('6G integrated focused market matrix preserves task-critical facts across compression and account minimization',()=>{
 const {market,account}=fixture();
 for(const [question,profile,required] of [
   ['Analyse the current XAUUSD market structure.','STRUCTURE',['STRUCTURE_SUMMARY','STRUCTURE_EVENT','FVG_ZONE','LIQUIDITY_REFERENCE']],
   ['Identify the latest BOS','BOS',['STRUCTURE_EVENT']],
   ['Find the recent FVGs on XAUUSD','FVG',['FVG_ZONE']],
   ['Find liquidity levels on XAUUSD','LIQUIDITY',['LIQUIDITY_REFERENCE']],
   ['Analyse the chart','MARKET_OVERVIEW',['STRUCTURE_SUMMARY','FVG_ZONE']]
 ]){
   const {data}=build(question,market,account);
   assert.equal(data.market.contextSelection.profile,profile);
   assert.equal(data.account,null);
   assert.deepEqual(data.market.frames.map(f=>f.timeframe),market.frames.map(f=>f.timeframe));
   for(const [i,f] of data.market.frames.entries()){
     const source=market.frames[i];
     for(const type of required)assert.deepEqual(f.observations.filter(o=>o.type===type),source.observations.filter(o=>o.type===type));
     for(const key of ['advanced','quality','coverage','freshness','activeCandle'])assert.deepEqual(f[key],source[key]);
     assert.deepEqual(f.closedCandles,source.closedCandles.slice(-f.closedCandles.length));
     const narrow=['BOS','FVG','LIQUIDITY'].includes(profile);
     assert.equal(f.closedCandles.length,narrow?(i===0?24:i===1?8:4):(i===0?32:i===1?16:8));
     if(narrow)assert.equal(f.narrowRawHistoryProjection.derivedEvidenceUsesOriginalWindow,true);
     else assert.equal(f.narrowRawHistoryProjection,undefined);
   }
 }
});
test('6G quote, calendar and session questions retain exact states without false current claims',()=>{
 const {market,account}=fixture();
 market.quote={status:'UNAVAILABLE',reason:'QUOTE_STALE',observedQuote:{bid:3679.9,ask:3680}};
 market.frames[2].freshness.state='MISSING_RECENT_CLOSED_BUCKET';
 market.frames[2].quality.gaps=1;
 for(const q of ['What is the current price of XAUUSD?','Show the economic calendar','Which trading session is open?','Analyse the chart']){
   const {data,policy}=build(q,market,account);
   for(const k of ['quote','economicCalendar','sessionClocks','sessionRanges'])assert.deepEqual(data.market[k],market[k]);
   assert.equal(data.market.frames[2].rawHistoryProjection,undefined);
   assert.deepEqual(data.market.frames[2].quality,market.frames[2].quality);
   assert.match(policy,/Never invent a quote or an open session/);
 }
 assert.equal(market.economicCalendar.events[0].timing,'UPCOMING');
 market.economicCalendar={...market.economicCalendar,dataStatus:'EXPIRED',events:[],noMatchingEventsInCoveredWindow:false};
 assert.deepEqual(build('Show the economic calendar',market,account).data.market.economicCalendar,market.economicCalendar);
});
test('6G exact sizing, stale quote and missing account retain deterministic limitations',()=>{
 const {market,account}=fixture();
 const q='Based on my current account balance and open margin, calculate the exact lot size for a 0.5% risk trade on XAUUSD with a 15-pip stop loss.';
 const {data}=build(q,market,account);
 assert.deepEqual(data.account,account);
 assert.equal(data.market.sizingCalculation.estimatedLots,'13.56');
 assert.equal(data.market.sizingCalculation.estimatedRequiredMargin,'99801.6');
 assert.equal(data.market.sizingCalculation.executionAllowed,false);
 market.quote={status:'UNAVAILABLE',reason:'QUOTE_STALE'};
 const stale=build(q,market,account).data.market.sizingCalculation;
 assert.equal(stale.riskLimitedLots,'33.31');
 assert.equal(stale.estimatedLots,undefined);
 assert.equal(build(q,market,null).data.market.sizingCalculation.status,'ACCOUNT_CONTEXT_UNAVAILABLE');
});
test('6G compound, risk, setup and conversational requests retain financial scope and exact recent references',()=>{
 const {market,account}=fixture();
 account.positionsTruncated=true;
 account.positions=[{symbol:'XAUUSD',side:'BUY',openVolume:'0.1',entryPrice:'3674.25'}];
 for(const q of ['Review my account risk','Can I enter a short here?','Analyse the chart and my account','XAUUSD ഇപ്പോൾ എങ്ങനെയാണ്?']){
   const {data,policy}=build(q,market,account);
   assert.deepEqual(data.account,account);
   assert.equal(data.market.contextSelection,undefined);
   assert.match(policy,/Do not claim complete account risk from truncated lists/);
 }
 const history=[{role:'user',text:'What is the invalidation?'},{role:'assistant',text:'3674.25 conditional on a completed 5m close.'}];
 const {data,policy}=build('What about that level now?',market,account,history);
 assert.deepEqual(data.history,history);assert.deepEqual(data.account,account);
 assert.match(policy,/Revalidate prior market conclusions and account values/);
 assert.equal(build('Review my account risk',null,null).data.account,null);
});
