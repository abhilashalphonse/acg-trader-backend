'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('crypto');
const express=require('express');
const mongoose=require('mongoose');
const {createAlertRouter,definitionSchema}=require('../src/modules/alerts/alert.routes');
const models=require('../src/modules/alerts/alert-models');
const {AlertShadowWorker}=require('../src/modules/alerts/alert-worker');
const {DurableAlertStream}=require('../src/modules/alerts/alert-journal');
test('alert inputs reject ownership, arbitrary sources and malformed prices',()=>{
  const data={symbol:'BTCUSD',condition:{type:'crosses_above',level:'100'}};
  assert.equal(definitionSchema.safeParse(data).success,true);
  for(const patch of [{ownerId:'victim'},{priceSource:'mid'},{condition:{type:'crosses',level:'NaN'}},{pushEnabled:'true'}])assert.equal(definitionSchema.safeParse({...data,...patch}).success,false);
});
if(process.env.ACG_ALERTS_STAGE2_E2E!=='true')test('authenticated live alerts integration (isolated replica set)',{skip:true},()=>{});
else{
  let server,base;
  before(async()=>{
    const uri=process.env.ACG_ALERTS_STAGE2_E2E_MONGO_URI;
    if(!uri?.startsWith('mongodb://127.0.0.1:27017/'))throw new Error('LOCAL_ONLY');
    await mongoose.connect(uri);mongoose.set('sanitizeFilter',true);
    for(const m of Object.values(models)){await m.init();await m.deleteMany({});}
    const app=express();app.use(express.json());
    app.use('/alerts',createAlertRouter({authService:{authenticateSessionToken:async token=>{
      if(!['alice','bob','other-tenant'].includes(token))throw Object.assign(new Error('Unauthorised'),{statusCode:401});
      return {tenantId:token==='other-tenant'?'tenant-b':'tenant-a',ownerExternalRef:token==='other-tenant'?'alice':token};
    }},marketRuntime:{instrumentRegistry:{get:symbol=>symbol==='BTCUSD'?{provider:'twelve-data',chartEnabled:true,status:'ACTIVE',tickSize:0.01}:null},timeframes:['1m','15m']}}));
    app.use((err,_req,res,_next)=>res.status(err.statusCode||500).json({error:err.message}));
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port+'/alerts';
  });
  after(async()=>{await new Promise(r=>server.close(r));await mongoose.disconnect();});
  const call=async(path='',method='GET',body,token='alice')=>{
    const response=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:response.status===204?null:await response.json()};
  };
  test('owner and tenant isolation; versioned editing, pause, deletion and idempotent creation',async()=>{
    const body={symbol:'BTCUSD',condition:{type:'crosses_above',level:'100'},clientRequestId:crypto.randomUUID()};
    assert.equal((await call('','GET',undefined,'bad')).status,401);
    const created=await call('','POST',body);assert.equal(created.status,201);const id=created.data.alert.id;
    assert.equal((await call('','POST',body)).data.alert.id,id);
    assert.equal((await call('','GET',undefined,'bob')).data.alerts.length,0);
    assert.equal((await call('','GET',undefined,'other-tenant')).data.alerts.length,0);
    assert.equal((await call('/'+id,'DELETE',{version:1},'bob')).status,409);
    assert.equal((await call('/'+id+'/status','PATCH',{version:1,status:'PAUSED'})).status,200);
    assert.equal((await call('/'+id+'/status','PATCH',{version:1,status:'STARTING'})).status,409);
    assert.equal((await call('/'+id+'/status','PATCH',{version:2,status:'STARTING'})).status,200);
    assert.equal((await call('/'+id,'DELETE',{version:3})).status,204);
    assert.equal((await call()).data.alerts.length,0);
  });
  test('durable trigger reaches only owner history with terminal delivery and read acknowledgement',async()=>{
    const created=await call('','POST',{symbol:'BTCUSD',condition:{type:'crosses_above',level:'100'},clientRequestId:crypto.randomUUID()});
    const id=created.data.alert.id,streamId='twelve-data:BTCUSD';
    const stream=new DurableAlertStream({streamId});await stream.start();
    for(const value of [99,101])stream.accept({streamId,kind:'quote',schemaVersion:1,marketTimeMs:Date.now(),receivedAtMs:Date.now(),prices:{last:String(value)}});
    await stream.flush();const worker=new AlertShadowWorker({liveDelivery:true});await worker.acquireLease();await worker.processRule(await models.AlertRule.findById(id).lean());await stream.stop();
    const history=await call('/history');assert.equal(history.data.events.length,1);
    assert.equal((await call('/history','GET',undefined,'bob')).data.events.length,0);
    const eventId=history.data.events[0].id;
    assert.equal(await models.AlertOutbox.countDocuments({channel:'terminal',status:'DELIVERED'}),1);
    await call('/history/read','POST',{ids:[eventId]},'bob');assert.equal((await call('/history')).data.events[0].readAt,null);
    await call('/history/read','POST',{ids:[eventId]});assert.ok((await call('/history')).data.events[0].readAt);
  });
}
