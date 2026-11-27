'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createLiveRuntimeConfig,assertLiveRuntime}=require('../src/modules/ai/providers/live-runtime-config');
const {createLiveOpenAiTransport,buildBody,parseResponse}=require('../src/modules/ai/providers/live-openai-transport');
const {compilePromptPackage}=require('../src/modules/ai/intelligence/prompt-compiler');
const fields={providerId:'openai',modelId:'synthetic-config-test',policyVersion:'a'.repeat(64),inputRatePicoUsd:100,
  outputRatePicoUsd:200,maxInputTokens:8192,maxOutputTokens:512,responseMode:'JSON_SCHEMA',store:false,streaming:false,reviewStatus:'APPROVED_LIVE'};
const descriptor={...fields,descriptorId:createHash('sha256').update(JSON.stringify(fields)).digest('hex')};
test('public transport rejects disabled or forged configurations before secret access',()=>{
  assert.throws(()=>createLiveOpenAiTransport({config:{enabled:true,descriptor}}));
  assert.throws(()=>createLiveOpenAiTransport({config:createLiveRuntimeConfig({env:{}})}));
  const env={ACG_AI_LIVE_PROVIDER_ENABLED:'true'};
  let reads=0,approved=true;
  const config=createLiveRuntimeConfig({env,descriptor,verifyRelease:()=>approved,secretPort:{withSecret(){reads++;throw Error('fixture');}}});
  assert.equal(assertLiveRuntime(config),true);
  approved=false;assert.throws(()=>assertLiveRuntime(config));
  approved=true;env.ACG_AI_LIVE_PROVIDER_ENABLED='false';assert.throws(()=>assertLiveRuntime(config));
  assert.equal(reads,0);
});
test('fixed request and strict response parsing; malformed usage never accepted',()=>{
  const scope={tenantId:'1'.repeat(24),actorId:'2'.repeat(24),sessionId:'3'.repeat(24),accountId:'4'.repeat(24)};
  const prompt=compilePromptPackage({scope,profile:'EDUCATION',question:'Synthetic test.',nowMs:Date.now()});
  const body=buildBody(descriptor,prompt);
  assert.equal(body.store,false);assert.equal(body.stream,false);assert.equal(body.n,1);
  assert.equal(body.max_completion_tokens,512);assert.equal(body.response_format.json_schema.strict,true);
  for(const v of Object.values(scope))assert.ok(!JSON.stringify(body).includes(v));
  const raw={id:'fixture-response',model:fields.modelId,service_tier:'default',choices:[{index:0,
    finish_reason:'stop',message:{role:'assistant',content:'{}'}}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}};
  assert.equal(parseResponse(raw,descriptor).usage.outputTokens,20);
  for(const mutated of [{...raw,model:'other'},{...raw,service_tier:'priority'},{...raw,usage:{...raw.usage,total_tokens:100}},
    {...raw,usage:{prompt_tokens:100,completion_tokens:600,total_tokens:700}},{...raw,choices:[{...raw.choices[0],message:{role:'assistant',content:'{}',tool_calls:[]}}]}])
    assert.throws(()=>parseResponse(mutated,descriptor));
  assert.throws(()=>buildBody(descriptor,{...prompt,packageId:'f'.repeat(64)}));
});

test('completed usage with no answer preserves provider finish classification',()=>{
  const raw={id:'fixture-response',model:fields.modelId,choices:[{index:0,finish_reason:'length',message:{role:'assistant',content:null}}],usage:{prompt_tokens:100,completion_tokens:512,total_tokens:612,completion_tokens_details:{reasoning_tokens:512}}};
  const incomplete=parseResponse(raw,descriptor);
  assert.equal(incomplete.candidate,null);assert.equal(incomplete.failureReason,'COMPLETION_LIMIT');
  assert.equal(incomplete.usage.outputTokens,512);assert.equal(incomplete.usage.reasoningOutputTokens,512);
  const refused=parseResponse({...raw,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:null,refusal:'fixture'}}]},descriptor);
  assert.equal(refused.candidate,null);assert.equal(refused.failureReason,'PROVIDER_REFUSED');
  const completed=parseResponse({...raw,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'{}'}}]},descriptor);
  assert.equal(completed.failureReason,null);assert.equal(completed.candidate,'{}');
});
