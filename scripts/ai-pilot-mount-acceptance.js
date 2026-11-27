'use strict';
const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {createApp}=require('../src/app');
const {scopeFor}=require('../src/modules/ai/ai-read-gateway');
const {assertIsolated}=require('../src/modules/ai/providers/credit-ledger-store');
const {createLiveAdmission}=require('../src/modules/ai/providers/live-admission');
const {LivePlatform,LiveControl,LiveConsent,LiveAttempt}=require('../src/modules/ai/providers/live-admission.model');
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function runPilotMountAcceptance({auth,token,foreignToken,readRequest}){
  assertIsolated();
  const {channel,...scope}=scopeFor(await auth.authenticateSessionToken(token),readRequest.accountId,Date.now());
  const owner={...scope,connectionId:readRequest.connectionId};
  const actor={tenantId:scope.tenantId,actorId:scope.actorId};
  const admin=createLiveAdmission({authorizeSession:async()=>owner,authorizeMarket:async()=>false,
    authorizeAdmin:async a=>a.actorId===actor.actorId&&a.tenantId===actor.tenantId,
    authorizePlatformAdmin:async a=>a.actorId===actor.actorId&&a.tenantId===actor.tenantId,
    authorizeReconciliation:async()=>false,resolvePrice:async()=>null});
  const p=await LivePlatform.findById('platform').lean(),t=await LiveControl.findById(actor.tenantId).lean();
  const global={dailyPicoUsd:1000000,dailyRequests:10,maxOutstandingPicoUsd:1000000,maxOutstandingRequests:1};
  const tenant={tenantDailyPicoUsd:1000000,actorDailyPicoUsd:1000000,tenantDailyRequests:10,actorDailyRequests:10};
  const platformRevision=(await admin.setPlatformControl(actor,{...global,enabled:true,expectedRevision:p.revision})).revision;
  await admin.setControl(actor,{...tenant,enabled:true,expectedRevision:t.revision});
  const fields={enabled:true,expiresAtMs:Date.now()+120000,
    members:[{tenantId:scope.tenantId,actorId:scope.actorId,accountId:scope.accountId}],instruments:[{symbol:'XAUUSD',timeframe:'1m'}]};
  const policyVersion=digest(fields);
  const d={providerId:'openai',modelId:'synthetic-pilot-mount-only',policyVersion,inputRatePicoUsd:100,outputRatePicoUsd:200,
    maxInputTokens:8192,maxOutputTokens:512,responseMode:'JSON_SCHEMA',store:false,streaming:false,reviewStatus:'APPROVED_LIVE'};
  const descriptor={...d,descriptorId:digest(d)};
  let approved=true,rights=true,secretReads=0;
  const bootstrap={descriptor,policy:{...fields,descriptorId:descriptor.descriptorId,policyVersion},
    verifyRelease:()=>approved,verifyApproval:async a=>approved&&a.policyVersion===policyVersion&&a.descriptorId===descriptor.descriptorId,
    resolveMembership:async s=>s.actorId===owner.actorId,resolveDataRights:async()=>rights,
    validatePayload:async()=>false,countUpperBound:async()=>{throw Error('Unexpected tokenization');},
    resolveBillingActor:async()=>null,authorizeBilling:async()=>false,
    secretPort:{withSecret(){secretReads++;throw Error('No provider calls allowed in mount acceptance');}}};
  const flags=['ACG_AI_READ_GATEWAY_ENABLED','ACG_AI_LIVE_PROVIDER_ENABLED','ACG_AI_RESTRICTED_PILOT_ENABLED'];
  const original=Object.fromEntries(flags.map(k=>[k,process.env[k]]));
  let server;
  try{
    for(const k of flags)process.env[k]='true';
    const app=createApp({authRuntime:{authService:auth},marketRuntime:{enabled:false,health:()=>({enabled:false})},
      tradingRuntime:{enabled:true,health:()=>({enabled:true})},restrictedPilotBootstrap:bootstrap});
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const root='http://127.0.0.1:'+server.address().port;
    const base={accountId:owner.accountId,connectionId:owner.connectionId,symbol:'XAUUSD',timeframe:'1m'};
    const call=async(op,body={},credential=token)=>{
      const res=await fetch(root+'/v1/ai/pilot/'+op,{method:'POST',headers:{'content-type':'application/json',
        ...(credential?{authorization:'Bearer '+credential}:{})},body:JSON.stringify({...base,...body})});
      return {status:res.status,body:await res.json(),cache:res.headers.get('cache-control')};
    };
    const old=await LiveConsent.findOne({tenantId:owner.tenantId,actorId:owner.actorId,accountId:owner.accountId,sessionId:owner.sessionId}).lean();
    const consent={expectedRevision:old?.revision??0,explicitConsent:true};
    const countBefore=await LiveAttempt.countDocuments({});
    assert.equal((await call('grant',consent,null)).status,401);
    assert.equal((await call('grant',consent,foreignToken)).status,403);
    assert.equal((await call('grant',{...consent,explicitConsent:false})).status,400);
    assert.equal((await call('grant',{...consent,question:'arbitrary input'})).status,400);
    rights=false;assert.equal((await call('grant',consent)).status,403);rights=true;
    const g=await call('grant',consent);assert.equal(g.status,200,JSON.stringify(g.body.error??{}));assert.equal(g.cache,'no-store');
    assert.equal(g.body.executionAllowed,false);assert.equal(g.body.revision,consent.expectedRevision+1);
    assert.equal((await call('generate',{operationId:randomUUID(),intent:'TRADE'})).status,400);
    assert.equal((await call('revoke',{expectedRevision:g.body.revision})).status,200);
    const rejected=await call('generate',{operationId:randomUUID(),intent:'HISTORICAL_OVERVIEW'});
    assert.ok(rejected.status>=400);assert.ok(!rejected.body.response);
    process.env.ACG_AI_RESTRICTED_PILOT_ENABLED='false';
    assert.equal((await call('grant',consent)).status,404);
    assert.equal((await fetch(root+'/health/live')).status,200);
    assert.equal(await LiveAttempt.countDocuments({}),countBefore);assert.equal(secretReads,0);
    console.log('PASS actual mounted restricted pilot API: real session and demo grant, consent/revoke, denied export, foreign scope, strict input and disabled switch; zero provider attempts');
  }finally{
    for(const k of flags){if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];}
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    // Restore a fixture-compatible platform control revision. No real database.
    await admin.setPlatformControl(actor,{...global,enabled:true,expectedRevision:platformRevision});
  }
}
module.exports={runPilotMountAcceptance};
