'use strict';
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=v=>typeof v==='string'&&/^[a-f0-9]{24}$/.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const exact=(obj,keys)=>obj&&isDeepStrictEqual(Object.keys(obj).sort(),keys.slice().sort());
const safeTime=v=>Number.isSafeInteger(v)&&v>0;
const fail=()=>Object.assign(Error('Pilot policy unavailable'),{code:'LIVE_AI_PILOT_POLICY_DENIED'});
// Staff-only, read-only pilot. Membership and export rights are deployment
// policy inputs, not browser claims. An unapproved policy cannot enable egress.
function createRestrictedPilotPolicy({policy,verifyApproval,resolveAccount,resolveMembership,resolveDataRights,validatePayload,now=Date.now,fundedStaff=false}={}){
  if(![verifyApproval,resolveMembership,resolveDataRights,validatePayload,now].every(f=>typeof f==='function')||(!fundedStaff&&typeof resolveAccount!=='function'))throw fail();
  if(!policy||!exact(policy,['enabled','expiresAtMs','descriptorId','policyVersion','members','instruments'])||
    typeof policy.enabled!=='boolean'||!safeTime(policy.expiresAtMs)||!hex(policy.descriptorId)||!hex(policy.policyVersion)||
    !Array.isArray(policy.members)||policy.members.length>10||!policy.members.every(m=>exact(m,fundedStaff?['tenantId','actorId']:['tenantId','actorId','accountId'])&&Object.values(m).every(id))||
    !Array.isArray(policy.instruments)||policy.instruments.length>10||!policy.instruments.every(i=>exact(i,['symbol','timeframe'])&&
      typeof i.symbol==='string'&&/^[A-Z0-9._-]{1,32}$/.test(i.symbol)&&['1m','5m','15m','30m','1h','4h','1d','1w'].includes(i.timeframe)))throw fail();
  const pinned=structuredClone(policy),{policyVersion,descriptorId,...fields}=pinned;
  // The descriptor pins the policy hash. Approval separately binds both hashes
  // to avoid a circular digest dependency.
  if(hash(fields)!==policyVersion)throw fail();
  const allowed=async(scope,workspace,purpose)=>{
    try{
      if(pinned.enabled!==true||now()>=pinned.expiresAtMs||await verifyApproval(Object.freeze({policyVersion,descriptorId}))!==true||
        !pinned.members.some(m=>(fundedStaff?['tenantId','actorId']:['tenantId','actorId','accountId']).every(k=>m[k]===scope?.[k]))||
        !pinned.instruments.some(i=>i.symbol===workspace?.symbol&&i.timeframe===workspace?.timeframe)||
        !['GRANT','CLAIM','DISPATCH','DISCLOSE','EXPORT'].includes(purpose))return false;
      if(workspace.descriptorId!==pinned.descriptorId||workspace.policyVersion!==policyVersion)return false;
      if(!fundedStaff){
        const a=await resolveAccount(scope);
        if(!a||a.tenantId!==scope.tenantId||a.accountId!==scope.accountId||a.actorId!==scope.actorId||
          a.accountType!=='DEMO'||a.active!==true||a.ownership!=='ACG_TRADER_PERSONAL_V1')return false;
      } // Funded branch is permitted only after the separate fresh session/ownership authority.
      if(await resolveMembership(scope,policyVersion)!==true)return false;
      if(await resolveDataRights({scope,symbol:workspace.symbol,timeframe:workspace.timeframe,policyVersion,providerId:'openai'})!==true)return false;
      return now()<pinned.expiresAtMs&&await verifyApproval(Object.freeze({policyVersion,descriptorId}))===true;
    }catch{return false;}
  };
  return Object.freeze({
    marketEntitlement:allowed,
    async authorizeExport({scope,workspace,policyVersion:version,descriptorId,wireDigest,payload}){
      try{
        const w={...workspace,policyVersion:version,descriptorId};
        if(!await allowed(scope,w,'EXPORT')||!hex(wireDigest)||hash(payload)!==wireDigest||
          payload?.store!==false||payload.stream!==false||payload.n!==1||payload.service_tier!=='default'||
          !Array.isArray(payload.messages)||payload.messages.length!==2||payload.messages[0].role!=='system'||payload.messages[1].role!=='user'||
          Object.hasOwn(payload,'tools')||Object.hasOwn(payload,'functions'))return false;
        // Data-loss prevention and licensing review must positively approve the
        // exact wire body. A generic keyword filter is not sufficient.
        if(await validatePayload({scope,workspace:w,wireDigest,payload:structuredClone(payload)})!==true)return false;
        return allowed(scope,w,'EXPORT');
      }catch{return false;}
    }
  });
}
// Reuse the actual personal-demo grant/account policy. The returned projection
// contains no financial state and is never included in the provider payload.
function createPersonalDemoPilotAccountResolver({store,now=Date.now}={}){
  if(typeof store?.account!=='function'||typeof now!=='function')throw fail();
  return async scope=>{
    if(!['tenantId','actorId','accountId'].every(k=>id(scope?.[k])))return null;
    const row=await store.account(scope,now());
    return row?{tenantId:scope.tenantId,actorId:scope.actorId,accountId:scope.accountId,
      accountType:'DEMO',active:true,ownership:'ACG_TRADER_PERSONAL_V1'}:null;
  };
}
module.exports={createRestrictedPilotPolicy,createPersonalDemoPilotAccountResolver};
