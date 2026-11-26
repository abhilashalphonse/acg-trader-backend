'use strict';
const {z}=require('zod');
const {randomUUID}=require('node:crypto');
const {digest,freeze}=require('../intelligence/candle-evidence');
const {assertIsolated}=require('./credit-ledger-store');
const {walletId,verifyWallet,walletView}=require('./credit-ledger');
const id=z.string().regex(/^[a-f0-9]{24}$/),uuid=z.uuid().transform(v=>v.toLowerCase());
const scopeSchema=z.object({tenantId:id,actorId:id,sessionId:id,accountId:id}).strict();
const skuSchema=z.enum(['FIXTURE_5','FIXTURE_10','FIXTURE_25']);
const CATALOG=freeze({FIXTURE_5:'500',FIXTURE_10:'1000',FIXTURE_25:'2500'});
const money=z.string().regex(/^(0|[1-9][0-9]{0,23})$/);
function fail(code){throw Object.assign(Error('Credit purchase unavailable'),{code});}
function parse(schema,v){const p=schema.safeParse(v);if(!p.success)fail('CREDIT_PURCHASE_INVALID');return p.data;}
const n=v=>BigInt(parse(money,v));
function m(v){return parse(money,v.toString());}
const owner=s=>({tenantId:s.tenantId,actorId:s.actorId});
const owns=(p,s)=>p&&p.tenantId===s.tenantId&&p.actorId===s.actorId;
function view(p){return freeze({purchaseId:p._id,sku:p.sku,currency:p.currency,amountMinor:p.amountMinor,
  creditAmount:p.creditAmount,moneyUnit:'PICO_USD',status:p.status,revision:p.revision,
  reversalPending:p.reversalPending,fullReversalVerified:p.fullReversalVerified,
  catalogVersion:p.catalogVersion,offlineOnly:true,paymentEnabled:false});}
// No external checkout, provider credentials, payment dispatch, routes or
// production mint capability. Store and service require isolated CI.
function createIsolatedPurchaseService({store,verifier,authorize,authorizeWebhook,now=Date.now}={}){
  assertIsolated();
  if(typeof store?.transaction!=='function'||typeof verifier?.verify!=='function'||
    typeof authorize!=='function'||typeof authorizeWebhook!=='function')fail('CREDIT_PURCHASE_CONFIG_INVALID');
  function clock(){const t=now();if(!Number.isSafeInteger(t)||t<1)fail('CREDIT_PURCHASE_CLOCK_INVALID');return t;}
  async function permit(fn,req){let ok=false;try{ok=await fn(freeze(req))===true;}catch{}if(!ok)fail('CREDIT_PURCHASE_FORBIDDEN');}
  async function userTx(scopeInput,operation,work){
    assertIsolated();const s=freeze(parse(scopeSchema,scopeInput));await permit(authorize,{scope:s,operation});
    const result=await store.transaction(t=>work(t,s));
    await permit(authorize,{scope:s,operation});return result;
  }
  async function walletChange(t,p,operation,delta,pendingDelta,at){
    const s=owner(p),wid=walletId(s),old=await t.wallet(s,wid);
    if(!old&&operation!=='PURCHASE_CREDIT')fail('CREDIT_WALLET_INVALID');
    const w=old?verifyWallet(old,s):{_id:wid,...s,available:'0',reserved:'0',spent:'0',credited:'0',
      reversed:'0',pendingReversals:0,revision:0};
    const next={...w,available:m(n(w.available)+delta),credited:m(n(w.credited)+delta),
      reversed:m(n(w.reversed??'0')+(delta<0n?-delta:0n)),pendingReversals:(w.pendingReversals??0)+pendingDelta,
      revision:w.revision+1};
    verifyWallet(next,s);
    if(old)await t.updateWallet(s,w,next);else await t.createWallet(next);
    await t.append({_id:digest(['credit-event-v1',wid,next.revision]),...s,walletId:wid,reservationId:null,
      operation,reference:p._id,revision:next.revision,amount:m(delta===0n?n(p.creditAmount):delta<0n?-delta:delta),
      available:next.available,reserved:next.reserved,spent:next.spent,credited:next.credited,
      reversed:next.reversed,pendingReversals:next.pendingReversals,occurredAtMs:at});
  }
  async function applyFullReversal(t,p,at){
    if(!p.credited||!p.fullReversalVerified)fail('CREDIT_PURCHASE_STATE_INVALID');
    const w=verifyWallet(await t.wallet(owner(p),walletId(p)),p);
    if(n(w.available)<n(p.creditAmount)){
      if(!p.reversalPending)await walletChange(t,p,'PAYMENT_REVERSAL_HOLD',0n,1,at);
      return {...p,status:'REVERSAL_PENDING',reversalPending:true};
    }
    await walletChange(t,p,'PAYMENT_REVERSAL',-n(p.creditAmount),p.reversalPending?-1:0,at);
    return {...p,status:'REVERSED',reversalPending:false};
  }
  return Object.freeze({
    catalog:()=>freeze(Object.entries(CATALOG).map(([sku,amountMinor])=>({sku,amountMinor,currency:'USD',
      creditAmount:(BigInt(amountMinor)*10000000000n).toString(),offlineOnly:true,paymentEnabled:false}))),
    async create(scope,{idempotencyKey,sku}={}){
      const key=parse(uuid,idempotencyKey),product=parse(skuSchema,sku);
      return userTx(scope,'PURCHASE_CREATE',async(t,s)=>{
        const prior=await t.purchaseByKey(s,key);
        if(prior){if(prior.sku!==product)fail('CREDIT_CONFLICT');return view(prior);}
        const w=await t.wallet(s,walletId(s));
        if(w&&(verifyWallet(w,s).pendingReversals??0)>0)fail('CREDIT_WALLET_RESTRICTED');
        const at=clock(),amountMinor=CATALOG[product],p={_id:randomUUID(),...owner(s),idempotencyKey:key,
          sku:product,currency:'USD',amountMinor,creditAmount:(BigInt(amountMinor)*10000000000n).toString(),
          catalogVersion:'fixture-purchase-v1',provider:'FIXTURE',paymentId:null,revision:1,status:'CREATED',
          credited:false,reversalPending:false,fullReversalVerified:false,createdAtMs:at,updatedAtMs:at};
        await t.createPurchase(p);return view(p);
      });
    },
    async status(scope,purchaseId){
      const key=parse(uuid,purchaseId);
      return userTx(scope,'PURCHASE_STATUS',async(t,s)=>{
        const p=await t.purchase(key);if(!owns(p,s))fail('CREDIT_PURCHASE_UNAVAILABLE');return view(p);
      });
    },
    async applySignedEvent(input){
      assertIsolated();const e=verifier.verify(input);
      await permit(authorizeWebhook,{operation:'PAYMENT_EVENT',provider:'FIXTURE',purchaseId:e.purchaseId,eventId:e.eventId});
      return store.transaction(async t=>{
        const at=clock(),p=await t.purchase(e.purchaseId);
        if(!p||p.provider!=='FIXTURE')fail('CREDIT_PURCHASE_UNAVAILABLE');
        const eventKey=digest(['fixture-payment-event-v1',e.eventId]),old=await t.paymentEvent(eventKey);
        if(old){
          if(old.payloadDigest!==e.payloadDigest||old.purchaseId!==p._id)fail('CREDIT_CONFLICT');
          return freeze({purchase:view(p),replayed:true,originalResultStatus:old.resultStatus});
        }
        if(p.paymentId!==null&&p.paymentId!==e.paymentId)fail('CREDIT_PAYMENT_ID_MISMATCH');
        let next={...p,paymentId:e.paymentId};
        if(e.type==='CAPTURED'){
          // Sticky review and reversal states cannot be turned into fresh credits
          // by a later capture, regardless of delivery order.
          if(!p.credited&&p.status==='CREATED'){
            if(e.currency!==p.currency||e.amountMinor!==p.amountMinor)next.status='REVIEW_REQUIRED';
            else{
              await walletChange(t,p,'PURCHASE_CREDIT',n(p.creditAmount),0,at);
              next={...next,status:'CREDITED',credited:true};
            }
          }else if(p.credited&&e.amountMinor!==p.amountMinor&&p.status==='CREDITED'){
            await walletChange(t,p,'PAYMENT_REVERSAL_HOLD',0n,1,at);
            next={...next,status:'REVERSAL_PENDING',reversalPending:true};
          }
        }else if(!['REVERSED','REVERSED_UNFUNDED'].includes(p.status)){
          const full=e.currency===p.currency&&e.amountMinor===p.amountMinor;
          if(!p.credited){
            next.status=full?'REVERSED_UNFUNDED':'REVIEW_REQUIRED';
            next.fullReversalVerified=full;
          }else if(full||p.fullReversalVerified){
            next=await applyFullReversal(t,{...next,fullReversalVerified:true},at);
          }else{
            if(!p.reversalPending)await walletChange(t,p,'PAYMENT_REVERSAL_HOLD',0n,1,at);
            next={...next,status:'REVERSAL_PENDING',reversalPending:true};
          }
        }
        next={...next,revision:p.revision+1,updatedAtMs:at};
        await t.updatePurchase(owner(p),p,next);
        await t.appendPaymentEvent({_id:eventKey,eventId:e.eventId,purchaseId:p._id,...owner(p),provider:'FIXTURE',
          payloadDigest:e.payloadDigest,type:e.type,paymentId:e.paymentId,currency:e.currency,
          amountMinor:e.amountMinor,resultStatus:next.status,receivedAtMs:at});
        return freeze({purchase:view(next),replayed:false,originalResultStatus:next.status});
      });
    },
    // Only a previously verified full reversal can be recovered automatically.
    // Partial/mismatched evidence stays restricted; no manual arbitrary debit.
    async reconcileFullReversal(purchaseId){
      assertIsolated();const key=parse(uuid,purchaseId);
      await permit(authorizeWebhook,{operation:'RECONCILE_FULL_REVERSAL',provider:'FIXTURE',purchaseId:key});
      return store.transaction(async t=>{
        const p=await t.purchase(key);if(!p)fail('CREDIT_PURCHASE_UNAVAILABLE');
        if(p.status==='REVERSED')return view(p);
        if(p.status!=='REVERSAL_PENDING'||!p.fullReversalVerified)fail('CREDIT_PURCHASE_STATE_INVALID');
        const at=clock(),next=await applyFullReversal(t,p,at);
        if(next.status===p.status)return view(p);
        const saved={...next,revision:p.revision+1,updatedAtMs:at};
        await t.updatePurchase(owner(p),p,saved);return view(saved);
      });
    },
  });
}
module.exports={createIsolatedPurchaseService};
