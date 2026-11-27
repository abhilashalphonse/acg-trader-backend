'use strict';
// Explicit operator command, not ordinary application startup. Dry run by
// default. Does not contact market feeds or OpenAI or modify trading records.
const mongoose=require('mongoose');
const {createHash}=require('node:crypto');
const {connectDatabase,disconnectDatabase,verifyTransactionSupport}=require('../src/config/database');
const {Tenant}=require('../src/modules/tenancy/tenant.model');
const {LivePlatform,LiveControl,LiveAttempt,LiveBudget,LivePlatformDay,models}=require('../src/modules/ai/providers/live-admission.model');
const {AiQuotaBucket}=require('../src/modules/ai/ai-quota-store');
const {createLiveAdmission}=require('../src/modules/ai/providers/live-admission');
const USD=1000000000000;
const platformCaps={dailyPicoUsd:USD,dailyRequests:20,maxOutstandingPicoUsd:USD,maxOutstandingRequests:1};
const tenantCaps={tenantDailyPicoUsd:USD,actorDailyPicoUsd:USD,tenantDailyRequests:20,actorDailyRequests:20};
const match=(x,c)=>x&&Object.entries(c).every(([k,v])=>x[k]===v);
const requireTrue=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});};
async function prepare({apply=false,env=process.env}={}){
  const tenantId=env.ACG_AI_STAFF_PREVIEW_TENANT_ID;
  requireTrue(/^[a-f0-9]{24}$/.test(tenantId??'')&&env.ACG_AI_STAFF_PREVIEW_ENABLED==='true','INVALID_STAFF_CONFIG');
  const tenant=await Tenant.findOne({_id:tenantId,slug:'acg-funded',status:'ACTIVE'}).select('_id').lean();
  requireTrue(tenant,'TENANT_MISMATCH');
  const p=await LivePlatform.findById('platform').lean(),t=await LiveControl.findById(tenantId).lean();
  requireTrue(!p||match(p,platformCaps),'PLATFORM_CAP_MISMATCH');
  requireTrue(!t||match(t,tenantCaps),'TENANT_CAP_MISMATCH');
  if(!p)requireTrue(!await LiveAttempt.exists({})&&!await LiveBudget.exists({})&&!await LivePlatformDay.exists({}),'HISTORICAL_EXPOSURE_REVIEW_REQUIRED');
  if(!apply)return {mode:'READ_ONLY',platformPresent:!!p,tenantPresent:!!t,platformEnabled:p?.enabled===true,tenantEnabled:t?.enabled===true,
    dailyUsd:1,dailyRequests:20,concurrentRequests:1};
  requireTrue(env.ACG_AI_FUNDED_LEDGER_PROVISION_APPROVED==='true'&&env.ACG_AI_FUNDED_LIVE_ENABLED!=='true'&&
    env.ACG_AI_LIVE_PROVIDER_ENABLED!=='true'&&env.ACG_AI_RESTRICTED_PILOT_ENABLED!=='true','EXPLICIT_OFFLINE_PROVISION_REQUIRED');
  const actor={tenantId,actorId:createHash('sha256').update('funded-ai-ledger-operator:'+tenantId).digest('hex').slice(0,24)};
  const allow=a=>a.tenantId===actor.tenantId&&a.actorId===actor.actorId;
  const admin=createLiveAdmission({authorizeSession:async()=>null,authorizeMarket:async()=>false,
    authorizeAdmin:async a=>allow(a),authorizePlatformAdmin:async a=>allow(a),
    authorizeReconciliation:async()=>false,resolvePrice:async()=>null});
  for(const m of [...models,AiQuotaBucket]){
    try{await m.createCollection();}catch(e){if(e.code!==48)throw e;}
    await m.createIndexes();
  }
  // Only initial controls are created. Existing revisions, balances, pauses,
  // usage and unknown exposure are preserved; never reset or resume silently.
  if(!p)await admin.setPlatformControl(actor,{...platformCaps,enabled:true,expectedRevision:0});
  if(!t)await admin.setControl(actor,{...tenantCaps,enabled:true,expectedRevision:0});
  return {mode:'PREPARED_NO_INFERENCE',dailyUsd:1,dailyRequests:20,concurrentRequests:1,
    platformEnabled:(await LivePlatform.findById('platform').lean())?.enabled===true,
    tenantEnabled:(await LiveControl.findById(tenantId).lean())?.enabled===true};
}
if(require.main===module)(async()=>{
  try{
    await connectDatabase();await verifyTransactionSupport();
    requireTrue(mongoose.connection.name===process.env.ACG_AI_EXPECTED_DATABASE,'DATABASE_MISMATCH');
    const result=await prepare({apply:process.argv.includes('--apply')});console.log(JSON.stringify(result));
  }catch(e){console.error('AI ledger preparation failed:',/^[A-Z_]{1,80}$/.test(e.code??'')?e.code:'UNAVAILABLE');process.exitCode=1;}
  finally{await disconnectDatabase();}
})();
module.exports={prepare,platformCaps,tenantCaps};
