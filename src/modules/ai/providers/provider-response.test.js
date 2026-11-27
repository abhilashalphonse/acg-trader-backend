'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createModelRegistry}=require('./model-registry');
const {createOfflineRequest}=require('./provider-contract');
const {buildWireRequest}=require('./provider-wire');
const {normalizeFixtureResponse,mapUsage}=require('./provider-response');
const {createResponseEngine}=require('../intelligence/response-engine');
const {compilePromptPackage}=require('../intelligence/prompt-compiler');
const {LIMITS}=require('./bounded-stream');
const nowMs=Date.UTC(2026,0,1);
const scope={tenantId:'a'.repeat(24),actorId:'b'.repeat(24),sessionId:'c'.repeat(24),accountId:'d'.repeat(24)};
const modelId='offline-fixture-v1',providers=['openai','anthropic','gemini','deepseek','openrouter'];
const make=(providerId,stream=true,extra={})=>{
  const descriptor={providerId,modelId,revision:'test-1',reviewStatus:'SYNTHETIC_TEST_ONLY',
    fundingModes:['BYO_API','ACG_CREDITS'],capabilities:{input:'TEXT',responseMode:providerId==='deepseek'?'JSON_OBJECT':'JSON_SCHEMA',
      separateInstructionChannel:true,streaming:true,usageReporting:'PROVIDER_REPORTED',maxContextTokens:8192,maxOutputTokens:2048}};
  return createOfflineRequest({registry:createModelRegistry({descriptors:[descriptor],allowSynthetic:true}),
    selection:{providerId,modelId,fundingMode:'BYO_API'},prompt:compilePromptPackage({scope,profile:'EDUCATION',question:'Explain BOS.',nowMs}),
    inputTokenUpperBound:4096,maxOutputTokens:1024,nowMs,stream,...extra});
};
const candidate=JSON.stringify({schemaVersion:'candidate-response-v2',status:'UNSUPPORTED',observations:[],interpretations:[],education:[]});
const usage={prompt_tokens:12,completion_tokens:10,total_tokens:22,prompt_tokens_details:{cached_tokens:3},completion_tokens_details:{reasoning_tokens:2}};
const chunk=(delta,finish_reason=null)=>({model:modelId,choices:[{index:0,delta,finish_reason}]});
const event=(v,name=null)=>(name?'event: '+name+'\r\n':'')+'data: '+(typeof v==='string'?v:JSON.stringify(v))+'\r\n\r\n';
const chatStream=(text=candidate)=>event(chunk({role:'assistant',content:text.slice(0,20)}))+': keepalive\r\n\r\n'+
  event(chunk({content:text.slice(20)}))+event(chunk({},'stop'))+event({model:modelId,choices:[],usage})+event('[DONE]');
const aevent=(type,extra={})=>event({type,...extra},type);
const anthropicStream=(text=candidate)=>aevent('message_start',{message:{role:'assistant',model:modelId,content:[],
  usage:{input_tokens:7,cache_read_input_tokens:3,cache_creation_input_tokens:2,output_tokens:1}}})+
  aevent('content_block_start',{index:0,content_block:{type:'text',text:''}})+
  aevent('content_block_delta',{index:0,delta:{type:'text_delta',text}})+aevent('content_block_stop',{index:0})+
  aevent('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:10}})+aevent('message_stop');
const geminiUsage={promptTokenCount:12,candidatesTokenCount:8,thoughtsTokenCount:2,cachedContentTokenCount:3,totalTokenCount:22};
const geminiStream=(text=candidate)=>event({modelVersion:modelId,candidates:[{index:0,content:{role:'model',parts:[{text:'private thinking',thought:true},{text:text.slice(0,15)}]}}]})+
  event({modelVersion:modelId,candidates:[{index:0,content:{parts:[{text:text.slice(15)}]},finishReason:'STOP'}],usageMetadata:geminiUsage});
const fragmented=(s)=>{const b=Buffer.from(s);return Array.from({length:Math.ceil(b.length/7)},(_,i)=>b.subarray(i*7,i*7+7));};
const run=(q,s,extra={})=>normalizeFixtureResponse(q,{httpStatus:200,contentType:q.request.stream?'text/event-stream; charset=utf-8':'application/json',
  chunks:fragmented(s),now:()=>nowMs,...extra});
test('five fixed provider mappings preserve distinct instructions, data, and no credentials or tools',()=>{
  for(const p of providers){
    const q=make(p),w=buildWireRequest(q);
    assert.equal(w.networkEnabled,false);assert.equal(w.redirect,'error');
    assert.ok(w.url.startsWith('https://'));
    assert.equal(w.headers.authorization,undefined);
    const s=JSON.stringify(w.body);
    assert.ok(s.includes('Explain BOS.'));assert.ok(s.includes('acg-prompt-v2'));
    assert.equal(s.includes('fundingMode'),false);assert.equal(s.includes(q.requestId),false);
    assert.equal(Object.hasOwn(w.body,'tools'),false);
    if(p==='openrouter')assert.equal(w.body.provider.allow_fallbacks,false);
  }
  assert.throws(()=>buildWireRequest({...make('openai'),providerId:'custom'}),{code:'ADAPTER_PROVIDER_UNSUPPORTED'});
  assert.throws(()=>buildWireRequest({...make('gemini'),modelId:'x/../y'}),{code:'ADAPTER_REQUEST_INVALID'});
  assert.throws(()=>buildWireRequest({...make('deepseek'),request:{...make('deepseek').request,responseMode:'JSON_SCHEMA'}}),{code:'ADAPTER_SCHEMA_UNSUPPORTED'});
});
test('five streaming protocols, arbitrary chunk boundaries and terminal usage normalization',async()=>{
  for(const p of providers){
    const q=make(p),s=p==='anthropic'?anthropicStream():p==='gemini'?geminiStream():chatStream();
    const v=await run(q,s);
    assert.equal(v.status,'COMPLETED',p);assert.equal(v.candidate,candidate);
    assert.equal(v.usage.inputTokens,12);assert.equal(v.usage.outputTokens,10);
    assert.equal(v.usage.totalTokens,22);assert.equal(v.usage.cachedInputTokens,3);
    assert.equal(v.candidateTrust,'UNVERIFIED');assert.equal(v.automaticFallback,false);
  }
  const unicode='{"text":"മലയാളം €"}';
  const v=await run(make('openai'),chatStream(unicode),{chunks:Array.from(Buffer.from(chatStream(unicode)),x=>Uint8Array.of(x))});
  assert.equal(v.candidate,unicode);
});
test('nonstreaming JSON responses converge on the same normalized contract',async()=>{
  for(const p of providers){
    let raw;
    if(p==='anthropic')raw={role:'assistant',model:modelId,content:[{type:'text',text:candidate}],stop_reason:'end_turn',usage:{input_tokens:12,output_tokens:10}};
    else if(p==='gemini')raw={modelVersion:modelId,candidates:[{index:0,content:{parts:[{text:candidate}]},finishReason:'STOP'}],usageMetadata:geminiUsage};
    else raw={model:modelId,choices:[{index:0,message:{role:'assistant',content:candidate},finish_reason:'stop'}],usage};
    const v=await run(make(p,false),JSON.stringify(raw));
    assert.equal(v.status,'COMPLETED',p);assert.equal(v.candidate,candidate);assert.equal(v.usage.totalTokens,22);
  }
});
test('truncation, malformed frames, tool output, refusal and model mismatch never release partial text',async()=>{
  const q=make('openai');
  const cases=[
    [chatStream().replace(event('[DONE]'),''),'INCOMPLETE'],
    [chatStream().slice(0,-2),'INCOMPLETE'],
    [event(chunk({content:'partial'}))+event('bad-json'),'FAILED'],
    [event(chunk({content:'partial',tool_calls:[{id:'tool'}]}))+event('[DONE]'),'FAILED'],
    [event(chunk({refusal:'private reason'}))+event(chunk({},'stop'))+event('[DONE]'),'REFUSED'],
    [event(chunk({content:'partial'},'length'))+event('[DONE]'),'INCOMPLETE'],
    [chatStream().replace(modelId,'unexpected-model'),'FAILED'],
    [chatStream()+event(chunk({content:'unexpected'})),'FAILED'],
    [event(chunk({content:'x'.repeat(16385)},'stop'))+event('[DONE]'),'FAILED']
  ];
  for(const [s,status] of cases){const v=await run(q,s);assert.equal(v.status,status);assert.equal(v.candidate,null);}
  assert.equal((await run(make('anthropic'),anthropicStream().replace(aevent('message_stop'),''))).status,'INCOMPLETE');
  assert.equal((await run(make('gemini'),event({candidates:[{content:{parts:[{text:'partial'}]}}]}))).status,'INCOMPLETE');
});
test('unknown usage, HTTP errors, resource limits and cancellation fail closed',async()=>{
  const q=make('openai');
  const absent=await run(q,chatStream().replace(event({model:modelId,choices:[],usage}),''));
  assert.equal(absent.status,'COMPLETED');assert.equal(absent.usage.status,'UNKNOWN');assert.equal(absent.usageDisposition,'RECONCILIATION_REQUIRED');
  assert.equal(mapUsage('openai',{...usage,total_tokens:999}).status,'UNKNOWN');
  assert.equal(mapUsage('gemini',{...geminiUsage,toolUsePromptTokenCount:1}).status,'UNKNOWN');
  assert.equal(mapUsage('anthropic',{input_tokens:1,output_tokens:1,server_tool_use:{web_search_requests:1}}).status,'UNKNOWN');
  for(const [httpStatus,error] of [[401,'AUTHENTICATION'],[402,'QUOTA'],[429,'RATE_LIMIT'],[503,'UNAVAILABLE'],[302,'INVALID_RESPONSE']]){
    const v=await run(q,'not read',{httpStatus});assert.equal(v.errorCode,error);assert.equal(v.candidate,null);
  }
  const invalid=await run(q,'',{chunks:[Buffer.from([0xff])]});assert.equal(invalid.status,'FAILED');
  const large=await run(q,'',{chunks:[Buffer.alloc(LIMITS.totalBytes+1)]});assert.equal(large.status,'FAILED');
  const controller=new AbortController();controller.abort();
  assert.equal((await run(q,chatStream(),{signal:controller.signal})).status,'CANCELLED');
  const blocked={async *[Symbol.asyncIterator](){await new Promise(()=>{});}};
  assert.equal((await run(q,'',{chunks:blocked,timeoutMs:10})).errorCode,'TIMEOUT');
  assert.equal((await run(q,chatStream(),{now:()=>nowMs+10000})).errorCode,'TIMEOUT');
});
test('streamed candidate must pass real Phase 2 verifier before disclosure',async()=>{
  const engine=createResponseEngine({authorize:async()=>true,now:()=>nowMs});
  const {ticket,prompt}=await engine.prepare({scope,profile:'EDUCATION',question:'What is BOS?'});
  const knowledgeId=prompt.payload.data.knowledge.entries.find(k=>k.id==='MARKET_STRUCTURE').knowledgeId;
  const q=make('openai',true,{prompt});
  const text=JSON.stringify({schemaVersion:'candidate-response-v2',status:'ANSWER',observations:[],interpretations:[],education:[{knowledgeId}]});
  const v=await run(q,chatStream(text));assert.equal(v.requiresPhase2Verification,true);
  const verified=await engine.verify({ticket,scope,candidate:v.candidate});
  assert.equal(verified.verified,true);assert.equal(verified.response.education[0].id,'MARKET_STRUCTURE');
});

test('Gemini completed response requires exact reported model and consistent terminal usage',async()=>{
  const q=make('gemini');
  const missing=geminiStream().replaceAll('"modelVersion":"'+modelId+'",','');
  assert.equal((await run(q,missing)).status,'FAILED');
  const conflicting=geminiStream()+event({modelVersion:modelId,usageMetadata:{...geminiUsage,totalTokenCount:23}});
  assert.equal((await run(q,conflicting)).status,'FAILED');
});
