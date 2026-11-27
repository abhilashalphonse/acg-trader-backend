'use strict';
const {assertIsolated}=require('./providers/credit-ledger-store');
const {createIsolatedCredentialAdapter}=require('./providers/isolated-credential-adapter');
const {createOfflineOrchestrator}=require('./providers/offline-orchestrator');
const {createOfflineBudget}=require('./providers/compute-budget');
const {createResponseEngine}=require('./intelligence/response-engine');
const {selectKnowledge}=require('./intelligence/knowledge-catalog');
const {AppError}=require('../../shared/errors/app-error');
const deny=code=>new AppError('Isolated conversation provider unavailable',{statusCode:409,code});
const policy={maxInputTokens:8192,maxOutputTokens:1024,maxRequestsPerUtcDay:16,maxTokensPerUtcDay:100000,
  maxCostPicoUsdPerRequest:null,maxCostPicoUsdPerUtcDay:null};
// Fixture transport only. The operation ID is assigned durably by the
// conversation service, before any adapter admission or external action.
// All content is server-owned or from the isolated persisted user message.
function createIsolatedConversationProvider({registry,store,crypto,transport,admission}={}){
  assertIsolated();
  const budget=createOfflineBudget({policies:{BYO_API:policy,ACG_CREDITS:policy}});
  return Object.freeze({
    async run({scope,selection,profile,question,operationId,authorize}){
      assertIsolated();
      if(profile!=='EDUCATION'||selection?.fundingMode!=='BYO_API'||typeof authorize!=='function')
        throw deny('AI_CHAT_PROVIDER_DISABLED');
      const d=registry.resolveForOfflineTest(selection);
      if(d.descriptorId!==selection.descriptorId||d.runtimeEnabled!==false||d.reviewStatus!=='SYNTHETIC_TEST_ONLY')
        throw deny('AI_CHAT_MODEL_CHANGED');
      const owner=Object.fromEntries(['tenantId','actorId','sessionId','accountId'].map(k=>[k,scope[k]]));
      const picked={providerId:d.providerId,modelId:d.modelId,fundingMode:'BYO_API'};
      const permitted=async()=>{try{return await authorize()===true;}catch{return false;}};
      const adapter=createIsolatedCredentialAdapter({scope:owner,selection:picked,registry,store,crypto,transport,admission,operationId,
        authorize:permitted});
      const engine=createResponseEngine({authorize:permitted});
      const orchestrator=createOfflineOrchestrator({registry,responseEngine:engine,adapters:[adapter],authorize:permitted,computeBudget:budget});
      const result=await orchestrator.run({scope:owner,idempotencyKey:operationId,selection:picked,profile:'EDUCATION',
        question,context:null,inputTokenUpperBound:8192,maxOutputTokens:1024,timeoutMs:7000,stream:false});
      const receipt=result.receipt;
      if(receipt.status!=='COMPLETED'){
        const unknown=receipt.status==='RECONCILIATION_REQUIRED'||receipt.dispatch==='ATTEMPTED'||receipt.budget?.status==='HELD_FOR_RECONCILIATION';
        return {state:unknown?'HELD_UNKNOWN':'FAILED'};
      }
      const r=result.response,u=receipt.usage;
      const allowed=new Set(selectKnowledge('EDUCATION').entries.map(k=>k.knowledgeId));
      if(!r||r.verification!=='RECOMPUTED_REFERENCE_SELECTION_ONLY'||r.symbol!==null||r.observations.length||r.interpretations.length||
        r.education.length>8||r.education.some(k=>!allowed.has(k.knowledgeId))||
        u.status!=='PROVIDER_REPORTED'||!Number.isSafeInteger(u.inputTokens)||!Number.isSafeInteger(u.outputTokens)||
        receipt.budget?.status!=='ACCOUNTED_OFFLINE'||Date.now()>=r.expiresAtMs||!await permitted())
        throw deny('AI_CHAT_PROVIDER_UNVERIFIED');
      // Persist only independently verified reference IDs and fixture usage,
      // never the candidate or generated prose. Freshness is separate from
      // historical persistence and is checked again by the caller.
      return {state:'VERIFIED',responseStatus:r.status,responseId:r.responseId,
        referenceIds:r.education.map(k=>k.knowledgeId),verifiedAtMs:r.verifiedAtMs,
        responseExpiresAtMs:r.expiresAtMs,inputTokens:u.inputTokens,outputTokens:u.outputTokens};
    }
  });
}
module.exports={createIsolatedConversationProvider};
