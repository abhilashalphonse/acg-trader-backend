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
  test('per-alert sound survives create and edit without suppressing history',async()=>{
    const input={symbol:'BTCUSD',condition:{type:'crosses_above',level:'100'},soundEnabled:false};
    const created=await call('','POST',{...input,clientRequestId:crypto.randomUUID()});
    assert.equal(created.status,201);assert.equal(created.data.alert.soundEnabled,false);
    const id=created.data.alert.id;
    assert.equal((await models.AlertRule.findById(id).lean()).soundEnabled,false);
    const changed=await call('/'+id,'PUT',{...input,soundEnabled:true,version:1});
    assert.equal(changed.status,200);assert.equal(changed.data.alert.soundEnabled,true);
    assert.equal((await models.AlertRule.findById(id).lean()).soundEnabled,true);
    assert.equal((await call('/'+id,'DELETE',{version:2})).status,204);
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
  test('push failures retry independently and provider acceptance is not device delivery',async()=>{
    const webpush=require('web-push');const original=webpush.sendNotification;
    const priorPublic=process.env.ACG_ALERTS_VAPID_PUBLIC_KEY,priorPrivate=process.env.ACG_ALERTS_VAPID_PRIVATE_KEY;
    const keys=webpush.generateVAPIDKeys();process.env.ACG_ALERTS_VAPID_PUBLIC_KEY=keys.publicKey;process.env.ACG_ALERTS_VAPID_PRIVATE_KEY=keys.privateKey;
    const {dispatchPush}=require('../src/modules/alerts/alert-delivery');
    try{
      assert.equal((await call('/push','POST',{endpoint:'https://127.0.0.1/secret',keys:{p256dh:'x'.repeat(80),auth:'x'.repeat(24)}})).status,400);
      const event=await models.AlertTrigger.findOne({ownerId:'owner:alice'}).lean();
      await models.AlertSubscription.create({tenantId:'tenant-a',ownerId:'owner:alice',endpoint:'https://fcm.googleapis.com/fcm/send/test-only',keys:{p256dh:'test',auth:'test'}});
      const job=await models.AlertOutbox.create({triggerId:event._id,channel:'push',status:'PENDING'});
      webpush.sendNotification=async()=>{throw Object.assign(new Error('test'),{statusCode:503});};
      await dispatchPush();let saved=await models.AlertOutbox.findById(job._id).lean();assert.equal(saved.status,'PENDING');assert.equal(saved.attempt,1);
      await models.AlertOutbox.updateOne({_id:job._id},{$set:{nextAttemptAt:new Date(0)}});
      webpush.sendNotification=async()=>({statusCode:201});await dispatchPush();saved=await models.AlertOutbox.findById(job._id).lean();assert.equal(saved.status,'ACCEPTED');assert.equal(saved.attempt,2);
      // Accepted devices are not resent when another device needs a retry.
      await models.AlertSubscription.create({tenantId:'tenant-a',ownerId:'owner:alice',endpoint:'https://fcm.googleapis.com/fcm/send/second-device',keys:{p256dh:'test',auth:'test'}});
      await models.AlertOutbox.updateOne({_id:job._id},{$set:{status:'PENDING',attempt:0,nextAttemptAt:new Date(0),acceptedDevices:[]}});
      const sends={};let failSecond=true;
      webpush.sendNotification=async subscription=>{
        sends[subscription.endpoint]=(sends[subscription.endpoint]||0)+1;
        if(subscription.endpoint.endsWith('second-device')&&failSecond)throw Object.assign(new Error('transient'),{statusCode:503});
        return {statusCode:201};
      };
      await dispatchPush();saved=await models.AlertOutbox.findById(job._id).lean();
      assert.equal(saved.status,'PENDING');assert.equal(saved.acceptedDevices.length,1);
      failSecond=false;await models.AlertOutbox.updateOne({_id:job._id},{$set:{nextAttemptAt:new Date(0)}});
      await dispatchPush();saved=await models.AlertOutbox.findById(job._id).lean();
      assert.equal(saved.status,'ACCEPTED');assert.equal(saved.acceptedDevices.length,2);
      assert.equal(sends['https://fcm.googleapis.com/fcm/send/test-only'],1);
      assert.equal(sends['https://fcm.googleapis.com/fcm/send/second-device'],2);
      // A crashed fifth attempt must reach a terminal status after its claim expires.
      await models.AlertOutbox.updateOne({_id:job._id},{$set:{status:'CLAIMED',attempt:5,claimUntil:new Date(0)}});
      await dispatchPush();saved=await models.AlertOutbox.findById(job._id).lean();
      assert.equal(saved.status,'FAILED');assert.equal(saved.lastError,'DELIVERY_ATTEMPTS_EXHAUSTED');

    }finally{webpush.sendNotification=original;if(priorPublic===undefined)delete process.env.ACG_ALERTS_VAPID_PUBLIC_KEY;else process.env.ACG_ALERTS_VAPID_PUBLIC_KEY=priorPublic;if(priorPrivate===undefined)delete process.env.ACG_ALERTS_VAPID_PRIVATE_KEY;else process.env.ACG_ALERTS_VAPID_PRIVATE_KEY=priorPrivate;}
  });
}
