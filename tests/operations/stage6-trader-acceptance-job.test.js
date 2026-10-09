'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {TARGET,assertEnvironment,assertNseTradingHours,validateAccount}=require('../../scripts/stage6-trader-acceptance-job');

const env={
  RAILWAY_PROJECT_ID:TARGET.project,
  RAILWAY_ENVIRONMENT_ID:TARGET.environment,
  RAILWAY_SERVICE_ID:TARGET.service,
  RAILWAY_ENVIRONMENT_NAME:'STAGING',
  STAGE6_JOB_CONFIRM:TARGET.confirm,
  STAGE6_JOB_ID:TARGET.runId,
  INDIA_EXECUTION_PILOT_CONFIRM:'RELIANCE-STAGING-ONLY',
  INDIA_EXECUTION_PILOT_ENVIRONMENT:'staging',
  INDIA_EXECUTION_PILOT_ALLOWED:'true',
  ACCEPTANCE_TRADER_BASE_URL:TARGET.origin,
};
test('Stage 6 Railway acceptance operator refuses production, unknown project and unacknowledged run',()=>{
 assert.equal(assertEnvironment(env),true);
 for(const patch of [
  {RAILWAY_ENVIRONMENT_NAME:'production'},
  {RAILWAY_PROJECT_ID:'other'},
  {RAILWAY_ENVIRONMENT_ID:'other'},
  {RAILWAY_SERVICE_ID:'other'},
  {STAGE6_JOB_CONFIRM:''},
  {STAGE6_JOB_ID:'other'},
  {INDIA_EXECUTION_PILOT_ALLOWED:'false'},
  {INDIA_EXECUTION_PILOT_ENVIRONMENT:'production'},
  {ACCEPTANCE_TRADER_BASE_URL:'https://acg-trader-backend-production.up.railway.app'},
 ])assert.throws(()=>assertEnvironment({...env,...patch}),/Stage6/);
});

test('Stage 6 only operates on allowed NSE session time, never weekends or official NSE holidays',()=>{
 assert.equal(assertNseTradingHours(new Date('2026-10-12T05:30:00Z')),'2026-10-12');
 assert.throws(()=>assertNseTradingHours(new Date('2026-10-10T05:30:00Z')),/NSE open/);
 assert.throws(()=>assertNseTradingHours(new Date('2026-10-20T05:30:00Z')),/NSE open/);
 assert.throws(()=>assertNseTradingHours(new Date('2026-10-12T02:00:00Z')),/NSE open/);
 assert.throws(()=>assertNseTradingHours(new Date('2026-10-12T10:00:00Z')),/NSE open/);
});

test('Stage 6 account cannot be real customer, blocked, changed or non-USD',()=>{
 const obj={
  _id:TARGET.accountId,ownerExternalRef:TARGET.owner,
  externalRef:TARGET.challenge,currency:'USD',
  accountType:'CHALLENGE',status:'ACTIVE',tradingEnabled:true,federationEnabled:true,
 };
 assert.equal(validateAccount(obj),true);
 for(const patch of [
  {ownerExternalRef:'CUS-A-CUSTOMER'}, {_id:'507f1f77bcf86cd799439011'},
  {externalRef:'CHALLENGE-REAL'}, {status:'DISABLED'}, {tradingEnabled:false},
  {currency:'INR'},{federationEnabled:false},{accountType:'FUNDED'},
 ])assert.throws(()=>validateAccount({...obj,...patch}),/dedicated ACTIVE USD staging fixture/);
});
