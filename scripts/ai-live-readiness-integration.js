'use strict';
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {scopeFor}=require('../src/modules/ai/ai-read-gateway');
const {assertIsolated}=require('../src/modules/ai/providers/credit-ledger-store');
const {createLiveAdmission}=require('../src/modules/ai/providers/live-admission');
const {LiveAttempt,LiveBudget,LiveEvent}=require('../src/modules/ai/providers/live-admission.model');
async function runLiveReadiness({auth,gateway,token,foreignToken,readRequest,foreignReadRequest}){
  assertIsolated();
  const principal=await auth.authenticateSessionToken(token);
  const other=await auth.authenticateSessionToken(foreignToken);
  const makeScope=(p,r)=>{const {channel,...s}=scopeFor(p,r.accountId,Date.now());return {...s,connectionId:r.connectionId};};
  const s=makeScope(principal,readRequest),b=makeScope(other,foreignReadRequest);
  const admin={tenantId:s.tenantId,actorId:s.actorId},descriptorId='a'.repeat(64),policyVersion='b'.repeat(64),evidenceId='c'.repeat(64);
  let clock=Date.now(),deny=false,denyAdmin=false,denyBilling=false;
  const price={descriptorId,approved:true,inputRatePicoUsd:100,outputRatePicoUsd:200};
  function service(){return createLiveAdmission({
    now:()=>clock,
    authorizeSession:async(input,purpose)=>{
      if(deny&&purpose!=='REVOKE')throw Error('Fixture revoked');
      const credential=input.actorId===s.actorId?token:foreignToken;
      const req=input.actorId===s.actorId?readRequest:foreignReadRequest;
      const p=await auth.authenticateSessionToken(credential);
      await gateway.assertDisclosure(p,req);
      return makeScope(p,req);
    },
    // These are synthetic administrator, entitlement and billing policies.
    // Real production authorization adapters must be reviewed separately.
    authorizeMarket:async (_scope,w)=>w.descriptorId===descriptorId&&w.policyVersion===policyVersion&&w.symbol==='XAUUSD'&&w.timeframe==='1m',
    authorizeAdmin:async a=>!denyAdmin&&a.tenantId===admin.tenantId&&a.actorId===admin.actorId,
    authorizeReconciliation:async a=>!denyBilling&&a.tenantId===admin.tenantId&&a.actorId===admin.actorId,
    resolvePrice:async d=>d===descriptorId?price:null
  });}
  const one=service(),two=service();await one.provision();
  const limits={tenantDailyPicoUsd:1000,actorDailyPicoUsd:600,tenantDailyRequests:4,actorDailyRequests:3};
  const config={descriptorId,policyVersion,symbol:'XAUUSD',timeframe:'1m'};
  const grant=(expectedRevision=0)=>({...config,expectedRevision,explicitConsent:true,expiresAtMs:clock+60000});
  const request=(operationId=randomUUID(),consentRevision=1)=>({...config,operationId,consentRevision,maxInputTokens:2,maxOutputTokens:1});
  const code=(p,c)=>assert.rejects(p,{code:c});
  const first=request();
  await code(one.claim(s,first),'LIVE_AI_PAUSED');
  denyAdmin=true;await code(one.setControl(admin,{...limits,expectedRevision:0,enabled:true}),'LIVE_AI_ADMIN_DENIED');denyAdmin=false;
  assert.deepEqual(await one.setControl(admin,{...limits,expectedRevision:0,enabled:true}),{enabled:true,revision:1});
  await code(one.claim(s,first),'LIVE_AI_CONSENT_REQUIRED');
  await code(one.grant(s,{...grant(),explicitConsent:false}),'LIVE_AI_INVALID');
  await code(one.grant({...s,accountId:b.accountId},grant()),'LIVE_AI_SCOPE_CHANGED');
  await one.grant(s,grant());await one.grant(b,grant());
  await code(one.claim(s,{...first,symbol:'EURUSD'}),'LIVE_AI_CONSENT_REQUIRED');
  const race=await Promise.allSettled([one.claim(s,first),two.claim(s,first)]);
  assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
  const a=race.find(x=>x.status==='fulfilled').value;assert.equal(a.reservedPicoUsd,400);
  assert.equal(await LiveAttempt.countDocuments({tenantId:s.tenantId}),1);
  await code(two.claim(s,request()),'LIVE_AI_BUDGET_LIMIT');
  const otherReq=request(),otherClaim=await two.claim(b,otherReq);
  assert.equal(otherClaim.reservedPicoUsd,400);
  const dispatch=await Promise.allSettled([one.beginDispatch(s,first.operationId),two.beginDispatch(s,first.operationId)]);
  assert.equal(dispatch.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(await one.assertDisclosure(s,first.operationId),true);
  // In-flight revoke stops disclosure; provider-side effects cannot be recalled.
  await two.revoke(s,1);await code(one.assertDisclosure(s,first.operationId),'LIVE_AI_DISCLOSURE_DENIED');
  await code(two.claim(s,request()),'LIVE_AI_CONSENT_REQUIRED');
  denyBilling=true;await code(one.reconcile(admin,{attemptId:a.attemptId,kind:'UNKNOWN',evidenceId}),'LIVE_AI_RECONCILE_DENIED');denyBilling=false;
  await one.reconcile(admin,{attemptId:a.attemptId,kind:'UNKNOWN',evidenceId});
  await code(two.reconcile(admin,{attemptId:a.attemptId,kind:'NOT_SENT',evidenceId}),'LIVE_AI_RECONCILE_DENIED');
  const paused=await two.setControl(admin,{...limits,expectedRevision:1,enabled:false});assert.equal(paused.revision,2);
  await code(one.beginDispatch(b,otherReq.operationId),'LIVE_AI_PAUSED');
  // Billing and abandonment remain possible during pause; no second dispatch.
  await code(one.reconcile(admin,{attemptId:a.attemptId,kind:'SETTLE',evidenceId,inputTokens:999,outputTokens:1}),'LIVE_AI_USAGE_UNVERIFIED');
  const settlement={attemptId:a.attemptId,kind:'SETTLE',evidenceId,inputTokens:1,outputTokens:1};
  assert.deepEqual(await one.reconcile(admin,settlement),{state:'SETTLED',actualPicoUsd:300});
  assert.deepEqual(await two.reconcile(admin,settlement),{state:'SETTLED',actualPicoUsd:300});
  await code(one.reconcile(admin,{...settlement,inputTokens:2}),'LIVE_AI_CHANGED');
  await two.reconcile(admin,{attemptId:otherClaim.attemptId,kind:'NOT_SENT',evidenceId});
  const tenantBudget=await LiveBudget.findOne({tenantId:s.tenantId,actorId:null}).lean();
  assert.equal(tenantBudget.reservedPicoUsd,0);assert.equal(tenantBudget.settledPicoUsd,300);assert.equal(tenantBudget.requests,2);
  await one.setControl(admin,{...limits,expectedRevision:2,enabled:true});
  await code(two.claim(b,request()),'LIVE_AI_CONSENT_REQUIRED');
  await one.grant(b,grant(1));
  await code(two.claim(b,request(otherReq.operationId,2)),'LIVE_AI_ALREADY_CLAIMED');
  const newReq=request(randomUUID(),2),newClaim=await one.claim(b,newReq);
  clock+=60001;await code(two.beginDispatch(b,newReq.operationId),'LIVE_AI_CONSENT_REQUIRED');
  await one.reconcile(admin,{attemptId:newClaim.attemptId,kind:'NOT_SENT',evidenceId});
  deny=true;await assert.rejects(one.claim(b,request(randomUUID(),2)));deny=false;
  const rows=await LiveEvent.find({tenantId:s.tenantId}).lean();
  assert.ok(rows.some(r=>r.kind==='UNKNOWN'));assert.ok(rows.some(r=>r.kind==='CONTROL'));
  assert.ok(rows.every(r=>!Object.hasOwn(r,'prompt')&&!Object.hasOwn(r,'secret')));
  console.log('PASS live readiness real Mongo transactional admission, auth scope, revocable consent, multi-instance duplicate and budget protection, unknown hold, reconciliation, pause and resume fencing');
}
module.exports={runLiveReadiness};
