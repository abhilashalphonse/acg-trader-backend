'use strict';
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createIsolatedCreditStore,assertIsolated}=require('../src/modules/ai/providers/credit-ledger-store');
const {createIsolatedCreditLedger}=require('../src/modules/ai/providers/credit-ledger');
const {AiCreditWallet,AiCreditReservation,AiCreditJournal}=require('../src/modules/ai/providers/credit-ledger.model');
const {createModelRegistry}=require('../src/modules/ai/providers/model-registry');
const {createOfflineRequest,normalizeOfflineOutcome,CONTRACT_VERSION}=require('../src/modules/ai/providers/provider-contract');
const {createOfflineOrchestrator}=require('../src/modules/ai/providers/offline-orchestrator');
const {createResponseEngine}=require('../src/modules/ai/intelligence/response-engine');
const {createPricingRegistry}=require('../src/modules/ai/providers/compute-pricing');
const {compilePromptPackage}=require('../src/modules/ai/intelligence/prompt-compiler');
async function runPhase3CreditIntegration({auth,token,foreignToken,accountId,foreignAccountId}){
  assertIsolated();
  const store=createIsolatedCreditStore();await store.provision();
  for(const [model,keys] of [[AiCreditWallet,{tenantId:1,actorId:1}],
    [AiCreditReservation,{tenantId:1,actorId:1,idempotencyKey:1}],
    [AiCreditJournal,{walletId:1,revision:1}]]){
    assert.ok((await model.collection.indexes()).some(i=>i.unique&&JSON.stringify(i.key)===JSON.stringify(keys)));
  }
  async function scopeOf(t,a){const p=await auth.authenticateSessionToken(t);assert.equal(p.authMethod,'SUPABASE');
    return {tenantId:p.tenantId,actorId:p.userId,sessionId:p.sessionId,accountId:String(a)};}
  const s=await scopeOf(token,accountId),foreign=await scopeOf(foreignToken,foreignAccountId);
  let active=token,activeAccount=accountId;
  const authorize=async req=>{try{const p=await scopeOf(active,activeAccount);return Object.keys(p).every(k=>p[k]===req.scope[k]);}catch{return false;}};
  let now=Date.UTC(2026,0,1);
  const ledger=()=>createIsolatedCreditLedger({store,authorize,now:()=>now});
  const l=ledger();
  const selection={providerId:'openai',modelId:'synthetic-ledger-v1',fundingMode:'ACG_CREDITS'};
  const registry=createModelRegistry({allowSynthetic:true,descriptors:[{...selection, fundingMode:undefined,
    revision:'fixture-1',reviewStatus:'SYNTHETIC_TEST_ONLY',fundingModes:['ACG_CREDITS','BYO_API'],
    capabilities:{input:'TEXT',responseMode:'JSON_OBJECT',separateInstructionChannel:true,streaming:false,
      usageReporting:'PROVIDER_REPORTED',maxContextTokens:8192,maxOutputTokens:2048}}].map(({fundingMode,...v})=>v)});
  const model=registry.resolveForOfflineTest(selection);
  const pricing=createPricingRegistry({allowSynthetic:true,prices:[{providerId:model.providerId,modelId:model.modelId,
    descriptorId:model.descriptorId,revision:'fixture-price',effectiveFromMs:now-1,effectiveUntilMs:null,currency:'USD',
    rateUnit:'MICRO_USD_PER_MILLION_TOKENS',reviewStatus:'SYNTHETIC_TEST_ONLY',source:'OFFLINE_FIXTURE',additionalFees:'NONE_SYNTHETIC',
    input:{standard:'1000000',cacheRead:null,cacheWriteMode:'NONE',cacheWrite:null,cacheWrite5m:null,cacheWrite1h:null},
    output:{standard:'2000000',reasoning:null}}]});
  const request=(fundingMode='ACG_CREDITS')=>{
    const q=createOfflineRequest({registry,selection:{...selection,fundingMode},
      prompt:compilePromptPackage({scope:s,profile:'EDUCATION',question:'Synthetic ledger fixture',nowMs:now}),
      inputTokenUpperBound:100,maxOutputTokens:50,nowMs:now});
    return {q,price:pricing.pin(q,now),key:randomUUID()};
  };
  const usage={status:'PROVIDER_REPORTED',inputTokens:20,outputTokens:10,totalTokens:30,cachedInputTokens:null,reasoningOutputTokens:null};
  const check=async(available,reserved,spent,credited='500000000')=>{
    const w=await l.balance(s);assert.deepEqual([w.available,w.reserved,w.spent,w.credited],[available,reserved,spent,credited]);
  };
  const ref=randomUUID();
  await l.fixtureCredit(s,ref,'500000000');await l.fixtureCredit(s,ref,'500000000');
  await assert.rejects(l.fixtureCredit(s,ref,'600000000'),{code:'CREDIT_CONFLICT'});
  await check('500000000','0','0');
  const a=request(),b=request(),c=request();
  assert.equal(a.price.upperBoundPicoUsd,'200000000');
  await l.reserve(s,a.key,a.q,a.price);
  await l.reserve(s,a.key,a.q,a.price);
  const race=await Promise.allSettled([l.reserve(s,b.key,b.q,b.price),l.reserve(s,c.key,c.q,c.price)]);
  assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(race.find(x=>x.status==='rejected').reason.code,'CREDIT_INSUFFICIENT');
  const held=race[0].status==='fulfilled'?b:c;
  await check('100000000','400000000','0');
  const claim=await Promise.all([l.claimDispatch(s,a.key),ledger().claimDispatch(s,a.key)]);
  assert.equal(claim.filter(x=>x.dispatchAllowed).length,1);
  const attemptId=claim.find(x=>x.dispatchAllowed).attemptId;
  assert.equal((await ledger().claimDispatch(s,a.key)).dispatchAllowed,false);
  await assert.rejects(l.releaseBeforeDispatch(s,a.key),{code:'CREDIT_STATE_INVALID'});
  const final={attemptId,requestId:a.q.requestId,status:'COMPLETED',usage};
  const settled=await Promise.all([l.recordOutcome(s,a.key,final),ledger().recordOutcome(s,a.key,final)]);
  assert.ok(settled.every(x=>x.status==='SETTLED'&&x.charged==='40000000'));
  await check('260000000','200000000','40000000');
  await assert.rejects(l.recordOutcome(s,a.key,{...final,usage:{...usage,inputTokens:21,totalTokens:31}}),{code:'CREDIT_CONFLICT'});
  await assert.rejects(l.recordOutcome(s,a.key,{...final,attemptId:randomUUID()}),{code:'CREDIT_ATTEMPT_MISMATCH'});
  await l.releaseBeforeDispatch(s,held.key);await l.releaseBeforeDispatch(s,held.key);
  await check('460000000','0','40000000');
  const ambiguous=request(),undispatched=request();
  await l.reserve(s,ambiguous.key,ambiguous.q,ambiguous.price);
  await l.reserve(s,undispatched.key,undispatched.q,undispatched.price);
  const dispatched=await l.claimDispatch(s,ambiguous.key);
  now+=10000;
  const recovered=ledger(); // same DB, new service instance
  assert.equal((await recovered.recoverExpired(s,ambiguous.key)).status,'RECONCILIATION_REQUIRED');
  assert.equal((await recovered.recoverExpired(s,undispatched.key)).status,'RELEASED');
  await check('260000000','200000000','40000000');
  assert.equal((await recovered.claimDispatch(s,ambiguous.key)).dispatchAllowed,false);
  const unknown={attemptId:dispatched.attemptId,requestId:ambiguous.q.requestId,status:'UNKNOWN',usage};
  assert.equal((await recovered.recordOutcome(s,ambiguous.key,unknown)).status,'RECONCILIATION_REQUIRED');
  assert.equal((await recovered.recordOutcome(s,ambiguous.key,{...unknown,status:'COMPLETED',usage:{...usage,inputTokens:101,totalTokens:111}})).status,'RECONCILIATION_REQUIRED');
  await check('260000000','200000000','40000000');
  assert.equal((await recovered.recordOutcome(s,ambiguous.key,{...unknown,status:'COMPLETED',usage})).status,'SETTLED');
  await check('420000000','0','80000000');
  const byo=request('BYO_API');
  await assert.rejects(l.reserve(s,byo.key,byo.q,byo.price),{code:'CREDIT_REQUEST_INVALID'});
  active=foreignToken;activeAccount=foreignAccountId;
  await assert.rejects(l.status(s,a.key),{code:'CREDIT_FORBIDDEN'});
  await assert.rejects(l.status(foreign,a.key),{code:'CREDIT_RESERVATION_UNAVAILABLE'});
  assert.equal((await l.balance(foreign)).credited,'0');
  active=token;activeAccount=accountId;
  // Force journal insert failure AFTER wallet CAS: transaction must roll back.
  const wallet=await AiCreditWallet.findOne({tenantId:s.tenantId,actorId:s.actorId}).lean();
  const event=await AiCreditJournal.findOne({walletId:wallet._id}).lean();
  await assert.rejects(store.transaction(async t=>{
    await t.updateWallet(s,wallet,{...wallet,revision:wallet.revision+1});
    await t.append(event);
  }),{code:'CREDIT_CONFLICT'});
  assert.equal((await l.balance(s)).revision,wallet.revision);
  const journal=await AiCreditJournal.find({walletId:wallet._id}).sort({revision:1}).lean();
  assert.deepEqual(journal.map(e=>e.revision),Array.from({length:wallet.revision},(_,i)=>i+1));
  assert.equal(journal.filter(e=>e.operation==='FIXTURE_CREDIT').length,1);
  assert.equal(journal.filter(e=>e.operation==='SETTLE').length,2);
  assert.ok(journal.every(e=>BigInt(e.available)+BigInt(e.reserved)+BigInt(e.spent)===BigInt(e.credited)));
  assert.ok(!(JSON.stringify(await AiCreditReservation.find({tenantId:s.tenantId,actorId:s.actorId}).lean()).includes('Synthetic ledger fixture')));
  await assert.rejects(AiCreditJournal.updateOne({_id:event._id},{$set:{amount:'0'}}),/append-only/);
  let dispatches=0;
  const orchestrator=()=>createOfflineOrchestrator({registry,pricingRegistry:pricing,creditLedger:ledger(),
    responseEngine:createResponseEngine({authorize,now:()=>now}),authorize,now:()=>now,
    adapters:[{providerId:selection.providerId,modelId:selection.modelId,contractVersion:CONTRACT_VERSION,
      executionMode:'OFFLINE_TEST_ONLY',async generate(q){
        dispatches++;
        return normalizeOfflineOutcome(q,{requestId:q.requestId,providerId:q.providerId,modelId:q.modelId,
          descriptorId:q.descriptorId,status:'COMPLETED',
          candidate:JSON.stringify({schemaVersion:'candidate-response-v2',status:'UNSUPPORTED',observations:[],interpretations:[],education:[]}),
          usage:{status:'PROVIDER_REPORTED',inputTokens:20,outputTokens:10,cachedInputTokens:null,reasoningOutputTokens:null},errorCode:'NONE'});
      }}]});
  const input={scope:s,idempotencyKey:randomUUID(),selection,profile:'EDUCATION',question:'Synthetic orchestration fixture',
    inputTokenUpperBound:100,maxOutputTokens:50,timeoutMs:10000};
  const result=await orchestrator().run(input);
  assert.equal(result.receipt.status,'COMPLETED');
  assert.equal(result.receipt.creditReservation.status,'SETTLED');
  assert.equal(result.receipt.creditReservation.charged,'40000000');
  assert.equal(dispatches,1);
  await check('380000000','0','120000000');
  const replay=await orchestrator().run(input);
  assert.equal(replay.receipt.status,'RECONCILIATION_REQUIRED');
  assert.equal(replay.receipt.dispatch,'NOT_DISPATCHED');assert.equal(dispatches,1);
  await check('380000000','0','120000000');
  const byoResult=await orchestrator().run({...input,idempotencyKey:randomUUID(),selection:{...selection,fundingMode:'BYO_API'}});
  assert.equal(byoResult.receipt.status,'COMPLETED');assert.equal(byoResult.receipt.creditReservation,null);
  await check('380000000','0','120000000');
  console.log('PASS Phase 3 credit orchestration durable pre-dispatch reservation, settlement, restart replay denial and BYO bypass');
  console.log('PASS Phase 3 credit ledger Mongo transactions, concurrent balance admission, one-shot dispatch, single settlement, recovery holds, journal rollback and isolation');
}
module.exports={runPhase3CreditIntegration};
