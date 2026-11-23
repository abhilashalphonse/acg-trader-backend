'use strict';
const crypto = require('crypto');
const webpush = require('web-push');
const { AlertOutbox, AlertTrigger, AlertRule, AlertSubscription } = require('./alert-models');

async function dispatchPush() {
  if (!process.env.ACG_ALERTS_VAPID_PRIVATE_KEY || !process.env.ACG_ALERTS_VAPID_PUBLIC_KEY) return;
  const now=new Date(), claimId=crypto.randomUUID();
  const job=await AlertOutbox.findOneAndUpdate({channel:'push',attempt:{$lt:5},$or:[
    {status:'PENDING',nextAttemptAt:{$lte:now}}, {status:'PENDING',nextAttemptAt:null},
    {status:'CLAIMED',claimUntil:{$lt:now}},
  ]},{$set:{status:'CLAIMED',claimId,claimUntil:new Date(Date.now()+60000)},$inc:{attempt:1}},{new:true});
  if(!job)return;
  let failure=null;
  try {
    const trigger=await AlertTrigger.findById(job.triggerId).lean();
    if(!trigger)throw new Error('EVENT_NOT_FOUND');
    const rule=await AlertRule.findOne({_id:trigger.alertId,tenantId:trigger.tenantId,ownerId:trigger.ownerId}).lean();
    const subscriptions=await AlertSubscription.find({tenantId:trigger.tenantId,ownerId:trigger.ownerId}).limit(10).lean();
    if(!subscriptions.length)throw new Error('NO_SUBSCRIBED_DEVICE');
    const evidence=trigger.evidence;
    const payload=JSON.stringify({eventId:String(trigger._id),title:evidence.name||`${evidence.symbol||rule?.symbol||'Market'} alert`,
      body:`${evidence.symbol||rule?.symbol||evidence.streamId} · ${evidence.condition.type.replaceAll('_',' ')} · ${evidence.observedPrice||''} · ${evidence.note||'Open the chart to review.'}`,
      symbol:evidence.symbol||rule?.symbol,timeframe:evidence.timeframe});
    for(const sub of subscriptions) {
      try { await webpush.sendNotification({endpoint:sub.endpoint,keys:sub.keys},payload,{
        TTL:300,timeout:8000,vapidDetails:{subject:process.env.ACG_ALERTS_VAPID_SUBJECT||'mailto:support@acgtrader.com',
          publicKey:process.env.ACG_ALERTS_VAPID_PUBLIC_KEY,privateKey:process.env.ACG_ALERTS_VAPID_PRIVATE_KEY},
      }); }
      catch(error){
        if([404,410].includes(error.statusCode))await AlertSubscription.deleteOne({_id:sub._id});
        else failure='PUSH_SERVICE_UNAVAILABLE';
      }
    }
  }catch(error){failure=error.message==='NO_SUBSCRIBED_DEVICE'?'NO_SUBSCRIBED_DEVICE':'PUSH_SERVICE_UNAVAILABLE';}
  const permanent=job.attempt>=5||failure==='NO_SUBSCRIBED_DEVICE';
  await AlertOutbox.updateOne({_id:job._id,claimId},{$set:{status:failure?(permanent?'FAILED':'PENDING'):'ACCEPTED',
    lastError:failure,nextAttemptAt:failure?new Date(Date.now()+Math.min(300000,10000*2**job.attempt)):null,claimUntil:null}});
}
module.exports={dispatchPush};
