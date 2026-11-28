'use strict';
// Dedicated child process for real Funded auth and live ledger acceptance.
// Fixed loopback replica set; never reads a deployed database URI.
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const {randomBytes}=require('node:crypto');
const {AuthService}=require('../src/modules/auth/auth.service');
const {Tenant}=require('../src/modules/tenancy/tenant.model');
const {TradingAccount}=require('../src/modules/accounts/trading-account.model');
const {TraderSession}=require('../src/modules/auth/trader-session.model');
const {FederationTicket}=require('../src/modules/auth/federation-ticket.model');
const {Position}=require('../src/modules/trading/position.model');
const {Order}=require('../src/modules/trading/order.model');
const {Instrument}=require('../src/modules/instruments/instrument.model');
const {Candle}=require('../src/modules/market-data/candle.model');
const {AiQuotaBucket}=require('../src/modules/ai/ai-quota-store');
const {models,LivePlatform,LiveAttempt}=require('../src/modules/ai/providers/live-admission.model');
const {assertIsolated}=require('../src/modules/ai/providers/credit-ledger-store');
const {runFundedPilotMountAcceptance}=require('./ai-funded-pilot-mount-acceptance');
async function main(){
  assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.ACG_AI_ISOLATED_CI,'true');
  const dbName='acg_ai_ci_'+randomBytes(12).toString('hex');
  mongoose.set('strictQuery',true);mongoose.set('sanitizeFilter',true);
  try{
    await mongoose.connect('mongodb://127.0.0.1:27017/'+dbName+'?replicaSet=rs0',{autoIndex:false,serverSelectionTimeoutMS:5000,maxPoolSize:20});
    assertIsolated();assert.equal(mongoose.connection.name,dbName);
    assert.equal((await mongoose.connection.db.admin().command({hello:1})).setName,'rs0');
    for(const m of [Tenant,TradingAccount,TraderSession,FederationTicket,Position,Order,Instrument,Candle,AiQuotaBucket,...models]){
      await m.createCollection();await m.createIndexes();
    }
    assert.equal(await LivePlatform.countDocuments({}),0);assert.equal(await LiveAttempt.countDocuments({}),0);
    const auth=new AuthService({});
    const tenant=await Tenant.create({name:'Foreign synthetic tenant',slug:'foreign-workspace-fixture',authModes:['FEDERATED']});
    const tenantId=String(tenant._id);
    const account=await TradingAccount.create({tenantId,ownerExternalRef:'foreign-owner',externalRef:'FOREIGN',accountCode:'FOREIGN',
      accountType:'CHALLENGE',riskDayKey:'2026-01-01',state:{initialBalance:'90000',balance:'90000',equity:'90000',freeMargin:'90000',dailyStartEquity:'90000'}});
    const ticket=await auth.createFederationTicket({tenantId,ownerExternalRef:'foreign-owner',accountIds:[String(account._id)],metadata:{fundedCustomerEmail:'foreign@example.test'}});
    const foreign=await auth.exchangeFederationTicket(ticket.ticket);
    console.log('PASS dedicated Funded fixture database and empty live ledger');
    await runFundedPilotMountAcceptance({auth,foreignToken:foreign.accessToken});
    const ledger=await LivePlatform.findById('platform').lean();
    assert.equal(ledger.outstandingRequests,0);assert.equal(ledger.outstandingPicoUsd,0);
    assert.equal(await LiveAttempt.countDocuments({state:'SETTLED'}),3);
    assert.equal(await LiveAttempt.countDocuments({}),3);
    console.log('PASS dedicated workspace acceptance: three settled requests, zero outstanding reservations');
  }finally{
    if(mongoose.connection.readyState===1&&mongoose.connection.name===dbName){assertIsolated();await mongoose.connection.dropDatabase();}
    await mongoose.disconnect();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
