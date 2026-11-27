'use strict';
const {z}=require('zod');
const {randomUUID,createHmac,randomBytes}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {freeze}=require('../intelligence/candle-evidence');
const {createOfflineRequest,normalizeOfflineOutcome,CONTRACT_VERSION}=require('./provider-contract');
const {createPricingRegistry,meterOfflineUsage}=require('./compute-pricing');
const id=z.string().regex(/^[a-f0-9]{24}$/);
const scopeSchema=z.object({tenantId:id,actorId:id,sessionId:id,accountId:id}).strict();
const selectionSchema=z.object({providerId:z.enum(['openai','anthropic','gemini','deepseek','openrouter']),
  modelId:z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  fundingMode:z.enum(['BYO_API','ACG_CREDITS'])}).strict();
const inputSchema=z.object({idempotencyKey:z.uuid(),scope:scopeSchema,selection:selectionSchema,
  profile:z.enum(['MARKET_OVERVIEW','STRUCTURE','SESSION','EDUCATION']),
  question:z.string().min(1).max(4096),context:z.unknown().optional(),
  inputTokenUpperBound:z.number().int().min(1).max(10000000),
  maxOutputTokens:z.number().int().min(1).max(1000000),stream:z.boolean().default(false),
  timeoutMs:z.number().int().min(1).max(30000).default(10000)}).strict();
const terminal=new Set(['COMPLETED','DENIED','FAILED','CANCELLED','RECONCILIATION_REQUIRED']);
const knownError=new Set(['NONE','AUTHENTICATION','RATE_LIMIT','QUOTA','TIMEOUT','UNAVAILABLE','INVALID_RESPONSE','CANCELLED','UNKNOWN']);
function fail(code){throw Object.assign(Error('AI request unavailable'),{code});}
function bounded(v,min,max){return Number.isSafeInteger(v)&&v>=min&&v<=max;}
const owner=s=>[s.tenantId,s.actorId].join(':');
const exact=(a,b)=>['tenantId','actorId','sessionId','accountId'].every(k=>a[k]===b[k]);
// Process-local offline orchestration only. No persistence, credentials, billing,
// live transport, worker recovery, runtime registration or financial tools.
// Never evict idempotency tombstones to admit new requests.
function createOfflineOrchestrator({registry,responseEngine,adapters,authorize,now=Date.now,
  pricingRegistry=createPricingRegistry(),creditLedger=null,computeBudget=null,educationCache=null,cachePolicyEpoch=null,maxActive=8,maxPerOwner=2,maxPerTenant=4,maxRecords=512}={}){
  if(!registry||typeof registry.resolveForOfflineTest!=='function'||
    typeof responseEngine?.prepare!=='function'||typeof responseEngine?.verify!=='function'||
    typeof authorize!=='function'||typeof pricingRegistry?.pin!=='function'||(creditLedger!==null&&!['reserve','claimDispatch','recordOutcome','releaseBeforeDispatch'].every(k=>typeof creditLedger[k]==='function'))||!Array.isArray(adapters)||adapters.length>32||
    (computeBudget!==null&&!['reserve','markAttempt','releaseBeforeAttempt','settle'].every(k=>typeof computeBudget[k]==='function'))||
    (educationCache!==null&&(!['get','put','isCurrent'].every(k=>typeof educationCache[k]==='function')||typeof cachePolicyEpoch!=='string'||!/^[a-zA-Z0-9._:-]{1,128}$/.test(cachePolicyEpoch)))||
    !bounded(maxActive,1,64)||!bounded(maxPerOwner,1,maxActive)||!bounded(maxPerTenant,1,maxActive)||
    !bounded(maxRecords,1,4096))fail('ORCHESTRATOR_CONFIG_INVALID');
  const adapterMap=new Map();
  const adapterKey=(p,m)=>JSON.stringify([p,m]);
  for(const a of adapters){
    if(a?.executionMode!=='OFFLINE_TEST_ONLY'||a.contractVersion!==CONTRACT_VERSION||
      typeof a.providerId!=='string'||typeof a.modelId!=='string'||typeof a.generate!=='function')fail('ADAPTER_CONFIG_INVALID');
    const k=adapterKey(a.providerId,a.modelId);
    if(adapterMap.has(k))fail('DUPLICATE_ADAPTER');
    adapterMap.set(k,a.generate.bind(a));
  }
  const records=new Map(),activeOwners=new Map(),activeTenants=new Map();
  const hmacKey=randomBytes(32);
  let active=0;
  const mac=value=>createHmac('sha256',hmacKey).update(JSON.stringify(value)).digest('hex');
  const recordKey=(scope,key)=>mac([owner(scope),key]);
  function clock(){const t=now();if(!bounded(t,1,Number.MAX_SAFE_INTEGER))fail('ORCHESTRATOR_CLOCK_INVALID');return t;}
  async function allowed(request){try{return await authorize(request)===true;}catch{return false;}}
  function view(r){
    return freeze({operationId:r.operationId,status:r.status,providerId:r.selection.providerId,modelId:r.selection.modelId,
      fundingMode:r.selection.fundingMode,requestId:r.requestId,createdAtMs:r.createdAtMs,finishedAtMs:r.finishedAtMs,
      dispatch:r.dispatch,usage:r.usage,usageDisposition:r.usageDisposition,errorCode:r.errorCode,
      pricingSnapshot:r.pricingSnapshot,metering:r.metering,creditReservation:r.creditReservation,
      budget:r.budget,cache:r.cache,
      automaticRetry:false,automaticFallback:false,offlineOnly:true});
  }
  function finish(r,status,errorCode){
    if(terminal.has(r.status))return;
    r.status=status;r.errorCode=errorCode;
    try{r.finishedAtMs=clock();}catch{r.finishedAtMs=null;}
    // Never retain questions, context, candidates, provider payloads or answers.
    r.controller=null;
  }
  function reserve(scope){
    const u=owner(scope),t=scope.tenantId;
    if(active>=maxActive||(activeOwners.get(u)||0)>=maxPerOwner||(activeTenants.get(t)||0)>=maxPerTenant)
      fail('ORCHESTRATOR_BUSY');
    active++;activeOwners.set(u,(activeOwners.get(u)||0)+1);activeTenants.set(t,(activeTenants.get(t)||0)+1);
    let released=false;
    return ()=>{if(released)return;released=true;active--;
      for(const [m,k] of [[activeOwners,u],[activeTenants,t]]){const n=m.get(k)-1;if(n)m.set(k,n);else m.delete(k);}
    };
  }
  async function run(input,{signal}={}){
    const parsed=inputSchema.safeParse(input);
    if(!parsed.success||!parsed.data.question.trim()||Buffer.byteLength(parsed.data.question)>4096)fail('ORCHESTRATOR_REQUEST_INVALID');
    const x=parsed.data,scope=freeze(x.scope),selection=freeze(x.selection),context=x.context??null;
    const key=recordKey(scope,x.idempotencyKey.toLowerCase());
    const auth=freeze({scope,selection,operation:'GENERATE',profile:x.profile});
    // Bound pending authorization too. A busy caller can retry only before
    // an idempotency record exists and before any adapter invocation.
    const release=reserve(scope);
    const controller=new AbortController();
    let timer,externalAbort,reason=null,record=null,detached=false;
    let inFlight=null,budgetTicket=null,budgetAttempted=false;
    const start=performance.now();
    function stop(code){if(reason===null){reason=code;controller.abort();}}
    const aborted=new Promise(resolve=>controller.signal.addEventListener('abort',()=>resolve({aborted:true}),{once:true}));
    const step=async fn=>{
      if(reason!==null)return {aborted:true};
      const work=Promise.resolve().then(()=>fn()).then(value=>({value}),()=>({failed:true}));
      inFlight=work;
      const result=await Promise.race([work,aborted]);
      if(!result.aborted)inFlight=null;
      return result;
    };
    function validTime(){return reason===null&&performance.now()-start<x.timeoutMs;}
    try{
      timer=setTimeout(()=>stop('TIMEOUT'),x.timeoutMs);
      if(signal){externalAbort=()=>stop('CANCELLED');signal.addEventListener('abort',externalAbort,{once:true});if(signal.aborted)externalAbort();}
      const permission=await step(()=>allowed(auth));
      if(permission.aborted)fail(reason||'TIMEOUT');
      if(permission.value!==true)fail('ORCHESTRATOR_FORBIDDEN');
      const model=registry.resolveForOfflineTest(selection);
      const generate=adapterMap.get(adapterKey(model.providerId,model.modelId));
      if(!generate)fail('ADAPTER_NOT_REGISTERED');
      // Owner-wide idempotency prevents replay after switching accounts/sessions.
      // HMAC avoids retaining a dictionary-guessable question hash in metadata.
      const fingerprint=mac([scope,selection,model.descriptorId,x.profile,x.question,context?.contextId??null,
        x.inputTokenUpperBound,x.maxOutputTokens,x.stream,x.timeoutMs]);
      const prior=records.get(key);
      if(prior){
        if(!exact(prior.scope,scope))fail('ORCHESTRATOR_FORBIDDEN');
        if(prior.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT');
        return freeze({receipt:view(prior),response:null,replayed:true});
      }
      if(records.size>=maxRecords)fail('ORCHESTRATOR_RECORD_LIMIT');
      if(!validTime())fail(reason||'TIMEOUT');
      record={scope,selection,profile:x.profile,fingerprint,operationId:randomUUID(),status:'PREPARING',requestId:null,
        createdAtMs:clock(),finishedAtMs:null,dispatch:'NOT_DISPATCHED',usage:{status:'UNKNOWN'},
        usageDisposition:'NOT_DISPATCHED',pricingSnapshot:null,metering:null,creditReservation:null,budget:null,cache:'NOT_USED',errorCode:'NONE',controller,stop};
      records.set(key,record);
      const prepared=await step(()=>responseEngine.prepare({scope,profile:x.profile,question:x.question,context}));
      if(prepared.aborted||!validTime()){finish(record,reason==='CANCELLED'?'CANCELLED':'FAILED',reason||'TIMEOUT');return result();}
      if(prepared.failed||!prepared.value){finish(record,'DENIED','PREPARE_FAILED');return result();}
      const {ticket,prompt}=prepared.value;
      let q;
      try{q=createOfflineRequest({registry,selection,prompt,inputTokenUpperBound:x.inputTokenUpperBound,
        maxOutputTokens:x.maxOutputTokens,nowMs:clock(),stream:x.stream});}
      catch{finish(record,'FAILED','REQUEST_REJECTED');return result();}
      record.requestId=q.requestId;
      const before=await step(()=>allowed(auth));
      if(before.aborted||!validTime()){finish(record,reason==='CANCELLED'?'CANCELLED':'FAILED',reason||'TIMEOUT');return result();}
      if(before.value!==true){finish(record,'DENIED','ORCHESTRATOR_FORBIDDEN');return result();}
      // Cache is deliberately BYO-only in this increment. Managed cache hits
      // need durable zero-charge idempotency and wallet policy integration.
      const cacheInput={scope,request:q,context,policyEpoch:cachePolicyEpoch};
      const cacheEligible=educationCache!==null&&q.fundingMode==='BYO_API'&&context===null&&x.profile==='EDUCATION';
      if(cacheEligible){
        record.cache='MISS';
        const cachePermission=await step(()=>allowed(freeze({...auth,operation:'CACHE_READ'})));
        if(cachePermission.aborted||!validTime()){finish(record,'FAILED',reason||'TIMEOUT');return result();}
        if(cachePermission.value===true){
          const cached=educationCache.get(cacheInput);
          if(cached!==null){
            const verified=await step(()=>responseEngine.verify({ticket,scope,candidate:cached.candidate}));
            if(verified.aborted||!validTime()){finish(record,'FAILED',reason||'TIMEOUT');return result();}
            if(verified.value?.verified!==true||!verified.value.response){finish(record,'FAILED','CACHE_VERIFICATION_REJECTED');return result();}
            const after=await step(()=>allowed(auth));
            const cacheAfter=await step(()=>allowed(freeze({...auth,operation:'CACHE_READ'})));
            if(after.aborted||cacheAfter.aborted||!validTime()){finish(record,'FAILED',reason||'TIMEOUT');return result();}
            if(after.value!==true||cacheAfter.value!==true){finish(record,'DENIED','ORCHESTRATOR_FORBIDDEN');return result();}
            if(clock()>=q.expiresAtMs||clock()>=verified.value.response.expiresAtMs){finish(record,'FAILED','TIMEOUT');return result();}
            if(!educationCache.isCurrent(cacheInput,cached)){finish(record,'FAILED','CACHE_EXPIRED_OR_INVALIDATED');return result();}
            record.cache='HIT_REVERIFIED';record.usageDisposition='NOT_DISPATCHED';
            record.usage=freeze({status:'NOT_DISPATCHED'});
            record.metering=freeze({status:'NO_PROVIDER_REQUEST',fundingMode:q.fundingMode,costPicoUsd:'0',
              proposedCreditDebitPicoUsd:'0',settled:false,creditDeducted:false,offlineOnly:true});
            finish(record,'COMPLETED','NONE');return result(verified.value.response);
          }
        }
      }
      // Pin the applicable immutable price before dispatch; BYO may operate
      // without a cost estimate, but managed compute needs an explicit price.
      try{record.pricingSnapshot=pricingRegistry.pin(q,clock());}
      catch(e){
        if(q.fundingMode==='ACG_CREDITS'||e?.code!=='PRICE_NOT_AVAILABLE'){
          finish(record,'FAILED','PRICE_UNAVAILABLE');return result();
        }
      }
      if(computeBudget!==null){
        try{budgetTicket=computeBudget.reserve({scope,request:q,pricingSnapshot:record.pricingSnapshot});record.budget=freeze({status:'RESERVED_OFFLINE'});}
        catch(e){finish(record,'FAILED',['BUDGET_REQUEST_LIMIT','BUDGET_DAILY_LIMIT','BUDGET_PRICE_REQUIRED','BUDGET_CAPACITY'].includes(e?.code)?e.code:'BUDGET_UNAVAILABLE');return result();}
      }
      const useLedger=creditLedger!==null&&q.fundingMode==='ACG_CREDITS';
      let attemptId=null;
      if(useLedger){
        const held=await step(()=>creditLedger.reserve(scope,x.idempotencyKey,q,record.pricingSnapshot));
        if(held.aborted||held.failed||!held.value||!validTime()){
          finish(record,'RECONCILIATION_REQUIRED','CREDIT_RESERVATION_UNCERTAIN');return result();
        }
        record.creditReservation=held.value;
        if(held.value.status!=='RESERVED'){
          finish(record,'FAILED','CREDIT_RESERVATION_NOT_AVAILABLE');return result();
        }
        const fresh=await step(()=>allowed(auth));
        if(fresh.aborted||fresh.value!==true||!validTime()||clock()>=q.expiresAtMs){
          const released=await step(()=>creditLedger.releaseBeforeDispatch(scope,x.idempotencyKey));
          if(released.value)record.creditReservation=released.value;
          finish(record,released.value?'DENIED':'RECONCILIATION_REQUIRED','CREDIT_DISPATCH_NOT_AUTHORIZED');return result();
        }
        const claim=await step(()=>creditLedger.claimDispatch(scope,x.idempotencyKey));
        if(claim.value?.receipt)record.creditReservation=claim.value.receipt;
        if(claim.aborted||claim.failed||claim.value?.dispatchAllowed!==true||!validTime()){
          finish(record,'RECONCILIATION_REQUIRED','CREDIT_DISPATCH_NOT_CLAIMED');return result();
        }
        attemptId=claim.value.attemptId;
        // Fresh check after durable dispatch claim; denial leaves a hold
        // for conservative recovery, never a second dispatch.
        const finalPermission=await step(()=>allowed(auth));
        if(finalPermission.aborted||finalPermission.value!==true||!validTime()){
          finish(record,'RECONCILIATION_REQUIRED','CREDIT_DISPATCH_NOT_AUTHORIZED');return result();
        }
      }
      const remaining=Math.min(q.expiresAtMs-clock(),Math.floor(x.timeoutMs-(performance.now()-start)));
      if(remaining<1){finish(record,useLedger?'RECONCILIATION_REQUIRED':'FAILED','TIMEOUT');return result();}
      clearTimeout(timer);timer=setTimeout(()=>stop('TIMEOUT'),remaining);
      // Commit the in-memory dispatch marker synchronously before invocation.
      // A timeout/throw after this point is ambiguous, never auto-retried.
      if(budgetTicket){computeBudget.markAttempt(budgetTicket);budgetAttempted=true;record.budget=freeze({status:'HELD_FOR_RECONCILIATION'});}
      record.status='DISPATCHED';record.dispatch='ATTEMPTED';record.usageDisposition='RECONCILIATION_REQUIRED';
      const work=Promise.resolve().then(()=>generate(q,{signal:controller.signal,timeoutMs:remaining}));
      const settled=work.then(value=>({value}),()=>({failed:true}));
      const outcome=await Promise.race([settled,aborted]);
      if(outcome.aborted||!validTime()){
        // Keep the concurrency slot until an uncooperative adapter actually
        // settles. Late completion is discarded and never changes a receipt.
        detached=true;settled.then(release);
        finish(record,'RECONCILIATION_REQUIRED',reason||'TIMEOUT');return result();
      }
      if(outcome.failed){finish(record,'RECONCILIATION_REQUIRED','UNKNOWN');return result();}
      let v;
      try{
        const o=outcome.value;
        // Revalidate normalized adapter output with the Phase 3A strict schema.
        const u=o.usage?.status==='PROVIDER_REPORTED'?{status:o.usage.status,inputTokens:o.usage.inputTokens,
          outputTokens:o.usage.outputTokens,cachedInputTokens:o.usage.cachedInputTokens,
          reasoningOutputTokens:o.usage.reasoningOutputTokens,
          ...Object.fromEntries(['cacheWriteInputTokens','cacheWrite5mInputTokens','cacheWrite1hInputTokens']
            .filter(k=>Object.hasOwn(o.usage,k)).map(k=>[k,o.usage[k]]))}:o.usage;
        v=normalizeOfflineOutcome(q,{requestId:o.requestId,providerId:o.providerId,modelId:o.modelId,
          descriptorId:o.descriptorId,status:o.status,candidate:o.candidate,usage:u,errorCode:o.errorCode});
      }catch{finish(record,'RECONCILIATION_REQUIRED','INVALID_RESPONSE');return result();}
      record.usage=v.usage;record.usageDisposition=v.usageDisposition;
      record.dispatch='OUTCOME_RECEIVED';
      if(budgetTicket){
        let metering=null;
        if(record.pricingSnapshot)try{metering=meterOfflineUsage(q,record.pricingSnapshot,v.status==='UNKNOWN'?{status:'UNKNOWN'}:v.usage);}catch{}
        try{record.budget=computeBudget.settle(budgetTicket,{outcome:v,metering});}
        catch{record.budget=freeze({status:'HELD_FOR_RECONCILIATION'});}
      }
      if(useLedger){
        const saved=await step(()=>creditLedger.recordOutcome(scope,x.idempotencyKey,{attemptId,requestId:q.requestId,status:v.status,usage:v.usage}));
        if(saved.value)record.creditReservation=saved.value;
        if(saved.aborted||saved.failed||saved.value?.status!=='SETTLED'||!validTime()){
          record.usageDisposition='RECONCILIATION_REQUIRED';finish(record,'RECONCILIATION_REQUIRED','CREDIT_SETTLEMENT_UNCERTAIN');return result();
        }
      }
      if(record.pricingSnapshot){
        try{
          record.metering=meterOfflineUsage(q,record.pricingSnapshot,v.status==='UNKNOWN'?{status:'UNKNOWN'}:v.usage);
          if(v.status==='UNKNOWN')record.metering=freeze({...record.metering,reason:'PROVIDER_OUTCOME_UNKNOWN'});
        }
        catch{record.usageDisposition='RECONCILIATION_REQUIRED';finish(record,'RECONCILIATION_REQUIRED','PRICE_SNAPSHOT_INVALID');return result();}
        if(record.metering.status==='RECONCILIATION_REQUIRED'){record.usageDisposition='RECONCILIATION_REQUIRED';finish(record,'RECONCILIATION_REQUIRED','METERING_UNCERTAIN');return result();}
      }else if(q.fundingMode==='BYO_API')record.metering=freeze({status:'PRICE_NOT_AVAILABLE',fundingMode:'BYO_API',costPicoUsd:null,proposedCreditDebitPicoUsd:'0',settled:false,creditDeducted:false,offlineOnly:true});
      if(v.usageDisposition==='RECONCILIATION_REQUIRED'||v.status==='UNKNOWN'){
        record.usageDisposition='RECONCILIATION_REQUIRED';
        finish(record,'RECONCILIATION_REQUIRED',v.errorCode==='NONE'?'USAGE_UNCERTAIN':v.errorCode);return result();
      }
      if(budgetTicket&&record.budget.status!=='ACCOUNTED_OFFLINE'){
        record.usageDisposition='RECONCILIATION_REQUIRED';finish(record,'RECONCILIATION_REQUIRED','BUDGET_USAGE_UNCERTAIN');return result();
      }
      if(v.status!=='COMPLETED'){finish(record,v.status==='CANCELLED'?'CANCELLED':'FAILED',
        knownError.has(v.errorCode)?v.errorCode:'UNKNOWN');return result();}
      record.status='VERIFYING';
      if(clock()>=q.expiresAtMs){finish(record,'FAILED','TIMEOUT');return result();}
      const verified=await step(()=>responseEngine.verify({ticket,scope,candidate:v.candidate}));
      if(verified.aborted||!validTime()){finish(record,reason==='CANCELLED'?'CANCELLED':'FAILED',reason||'TIMEOUT');return result();}
      if(verified.value?.verified!==true||!verified.value.response){finish(record,'FAILED','VERIFICATION_REJECTED');return result();}
      const after=await step(()=>allowed(auth));
      if(after.aborted||!validTime()){finish(record,reason==='CANCELLED'?'CANCELLED':'FAILED',reason||'TIMEOUT');return result();}
      if(after.value!==true){finish(record,'DENIED','ORCHESTRATOR_FORBIDDEN');return result();}
      if(clock()>=q.expiresAtMs||clock()>=verified.value.response.expiresAtMs){finish(record,'FAILED','TIMEOUT');return result();}
      if(cacheEligible){
        const cachePermission=await step(()=>allowed(freeze({...auth,operation:'CACHE_WRITE'})));
        if(cachePermission.aborted||!validTime()){finish(record,'FAILED',reason||'TIMEOUT');return result();}
        const finalAccess=await step(()=>allowed(auth));
        if(finalAccess.aborted||!validTime()){finish(record,'FAILED',reason||'TIMEOUT');return result();}
        if(finalAccess.value!==true){finish(record,'DENIED','ORCHESTRATOR_FORBIDDEN');return result();}
        if(cachePermission.value===true)try{educationCache.put(cacheInput,{candidate:v.candidate,verifiedResponse:verified.value.response});}catch{}
        if(clock()>=q.expiresAtMs||clock()>=verified.value.response.expiresAtMs){finish(record,'FAILED','TIMEOUT');return result();}
      }
      finish(record,'COMPLETED','NONE');return result(verified.value.response);
    }catch(e){
      if(record){finish(record,record.dispatch==='ATTEMPTED'?'RECONCILIATION_REQUIRED':'FAILED','UNKNOWN');return result();}
      throw e;
    }finally{
      releaseUnusedBudget();
      clearTimeout(timer);if(externalAbort)signal.removeEventListener('abort',externalAbort);
      if(!detached){if(inFlight)inFlight.then(release);else release();}
      if(record)record.stop=null;
    }
    function releaseUnusedBudget(){
      if(budgetTicket&&!budgetAttempted){
        try{computeBudget.releaseBeforeAttempt(budgetTicket);if(record)record.budget=freeze({status:'RELEASED_BEFORE_ATTEMPT'});}
        catch{if(record)record.budget=freeze({status:'HELD_FOR_RECONCILIATION'});}
        budgetTicket=null;
      }
    }
    function result(response=null){releaseUnusedBudget();return freeze({receipt:view(record),response,replayed:false});}
  }
  async function lookup(scopeInput,keyInput,operation){
    const s=scopeSchema.safeParse(scopeInput),k=z.uuid().safeParse(keyInput);
    if(!s.success||!k.success)fail('ORCHESTRATOR_REQUEST_INVALID');
    const scope=freeze(s.data),r=records.get(recordKey(scope,k.data.toLowerCase()));
    if(!r||!exact(r.scope,scope)||!await allowed(freeze({scope,selection:r.selection,profile:r.profile,operation})))fail('ORCHESTRATOR_FORBIDDEN');
    return r;
  }
  return Object.freeze({
    run,
    async status(scope,key){return view(await lookup(scope,key,'STATUS'));},
    async cancel(scope,key){
      const r=await lookup(scope,key,'CANCEL');
      if(!terminal.has(r.status))r.stop?.('CANCELLED');
      return view(r);
    },
  });
}
module.exports={createOfflineOrchestrator};
