'use strict';
const {createHmac,randomBytes}=require('node:crypto');
const {freeze}=require('../intelligence/candle-evidence');
// Only context-free education candidate selections. Not cached final answers,
// live quotes, market evidence, account data, or provider KV-cache control.
function createOfflineEducationCache({now=Date.now,maxEntries=128,maxBytes=262144,ttlMs=5000}={}){
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>1024||
    !Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>4194304||
    !Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>10000)throw Error('Invalid offline cache config');
  const secret=randomBytes(32),entries=new Map();let bytes=0,last=0;
  function time(){const t=now();if(!Number.isSafeInteger(t)||t<last||t<=0){entries.clear();bytes=0;return null;}last=t;return t;}
  function key({scope,request:q,context,policyEpoch}={}){
    if(context!==null||q?.executionMode!=='OFFLINE_TEST_ONLY'||q.request?.data?.profile!=='EDUCATION'||
      q.request?.data?.evidence!==null||typeof policyEpoch!=='string'||!/^[a-zA-Z0-9._:-]{1,128}$/.test(policyEpoch)||
      !['tenantId','actorId','sessionId','accountId'].every(k=>typeof scope?.[k]==='string'&&/^[a-f0-9]{24}$/.test(scope[k])))return null;
    return createHmac('sha256',secret).update(JSON.stringify([
      scope.tenantId,scope.actorId,scope.sessionId,scope.accountId,q.providerId,q.modelId,q.descriptorId,q.fundingMode,
      q.packageId,q.budget.inputTokenUpperBound,q.budget.maxOutputTokens,q.request.stream,policyEpoch])).digest('hex');
  }
  function remove(k){const e=entries.get(k);if(e){bytes-=e.size;entries.delete(k);}}
  function prune(t){for(const [k,e] of entries)if(e.expiresAtMs<=t)remove(k);}
  return Object.freeze({
    get(input){
      const t=time(),k=key(input);if(t===null||!k||t>=input.request.expiresAtMs)return null;
      prune(t);const e=entries.get(k);if(!e)return null;
      entries.delete(k);entries.set(k,e);
      return e.candidate;
    },
    put(input,{candidate,verifiedResponse}={}){
      const t=time(),k=key(input);
      if(t===null||!k||typeof candidate!=='string'||verifiedResponse?.schemaVersion!=='verified-response-v1'||
        verifiedResponse.status!=='ANSWER'||verifiedResponse.contextId!==null||verifiedResponse.symbol!==null||
        verifiedResponse.packageId!==input.request.packageId||!Number.isSafeInteger(verifiedResponse.expiresAtMs)||
        verifiedResponse.observations?.length!==0||verifiedResponse.interpretations?.length!==0||
        !verifiedResponse.education?.length)return false;
      const size=Buffer.byteLength(candidate);if(size<1||size>16384||size>maxBytes)return false;
      let c;try{c=JSON.parse(candidate);}catch{return false;}
      if(c?.schemaVersion!=='candidate-response-v2'||c.status!=='ANSWER'||!Array.isArray(c.observations)||c.observations.length||
        !Array.isArray(c.interpretations)||c.interpretations.length||!Array.isArray(c.education)||!c.education.length||
        Object.keys(c).length!==5||c.education.some(x=>Object.keys(x??{}).length!==1||!/^[a-f0-9]{64}$/.test(x?.knowledgeId??'')))return false;
      const expiresAtMs=Math.min(t+ttlMs,input.request.expiresAtMs,verifiedResponse.expiresAtMs);
      if(expiresAtMs<=t)return false;
      prune(t);remove(k);
      while(entries.size>=maxEntries||bytes+size>maxBytes)remove(entries.keys().next().value);
      entries.set(k,freeze({candidate,expiresAtMs,size}));bytes+=size;return true;
    },
    invalidateAll(){entries.clear();bytes=0;},
  });
}
module.exports={createOfflineEducationCache};
