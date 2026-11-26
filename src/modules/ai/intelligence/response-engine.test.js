'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTrustedContextAssembler}=require('./trusted-context');
const {createResponseEngine,MAX_RESPONSE_BYTES}=require('./response-engine');
const start=Date.UTC(2026,0,5,10),step=60000,asOf=start+7*step;
const scope={tenantId:'a'.repeat(24),actorId:'b'.repeat(24),sessionId:'c'.repeat(24),accountId:'d'.repeat(24)};
const foreign={...scope,accountId:'e'.repeat(24)};
const instrument={symbol:'XAUUSD',status:'ACTIVE',chartEnabled:true,provider:'twelve-data',providerSymbol:'XAU/USD',
  quoteCurrency:'USD',timezone:'UTC',scheduleVersion:1,tradingSessions:[{days:[1],open:'00:00',close:'23:59'}],
  tradingHolidays:[],sessionOverrides:[],maxQuoteAgeMs:30000};
const rows=[[100,103,97,100],[100,104,96,101],[101,110,90,102],
  [102,105,95,103],[103,106,94,104],[104,112,101,106],[106,115,105,112]];
async function fixture(){
  let clock=asOf,auth=true,checks=0,after=null;
  const candles=rows.map(([open,high,low,close],i)=>({symbol:'XAUUSD',timeframe:'1m',
    openTimeMs:start+i*step,closeTimeMs:start+(i+1)*step,open,high,low,close,
    complete:true,synthetic:false,source:'BACKFILL',provider:'twelve-data'}));
  const q={symbol:'XAUUSD',providerSymbol:'XAU/USD',source:'twelve-data',receivedAtMs:asOf-1000,
    providerTimestampMs:asOf-25000,isStale:false,sessionOpen:true,bid:112,ask:113,isSyntheticSpread:true};
  const assembler=createTrustedContextAssembler({source:{async instrument(){return structuredClone(instrument);},quote(){return q;},async candles(){return candles;}},
    authorize:async()=>true,now:()=>asOf});
  const context=await assembler.assemble({scope,symbol:'XAUUSD',timeframes:['1m'],sessionWindows:[{timeframe:'1m',startMs:start,endMs:asOf}]});
  const engine=createResponseEngine({authorize:async req=>{checks++;assert.deepEqual(req.scope,scope);if(after)after(checks);return auth;},now:()=>clock});
  const prepare=(extra={})=>engine.prepare({scope,profile:'STRUCTURE',question:'Explain gold structure',context,...extra});
  const verify=(ticket,candidate,extra={})=>engine.verify({ticket,scope,candidate:typeof candidate==='string'?candidate:JSON.stringify(candidate),...extra});
  return {engine,context,prepare,verify,candles,q,advance:n=>{clock+=n;},deny:()=>{auth=false;},after:f=>{after=f;},checks:()=>checks};
}
const candidate=(extra={})=>({schemaVersion:'candidate-response-v2',status:'ANSWER',observations:[],interpretations:[],education:[],...extra});
const find=(p,type)=>p.payload.data.evidence.references.find(r=>r.type===type);
test('independent replay verifies typed facts and advanced references; output is server-rendered',async()=>{
  const f=await fixture(),{ticket,prompt}=await f.prepare();
  const fact=find(prompt,'FACT'),event=find(prompt,'STRUCTURE_EVENT'),zone=find(prompt,'FVG_ZONE'),session=find(prompt,'SESSION_RANGE');
  // Mutating source objects after assembly does not change pinned evidence.
  f.candles[0].close=999;f.q.bid=999;
  const k=prompt.payload.data.knowledge.entries[0];
  const result=await f.verify(ticket,candidate({
    observations:[fact,event,zone,session].map(r=>({referenceId:r.referenceId})),
    interpretations:[{referenceId:event.referenceId,code:'SWEEP_OR_BREAK'}],
    education:[{knowledgeId:k.knowledgeId}]
  }));
  assert.equal(result.verified,true);
  assert.equal(result.response.verification,'RECOMPUTED_REFERENCE_SELECTION_ONLY');
  assert.deepEqual(result.response.observations[0],fact);
  assert.deepEqual(result.response.observations[1],event);
  assert.deepEqual(result.response.education[0],k);
  assert.equal(result.response.symbol,'XAUUSD');
  assert.equal(result.response.expiresAtMs,asOf+5000);
  assert.ok(Object.isFrozen(result.response.observations[0]));
  assert.equal(JSON.stringify(result.response).includes(scope.accountId),false);
  assert.equal(JSON.stringify(result.response).includes('999'),false);
  assert.equal(f.checks(),3);
  assert.equal((await f.verify(ticket,candidate())).verified,false);
});
test('reject arbitrary text, fabricated numbers, unknown keys, malformed JSON and oversized response',async()=>{
  const f=await fixture();
  for(const make of [
    p=>candidate({observations:[{referenceId:find(p,'FACT').referenceId,value:'999'}]}),
    p=>candidate({interpretations:[{referenceId:find(p,'STRUCTURE_EVENT').referenceId,code:'SWEEP_OR_BREAK',text:'execute trade'}]}),
    p=>candidate({education:[{knowledgeId:p.payload.data.knowledge.entries[0].knowledgeId,text:'invented'}]}),
    ()=>candidate({toolCalls:[{name:'trade.execute'}]}),()=>candidate({answer:'free text'}),()=>'{',
    ()=>'x'.repeat(MAX_RESPONSE_BYTES+1)
  ]){
    const {ticket,prompt}=await f.prepare();
    const result=await f.verify(ticket,make(prompt));
    assert.equal(result.verified,false);assert.equal(result.response,null);
  }
});
test('unknown references, duplicate references and mismatched interpretations fail closed',async()=>{
  const f=await fixture();
  for(const [make,code] of [
    [()=>candidate({observations:[{referenceId:'0'.repeat(64)}]}),'UNKNOWN_MARKET_REFERENCE'],
    [p=>candidate({observations:[{referenceId:find(p,'FACT').referenceId},{referenceId:find(p,'FACT').referenceId}]}),'DUPLICATE_REFERENCE'],
    [p=>candidate({interpretations:[{referenceId:find(p,'FACT').referenceId,code:'FRAME_ALIGNMENT'}]}),'INTERPRETATION_MISMATCH'],
    [()=>candidate({education:[{knowledgeId:'0'.repeat(64)}]}),'UNKNOWN_KNOWLEDGE_REFERENCE'],
    [p=>candidate({status:'INSUFFICIENT_EVIDENCE',observations:[{referenceId:find(p,'FACT').referenceId}]}),'CONTRADICTORY_RESPONSE'],
    [()=>candidate(),'CONTRADICTORY_RESPONSE']
  ]){
    const {ticket,prompt}=await f.prepare();assert.equal((await f.verify(ticket,make(prompt))).code,code);
  }
});
test('opaque tickets are bound to scope and consumed once, even concurrently',async()=>{
  const f=await fixture(),{ticket,prompt}=await f.prepare();
  const c=candidate({observations:[{referenceId:find(prompt,'FACT').referenceId}]});
  assert.equal((await f.verify({},c)).code,'UNKNOWN_OR_FOREIGN_TICKET');
  assert.equal((await f.verify(ticket,c,{scope:foreign})).code,'UNKNOWN_OR_FOREIGN_TICKET');
  const results=await Promise.all([f.verify(ticket,c),f.verify(ticket,c)]);
  assert.equal(results.filter(r=>r.verified).length,1);
  await assert.rejects(f.prepare({context:structuredClone(f.context)}),/Untrusted context/);
  await assert.rejects(f.prepare({scope:foreign}),/Untrusted context/);
});
test('expiry, revocation and late authorization prevent disclosure',async()=>{
  const a=await fixture(),p=await a.prepare();
  const c=candidate({observations:[{referenceId:find(p.prompt,'FACT').referenceId}]});
  a.advance(5000);assert.equal((await a.verify(p.ticket,c)).code,'RESPONSE_EXPIRED');
  const b=await fixture(),q=await b.prepare();b.deny();
  assert.equal((await b.verify(q.ticket,c)).code,'RESPONSE_FORBIDDEN');
  const d=await fixture(),s=await d.prepare();
  d.after(checks=>{if(checks===3)d.deny();});
  assert.equal((await d.verify(s.ticket,c)).code,'RESPONSE_FORBIDDEN');
  const e=await fixture(),t=await e.prepare();
  e.after(checks=>{if(checks===3)e.advance(5000);});
  assert.equal((await e.verify(t.ticket,c)).code,'RESPONSE_EXPIRED');
});
test('education selects only original catalog text and can abstain without market evidence',async()=>{
  const f=await fixture(),{ticket,prompt}=await f.prepare({context:null,profile:'EDUCATION',question:'What is BOS?'});
  const k=prompt.payload.data.knowledge.entries[0];
  const result=await f.verify(ticket,candidate({status:'INSUFFICIENT_EVIDENCE',education:[{knowledgeId:k.knowledgeId}]}));
  assert.equal(result.verified,true);assert.equal(result.response.symbol,null);
  assert.deepEqual(result.response.education,[k]);
  assert.deepEqual(result.response.observations,[]);
});
