'use strict';
const {scopeFor}=require('../ai-read-gateway');
const {createHash}=require('node:crypto');
const fail=code=>Object.assign(Error('Live provider configuration unavailable'),{code});
const ensure=(v,code='LIVE_AI_CONFIG_INVALID')=>{if(!v)throw fail(code);};
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const positive=v=>Number.isSafeInteger(v)&&v>0;
const approved=new WeakMap();
// Request-bound server composition. The bearer token comes from authenticated
// HTTP middleware, never from a request-body scope. A separate entitlement
// adapter must authorize export of the exact market data and policy version.
function createLiveSessionAuthority({authService,gateway,governanceStore,sessionToken,marketEntitlement,now=Date.now}={}){
  ensure(typeof authService?.authenticateSessionToken==='function'&&typeof gateway?.assertDisclosure==='function'&&
    typeof governanceStore?.control==='function'&&typeof sessionToken==='function'&&typeof marketEntitlement==='function');
  async function resolve(s,purpose){
    const principal=await authService.authenticateSessionToken(await sessionToken());
    const current=scopeFor(principal,s.accountId,now(),purpose!=='REVOKE');
    if(purpose!=='REVOKE'){
      await gateway.assertDisclosure(principal,{accountId:s.accountId,connectionId:s.connectionId,toolId:'account.valuation.read',args:{}});
      ensure((await governanceStore.control(current.tenantId)).enabled===true,'LIVE_AI_PAUSED');
    }
    return {tenantId:current.tenantId,actorId:current.actorId,sessionId:current.sessionId,accountId:current.accountId,connectionId:s.connectionId};
  }
  return Object.freeze({
    authorizeSession:resolve,
    async authorizeMarket(s,w,purpose){
      const fresh=await resolve(s,purpose);
      if(!Object.keys(fresh).every(k=>fresh[k]===s[k]))return false;
      if(await marketEntitlement(Object.freeze({...fresh}),Object.freeze({...w}),purpose)!==true)return false;
      const again=await resolve(s,purpose);
      return Object.keys(again).every(k=>again[k]===s[k]);
    }
  });
}
// Configuration validation only. This is not a live HTTP adapter or a model
// registry approval. No secret is read or returned, and no endpoint is
// configurable. An approved descriptor and secret port must be supplied by
// trusted deployment composition; the default remains disabled.
function createLiveRuntimeConfig({env=process.env,descriptor=null,secretPort=null,verifyRelease=null}={}){
  if(env.ACG_AI_LIVE_PROVIDER_ENABLED!=='true')return Object.freeze({enabled:false});
  ensure(typeof verifyRelease==='function'&&verifyRelease()===true,'LIVE_AI_RELEASE_NOT_APPROVED');
  ensure(descriptor?.providerId==='openai'&&descriptor.reviewStatus==='APPROVED_LIVE'&&
    typeof descriptor.modelId==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(descriptor.modelId)&&
    hex(descriptor.descriptorId)&&hex(descriptor.policyVersion)&&positive(descriptor.inputRatePicoUsd)&&positive(descriptor.outputRatePicoUsd)&&
    positive(descriptor.maxInputTokens)&&descriptor.maxInputTokens<=32768&&positive(descriptor.maxOutputTokens)&&descriptor.maxOutputTokens<=4096&&
    descriptor.responseMode==='JSON_SCHEMA'&&descriptor.store===false&&descriptor.streaming===false,'LIVE_AI_DESCRIPTOR_UNAPPROVED');
  ensure(typeof secretPort?.withSecret==='function','LIVE_AI_SECRET_UNAVAILABLE');
  const fields={providerId:descriptor.providerId,modelId:descriptor.modelId,policyVersion:descriptor.policyVersion,
    inputRatePicoUsd:descriptor.inputRatePicoUsd,outputRatePicoUsd:descriptor.outputRatePicoUsd,maxInputTokens:descriptor.maxInputTokens,
    maxOutputTokens:descriptor.maxOutputTokens,responseMode:descriptor.responseMode,store:false,streaming:false,reviewStatus:descriptor.reviewStatus};
  const digest=createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  ensure(digest===descriptor.descriptorId,'LIVE_AI_DESCRIPTOR_CHANGED');
  const pinned=Object.freeze({...fields,descriptorId:digest});
  const config=Object.freeze({enabled:true,descriptor:pinned,hostname:'api.openai.com',path:'/v1/chat/completions',
    async resolvePrice(id){return id===digest?{descriptorId:digest,approved:true,inputRatePicoUsd:pinned.inputRatePicoUsd,outputRatePicoUsd:pinned.outputRatePicoUsd,maxInputTokens:pinned.maxInputTokens,maxOutputTokens:pinned.maxOutputTokens,policyVersion:pinned.policyVersion}:null;},
  });
  approved.set(config,{verifyRelease,secretPort,env});return config;
}
// Internal transport access, never expose to HTTP handlers. Recheck the
// release switch on each operation and immediately before credential use.
function assertLiveRuntime(config){
  const state=approved.get(config);
  ensure(state&&state.env.ACG_AI_LIVE_PROVIDER_ENABLED==='true'&&state.verifyRelease()===true,'LIVE_AI_RELEASE_NOT_APPROVED');
  return true;
}
async function withLiveSecret(config,fn){
  assertLiveRuntime(config);
  ensure(typeof fn==='function');
  return approved.get(config).secretPort.withSecret(fn);
}
module.exports={createLiveRuntimeConfig,createLiveSessionAuthority,assertLiveRuntime,withLiveSecret};
