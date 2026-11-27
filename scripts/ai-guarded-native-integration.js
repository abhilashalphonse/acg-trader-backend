'use strict';
const assert=require('node:assert/strict');
const {createLiveAdmission}=require('../src/modules/ai/providers/live-admission');
const {createLiveSessionAuthority}=require('../src/modules/ai/providers/live-runtime-config');
const {createGuardedFixtureMarket}=require('../src/modules/ai/providers/guarded-fixture-market');
const {assertIsolated}=require('../src/modules/ai/providers/credit-ledger-store');
const {LiveControl,LiveConsent,LiveAttempt,LivePlatform}=require('../src/modules/ai/providers/live-admission.model');

// Test fixture only. All data, rates and authorizations belong to disposable CI.
async function runGuardedNative({auth,gateway,gs,token,scope,readRequest,selection,workspace,
  useGuard,create,append,generate,requests,setHook,setMode}){
  assertIsolated();
  const owner={...scope,connectionId:readRequest.connectionId};
  const {tenantId,actorId,sessionId,accountId}=owner;
  const actor={tenantId,actorId};
  const policyVersion='d'.repeat(64);
  const config={descriptorId:selection.descriptorId,policyVersion,symbol:workspace.symbol,timeframe:workspace.timeframe};
  const price={descriptorId:selection.descriptorId,policyVersion,approved:true,inputRatePicoUsd:100,outputRatePicoUsd:200,
    maxInputTokens:8192,maxOutputTokens:1024};
  let entitled=true;
  const authz=createLiveSessionAuthority({authService:auth,gateway,governanceStore:gs,sessionToken:()=>token,
    marketEntitlement:async (s,w)=>entitled&&s.actorId===actorId&&Object.keys(config).every(k=>config[k]===w[k])});
  const ledger=()=>createLiveAdmission({...authz,
    authorizePlatformAdmin:async a=>a.tenantId===tenantId&&a.actorId===actorId,
    authorizeAdmin:async a=>a.tenantId===tenantId&&a.actorId===actorId,
    authorizeReconciliation:async a=>a.tenantId===tenantId&&a.actorId===actorId,
    resolvePrice:async id=>id===price.descriptorId?price:null});
  const service=ledger();
  const control=await LiveControl.findById(tenantId).lean();
  const platform=await LivePlatform.findById('platform').lean();
  await service.setPlatformControl(actor,{expectedRevision:platform.revision,enabled:true,dailyPicoUsd:20000000,dailyRequests:100,maxOutstandingPicoUsd:10000000,maxOutstandingRequests:10});
  const limits={tenantDailyPicoUsd:10000000,actorDailyPicoUsd:8000000,tenantDailyRequests:16,actorDailyRequests:12};
  let revision=(await service.setControl(actor,{...limits,enabled:true,expectedRevision:control.revision})).revision;
  const makeGuard=()=>createGuardedFixtureMarket({admission:ledger(),policyVersion,
    reconcileFixture:input=>service.reconcile(actor,input)});
  useGuard(makeGuard());await create();
  const start=requests(),first=await append();
  assert.equal((await generate(first)).status,403);
  assert.equal(requests(),start);
  async function grant(){
    const prev=await LiveConsent.findOne({tenantId,actorId,accountId,sessionId}).lean();
    return service.grant(owner,{...config,expectedRevision:prev?.revision??0,explicitConsent:true,expiresAtMs:Date.now()+120000});
  }
  const consent=await grant();
  const verified=await generate(first);
  assert.equal(verified.status,200);assert.equal(verified.body.providerRun.state,'VERIFIED');assert.ok(verified.body.verifiedMarket);
  const rowFor=body=>LiveAttempt.findOne({tenantId,actorId,operationId:body.providerRun.operationId}).lean();
  const row=await rowFor(verified.body);
  assert.equal(row.state,'SETTLED');assert.equal(row.actualPicoUsd,14000);assert.equal(row.consentRevision,consent.revision);
  useGuard(makeGuard());
  const duplicate=await generate(first);
  assert.equal(duplicate.status,200);assert.equal(duplicate.body.replayed,true);assert.ok(!duplicate.body.verifiedMarket);
  assert.equal(requests(),start+1);
  const second=await append();
  setHook(async()=>{await service.revoke(owner,consent.revision);});
  const revoked=await generate(second);setHook(null);
  assert.equal(revoked.status,200);assert.ok(!revoked.body.verifiedMarket);assert.notEqual(revoked.body.providerRun.state,'VERIFIED');
  assert.equal((await rowFor(revoked.body)).state,'SETTLED');
  const third=await append();
  assert.equal((await generate(third)).status,403);assert.equal(requests(),start+2);
  await grant();entitled=false;assert.equal((await generate(third)).status,403);entitled=true;
  setMode('redirect');const held=await generate(third);setMode('normal');
  assert.equal(held.status,200);assert.ok(!held.body.verifiedMarket);
  assert.equal((await rowFor(held.body)).state,'HELD_UNKNOWN');
  const fourth=await append();
  setHook(async()=>{revision=(await service.setControl(actor,{...limits,enabled:false,expectedRevision:revision})).revision;});
  const paused=await generate(fourth);setHook(null);
  assert.equal(paused.status,200);assert.ok(!paused.body.verifiedMarket);
  const fifth=await append();assert.equal((await generate(fifth)).status,403);
  revision=(await service.setControl(actor,{...limits,enabled:true,expectedRevision:revision})).revision;
  assert.equal((await generate(fifth)).status,403);assert.equal(requests(),start+4);
  // A fresh consent cannot override an exhausted durable spending limit.
  const low={...limits,tenantDailyPicoUsd:500000,actorDailyPicoUsd:500000};
  revision=(await service.setControl(actor,{...low,enabled:true,expectedRevision:revision})).revision;
  await grant();
  const denied=await generate(fifth);
  assert.equal(denied.status,200);assert.ok(!denied.body.verifiedMarket);
  assert.equal(await rowFor(denied.body),null);
  assert.equal(requests(),start+4);
  await service.setControl(actor,{...low,enabled:false,expectedRevision:revision});
  console.log('PASS guarded native runtime: consent, settled usage, replay, revocation, unknown hold, pause/resume and budget denial against real TLS fixture');
}
module.exports={runGuardedNative};
