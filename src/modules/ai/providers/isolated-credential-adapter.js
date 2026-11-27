'use strict';
const {assertIsolated}=require('./credit-ledger-store');
const {connectionId}=require('./credential-vault');
const {CONTRACT_VERSION,normalizeOfflineOutcome}=require('./provider-contract');
const {freeze}=require('../intelligence/candle-evidence');
const deny=code=>Object.assign(Error('Provider credential use denied'),{code});
const same=(d,other)=>d&&other&&['_id','tenantId','actorId','providerId','revision','generation','status'].every(k=>d[k]===other[k]);
const id=v=>typeof v==='string'&&/^[a-f0-9]{24}$/.test(v);
// Infrastructure-only adapter. No plaintext returned to the app, no credential
// acceptance from an HTTP request, no model activation. A fresh authorization
// and vault revision/generation are checked before and after transport.
function createIsolatedCredentialAdapter({scope,selection,registry,store,crypto,transport,authorize,admission,operationId,now=Date.now}={}){
  assertIsolated();
  if(!['tenantId','actorId','sessionId','accountId'].every(k=>id(scope?.[k]))||
    typeof operationId!=='string'||!/^[a-f0-9-]{36}$/.test(operationId)||selection?.fundingMode!=='BYO_API'||typeof authorize!=='function'||
    typeof store?.get!=='function'||typeof crypto?.decrypt!=='function'||
    typeof transport?.exchange!=='function'||typeof admission?.claim!=='function'||typeof admission?.finish!=='function')
    throw deny('TRANSPORT_CONFIG_INVALID');
  const owner=freeze(Object.fromEntries(['tenantId','actorId','sessionId','accountId'].map(k=>[k,scope[k]])));
  const picked=freeze(structuredClone(selection)),model=registry.resolveForOfflineTest(picked);
  const providerId=model.providerId,modelId=model.modelId,key=connectionId(owner,providerId);
  const binding=d=>({tenantId:owner.tenantId,actorId:owner.actorId,providerId,connectionId:key,generation:d.generation});
  async function permitted(q,operation,credential){
    assertIsolated();
    if(await authorize(freeze({scope:owner,selection:picked,requestId:q.requestId,operationId,operation,
      credentialRevision:credential.revision,credentialGeneration:credential.generation,offlineOnly:true,externalExport:false}))!==true)
      throw deny('TRANSPORT_FORBIDDEN');
  }
  async function read(includeEnvelope=false){
    const d=await store.get(owner,key,includeEnvelope);
    if(!d||d._id!==key||d.tenantId!==owner.tenantId||d.actorId!==owner.actorId||d.providerId!==providerId||
      d.status!=='STORED_UNVERIFIED'||d.revokedAt||!Number.isSafeInteger(d.revision)||d.revision<1||
      typeof d.generation!=='string'||!/^[a-f0-9-]{36}$/.test(d.generation))throw deny('TRANSPORT_CREDENTIAL_UNAVAILABLE');
    return d;
  }
  return Object.freeze({contractVersion:CONTRACT_VERSION,providerId,modelId,executionMode:'OFFLINE_TEST_ONLY',
    async generate(q,{signal,timeoutMs=3000}={}){
      assertIsolated();
      if(q?.contractVersion!==CONTRACT_VERSION||q.executionMode!=='OFFLINE_TEST_ONLY'||q.providerId!==providerId||
        q.modelId!==modelId||q.descriptorId!==model.descriptorId||q.fundingMode!=='BYO_API'||q.modelRevision!==model.revision)
        throw deny('ADAPTER_BINDING_MISMATCH');
      const base={requestId:q.requestId,providerId,modelId,descriptorId:q.descriptorId};
      const hidden=()=>normalizeOfflineOutcome(q,{...base,status:'UNKNOWN',candidate:null,usage:{status:'UNKNOWN'},errorCode:'UNKNOWN'});
      const at=now();
      if(!Number.isSafeInteger(at)||at<q.createdAtMs||at>=q.expiresAtMs||signal?.aborted)throw deny('TRANSPORT_REQUEST_EXPIRED');
      let secret,lease,outcome;
      try{
        const meta=await read();
        await permitted(q,'CREDENTIAL_READ',meta);
        const row=await read(true);
        if(!same(meta,row))throw deny('TRANSPORT_CREDENTIAL_CHANGED');
        await permitted(q,'DISPATCH',row);
        if(!same(row,await read()))throw deny('TRANSPORT_CREDENTIAL_CHANGED');
        secret=crypto.decrypt(row.envelope,binding(row));
        // Durable one-shot claim before any socket opens. A failed or uncertain
        // claim is never retried by this adapter, including after restart.
        lease=await admission.claim(owner,q,operationId);
        await permitted(q,'DISPATCH',row);
        if(!same(row,await read())||signal?.aborted||now()>=q.expiresAtMs)throw deny('TRANSPORT_CREDENTIAL_CHANGED');
        outcome=await transport.exchange(q,secret,{signal,timeoutMs});
        secret.fill(0);
        // Record only disposition and bounded usage, never candidate or key.
        await admission.finish(owner,q,operationId,lease,outcome);
        await permitted(q,'DISCLOSE',row);
        if(!same(row,await read())||signal?.aborted||now()>=q.expiresAtMs)return hidden();
        return outcome;
      }catch{
        // If no outcome was durably recorded, the claim remains reserved.
        // No automatic retries; even a pre-socket error can consume a slot.
        if(lease&&!outcome)try{await admission.finish(owner,q,operationId,lease,hidden());}catch{}
        return hidden();
      }finally{secret?.fill(0);}
    },
  });
}
module.exports={createIsolatedCredentialAdapter};
