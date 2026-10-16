'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PersonalDemoService, INTERNAL_OWNER, DEMO_BALANCE } = require('../../src/modules/identity/personal-demo.service');
const { verifyProviderEmail } = require('../../src/modules/identity/personal-email-verifier');

const TENANT='64b000000000000000000001';
const USER='64b000000000000000000003';
const LOGIN_ID='64b000000000000000000004';
const ACCOUNT='64b000000000000000000010';
const NOW=new Date('2026-10-16T12:00:00Z');
function query(row){return {lean:async()=>row};}

function fixture() {
 const state={namespace:null, account:null, grant:null, opening:null, provisionCount:0, ledgerCount:0, grantedWriteFails:false};
 const tenantModel={
   async findOneAndUpdate(filter,patch) {
     if (!state.namespace) state.namespace={_id:TENANT,...patch.$setOnInsert};
     return query(state.namespace);
   },
   findOne:()=>query(state.namespace),
 };
 const accountModel={findOne:()=>query(state.account)};
 const ledgerModel={findOne:()=>query(state.opening)};
 const grantModel={
   async findOneAndUpdate(filter,patch) {
     if(state.grantedWriteFails) throw new Error('grant write failed');
     if(!state.grant)state.grant={...filter,...patch.$setOnInsert};
     return query(state.grant);
   },
   findOne:()=>query(state.grant),
 };
 const accountControlService={async provision(command){
   state.provisionCount++;
   assert.equal(command.accountType,'DEMO');
   assert.equal(command.initialBalance,DEMO_BALANCE);
   assert.equal(command.tenantId,TENANT);
   assert.equal(command.userId,USER);
   assert.equal(command.ownerExternalRef,null);
   if(!state.account) {
     state.account={_id:ACCOUNT,userId:USER,tenantId:TENANT,
       externalRef:command.externalRef,accountType:'DEMO',currency:'USD',
       metadata:{product:'DEFAULT_DEMO_V1',ownership:INTERNAL_OWNER}};
     state.opening={type:'DEPOSIT',amount:DEMO_BALANCE,balanceBefore:'0',balanceAfter:DEMO_BALANCE};
     state.ledgerCount++;
   }
   return {idempotentReplay:state.provisionCount>1};
 }};
 const service=new PersonalDemoService({tenantModel,accountModel,ledgerModel,grantModel,accountControlService,now:()=>NOW});
 return {service,state};
}

test('creates exactly one 100k virtual demo and returns it on callback retries',async()=>{
 const {service,state}=fixture();
 const first=await service.ensureDemo({userId:USER,loginIdentityId:LOGIN_ID});
 const second=await service.ensureDemo({userId:USER,loginIdentityId:LOGIN_ID});
 assert.equal(first.account.initialBalance,'100000');
 assert.equal(first.accountId,ACCOUNT);
 assert.deepEqual(first.account,second.account);
 assert.equal(state.ledgerCount,1);
 assert.deepEqual(state.grant.permissions,['VIEW','TRADE']);
 assert.equal(state.grant.source,'PERSONAL');
 assert.equal(first.idempotentReplay,false);
 assert.equal(second.idempotentReplay,true);
 assert.equal(await service.isPersonalNamespace(TENANT),true);
});

test('grant persistence fails recoverably and retry completes without double-credit',async()=>{
 const {service,state}=fixture();
 state.grantedWriteFails=true;
 await assert.rejects(service.ensureDemo({userId:USER,loginIdentityId:LOGIN_ID}),/grant write failed/);
 state.grantedWriteFails=false;
 await service.ensureDemo({userId:USER,loginIdentityId:LOGIN_ID});
 assert.equal(state.ledgerCount,1);
 assert.equal(state.grant.status,'ACTIVE');
});

test('revoked grant cannot be resurrected by signing in again',async()=>{
 const {service,state}=fixture();
 await service.ensureDemo({userId:USER,loginIdentityId:LOGIN_ID});
 state.grant.status='REVOKED';
 state.grant.revokedAt=new Date();
 await assert.rejects(service.ensureDemo({userId:USER,loginIdentityId:LOGIN_ID}),
 err=>err.code==='PERSONAL_DEMO_UNAVAILABLE');
 assert.equal(state.ledgerCount,1);
});

test('reserved namespace misconfiguration fails closed and cannot be reassigned',async()=>{
 const {service,state}=fixture();
 state.namespace={_id:TENANT,slug:'acg-trader-personal',status:'ACTIVE',
   authModes:['PASSWORD','SUPABASE'],features:{personalOwner:INTERNAL_OWNER},
   metadata:{namespace:'INTERNAL_ONLY'}};
 await assert.rejects(service.ensureDemo({userId:USER,loginIdentityId:LOGIN_ID}),
  err=>err.code==='PERSONAL_DEMO_UNAVAILABLE');
 assert.equal(state.provisionCount,0);
});

test('ledger inconsistency blocks access rather than minting a grant',async()=>{
 const {service,state}=fixture();
 await service.ensureDemo({userId:USER,loginIdentityId:LOGIN_ID});
 state.opening.balanceAfter='200000';
 state.grant=null;
 await assert.rejects(service.ensureDemo({userId:USER,loginIdentityId:LOGIN_ID}),
  err=>err.code==='PERSONAL_DEMO_LEDGER_UNAVAILABLE');
 assert.equal(state.grant,null);
});

test('provider confirms JWT subject and verified email before personal provisioning',async()=>{
 const defaults={identityService:{verifier:{verify:async()=>({subject:'subject-123'})}},
   projectRef:'mwkwvchaqjqtyfgmialk', publishableKey:'sb_publishable_public'};
 const good=async()=>({ok:true,json:async()=>({id:'subject-123',email:'user@example.com',email_confirmed_at:'2026-10-16T10:00:00Z'})});
 assert.deepEqual(await verifyProviderEmail('token',{...defaults,fetchImpl:good}),{subject:'subject-123'});
 const unverified=async()=>({ok:true,json:async()=>({id:'subject-123',email:'user@example.com',email_confirmed_at:null})});
 await assert.rejects(verifyProviderEmail('token',{...defaults,fetchImpl:unverified}),
 err=>err.code==='EMAIL_VERIFICATION_REQUIRED');
 const mismatched=async()=>({ok:true,json:async()=>({id:'other',email:'user@example.com',email_confirmed_at:'2026-10-16T10:00:00Z'})});
 await assert.rejects(verifyProviderEmail('token',{...defaults,fetchImpl:mismatched}),
 err=>err.code==='IDENTITY_TOKEN_INVALID');
});
