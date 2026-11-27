'use strict';
const {createHash}=require('node:crypto');
const {LiveAttempt}=require('./live-admission.model');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=v=>typeof v==='string'&&/^[a-f0-9]{24}$/.test(v);
const count=v=>Number.isSafeInteger(v)&&v>=0;
const fail=()=>Object.assign(Error('Provider usage evidence unavailable'),{code:'LIVE_AI_BILLING_EVIDENCE_DENIED'});
// Server-only usage recorder. This binds a provider-reported receipt to an
// attempt, but does not prove the charge on the organization invoice.
// authenticateEvidence must verify provenance from the trusted transport or
// authenticated billing import, never from an HTTP request body.
function createProviderUsageRecorder({admission,actor,authenticateEvidence}={}){
  if(typeof admission?.reconcile!=='function'||!id(actor?.tenantId)||!id(actor?.actorId)||typeof authenticateEvidence!=='function')throw fail();
  return async input=>{
    if(!hex(input?.attemptId)||!hex(input.descriptorId)||!['SETTLE','UNKNOWN'].includes(input.kind))throw fail();
    const row=await LiveAttempt.findOne({_id:input.attemptId,tenantId:actor.tenantId,descriptorId:input.descriptorId})
      .read('primary').readConcern('majority').maxTimeMS(2000).lean();
    if(!row)throw fail();
    const known=input.kind==='SETTLE';
    if(known&&(!/^[A-Za-z0-9_-]{1,160}$/.test(input.providerResponseId??'')||!count(input.inputTokens)||!count(input.outputTokens)))throw fail();
    const data={attemptId:input.attemptId,descriptorId:input.descriptorId,kind:input.kind,
      ...(known?{providerResponseHash:hash(['openai',input.providerResponseId]),inputTokens:input.inputTokens,outputTokens:input.outputTokens}:{})};
    if(await authenticateEvidence(Object.freeze({...data}),input)!==true)throw fail();
    const {descriptorId,...settlement}=data;
    return admission.reconcile(actor,{...settlement,evidenceId:hash(['provider-usage-v1',data])});
  };
}
// Review an independently authenticated provider usage/cost export for an
// EXACT project/model/UTC bucket. Never silently allocate an aggregate to a
// request, treat rounded dashboard dollars as an invoice, or alter the ledger.
function compareBillingBucket({local,provider}={}){
  for(const x of [local,provider]){
    if(!x||typeof x.projectId!=='string'||!x.projectId||typeof x.model!=='string'||!x.model||
      !count(x.startMs)||!count(x.endMs)||x.endMs<=x.startMs||!count(x.requests)||!count(x.inputTokens)||!count(x.outputTokens))throw fail();
  }
  if(!['projectId','model','startMs','endMs'].every(k=>local[k]===provider[k])||provider.authenticated!==true||
    provider.complete!==true||!count(provider.costPicoUsd)||!count(local.estimatedCostPicoUsd))return {state:'EVIDENCE_INCOMPLETE'};
  const differences={requests:provider.requests-local.requests,inputTokens:provider.inputTokens-local.inputTokens,
    outputTokens:provider.outputTokens-local.outputTokens,costPicoUsd:provider.costPicoUsd-local.estimatedCostPicoUsd};
  const matches=Object.values(differences).every(v=>v===0);
  return {state:matches?'MATCHED_BUCKET':'REVIEW_REQUIRED',differences,providerCostPicoUsd:provider.costPicoUsd,
    requestAttributionVerified:false,ledgerChanged:false};
}
module.exports={createProviderUsageRecorder,compareBillingBucket};
