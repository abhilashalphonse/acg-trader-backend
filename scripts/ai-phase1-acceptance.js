'use strict';
// Dedicated CI replica-set acceptance. No environment-provided URI is accepted.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const express = require('express');
const { AuthService } = require('../src/modules/auth/auth.service');
const { Tenant } = require('../src/modules/tenancy/tenant.model');
const { User } = require('../src/modules/identity/user.model');
const { LoginIdentity } = require('../src/modules/identity/login-identity.model');
const { AccountAccessGrant } = require('../src/modules/identity/account-access-grant.model');
const { TradingAccount } = require('../src/modules/accounts/trading-account.model');
const { TraderSession } = require('../src/modules/auth/trader-session.model');
const { ServiceApiKey } = require('../src/modules/auth/service-api-key.model');
const { Position } = require('../src/modules/trading/position.model');
const { Order } = require('../src/modules/trading/order.model');
const { PersonalDemoService, INTERNAL_SLUG, INTERNAL_OWNER, DEMO_PRODUCT } = require('../src/modules/identity/personal-demo.service');
const { AiReadGrant } = require('../src/modules/ai/ai-read-grant.model');
const { AiGovernanceControl, AiAuditEvent } = require('../src/modules/ai/ai-governance.model');
const { AiQuotaBucket, createAiQuotaStore } = require('../src/modules/ai/ai-quota-store');
const { createAiQuota } = require('../src/modules/ai/ai-quota');
const { createAiReadStore } = require('../src/modules/ai/ai-read-store');
const { createAiReadGateway } = require('../src/modules/ai/ai-read-gateway');
const { createAiGovernanceStore } = require('../src/modules/ai/ai-governance-store');
const { createAiGovernance } = require('../src/modules/ai/ai-governance');
const { createAiReadRouter } = require('../src/modules/ai/ai-read.routes');
const { createAiGovernanceRouter } = require('../src/modules/ai/ai-governance.routes');
const { aiJsonBoundary } = require('../src/modules/ai/ai-http-security');

async function main() {
  if (process.env.NODE_ENV !== 'test' || process.env.ACG_AI_ISOLATED_CI !== 'true') {
    throw new Error('This suite runs only in an explicitly isolated test environment');
  }
  const dbName='acg_ai_ci_'+crypto.randomBytes(12).toString('hex');
  mongoose.set('strictQuery',true); mongoose.set('sanitizeFilter',true);
  let server;
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017/'+dbName+'?replicaSet=rs0',
      {autoIndex:false,serverSelectionTimeoutMS:5000,maxPoolSize:20});
    const hello=await mongoose.connection.db.admin().command({hello:1});
    assert.equal(hello.setName,'rs0');
    assert.equal(mongoose.connection.name,dbName);
    for(const model of [Tenant,User,LoginIdentity,AccountAccessGrant,TradingAccount,TraderSession,ServiceApiKey,
      Position,Order,AiReadGrant,AiGovernanceControl,AiAuditEvent,AiQuotaBucket]){
      await model.createCollection();await model.createIndexes();
    }
    const indexes=await AiQuotaBucket.collection.indexes();
    assert.ok(indexes.some(i=>i.key.expiresAt===1&&i.expireAfterSeconds===0));
    assert.ok((await AiAuditEvent.collection.indexes()).some(i=>i.key.tenantId===1&&i.key.occurredAt===-1));
    console.log('PASS isolated replica-set and AI index provisioning');
    const tenant=await Tenant.create({name:'Personal test',slug:INTERNAL_SLUG,authModes:['SUPABASE'],
      features:{personalOwner:INTERNAL_OWNER},metadata:{namespace:'INTERNAL_ONLY'}});
    const foreign=await Tenant.create({name:'Partner test',slug:'partner-test',authModes:['SUPABASE']});
    const tid=String(tenant._id),fid=String(foreign._id);
    const personal=new PersonalDemoService();
    const auth=new AuthService({supabaseTradingSessionsEnabled:true,personalDemoEnabled:true,
      personalNamespaceValidator:id=>personal.isPersonalNamespace(id)});
    async function seed(label,balance){
      const user=await User.create({});
      const identity=await LoginIdentity.create({userId:user._id,provider:'SUPABASE',issuer:'https://test.invalid/auth/v1',subject:label});
      const account=await TradingAccount.create({tenantId:tenant._id,userId:user._id,externalRef:label,accountCode:label,
        accountType:'DEMO',riskDayKey:'2026-01-01',state:{initialBalance:balance,balance,equity:balance,freeMargin:balance,dailyStartEquity:balance,floatingPnl:'0',realizedPnlToday:'0',usedMargin:'0'},
        metadata:{product:DEMO_PRODUCT,ownership:INTERNAL_OWNER}});
      await AccountAccessGrant.create({tenantId:tenant._id,userId:user._id,accountId:account._id,
        source:'PERSONAL',permissions:['VIEW','TRADE']});
      const session=await auth.createPersonalDemoSession({tenantId:tid,userId:String(user._id),loginIdentityId:String(identity._id)});
      // Seed persisted positions/order fixtures through model APIs, no trade execution.
      const order=await Order.create({tenantId:tenant._id,accountId:account._id,clientOrderId:'fixture',
        symbol:'XAUUSD',side:'BUY',type:'LIMIT',status:'PENDING',requestedVolume:'1',limitPrice:'100',stopLoss:'90'});
      await Position.create({tenantId:tenant._id,accountId:account._id,sourceOrderId:order._id,symbol:'XAUUSD',side:'BUY',
        initialVolume:'1',openVolume:'1',entryPrice:'100',contractSize:'100',volumeStep:'0.01',quoteCurrency:'USD'});
      return {user,identity,account,id:String(account._id),session};
    }
    const a=await seed('A','10000'),b=await seed('B','90000');
    await assert.rejects(auth.createPersonalDemoSession({tenantId:fid,userId:String(a.user._id),loginIdentityId:String(a.identity._id)}));
    const gs=createAiGovernanceStore();
    const governance=createAiGovernance({store:gs});
    const store=createAiReadStore();
    const gateway=createAiReadGateway({store,enabled:()=>true});
    const quotaStore=createAiQuotaStore();
    const quota=createAiQuota({store:quotaStore});
    // Two independent quota instances compete for the same persisted bucket.
    const fixedTime=Date.now();
    const q1=createAiQuota({store:quotaStore,limit:10,now:()=>fixedTime});
    const q2=createAiQuota({store:createAiQuotaStore(),limit:10,now:()=>fixedTime});
    const qp={tenantId:tid,userId:String(new mongoose.Types.ObjectId())};
    const outcomes=await Promise.allSettled(Array.from({length:40},(_,i)=>(i%2?q1:q2).consume(qp)));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,10);
    assert.ok(outcomes.filter(x=>x.status==='rejected').every(x=>x.reason.code==='AI_QUOTA_EXCEEDED'));
    console.log('PASS distributed quota 40 concurrent requests, exactly 10 accepted');
    // Exercise real HTTP handlers with real authentication, grants and Mongo stores.
    const app=express();
    app.use(['/read','/admin'],aiJsonBoundary());
    app.use('/read',createAiReadRouter({authService:auth,gateway,governance,quota}));
    app.use('/admin',createAiGovernanceRouter({authService:auth,store:gs}));
    server=app.listen(0,'127.0.0.1');
    await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    const root='http://127.0.0.1:'+server.address().port;
    async function send(path,token,body,method='POST',clientId){
      const res=await fetch(root+path,{method:body===undefined?'GET':method,
        headers:{authorization:'Bearer '+token,...(clientId?{'x-acg-client-id':clientId}:{}),'content-type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:res.status,body:await res.json()};
    }
    const ta=a.session.accessToken,tb=b.session.accessToken;
    const input={accountId:a.id,toolIds:['account.valuation.read','account.positions.read','account.orders.read']};
    assert.equal((await send('/read/grants',ta,input)).status,403);
    const admin=await auth.createServiceApiKey({tenantId:tid,clientId:'governance',scopes:['ai:governance:write','ai:governance:read','ai:audit:read']});
    const wild=await auth.createServiceApiKey({tenantId:tid,clientId:'wildcard',scopes:['*']});
    const patch={enabled:true,expectedRevision:0,reason:'PILOT_APPROVAL'};
    assert.equal((await send('/admin/control',wild.apiKey,patch,'PATCH',wild.clientId)).status,403);
    assert.equal((await send('/admin/control',admin.apiKey,{...patch,tenantId:fid},'PATCH',admin.clientId)).status,400);
    assert.equal((await send('/admin/control',admin.apiKey,patch,'PATCH',admin.clientId)).status,200);
    assert.equal((await gs.control(fid)).enabled,false);
    assert.equal((await send('/read/grants',tb,input)).status,403);
    const grants=await Promise.all([send('/read/grants',ta,input),send('/read/grants',ta,input)]);
    assert.deepEqual(grants.map(x=>x.status).sort(),[201,409]);
    const grant=grants.find(x=>x.status===201).body.grant;
    const req={accountId:a.id,connectionId:grant.connectionId,toolId:'account.valuation.read',args:{}};
    assert.equal((await send('/read/invoke','invalid-test-token',req)).status,401);
    const val=await send('/read/invoke',ta,req);
    assert.equal(val.status,200);assert.equal(val.body.result.balance,'10000');assert.equal(val.body.result.live,false);
    for(const [toolId,key] of [['account.positions.read','positions'],['account.orders.read','orders']]){
      const result=await send('/read/invoke',ta,{...req,toolId});
      assert.equal(result.status,200);assert.equal(result.body.result[key].length,1);
      assert.equal(result.body.result[key][0].symbol,'XAUUSD');
    }
    assert.equal((await send('/read/invoke',tb,req)).status,403);
    assert.equal((await send('/read/invoke',ta,{...req,accountId:b.id})).status,403);
    assert.equal((await send('/read/invoke',ta,{...req,toolId:'trade.execute'})).status,403);
    assert.equal((await send('/read/invoke',ta,{...req,args:{$where:'forbidden'}})).status,400);
    console.log('PASS real auth, account isolation, concurrent grants, projected reads, financial denial and injection rejection');
    // Phase 2 synthetic entitlement + real database source; no public runtime registration.
    const {runPhase2Integration}=require('./ai-phase2-integration');
    const assertPhase2Denied=await runPhase2Integration({auth,gateway,gs,token:ta,readRequest:req,foreignToken:tb});
    const {runPhase3VaultIntegration}=require('./ai-phase3-vault-integration');
    await runPhase3VaultIntegration({auth,token:ta,foreignToken:tb});
    const {runPhase3CreditIntegration}=require('./ai-phase3-credit-integration');
    await runPhase3CreditIntegration({auth,token:ta,foreignToken:tb,accountId:a.id,foreignAccountId:b.id});
    const {runPhase3PurchaseIntegration}=require('./ai-phase3-purchase-integration');
    await runPhase3PurchaseIntegration({auth,token:ta,foreignToken:tb,accountId:a.id,foreignAccountId:b.id});
    // Verify transactional governance compare-and-swap and rollback.
    const race=await Promise.allSettled([0,1].map(()=>gs.updateControl({tenantId:tid,actorId:'fixture',expectedRevision:1,enabled:false,reason:'INCIDENT_RESPONSE'})));
    assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(race.find(x=>x.status==='rejected').reason.code,'AI_CONTROL_CONFLICT');
    assert.equal((await gs.control(tid)).revision,2);
    await assertPhase2Denied('PAUSED');
    await assert.rejects(gs.updateControl({tenantId:tid,actorId:'fixture',expectedRevision:2,enabled:true,reason:'x'.repeat(65)}));
    assert.deepEqual(await gs.control(tid).then(c=>({enabled:c.enabled,revision:c.revision})),{enabled:false,revision:2});
    assert.equal((await send('/read/invoke',ta,req)).status,403);
    assert.equal((await send('/read/grants/revoke',ta,{accountId:a.id,connectionId:grant.connectionId})).body.revoked,true);
    await gs.updateControl({tenantId:tid,actorId:'fixture',expectedRevision:2,enabled:true,reason:'PILOT_APPROVAL'});
    assert.equal((await send('/read/invoke',ta,req)).status,403);
    await assertPhase2Denied('REVOKED');
    console.log('PASS Phase 2 actual governance suspension/revision and grant revocation boundary');
    console.log('PASS control CAS, rollback, suspension, revocation and resume cannot restore revoked grant');
    // A current account grant is independently required, even if a session exists.
    const gb=await send('/read/grants',tb,{accountId:b.id,toolIds:['account.valuation.read']});
    assert.equal(gb.status,201);
    await AccountAccessGrant.updateOne({accountId:b.account._id,userId:b.user._id},{$set:{status:'REVOKED',revokedAt:new Date()}});
    assert.equal((await send('/read/invoke',tb,{...req,accountId:b.id,connectionId:gb.body.grant.connectionId})).status,403);
    // Revocation of the normal authenticated session must also deny AI access.
    await TraderSession.updateOne({_id:b.session.session.id},{$set:{revokedAt:new Date()}});
    assert.equal((await send('/read/invoke',tb,{...req,accountId:b.id,connectionId:gb.body.grant.connectionId})).status,401);
    const audit=await send('/admin/audit?limit=100',admin.apiKey,undefined,'GET',admin.clientId);
    assert.equal(audit.status,200);
    assert.ok(audit.body.events.some(e=>e.stage==='DENIED'&&e.reason==='AI_FINANCIAL_BOUNDARY_DENIED'));
    assert.ok(audit.body.events.every(e=>e.tenantId===tid));
    assert.doesNotMatch(JSON.stringify(audit.body),/acg_ts_|acg_sk_/);
    for (const e of audit.body.events) for (const field of ['balance','equity','args','result','token','prompt']) assert.equal(Object.hasOwn(e,field),false);
    const event=await AiAuditEvent.findOne({tenantId:tid}).lean();
    await assert.rejects(AiAuditEvent.updateOne({_id:event._id},{$set:{reason:'modified'}}),/append-only/);
    await assert.rejects(AiAuditEvent.deleteOne({_id:event._id}),/append-only/);
    assert.equal(await Order.countDocuments({}),2);assert.equal(await Position.countDocuments({}),2);
    assert.equal(String((await TradingAccount.findById(a.id)).state.balance),'10000');
    assert.equal(String((await TradingAccount.findById(b.id)).state.balance),'90000');
    console.log('PASS current account revocation, scoped minimal audit, application immutability and no financial mutations');
  } finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(mongoose.connection.readyState===1 && mongoose.connection.name===dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
