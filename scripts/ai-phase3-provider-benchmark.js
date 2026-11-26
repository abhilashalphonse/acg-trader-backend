'use strict';
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const {randomUUID,randomBytes}=require('node:crypto');
const {createModelRegistry}=require('../src/modules/ai/providers/model-registry');
const {createOfflineRequest}=require('../src/modules/ai/providers/provider-contract');
const {normalizeFixtureResponse}=require('../src/modules/ai/providers/provider-response');
const {buildWireRequest}=require('../src/modules/ai/providers/provider-wire');
const {createPricingRegistry,meterOfflineUsage}=require('../src/modules/ai/providers/compute-pricing');
const {createEnvelopeCrypto}=require('../src/modules/ai/providers/credential-crypto');
const {compilePromptPackage}=require('../src/modules/ai/intelligence/prompt-compiler');
const {createResponseEngine}=require('../src/modules/ai/intelligence/response-engine');
const now=Date.UTC(2026,0,1);
const scope={tenantId:'a'.repeat(24),actorId:'b'.repeat(24),sessionId:'c'.repeat(24),accountId:'d'.repeat(24)};
const providers=['openai','anthropic','gemini','deepseek','openrouter'],modelId='fixture-benchmark-v1';
const registry=createModelRegistry({allowSynthetic:true,descriptors:providers.map(providerId=>({
  providerId,modelId,revision:'fixture-1',reviewStatus:'SYNTHETIC_TEST_ONLY',fundingModes:['BYO_API'],
  capabilities:{input:'TEXT',responseMode:'JSON_OBJECT',separateInstructionChannel:true,streaming:true,
    usageReporting:'PROVIDER_REPORTED',maxContextTokens:8192,maxOutputTokens:2048}}))});
const engine=createResponseEngine({authorize:async()=>true,now:()=>now});
const event=(v,name)=> (name?'event: '+name+'\n':'')+'data: '+(typeof v==='string'?v:JSON.stringify(v))+'\n\n';
const ae=(type,extra={})=>event({type,...extra},type);
function stream(p,candidate){
  if(p==='anthropic')return ae('message_start',{message:{role:'assistant',model:modelId,content:[],
    usage:{input_tokens:80,cache_read_input_tokens:20,output_tokens:1}}})+
    ae('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    ae('content_block_delta',{index:0,delta:{type:'text_delta',text:candidate}})+
    ae('content_block_stop',{index:0})+ae('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:20}})+ae('message_stop');
  if(p==='gemini')return event({modelVersion:modelId,candidates:[{index:0,content:{parts:[{text:candidate}]},finishReason:'STOP'}],
    usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,cachedContentTokenCount:20,totalTokenCount:120}});
  return event({model:modelId,choices:[{index:0,delta:{content:candidate},finish_reason:'stop'}]})+
    event({model:modelId,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:20}}})+event('[DONE]');
}
function chunk(s,n){const b=Buffer.from(s);return Array.from({length:Math.ceil(b.length/n)},(_,i)=>b.subarray(i*n,i*n+n));}
function statistics(v){const s=[...v].sort((a,b)=>a-b);return {count:s.length,p50Ms:s[Math.floor((s.length-1)*0.5)],
  p95Ms:s[Math.ceil(s.length*0.95)-1],maxMs:s.at(-1)};}
async function main(){
  const before=process.memoryUsage(),metrics={},totalStart=performance.now();
  let valid=0,invalid=0,cryptoChecks=0;
  for(const providerId of providers){
    const selection={providerId,modelId,fundingMode:'BYO_API'},model=registry.resolveForOfflineTest(selection);
    const pricing=createPricingRegistry({allowSynthetic:true,prices:[{providerId,modelId,descriptorId:model.descriptorId,
      revision:'fixture-price',effectiveFromMs:now-1,effectiveUntilMs:null,currency:'USD',rateUnit:'MICRO_USD_PER_MILLION_TOKENS',
      reviewStatus:'SYNTHETIC_TEST_ONLY',source:'OFFLINE_FIXTURE',additionalFees:'NONE_SYNTHETIC',
      input:{standard:'1000000',cacheRead:'500000',cacheWriteMode:'NONE',cacheWrite:null,cacheWrite5m:null,cacheWrite1h:null},
      output:{standard:'2000000',reasoning:null}}]});
    const times=[],started=performance.now();
    for(let i=0;i<60;i++){
      const start=performance.now(),{ticket,prompt}=await engine.prepare({scope,profile:'EDUCATION',question:'Explain BOS.'});
      const q=createOfflineRequest({registry,selection,prompt,inputTokenUpperBound:4096,maxOutputTokens:1024,nowMs:now,stream:true});
      const candidate=JSON.stringify({schemaVersion:'candidate-response-v2',status:'ANSWER',observations:[],interpretations:[],
        education:[{knowledgeId:prompt.payload.data.knowledge.entries.find(k=>k.id==='MARKET_STRUCTURE').knowledgeId}]});
      const wire=buildWireRequest(q);
      assert.equal(wire.networkEnabled,false);
      for(const id of [...Object.values(scope),q.requestId,q.descriptorId])assert.ok(!JSON.stringify(wire.body).includes(id));
      const s=stream(providerId,candidate),options={httpStatus:200,contentType:'text/event-stream',now:()=>now};
      const v=await normalizeFixtureResponse(q,{...options,chunks:chunk(s,[1,7,64,256][i%4])});
      assert.equal(v.status,'COMPLETED');assert.equal(v.usage.totalTokens,120);assert.equal(v.candidate,candidate);
      const m=meterOfflineUsage(q,pricing.pin(q,now),v.usage);
      assert.equal(m.costPicoUsd,'130000000');assert.equal(m.proposedCreditDebitPicoUsd,'0');
      const result=await engine.verify({ticket,scope,candidate:v.candidate});
      assert.equal(result.verified,true);assert.equal(result.response.education[0].id,'MARKET_STRUCTURE');
      times.push(performance.now()-start);valid++;
      // Every deliberately truncated fixture must suppress candidate text.
      const cut=await normalizeFixtureResponse(q,{...options,chunks:chunk(s.slice(0,-3),13)});
      assert.notEqual(cut.status,'COMPLETED');assert.equal(cut.candidate,null);invalid++;
      // A response ticket cannot be replayed even with the original candidate.
      assert.equal((await engine.verify({ticket,scope,candidate:v.candidate})).verified,false);
    }
    metrics[providerId]={...statistics(times),wallMs:performance.now()-started};
  }
  const crypto=createEnvelopeCrypto({keys:[{id:'fixture',key:randomBytes(32)}],activeKeyId:'fixture'});
  for(let i=0;i<64;i++){
    const binding={tenantId:scope.tenantId,actorId:scope.actorId,connectionId:'e'.repeat(64),providerId:providers[i%5],generation:randomUUID()};
    const secret=randomBytes(64),envelope=crypto.encrypt(secret,binding);
    const plain=crypto.decrypt(envelope,binding);assert.deepEqual(plain,secret);plain.fill(0);
    for(const foreign of [{...binding,tenantId:'f'.repeat(24)},{...binding,actorId:'f'.repeat(24)},
      {...binding,generation:randomUUID()},{...binding,providerId:providers[(i+1)%5]}]){
      assert.throws(()=>crypto.decrypt(envelope,foreign),{code:'CREDENTIAL_CRYPTO_FAILED'});cryptoChecks++;
    }
    const damaged=structuredClone(envelope);
    const tag=Buffer.from(damaged.secret.tag,'base64');tag[0]^=1;damaged.secret.tag=tag.toString('base64');
    assert.throws(()=>crypto.decrypt(damaged,binding),{code:'CREDENTIAL_CRYPTO_FAILED'});cryptoChecks++;
    secret.fill(0);
  }
  const after=process.memoryUsage(),elapsed=performance.now()-totalStart;
  // Generous regression ceilings, not production SLOs. CI host is shared.
  assert.ok(elapsed<30000,'offline suite time regression');
  assert.ok(after.rss-before.rss<256*1024*1024,'offline RSS growth regression');
  assert.ok(Object.values(metrics).every(v=>v.p95Ms<250),'offline p95 regression');
  console.log('PHASE3J_PROVIDER_PERFORMANCE_PASS '+JSON.stringify({valid,invalid,cryptoChecks,metrics,elapsedMs:elapsed,
    completedPerSecond:valid/(elapsed/1000),rssBeforeBytes:before.rss,rssAfterBytes:after.rss,heapBeforeBytes:before.heapUsed,
    heapAfterBytes:after.heapUsed,node:process.version,offlineOnly:true}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
