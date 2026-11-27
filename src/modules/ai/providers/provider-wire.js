'use strict';
const {freeze}=require('../intelligence/candle-evidence');
const {CONTRACT_VERSION,CANDIDATE_JSON_SCHEMA}=require('./provider-contract');
const CHAT=Object.freeze({
  openai:'https://api.openai.com/v1/chat/completions',
  deepseek:'https://api.deepseek.com/chat/completions',
  openrouter:'https://openrouter.ai/api/v1/chat/completions',
});
function fail(code='ADAPTER_REQUEST_INVALID'){throw Object.assign(Error('Provider adapter unavailable'),{code});}
function buildWireRequest(q){
  if(q?.contractVersion!==CONTRACT_VERSION||q.executionMode!=='OFFLINE_TEST_ONLY'||
    typeof q.modelId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(q.modelId)||
    !q.request||!Array.isArray(q.request.tools)||q.request.tools.length||
    typeof q.request.stream!=='boolean'||!Number.isSafeInteger(q.request.maxOutputTokens)||
    q.request.maxOutputTokens<1||!['JSON_SCHEMA','JSON_OBJECT'].includes(q.request.responseMode))
    fail();
  const {instruction,data,maxOutputTokens,stream,responseMode}=q.request;
  const system=JSON.stringify(instruction),user=JSON.stringify(data);
  if(typeof system!=='string'||typeof user!=='string'||Buffer.byteLength(system)+Buffer.byteLength(user)>49152)fail();
  const strict=responseMode==='JSON_SCHEMA';
  const schema=CANDIDATE_JSON_SCHEMA;
  let url,body,headers={'content-type':'application/json'},authScheme;
  if(Object.hasOwn(CHAT,q.providerId)){
    if(q.providerId==='deepseek'&&strict)fail('ADAPTER_SCHEMA_UNSUPPORTED');
    url=CHAT[q.providerId];authScheme='BEARER';
    body={model:q.modelId,messages:[{role:'system',content:system},{role:'user',content:user}],stream,
      [q.providerId==='openai'?'max_completion_tokens':'max_tokens']:maxOutputTokens,
      response_format:strict?{type:'json_schema',json_schema:{name:'acg_candidate',strict:true,schema}}:{type:'json_object'}};
    if(stream)body.stream_options={include_usage:true};
    if(q.providerId==='openai')body.store=false;
    // No provider failover permission. Actual route pinning is a later gate.
    if(q.providerId==='openrouter')body.provider={allow_fallbacks:false,require_parameters:true};
  }else if(q.providerId==='anthropic'){
    url='https://api.anthropic.com/v1/messages';authScheme='X_API_KEY';headers['anthropic-version']='2023-06-01';
    body={model:q.modelId,system:strict?system:system+'\nReturn a JSON object matching the supplied candidate response contract.',
      messages:[{role:'user',content:user}],max_tokens:maxOutputTokens,stream};
    if(strict)body.output_config={format:{type:'json_schema',schema}};
  }else if(q.providerId==='gemini'){
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(q.modelId))fail();
    url='https://generativelanguage.googleapis.com/v1beta/models/'+q.modelId+
      (stream?':streamGenerateContent?alt=sse':':generateContent');
    authScheme='X_GOOG_API_KEY';
    body={systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:user}]}],
      generationConfig:{candidateCount:1,maxOutputTokens,responseMimeType:'application/json',
        ...(strict?{responseJsonSchema:schema}:{})}};
  }else fail('ADAPTER_PROVIDER_UNSUPPORTED');
  return freeze({mode:'OFFLINE_WIRE_FIXTURE_ONLY',method:'POST',url,headers,authScheme,body,
    redirect:'error',networkEnabled:false});
}
module.exports={buildWireRequest};
