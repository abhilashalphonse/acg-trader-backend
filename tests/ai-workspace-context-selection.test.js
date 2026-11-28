'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classifyWorkspaceQuestion,classifyWorkspaceIntent,workspaceEvidenceProfile,selectWorkspaceEvidence,compressSupportingFrames}=require('../src/modules/ai/intelligence/workspace-context-selection');
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

test('phase 6A classifies bounded explicit intents without changing legacy evidence scope',()=>{
  const cases=[
    ['Analyse the current BTCUSD market structure.','STRUCTURE'],
    ['What is the current price of BTCUSD?','QUOTE'],
    ['Find the recent FVGs on BTCUSD','FVG'],
    ['Identify the latest BOS','BOS'],
    ["What's happening with gold?",'MARKET_OVERVIEW'],
    ['Analyse the chart','MARKET_OVERVIEW'],
    ['Find liquidity levels on BTCUSD','LIQUIDITY'],
    ['Can I enter a short here?','SETUP'],
    ['Are there any trading setups?','SETUP'],
    ['Review my account risk','ACCOUNT_RISK'],
    ['Calculate the position size','SIZING'],
    ['Show the economic calendar','CALENDAR'],
    ['Which trading session is open?','SESSION'],
    ['Explain fair value gaps','EDUCATION'],
    ['Analyse account','FULL'],
    ['Analyse the market and my risk','FULL'],
    ['BTCUSD ഇപ്പോൾ എങ്ങനെയാണ്?','FULL']
  ];
  for(const [q,intent] of cases)assert.equal(classifyWorkspaceIntent(q),intent,q);
  assert.equal(classifyWorkspaceIntent('What about that level?',[{role:'user',text:'Review the chart'}]),'FOLLOW_UP');
  assert.equal(classifyWorkspaceQuestion('Can I enter a short here?'),'FULL');
  assert.equal(classifyWorkspaceQuestion('Calculate the position size'),'FULL');
});

test('6B selects only bounded intents and preserves source scope, session and calendar evidence',()=>{
  const market=fixture();
  market.sessionClocks=[{name:'LONDON',state:'WEEKEND'}];
  market.sessionRanges=[{name:'LONDON',range:{status:'PARTIAL',high:59060,low:59010}}];
  market.economicCalendar={dataStatus:'FRESH',events:[{title:'Fixture event',scheduledAtMs:1795824000000}]};
  const original=JSON.stringify(market),account={state:{equity:'1000'},positions:[]};
  for(const [question,profile,cap,secondary] of [
    ['Analyse the chart','MARKET_OVERVIEW',48,16],
    ['Find liquidity levels on BTCUSD','LIQUIDITY',48,16],
    ['Which trading session is open?','SESSION',8,4],
    ['Show the economic calendar','CALENDAR',1,0]
  ]){
    const body=buildWorkspaceBody(descriptor,{question,history:[],market,account});
    const data=JSON.parse(body.messages[1].content);
    assert.equal(data.market.contextSelection.profile,profile);
    assert.equal(data.market.contextSelection.omittedEvidenceIsNotAbsent,true);
    assert.equal(data.market.frames[0].closedCandles.length,cap);
    assert.equal(data.market.frames[1].closedCandles.length,secondary);
    for(const key of ['quote','economicCalendar','sessionClocks','sessionRanges','instrument'])assert.deepEqual(data.market[key],market[key]);
    assert.equal(data.account,null);
    for(const [i,frame] of data.market.frames.entries()){
      assert.deepEqual(frame.closedCandles,market.frames[i].closedCandles.slice(64-frame.closedCandles.length));
      assert.equal(frame.omittedClosedBars,64-frame.closedCandles.length);
      for(const key of ['quality','freshness','activeCandle'])assert.deepEqual(frame[key],market.frames[i][key]);
      assert.deepEqual(frame.advanced.regime,market.frames[i].advanced.regime);
      assert.deepEqual(frame.advanced.dealingRange,market.frames[i].advanced.dealingRange);
    }
    const refs=data.market.frames[0].observations;
    if(profile==='MARKET_OVERVIEW')assert.ok(refs.some(o=>o.kind==='SMA_20'));
    if(profile==='LIQUIDITY')assert.ok(refs.some(o=>o.type==='LIQUIDITY_REFERENCE'));
    const full=buildWorkspaceBody(descriptor,{question,history:[{role:'user',text:'Review all evidence'}],market,account});
    assert.ok(Buffer.byteLength(JSON.stringify(body))<Buffer.byteLength(JSON.stringify(full)));
  }
  assert.equal(JSON.stringify(market),original);
  for(const question of ['Can I enter a short here?','Calculate the position size','Review my account risk','Explain fair value gaps','Analyse the chart and my account','BTCUSD ഇപ്പോൾ എങ്ങനെയാണ്?'])assert.equal(workspaceEvidenceProfile(question,[],market),'FULL');
  assert.equal(workspaceEvidenceProfile('Show the economic calendar',[{role:'user',text:'Explain my trade'}],market),'FULL');
  assert.equal(workspaceEvidenceProfile('Analyse the chart',[],null),'FULL');
});

function compressionFixture(){
  const market=fixture();
  const steps={'5m':300000,'1m':60000,'30m':1800000,'4h':14400000};
  for(const f of market.frames){
    const step=steps[f.timeframe],end=1795824000000;
    f.closedCandles=f.closedCandles.map((b,i)=>[end-(64-i)*step,b[1]+0.01234567,b[2]+0.01234567,b[3]+0.01234567,b[4]+0.01234567]);
    f.status='HISTORICAL_ONLY';
    f.quality={status:'RECENT_CLOSED_BAR',gaps:0,exclusions:{incomplete:0,synthetic:0},contiguousCount:64,closedCount:64};
    f.freshness={state:'LATEST_EXPECTED_UTC_BUCKET',latestClosedAtMs:end};
    f.coverage={outOfSessionBars:0,coverageVerified:true};
    f.advanced={...f.advanced,regime:{state:'RANGING',bars:20},dealingRange:{high:59063,low:58999,bars:48},
      liquidity:{levels:[{side:'BUY_SIDE',kind:'INTERNAL_SWING',level:59035}]},
      displacements:[{direction:'BULLISH',atMs:end,close:59062}]};
  }
  return market;
}
test('6C shortens only healthy higher-frame tails and preserves exact prices and all derived evidence',()=>{
  for(const profile of ['STRUCTURE','MARKET_OVERVIEW','BOS','FVG','LIQUIDITY']){
    const data={market:compressionFixture(),knowledge:[{id:'EVIDENCE_QUALITY'},{id:'RISK_BOUNDARY'}]};
    selectWorkspaceEvidence(data,profile);
    const before=structuredClone(data.market);
    compressSupportingFrames(data.market);
    assert.ok(Buffer.byteLength(JSON.stringify(data.market))<Buffer.byteLength(JSON.stringify(before)),profile);
    for(const [i,f] of data.market.frames.entries()){
      const previous=before.frames[i];
      if(i<2){assert.deepEqual(f,previous);continue;}
      assert.deepEqual(f.closedCandles,previous.closedCandles.slice(-8));
      assert.equal(f.omittedClosedBars,56);
      assert.equal(f.rawHistoryProjection.derivedEvidenceUsesOriginalWindow,true);
      assert.equal(f.rawHistoryProjection.omittedAdditionalBars,8);
      for(const key of ['quality','freshness','coverage','observations','advanced','activeCandle'])assert.deepEqual(f[key],previous[key]);
    }
    for(const key of ['quote','instrument','economicCalendar','contextSelection'])assert.deepEqual(data.market[key],before[key]);
    const once=structuredClone(data.market);
    compressSupportingFrames(data.market);
    assert.deepEqual(data.market,once);
  }
});
test('6C keeps uncertain, gapped and unavailable frames and complex requests unchanged',()=>{
  for(const mutate of [
    f=>{f.quality.gaps=1;},
    f=>{f.quality.exclusions.synthetic=1;},
    f=>{f.quality.contiguousCount=19;},
    f=>{delete f.quality.contiguousCount;},
    f=>{f.freshness.state='CHECK_COVERAGE';},
    f=>{f.status='UNAVAILABLE';},
    f=>{f.coverage.outOfSessionBars=1;},
    f=>{delete f.advanced.dealingRange;}
  ]){
    const data={market:compressionFixture(),knowledge:[]};
    selectWorkspaceEvidence(data,'STRUCTURE');
    mutate(data.market.frames[2]);
    const previous=structuredClone(data.market.frames[2]);
    compressSupportingFrames(data.market);
    assert.deepEqual(data.market.frames[2],previous);
  }
  const market=compressionFixture(),original=JSON.stringify(market);
  compressSupportingFrames(market);
  assert.equal(JSON.stringify(market),original);
  const body=buildWorkspaceBody(descriptor,{question:'Analyse the current BTCUSD market structure.',history:[],market,account:null});
  const projected=JSON.parse(body.messages[1].content).market;
  assert.equal(projected.frames[0].closedCandles.length,48);
  assert.equal(projected.frames[1].closedCandles.length,16);
  assert.equal(projected.frames[2].closedCandles.length,8);
  assert.equal(JSON.stringify(market),original);
});

test('6E omits authorized account data only for standalone focused market requests',()=>{
 const market=fixture();
 const account={source:'PERSISTED_ACCOUNT_SNAPSHOT',asOfMs:1795824000000,currency:'USD',state:{equity:'1000',balance:'1000',freeMargin:'500'},positions:[{symbol:'BTCUSD',side:'BUY',openVolume:'0.1',entryPrice:'59000'}],pendingOrders:[],riskPolicy:{maxPositionVolume:'0.5'}};
 const original=structuredClone(account);
 const build=(question,history=[],m=market,a=account)=>JSON.parse(buildWorkspaceBody(descriptor,{question,history,market:m,account:a}).messages[1].content);
 for(const q of ['Analyse the current BTCUSD market structure.','Find the recent FVGs on BTCUSD','Identify the latest BOS','Find liquidity levels on BTCUSD','What is the current price of BTCUSD?','Analyse the chart','Show the economic calendar','Which trading session is open?']){
   const d=build(q);assert.equal(d.account,null,q);
   assert.deepEqual(d.market.quote,market.quote);
 }
 for(const q of ['Review my account risk','Calculate the position size','Can I enter a short here?','Analyse the chart and my account','Explain fair value gaps','BTCUSD ഇപ്പോൾ എങ്ങനെയാണ്?']){
   assert.deepEqual(build(q).account,account,q);
 }
 assert.deepEqual(build('Analyse the chart',[{role:'user',text:'Review my account'}]).account,account);
 assert.deepEqual(build('Analyse the chart',[],null).account,account);
 assert.equal(build('Review my account risk',[],market,null).account,null);
 assert.deepEqual(account,original);
});
