'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../../src/modules/auth/auth.service');

const A='64b000000000000000000001';
const B='64b000000000000000000002';
const USER='64b000000000000000000003';
const ID='64b000000000000000000004';
const ACC_A='64b000000000000000000010';
const ACC_B='64b000000000000000000011';
const FAKE_NOW=new Date('2026-10-16T15:00:00Z');

function query(rows) {return { select() {return {lean: async () => rows};} };}
function makeContextFixture() {
  const state={user:true,identity:true,grants:[
    {tenantId:A, accountId:ACC_A, userId:USER, status:'ACTIVE', permissions:['TRADE'], revokedAt:null, expiresAt:null},
    {tenantId:B, accountId:ACC_B, userId:USER, status:'ACTIVE', permissions:['TRADE'], revokedAt:null, expiresAt:null},
  ],accounts:[{_id:ACC_A,tenantId:A,status:'ACTIVE'},{_id:ACC_B,tenantId:B,status:'ACTIVE'}],
  tenants:[{_id:A,name:'Personal',status:'ACTIVE',authModes:['SUPABASE']},{_id:B,name:'Other Firm',status:'ACTIVE',authModes:['SUPABASE']}]};
  const auth=new AuthService({
    now:()=>FAKE_NOW,
    supabaseTradingSessionsEnabled:true,
    userModel:{findOne:()=>query(state.user?{_id:USER}:null)},
    loginIdentityModel:{findOne:()=>query(state.identity?{_id:ID}:null)},
    accountAccessGrantModel:{find:()=>query(state.grants.filter(g=>g.status==='ACTIVE'&&g.revokedAt===null&&g.permissions.includes('TRADE')&&(!g.expiresAt||g.expiresAt>FAKE_NOW)))},
    tenantModel:{find:()=>query(state.tenants.filter(t=>t.status==='ACTIVE'&&t.authModes.includes('SUPABASE')))},
    accountModel:{find:()=>query(state.accounts.filter(a=>a.status==='ACTIVE'))},
  });
  return {state,auth};
}
test('organization discovery returns only tenant-scoped eligible TRADE accounts',async()=>{
  const {state,auth}=makeContextFixture();
  let r=await auth.listSupabaseTenantContexts({userId:USER,loginIdentityId:ID});
  assert.deepEqual(r.organizations,[{id:B,name:'Other Firm',accountCount:1},{id:A,name:'Personal',accountCount:1}]);
  state.grants[1].permissions=['VIEW'];
  r=await auth.listSupabaseTenantContexts({userId:USER,loginIdentityId:ID});
  assert.deepEqual(r.organizations,[{id:A,name:'Personal',accountCount:1}]);
  state.accounts[0].tenantId=B; // a malformed cross-firm grant cannot leak
  r=await auth.listSupabaseTenantContexts({userId:USER,loginIdentityId:ID});
  assert.deepEqual(r.organizations,[]);
});
test('disabling identity or session rollout fails closed',async()=>{
 const {state,auth}=makeContextFixture();
 state.identity=false;
 await assert.rejects(auth.listSupabaseTenantContexts({userId:USER,loginIdentityId:ID}),
   err=>err.code==='TRADER_SESSION_INVALID');
 state.identity=true;auth.supabaseTradingSessionsEnabled=false;
 await assert.rejects(auth.listSupabaseTenantContexts({userId:USER,loginIdentityId:ID}),
   err=>err.code==='TRADER_SESSION_INVALID');
});
