'use strict';
const https=require('node:https');
const dns=require('node:dns').promises;
const {performance}=require('node:perf_hooks');
const {createHash}=require('node:crypto');
const {publicIPv4}=require('./openai-live-smoke');
const {consumeBytes}=require('./bounded-stream');
const {readWorkspaceProviderStream}=require('./workspace-provider-stream');
const {mapUsage}=require('./provider-response');
const {CANDIDATE_JSON_SCHEMA}=require('./provider-contract');
const {assertLiveRuntime,withLiveSecret}=require('./live-runtime-config');
const {assertIsolated}=require('./credit-ledger-store');
const HOST='api.openai.com',PATH='/v1/chat/completions';
const fail=()=>Object.assign(Error('OpenAI transport unavailable'),{code:'LIVE_OPENAI_UNAVAILABLE'});
const requireTrue=v=>{if(!v)throw fail();};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
function buildBody(descriptor,prompt){
  requireTrue(descriptor?.providerId==='openai'&&descriptor.responseMode==='JSON_SCHEMA'&&descriptor.store===false&&descriptor.streaming===false);
  requireTrue(prompt?.payload?.schemaVersion==='prompt-package-v1'&&prompt.payload.instructions?.version==='acg-prompt-v2'&&
    prompt.payload.instructions?.responseContract?.schemaVersion==='candidate-response-v2'&&
    digest(prompt.payload)===prompt.packageId&&Buffer.byteLength(JSON.stringify(prompt.payload))===prompt.payloadBytes&&
    prompt.payloadBytes<=49152);
  const body={model:descriptor.modelId,store:false,stream:false,n:1,service_tier:'default',max_completion_tokens:descriptor.maxOutputTokens,
    messages:[{role:'system',content:JSON.stringify(prompt.payload.instructions)},{role:'user',content:JSON.stringify(prompt.payload.data)}],
    response_format:{type:'json_schema',json_schema:{name:'acg_candidate',strict:true,schema:CANDIDATE_JSON_SCHEMA}}};
  requireTrue(Buffer.byteLength(JSON.stringify(body))<=65536);
  return body;
}
function parseResponse(raw,d){
  requireTrue(raw?.model===d.modelId&&typeof raw.id==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(raw.id)&&
    Array.isArray(raw.choices)&&raw.choices.length===1&&raw.choices[0].index===0&&
    (raw.service_tier===undefined||raw.service_tier==='default'));
  const choice=raw.choices[0],m=choice.message;
  requireTrue(m?.role==='assistant'&&m.tool_calls==null&&m.function_call==null&&
    ['stop','length','content_filter'].includes(choice.finish_reason));
  const usage=mapUsage('openai',raw.usage);
  requireTrue(usage.status==='PROVIDER_REPORTED'&&integer(raw.usage.total_tokens)&&
    raw.usage.total_tokens===usage.inputTokens+usage.outputTokens&&usage.inputTokens<=d.maxInputTokens&&usage.outputTokens<=d.maxOutputTokens);
  const complete=choice.finish_reason==='stop'&&m.refusal==null;
  if(complete)requireTrue(typeof m.content==='string'&&m.content.trim()&&Buffer.byteLength(m.content)<=16384);
  return {providerResponseId:raw.id,usage,candidate:complete?m.content:null,
    failureReason:complete?null:choice.finish_reason==='length'?'COMPLETION_LIMIT':'PROVIDER_REFUSED'};
}
// Shared bounded HTTP mechanics. Target is determined by the two internal
// factories, never by a customer or caller-supplied URL.
async function exchange({target,body,key,deadlineMs,beforeWrite,signal,maxDurationMs=10000,descriptor,onDelta}){
  requireTrue(Buffer.isBuffer(key)&&key.length>=20&&key.length<=4096&&key.every(v=>v>=33&&v<=126));
  requireTrue(integer(deadlineMs)&&deadlineMs>Date.now()&&deadlineMs-Date.now()<=maxDurationMs&&maxDurationMs<=30000);
  const controller=new AbortController(),start=performance.now(),duration=deadlineMs-Date.now();
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  const timer=setTimeout(abort,duration);
  let req,res,bytes;
  try{
    const route=await target(controller.signal);
    requireTrue(!controller.signal.aborted&&Date.now()<deadlineMs);
    bytes=Buffer.from(JSON.stringify(body));
    await beforeWrite();
    requireTrue(!controller.signal.aborted&&Date.now()<deadlineMs);
    res=await new Promise((resolve,reject)=>{
      req=https.request({...route,method:'POST',path:PATH,agent:false,minVersion:'TLSv1.2',rejectUnauthorized:true,
        signal:controller.signal,maxHeaderSize:16384,headers:{authorization:'Bearer '+key.toString('ascii'),
          'content-type':'application/json','accept':body.stream?'text/event-stream':'application/json','accept-encoding':'identity','content-length':bytes.length}},resolve);
      req.on('error',reject);req.end(bytes);
    });
    requireTrue(res.statusCode===200&&(!res.headers['content-encoding']||res.headers['content-encoding']==='identity')&&
      res.headers['content-type']?.split(';')[0].trim().toLowerCase()===(body.stream?'text/event-stream':'application/json'));
    const remaining=Math.floor(duration-(performance.now()-start));requireTrue(remaining>0);
    if(body.stream)return await readWorkspaceProviderStream(res,{descriptor,signal:controller.signal,timeoutMs:remaining,onDelta:async delta=>{
      requireTrue(!controller.signal.aborted&&Date.now()<deadlineMs);
      await onDelta?.(delta,controller.signal);
    }});
    let text='';await consumeBytes(res,{signal:controller.signal,timeoutMs:remaining,onText:t=>{text+=t;}});
    requireTrue(!controller.signal.aborted&&Date.now()<deadlineMs);
    return JSON.parse(text);
  }catch{throw fail();}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);res?.destroy();req?.destroy();bytes?.fill(0);}
}
async function publicTarget(signal){
  let cancel;
  try{
    const addresses=await Promise.race([dns.resolve4(HOST),new Promise((_,reject)=>{
      cancel=()=>reject(fail());signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
    })]);
    requireTrue(addresses.length>0&&addresses.length<=32&&addresses.every(publicIPv4)&&!signal.aborted);
    const address=addresses[0];
    return {hostname:HOST,port:443,servername:HOST,family:4,autoSelectFamily:false,
      lookup:(_name,opts,cb)=>opts?.all?cb(null,[{address,family:4}]):cb(null,address,4)};
  }finally{if(cancel)signal.removeEventListener('abort',cancel);}
}
// This is deliberately not mounted in an HTTP route. A trusted caller must
// provide the server-created prompt + verification ticket, a durable message
// operation, approved export and conservative tokenizer/price policy. No
// customer transport can be activated merely by setting an environment flag.
function createLiveOpenAiTransport({config,admission,authorizeExport,countUpperBound,recordUsage,verifyCandidate,educationOnly=false,workspaceChat=false,isolatedLoopback=null}={}){
  assertLiveRuntime(config);
  requireTrue([authorizeExport,countUpperBound,recordUsage,verifyCandidate].every(f=>typeof f==='function')&&
    ['assertConsent','claim','beginDispatch','assertDispatch','assertDisclosure'].every(k=>typeof admission?.[k]==='function'));
  const d=config.descriptor;
  let target=publicTarget;
  if(isolatedLoopback!==null){
    assertIsolated();requireTrue(workspaceChat&&Number.isInteger(isolatedLoopback.port)&&isolatedLoopback.port>0&&isolatedLoopback.port<=65535&&
      Buffer.isBuffer(isolatedLoopback.ca)&&isolatedLoopback.ca.length>0&&isolatedLoopback.ca.length<=65536);
    const {port}=isolatedLoopback,ca=Buffer.from(isolatedLoopback.ca);
    target=async()=>{assertIsolated();return {hostname:'127.0.0.1',port,ca};};
  }
  return Object.freeze({
    async run({scope,workspace,prompt,ticket,operationId,authorizeMessage,signal,workspaceBody=null,onDelta}){
      assertLiveRuntime(config);
      requireTrue(typeof authorizeMessage==='function'&&hex(prompt?.packageId));
      if(workspaceChat){
        requireTrue(!educationOnly&&workspaceBody?.model===d.modelId&&workspaceBody.store===false&&typeof workspaceBody.stream==='boolean'&&
          (workspaceBody.stream===false?!Object.hasOwn(workspaceBody,'stream_options'):d.streaming===true&&typeof onDelta==='function'&&workspaceBody.stream_options?.include_usage===true&&Object.keys(workspaceBody.stream_options).length===1)&&
          workspaceBody.n===1&&workspaceBody.service_tier==='default'&&workspaceBody.reasoning_effort==='low'&&workspaceBody.max_completion_tokens===d.maxOutputTokens&&
          workspaceBody.response_format?.json_schema?.name==='acg_workspace_answer'&&
          digest(workspaceBody)===prompt.packageId&&workspaceBody.messages?.length===2&&
          !Object.hasOwn(workspaceBody,'tools')&&!Object.hasOwn(workspaceBody,'functions'));
      }else if(educationOnly){
        requireTrue(workspace?.includeChartContext===false&&workspace.symbol==='EDUCATION'&&workspace.timeframe==='1m'&&
          prompt.payload.data.profile==='EDUCATION'&&prompt.payload.data.evidence===null&&
          ['Explain market structure and break of structure.','Explain potential liquidity references.','Explain fair value gaps.'].includes(prompt.payload.data.question));
      }else{
        requireTrue(workspace?.includeChartContext===true&&prompt.payload.data.evidence?.symbol===workspace.symbol&&prompt.payload.data.evidence?.frames?.length===1&&
          prompt.payload.data.evidence.frames[0].timeframe===workspace.timeframe&&prompt.payload.data.evidence.quoteStatus==='UNAVAILABLE');
      }
      const body=workspaceChat?structuredClone(workspaceBody):buildBody(d,prompt),wireDigest=digest(body);
      const deadlineMs=Math.min(prompt.expiresAtMs,Date.now()+(workspaceChat?26000:8000));
      const expected={descriptorId:d.descriptorId,policyVersion:d.policyVersion,symbol:workspace.symbol,timeframe:workspace.timeframe};
      const check=async()=>{
        assertLiveRuntime(config);requireTrue(!signal?.aborted&&Date.now()<deadlineMs&&await authorizeMessage()===true);
        requireTrue(await authorizeExport({scope,workspace,policyVersion:d.policyVersion,descriptorId:d.descriptorId,wireDigest,
          payload:structuredClone(body)})===true);
        requireTrue(!signal?.aborted&&Date.now()<deadlineMs);
      };
      await check();
      const pin=await admission.assertConsent(scope,expected);
      const tokens=await countUpperBound(body,d);
      requireTrue(integer(tokens)&&tokens>0&&tokens<=d.maxInputTokens);
      const claim=await admission.claim(scope,{...expected,consentRevision:pin.consentRevision,operationId,
        maxInputTokens:d.maxInputTokens,maxOutputTokens:d.maxOutputTokens});
      let began=false,recorded=false,invoked=false;
      try{
        await check();await admission.beginDispatch(scope,operationId);began=true;
        const raw=await withLiveSecret(config,async key=>{
          requireTrue(!invoked);invoked=true;
          const copy=Buffer.isBuffer(key)?Buffer.from(key):null;
          try{return await exchange({target,body,key:copy,deadlineMs,signal,descriptor:d,onDelta:body.stream?async(delta,wireSignal)=>{
            await check();await admission.assertDisclosure(scope,operationId);
            requireTrue(!wireSignal.aborted&&!signal?.aborted&&Date.now()<deadlineMs);
            await onDelta(delta);
          }:undefined,maxDurationMs:workspaceChat?30000:10000,beforeWrite:async()=>{
            await check();await admission.assertDispatch(scope,operationId);await check();
          }});}finally{copy?.fill(0);}
        });
        requireTrue(invoked);
        const parsed=parseResponse(raw,d);
        const usage={inputTokens:parsed.usage.inputTokens,outputTokens:parsed.usage.outputTokens};
        // This reports provider usage, not an invoice. Trusted billing
        // composition must bind evidence to the attempt and handle uncertainty.
        const settlement=await recordUsage({attemptId:claim.attemptId,kind:'SETTLE',providerResponseId:parsed.providerResponseId,
          descriptorId:d.descriptorId,...usage});
        requireTrue(settlement?.state==='SETTLED');recorded=true;
        await admission.assertDisclosure(scope,operationId);await check();
        if(!parsed.candidate)return {state:'FAILED',usage,...(workspaceChat?{failureReason:parsed.failureReason}: {})};
        if(workspaceChat){
          let answer;try{answer=JSON.parse(parsed.candidate);}catch{return {state:'FAILED',usage,failureReason:'INVALID_ANSWER'};}
          if(!(answer&&Object.keys(answer).length===1&&typeof answer.answer==='string'&&answer.answer.trim()&&
            Buffer.byteLength(answer.answer,'utf8')<=12000))return {state:'FAILED',usage,failureReason:'INVALID_ANSWER'};
          await admission.assertDisclosure(scope,operationId);await check();
          return {state:'ANSWERED',answer:answer.answer.trim(),usage};
        }
        const verified=await verifyCandidate({ticket,scope,candidate:parsed.candidate});
        requireTrue(verified?.verified===true&&verified.response?.verification==='RECOMPUTED_REFERENCE_SELECTION_ONLY'&&
          verified.response.packageId===prompt.packageId&&verified.response.symbol===(educationOnly?null:workspace.symbol)&&Date.now()<verified.response.expiresAtMs);
        await admission.assertDisclosure(scope,operationId);await check();
        return {state:'VERIFIED',response:verified.response,usage};
      }catch{
        if(began&&!recorded)try{await recordUsage({attemptId:claim.attemptId,kind:'UNKNOWN',descriptorId:d.descriptorId});}catch{}
        // Preserve ambiguous claims even when a socket was never opened.
        return {state:recorded?'FAILED':'HELD_UNKNOWN',...(workspaceChat?{failureReason:recorded?'DELIVERY_UNAVAILABLE':'OUTCOME_UNKNOWN'}:{})};
      }
    }
  });
}
// Test-only entry to the same HTTPS parser and write fence. No public DNS,
// approved live descriptor or real API key needed in CI.
function createLoopbackOpenAiWire({port,ca}){
  assertIsolated();requireTrue(Number.isInteger(port)&&port>0&&port<=65535&&Buffer.isBuffer(ca)&&ca.length>0&&ca.length<=65536);
  const trustedCa=Buffer.from(ca);
  return Object.freeze({async run({descriptor,prompt,key,beforeWrite,signal}){
    assertIsolated();
    const body=buildBody(descriptor,prompt);
    const raw=await exchange({target:async()=>({hostname:'127.0.0.1',port,ca:trustedCa}),body,key,
      deadlineMs:Math.min(prompt.expiresAtMs,Date.now()+5000),beforeWrite,signal});
    return parseResponse(raw,descriptor);
  }});
}
module.exports={createLiveOpenAiTransport,createLoopbackOpenAiWire,buildBody,parseResponse};
