'use strict';
const assert=require('node:assert/strict');
const express=require('express');
const {randomUUID}=require('node:crypto');
const {createIsolatedChatRouter}=require('../src/modules/ai/ai-chat.routes');
const {createModelRegistry}=require('../src/modules/ai/providers/model-registry');
const {createAiGovernance}=require('../src/modules/ai/ai-governance');
const {createAiQuota}=require('../src/modules/ai/ai-quota');
const {createAiQuotaStore}=require('../src/modules/ai/ai-quota-store');
const {AiAuditEvent}=require('../src/modules/ai/ai-governance.model');
async function runPhase4ChatIntegration({auth,gateway,gs,token,foreignToken,readRequest,scope}){
  const capability={input:'TEXT',responseMode:'JSON_OBJECT',separateInstructionChannel:true,streaming:false,
    usageReporting:'PROVIDER_REPORTED',maxContextTokens:8192,maxOutputTokens:1024};
  const descriptor={providerId:'openai',modelId:'fixture-chat',revision:'v1',reviewStatus:'SYNTHETIC_TEST_ONLY',
    fundingModes:['BYO_API','ACG_CREDITS'],capabilities:capability};
  const registry=createModelRegistry({allowSynthetic:true,descriptors:[descriptor,
    {...descriptor,modelId:'planned-model',reviewStatus:'PROPOSED'},
    {...descriptor,modelId:'filtered-model'}]});
  let allowed=true,lateDeny=false,checks=0;
  // Distinct deterministic quota bucket, to avoid disturbing Phase 1's shared-window test.
  const quotaNow=Date.now()+3600000;
  const app=express();
  // Synthetic-only HTTP listener and real current identity/grant/quota/audit.
  app.use('/v1/ai/chat',createIsolatedChatRouter({authService:auth,gateway,governance:createAiGovernance({store:gs}),
    quota:createAiQuota({store:createAiQuotaStore(),now:()=>quotaNow,limit:30}),registry,
    authorizePurpose:async x=>{
      assert.equal(x.externalExport,false);assert.equal(x.offlineOnly,true);
      assert.equal(x.scope.actorId,scope.actorId);
      if(x.selection?.modelId==='filtered-model')return false;
      if(lateDeny&&x.selection&&++checks>=2)return false;
      return allowed;
    }}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const root='http://127.0.0.1:'+server.address().port+'/v1/ai/chat';
  const a={accountId:readRequest.accountId,connectionId:readRequest.connectionId};
  async function send(path,body,credential=token,headers={}){
    const response=await fetch(root+path,{method:'POST',headers:{'content-type':'application/json',
      ...(credential?{authorization:'Bearer '+credential}:{}),...headers},body:JSON.stringify(body)});
    const text=await response.text();
    return {status:response.status,cache:response.headers.get('cache-control'),text,body:response.headers.get('content-type')?.includes('json')?JSON.parse(text):null};
  }
  try{
    assert.equal((await send('/capabilities',a,null)).status,401);
    const d=await send('/capabilities',a);assert.equal(d.status,200);assert.equal(d.cache,'no-store');
    assert.equal(d.body.runtimeEnabled,false);assert.equal(d.body.sendEnabled,false);
    assert.equal(d.body.providers.length,6);assert.ok(d.body.providers.every(p=>p.runtimeEnabled===false));
    assert.equal(d.body.rehearsalOptions.length,1);
    const {providerId,modelId,descriptorId,fundingMode}=d.body.rehearsalOptions[0];
    const input={...a,selection:{providerId,modelId,descriptorId,fundingMode},profile:'EDUCATION'};
    assert.ok(!d.text.includes(scope.actorId)&&!d.text.includes(scope.sessionId)&&!d.text.includes(a.connectionId));
    const ok=await send('/preflight',input);assert.equal(ok.status,200);assert.equal(ok.body.dispatchAllowed,false);
    assert.equal(ok.body.creditDeducted,false);assert.equal(ok.body.status,'VALIDATED_OFFLINE_ONLY');
    assert.equal((await send('/preflight',{...input,selection:{...input.selection,fundingMode:'ACG_CREDITS'}})).body.error.code,'AI_CHAT_FUNDING_DISABLED');
    assert.equal((await send('/preflight',{...input,selection:{...input.selection,descriptorId:'f'.repeat(64)}})).status,409);
    assert.equal((await send('/preflight',{...input,selection:{...input.selection,modelId:'planned-model'}})).status,409);
    assert.equal((await send('/preflight',{...input,question:'api_key=fixture-secret'})).status,400);
    assert.equal((await send('/preflight',{...input,context:{symbol:'XAUUSD'}})).status,400);
    assert.equal((await send('/capabilities',{...a,connectionId:randomUUID()})).status,403);
    assert.equal((await send('/capabilities',a,foreignToken)).status,403);
    assert.equal((await send('/capabilities?debug=true',a)).status,400);
    assert.equal((await send('/capabilities',a,token,{'content-type':'text/plain'})).status,415);
    assert.equal((await send('/messages',{...input,question:'Do not dispatch.'})).status,404);
    allowed=false;assert.equal((await send('/capabilities',a)).status,403);allowed=true;
    lateDeny=true;checks=0;assert.equal((await send('/preflight',input)).status,403);lateDeny=false;
    const events=await AiAuditEvent.find({tenantId:scope.tenantId,operation:{$in:['CHAT_DISCOVER_OFFLINE','CHAT_PREFLIGHT_OFFLINE']}}).lean();
    assert.ok(events.some(e=>e.stage==='ALLOWED'));assert.ok(events.some(e=>e.stage==='DENIED'));
    assert.ok(events.some(e=>e.stage==='SUPPRESSED'));
    assert.ok(events.every(e=>!Object.hasOwn(e,'selection')&&!Object.hasOwn(e,'question')&&!Object.hasOwn(e,'result')));
    console.log('PASS Phase 4B authenticated isolated capability discovery, filtered synthetic catalog, model/funding validation, late purpose revocation, no dispatch or sensitive payload disclosure');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
module.exports={runPhase4ChatIntegration};
