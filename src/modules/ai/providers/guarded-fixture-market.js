'use strict';
const {createHash}=require('node:crypto');
const {assertIsolated}=require('./credit-ledger-store');
const {AppError}=require('../../../shared/errors/app-error');
const deny=()=>new AppError('AI admission or consent unavailable',{statusCode:403,code:'AI_CHAT_PURPOSE_DENIED'});
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
// Isolated integration of the production admission primitives. This wrapper
// cannot be instantiated outside disposable CI and never opens public sockets.
// A future live adapter must separately implement approved transport, data
// export policy and authenticated provider billing evidence.
function createGuardedFixtureMarket({admission,policyVersion,reconcileFixture}={}){
  assertIsolated();
  if(!/^[a-f0-9]{64}$/.test(policyVersion)||typeof reconcileFixture!=='function'||
    !['assertConsent','claim','beginDispatch','assertDispatch','assertDisclosure'].every(k=>typeof admission?.[k]==='function'))throw deny();
  const prepared=new WeakMap();
  async function permitted(fn){try{return await fn();}catch{throw deny();}}
  return Object.freeze({
    async prepare({scope,selection,workspace}){
      assertIsolated();
      if(workspace?.includeChartContext!==true)throw deny();
      const expected=Object.freeze({descriptorId:selection.descriptorId,policyVersion,symbol:workspace.symbol,timeframe:workspace.timeframe});
      const owner=Object.freeze(Object.fromEntries(['tenantId','actorId','sessionId','accountId','connectionId'].map(k=>[k,scope[k]])));
      const pin=await permitted(()=>admission.assertConsent(owner,expected));
      const ticket=Object.freeze({});
      prepared.set(ticket,{owner,expected,pin});return ticket;
    },
    bind({ticket,operationId,transport,authorize}){
      assertIsolated();
      const context=prepared.get(ticket);
      if(!context||typeof transport?.exchange!=='function'||typeof authorize!=='function')throw deny();
      prepared.delete(ticket);
      const {owner,expected,pin}=context;
      let invoked=false;
      return Object.freeze({
        async exchange(q,secret,{signal,timeoutMs}={}){
          assertIsolated();
          if(invoked||q.executionMode!=='OFFLINE_TEST_ONLY'||q.descriptorId!==expected.descriptorId||signal?.aborted||Date.now()>=q.expiresAtMs)throw deny();
          invoked=true;
          const check=async()=>{if(signal?.aborted||Date.now()>=q.expiresAtMs||await authorize()!==true)throw deny();};
          await check();await admission.assertConsent(owner,{...expected,consentRevision:pin.consentRevision});
          const claim=await admission.claim(owner,{...expected,consentRevision:pin.consentRevision,operationId,
            maxInputTokens:q.budget.inputTokenUpperBound,maxOutputTokens:q.budget.maxOutputTokens});
          let began=false,outcome=null,settled=false,wrote=false;
          try{
            await check();
            await admission.beginDispatch(owner,operationId);began=true;
            outcome=await transport.exchange(q,secret,{signal,timeoutMs,beforeWrite:async()=>{
              if(wrote)throw deny();
              await check();await admission.assertDispatch(owner,operationId);await check();
              wrote=true;
            }});
            if(!wrote)throw deny();
            const u=outcome?.usage;
            const known=['COMPLETED','REFUSED','INCOMPLETE','FAILED'].includes(outcome?.status)&&
              outcome.usageDisposition==='UNSETTLED'&&u?.status==='PROVIDER_REPORTED'&&
              Number.isSafeInteger(u.inputTokens)&&u.inputTokens>=0&&u.inputTokens<=q.budget.inputTokenUpperBound&&
              Number.isSafeInteger(u.outputTokens)&&u.outputTokens>=0&&u.outputTokens<=q.budget.maxOutputTokens&&
              u.totalTokens===u.inputTokens+u.outputTokens;
            const usage=known?{inputTokens:u.inputTokens,outputTokens:u.outputTokens}:{};
            const evidenceId=digest(['fixture-transport-usage-v1',claim.attemptId,q.requestId,known?'SETTLE':'UNKNOWN',usage]);
            await reconcileFixture({attemptId:claim.attemptId,kind:known?'SETTLE':'UNKNOWN',evidenceId,...usage});
            settled=true;
            if(!known)return outcome;
            await admission.assertDisclosure(owner,operationId);await check();
            return outcome;
          }catch(e){
            // A committed beginDispatch may be ambiguous, so never release it
            // as not-sent. If no begin was recorded, retain CLAIMED for recovery.
            if(began&&!settled)try{await reconcileFixture({attemptId:claim.attemptId,kind:'UNKNOWN',
              evidenceId:digest(['fixture-transport-unknown-v1',claim.attemptId,q.requestId])});}catch{}
            throw e;
          }
        }
      });
    },
    async assertDisclosure(scope,operationId){assertIsolated();return permitted(()=>admission.assertDisclosure(scope,operationId));}
  });
}
module.exports={createGuardedFixtureMarket};
