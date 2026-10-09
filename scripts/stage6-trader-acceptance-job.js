'use strict';

// A one-shot acceptance operator living INSIDE the approved Trader staging
// deployment. No browser/admin bearer, production credentials, or public
// test-only authentication endpoint. Only the dedicated funded fixture is used.
const path = require('node:path');
const mongoose = require('mongoose');
const { spawnSync } = require('node:child_process');

const TARGET = Object.freeze({
  project: '2c77c657-8a52-4741-8e4e-44c936de5f92',
  environment: '3c1bfee9-5f5f-441a-b1fc-4915e1d5dc85',
  service: 'bed084ff-f2e8-438e-85f2-252c8c1cfba7',
  origin: 'https://discerning-presence-staging.up.railway.app',
  accountId: '6ac88a06a8bc1654797f2a73',
  owner: 'CUS-2026100906302932A1B6',
  challenge: 'ACG-ACC-06302932A1B6-A',
  confirm: 'STAGE6_RELIANCE_STAGING_ONE_SHOT',
  runId: 'stage6-reliance-20261012-v1',
});

function assertEnvironment(e=process.env) {
  const expected = [
    ['RAILWAY_PROJECT_ID',TARGET.project],
    ['RAILWAY_ENVIRONMENT_ID',TARGET.environment],
    ['RAILWAY_SERVICE_ID',TARGET.service],
    ['STAGE6_JOB_CONFIRM',TARGET.confirm],
    ['STAGE6_JOB_ID',TARGET.runId],
    ['INDIA_EXECUTION_PILOT_CONFIRM','RELIANCE-STAGING-ONLY'],
    ['INDIA_EXECUTION_PILOT_ENVIRONMENT','staging'],
    ['INDIA_EXECUTION_PILOT_ALLOWED','true'],
  ];
  for (const [key,value] of expected) if(String(e[key]||'').trim()!==value) {
    throw new Error('Stage6 staging job blocked: '+key+' differs from approved configuration');
  }
  if(String(e.RAILWAY_ENVIRONMENT_NAME||'').toUpperCase()!=='STAGING'){
    throw new Error('Stage6 job requires Railway STAGING');
  }
  if(String(e.ACCEPTANCE_TRADER_BASE_URL||TARGET.origin).replace(/\/+$/,'')!==TARGET.origin){
    throw new Error('Stage6 job cannot contact an unrecognized Trader host');
  }
  return true;
}

function assertNseTradingHours(now=new Date()){
  const dt = new Intl.DateTimeFormat('en-GB',{
    timeZone:'Asia/Kolkata', year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23',
  }).formatToParts(now);
  const get=k=>dt.find(x=>x.type===k)?.value;
  const day=get('weekday');
  const date=get('year')+'-'+get('month')+'-'+get('day');
  const minute=Number(get('hour'))*60+Number(get('minute'));
  const holidays=require('../src/modules/instruments/india-pilot-catalog').NSE_EQUITY_HOLIDAYS_2026;
  if(day==='Sat'||day==='Sun'||holidays.includes(date)||minute<585||minute>840){
    throw new Error('Stage6 requires NSE open trading hours (09:45-14:00 IST, non-holiday)');
  }
  return date;
}

async function http(route,{method='GET',body,token}={}){
  const res=await fetch(TARGET.origin+route,{
    method,
    headers:{
      accept:'application/json',
      ...(token?{authorization:'Bearer '+token}:{}),
      ...(body?{'content-type':'application/json'}:{}),
    },
    ...(body?{body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(15000),
    redirect:'error',
  });
  if(!res.ok)throw new Error('Trader API '+method+' '+route+' HTTP '+res.status);
  return res.json();
}

function validateAccount(account){
  if(!account||String(account._id)!==TARGET.accountId
    ||String(account.ownerExternalRef)!==TARGET.owner
    ||String(account.externalRef)!==TARGET.challenge
    ||String(account.currency).toUpperCase()!=='USD'
    ||String(account.accountType)!=='CHALLENGE'
    ||String(account.status)!=='ACTIVE'
    ||account.tradingEnabled!==true
    ||account.federationEnabled===false){
    throw new Error('Stage6 account is not the dedicated ACTIVE USD staging fixture');
  }
  return true;
}

async function run(){
  assertEnvironment();
  assertNseTradingHours();
  const {connectDatabase,disconnectDatabase}=require('../src/config/database');
  const {TradingAccount}=require('../src/modules/accounts/trading-account.model');
  const {createAuthRuntime}=require('../src/modules/auth/auth.runtime');
  const {setPilotExecution}=require('./india-pilot-execution');
  const {deriveStopFromPreview}=require('./acceptance-global-markets-bootstrap');
  let claimed=false;
  let pilotEnabled=false;
  let result={status:'BLOCKED',runId:TARGET.runId,accountId:TARGET.accountId};
  let failure=null;
  await connectDatabase();
  try{
    const account=await TradingAccount.findById(TARGET.accountId).lean();
    validateAccount(account);

    // Check both endpoints and valuation BEFORE enabling any instrument.
    const ready=await http('/health/ready');
    if(ready?.ready===false||ready?.status==='not_ready')throw new Error('Trader readiness failed');
    const before=await http('/v1/instruments/RELIANCE');
    if(before?.instrument?.sessionOpen!==true)throw new Error('RELIANCE NSE session closed');

    const journal=mongoose.connection.db.collection('stage6FinancialAcceptanceJobs');
    const claim=await journal.updateOne({_id:TARGET.runId},
      {$setOnInsert:{state:'CLAIMED',createdAt:new Date(),accountId:TARGET.accountId}},
      {upsert:true});
    if(claim.upsertedCount!==1)throw new Error('Stage6 job already claimed, never replay automatically');
    claimed=true;
    await journal.updateOne({_id:TARGET.runId},{$set:{state:'PREFLIGHT'}});

    const auth=createAuthRuntime().authService;
    const issued=await auth.createFederationTicket({
      tenantId:String(account.tenantId),
      ownerExternalRef:TARGET.owner,
      ownerExternalRefs:[TARGET.owner],
      accountIds:[TARGET.accountId],
      selectedAccountId:TARGET.accountId,
      metadata:{stage6:true,fixtureOnly:true},
    });
    const session=await auth.exchangeFederationTicket(issued.ticket);
    const token=String(session?.accessToken||'');
    if(!token)throw new Error('No staging acceptance session token issued');

    const granted=await http('/v1/auth/accounts',{token});
    if(!(granted.accounts||[]).some(a=>String(a.id||a._id||a.accountId)===TARGET.accountId)){
      throw new Error('Stage6 session lacks acceptance account grant');
    }
    const valuation=await http('/v1/trading/accounts/'+TARGET.accountId+'/valuation',{token});
    if(valuation?.complete!==true||Number(valuation.positionCount)!==0||
      Number(valuation.usedMargin||0)!==0){
      throw new Error('Stage6 account is not financially flat');
    }

    // Mark activation attempted before the write, so even a partial error is
    // followed by an explicit disable attempt.
    pilotEnabled=true;
    const on=await setPilotExecution('enable');
    if(on.executionEnabled!==true)throw new Error('RELIANCE staging pilot activation failed');
    const live=await http('/v1/instruments/RELIANCE');
    if(live.instrument?.executionEnabled!==true||
       live.instrument?.sessionOpen!==true||
       String(live.instrument?.quoteCurrency)!=='INR'||
       Number(live.instrument?.defaultLeverage)!==10||
       live.instrument?.corporateActionPolicy!=='UNSUPPORTED'){
      throw new Error('RELIANCE pilot instrument gates failed');
    }

    const quote=await http('/v1/trading/orders/market/preview',{
      token,method:'POST',body:{
        accountId:TARGET.accountId,symbol:'RELIANCE',side:'BUY',
        sizingMode:'QUANTITY',volume:'0.001',source:'API',
      },
    });
    const stop=deriveStopFromPreview(quote,live.instrument.tickSize||'0.01','2');
    await journal.updateOne({_id:TARGET.runId},{$set:{
      state:'EXECUTING',quoteSource:stop.quoteSource,
      quoteTimestamp:new Date(stop.quoteReceivedAtMs),stopLoss:stop.stopLoss,
      executedAt:new Date(),
    }});
    const child=spawnSync(process.execPath,[path.join(__dirname,'acceptance-global-markets-final.js')],{
      env:{
        ...process.env,
        ACCEPTANCE_TARGET_ENVIRONMENT:'staging',
        ACCEPTANCE_TRADER_BASE_URL:TARGET.origin,
        ACCEPTANCE_ALLOW_MUTATIONS:'GLOBAL_MARKETS_RELIANCE_STAGING_ONLY',
        ACCEPTANCE_ACCOUNT_ID:TARGET.accountId,
        ACCEPTANCE_TRADER_BEARER:token,
        ACCEPTANCE_RELIANCE_STOP_LOSS:stop.stopLoss,
      },
      encoding:'utf8',timeout:210000,maxBuffer:10*1024*1024,
    });
    if(child.error||child.status!==0){
      throw new Error('Stage6 financial runner returned failure, status '+String(child.status));
    }
    let evidence;
    try {evidence=JSON.parse(child.stdout);}catch{
      throw new Error('Stage6 financial runner did not produce valid JSON evidence');
    }
    if(evidence?.status!=='PASS'||evidence?.accountId!==TARGET.accountId){
      throw new Error('Stage6 runner evidence lacks PASS for dedicated fixture');
    }
    result={status:'PASS',runId:TARGET.runId,accountId:TARGET.accountId,
      financialChecks:evidence.checks?.length||0,
      source:stop.quoteSource,quoteAt:new Date(stop.quoteReceivedAtMs).toISOString(),
      stopLoss:stop.stopLoss,evidence};
    await journal.updateOne({_id:TARGET.runId},
      {$set:{state:'FINANCIAL_PASS',financialEvidence:evidence,finishedAt:new Date()}});
  }catch(err){
    failure=err;
    result={status:'FAIL',runId:TARGET.runId,accountId:TARGET.accountId,
      errorCode:String(err?.code||err?.name||'ERROR').slice(0,100),
      message:String(err?.message||'error').slice(0,250)};
    if(claimed){
      await mongoose.connection.db.collection('stage6FinancialAcceptanceJobs')
        .updateOne({_id:TARGET.runId},{$set:{state:'FAILED',error:result,failedAt:new Date()}})
        .catch(()=>{});
    }
  }finally{
    // Fail closed after the attempt, even if the financial test failed.
    if(pilotEnabled){
      try{
        const off=await setPilotExecution('disable');
        if(off.executionEnabled!==false)throw new Error('Pilot still enabled');
        result.pilotDisabled=true;
      }catch(err){
        result.pilotDisabled=false;
        failure=failure||err;
      }
    }
    await disconnectDatabase();
  }
  // The evidence contains no auth token or secrets.
  console.log('STAGE6_JOB_RESULT '+JSON.stringify(result));
  if(failure)throw new Error('Stage6 acceptance failed; inspect the sanitized STAGE6_JOB_RESULT');
  return result;
}

if(require.main===module){
  run().catch(err=>{
    console.error('STAGE6_JOB_FAILED '+String(err.message||'error'));
    process.exitCode=1;
  });
}
module.exports={TARGET,assertEnvironment,assertNseTradingHours,validateAccount,run};
