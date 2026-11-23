'use strict';
const models=require('./alert-models');
const {AlertShadowWorker}=require('./alert-worker');
const {dispatchPush}=require('./alert-delivery');

async function startAlertRuntime({logger}) {
  // Create only the new alerts indexes. Never sync/drop indexes in production.
  for(const model of Object.values(models))await model.createIndexes();
  const worker=new AlertShadowWorker({logger,liveDelivery:true});
  let stopped=false, pending=null, deliveryPending=null;
  const run=()=>{
    if(stopped||pending)return;
    let advanced=false;
    pending=worker.pumpOnce().then(result=>{advanced=result.advanced>0;})
      .catch(error=>logger.error({err:error},'Alert processing interrupted'))
      .finally(()=>{pending=null;if(advanced&&!stopped){const next=setTimeout(run,10);next.unref?.();}});
  };
  const send=()=>{
    if(stopped||deliveryPending)return;
    deliveryPending=dispatchPush().catch(error=>logger.error({err:error},'Alert delivery interrupted'))
      .finally(()=>{deliveryPending=null;});
  };
  const timer=setInterval(run,500),deliveryTimer=setInterval(send,1000);
  timer.unref?.();deliveryTimer.unref?.();run();send();
  return {async stop(){stopped=true;clearInterval(timer);clearInterval(deliveryTimer);await Promise.all([pending,deliveryPending].filter(Boolean));}};
}
module.exports={startAlertRuntime};
