'use strict';
const {assertIsolated}=require('./providers/credit-ledger-store');
const {createIsolatedCredentialAdapter}=require('./providers/isolated-credential-adapter');
const {createOfflineOrchestrator}=require('./providers/offline-orchestrator');
const {createOfflineBudget}=require('./providers/compute-budget');
const {createResponseEngine}=require('./intelligence/response-engine');
const {selectKnowledge}=require('./intelligence/knowledge-catalog');
const {createTrustedContextAssembler}=require('./intelligence/trusted-context');
const {isDeepStrictEqual}=require('node:util');
const {AppError}=require('../../shared/errors/app-error');
const deny=code=>new AppError('Isolated conversation provider unavailable',{statusCode:409,code});
const policy={maxInputTokens:8192,maxOutputTokens:1024,maxRequestsPerUtcDay:16,maxTokensPerUtcDay:100000,
  maxCostPicoUsdPerRequest:null,maxCostPicoUsdPerUtcDay:null};
// Fixture transport only. The operation ID is assigned durably by the
// conversation service, before any adapter admission or external action.
// All content is server-owned or from the isolated persisted user message.
function createIsolatedConversationProvider({registry,store,crypto,transport,admission,marketSource=null}={}){
  assertIsolated();
  const budget=createOfflineBudget({policies:{BYO_API:policy,ACG_CREDITS:policy}});
  return Object.freeze({
    async run({scope,selection,profile,workspace=null,question,operationId,authorize}){
      assertIsolated();
      const market=profile==='STRUCTURE'||profile==='MARKET_OVERVIEW';
      if((!market&&profile!=='EDUCATION')||selection?.fundingMode!=='BYO_API'||typeof authorize!=='function'||
        (market?(!marketSource||workspace?.includeChartContext!==true):workspace!==null))
        throw deny('AI_CHAT_PROVIDER_DISABLED');
      const d=registry.resolveForOfflineTest(selection);
      if(d.descriptorId!==selection.descriptorId||d.runtimeEnabled!==false||d.reviewStatus!=='SYNTHETIC_TEST_ONLY')
        throw deny('AI_CHAT_MODEL_CHANGED');
      const owner=Object.fromEntries(['tenantId','actorId','sessionId','accountId'].map(k=>[k,scope[k]]));
      const picked={providerId:d.providerId,modelId:d.modelId,fundingMode:'BYO_API'};
      const permitted=async()=>{try{return await authorize()===true;}catch{return false;}};
      // Only the server's read-only market source can mint a context. No client
      // candles, quote, account data, serialized evidence or provider URL.
      let context=null,request=null;
      if(market){
        request={scope:owner,symbol:workspace.symbol,timeframes:[workspace.timeframe],limit:64,sessionWindows:[]};
        const assembler=createTrustedContextAssembler({source:{instrument:s=>marketSource.instrument(s),
          candles:r=>marketSource.candles(r),quote:()=>null},authorize:async r=>isDeepStrictEqual(r,request)&&await permitted()});
        try{context=await assembler.assemble(request);}catch{return {state:'FAILED'};}
      }
      const adapter=createIsolatedCredentialAdapter({scope:owner,selection:picked,registry,store,crypto,transport,admission,operationId,
        authorize:permitted});
      const engine=createResponseEngine({authorize:async r=>r.profile===profile&&isDeepStrictEqual(r.marketRequest,request)&&await permitted()});
      const orchestrator=createOfflineOrchestrator({registry,responseEngine:engine,adapters:[adapter],authorize:permitted,computeBudget:budget});
      const result=await orchestrator.run({scope:owner,idempotencyKey:operationId,selection:picked,profile,
        question,context,inputTokenUpperBound:8192,maxOutputTokens:1024,timeoutMs:7000,stream:false});
      const receipt=result.receipt;
      if(receipt.status!=='COMPLETED'){
        const unknown=receipt.status==='RECONCILIATION_REQUIRED'||receipt.dispatch==='ATTEMPTED'||receipt.budget?.status==='HELD_FOR_RECONCILIATION';
        return {state:unknown?'HELD_UNKNOWN':'FAILED'};
      }
      const r=result.response,u=receipt.usage;
      const allowed=new Set(selectKnowledge(profile).entries.map(k=>k.knowledgeId));
      if(!r||r.verification!=='RECOMPUTED_REFERENCE_SELECTION_ONLY'||(market?(r.symbol!==workspace.symbol||r.contextId!==context.contextId||r.quoteStatus!=='UNAVAILABLE'||r.asOfMs!==context.asOfMs):
          (r.symbol!==null||r.observations.length||r.interpretations.length))||
        r.education.length>8||r.education.some(k=>!allowed.has(k.knowledgeId))||
        u.status!=='PROVIDER_REPORTED'||!Number.isSafeInteger(u.inputTokens)||!Number.isSafeInteger(u.outputTokens)||
        receipt.budget?.status!=='ACCOUNTED_OFFLINE'||Date.now()>=r.expiresAtMs||!await permitted())
        throw deny('AI_CHAT_PROVIDER_UNVERIFIED');
      // Persist only independently verified reference IDs and fixture usage,
      // never the candidate or generated prose. Freshness is separate from
      // historical persistence and is checked again by the caller.
      return {state:'VERIFIED',responseStatus:r.status,responseId:r.responseId,
        referenceIds:market?[]:r.education.map(k=>k.knowledgeId),
        ...(market?{marketResponse:{source:{provider:context.instrument.provider,scheduleVersion:context.instrument.scheduleVersion},response:r}}:{}),verifiedAtMs:r.verifiedAtMs,
        responseExpiresAtMs:r.expiresAtMs,inputTokens:u.inputTokens,outputTokens:u.outputTokens};
    }
  });
}
module.exports={createIsolatedConversationProvider};
