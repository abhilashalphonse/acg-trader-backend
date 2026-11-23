'use strict';
// Runs only in the named, isolated staging project. Local forwarding lets the
// existing localhost-only destructive test guards remain intact.
const net=require('net');
const {spawn}=require('child_process');
const mongoose=require('mongoose');
if(process.env.RAILWAY_PROJECT_ID!=='98a016a8-668d-401f-896f-00f407c5c15d')throw new Error('ISOLATED_ALERTS_PROJECT_REQUIRED');
const server=net.createServer(client=>{
  const upstream=net.connect(27017,'alerts-test-mongo.railway.internal');
  client.pipe(upstream).pipe(client);client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
});
const uri='mongodb://127.0.0.1:27017/alerts_isolated_acceptance?directConnection=true&replicaSet=alertsTest';
function run(file){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--test',file],{stdio:'inherit',env:{...process.env,
    ACG_ALERTS_STAGE2_E2E:'true',ACG_ALERTS_STAGE2_E2E_MONGO_URI:uri}});
  child.on('exit',code=>code===0?resolve():reject(new Error(file+' failed: '+code)));
});}
async function main(){
  await new Promise(resolve=>server.listen(27017,'127.0.0.1',resolve));
  await mongoose.connect(uri);const hello=await mongoose.connection.db.admin().command({hello:1});
  console.log(JSON.stringify({gate:'topology',setName:hello.setName,isWritablePrimary:hello.isWritablePrimary}));
  await mongoose.disconnect();
  const start=Date.now();
  await run('tests/alerts-stage2-integration.test.js');
  if(process.env.ACG_ALERTS_ACCEPTANCE_SKIP_KILLS!=='true')await run('tests/alerts-stage2-process-kill.test.js');
  await run('tests/alerts-live.test.js');
  console.log(JSON.stringify({gate:'RAILWAY_DATABASE_ACCEPTANCE_PASS',elapsedMs:Date.now()-start}));
  // A bounded load sample uses the actual journal/evaluator against staging.
  await mongoose.connect(uri);mongoose.set('sanitizeFilter',true);
  const models=require('../src/modules/alerts/alert-models');
  const {DurableAlertStream}=require('../src/modules/alerts/alert-journal');
  const {AlertShadowWorker}=require('../src/modules/alerts/alert-worker');
  for(const m of Object.values(models))await m.deleteMany({});
  const streamId='twelve-data:BTCUSD',stream=new DurableAlertStream({streamId});
  await models.AlertRule.create({tenantId:'isolated',ownerId:'sample',symbol:'BTCUSD',feedId:'twelve-data',streamId,
    tickSize:'0.01',priceSource:'last',condition:{type:'crosses',level:'100'},frequency:'repeat',status:'STARTING'});
  await stream.start();const worker=new AlertShadowWorker();let events=0,liveSamples=0,lastLiveTime=null;
  const begin=Date.now(),writeLatencies=[];
  for(let n=0;n<240;n++){
    const t=Date.now();for(let i=0;i<20;i++){stream.accept({schemaVersion:1,kind:'quote',streamId,marketTimeMs:Date.now(),receivedAtMs:Date.now(),quality:'SYNTHETIC_LOAD_TEST',prices:{last:i%2?'101':'99',bid:null,ask:null}});events++;}
    const w=Date.now();await stream.flush();writeLatencies.push(Date.now()-w);await worker.pumpOnce();
    if(n%10===0){
      try {const r=await fetch('https://acg-trader-backend-production.up.railway.app/v1/market/quotes?symbols=BTCUSD',{signal:AbortSignal.timeout(5000)});const data=await r.json();const q=data.quotes?.[0];
        if(q&&q.timeMs!==lastLiveTime){lastLiveTime=q.timeMs;liveSamples++;console.log(JSON.stringify({gate:'read_only_live_sample',symbol:q.symbol,marketTimeMs:q.timeMs,stale:q.isStale}));}
      }catch(error){console.log(JSON.stringify({gate:'live_sample_unavailable',reason:error.name}));}
    }
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,1000-(Date.now()-t))));
  }
  await stream.stop();for(let i=0;i<5;i++)await worker.pumpOnce();
  const stats=await mongoose.connection.db.command({dbStats:1});writeLatencies.sort((a,b)=>a-b);
  console.log(JSON.stringify({gate:'RAILWAY_LOAD_SAMPLE',durationMs:Date.now()-begin,events,liveSamples,
    journalWriteP95Ms:writeLatencies[Math.floor(writeLatencies.length*.95)],dataSize:stats.dataSize,storageSize:stats.storageSize,indexSize:stats.indexSize,
    triggers:await models.AlertTrigger.countDocuments({}),batches:await models.MarketBatch.countDocuments({}),workerBatches:worker.processedBatches}));
  await mongoose.disconnect();server.close();
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
