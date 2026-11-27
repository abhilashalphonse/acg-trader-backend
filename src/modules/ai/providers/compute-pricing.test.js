'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createModelRegistry}=require('./model-registry');
const {createOfflineRequest,normalizeOfflineOutcome}=require('./provider-contract');
const {compilePromptPackage}=require('../intelligence/prompt-compiler');
const {mapUsage,normalizeFixtureResponse}=require('./provider-response');
const {createPricingRegistry,meterOfflineUsage}=require('./compute-pricing');
const now=Date.UTC(2026,0,1);
const scope={tenantId:'a'.repeat(24),actorId:'b'.repeat(24),sessionId:'c'.repeat(24),accountId:'d'.repeat(24)};
function fixture(providerId='anthropic',fundingMode='ACG_CREDITS',extra={}){
  const modelId='synthetic-pricing-v1';
  const registry=createModelRegistry({allowSynthetic:true,descriptors:[{
    providerId,modelId,revision:'fixture-v1',reviewStatus:'SYNTHETIC_TEST_ONLY',
    fundingModes:['BYO_API','ACG_CREDITS'],capabilities:{input:'TEXT',responseMode:'JSON_OBJECT',
    separateInstructionChannel:true,streaming:true,usageReporting:'PROVIDER_REPORTED',
    maxContextTokens:10000000,maxOutputTokens:1000000}}]});
  const selection={providerId,modelId,fundingMode},model=registry.resolveForOfflineTest(selection);
  const q=createOfflineRequest({registry,selection,prompt:compilePromptPackage({scope,profile:'EDUCATION',question:'Explain BOS.',nowMs:now}),
    inputTokenUpperBound:10000,maxOutputTokens:1000,nowMs:now,...extra});
  const p={providerId,modelId,descriptorId:model.descriptorId,revision:'fixture-r1',
    effectiveFromMs:now-1000,effectiveUntilMs:null,currency:'USD',rateUnit:'MICRO_USD_PER_MILLION_TOKENS',
    reviewStatus:'SYNTHETIC_TEST_ONLY',source:'OFFLINE_FIXTURE',additionalFees:'NONE_SYNTHETIC',
    input:{standard:'3000000',cacheRead:'300000',cacheWriteMode:'TTL_SPLIT',cacheWrite:null,
      cacheWrite5m:'3750000',cacheWrite1h:'6000000'},
    output:{standard:'15000000',reasoning:'20000000'}};
  return {q,p};
}
const make=prices=>createPricingRegistry({prices,allowSynthetic:true});
const usage={status:'PROVIDER_REPORTED',inputTokens:1000,outputTokens:100,totalTokens:1100,
  cachedInputTokens:200,cacheWriteInputTokens:300,cacheWrite5mInputTokens:100,cacheWrite1hInputTokens:200,reasoningOutputTokens:20};
test('exact mutually exclusive token categories, upper bound and debit proposal',()=>{
  const {q,p}=fixture(),s=make([p]).pin(q,now);
  assert.equal(s.upperBoundPicoUsd,'80000000000');
  const m=meterOfflineUsage(q,s,usage);
  // 500 standard input *3m + 200 cache reads *0.3m + 100 writes *3.75m +
  // 200 writes *6m + 80 output *15m + 20 reasoning *20m.
  assert.equal(m.costPicoUsd,'4735000000');
  assert.equal(m.proposedCreditDebitPicoUsd,m.costPicoUsd);
  assert.equal(m.creditDeducted,false);assert.equal(m.settled,false);
  assert.equal(m.lines.reduce((n,x)=>n+x.tokens,0),1100);
  assert.ok(Object.isFrozen(s.price.input));assert.ok(Object.isFrozen(m.lines));
  assert.deepEqual(meterOfflineUsage(q,s,usage),m);
});
test('BYO_API never proposes ACG debit, including unknown usage',()=>{
  const {q,p}=fixture('anthropic','BYO_API'),s=make([p]).pin(q,now);
  assert.equal(meterOfflineUsage(q,s,usage).proposedCreditDebitPicoUsd,'0');
  const unknown=meterOfflineUsage(q,s,{status:'UNKNOWN'});
  assert.equal(unknown.status,'RECONCILIATION_REQUIRED');assert.equal(unknown.costPicoUsd,null);
  assert.equal(unknown.proposedCreditDebitPicoUsd,'0');
});
test('immutable effective windows, exact boundary, gaps, no live rate or ambiguous catalog',()=>{
  const {q,p}=fixture(),end=now+10;
  const a={...p,effectiveUntilMs:end},b={...p,revision:'fixture-r2',effectiveFromMs:end,
    input:{...p.input,standard:'9000000'}};
  const r=make([a,b]),s1=r.pin(q,now),s2=r.pin(q,end);
  assert.equal(s1.price.revision,'fixture-r1');assert.equal(s2.price.revision,'fixture-r2');
  assert.notEqual(s1.snapshotId,s2.snapshotId);
  assert.equal(meterOfflineUsage(q,s1,usage).costPicoUsd,'4735000000');
  assert.equal(meterOfflineUsage(q,s2,usage).costPicoUsd,'7735000000');
  a.input={...a.input,standard:'0'};
  assert.equal(s1.price.input.standard,'3000000');
  assert.throws(()=>make([p,b]),{code:'PRICE_INTERVAL_OVERLAP'});
  assert.throws(()=>make([a,{...b,revision:a.revision}]),{code:'PRICE_REVISION_DUPLICATE'});
  assert.throws(()=>make([a]).pin(q,end),{code:'PRICE_NOT_AVAILABLE'});
  assert.throws(()=>createPricingRegistry().pin(q,now),{code:'PRICE_NOT_AVAILABLE'});
  assert.throws(()=>createPricingRegistry({prices:[p]}),{code:'PRICE_CATALOG_INVALID'});
  assert.throws(()=>r.resolveForRuntime(),{code:'PRICE_RUNTIME_DISABLED'});
  assert.throws(()=>r.pin(q,q.expiresAtMs),{code:'PRICE_REQUEST_INVALID'});
  assert.throws(()=>make([{...p,descriptorId:'0'.repeat(64)}]).pin(q,now),{code:'PRICE_NOT_AVAILABLE'});
});
test('unknown cache split, malformed totals, overrun, unsupported cache write and tampered snapshot fail closed',()=>{
  const {q,p}=fixture(),s=make([p]).pin(q,now);
  const cases=[
    [{status:'UNKNOWN'},'USAGE_UNKNOWN'],
    [{...usage,totalTokens:999},'USAGE_INVALID'],
    [{...usage,cachedInputTokens:null},'CACHE_READ_UNKNOWN'],
    [{...usage,cacheWrite5mInputTokens:null},'CACHE_WRITE_TTL_UNKNOWN'],
    [{...usage,reasoningOutputTokens:null},'REASONING_USAGE_UNKNOWN'],
    [{...usage,inputTokens:10001,totalTokens:10101},'USAGE_EXCEEDS_PLANNING_BOUND'],
    [{...usage,cacheWrite5mInputTokens:301},'USAGE_INVALID'],
    [{...usage,cachedInputTokens:1001},'USAGE_INVALID'],
    [{...usage,extraFee:100},'USAGE_INVALID'],
  ];
  for(const [u,reason] of cases){const m=meterOfflineUsage(q,s,u);
    assert.equal(m.status,'RECONCILIATION_REQUIRED');assert.equal(m.reason,reason);assert.equal(m.costPicoUsd,null);
    assert.equal(m.proposedCreditDebitPicoUsd,null);}
  const noWrite={...p,input:{...p.input,cacheWriteMode:'NONE',cacheWrite5m:null,cacheWrite1h:null}};
  assert.equal(meterOfflineUsage(q,make([noWrite]).pin(q,now),usage).reason,'CACHE_WRITE_UNSUPPORTED');
  assert.throws(()=>meterOfflineUsage(q,{...s,upperBoundPicoUsd:'0'},usage),{code:'PRICE_SNAPSHOT_INTEGRITY'});
  assert.throws(()=>meterOfflineUsage({...q,fundingMode:'BYO_API'},s,usage),{code:'PRICE_SNAPSHOT_MISMATCH'});
  for(const bad of ['-1','1.1','01','1e6',1e6,'10000000000000']){
    assert.throws(()=>make([{...p,input:{...p.input,standard:bad}}]),{code:'PRICE_DESCRIPTOR_INVALID'});
  }
});
test('inclusive rates never double-count reasoning or cache reads; exact zero and very large values',()=>{
  const {q,p}=fixture('openai','ACG_CREDITS',{inputTokenUpperBound:8000000,maxOutputTokens:1000000});
  const flat={...p,input:{standard:'9999999999999',cacheRead:null,cacheWriteMode:'NONE',cacheWrite:null,
    cacheWrite5m:null,cacheWrite1h:null},output:{standard:'9999999999999',reasoning:null}};
  const s=make([flat]).pin(q,now);
  const u={status:'PROVIDER_REPORTED',inputTokens:8000000,outputTokens:1000000,totalTokens:9000000,
    cachedInputTokens:1,reasoningOutputTokens:999999};
  const m=meterOfflineUsage(q,s,u);
  assert.equal(m.costPicoUsd,'89999999999991000000');assert.equal(m.lines.length,2);
  assert.equal(m.costPicoUsd,s.upperBoundPicoUsd);
  assert.equal(meterOfflineUsage(q,s,{...u,inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,reasoningOutputTokens:0}).costPicoUsd,'0');
});
test('Anthropic cache TTL usage preserved through normalizer; missing breakdown is not guessed',async()=>{
  const {q,p}=fixture(),s=make([p]).pin(q,now);
  const raw={input_tokens:500,cache_read_input_tokens:200,cache_creation_input_tokens:300,
    cache_creation:{ephemeral_5m_input_tokens:100,ephemeral_1h_input_tokens:200},output_tokens:100};
  const u=mapUsage('anthropic',raw);
  assert.equal(u.inputTokens,1000);assert.equal(u.cacheWriteInputTokens,300);
  assert.equal(u.cacheWrite5mInputTokens,100);assert.equal(u.cacheWrite1hInputTokens,200);
  const o=normalizeOfflineOutcome(q,{requestId:q.requestId,providerId:q.providerId,modelId:q.modelId,descriptorId:q.descriptorId,
    status:'COMPLETED',candidate:'{}',usage:u,errorCode:'NONE'});
  const fixed={...p,output:{...p.output,reasoning:null}},s2=make([fixed]).pin(q,now);
  assert.equal(meterOfflineUsage(q,s2,o.usage).costPicoUsd,'4635000000');
  assert.equal(meterOfflineUsage(q,s,o.usage).reason,'REASONING_USAGE_UNKNOWN');
  const {cache_creation,...missing}=raw;
  assert.equal(meterOfflineUsage(q,s2,{...mapUsage('anthropic',missing),totalTokens:1100}).reason,'CACHE_WRITE_TTL_UNKNOWN');
  assert.equal(mapUsage('anthropic',{...raw,cache_creation:{ephemeral_5m_input_tokens:10,ephemeral_1h_input_tokens:20}}).status,'UNKNOWN');
  const response={role:'assistant',model:q.modelId,content:[{type:'text',text:'{}'}],stop_reason:'end_turn',usage:raw};
  const received=await normalizeFixtureResponse(q,{httpStatus:200,contentType:'application/json',
    chunks:[Buffer.from(JSON.stringify(response))],now:()=>now});
  assert.equal(received.status,'COMPLETED');assert.equal(received.usage.cacheWrite1hInputTokens,200);
  assert.equal(meterOfflineUsage(q,s2,received.usage).costPicoUsd,'4635000000');
});
