'use strict';
// A single provider response identity and one assistant choice. The caller
// still owns authorization, dispatch reservation, final settlement and the
// final JSON schema check. Never send raw provider JSON or reasoning to UI.
const {consumeSse}=require('./bounded-stream');
const {mapUsage}=require('./provider-response');
const deny=()=>Object.assign(Error('Workspace stream rejected'),{code:'LIVE_OPENAI_STREAM_INVALID'});
const check=x=>{if(!x)throw deny();};
const bytes=s=>Buffer.byteLength(s,'utf8');
const validId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(s);
// Accept only a JSON string prefix inside the single answer field. Never
// display keys, JSON syntax, tool calls or hidden reasoning. Leave incomplete
// escapes and split surrogate pairs pending until more input arrives.
function answerPrefix(raw){
  const head=/^\s*\{\s*"answer"\s*:\s*"/.exec(raw);
  if(!head)return '';
  let i=head[0].length,end=i;
  while(i<raw.length){
    const c=raw[i];
    if(c==='"')break;
    if(c.charCodeAt(0)<32)throw deny();
    if(c==='\\'){
      if(i+1>=raw.length)break;
      const e=raw[i+1];
      if(e==='u'){
        if(i+6>raw.length)break;
        check(/^[0-9a-fA-F]{4}$/.test(raw.slice(i+2,i+6)));i+=6;
      }else{check('"\\/bfnrt'.includes(e));i+=2;}
    }else i++;
    end=i;
  }
  let decoded;
  try{decoded=JSON.parse('"'+raw.slice(head[0].length,end)+'"');}catch{throw deny();}
  if(/[\uD800-\uDBFF]$/.test(decoded))decoded=decoded.slice(0,-1);
  check(bytes(decoded)<=12000);
  return decoded;
}
function createWorkspaceStreamCollector(descriptor){
  let id=null,raw='',role=false,reason=null,refusal=false,usage=null,done=false,preview='';
  return Object.freeze({
    event({event,data}){
      check(!done&&(event===null||event==='message'));
      if(data==='[DONE]'){check(reason!==null&&usage!==null);done=true;return null;}
      let v;try{v=JSON.parse(data);}catch{throw deny();}
      check(v&&typeof v==='object'&&!Array.isArray(v)&&!v.error&&validId(v.id)&&v.model===descriptor.modelId&&
        (v.object===undefined||v.object==='chat.completion.chunk')&&(v.service_tier===undefined||v.service_tier==='default'));
      if(id===null)id=v.id;check(v.id===id);
      check(Array.isArray(v.choices)&&v.choices.length<=1);
      if(v.choices.length){
        check(reason===null&&usage===null&&v.usage==null);
        const c=v.choices[0],d=c.delta;
        check(c.index===0&&d&&typeof d==='object'&&!Array.isArray(d)&&d.tool_calls==null&&d.function_call==null&&d.audio==null);
        if(d.role!=null){check(d.role==='assistant'&&!role);role=true;}
        if(d.refusal!=null){check(typeof d.refusal==='string');refusal=true;}
        if(d.content!=null){check(typeof d.content==='string'&&role);raw+=d.content;check(bytes(raw)<=16384);}
        if(c.finish_reason!=null){check(['stop','length','content_filter'].includes(c.finish_reason));reason=c.finish_reason;}
        if(refusal||reason==='content_filter'||reason==='length')return null;
        const next=answerPrefix(raw);
        check(next.startsWith(preview));
        const delta=next.slice(preview.length);preview=next;
        return delta||null;
      }
      check(reason!==null&&usage===null&&v.usage!=null);
      const u=mapUsage('openai',v.usage);
      check(u.status==='PROVIDER_REPORTED'&&Number.isSafeInteger(v.usage.total_tokens)&&v.usage.total_tokens===u.inputTokens+u.outputTokens&&
        u.inputTokens<=descriptor.maxInputTokens&&u.outputTokens<=descriptor.maxOutputTokens);
      usage=v.usage;return null;
    },
    result(){
      check(done&&id&&role&&reason!==null&&usage!==null);
      // Convert to exactly the existing non-streaming response contract.
      return {id,model:descriptor.modelId,service_tier:'default',usage,
        choices:[{index:0,finish_reason:reason,message:{role:'assistant',content:raw,refusal:refusal?'refused':null}}]};
    }
  });
}
async function readWorkspaceProviderStream(chunks,{descriptor,signal,timeoutMs,onDelta}){
  const collector=createWorkspaceStreamCollector(descriptor);
  await consumeSse(chunks,{signal,timeoutMs,onEvent:async event=>{
    const delta=collector.event(event);
    if(delta&&onDelta)await onDelta(delta);
  }});
  return collector.result();
}
module.exports={answerPrefix,createWorkspaceStreamCollector,readWorkspaceProviderStream};
