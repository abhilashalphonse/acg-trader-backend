'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createModelRegistry}=require('./model-registry');
const {createResponseEngine}=require('../intelligence/response-engine');
const {createOfflineOrchestrator}=require('./offline-orchestrator');
const {normalizeFixtureResponse}=require('./provider-response');
const {normalizeOfflineOutcome,CONTRACT_VERSION}=require('./provider-contract');
const scope={tenantId:'a'.repeat(24),actorId:'b'.repeat(24),sessionId:'c'.repeat(24),accountId:'d'.repeat(24)};
const selection={providerId:'openai',modelId:'offline-fixture-v1',fundingMode:'BYO_API'};
const nowMs=Date.UTC(2026,0,1);
const usage={status:'PROVIDER_REPORTED',inputTokens:100,outputTokens:30,cachedInputTokens:null,reasoningOutputTokens:null};
const input=(extra={})=>({idempotencyKey:randomUUID(),scope,selection,profile:'EDUCATION',question:'Explain BOS.',
  inputTokenUpperBound:4096,maxOutputTokens:1024,timeoutMs:5000,...extra});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const candidate=q=>JSON.stringify({schemaVersion:'candidate-response-v2',status:'ANSWER',observations:[],interpretations:[],
  education:[{knowledgeId:q.request.data.knowledge.entries.find(k=>k.id==='MARKET_STRUCTURE').knowledgeId}]});
function output(q,extra={}){
  return normalizeOfflineOutcome(q,{requestId:q.requestId,providerId:q.providerId,modelId:q.modelId,descriptorId:q.descriptorId,
    status:'COMPLETED',candidate:candidate(q),usage,errorCode:'NONE',...extra});
}
function setup({generate=async q=>output(q),authorize=async()=>true,engineAuthorize=async()=>true,options={},now=()=>nowMs}={}){
  let calls=0;
  const descriptor={providerId:selection.providerId,modelId:selection.modelId,revision:'test-1',
    reviewStatus:'SYNTHETIC_TEST_ONLY',fundingModes:['BYO_API','ACG_CREDITS'],
    capabilities:{input:'TEXT',responseMode:'JSON_SCHEMA',separateInstructionChannel:true,streaming:true,
      usageReporting:'PROVIDER_REPORTED',maxContextTokens:8192,maxOutputTokens:2048}};
  const registry=createModelRegistry({descriptors:[descriptor],allowSynthetic:true});
  const responseEngine=createResponseEngine({authorize:engineAuthorize,now});
  const adapter={contractVersion:CONTRACT_VERSION,executionMode:'OFFLINE_TEST_ONLY',
    providerId:selection.providerId,modelId:selection.modelId,
    async generate(q,opts){calls++;return generate(q,opts);}};
  const service=createOfflineOrchestrator({registry,responseEngine,adapters:[adapter],authorize,now,...options});
  return {service,calls:()=>calls};
}
test('explicit provider and funding selection, real Phase 2 verification and receipt-only replay',async()=>{
  const {service,calls}=setup(),x=input();
  const r=await service.run(x);
  assert.equal(r.receipt.status,'COMPLETED');assert.equal(r.receipt.dispatch,'OUTCOME_RECEIVED');
  assert.equal(r.receipt.fundingMode,'BYO_API');assert.equal(r.receipt.usage.totalTokens,130);
  assert.equal(r.response.education[0].id,'MARKET_STRUCTURE');
  assert.equal(r.receipt.usageDisposition,'UNSETTLED');
  const replay=await service.run({...x,idempotencyKey:x.idempotencyKey.toUpperCase()});
  assert.equal(replay.replayed,true);assert.equal(replay.response,null);
  assert.deepEqual(replay.receipt,r.receipt);assert.equal(calls(),1);
  const receipt=await service.status(scope,x.idempotencyKey);
  assert.deepEqual(receipt,r.receipt);assert.ok(!JSON.stringify(receipt).includes(x.question));
  await assert.rejects(service.run({...x,question:'A different question'}),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(service.run({...x,scope:{...scope,accountId:'e'.repeat(24)}}),{code:'ORCHESTRATOR_FORBIDDEN'});
  await assert.rejects(service.status({...scope,actorId:'e'.repeat(24)},x.idempotencyKey),{code:'ORCHESTRATOR_FORBIDDEN'});
  const c=await service.run(input({selection:{...selection,fundingMode:'ACG_CREDITS'}}));
  assert.equal(c.receipt.fundingMode,'ACG_CREDITS');assert.equal(calls(),2);
});
test('concurrent identical requests dispatch at most once; owner and global admission bounds',async()=>{
  const started=deferred(),hold=deferred();
  const {service,calls}=setup({generate:async q=>{started.resolve();await hold.promise;return output(q);},
    options:{maxActive:2,maxPerOwner:2,maxPerTenant:2}});
  const x=input(),p=service.run(x);await started.promise;
  const duplicate=await service.run(x);assert.equal(duplicate.replayed,true);
  assert.equal(duplicate.receipt.status,'DISPATCHED');assert.equal(duplicate.response,null);
  const y=service.run(input());
  // Admission occurs synchronously before the first await.
  await assert.rejects(service.run(input()),{code:'ORCHESTRATOR_BUSY'});
  await assert.rejects(service.run(input({scope:{...scope,tenantId:'e'.repeat(24)}})),{code:'ORCHESTRATOR_BUSY'});
  hold.resolve();const results=await Promise.all([p,y]);
  assert.ok(results.every(v=>v.receipt.status==='COMPLETED'));assert.equal(calls(),2);
});
test('cancellation after dispatch preserves ambiguity and holds slot until adapter settles',async()=>{
  const started=deferred(),hold=deferred(),finished=deferred();
  const {service,calls}=setup({generate:async(q,{signal})=>{
    started.resolve(signal);await hold.promise;finished.resolve();return output(q);
  },options:{maxActive:1,maxPerOwner:1,maxPerTenant:1}});
  const x=input(),p=service.run(x),signal=await started.promise;
  await service.cancel(scope,x.idempotencyKey);
  const result=await p;
  assert.equal(signal.aborted,true);assert.equal(result.receipt.status,'RECONCILIATION_REQUIRED');
  assert.equal(result.receipt.errorCode,'CANCELLED');assert.equal(result.receipt.dispatch,'ATTEMPTED');
  assert.equal(result.response,null);assert.equal(result.receipt.usage.status,'UNKNOWN');
  await assert.rejects(service.run(input()),{code:'ORCHESTRATOR_BUSY'});
  hold.resolve();await finished.promise;await new Promise(resolve=>setImmediate(resolve));
  const duplicate=await service.run(x);assert.equal(duplicate.replayed,true);assert.equal(calls(),1);
  assert.deepEqual(duplicate.receipt,result.receipt);
});
test('deadline after dispatch and thrown adapter never trigger retry or fallback',async()=>{
  const hold=deferred();
  const a=setup({generate:async()=>hold.promise});
  const x=input({timeoutMs:500});const r=await a.service.run(x);
  assert.equal(r.receipt.status,'RECONCILIATION_REQUIRED');assert.equal(r.receipt.errorCode,'TIMEOUT');
  assert.equal(r.receipt.automaticRetry,false);assert.equal(r.receipt.automaticFallback,false);
  hold.resolve(null);
  const b=setup({generate:async()=>{throw Error('synthetic confidential error');}});
  const y=input(),failed=await b.service.run(y);
  assert.equal(failed.receipt.status,'RECONCILIATION_REQUIRED');assert.equal(failed.receipt.errorCode,'UNKNOWN');
  assert.equal(JSON.stringify(failed).includes('confidential'),false);
  assert.equal((await b.service.run(y)).replayed,true);assert.equal(b.calls(),1);
});
test('authorization denial, invalid candidate, expired response and unknown usage suppress disclosure',async()=>{
  const a=setup({authorize:async()=>false});
  await assert.rejects(a.service.run(input()),{code:'ORCHESTRATOR_FORBIDDEN'});assert.equal(a.calls(),0);
  let n=0;const b=setup({authorize:async()=>++n<3});
  const denied=await b.service.run(input());assert.equal(denied.receipt.status,'DENIED');
  assert.equal(denied.response,null);assert.equal(denied.receipt.usage.totalTokens,130);
  const c=setup({generate:async q=>output(q,{candidate:'{"invented":true}'})});
  assert.equal((await c.service.run(input())).receipt.errorCode,'VERIFICATION_REJECTED');
  const d=setup({generate:async q=>output(q,{usage:{status:'UNKNOWN'}})});
  const unknown=await d.service.run(input());assert.equal(unknown.receipt.status,'RECONCILIATION_REQUIRED');assert.equal(unknown.response,null);
  let clock=nowMs;const e=setup({now:()=>clock,generate:async q=>{clock=nowMs+10000;return output(q);}});
  const expired=await e.service.run(input());assert.equal(expired.receipt.errorCode,'TIMEOUT');assert.equal(expired.response,null);
});
test('pre-dispatch cancellation, record capacity and strict routing validation',async()=>{
  const a=setup(),controller=new AbortController();controller.abort();
  await assert.rejects(a.service.run(input(),{signal:controller.signal}),{code:'CANCELLED'});assert.equal(a.calls(),0);
  await assert.rejects(a.service.run(input({selection:{...selection,fundingMode:'AUTO'}})),{code:'ORCHESTRATOR_REQUEST_INVALID'});
  const b=setup({options:{maxRecords:1}});
  await b.service.run(input());
  await assert.rejects(b.service.run(input()),{code:'ORCHESTRATOR_RECORD_LIMIT'});
  assert.equal(b.calls(),1);
});
test('actual Phase 3C SSE adapter pipeline through orchestration and Phase 2 verification',async()=>{
  const {service}=setup({generate:async(q,{signal,timeoutMs})=>{
    const event=v=>'data: '+(typeof v==='string'?v:JSON.stringify(v))+'\n\n';
    const s=event({model:q.modelId,choices:[{index:0,delta:{content:candidate(q)},finish_reason:null}]})+
      event({model:q.modelId,choices:[{index:0,delta:{},finish_reason:'stop'}]})+
      event({model:q.modelId,choices:[],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}})+event('[DONE]');
    return normalizeFixtureResponse(q,{httpStatus:200,contentType:'text/event-stream',chunks:[Buffer.from(s)],signal,timeoutMs,now:()=>nowMs});
  }});
  const r=await service.run(input({stream:true}));
  assert.equal(r.receipt.status,'COMPLETED');assert.equal(r.response.education[0].id,'MARKET_STRUCTURE');
});

test('stalled pre-dispatch authorization holds admission until the work settles',async()=>{
  const hold=deferred(),started=deferred(),controller=new AbortController();
  const {service,calls}=setup({authorize:async()=>{started.resolve();return hold.promise;},
    options:{maxActive:1,maxPerOwner:1,maxPerTenant:1}});
  const p=service.run(input(),{signal:controller.signal});
  await started.promise;controller.abort();
  await assert.rejects(p,{code:'CANCELLED'});
  await assert.rejects(service.run(input()),{code:'ORCHESTRATOR_BUSY'});
  assert.equal(calls(),0);
  hold.resolve(true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await service.run(input())).receipt.status,'COMPLETED');
});
test('provider mismatch and usage overrun require reconciliation; no candidate release',async()=>{
  const a=setup({generate:async q=>({...output(q),modelId:'wrong-model'})});
  const bad=await a.service.run(input());
  assert.equal(bad.receipt.status,'RECONCILIATION_REQUIRED');assert.equal(bad.receipt.errorCode,'INVALID_RESPONSE');
  assert.equal(bad.response,null);
  const b=setup({generate:async q=>output(q,{usage:{...usage,inputTokens:4097}})});
  const over=await b.service.run(input());assert.equal(over.receipt.status,'RECONCILIATION_REQUIRED');
  assert.equal(over.receipt.usage.inputTokens,4097);assert.equal(over.response,null);
});
