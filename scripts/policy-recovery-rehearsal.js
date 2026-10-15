'use strict';
// Runs only against the disposable browser acceptance database; never production.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const uri = process.env.MONGODB_URI || '';
if (process.env.CI !== 'true' || process.env.PR72_E2E_DISPOSABLE !== '1'
 || !/^mongodb:\/\/127\.0\.0\.1:27017\/acg_pr72_browser_e2e(?:\?|$)/.test(uri)) throw Error('Disposable recovery guard required');
const { Tenant } = require('../src/modules/tenancy/tenant.model');
const { Position } = require('../src/modules/trading/position.model');
const { TradingAccount } = require('../src/modules/accounts/trading-account.model');
const { AccountControlService } = require('../src/modules/trading/account-control.service');
const policy = {FOREX:100,METAL:50,ENERGY:50,OTHER:50,INDEX:20,EQUITY:10,CRYPTO:2};
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let child;
async function snapshot() {
 const db=mongoose.connection.db;
 return {
  accounts: await db.collection('tradingaccounts').find({}, {projection:{_id:1,'state.balance':1,'state.usedMargin':1}}).sort({_id:1}).toArray(),
  positions: await db.collection('positions').find({}, {projection:{_id:1,margin:1,status:1,openVolume:1}}).sort({_id:1}).toArray(),
  ledgers: await db.collection('accountledgers').find({}).sort({_id:1}).toArray()
 };
}
async function stop() {
 if(!child || child.exitCode!==null) return;
 const p=child; p.kill('SIGTERM');
 for(let i=0;i<100 && p.exitCode===null;i++) await sleep(100);
 if(p.exitCode===null) {p.kill('SIGKILL'); throw Error('Recovery shutdown timed out');}
 assert.equal(p.exitCode,0,'Graceful shutdown failed');
 child=null;
}
async function boot(cwd, expected) {
 const log=fs.openSync(path.join(process.env.RUNNER_TEMP,'recovery-startup.log'),'a',0o600);
 child=spawn(process.execPath,['src/server.js'],{cwd,env:{...process.env,PORT:'4100',NODE_ENV:'test',PLATFORM_EVENTS_ENABLED:'false',RECONCILIATION_ENABLED:'false',WEEKEND_WORKER_ENABLED:'false',MARKET_CANDLE_LEGACY_CLEANUP_ENABLED:'false'},stdio:['ignore',log,log]});
 fs.closeSync(log);
 let ready=false;
 for(let i=0;i<90;i++) {
  if(child.exitCode!==null) throw Error('Recovery process exited before health check');
  try {if((await fetch('http://127.0.0.1:4100/health/live')).ok){ready=true;break;}} catch {}
  await sleep(1000);
 }
 assert.ok(ready,'Recovery health timeout');
 const specs=await mongoose.connection.db.collection('instruments').find({}).toArray();
 assert.ok(specs.length>=300,'Catalog missing');
 for(const spec of specs) assert.equal(spec.defaultLeverage,policy[spec.assetClass],'Recovery changed leverage policy');
 assert.deepEqual(await snapshot(),expected,'Recovery changed durable financial state');
 await stop();
}
async function main() {
 await mongoose.connect(uri);
 const tenant=await Tenant.create({name:'Recovery rehearsal',slug:'recovery-rehearsal'});
 const result=await new AccountControlService().provision({tenantId:String(tenant._id),externalRef:'recovery-legacy',ownerExternalRef:'recovery-owner',accountType:'DEMO',currency:'USD',initialBalance:'10000000',leverage:100,riskPolicy:{},tradingPermissionsVersion:1,tradingPermissions:{newsTrading:true,weekendHolding:true}});
 // Explicit synthetic pre-policy reservation: 0.01 BTC at 100, reserved at 100x.
 await Position.create({tenantId:tenant._id,accountId:result.account.id,sourceOrderId:new mongoose.Types.ObjectId(),symbol:'BTCUSD',side:'BUY',initialVolume:'0.01',openVolume:'0.01',entryPrice:'100',contractSize:'1',volumeStep:'0.01',quoteCurrency:'USD',margin:'0.01'});
 await TradingAccount.updateOne({_id:result.account.id},{$set:{'state.usedMargin':'0.01','state.freeMargin':'9999999.99'}});
 const expected=await snapshot();
 await boot(path.resolve(__dirname,'..'),expected);
 await boot(path.resolve(process.env.RECOVERY_CHECKOUT),expected);
 console.log('POLICY_PRESERVING_RECOVERY_PASS',JSON.stringify({recoverySha:process.env.RECOVERY_SHA,legacyMarginUnchanged:true,balancesUnchanged:true,ledgerUnchanged:true,startCommand:'node src/server.js',healthPath:'/health/live',isolated:true}));
}
main().catch(e=>{console.error('RECOVERY_REHEARSAL_FAILED',e.message);process.exitCode=1;}).finally(async()=>{try{await stop();}finally{await mongoose.disconnect();}});
