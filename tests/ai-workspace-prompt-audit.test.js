'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {measureWorkspacePrompt,fields}=require('../src/modules/ai/intelligence/workspace-prompt-audit');
const {summarizePromptAudit}=require('../scripts/ai-workspace-prompt-audit');
const {buildWorkspaceBody}=require('../src/modules/ai/providers/funded-workspace-context');
const byte=v=>Buffer.byteLength(JSON.stringify(v),'utf8');
function fixture(){
 const data={question:'Analyse the chart',history:[{role:'user',text:'മലയാളം'},{role:'assistant',text:'Prior response'}],
   account:{source:'PERSISTED_ACCOUNT_SNAPSHOT',state:{balance:'92345.67'}},
   knowledge:[{id:'RISK_BOUNDARY',text:'No trading authority'}],
   market:{contextSelection:{profile:'BOS'},schemaVersion:'adaptive-market-v1',symbol:'BTCUSD',selectedTimeframe:'5m',
     quote:{status:'UNAVAILABLE'},quoteStatus:'UNAVAILABLE',instrument:{digits:2},economicCalendar:{events:[]},
     sizingCalculation:{executionAllowed:false},sessionClocks:[{name:'LONDON'}],
     frames:[{timeframe:'5m',closedCandles:[[1795836600000,59913.71,59950,59900,59941.16]],activeCandle:{complete:false},
       candleColumns:['openTimeMs','open','high','low','close'],observations:[{type:'STRUCTURE_EVENT',level:'59941.16'}],
       advanced:{regime:{state:'RANGING'}},closedPriceContext:{price:59941.16},
       quoteRangeLocation:null,quality:{gaps:0},freshness:{state:'LATEST_EXPECTED_UTC_BUCKET'}}]}};
 const body={model:'fixture',stream:true,stream_options:{include_usage:true},messages:[{role:'system',content:'["Read-only"]'},{role:'user',content:JSON.stringify(data)}],response_format:{type:'json_schema'}};
 return {data,body};
}
test('final message bytes partition exactly, including UTF-8, without disclosing content',()=>{
 const {data,body}=fixture(),original=structuredClone(body),report=measureWorkspacePrompt(body),f=data.market.frames[0];
 assert.equal(report.aiPromptContentBytes,body.messages.reduce((n,m)=>n+Buffer.byteLength(m.content,'utf8'),0));
 assert.equal(fields.reduce((n,k)=>n+report['aiPrompt'+k+'Bytes'],0),report.aiPromptContentBytes);
 assert.equal(report.aiPromptSystemBytes,Buffer.byteLength(body.messages[0].content));
 assert.equal(report.aiPromptHistoryBytes,byte(data.history));
 assert.equal(report.aiPromptCandlesBytes,byte(f.closedCandles)+byte(f.activeCandle)+byte(f.candleColumns));
 assert.equal(report.aiPromptAnalysisBytes,byte(f.observations)+byte(f.advanced)+byte(f.closedPriceContext)+byte(data.market.sizingCalculation));
 assert.equal(report.aiPromptAccountBytes,byte(data.account));
 assert.equal(report.aiPromptQuoteSessionBytes,byte(data.market.quote)+byte(data.market.quoteStatus)+byte(data.market.sessionClocks));
 assert.equal(report.aiPromptCalendarBytes,byte(data.market.economicCalendar));
 assert.equal(report.aiPromptInstrumentBytes,byte(data.market.instrument));
 assert.equal(report.aiPromptWireBytes,byte(body));assert.equal(report.aiPromptSchemaBytes,byte(body.response_format));
 assert.equal(report.aiPromptFrameCount,1);assert.equal(report.aiPromptCandleCount,1);assert.equal(report.aiPromptObservationCount,1);
 assert.equal(report.aiPromptHistoryCount,2);assert.equal(report.aiPromptProfile,'BOS');
 assert.ok(Object.entries(report).every(([k,v])=>k==='aiPromptProfile'?v==='BOS':Number.isSafeInteger(v)&&v>=0));
 assert.doesNotMatch(JSON.stringify(report),/92345\.67|59941\.16|BTCUSD|Prior response|Analyse the chart|മലയാളം/);
 assert.deepEqual(body,original);
});
test('real request builder: no account or market and no history leak into audit',()=>{
 const body=buildWorkspaceBody({modelId:'fixture',maxInputTokens:32768,maxOutputTokens:2048},
   {question:'Explain BOS',history:[],market:null,account:null});
 body.stream=true;body.stream_options={include_usage:true};
 const report=measureWorkspacePrompt(body);
 for(const k of ['Account','Candles','Analysis','QuoteSession','Calendar','Instrument'])assert.equal(report['aiPrompt'+k+'Bytes'],0);
 assert.equal(report.aiPromptProfile,'FULL');assert.equal(report.aiPromptFrameCount,0);
 assert.equal(report.aiPromptHistoryCount,0);assert.equal(report.aiPromptHistoryBytes,2);
 assert.equal(report.aiPromptWireBytes,byte(body));
 assert.equal(fields.reduce((n,k)=>n+report['aiPrompt'+k+'Bytes'],0),report.aiPromptContentBytes);
});
test('offline audit reconciles proportional token proxy, keeps actual total separate, and counts missing samples',()=>{
 const a=measureWorkspacePrompt(fixture().body);
 const rows=[{...a,aiOutcome:'ANSWERED',aiInputTokens:400},{...a,aiOutcome:'ANSWERED',aiInputTokens:600},
   {aiOutcome:'ANSWERED',aiInputTokens:100},{...a,aiOutcome:'ANSWERED',aiInputTokens:200,aiPromptSystemBytes:999},
   {...a,aiOutcome:'FAILED',aiInputTokens:300}];
 const report=summarizePromptAudit(rows);
 assert.equal(report.missingAuditSamples,2);
 assert.equal(report.groups.ALL.samples,2);
 assert.equal(report.groups.ALL.meanProviderInputTokens,500);
 assert.equal(report.groups.BOS.samples,2);
 const c=Object.values(report.groups.ALL.categories);
 assert.ok(Math.abs(c.reduce((n,x)=>n+x.meanByteWeightedTokenProxy,0)-500)<1e-9);
 assert.ok(Math.abs(c.reduce((n,x)=>n+x.contentByteShare,0)-1)<1e-9);
 assert.equal(c.reduce((n,x)=>n+x.meanBytes,0),a.aiPromptContentBytes);
});
