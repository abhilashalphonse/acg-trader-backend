'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAiReadGateway } = require('./ai-read-gateway');
const { AVAILABLE_READ_TOOLS, resolveReadTool } = require('./read-tool-registry');

const id = digit => digit.repeat(24);
function fixture() {
  let clock = 1700000000000, enabled = true, accountAllowed = true, saved = null, reads = 0;
  const expires = () => new Date(clock + 7200000).toISOString();
  const principal = { authMethod:'SUPABASE', tenantId:id('1'), userId:id('2'), sessionId:id('3'),
    accountIds:[id('4')], expiresAt:expires(), refreshExpiresAt:expires(), idleExpiresAt:expires() };
  const store = {
    async account(s) { return accountAllowed && s.tenantId === principal.tenantId && s.actorId === principal.userId &&
      s.accountId === id('4') ? { currency:'USD', state:{ balance:'10000' }, updatedAt:new Date(clock) } : null; },
    async createGrant(doc) { if(saved) return false; saved=structuredClone(doc); return true; },
    async getGrant(key) { return saved?._id === key ? structuredClone(saved) : null; },
    async revokeGrant(key,c) { if(saved?._id!==key || saved.connectionId!==c || saved.status!=='ACTIVE') return false;
      saved.status='REVOKED'; saved.revokedAt=new Date(clock); return true; },
    async positions(scope,limit) { reads++; assert.equal(scope.accountId,id('4')); assert.equal(limit,2);
      return [{_id:id('8'),symbol:'XAUUSD',openVolume:'0.1',metadata:{secret:'never'}},{_id:id('9')}]; },
    async orders() { reads++; return []; },
  };
  const gateway = createAiReadGateway({ store, enabled:()=>enabled, now:()=>clock });
  const input = { accountId:id('4'), toolIds:[...AVAILABLE_READ_TOOLS] };
  return { principal,store,gateway,input, disable:()=>{enabled=false;}, removeAccount:()=>{accountAllowed=false;},
    tick:ms=>{clock+=ms;}, readCount:()=>reads, async issue(){const g=await gateway.create(principal,input);
      return { accountId:input.accountId,connectionId:g.connectionId,toolId:'account.positions.read',args:{limit:1} };},
    fresh:async()=>principal };
}
const rejects = (p,code) => assert.rejects(p,e=>e.code===code);
test('valid scoped read returns a bounded projection and not raw metadata',async()=>{
  const x=fixture(), q=await x.issue();
  const result=await x.gateway.invoke(x.principal,q,x.fresh);
  assert.equal(result.result.positions.length,1); assert.equal(result.result.truncated,true);
  assert.equal(result.result.positions[0].metadata,undefined); assert.equal(x.readCount(),1);
});
test('disabled, legacy, cross-account and absent account grants fail closed',async()=>{
  const x=fixture(); x.disable(); await rejects(x.gateway.create(x.principal,x.input),'AI_DISABLED');
  const y=fixture(); await rejects(y.gateway.create({...y.principal,authMethod:'FEDERATED'},y.input),'AI_IDENTITY_UNAVAILABLE');
  await rejects(y.gateway.create(y.principal,{...y.input,accountId:id('5')}),'ACCOUNT_ACCESS_FORBIDDEN');
  y.removeAccount(); await rejects(y.gateway.create(y.principal,y.input),'AI_ACCOUNT_FORBIDDEN');
});
test('unissued or spoofed connection cannot dispatch',async()=>{
  const x=fixture(); const q=await x.issue();
  await rejects(x.gateway.invoke(x.principal,{...q,connectionId:'fake'},x.fresh),'AI_GRANT_INACTIVE');
  await rejects(x.gateway.invoke({...x.principal,sessionId:id('6')},q,x.fresh),'AI_GRANT_INACTIVE');
  await rejects(x.gateway.invoke({...x.principal,userId:id('7')},q,x.fresh),'AI_ACCOUNT_FORBIDDEN');
  assert.equal(x.readCount(),0);
});
test('unknown, financial writes and argument injection cannot dispatch',async()=>{
  const x=fixture(),q=await x.issue();
  for(const toolId of ['trade.execute','constructor','__proto__','market.quote.read']){
    await assert.rejects(x.gateway.invoke(x.principal,{...q,toolId},x.fresh));
  }
  await rejects(x.gateway.invoke(x.principal,{...q,args:{limit:1,accountId:id('5')}},x.fresh),'AI_INVALID_TOOL_ARGUMENTS');
  await rejects(x.gateway.invoke(x.principal,{...q,args:{limit:51}},x.fresh),'AI_INVALID_TOOL_ARGUMENTS');
  assert.equal(x.readCount(),0);
});
test('revocation and expiry cannot be silently recreated',async()=>{
  const x=fixture(),q=await x.issue();
  assert.equal((await x.gateway.revoke(x.principal,q)).revoked,true);
  await rejects(x.gateway.invoke(x.principal,q,x.fresh),'AI_GRANT_INACTIVE');
  await rejects(x.gateway.create(x.principal,x.input),'AI_GRANT_ALREADY_EXISTS');
  const y=fixture(),r=await y.issue(); y.tick(3600000);
  await rejects(y.gateway.invoke(y.principal,r,y.fresh),'GRANT_INACTIVE');
});
test('in-flight revocation and account removal suppress results',async()=>{
  const x=fixture(),q=await x.issue();
  await rejects(x.gateway.invoke(x.principal,q,async()=>{await x.gateway.revoke(x.principal,q);return x.principal;}),'AI_GRANT_INACTIVE');
  const y=fixture(),r=await y.issue();
  await rejects(y.gateway.invoke(y.principal,r,async()=>{y.removeAccount();return y.principal;}),'AI_ACCOUNT_FORBIDDEN');
});
test('grant creation is limited to implemented read tools',async()=>{
  const x=fixture();
  await rejects(x.gateway.create(x.principal,{...x.input,toolIds:['market.quote.read']}),'AI_TOOL_NOT_AVAILABLE');
  assert.throws(()=>resolveReadTool('trade.execute',{}));
  assert.throws(()=>resolveReadTool('account.valuation.read',{unexpected:true}));
});
test('valuation explicitly labels persisted state rather than live data',async()=>{
  const x=fixture(),q=await x.issue();
  const r=await x.gateway.invoke(x.principal,{...q,toolId:'account.valuation.read',args:{}},x.fresh);
  assert.equal(r.result.live,false); assert.equal(r.result.balance,'10000');
});

test('financial actions are denied before even reading account or grant data',async()=>{
  const x=fixture(),q=await x.issue();
  x.store.account=async()=>assert.fail('must not load account');
  x.store.getGrant=async()=>assert.fail('must not load grant');
  for(const toolId of ['trade.execute','orders.cancel','positions.close','account.withdraw','account.risk.write']){
    await rejects(x.gateway.invoke(x.principal,{...q,toolId},x.fresh),'AI_FINANCIAL_BOUNDARY_DENIED');
  }
  assert.equal(x.readCount(),0);
});
test('a corrupt grant containing a future candidate cannot dispatch even a valid read',async()=>{
  const x=fixture(),q=await x.issue();
  const original=x.store.getGrant;
  x.store.getGrant=async key=>{const grant=await original(key);grant.toolIds.push('market.quote.read');return grant;};
  await rejects(x.gateway.invoke(x.principal,q,x.fresh),'AI_FINANCIAL_BOUNDARY_DENIED');
  assert.equal(x.readCount(),0);
});
