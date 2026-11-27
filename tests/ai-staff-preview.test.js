'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {staffPreviewAllowed}=require('../src/modules/ai/providers/staff-preview.routes');
test('staff preview follows verified Funded email across owned accounts only; no session forgery',()=>{
  const tenant='1'.repeat(24),a='2'.repeat(24),b='3'.repeat(24),now=Date.now(),future=new Date(now+60000).toISOString();
  const env={ACG_AI_STAFF_PREVIEW_ENABLED:'true',ACG_AI_STAFF_PREVIEW_TENANT_ID:tenant,ACG_AI_STAFF_PREVIEW_EMAIL:'staff@example.test'};
  const p={authMethod:'FEDERATED',tenantId:tenant,ownerExternalRef:'fixture-owner',fundedCustomerEmail:'STAFF@example.test',
    sessionId:'4'.repeat(24),accountIds:[a,b],expiresAt:future,refreshExpiresAt:future,idleExpiresAt:future};
  assert.equal(staffPreviewAllowed(p,a,env,now),true);
  assert.equal(staffPreviewAllowed(p,b,env,now),true);
  assert.equal(staffPreviewAllowed(p,'5'.repeat(24),env,now),false);
  for(const changes of [{tenantId:'6'.repeat(24)},{fundedCustomerEmail:'other@example.test'},{authMethod:'PASSWORD'},{authMethod:'SUPABASE'},
    {ownerExternalRef:''},{expiresAt:new Date(now).toISOString()}])assert.equal(staffPreviewAllowed({...p,...changes},a,env,now),false);
  assert.equal(staffPreviewAllowed(p,a,{...env,ACG_AI_STAFF_PREVIEW_ENABLED:'false'},now),false);
});
