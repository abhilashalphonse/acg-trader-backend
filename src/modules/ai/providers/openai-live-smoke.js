'use strict';
const https=require('node:https');
const dns=require('node:dns').promises;
const net=require('node:net');
const {performance}=require('node:perf_hooks');
const {randomUUID}=require('node:crypto');
const {createResponseEngine}=require('../intelligence/response-engine');
const {CANDIDATE_JSON_SCHEMA}=require('./provider-contract');
const {consumeBytes}=require('./bounded-stream');
const {mapUsage}=require('./provider-response');
const MODEL='gpt-6-luna',HOST='api.openai.com',PATH='/v1/chat/completions';
const INPUT_PLANNING_TOKENS=8192,MAX_OUTPUT_TOKENS=512,MAX_REQUEST_BYTES=8192;
const APPROVAL='ONE_SYNTHETIC_OPENAI_REQUEST';
const fail=code=>Object.assign(Error('OpenAI smoke unavailable'),{code});
function publicIPv4(ip){
  if(net.isIP(ip)!==4)return false;
  const [a,b,c]=ip.split('.').map(Number);
  // Conservative denylist of private, loopback, shared, link-local,
  // documentation, benchmarking, protocol and reserved address blocks.
  return a>0&&a<224&&a!==10&&a!==127&&!(a===100&&b>=64&&b<=127)&&
    !(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&
    !(a===192&&b===0&&(c===0||c===2))&&!(a===192&&b===88&&c===99)&&
    !(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);
}
function makeBody(knowledgeId){
  if(typeof knowledgeId!=='string'||!/^[a-f0-9]{64}$/.test(knowledgeId))throw fail('SMOKE_INVALID_REFERENCE');
  // Deliberately do not export the internal knowledge catalog, market data,
  // account/session IDs, real user questions or even the internal prompt package.
  return {model:MODEL,store:false,stream:false,n:1,max_completion_tokens:MAX_OUTPUT_TOKENS,
    reasoning_effort:'none',service_tier:'default',messages:[
      {role:'system',content:'Synthetic integration test. Select the supplied knowledge reference in a candidate-response-v2 JSON object. Do not provide prose, tools, or any market facts.'},
      {role:'user',content:JSON.stringify({exercise:'Fictional educational reference selection only.',
        allowedKnowledgeId:knowledgeId,expectedStatus:'ANSWER',observations:[],interpretations:[]})}],
    response_format:{type:'json_schema',json_schema:{name:'acg_smoke_candidate',strict:true,schema:CANDIDATE_JSON_SCHEMA}}};
}
function parseResponse(raw){
  if(!raw||raw.model!==MODEL||!Array.isArray(raw.choices)||raw.choices.length!==1||
    raw.choices[0]?.index!==0||raw.choices[0]?.finish_reason!=='stop')throw fail('SMOKE_RESPONSE_INVALID');
  const m=raw.choices[0].message;
  if(m?.role!=='assistant'||m.refusal!=null||m.tool_calls!=null||m.function_call!=null||
    typeof m.content!=='string'||Buffer.byteLength(m.content,'utf8')>16384)throw fail('SMOKE_RESPONSE_INVALID');
  const u=mapUsage('openai',raw.usage);
  if(u.status!=='PROVIDER_REPORTED'||u.inputTokens>INPUT_PLANNING_TOKENS||u.outputTokens>MAX_OUTPUT_TOKENS)
    throw fail('SMOKE_USAGE_UNCERTAIN');
  return {candidate:m.content,inputTokens:u.inputTokens,outputTokens:u.outputTokens};
}
// Only called by the explicitly approved standalone smoke, never by app routes.
// Fixed public hostname, direct TLS socket to a validated DNS A record.
// No configurable endpoint, redirects, proxy, SDK retry or streaming.
async function publicExchange(body,key,{timeoutMs=8000}={}){
  const start=performance.now(),controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  let req,res,bytes;
  try{
    const addresses=await Promise.race([dns.resolve4(HOST),new Promise((_,reject)=>{
      controller.signal.addEventListener('abort',()=>reject(fail('SMOKE_TIMEOUT')),{once:true});
    })]);
    if(!addresses.length||addresses.length>32||!addresses.every(publicIPv4)||controller.signal.aborted)
      throw fail('SMOKE_DNS_REJECTED');
    const address=addresses[0];
    bytes=Buffer.from(JSON.stringify(body),'utf8');
    if(bytes.length>MAX_REQUEST_BYTES)throw fail('SMOKE_REQUEST_LIMIT');
    res=await new Promise((resolve,reject)=>{
      req=https.request({hostname:HOST,port:443,path:PATH,method:'POST',family:4,autoSelectFamily:false,
        lookup:(_hostname,options,callback)=>options?.all?callback(null,[{address,family:4}]):callback(null,address,4),
        servername:HOST,rejectUnauthorized:true,minVersion:'TLSv1.2',agent:false,signal:controller.signal,maxHeaderSize:16384,
        headers:{authorization:'Bearer '+key.toString('ascii'),'content-type':'application/json','accept':'application/json',
          'accept-encoding':'identity','content-length':bytes.length}},resolve);
      req.on('error',reject);req.end(bytes);
    });
    const status=res.statusCode;
    if(status!==200)throw fail(status===401||status===403?'SMOKE_AUTH_DENIED':status===429?'SMOKE_RATE_LIMIT':'SMOKE_HTTP_REJECTED');
    if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||
      res.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw fail('SMOKE_RESPONSE_INVALID');
    const remaining=Math.floor(timeoutMs-(performance.now()-start));
    if(remaining<1)throw fail('SMOKE_TIMEOUT');
    let raw='';
    await consumeBytes(res,{signal:controller.signal,timeoutMs:remaining,onText:t=>{raw+=t;}});
    if(controller.signal.aborted)throw fail('SMOKE_TIMEOUT');
    try{return JSON.parse(raw);}catch{throw fail('SMOKE_RESPONSE_INVALID');}
  }catch(e){
    if(controller.signal.aborted)throw fail('SMOKE_TIMEOUT');
    if(typeof e?.code==='string'&&/^SMOKE_[A-Z_]+$/.test(e.code))throw fail(e.code);
    throw fail('SMOKE_NETWORK_UNCERTAIN');
  }finally{clearTimeout(timer);res?.destroy();req?.destroy();bytes?.fill(0);}
}
async function runApprovedSmoke({approval,key,claim,finish}={}){
  // Dedicated nonproduction CLI only. CI must never make external requests.
  if(process.env.NODE_ENV!=='acg-ai-live-smoke'||process.env.CI==='true'||approval!==APPROVAL||
    !Buffer.isBuffer(key)||key.length<20||key.length>4096||!key.every(v=>v>=33&&v<=126)||
    typeof claim!=='function'||typeof finish!=='function')throw fail('SMOKE_DISABLED');
  // Synthetic scope never leaves this process. Internal knowledge is used
  // exclusively to verify the provider's selected opaque reference.
  const scope={tenantId:'a'.repeat(24),actorId:'b'.repeat(24),sessionId:'c'.repeat(24),accountId:'d'.repeat(24)};
  const engine=createResponseEngine({authorize:async()=>true});
  const {ticket,prompt}=await engine.prepare({scope,profile:'EDUCATION',question:'Synthetic reference selection smoke.'});
  const reference=prompt.payload.data.knowledge.entries.find(k=>k.id==='MARKET_STRUCTURE').knowledgeId;
  const body=makeBody(reference),attemptId=randomUUID();
  if(Buffer.byteLength(JSON.stringify(body),'utf8')>MAX_REQUEST_BYTES)throw fail('SMOKE_REQUEST_LIMIT');
  // The external process must persist a one-shot claim before DNS/socket work.
  await claim({attemptId,model:MODEL,createdAtMs:Date.now(),state:'CLAIMED'});
  let result={attemptId,model:MODEL,state:'HELD_UNKNOWN',code:'SMOKE_NETWORK_UNCERTAIN'};
  try{
    const v=parseResponse(await publicExchange(body,key));
    const verified=await engine.verify({ticket,scope,candidate:v.candidate});
    if(!verified.verified||verified.response.status!=='ANSWER'||verified.response.education.length!==1||
      verified.response.education[0].knowledgeId!==reference||verified.response.observations.length||verified.response.interpretations.length)
      throw fail('SMOKE_VERIFICATION_REJECTED');
    result={attemptId,model:MODEL,state:'VERIFIED',inputTokens:v.inputTokens,outputTokens:v.outputTokens,
      verification:'REFERENCE_SELECTION_ONLY',customerDataExported:false,acgCreditsDeducted:false};
  }catch(e){result={...result,code:typeof e?.code==='string'&&/^SMOKE_[A-Z_]+$/.test(e.code)?e.code:'SMOKE_UNKNOWN'};}
  finally{key.fill(0);}
  await finish(result);return result;
}
module.exports={runApprovedSmoke,publicIPv4,makeBody,parseResponse,MODEL,APPROVAL,INPUT_PLANNING_TOKENS,MAX_OUTPUT_TOKENS};
