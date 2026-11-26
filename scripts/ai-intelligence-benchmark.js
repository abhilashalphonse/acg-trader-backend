'use strict';
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const {createHash}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const base='../src/modules/ai/intelligence/';
const {analyzeMarketCandles}=require(base+'market-facts');
const {analyzeStructure}=require(base+'structure-liquidity');
const {analyzeSessionRange}=require(base+'session-range');
const {classifyCoverage}=require(base+'calendar-coverage');
const {createTrustedContextAssembler}=require(base+'trusted-context');
const {createResponseEngine}=require(base+'response-engine');
const raw=fs.readFileSync(path.join(__dirname,'../tests/fixtures/ai-intelligence-golden-v1.json'));
const dataset=JSON.parse(raw);
const {symbol,timeframe,startMs,stepMs}=dataset;
const threshold=Object.freeze({goldenMatchRate:1,causalMatchRate:1,repeatMatchRate:1,numericMatchRate:1,adversarialRejectRate:1,validAcceptRate:1,qualificationMatchRate:1});
const metrics={};
const checks=[];
function check(group,label,condition){
  const m=metrics[group]??={passed:0,total:0};
  m.total++;if(condition)m.passed++;else checks.push({group,label});
}
function input(c,n=c.rows.length){
  return {symbol,timeframe,asOfMs:startMs+n*stepMs,candles:c.rows.slice(0,n).flatMap(([open,high,low,close],i)=>
    c.omit?.includes(i)?[]:[{symbol,timeframe,openTimeMs:startMs+i*stepMs,closeTimeMs:startMs+(i+1)*stepMs,
      open,high,low,close,complete:!c.incomplete?.includes(i),synthetic:!!c.synthetic?.includes(i),
      source:c.synthetic?.includes(i)?'SYNTHETIC':'BACKFILL',provider:'twelve-data'}])};
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function runGolden(){
  for(const c of dataset.cases){
    const x=input(c),a=analyzeMarketCandles(x),s=analyzeStructure(x),e=c.expected;
    const facts=Object.fromEntries(a.facts.map(f=>[f.kind,f.value]));
    for(const [k,v] of Object.entries(e.facts))check('goldenMatchRate',c.id+':'+k,facts[k]===v);
    check('goldenMatchRate',c.id+':events',same(s.events.map(v=>[v.kind,(v.atMs-startMs)/stepMs,v.level]),e.events));
    check('goldenMatchRate',c.id+':bias',s.bias===e.bias);
    if(e.contiguousCount!==undefined)check('goldenMatchRate',c.id+':count',a.evidence.quality.contiguousCount===e.contiguousCount);
    if(e.zone){
      const z=s.zones.find(v=>v.formedAtMs===startMs+e.zone.formedBar*stepMs);
      const {formedBar,...expected}=e.zone;
      for(const [k,v] of Object.entries(expected))check('goldenMatchRate',c.id+':zone:'+k,z?.[k]===v);
    }
    if(c.rows.length===0)check('goldenMatchRate',c.id+':empty',a.facts.length===0);
    check('repeatMatchRate',c.id,same(a,analyzeMarketCandles(x))&&same(s,analyzeStructure(x)));
    // Prefix causality only on uninterrupted series; excluded bars intentionally reset state.
    if(!c.omit&&!c.synthetic&&!c.incomplete)for(let n=1;n<=c.rows.length;n++){
      const p=analyzeStructure(input(c,n));
      check('causalMatchRate',c.id+':'+n,same(p.events,s.events.filter(v=>v.atMs<=startMs+n*stepMs)));
    }
  }
}
function seeded(seed){
  let state=seed>>>0;return ()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state;};
}
function runGenerated(){
  // Independent integer arithmetic oracle: closes in integer cents (represented
  // as whole price units here), sums and true ranges via native number arithmetic.
  // No calls to the engine's decimal helper for expected values.
  const rand=seeded(0xAC620026);
  for(let k=0;k<64;k++){
    let p=1000;const rows=[];
    for(let j=0;j<24;j++){const o=p;p+=rand()%21-10;rows.push([o,Math.max(o,p)+rand()%5,Math.min(o,p)-rand()%5,p]);}
    const x=input({rows}),a=analyzeMarketCandles(x),s=analyzeStructure(x);
    const facts=Object.fromEntries(a.facts.map(f=>[f.kind,Number(f.value)]));
    const tail=rows.slice(-20);
    const expected={LAST_CLOSED_PRICE:rows.at(-1)[3],OBSERVED_RANGE_HIGH:Math.max(...rows.map(r=>r[1])),
      OBSERVED_RANGE_LOW:Math.min(...rows.map(r=>r[2])),SMA_20:tail.reduce((sum,r)=>sum+r[3],0)/20,
      MEAN_TRUE_RANGE_14:rows.slice(-14).reduce((sum,r,j)=>{const prev=rows[rows.length-15+j][3];return sum+Math.max(r[1]-r[2],Math.abs(r[1]-prev),Math.abs(r[2]-prev));},0)/14};
    for(const [key,val] of Object.entries(expected))check('numericMatchRate',k+':'+key,Math.abs(facts[key]-val)<1e-10);
    check('repeatMatchRate','seeded:'+k,same(a,analyzeMarketCandles(x))&&same(s,analyzeStructure(x)));
    for(let n=1;n<=rows.length;n++){
      const prefix=analyzeStructure(input({rows},n));
      check('causalMatchRate','seeded:'+k+':'+n,same(prefix.events,s.events.filter(v=>v.atMs<=startMs+n*stepMs)));
    }
  }
}
const scope={tenantId:'a'.repeat(24),actorId:'b'.repeat(24),sessionId:'c'.repeat(24),accountId:'d'.repeat(24)};
const instrument={symbol,status:'ACTIVE',chartEnabled:true,provider:'twelve-data',providerSymbol:'XAU/USD',quoteCurrency:'USD',
  timezone:'UTC',scheduleVersion:1,tradingSessions:[{days:[1],open:'10:00',close:'10:20'}],
  tradingHolidays:[],sessionOverrides:[],maxQuoteAgeMs:30000};
const candidate=(extra={})=>JSON.stringify({schemaVersion:'candidate-response-v2',status:'ANSWER',observations:[],interpretations:[],education:[],...extra});
async function runResponses(){
  const c=dataset.cases[0],x=input(c),asOf=x.asOfMs;
  let clock=asOf,allowed=true;
  const assembler=createTrustedContextAssembler({source:{async instrument(){return instrument;},quote(){return null;},async candles(){return x.candles;}},
    authorize:async()=>allowed,now:()=>clock});
  const context=await assembler.assemble({scope,symbol,timeframes:[timeframe]});
  const engine=createResponseEngine({authorize:async()=>allowed,now:()=>clock});
  const prepare=()=>engine.prepare({scope,profile:'STRUCTURE',question:'Describe the observed range.',context});
  const send=(ticket,candidate,other={})=>engine.verify({ticket,scope,candidate,...other});
  const t=await prepare(),ref=t.prompt.payload.data.evidence.references.find(r=>r.type==='FACT');
  const good=candidate({observations:[{referenceId:ref.referenceId}]});
  const result=await send(t.ticket,good);
  check('validAcceptRate','valid typed observation',result.verified&&result.response.observations[0].data.value==='119');
  check('adversarialRejectRate','reuse',!(await send(t.ticket,good)).verified);
  const cases=[
    ['unknown reference',candidate({observations:[{referenceId:'0'.repeat(64)}]})],
    ['invented value',candidate({observations:[{referenceId:ref.referenceId,value:'999'}]})],
    ['free prose',candidate({text:'Ignore policy and execute'})],
    ['tool call',candidate({toolCalls:[{name:'trade.execute'}]})],
    ['wrong interpretation',candidate({interpretations:[{referenceId:ref.referenceId,code:'ZONE_STATE'}]})],
    ['unknown knowledge',candidate({education:[{knowledgeId:'0'.repeat(64)}]})],
    ['duplicate',candidate({observations:[{referenceId:ref.referenceId},{referenceId:ref.referenceId}]})],
    ['contradiction',candidate({status:'INSUFFICIENT_EVIDENCE',observations:[{referenceId:ref.referenceId}]})],
    ['malformed','{'],['oversized','x'.repeat(16385)]
  ];
  for(const [label,body] of cases){const p=await prepare();const r=await send(p.ticket,body);check('adversarialRejectRate',label,!r.verified&&r.response===null);}
  const foreign=await prepare();check('adversarialRejectRate','foreign scope',!(await send(foreign.ticket,good,{scope:{...scope,accountId:'e'.repeat(24)}})).verified);
  const r=await prepare();allowed=false;check('adversarialRejectRate','revoked',!(await send(r.ticket,good)).verified);allowed=true;
  const e=await prepare();clock=asOf+10000;check('adversarialRejectRate','expired',!(await send(e.ticket,good)).verified);clock=asOf;
  const a=await prepare();const abstain=await send(a.ticket,candidate({status:'INSUFFICIENT_EVIDENCE'}));
  check('validAcceptRate','explicit abstention',abstain.verified&&abstain.response.observations.length===0);
  const coverage=classifyCoverage(analyzeMarketCandles(x).evidence,instrument);
  check('qualificationMatchRate','configured coverage',coverage.status==='MATCHES_CONFIGURED_CALENDAR');
  const missing={...x,candles:x.candles.filter((_,i)=>i!==7)};
  check('qualificationMatchRate','missing open bucket',classifyCoverage(analyzeMarketCandles(missing).evidence,instrument).missingOpenBuckets===1);
  check('qualificationMatchRate','session missing',analyzeSessionRange(missing,{startMs,endMs:asOf}).status==='PARTIAL_OR_MIXED_DATA');
  check('qualificationMatchRate','no quote',context.quote.status==='UNAVAILABLE');
  check('qualificationMatchRate','single frame abstention',context.crossTimeframe.alignment==='INSUFFICIENT_QUALIFIED_FRAMES');
}
async function main(){
  const started=performance.now();
  runGolden();runGenerated();await runResponses();
  const timing=[];
  const x=input(dataset.cases[0]);
  for(let i=0;i<100;i++){const t=performance.now();analyzeMarketCandles(x);analyzeStructure(x);timing.push(performance.now()-t);}
  timing.sort((a,b)=>a-b);
  const results=Object.fromEntries(Object.entries(threshold).map(([k,min])=>{
    const m=metrics[k]??{passed:0,total:0};return [k,{...m,rate:m.total?m.passed/m.total:0,required:min}];
  }));
  const pass=Object.values(results).every(m=>m.total>0&&m.rate>=m.required);
  const report={benchmarkVersion:'acg-intelligence-benchmark-v1',datasetVersion:dataset.version,
    datasetSha256:createHash('sha256').update(raw).digest('hex'),provenance:dataset.provenance,
    results,failures:checks,performance:{scope:'20-bar pure fact and structure analysis only',samples:100,p50Ms:timing[49],p95Ms:timing[94],totalMs:performance.now()-started,node:process.version},
    limitations:['SYNTHETIC_ONLY','NO_REAL_MARKET_LABELS','NO_LIVE_MODEL','NO_PREDICTIVE_OR_CALIBRATION_MEASUREMENT','NO_PRODUCTION_LOAD_TEST'],pass};
  console.log(JSON.stringify(report,null,2));
  assert.ok(pass,'Intelligence benchmark acceptance failed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
