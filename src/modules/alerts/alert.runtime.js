'use strict';
const models=require('./alert-models');
const {AlertShadowWorker}=require('./alert-worker');
const {dispatchPush}=require('./alert-delivery');

async function startAlertRuntime({logger}) {
  // Create only the new alerts indexes. Never sync/drop indexes in production.
  for(const model of Object.values(models))await model.createIndexes();
  const worker=new AlertShadowWorker({logger,liveDelivery:true});
  let stopped=false, pending=null;
  const run=()=>{
    if(stopped||pending)return;
    pending=(async()=>{await worker.pumpOnce();await dispatchPush();})()
      .catch(error=>logger.error({err:error},'Alert processing interrupted'))
      .finally(()=>{pending=null;});
  };
  const timer=setInterval(run,500);timer.unref?.();run();
  return {async stop(){stopped=true;clearInterval(timer);if(pending)await pending;}};
}
module.exports={startAlertRuntime};
