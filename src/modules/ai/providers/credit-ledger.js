'use strict';
const {z}=require('zod');
const {randomUUID}=require('node:crypto');
const {digest,freeze}=require('../intelligence/candle-evidence');
const {meterOfflineUsage}=require('./compute-pricing');
const {CONTRACT_VERSION}=require('./provider-contract');
const {assertIsolated}=require('./credit-ledger-store');
const id=z.string().regex(/^[a-f0-9]{24}$/),uuid=z.uuid().transform(s=>s.toLowerCase());
const money=z.string().regex(/^(0|[1-9][0-9]{0,23})$/);
const hex=z.string().regex(/^[a-f0-9]{64}$/);
const instant=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const scopeSchema=z.object({tenantId:id,actorId:id,sessionId:id,accountId:id}).strict();
const metaSchema=z.object({contractVersion:z.literal(CONTRACT_VERSION),executionMode:z.literal('OFFLINE_TEST_ONLY'),
  requestId:uuid,providerId:z.enum(['openai','anthropic','gemini','deepseek','openrouter']),
  modelId:z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),descriptorId:hex,
  fundingMode:z.literal('ACG_CREDITS'),createdAtMs:instant,expiresAtMs:instant,
  budget:z.object({inputTokenUpperBound:z.number().int().min(1).max(10000000),
    maxOutputTokens:z.number().int().min(1).max(1000000)}).strict()}).strict();
const outcomeSchema=z.object({attemptId:uuid,requestId:uuid,status:z.enum(['COMPLETED','REFUSED','INCOMPLETE','FAILED','CANCELLED','UNKNOWN']),
  usage:z.unknown()}).strict();
function fail(code){throw Object.assign(Error('Credit ledger operation unavailable'),{code});}
function parse(s,v){const p=s.safeParse(v);if(!p.success)fail('CREDIT_REQUEST_INVALID');return p.data;}
function n(v){return BigInt(parse(money,v));}
function m(v){if(v<0n||!money.safeParse(v.toString()).success)fail('CREDIT_AMOUNT_INVALID');return v.toString();}
const walletId=s=>digest(['credit-wallet-v1',s.tenantId,s.actorId]);
const reservationId=(s,key)=>digest(['credit-reservation-v1',walletId(s),key]);
const same=(r,s)=>r&&['tenantId','actorId','sessionId','accountId'].every(k=>r[k]===s[k]);
const owner=s=>({tenantId:s.tenantId,actorId:s.actorId});
function verifyWallet(w,s){
  if(!w||w._id!==walletId(s)||w.tenantId!==s.tenantId||w.actorId!==s.actorId||
    !Number.isSafeInteger(w.revision)||w.revision<0||w.revision>=Number.MAX_SAFE_INTEGER||
    !Number.isSafeInteger(w.pendingReversals??0)||(w.pendingReversals??0)<0||
    !money.safeParse(w.reversed??'0').success||n(w.available)+n(w.reserved)+n(w.spent)!==n(w.credited))fail('CREDIT_WALLET_INVALID');
  return w;
}
function walletView(w){return freeze({available:w.available,reserved:w.reserved,spent:w.spent,credited:w.credited,revision:w.revision,
  pendingReversals:w.pendingReversals??0,reversed:w.reversed??'0',
  currency:'USD',moneyUnit:'PICO_USD',offlineOnly:true});}
function receipt(r){return freeze({reservationId:r._id,requestId:r.requestId,status:r.status,revision:r.revision,amount:r.amount,
  charged:r.charged,expiresAtMs:r.expiresAtMs,reason:r.reason,offlineOnly:true,automaticRetry:false});}
function projectRequest(q){
  return parse(metaSchema,{contractVersion:q?.contractVersion,executionMode:q?.executionMode,requestId:q?.requestId,
    providerId:q?.providerId,modelId:q?.modelId,descriptorId:q?.descriptorId,fundingMode:q?.fundingMode,
    createdAtMs:q?.createdAtMs,expiresAtMs:q?.expiresAtMs,budget:{inputTokenUpperBound:q?.budget?.inputTokenUpperBound,
    maxOutputTokens:q?.budget?.maxOutputTokens}});
}
// Isolated fixture service. No real wallet funding, provider transport or
// mounted route. Authorize must be a trusted action-specific current policy.
function createIsolatedCreditLedger({store,authorize,now=Date.now}={}){
  assertIsolated();
  if(typeof store?.transaction!=='function'||typeof authorize!=='function')fail('CREDIT_CONFIG_INVALID');
  const clock=()=>parse(instant,now());
  async function permit(scope,operation,key=null){
    let allowed=false;try{allowed=await authorize(freeze({scope,operation,idempotencyKey:key}))===true;}catch{}
    if(!allowed)fail('CREDIT_FORBIDDEN');
  }
  async function tx(scopeInput,operation,keyInput,work){
    assertIsolated();
    const s=freeze(parse(scopeSchema,scopeInput)),key=keyInput===null?null:parse(uuid,keyInput);
    await permit(s,operation,key);
    const result=await store.transaction(t=>work(t,s,key));
    await permit(s,operation,key);
    return result;
  }
  async function readReservation(t,s,key){
    const r=await t.reservation(s,reservationId(s,key));
    if(!same(r,s))fail('CREDIT_RESERVATION_UNAVAILABLE');
    return r;
  }
  async function journal(t,s,w,operation,reference,reservation,amount,at,eventId=null){
    await t.append({_id:eventId??digest(['credit-event-v1',w._id,w.revision]),...owner(s),walletId:w._id,
      reservationId:reservation?reservation._id:null,operation,reference,revision:w.revision,amount,
      available:w.available,reserved:w.reserved,spent:w.spent,credited:w.credited,pendingReversals:w.pendingReversals??0,reversed:w.reversed??'0',occurredAtMs:at});
  }
  async function change(t,s,w,r,next,operation,availableDelta,reservedDelta,spentDelta,at){
    const newWallet={...w,available:m(n(w.available)+availableDelta),reserved:m(n(w.reserved)+reservedDelta),
      spent:m(n(w.spent)+spentDelta),revision:w.revision+1};
    verifyWallet(newWallet,s);
    await t.updateWallet(s,w,newWallet);
    if(r)await t.updateReservation(s,r,next);else await t.createReservation(next);
    await journal(t,s,newWallet,operation,next.requestId,next,operation==='SETTLE'?next.charged:next.amount,at);
    return receipt(next);
  }
  return Object.freeze({
    async balance(scope){return tx(scope,'BALANCE',null,async(t,s)=>{
      const w=await t.wallet(s,walletId(s));return w?walletView(verifyWallet(w,s)):walletView({available:'0',reserved:'0',spent:'0',credited:'0',revision:0});
    });},
    // Synthetic funding only; no payment or arbitrary production mint method.
    async fixtureCredit(scope,reference,amount){
      const value=parse(money,amount);if(n(value)===0n)fail('CREDIT_AMOUNT_INVALID');
      return tx(scope,'FIXTURE_CREDIT',reference,async(t,s,key)=>{
        const at=clock(),wid=walletId(s),eventId=digest(['fixture-credit-v1',key]);
        const existing=await t.journal(s,eventId);
        const w=await t.wallet(s,wid);
        if(existing){
          if(existing.operation!=='FIXTURE_CREDIT'||existing.amount!==value||existing.walletId!==wid)fail('CREDIT_CONFLICT');
          return walletView(verifyWallet(w,s));
        }
        const previous=w?verifyWallet(w,s):{_id:wid,...owner(s),available:'0',reserved:'0',spent:'0',credited:'0',revision:0};
        const next={...previous,available:m(n(previous.available)+n(value)),credited:m(n(previous.credited)+n(value)),revision:previous.revision+1};
        verifyWallet(next,s);
        if(w)await t.updateWallet(s,w,next);else await t.createWallet(next);
        await journal(t,s,next,'FIXTURE_CREDIT',key,null,value,at,eventId);
        return walletView(next);
      });
    },
    async reserve(scope,key,q,snapshot){
      const meta=projectRequest(q);
      // Validate and recompute the pinned bound using the existing price engine.
      meterOfflineUsage(meta,snapshot,{status:'UNKNOWN'});
      const snapshotJson=JSON.stringify(snapshot),metaJson=JSON.stringify(meta);
      if(Buffer.byteLength(snapshotJson)>16384||Buffer.byteLength(metaJson)>4096)fail('CREDIT_REQUEST_INVALID');
      const amount=parse(money,snapshot.upperBoundPicoUsd);
      const fingerprint=digest([metaJson,snapshotJson]);
      return tx(scope,'RESERVE',key,async(t,s,k)=>{
        const at=clock(),rid=reservationId(s,k),old=await t.reservation(s,rid);
        if(old){
          if(!same(old,s)||old.requestFingerprint!==fingerprint)fail('CREDIT_CONFLICT');
          return receipt(old);
        }
        if(at<snapshot.pinnedAtMs||at>=meta.expiresAtMs)fail('CREDIT_REQUEST_EXPIRED');
        const w=verifyWallet(await t.wallet(s,walletId(s)),s);
        if((w.pendingReversals??0)>0)fail('CREDIT_WALLET_RESTRICTED');
        if(n(w.available)<n(amount))fail('CREDIT_INSUFFICIENT');
        const next={_id:rid,...s,idempotencyKey:k,requestId:meta.requestId,requestFingerprint:fingerprint,
          revision:1,status:'RESERVED',amount,charged:'0',attemptId:null,requestMeta:metaJson,pricingSnapshot:snapshotJson,
          createdAtMs:at,expiresAtMs:meta.expiresAtMs,updatedAtMs:at,usageDigest:null,reason:null};
        return change(t,s,w,null,next,'RESERVE',-n(amount),n(amount),0n,at);
      });
    },
    async claimDispatch(scope,key){
      return tx(scope,'DISPATCH',key,async(t,s,k)=>{
        const at=clock(),r=await readReservation(t,s,k);
        // Only the transaction that changes RESERVED -> DISPATCHED returns a
        // capability. A replay, unknown commit, restart or concurrent loser
        // must never cause another provider dispatch.
        if(r.status!=='RESERVED')return freeze({receipt:receipt(r),dispatchAllowed:false,attemptId:null});
        if(at>=r.expiresAtMs)fail('CREDIT_REQUEST_EXPIRED');
        const w=verifyWallet(await t.wallet(s,walletId(s)),s);
        const next={...r,status:'DISPATCHED',attemptId:randomUUID(),revision:r.revision+1,updatedAtMs:at};
        const result=await change(t,s,w,r,next,'DISPATCH',0n,0n,0n,at);
        return freeze({receipt:result,dispatchAllowed:true,attemptId:next.attemptId});
      });
    },
    async recordOutcome(scope,key,input){
      const o=parse(outcomeSchema,input);
      return tx(scope,'OUTCOME',key,async(t,s,k)=>{
        const at=clock(),r=await readReservation(t,s,k);
        if(r.attemptId!==o.attemptId||r.requestId!==o.requestId)fail('CREDIT_ATTEMPT_MISMATCH');
        // Only a definitive, normalized provider usage record may settle.
        // CANCELLED/UNKNOWN remain ambiguous even with reported partial usage.
        let metered;
        try{metered=meterOfflineUsage(JSON.parse(r.requestMeta),JSON.parse(r.pricingSnapshot),
          ['CANCELLED','UNKNOWN'].includes(o.status)?{status:'UNKNOWN'}:o.usage);}
        catch{fail('CREDIT_SNAPSHOT_INVALID');}
        const final=metered.status==='CALCULATED_OFFLINE';
        const evidence=final?digest([o.status,
          ['status','inputTokens','outputTokens','totalTokens','cachedInputTokens','reasoningOutputTokens',
            'cacheWriteInputTokens','cacheWrite5mInputTokens','cacheWrite1hInputTokens'].map(k=>o.usage[k]??null),
          metered.lines,metered.costPicoUsd]):null;
        if(r.status==='SETTLED'){
          if(!final||r.usageDigest!==evidence)fail('CREDIT_CONFLICT');
          return receipt(r);
        }
        if(!['DISPATCHED','RECONCILIATION_REQUIRED'].includes(r.status))fail('CREDIT_STATE_INVALID');
        if(!final&&r.status==='RECONCILIATION_REQUIRED')return receipt(r);
        const w=verifyWallet(await t.wallet(s,walletId(s)),s);
        if(!final){
          return change(t,s,w,r,{...r,status:'RECONCILIATION_REQUIRED',reason:['CANCELLED','UNKNOWN'].includes(o.status)?'OUTCOME_UNKNOWN':'USAGE_UNCERTAIN',
            revision:r.revision+1,updatedAtMs:at},'HOLD',0n,0n,0n,at);
        }
        const charge=n(metered.proposedCreditDebitPicoUsd),hold=n(r.amount);
        if(charge>hold)fail('CREDIT_AMOUNT_INVALID');
        return change(t,s,w,r,{...r,status:'SETTLED',reason:'VERIFIED_USAGE',charged:m(charge),usageDigest:evidence,
          revision:r.revision+1,updatedAtMs:at},'SETTLE',hold-charge,-hold,charge,at);
      });
    },
    async releaseBeforeDispatch(scope,key){
      return tx(scope,'RELEASE',key,async(t,s,k)=>{
        const at=clock(),r=await readReservation(t,s,k);
        if(r.status==='RELEASED')return receipt(r);
        if(r.status!=='RESERVED'||r.attemptId!==null)fail('CREDIT_STATE_INVALID');
        const w=verifyWallet(await t.wallet(s,walletId(s)),s);
        return change(t,s,w,r,{...r,status:'RELEASED',reason:'CANCELLED_BEFORE_DISPATCH',revision:r.revision+1,
          updatedAtMs:at},'RELEASE',n(r.amount),-n(r.amount),0n,at);
      });
    },
    async recoverExpired(scope,key){
      return tx(scope,'RECOVER',key,async(t,s,k)=>{
        const at=clock(),r=await readReservation(t,s,k);
        if(at<r.expiresAtMs||!['RESERVED','DISPATCHED'].includes(r.status))return receipt(r);
        const w=verifyWallet(await t.wallet(s,walletId(s)),s);
        if(r.status==='RESERVED'&&r.attemptId===null)
          return change(t,s,w,r,{...r,status:'RELEASED',reason:'EXPIRED_BEFORE_DISPATCH',revision:r.revision+1,
            updatedAtMs:at},'RELEASE',n(r.amount),-n(r.amount),0n,at);
        return change(t,s,w,r,{...r,status:'RECONCILIATION_REQUIRED',reason:'RECOVERED_AMBIGUOUS',
          revision:r.revision+1,updatedAtMs:at},'HOLD',0n,0n,0n,at);
      });
    },
    async status(scope,key){return tx(scope,'STATUS',key,async(t,s,k)=>receipt(await readReservation(t,s,k)));},
  });
}
module.exports={createIsolatedCreditLedger,walletId,verifyWallet,walletView};
