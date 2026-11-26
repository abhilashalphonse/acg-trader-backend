'use strict';
// Dedicated loopback replica-set acceptance; no supplied connection URI.
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const {randomBytes,randomUUID}=require('node:crypto');
const {fork}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const {createIsolatedCreditStore,assertIsolated}=require('../src/modules/ai/providers/credit-ledger-store');
const {createIsolatedCreditLedger}=require('../src/modules/ai/providers/credit-ledger');
const {AiCreditWallet,AiCreditReservation,AiCreditJournal}=require('../src/modules/ai/providers/credit-ledger.model');
const {createModelRegistry}=require('../src/modules/ai/providers/model-registry');
const {createOfflineRequest}=require('../src/modules/ai/providers/provider-contract');
const {createPricingRegistry}=require('../src/modules/ai/providers/compute-pricing');
const {compilePromptPackage}=require('../src/modules/ai/intelligence/prompt-compiler');
const initial=Date.UTC(2026,0,1);
const scope=Object.freeze({tenantId:'a'.repeat(24),actorId:'b'.repeat(24),sessionId:'c'.repeat(24),accountId:'d'.repeat(24)});
const selection={providerId:'openai',modelId:'fixture-acceptance-v1',fundingMode:'ACG_CREDITS'};
const usage={status:'PROVIDER_REPORTED',inputTokens:20,outputTokens:10,totalTokens:30,cachedInputTokens:null,reasoningOutputTokens:null};
function guard(){assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.ACG_AI_ISOLATED_CI,'true');}
async function connect(db){
  guard();assert.match(db,/^acg_ai_ci_[a-f0-9]{24}$/);
  await mongoose.connect('mongodb://127.0.0.1:27017/'+db+'?replicaSet=rs0',
    {autoIndex:false,serverSelectionTimeoutMS:5000,maxPoolSize:20});
  assertIsolated();
  assert.equal((await mongoose.connection.db.admin().command({hello:1})).setName,'rs0');
}
function ledger(now,store=createIsolatedCreditStore()){
  return createIsolatedCreditLedger({store,now,authorize:async r=>Object.keys(scope).every(k=>r.scope[k]===scope[k])});
}
function factory(now){
  const registry=createModelRegistry({allowSynthetic:true,descriptors:[{
    providerId:selection.providerId,modelId:selection.modelId,revision:'fixture-1',reviewStatus:'SYNTHETIC_TEST_ONLY',
    fundingModes:['ACG_CREDITS'],capabilities:{input:'TEXT',responseMode:'JSON_OBJECT',separateInstructionChannel:true,
      streaming:false,usageReporting:'PROVIDER_REPORTED',maxContextTokens:8192,maxOutputTokens:2048}}]});
  const model=registry.resolveForOfflineTest(selection);
  const pricing=createPricingRegistry({allowSynthetic:true,prices:[{providerId:model.providerId,modelId:model.modelId,
    descriptorId:model.descriptorId,revision:'fixture-price',effectiveFromMs:initial-1,effectiveUntilMs:null,
    currency:'USD',rateUnit:'MICRO_USD_PER_MILLION_TOKENS',reviewStatus:'SYNTHETIC_TEST_ONLY',
    source:'OFFLINE_FIXTURE',additionalFees:'NONE_SYNTHETIC',input:{standard:'1000000',cacheRead:null,
      cacheWriteMode:'NONE',cacheWrite:null,cacheWrite5m:null,cacheWrite1h:null},output:{standard:'2000000',reasoning:null}}]});
  return ()=>{const at=now(),q=createOfflineRequest({registry,selection,
    prompt:compilePromptPackage({scope,profile:'EDUCATION',question:'Isolated acceptance fixture',nowMs:at}),
    inputTokenUpperBound:100,maxOutputTokens:50,nowMs:at});
    return {q,price:pricing.pin(q,at),key:randomUUID()};};
}
async function child(){
  guard();const [db,key]=process.argv.slice(3);assert.match(key,/^[0-9a-f-]{36}$/);
  await connect(db);const claim=await ledger(()=>initial).claimDispatch(scope,key);
  assert.equal(claim.dispatchAllowed,true);
  // IPC sends only fixture attempt ID after committed claim. Parent SIGKILLs
  // this worker; no provider is called, and no outcome is recorded.
  process.send({attemptId:claim.attemptId});
  setInterval(()=>{},1000);
}
async function crashAfterClaim(db,key){
  const worker=fork(__filename,['claim-child',db,key],{stdio:['ignore','ignore','ignore','ipc']});
  try{
    const msg=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('claim worker deadline')),15000);
      worker.once('message',m=>{clearTimeout(timer);resolve(m);});
      worker.once('error',e=>{clearTimeout(timer);reject(e);});
      worker.once('exit',()=>{clearTimeout(timer);reject(Error('claim worker exited before acknowledgement'));});
    });
    assert.match(msg.attemptId,/^[0-9a-f-]{36}$/);
    const exit=new Promise(resolve=>worker.once('exit',(code,signal)=>resolve({code,signal})));
    assert.equal(worker.kill('SIGKILL'),true);
    assert.equal((await exit).signal,'SIGKILL');
    return msg.attemptId;
  }finally{if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');}
}
function stats(values){const a=[...values].sort((x,y)=>x-y);return {count:a.length,p50Ms:a[Math.floor((a.length-1)*0.5)],
  p95Ms:a[Math.ceil(a.length*0.95)-1],maxMs:a.at(-1)};}
async function main(){
  guard();const db='acg_ai_ci_'+randomBytes(12).toString('hex');
  let clock=initial;const now=()=>clock,make=factory(now);
  try{
    await connect(db);const store=createIsolatedCreditStore();await store.provision();
    const l=ledger(now,store);await l.fixtureCredit(scope,randomUUID(),'1600000000');
    // 16 competing requests, exactly eight holds affordable. No retry on
    // insufficient balance, no overspending despite separate service objects.
    const requests=Array.from({length:16},make),latencies=[],started=performance.now();
    const reservations=await Promise.allSettled(requests.map(async x=>{
      const t=performance.now();try{return await ledger(now).reserve(scope,x.key,x.q,x.price);}
      finally{latencies.push(performance.now()-t);}
    }));
    const winners=requests.filter((_,i)=>reservations[i].status==='fulfilled');
    assert.equal(winners.length,8);
    assert.ok(reservations.filter(x=>x.status==='rejected').every(x=>x.reason.code==='CREDIT_INSUFFICIENT'));
    let w=await l.balance(scope);assert.deepEqual([w.available,w.reserved,w.spent],['0','1600000000','0']);
    const reservationWallMs=performance.now()-started;
    const target=winners.pop();
    const claims=await Promise.all(winners.map(async x=>{
      const a=await Promise.all([ledger(now).claimDispatch(scope,x.key),ledger(now).claimDispatch(scope,x.key)]);
      assert.equal(a.filter(v=>v.dispatchAllowed).length,1);return a.find(v=>v.dispatchAllowed).attemptId;
    }));
    const settleStart=performance.now(),settleTimes=[];
    await Promise.all(winners.map(async(x,i)=>{
      const at=performance.now(),outcome={attemptId:claims[i],requestId:x.q.requestId,status:'COMPLETED',usage};
      const v=await Promise.all([ledger(now).recordOutcome(scope,x.key,outcome),ledger(now).recordOutcome(scope,x.key,outcome)]);
      assert.ok(v.every(e=>e.status==='SETTLED'&&e.charged==='40000000'));settleTimes.push(performance.now()-at);
    }));
    const settleWallMs=performance.now()-settleStart;
    w=await l.balance(scope);assert.deepEqual([w.available,w.reserved,w.spent],['1120000000','200000000','280000000']);
    const attempt=await crashAfterClaim(db,target.key);
    // Disconnect and reconnect the actual client (not a server outage).
    // Any operations while disconnected must fail closed, no local balance.
    await mongoose.disconnect();
    await assert.rejects(l.balance(scope),{code:'CREDIT_LEDGER_DISABLED'});
    await connect(db);const recovered=ledger(now);
    assert.equal((await recovered.claimDispatch(scope,target.key)).dispatchAllowed,false);
    clock+=10000;
    assert.equal((await recovered.recoverExpired(scope,target.key)).status,'RECONCILIATION_REQUIRED');
    assert.equal((await recovered.balance(scope)).reserved,'200000000');
    await assert.rejects(recovered.releaseBeforeDispatch(scope,target.key),{code:'CREDIT_STATE_INVALID'});
    const final={attemptId:attempt,requestId:target.q.requestId,status:'COMPLETED',usage};
    // Simulate lost acknowledgement AFTER actual majority commit; never reapply debit.
    const committed=await recovered.recordOutcome(scope,target.key,final);
    assert.equal(committed.status,'SETTLED');
    const replay=await ledger(now).recordOutcome(scope,target.key,final);
    assert.deepEqual(replay,committed);
    w=await recovered.balance(scope);
    assert.deepEqual([w.available,w.reserved,w.spent,w.credited],['1280000000','0','320000000','1600000000']);
    const wallet=await AiCreditWallet.findOne({tenantId:scope.tenantId,actorId:scope.actorId}).lean();
    const rows=await AiCreditJournal.find({walletId:wallet._id}).sort({revision:1}).lean();
    const rs=await AiCreditReservation.find({tenantId:scope.tenantId,actorId:scope.actorId}).lean();
    // Replay deltas independently, not just validate a persisted equality.
    let available=0n,reserved=0n,spent=0n,credited=0n;
    const holds=new Map(),attempted=new Set();
    for(const [i,e] of rows.entries()){
      assert.equal(e.revision,i+1);const amount=BigInt(e.amount);
      if(e.operation==='FIXTURE_CREDIT'){available+=amount;credited+=amount;}
      else if(e.operation==='RESERVE'){assert.ok(!holds.has(e.reservationId));holds.set(e.reservationId,amount);available-=amount;reserved+=amount;}
      else if(e.operation==='DISPATCH'){assert.ok(holds.has(e.reservationId)&&!attempted.has(e.reservationId));attempted.add(e.reservationId);}
      else if(e.operation==='HOLD'){assert.ok(attempted.has(e.reservationId)&&holds.has(e.reservationId));}
      else if(e.operation==='SETTLE'){const hold=holds.get(e.reservationId);assert.ok(attempted.has(e.reservationId)&&hold>=amount);
        reserved-=hold;available+=hold-amount;spent+=amount;holds.delete(e.reservationId);}
      else assert.fail('Unexpected journal operation');
      assert.ok(available>=0n&&reserved>=0n&&spent>=0n);
      assert.deepEqual([available,reserved,spent,credited].map(String),[e.available,e.reserved,e.spent,e.credited]);
    }
    assert.equal(rows.length,w.revision);assert.equal(holds.size,0);
    assert.equal(rs.length,8);assert.ok(rs.every(x=>x.status==='SETTLED'));
    assert.equal(rs.reduce((v,x)=>v+BigInt(x.charged),0n),spent);
    assert.deepEqual([available,reserved,spent,credited].map(String),[w.available,w.reserved,w.spent,w.credited]);
    console.log('PHASE3J_FINANCIAL_PASS '+JSON.stringify({contenders:16,admitted:8,denied:8,dispatchClaims:8,settlements:8,
      duplicateClaimsPrevented:8,settlementReplays:8,processSigkill:true,clientDisconnectReconnect:true,
      journalRows:rows.length,reservationWallMs,settleWallMs,reservationLatency:stats(latencies),settlementPairLatency:stats(settleTimes)}));
  }finally{
    if(mongoose.connection.readyState===1&&mongoose.connection.name===db)await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}
(process.argv[2]==='claim-child'?child():main()).catch(e=>{console.error(e);process.exitCode=1;if(process.send)process.disconnect();});
