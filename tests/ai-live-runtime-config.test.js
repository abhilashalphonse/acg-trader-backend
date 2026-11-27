'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createLiveRuntimeConfig}=require('../src/modules/ai/providers/live-runtime-config');
const env={ACG_AI_LIVE_PROVIDER_ENABLED:'true'};
const fields={providerId:'openai',modelId:'synthetic-runtime-config-test',policyVersion:'a'.repeat(64),
  inputRatePicoUsd:100,outputRatePicoUsd:200,maxInputTokens:8192,maxOutputTokens:1024,responseMode:'JSON_SCHEMA',
  store:false,streaming:false,reviewStatus:'APPROVED_LIVE'};
const descriptor={...fields,descriptorId:createHash('sha256').update(JSON.stringify(fields)).digest('hex')};
test('live runtime is default-off and requires approval, a pinned descriptor and a secret port',async()=>{
  assert.deepEqual(createLiveRuntimeConfig({env:{}}),{enabled:false});
  assert.throws(()=>createLiveRuntimeConfig({env}),{code:'LIVE_AI_RELEASE_NOT_APPROVED'});
  assert.throws(()=>createLiveRuntimeConfig({env,verifyRelease:()=>true}),{code:'LIVE_AI_DESCRIPTOR_UNAPPROVED'});
  assert.throws(()=>createLiveRuntimeConfig({env,descriptor,verifyRelease:()=>true}),{code:'LIVE_AI_SECRET_UNAVAILABLE'});
  const secretPort={withSecret(){throw Error('Configuration must never read credentials');}};
  const config=createLiveRuntimeConfig({env,descriptor,secretPort,verifyRelease:()=>true});
  assert.equal(config.enabled,true);assert.equal(config.hostname,'api.openai.com');assert.equal(config.path,'/v1/chat/completions');
  assert.equal(await config.resolvePrice('f'.repeat(64)),null);
  assert.equal((await config.resolvePrice(descriptor.descriptorId)).policyVersion,fields.policyVersion);
  assert.ok(!Object.hasOwn(config,'secretPort'));
  assert.throws(()=>createLiveRuntimeConfig({env,descriptor:{...descriptor,outputRatePicoUsd:201},secretPort,verifyRelease:()=>true}),{code:'LIVE_AI_DESCRIPTOR_CHANGED'});
  assert.throws(()=>createLiveRuntimeConfig({env,descriptor:{...descriptor,store:true},secretPort,verifyRelease:()=>true}),{code:'LIVE_AI_DESCRIPTOR_UNAPPROVED'});
});
