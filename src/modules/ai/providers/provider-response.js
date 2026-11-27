'use strict';
const {isDeepStrictEqual}=require('node:util');
const {normalizeOfflineOutcome,MAX_CANDIDATE_BYTES}=require('./provider-contract');
const {buildWireRequest}=require('./provider-wire');
const {consumeBytes,consumeSse}=require('./bounded-stream');
const CHAT=new Set(['openai','deepseek','openrouter']);
const unknown=()=>({status:'UNKNOWN'});
const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=10000000;
function invalid(code='INVALID_RESPONSE'){throw Object.assign(Error('Provider response rejected'),{code});}
function usage(input,output,cached=null,reasoning=null,total=null){
  if(!count(input)||!count(output)||(cached!==null&&(!count(cached)||cached>input))||
    (reasoning!==null&&(!count(reasoning)||reasoning>output))||
    (total!==null&&(!Number.isSafeInteger(total)||total!==input+output)))return unknown();
  return {status:'PROVIDER_REPORTED',inputTokens:input,outputTokens:output,cachedInputTokens:cached,reasoningOutputTokens:reasoning};
}
function mapUsage(provider,u){
  if(!u||typeof u!=='object')return unknown();
  if(CHAT.has(provider)){
    const c=u.prompt_tokens_details?.cached_tokens??u.prompt_cache_hit_tokens??null;
    if(u.prompt_tokens_details?.cached_tokens!=null&&u.prompt_cache_hit_tokens!=null&&u.prompt_tokens_details.cached_tokens!==u.prompt_cache_hit_tokens)return unknown();
    if(u.prompt_cache_miss_tokens!=null&&(!count(u.prompt_cache_miss_tokens)||!count(c)||c+u.prompt_cache_miss_tokens!==u.prompt_tokens))return unknown();
    return usage(u.prompt_tokens,u.completion_tokens,c,u.completion_tokens_details?.reasoning_tokens??null,u.total_tokens??null);
  }
  if(provider==='anthropic'){
    const read=u.cache_read_input_tokens??0,write=u.cache_creation_input_tokens??0;
    if(!count(u.input_tokens)||!count(read)||!count(write)||u.server_tool_use!=null)return unknown();
    const base=usage(u.input_tokens+read+write,u.output_tokens,read,null);
    if(base.status==='UNKNOWN')return base;
    const a=u.cache_creation?.ephemeral_5m_input_tokens,b=u.cache_creation?.ephemeral_1h_input_tokens;
    if(u.cache_creation!=null&&(!count(a)||!count(b)||a+b!==write))return unknown();
    return {...base,cacheWriteInputTokens:write,cacheWrite5mInputTokens:write===0?0:a??null,
      cacheWrite1hInputTokens:write===0?0:b??null};
  }
  if(provider==='gemini'){
    const thoughts=u.thoughtsTokenCount??0,tools=u.toolUsePromptTokenCount??0;
    if(!count(thoughts)||tools!==0||!count(u.candidatesTokenCount)||!count(u.totalTokenCount))return unknown();
    return usage(u.promptTokenCount,u.candidatesTokenCount+thoughts,u.cachedContentTokenCount??null,
      u.thoughtsTokenCount??null,u.totalTokenCount);
  }
  return unknown();
}
function finishStatus(provider,reason){
  if(CHAT.has(provider)){
    if(reason==='stop')return 'COMPLETED';
    if(reason==='length')return 'INCOMPLETE';
    if(reason==='content_filter')return 'REFUSED';
  }else if(provider==='anthropic'){
    if(reason==='end_turn')return 'COMPLETED';
    if(reason==='max_tokens')return 'INCOMPLETE';
    if(reason==='refusal')return 'REFUSED';
  }else if(provider==='gemini'){
    if(reason==='STOP')return 'COMPLETED';
    if(reason==='MAX_TOKENS')return 'INCOMPLETE';
    if(['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII'].includes(reason))return 'REFUSED';
  }
  return 'FAILED';
}
function errorForStatus(status){
  if(status===401||status===403)return 'AUTHENTICATION';
  if(status===402)return 'QUOTA';
  if(status===429)return 'RATE_LIMIT';
  if(status===408||status===504)return 'TIMEOUT';
  if(status>=500&&status<=599)return 'UNAVAILABLE';
  return 'INVALID_RESPONSE';
}
function createCollector(q){
  const provider=q.providerId;
  let text='',bytes=0,reason=null,terminal=false,started=false,block=null,blockCount=0,refusal=false,rawUsage=null,modelSeen=false;
  function add(s){
    if(typeof s!=='string')invalid();
    bytes+=Buffer.byteLength(s,'utf8');if(bytes>MAX_CANDIDATE_BYTES)invalid('STREAM_LIMIT');
    text+=s;
  }
  function setReason(r){
    if(typeof r!=='string'||reason!==null)invalid();
    reason=r;
  }
  function sameModel(m){if(m!==q.modelId)invalid('MODEL_MISMATCH');}
  function noTools(v){if(v?.function_call!=null||v?.tool_calls!=null&&(!Array.isArray(v.tool_calls)||v.tool_calls.length))invalid();}
  function chatText(v){
    if(!v||typeof v!=='object')invalid();
    noTools(v);
    if(v.role!=null&&v.role!=='assistant')invalid();
    if(v.refusal!=null){if(typeof v.refusal!=='string')invalid();refusal=true;}
    if(v.content!=null)add(v.content);
    // Provider reasoning fields deliberately never copied into candidate output.
  }
  function gemini(v){
    if(v.modelVersion!=null){sameModel(v.modelVersion);modelSeen=true;}
    if(v.promptFeedback?.blockReason&&v.promptFeedback.blockReason!=='BLOCK_REASON_UNSPECIFIED'){
      if(reason!==null||text||v.candidates?.length)invalid();
      reason='SAFETY';refusal=true;
    }
    if(v.candidates!=null){
      if(!Array.isArray(v.candidates)||v.candidates.length>1)invalid();
      if(v.candidates.length){
        if(reason!==null)invalid();
        const c=v.candidates[0];if(c.index!=null&&c.index!==0)invalid();
        if(c.content?.role!=null&&c.content.role!=='model')invalid();
        if(c.content?.parts!=null){
          if(!Array.isArray(c.content.parts))invalid();
          for(const p of c.content.parts){
            if(typeof p.text!=='string'||['functionCall','functionResponse','inlineData','fileData','executableCode','codeExecutionResult'].some(k=>Object.hasOwn(p,k)))invalid();
            if(p.thought!==true)add(p.text);
          }
        }
        if(c.finishReason!=null)setReason(c.finishReason);
      }
    }
    if(v.usageMetadata!=null&&reason!==null){
      if(rawUsage!==null&&!isDeepStrictEqual(rawUsage,v.usageMetadata))invalid();
      rawUsage=v.usageMetadata;
    }
  }
  function json(v){
    if(!v||typeof v!=='object'||Array.isArray(v)||v.error)invalid();
    if(CHAT.has(provider)){
      sameModel(v.model);
      if(!Array.isArray(v.choices)||v.choices.length!==1||v.choices[0].index!==0)invalid();
      chatText(v.choices[0].message);setReason(v.choices[0].finish_reason);rawUsage=v.usage??null;
    }else if(provider==='anthropic'){
      sameModel(v.model);
      if(v.role!=='assistant'||!Array.isArray(v.content))invalid();
      for(const p of v.content){if(p.type!=='text')invalid();add(p.text);}
      setReason(v.stop_reason);rawUsage=v.usage??null;
    }else if(provider==='gemini')gemini(v);
    else invalid();
    terminal=true;
  }
  function event({event,data}){
    if(terminal)invalid();
    if(data==='[DONE]'){
      if(!CHAT.has(provider)||reason===null)invalid();
      terminal=true;return;
    }
    let v;try{v=JSON.parse(data);}catch{invalid();}
    if(!v||typeof v!=='object'||Array.isArray(v)||v.error)invalid();
    if(CHAT.has(provider)){
      sameModel(v.model);
      if(!Array.isArray(v.choices)||v.choices.length>1)invalid();
      if(v.choices.length){
        if(reason!==null)invalid();
        const c=v.choices[0];if(c.index!==0)invalid();
        chatText(c.delta);if(c.finish_reason!=null)setReason(c.finish_reason);
      }
      if(v.usage!=null){
        if(reason===null||rawUsage!==null)invalid();
        rawUsage=v.usage;
      }
    }else if(provider==='anthropic'){
      if(event!==v.type)invalid();
      switch(v.type){
        case 'ping':break;
        case 'message_start':
          if(started||reason!==null||v.message?.role!=='assistant'||!Array.isArray(v.message.content)||v.message.content.length)invalid();
          sameModel(v.message.model);started=true;rawUsage=v.message.usage??null;break;
        case 'content_block_start':
          if(!started||reason!==null||block!==null||v.index!==blockCount||v.content_block?.type!=='text')invalid();
          block=v.index;blockCount++;add(v.content_block.text);break;
        case 'content_block_delta':
          if(block===null||v.index!==block||v.delta?.type!=='text_delta')invalid();
          add(v.delta.text);break;
        case 'content_block_stop':
          if(block===null||v.index!==block)invalid();block=null;break;
        case 'message_delta':
          if(!started||block!==null||reason!==null)invalid();
          setReason(v.delta?.stop_reason);rawUsage=count(v.usage?.output_tokens)?{...rawUsage,...v.usage}:null;break;
        case 'message_stop':
          if(!started||block!==null||reason===null)invalid();
          terminal=true;break;
        default:invalid();
      }
    }else if(provider==='gemini')gemini(v);
    else invalid();
  }
  return {json,event,result(){
    // Gemini has no [DONE] marker: require explicit finish plus clean SSE EOF.
    if((provider!=='gemini'&&!terminal)||reason===null)invalid('TRUNCATED_STREAM');
    const status=refusal?'REFUSED':finishStatus(provider,reason);
    if(status==='COMPLETED'&&(!text.trim()||provider==='gemini'&&!modelSeen))invalid();
    return {status,candidate:status==='COMPLETED'?text:null,usage:mapUsage(provider,rawUsage),
      errorCode:status==='COMPLETED'?'NONE':status==='FAILED'?'INVALID_RESPONSE':'UNKNOWN'};
  }};
}
// Offline response normalization for byte fixtures or the isolated TLS rehearsal.
// This parser never opens a socket or handles credentials.
async function normalizeFixtureResponse(q,{httpStatus,contentType,chunks,signal,timeoutMs=1000,now=Date.now}={}){
  buildWireRequest(q);
  const base={requestId:q.requestId,providerId:q.providerId,modelId:q.modelId,descriptorId:q.descriptorId};
  const finish=x=>normalizeOfflineOutcome(q,{...base,...x});
  const failure=(status,errorCode)=>finish({status,candidate:null,usage:unknown(),errorCode});
  if(signal?.aborted)return failure('CANCELLED','CANCELLED');
  const t=now();
  if(!Number.isSafeInteger(t)||t<q.createdAtMs||t>=q.expiresAtMs)return failure('UNKNOWN','TIMEOUT');
  if(!Number.isInteger(httpStatus)||httpStatus<100||httpStatus>599)return failure('FAILED','INVALID_RESPONSE');
  if(httpStatus<200||httpStatus>=300)return failure('FAILED',errorForStatus(httpStatus));
  const mime=typeof contentType==='string'?contentType.split(';')[0].trim().toLowerCase():'';
  if(mime!==(q.request.stream?'text/event-stream':'application/json'))return failure('FAILED','INVALID_RESPONSE');
  const collector=createCollector(q);
  try{
    const budget=Math.min(timeoutMs,q.expiresAtMs-t);
    if(q.request.stream)await consumeSse(chunks,{signal,timeoutMs:budget,onEvent:collector.event});
    else{
      let body='';
      await consumeBytes(chunks,{signal,timeoutMs:budget,onText:s=>{body+=s;}});
      collector.json(JSON.parse(body));
    }
    if(signal?.aborted)return failure('CANCELLED','CANCELLED');
    const end=now();
    if(!Number.isSafeInteger(end)||end<t||end>=q.expiresAtMs)return failure('UNKNOWN','TIMEOUT');
    return finish(collector.result());
  }catch(e){
    if(e?.code==='CANCELLED')return failure('CANCELLED','CANCELLED');
    if(e?.code==='TIMEOUT')return failure('UNKNOWN','TIMEOUT');
    if(e?.code==='TRUNCATED_STREAM')return failure('INCOMPLETE','INVALID_RESPONSE');
    return failure('FAILED','INVALID_RESPONSE');
  }
}
module.exports={normalizeFixtureResponse,mapUsage};
