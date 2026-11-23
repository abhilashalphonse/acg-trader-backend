'use strict';
// Temporary Railway Stage 2 ONLY. Synthetic traffic; never a live market-feed test.
// Enabled only in the dedicated acg-trader-alerts-stage2-staging project.
// No trading commands, no notification provider, no public API.
const mongoose = require('mongoose');
const { DurableAlertStream } = require('../src/modules/alerts/alert-journal');
const { AlertShadowWorker } = require('../src/modules/alerts/alert-worker');
const { AlertRule, MarketBatch, AlertTrigger, AlertOutbox, AlertReplayGap,
  StreamCoverage } = require('../src/modules/alerts/alert-models');

const projectId = '98a016a8-668d-401f-896f-00f407c5c15d';
const shadowStream = 'shadow-synthetic:XAUUSD';
const uri = process.env.ACG_ALERTS_STAGE2_DB_URI || '';
const role = process.env.ACG_ALERTS_SHADOW_ROLE || '';
const requireIsolation = () => {
  if (process.env.RAILWAY_PROJECT_ID !== projectId ||
      process.env.ACG_ALERTS_STAGE2_PRIVATE_TEST !== 'true' ||
      !['capture','evaluator'].includes(role) ||
      !/^mongodb:\/\//.test(uri) ||
      !uri.includes('.railway.internal') ||
      !uri.includes('/acg_alerts_stage2_shadow?')) {
    throw new Error('Refusing shadow test: project, role, or isolated MongoDB URI mismatch');
  }
};
let running = true;
const stop = () => { running = false; };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
function log(type, extra = {}) {
  process.stdout.write(JSON.stringify({
    stamp: new Date().toISOString(), stage: 'alerts-stage2',
    role, type, ...extra,
  }) + '\n');
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve,ms)); }
function failSafe(condition,message) { if (!condition) throw new Error(message); }
async function seed() {
  const rules = [
    { type:'crosses', level:'100' },
    { type:'crosses_above', level:'100' },
    { type:'crosses_below', level:'100' },
    { type:'enters_range', lower:'99', upper:'101' },
    { type:'exits_range', lower:'99', upper:'101' },
  ];
  const now = new Date();
  for (let i=0;i<rules.length;i++) {
    await AlertRule.updateOne({
      tenantId:'railway-stage2-isolated', ownerId:'synthetic-shadow-user',
      streamId:shadowStream, version:1, 'condition.type':rules[i].type,
    }, { $setOnInsert: {
      tenantId:'railway-stage2-isolated', ownerId:'synthetic-shadow-user',
      streamId:shadowStream, version:1,
      symbol:'XAUUSD', feedId:'shadow-synthetic',
      effectiveFrom:now,
      status:'STARTING', condition:rules[i],
      frequency:'repeat', cooldownMs:0, priceSource:'bid',
      tickSize:'1', timeframe:null,
    } }, { upsert:true });
  }
}
async function capture() {
  await seed();
  const stream=new DurableAlertStream({streamId:shadowStream,
    ownerId:process.env.RAILWAY_REPLICA_ID || 'isolated-capture'});
  failSafe(await stream.start('SYNTHETIC_SHADOW_CAPTURE_START')===true,'Capture lease unavailable');
  await stream.flush();
  let tick=0, injectedFeed=false, injectedDb=false;
  const start=Date.now();
  while(running){
    const elapsed=Date.now()-start;
    if (!injectedFeed && elapsed>20000) {
      injectedFeed=true;
      log('feed_disconnect_injected');
      stream.interrupt('SYNTHETIC_FEED_DISCONNECTED');
      await sleep(1100);
      failSafe(await stream.restart('RECOVERED_SYNTHETIC_FEED')===true,'Feed restart unavailable');
      await stream.flush();
      log('feed_recovered', {generation:stream.generation});
    }
    if (!injectedDb && elapsed>42000){
      injectedDb=true;
      const original=stream.persist.bind(stream);
      stream.persist=async()=>{throw Error('INJECTED_SHADOW_MONGO_WRITE_FAILURE');};
      stream.accept({schemaVersion:1,kind:'quote',streamId:shadowStream,
        marketTimeMs:Date.now(),receivedAtMs:Date.now(),quality:'SYNTHETIC',
        prices:{bid:'98',ask:'99',last:'98'}});
      try{await stream.flush();}catch{log('db_failure_injected');}
      stream.persist=original;
      await sleep(700);
      failSafe(await stream.restart('RECOVERED_SYNTHETIC_DB')===true,'Database-failure recovery unavailable');
      await stream.flush();
      log('db_recovered', {generation:stream.generation});
    }
    // Repeated plateaus and multi-tick jumps across threshold 100.
    const phase=tick%12;
    const price=phase<3?98:phase<6?102:phase<9?99:101;
    const now=Date.now();
    stream.accept({
      schemaVersion:1,kind:'quote',streamId:shadowStream,
      marketTimeMs:now,receivedAtMs:now,quality:'SYNTHETIC',
      source:'shadow-generated-no-external-provider',
      prices:{bid:String(price),ask:String(price+1),last:String(price)},
    });
    tick++;
    if(tick%40===0) log('capture_metrics',{ticksGenerated:tick,
      eventsAccepted:stream.acceptedEvents,batchesAccepted:stream.acceptedBatches,
      pending:stream.buffer.length,generation:stream.generation,
      elapsedSeconds:Math.round(elapsed/1000)});
    await sleep(250);
  }
  await stream.stop();
  log('capture_exit',{ticksGenerated:tick,eventsAccepted:stream.acceptedEvents});
}
async function evaluate() {
  const worker=new AlertShadowWorker({logger:{
    error:(details,reason)=>log('evaluation_error',{reason,
      message:details?.err?.message || null}),
  }});
  const start=Date.now();
  let count=0;
  while(running){
    const state=await worker.pumpOnce({maxRules:50});
    count++;
    if(count%20===0){
      const [batch,coverage,rules,triggers,gaps,pending] = await Promise.all([
        MarketBatch.findOne({streamId:shadowStream}).sort({generation:-1,lastSequence:-1}).lean(),
        StreamCoverage.findById(shadowStream).lean(),
        AlertRule.find({streamId:shadowStream}).select('checkpoint runtime status').lean(),
        AlertTrigger.countDocuments({'evidence.streamId':shadowStream}),
        AlertReplayGap.countDocuments({streamId:shadowStream}),
        AlertOutbox.countDocuments({channel:'shadow'}),
      ]);
      const lagValues=rules.map(r=>r.runtime?.lastObservedMs).filter(Number.isFinite)
        .map(t=>Math.max(0,Date.now()-t));
      log('evaluator_metrics',{
        loops:count,elapsedSeconds:Math.round((Date.now()-start)/1000),
        ownsLease:state.ownsLease, advanced:state.advanced, conflicts:state.conflicts,
        latestGeneration:batch?.generation ?? null, latestBatchSequence:batch?.lastSequence ?? null,
        captureStatus:coverage?.status ?? null, rules:rules.length,
        latestCheckpoints:rules.map(r=>r.checkpoint?.sequence ?? null),
        triggerCount:triggers, shadowOutboxCount:pending, gapCount:gaps,
        maxObservedLagMs:lagValues.length?Math.max(...lagValues):null,
        minObservedLagMs:lagValues.length?Math.min(...lagValues):null,
      });
    }
    await sleep(500);
  }
  log('evaluator_exit',{loops:count});
}
async function main(){
  requireIsolation();
  await mongoose.connect(uri,{serverSelectionTimeoutMS:8000,maxPoolSize:5});
  const hello=await mongoose.connection.db.admin().command({hello:1});
  failSafe(hello.setName==='rs0' && hello.isWritablePrimary === true,
    'Not connected to expected writable isolated MongoDB replica set');
  const db=mongoose.connection.db.databaseName;
  failSafe(db==='acg_alerts_stage2_shadow','Unexpected isolated DB name: '+db);
  log('isolated_db_verified',{databaseName:db,replicaSet:hello.setName,
    self:hello.me ?? null,projectId:process.env.RAILWAY_PROJECT_ID});
  if(role==='capture') await capture(); else await evaluate();
  await mongoose.disconnect();
}
main().catch(error=>{log('fatal',{message:String(error.message||error)});process.exitCode=1;});
