'use strict';
const {createHash,randomUUID}=require('node:crypto');
const mongoose=require('mongoose');
const {LiveControl:C,LivePlatform:P,LiveEvent:E,LiveAttempt:A,LiveBudget:B,LivePlatformDay:D}=require('./live-admission.model');
const fail=()=>Object.assign(Error('Staff test allowance configuration rejected'),{code:'AI_STAFF_CAP_DENIED'});
const check=x=>{if(!x)throw fail();};
// Default unchanged. An expanded limit is only valid in an explicitly
// approved staff workspace, with a separate bounded expiration.
function requestCap(env,workspaceChat,now=Date.now()){
 const value=env.ACG_AI_FUNDED_STAFF_DAILY_REQUEST_LIMIT;
 const until=env.ACG_AI_FUNDED_STAFF_REQUEST_LIMIT_EXPIRES_AT_MS;
 if(value===undefined||value==='20'){check(!until);return {dailyRequests:20,expiresAtMs:null};}
 check(value==='100'&&workspaceChat===true&&typeof until==='string'&&/^\d{13}$/.test(until));
 const expiresAtMs=Number(until);
 check(expiresAtMs>now&&expiresAtMs-now<=86400000);
 return {dailyRequests:100,expiresAtMs};
}
function validateCaps(p,t,cap){
 return p?.enabled===true&&p.dailyPicoUsd===1000000000000&&p.dailyRequests===cap&&p.maxOutstandingRequests===1&&
    p.maxOutstandingPicoUsd<=1000000000000&&t?.enabled===true&&t.tenantDailyPicoUsd===1000000000000&&
    t.actorDailyPicoUsd===1000000000000&&t.tenantDailyRequests===cap&&t.actorDailyRequests===cap;
}
// One-time, explicitly approved maximum-budget accounting, not a provider
// settlement. The exact incident pin is created from verified read-only
// production observations; neither ordinary requests nor timeouts invoke it.
// Keep the maximum inside the existing settled-budget aggregate for older
// runtimes, and separately classify the non-provider-reported portion.
async function accountHeldStaffAttempt({session,env,clock,p,t,tenantId,actorId}){
 const pin=env.ACG_AI_STAFF_HELD_RECOVERY;
 check(typeof pin==='string'&&/^v1:[0-9]{13}:[0-9]{13}:[1-9][0-9]{0,12}$/.test(pin));
 const [version,created,observed,amountRaw]=pin.split(':');
 const createdAtMs=Number(created),observedAtMs=Number(observed),amount=Number(amountRaw);
 check([createdAtMs,observedAtMs,amount].every(Number.isSafeInteger)&&createdAtMs<=observedAtMs&&clock-observedAtMs>=60000&&amount<=1000000000000);
 const digest=createHash('sha256').update(JSON.stringify(['staff-held-max-budget-v1',tenantId,actorId,pin])).digest('hex');
 const candidates=await A.find({tenantId,actorId,createdAtMs,reservedPicoUsd:amount}).session(session).limit(2).maxTimeMS(2000).lean();
 check(candidates.length===1);
 const a=candidates[0];
 if(a.state==='ACCOUNTED_UNKNOWN'){
   check(a.recoveryApprovalDigest===digest&&a.accountedUnknownPicoUsd===amount&&a.unknownObservedAtMs===observedAtMs&&a.actualPicoUsd==null&&a.inputTokens==null&&a.outputTokens==null);
   check(p.outstandingRequests===0&&p.outstandingPicoUsd===0);
   return {recovered:false,alreadyAccounted:true,accountedUnknownPicoUsd:amount};
 }
 check(a.state==='HELD_UNKNOWN'&&a.updatedAtMs===observedAtMs&&a.evidenceId&&a.actualPicoUsd==null&&a.inputTokens==null&&a.outputTokens==null&&a.providerResponseHash==null&&p.outstandingRequests===1&&p.outstandingPicoUsd===amount);
 check(a.maxInputTokens*a.inputRatePicoUsd+a.maxOutputTokens*a.outputRatePicoUsd===amount);
 const digestKey=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 const rows=[[D,a.day],[B,digestKey(['tenant',tenantId,a.day])],[B,digestKey(['actor',tenantId,actorId,a.day])]];
 for(const [M,key] of rows){
   const r=await M.findById(key).session(session).maxTimeMS(2000).lean();
   check(r&&r.reservedPicoUsd===amount&&Number.isSafeInteger(r.requests)&&r.requests>0&&Number.isSafeInteger(r.settledPicoUsd)&&Number.isSafeInteger(r.settledPicoUsd+amount)&&Number.isSafeInteger((r.accountedUnknownPicoUsd??0)+amount)&&r.settledPicoUsd+amount<=1000000000000);
   const next={reservedPicoUsd:0,settledPicoUsd:r.settledPicoUsd+amount,accountedUnknownPicoUsd:(r.accountedUnknownPicoUsd??0)+amount};
   const result=await M.updateOne({_id:key,requests:r.requests,reservedPicoUsd:amount,settledPicoUsd:r.settledPicoUsd},{$set:next},{session,runValidators:true,maxTimeMS:2000});check(result.matchedCount===1);
 }
 const result=await A.updateOne({_id:a._id,state:'HELD_UNKNOWN',updatedAtMs:observedAtMs,reservedPicoUsd:amount},{$set:{state:'ACCOUNTED_UNKNOWN',accountedUnknownPicoUsd:amount,unknownObservedAtMs:observedAtMs,recoveryApprovalDigest:digest,updatedAtMs:clock}},{session,runValidators:true,maxTimeMS:2000});check(result.matchedCount===1);
 check(Number.isSafeInteger(p.fence+1)&&Number.isSafeInteger(p.revision+1)&&Number.isSafeInteger(t.fence+1)&&Number.isSafeInteger(t.revision+1));
 const platform=await P.updateOne({_id:'platform',revision:p.revision,fence:p.fence,outstandingRequests:1,outstandingPicoUsd:amount},{$set:{outstandingRequests:0,outstandingPicoUsd:0,fence:p.fence+1,revision:p.revision+1}},{session,runValidators:true,maxTimeMS:2000});
 const control=await C.updateOne({_id:tenantId,revision:t.revision,fence:t.fence},{$set:{revision:t.revision+1,fence:t.fence+1}},{session,runValidators:true,maxTimeMS:2000});
 check(platform.matchedCount===1&&control.matchedCount===1);
 await E.create([{_id:randomUUID(),tenantId,actorId,kind:'ACCOUNT_UNKNOWN',subject:a._id,revision:t.revision+1,atMs:clock}],{session,ordered:true});
 return {recovered:true,accountedUnknownPicoUsd:amount};
}
// Explicit operator-run migration. All three request ceilings change
// atomically; no daily rows, usage, monetary caps or outstanding balances
// are reset. Revision bumps invalidate old consents. Fail closed on drift.
async function migrateStaffRequestCap({env=process.env,now=Date.now}={}){
 const clock=now(),tenantId=env.ACG_AI_STAFF_PREVIEW_TENANT_ID;
 const staff=env.ACG_AI_STAFF_PREVIEW_EMAIL?.trim().toLowerCase();
 check(env.ACG_AI_FUNDED_LIVE_ENABLED==='true'&&env.ACG_AI_LIVE_PROVIDER_ENABLED==='true'&&env.ACG_AI_RESTRICTED_PILOT_ENABLED==='true'&&
   env.ACG_AI_STAFF_PREVIEW_ENABLED==='true'&&env.ACG_AI_FUNDED_WORKSPACE_CHAT_ENABLED==='true'&&env.ACG_AI_FUNDED_WORKSPACE_EXPORT_AUTHORIZED==='true'&&
   /^\d{13}$/.test(env.ACG_AI_FUNDED_WORKSPACE_EXPIRES_AT_MS??'')&&Number(env.ACG_AI_FUNDED_WORKSPACE_EXPIRES_AT_MS)>clock&&Number(env.ACG_AI_FUNDED_WORKSPACE_EXPIRES_AT_MS)-clock<=86400000&&
   /^[a-f0-9]{24}$/.test(tenantId??'')&&typeof staff==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(staff)&&
   ['20','100'].includes(env.ACG_AI_FUNDED_STAFF_DAILY_REQUEST_LIMIT));
 const {dailyRequests:target}=requestCap(env,true,clock);
 const actorId=createHash('sha256').update(JSON.stringify(['funded-staff-ai-v1',tenantId,staff])).digest('hex').slice(0,24);
 return mongoose.connection.transaction(async session=>{
   const p=await P.findById('platform').session(session).maxTimeMS(2000).lean();
   const t=await C.findById(tenantId).session(session).maxTimeMS(2000).lean();
   // The filter uses server-owned scalar values only. Keep global Mongoose
   // sanitization enabled; a second enabled tenant must deny the migration.
   const enabled=await C.find({enabled:true}).session(session).select('_id').limit(2).maxTimeMS(2000).lean();
   const other=enabled.length!==1||String(enabled[0]._id)!==tenantId;
   check(!other&&[20,100].includes(p?.dailyRequests)&&validateCaps(p,t,p.dailyRequests));
   if(env.ACG_AI_STAFF_HELD_RECOVERY){
     // Never change request limits and resolve unknown usage in the same operation.
     check(p.dailyRequests===target);
     const recovery=await accountHeldStaffAttempt({session,env,clock,p,t,tenantId,actorId});
     return {changed:false,dailyRequests:target,dailyUsd:1,maxConcurrent:1,...recovery};
   }
   check(p.outstandingRequests===0&&p.outstandingPicoUsd===0);
   const from=p.dailyRequests;
   if(from===target)return {changed:false,dailyRequests:target,dailyUsd:1,maxConcurrent:1};
   check([p.revision,p.fence,t.revision,t.fence].every(n=>Number.isSafeInteger(n)&&n>=0&&n<Number.MAX_SAFE_INTEGER));
   const a=await P.updateOne({_id:'platform',revision:p.revision,fence:p.fence,outstandingRequests:0,outstandingPicoUsd:0},
     {$set:{dailyRequests:target,revision:p.revision+1,fence:p.fence+1}},{session,runValidators:true,maxTimeMS:2000});
   const b=await C.updateOne({_id:tenantId,revision:t.revision,fence:t.fence},
     {$set:{tenantDailyRequests:target,actorDailyRequests:target,revision:t.revision+1,fence:t.fence+1}},{session,runValidators:true,maxTimeMS:2000});
   check(a.matchedCount===1&&b.matchedCount===1);
   await E.create([{_id:randomUUID(),tenantId,actorId,kind:'PLATFORM_CONTROL',subject:'platform',revision:p.revision+1,atMs:clock},
     {_id:randomUUID(),tenantId,actorId,kind:'CONTROL',subject:tenantId,revision:t.revision+1,atMs:clock}],{session,ordered:true});
   return {changed:true,previousDailyRequests:from,dailyRequests:target,dailyUsd:1,maxConcurrent:1};
 },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary',maxCommitTimeMS:2000});
}
module.exports={requestCap,validateCaps,migrateStaffRequestCap};
