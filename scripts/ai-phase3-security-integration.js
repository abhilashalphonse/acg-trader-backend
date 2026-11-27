'use strict';
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createIsolatedIntelligenceSession}=require('../src/modules/ai/providers/intelligence-session');
const {createOfflineBudget}=require('../src/modules/ai/providers/compute-budget');
const {createOfflineEducationCache}=require('../src/modules/ai/providers/education-cache');
const {createModelRegistry}=require('../src/modules/ai/providers/model-registry');
const {normalizeOfflineOutcome,CONTRACT_VERSION}=require('../src/modules/ai/providers/provider-contract');
const {createAiQuota}=require('../src/modules/ai/ai-quota');
const {createAiQuotaStore}=require('../src/modules/ai/ai-quota-store');
const {createAiGovernance}=require('../src/modules/ai/ai-governance');
const {AiAuditEvent}=require('../src/modules/ai/ai-governance.model');
const {assertIsolated}=require('../src/modules/ai/providers/credit-ledger-store');

async function runPhase3SecurityIntegration({auth,gateway,gs,token,foreignToken,readRequest,source,scope,asOf}){
  assertIsolated();
  let clock=asOf,activeToken=token,purposeAllowed=true,discloseAllowed=true,adapterAction=null,quoteReads=0,calls=0;
  const selection={providerId:'openai',modelId:'fixture-security-v1',fundingMode:'BYO_API'};
  const registry=createModelRegistry({allowSynthetic:true,descriptors:[{
    providerId:selection.providerId,modelId:selection.modelId,revision:'fixture-1',reviewStatus:'SYNTHETIC_TEST_ONLY',
    fundingModes:['BYO_API'],capabilities:{input:'TEXT',responseMode:'JSON_OBJECT',separateInstructionChannel:true,
      streaming:false,usageReporting:'PROVIDER_REPORTED',maxContextTokens:100000,maxOutputTokens:2048}}]});
  const policy={maxInputTokens:60000,maxOutputTokens:1024,maxRequestsPerUtcDay:40,maxTokensPerUtcDay:2000000,
    maxCostPicoUsdPerRequest:null,maxCostPicoUsdPerUtcDay:null};
  const budget=createOfflineBudget({policies:{BYO_API:policy,ACG_CREDITS:policy},now:()=>clock});
  const cache=createOfflineEducationCache({now:()=>clock});
  const adapters=[{providerId:selection.providerId,modelId:selection.modelId,executionMode:'OFFLINE_TEST_ONLY',
    contractVersion:CONTRACT_VERSION,async generate(q){
      calls++;
      const d=q.request.data,e=d.evidence;
      const candidate=e?{schemaVersion:'candidate-response-v2',status:'ANSWER',
        observations:[{referenceId:e.references.find(r=>r.type==='FACT').referenceId}],interpretations:[],education:[]}:
        {schemaVersion:'candidate-response-v2',status:'ANSWER',observations:[],interpretations:[],
          education:[{knowledgeId:d.knowledge.entries.find(k=>k.id==='MARKET_STRUCTURE').knowledgeId}]};
      assert.ok(!JSON.stringify(q.request).includes(scope.accountId));
      assert.equal(q.request.tools.length,0);
      if(adapterAction)await adapterAction(q);
      return normalizeOfflineOutcome(q,{requestId:q.requestId,providerId:q.providerId,modelId:q.modelId,
        descriptorId:q.descriptorId,status:'COMPLETED',candidate:JSON.stringify(candidate),
        usage:{status:'PROVIDER_REPORTED',inputTokens:100,outputTokens:20,cachedInputTokens:null,reasoningOutputTokens:null},errorCode:'NONE'});
    }}];
  const quotaNow=Date.now();
  const base={auth,gateway,governance:createAiGovernance({store:gs}),governanceStore:gs,
    quota:createAiQuota({store:createAiQuotaStore(),now:()=>quotaNow}),
    currentToken:()=>activeToken,accountId:readRequest.accountId,connectionId:readRequest.connectionId,
    selection,registry,adapters,computeBudget:budget,educationCache:cache,policyEpoch:'fixture-policy-v1',now:()=>clock,
    authorizePurpose:async req=>{
      assert.equal(req.offlineOnly,true);assert.equal(req.externalExport,false);
      assert.deepEqual(req.scope,scope);
      return purposeAllowed&&(req.operation!=='DISCLOSE'||discloseAllowed);
    }};
  const market={symbol:'XAUUSD',timeframes:['1m','5m'],limit:20,sessionWindows:[],evidenceMode:'HISTORICAL_ONLY'};
  const marketOptions={...base,profile:'MARKET_OVERVIEW',market,source:{
    instrument:s=>source.instrument(s),candles:r=>source.candles(r),
    quote:s=>{quoteReads++;return source.quote(s);}
  }};
  const make=()=>createIsolatedIntelligenceSession(marketOptions);
  const session=await make();
  const input=(question='Describe observed market.')=>({idempotencyKey:randomUUID(),question,
    inputTokenUpperBound:50000,maxOutputTokens:1024,timeoutMs:10000});
  const result=await session.run(input());
  assert.equal(result.receipt.status,'COMPLETED');assert.equal(result.response.symbol,'XAUUSD');
  assert.equal(result.response.quoteStatus,'UNAVAILABLE');assert.equal(quoteReads,0);
  assert.equal(result.response.observations[0].data.kind,'LAST_CLOSED_PRICE');
  assert.equal(result.response.observations[0].data.value,'119');
  assert.equal(result.receipt.budget.status,'ACCOUNTED_OFFLINE');
  const before=calls;
  await assert.rejects(session.run({...input(),context:{forged:true}}),{code:'AI_INTEGRATION_INVALID'});
  await assert.rejects(session.run(input('api_key=fixture_secret_not_real')),{code:'AI_QUESTION_RESTRICTED'});
  purposeAllowed=false;
  await assert.rejects(session.run(input()),{code:'AI_INTEGRATION_FORBIDDEN'});
  purposeAllowed=true;activeToken=foreignToken;
  await assert.rejects(session.run(input()));
  activeToken=token;
  assert.equal(calls,before);
  // Revoke purpose during attempted inference; no response survives final
  // authorization. Budget retains actual reported usage where definitive.
  adapterAction=()=>{purposeAllowed=false;};
  await assert.rejects(session.run(input()),{code:'AI_INTEGRATION_FORBIDDEN'});
  purposeAllowed=true;adapterAction=null;
  // Fresh historical mode never fetches a quote. Recent mode explicitly does.
  const recent=await createIsolatedIntelligenceSession({...marketOptions,market:{...market,evidenceMode:'RECENT_QUOTE_AND_HISTORY'}});
  const rr=await recent.run(input());assert.equal(rr.receipt.status,'COMPLETED');
  assert.equal(rr.response.quoteStatus,'RECENT_PROVIDER_EVENT');assert.equal(quoteReads,1);
  // Expire evidence during inference, never extend original context TTL.
  adapterAction=()=>{clock=asOf+10000;};
  const expired=await session.run(input());
  assert.equal(expired.response,null);assert.equal(expired.receipt.errorCode,'TIMEOUT');
  clock=asOf+10001;adapterAction=null;
  // Cache is scoped and reverified through the real identity/grant boundary.
  const edu=await createIsolatedIntelligenceSession({...base,profile:'EDUCATION'});
  const e1=await edu.run(input('Explain BOS.'));
  assert.equal(e1.receipt.status,'COMPLETED');assert.equal(e1.receipt.cache,'MISS');
  const c=calls;
  const e2=await edu.run(input('Explain BOS.'));
  assert.equal(e2.receipt.cache,'HIT_REVERIFIED');assert.equal(calls,c);
  discloseAllowed=false;
  await assert.rejects(edu.run(input('Explain BOS.')),{code:'AI_INTEGRATION_FORBIDDEN'});
  discloseAllowed=true;assert.equal(calls,c);
  const restricted=await createIsolatedIntelligenceSession({...base,profile:'EDUCATION',
    quota:createAiQuota({store:createAiQuotaStore(),limit:1,now:()=>quotaNow})});
  await assert.rejects(restricted.run(input('Explain BOS.')),{code:'AI_QUOTA_EXCEEDED'});
  assert.equal(calls,c);
  const events=await AiAuditEvent.find({tenantId:scope.tenantId,operation:'AI_GENERATE_OFFLINE'}).lean();
  assert.ok(events.some(e=>e.stage==='ATTEMPT'));
  assert.ok(events.some(e=>e.stage==='ALLOWED'));
  assert.ok(events.some(e=>e.stage==='DENIED'&&e.reason==='AI_QUESTION_RESTRICTED'));
  assert.ok(events.some(e=>e.stage==='SUPPRESSED'));
  assert.ok(events.every(e=>!Object.hasOwn(e,'question')&&!Object.hasOwn(e,'prompt')&&!Object.hasOwn(e,'result')));
  console.log('PASS Phase 3 intelligence composition real identity/grants, governance audit, separate purpose, historical quote exclusion, expiry and reverified cache');
  return {
    async assertPaused(){await assert.rejects(session.run(input()),{code:'AI_GOVERNANCE_PAUSED'});},
    async assertRevoked(){await assert.rejects(make(),{code:'AI_INTEGRATION_FORBIDDEN'});},
  };
}
module.exports={runPhase3SecurityIntegration};
