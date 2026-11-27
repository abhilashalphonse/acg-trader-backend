'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createModelRegistry}=require('./model-registry');
const {createOfflineRequest,normalizeOfflineOutcome,CANDIDATE_JSON_SCHEMA}=require('./provider-contract');
const {createFixtureAdapter}=require('./fixture-adapter');
const {createResponseEngine}=require('../intelligence/response-engine');
const {compilePromptPackage}=require('../intelligence/prompt-compiler');
const nowMs=Date.UTC(2026,0,1);
const scope={tenantId:'a'.repeat(24),actorId:'b'.repeat(24),sessionId:'c'.repeat(24),accountId:'d'.repeat(24)};
const descriptor=()=>({providerId:'openai',modelId:'synthetic-fixture-v1',revision:'test-1',
  reviewStatus:'SYNTHETIC_TEST_ONLY',fundingModes:['BYO_API','ACG_CREDITS'],
  capabilities:{input:'TEXT',responseMode:'JSON_SCHEMA',separateInstructionChannel:true,streaming:false,
    usageReporting:'PROVIDER_REPORTED',maxContextTokens:8192,maxOutputTokens:2048}});
const selection={providerId:'openai',modelId:'synthetic-fixture-v1',fundingMode:'BYO_API'};
const registry=()=>createModelRegistry({descriptors:[descriptor()],allowSynthetic:true});
const prompt=()=>compilePromptPackage({scope,profile:'EDUCATION',question:'Explain market structure.',nowMs});
const build=(extra={})=>createOfflineRequest({registry:registry(),selection,prompt:prompt(),inputTokenUpperBound:4096,maxOutputTokens:1024,nowMs,...extra});
const usage={status:'PROVIDER_REPORTED',inputTokens:1000,outputTokens:100,cachedInputTokens:200,reasoningOutputTokens:10};
const candidate=JSON.stringify({schemaVersion:'candidate-response-v2',status:'UNSUPPORTED',observations:[],interpretations:[],education:[]});
const raw=(q,extra={})=>({requestId:q.requestId,providerId:q.providerId,modelId:q.modelId,descriptorId:q.descriptorId,
  status:'COMPLETED',candidate,usage,errorCode:'NONE',...extra});
test('default registry is empty of models, all planned providers disabled, runtime always blocked',()=>{
  const r=createModelRegistry();
  assert.equal(r.providers().length,6);assert.deepEqual(r.models(),[]);
  assert.ok(r.providers().every(p=>p.runtimeEnabled===false&&p.integrationStatus==='PLANNED'));
  assert.throws(()=>r.resolveForRuntime(selection),{code:'AI_PROVIDER_RUNTIME_DISABLED'});
  assert.throws(()=>registry().resolveForRuntime(selection),{code:'AI_PROVIDER_RUNTIME_DISABLED'});
  assert.throws(()=>r.resolveForOfflineTest(selection),{code:'MODEL_NOT_REGISTERED'});
});
test('synthetic registration is opt-in, immutable, versioned and explicit about funding modes',()=>{
  assert.throws(()=>createModelRegistry({descriptors:[descriptor()]}),{code:'SYNTHETIC_MODEL_FORBIDDEN'});
  assert.throws(()=>createModelRegistry({descriptors:[descriptor(),descriptor()],allowSynthetic:true}),{code:'DUPLICATE_MODEL'});
  const d=descriptor(),r=createModelRegistry({descriptors:[d],allowSynthetic:true});
  d.capabilities.maxOutputTokens=1;
  assert.equal(r.models()[0].capabilities.maxOutputTokens,2048);
  assert.ok(Object.isFrozen(r.models()[0].fundingModes));
  assert.equal(r.resolveForOfflineTest(selection).descriptorId,registry().resolveForOfflineTest(selection).descriptorId);
  assert.throws(()=>r.resolveForOfflineTest({...selection,fundingMode:'FREE_FALLBACK'}),{code:'FUNDING_MODE_UNSUPPORTED'});
  const p=createModelRegistry({descriptors:[{...descriptor(),reviewStatus:'PROPOSED'}],allowSynthetic:true});
  assert.throws(()=>p.resolveForOfflineTest(selection),{code:'MODEL_NOT_TEST_ENABLED'});
  for(const caps of [{responseMode:'UNSUPPORTED'},{separateInstructionChannel:false},{usageReporting:'UNKNOWN'}]){
    const d=descriptor();Object.assign(d.capabilities,caps);
    const r=createModelRegistry({descriptors:[d],allowSynthetic:true});
    assert.throws(()=>r.resolveForOfflineTest(selection),{code:'MODEL_CAPABILITY_UNSUPPORTED'});
  }
  assert.throws(()=>createModelRegistry({descriptors:[{...descriptor(),endpoint:'https://untrusted.invalid'}],allowSynthetic:true}),{code:'INVALID_MODEL_DESCRIPTOR'});
});
test('request binds model and funding, keeps instructions/data separate, and has no tools',()=>{
  const q=build(),credit=build({selection:{...selection,fundingMode:'ACG_CREDITS'}});
  assert.equal(q.fundingMode,'BYO_API');assert.equal(credit.fundingMode,'ACG_CREDITS');
  assert.deepEqual(q.request,credit.request);
  assert.notEqual(q.requestId,credit.requestId);
  assert.equal(q.request.instruction.version,'acg-prompt-v2');
  assert.equal(q.request.data.question,'Explain market structure.');
  assert.equal(q.request.responseSchema,CANDIDATE_JSON_SCHEMA);
  assert.equal(q.request.responseSchema.additionalProperties,false);
  assert.deepEqual(q.request.tools,[]);
  assert.ok(Object.isFrozen(q.request.data));
  const wire=JSON.stringify(q.request);
  for(const key of [...Object.values(scope),'fundingMode','requestId','apiKey','endpoint'])assert.equal(wire.includes(key),false);
  assert.equal(q.budget.tokenCountStatus,'UNVERIFIED_PLANNING_BOUND');
});
test('expired or altered prompts, token overruns and unknown models fail closed',()=>{
  assert.throws(()=>build({nowMs:nowMs+10000}),{code:'INVALID_OR_EXPIRED_PROMPT'});
  assert.throws(()=>build({maxOutputTokens:2049}),{code:'MODEL_TOKEN_BUDGET_EXCEEDED'});
  assert.throws(()=>build({inputTokenUpperBound:8192}),{code:'MODEL_TOKEN_BUDGET_EXCEEDED'});
  assert.throws(()=>build({inputTokenUpperBound:0}),{code:'MODEL_TOKEN_BUDGET_EXCEEDED'});
  assert.throws(()=>build({selection:{...selection,modelId:'unknown'}}),{code:'MODEL_NOT_REGISTERED'});
  const p=prompt();assert.throws(()=>build({prompt:{...p,packageId:'0'.repeat(64)}}),{code:'PROMPT_INTEGRITY'});
});
test('outcomes preserve inclusive usage and flag overrun or uncertainty without billing or fallback',()=>{
  const q=build();
  const v=normalizeOfflineOutcome(q,raw(q));
  assert.equal(v.usage.totalTokens,1100);assert.equal(v.usage.cachedInputTokens,200);
  assert.equal(v.usage.reasoningOutputTokens,10);assert.equal(v.usageDisposition,'UNSETTLED');
  assert.equal(v.candidateTrust,'UNVERIFIED');assert.equal(v.requiresPhase2Verification,true);
  assert.equal(v.automaticRetry,false);assert.equal(v.automaticFallback,false);
  const unknown=normalizeOfflineOutcome(q,raw(q,{status:'UNKNOWN',candidate:null,errorCode:'TIMEOUT',usage:{status:'UNKNOWN'}}));
  assert.equal(unknown.usageDisposition,'RECONCILIATION_REQUIRED');assert.equal(unknown.candidate,null);
  assert.equal(unknown.requiresPhase2Verification,false);
  const over=normalizeOfflineOutcome(q,raw(q,{usage:{...usage,inputTokens:4097}}));
  assert.equal(over.usage.inputTokens,4097);assert.equal(over.exceedsPlanningBound,true);assert.equal(over.usageDisposition,'RECONCILIATION_REQUIRED');
  for(const status of ['REFUSED','INCOMPLETE','FAILED','CANCELLED']){
    assert.equal(normalizeOfflineOutcome(q,raw(q,{status,candidate:null,errorCode:'UNKNOWN'})).candidate,null);
  }
});
test('malformed outcomes, tool fields, wrong request/model, invalid subcounts and partial text rejected',()=>{
  const q=build();
  for(const x of [{requestId:'bad'},{providerId:'gemini'},{modelId:'other'},{descriptorId:'0'.repeat(64)},
    {usage:{...usage,cachedInputTokens:1001}},{usage:{...usage,reasoningOutputTokens:101}},
    {usage:{status:'UNKNOWN',inputTokens:0}},{usage:{...usage,inputTokens:-1}},{toolCalls:[]},
    {candidate:'x'.repeat(16385)},{status:'FAILED',errorCode:'TIMEOUT'},{status:'REFUSED',candidate:null,errorCode:'NONE'}]){
    assert.throws(()=>normalizeOfflineOutcome(q,raw(q,x)));
  }
});
test('fixture adapter generates candidate only; actual Phase 2 verifier owns disclosure',async()=>{
  const engine=createResponseEngine({authorize:async()=>true,now:()=>nowMs});
  const {ticket,prompt}=await engine.prepare({scope,profile:'EDUCATION',question:'What is BOS?'});
  const q=build({prompt});
  const knowledgeId=prompt.payload.data.knowledge.entries.find(k=>k.id==='MARKET_STRUCTURE').knowledgeId;
  const adapter=createFixtureAdapter({providerId:q.providerId,modelId:q.modelId,fixture:{status:'COMPLETED',
    candidate:JSON.stringify({schemaVersion:'candidate-response-v2',status:'ANSWER',observations:[],interpretations:[],education:[{knowledgeId}]}),usage,errorCode:'NONE'}});
  const outcome=await adapter.generate(q);
  assert.equal(outcome.candidateTrust,'UNVERIFIED');
  const verified=await engine.verify({ticket,scope,candidate:outcome.candidate});
  assert.equal(verified.verified,true);assert.equal(verified.response.education[0].id,'MARKET_STRUCTURE');
  await assert.rejects(adapter.generate({...q,modelId:'other'}),{code:'ADAPTER_BINDING_MISMATCH'});
});
