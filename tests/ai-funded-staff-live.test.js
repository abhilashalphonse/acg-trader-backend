'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {createFundedStaffAuthority}=require('../src/modules/ai/providers/funded-staff-authority');
const {createRestrictedPilotPolicy}=require('../src/modules/ai/providers/restricted-pilot-policy');
const {loadFundedPilotBootstrap}=require('../src/modules/ai/providers/funded-pilot-bootstrap');
const tenantId='1'.repeat(24),sessionId='2'.repeat(24),a='3'.repeat(24),b='4'.repeat(24);
const now=Date.now(),future=new Date(now+60000).toISOString();
const env={ACG_AI_STAFF_PREVIEW_ENABLED:'true',ACG_AI_STAFF_PREVIEW_TENANT_ID:tenantId,ACG_AI_STAFF_PREVIEW_EMAIL:'staff@example.test'};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const query=v=>({select(){return this},read(){return this},readConcern(){return this},maxTimeMS(){return this},async lean(){return v}});
test('Funded actor shares a budget across owned accounts including verified aliases; wrong staff and tenant denied',async()=>{
  let principal={tenantId,sessionId,authMethod:'FEDERATED',ownerExternalRef:'owner',fundedCustomerEmail:'staff@example.test',
    accountIds:[a,b],expiresAt:future,refreshExpiresAt:future,idleExpiresAt:future};
  let session={ownerExternalRef:'owner',ownerExternalRefs:['alias']},status='ACTIVE';
  const authority=createFundedStaffAuthority({authService:{authenticateSessionToken:async()=>principal},env,now:()=>now,
    sessionModel:{findOne:()=>query(session)},
    accountModel:{findOne:f=>query(status==='ACTIVE'?{_id:f._id,tenantId,ownerExternalRef:f._id===a?'owner':'alias',accountType:'CHALLENGE'}:null)}});
  const s1=await authority.resolve('synthetic',a,randomUUID()),s2=await authority.resolve('synthetic',b,randomUUID());
  assert.equal(s1.actorId,s2.actorId);assert.notEqual(s1.accountId,s2.accountId);
  await assert.rejects(authority.resolve('synthetic','5'.repeat(24),randomUUID()),{code:'AI_FUNDED_STAFF_DENIED'});
  session={ownerExternalRef:'owner',ownerExternalRefs:[]};
  await assert.rejects(authority.resolve('synthetic',b,randomUUID()),{code:'AI_FUNDED_STAFF_DENIED'});
  session=null;await assert.rejects(authority.resolve('synthetic',a,randomUUID()),{code:'AI_FUNDED_STAFF_DENIED'});
  session={ownerExternalRef:'owner'};status='CLOSED';await assert.rejects(authority.resolve('synthetic',a,randomUUID()),{code:'AI_FUNDED_STAFF_DENIED'});
  status='ACTIVE';principal={...principal,fundedCustomerEmail:'other@example.test'};
  await assert.rejects(authority.resolve('synthetic',a,randomUUID()),{code:'AI_FUNDED_STAFF_DENIED'});
});
test('Funded policy actor-only scope remains explicit and binds reviewed rights; personal policy does not accept wildcard',async()=>{
  const actorId='5'.repeat(24),descriptorId='a'.repeat(64);
  const fields={enabled:true,expiresAtMs:now+60000,members:[{tenantId,actorId}],instruments:[{symbol:'XAUUSD',timeframe:'1m'}],approvalDigest:'b'.repeat(64)};
  const policyVersion=hash(fields),policy={...fields,descriptorId,policyVersion};
  let rights=true;
  const args={policy,verifyApproval:async()=>true,resolveMembership:async()=>true,resolveDataRights:async()=>rights,validatePayload:async()=>false,now:()=>now};
  assert.throws(()=>createRestrictedPilotPolicy({...args,resolveAccount:async()=>null}));
  const p=createRestrictedPilotPolicy({...args,fundedStaff:true}),w={symbol:'XAUUSD',timeframe:'1m',descriptorId,policyVersion};
  assert.equal(await p.marketEntitlement({tenantId,actorId,accountId:a},w,'GRANT'),true);
  assert.equal(await p.marketEntitlement({tenantId,actorId,accountId:b},w,'CLAIM'),true);
  assert.equal(await p.marketEntitlement({tenantId,actorId:'6'.repeat(24),accountId:a},w,'CLAIM'),false);
  rights=false;assert.equal(await p.marketEntitlement({tenantId,actorId,accountId:a},w,'DISPATCH'),false);
  assert.throws(()=>createRestrictedPilotPolicy({...args,fundedStaff:true,policy:{...policy,approvalDigest:'c'.repeat(64)}}));
});
test('production bootstrap fails closed with absent activation flags, approval or provider key',async()=>{
  assert.equal(await loadFundedPilotBootstrap({env:{}}),null);
  const enabled={...env,ACG_AI_FUNDED_LIVE_ENABLED:'true',ACG_AI_LIVE_PROVIDER_ENABLED:'true',ACG_AI_RESTRICTED_PILOT_ENABLED:'true'};
  await assert.rejects(loadFundedPilotBootstrap({env:enabled}),{code:'AI_FUNDED_CONFIG_DENIED'});
  const approval={approvalId:'test-review',rightsEvidence:'synthetic review only',expiresAtMs:now+60000,tenantId,provider:'twelve-data',instruments:[{symbol:'XAUUSD',timeframe:'1m'}]};
  await assert.rejects(loadFundedPilotBootstrap({env:{...enabled,ACG_AI_FUNDED_EXPORT_APPROVAL_JSON:JSON.stringify(approval)},now:()=>now}),{code:'AI_FUNDED_CONFIG_DENIED'});
});
