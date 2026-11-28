'use strict';
const {createHash,randomUUID}=require('node:crypto');
const mongoose=require('mongoose');
const {LiveControl:C,LivePlatform:P,LiveEvent:E}=require('./live-admission.model');
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
   check(!other&&[20,100].includes(p?.dailyRequests)&&validateCaps(p,t,p.dailyRequests)&&p.outstandingRequests===0&&p.outstandingPicoUsd===0);
   const from=p.dailyRequests;
   if(from===target)return {changed:false,dailyRequests:target,dailyUsd:1,maxConcurrent:1};
   check([p.revision,p.fence,t.revision,t.fence].every(n=>Number.isSafeInteger(n)&&n>=0&&n<Number.MAX_SAFE_INTEGER));
   const a=await P.updateOne({_id:'platform',revision:p.revision,fence:p.fence,outstandingRequests:0,outstandingPicoUsd:0},
     {$set:{dailyRequests:target,revision:p.revision+1,fence:p.fence+1}},{session,runValidators:true,maxTimeMS:2000});
   const b=await C.updateOne({_id:tenantId,revision:t.revision,fence:t.fence},
     {$set:{tenantDailyRequests:target,actorDailyRequests:target,revision:t.revision+1,fence:t.fence+1}},{session,runValidators:true,maxTimeMS:2000});
   check(a.matchedCount===1&&b.matchedCount===1);
   await E.create([{_id:randomUUID(),tenantId,actorId,kind:'PLATFORM_CONTROL',subject:'platform',revision:p.revision+1,atMs:clock},
     {_id:randomUUID(),tenantId,actorId,kind:'CONTROL',subject:tenantId,revision:t.revision+1,atMs:clock}],{session});
   return {changed:true,previousDailyRequests:from,dailyRequests:target,dailyUsd:1,maxConcurrent:1};
 },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary',maxCommitTimeMS:2000});
}
module.exports={requestCap,validateCaps,migrateStaffRequestCap};
