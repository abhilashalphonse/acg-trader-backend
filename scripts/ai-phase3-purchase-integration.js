'use strict';
const assert=require('node:assert/strict');
const {randomUUID,createHmac}=require('node:crypto');
const {createIsolatedCreditStore,assertIsolated}=require('../src/modules/ai/providers/credit-ledger-store');
const {createIsolatedCreditLedger}=require('../src/modules/ai/providers/credit-ledger');
const {AiCreditWallet,AiCreditJournal}=require('../src/modules/ai/providers/credit-ledger.model');
const {AiCreditPurchase,AiCreditPaymentEvent}=require('../src/modules/ai/providers/credit-purchase.model');
const {createFixturePaymentVerifier}=require('../src/modules/ai/providers/fixture-payment-verifier');
const {createIsolatedPurchaseService}=require('../src/modules/ai/providers/credit-purchase');
const {createModelRegistry}=require('../src/modules/ai/providers/model-registry');
const {createOfflineRequest}=require('../src/modules/ai/providers/provider-contract');
const {createPricingRegistry}=require('../src/modules/ai/providers/compute-pricing');
const {compilePromptPackage}=require('../src/modules/ai/intelligence/prompt-compiler');

async function runPhase3PurchaseIntegration({auth,token,foreignToken,accountId,foreignAccountId}){
  assertIsolated();
  const store=createIsolatedCreditStore();
  for(const [model,keys] of [[AiCreditPurchase,{tenantId:1,actorId:1,idempotencyKey:1}],
    [AiCreditPurchase,{provider:1,paymentId:1}],[AiCreditPaymentEvent,{provider:1,eventId:1}]]){
    assert.ok((await model.collection.indexes()).some(i=>i.unique&&JSON.stringify(i.key)===JSON.stringify(keys)));
  }
  async function scopeOf(t,a){const p=await auth.authenticateSessionToken(t);assert.equal(p.authMethod,'SUPABASE');
    return {tenantId:p.tenantId,actorId:p.userId,sessionId:p.sessionId,accountId:String(a)};}
  const s=await scopeOf(token,accountId),foreign=await scopeOf(foreignToken,foreignAccountId);
  let active=token,activeAccount=accountId,webhookAllowed=true,now=Date.UTC(2026,0,1);
  const secret=Buffer.alloc(32,71);
  const authorize=async req=>{try{const p=await scopeOf(active,activeAccount);
    return Object.keys(p).every(k=>p[k]===req.scope[k]);}catch{return false;}};
  const authorizeWebhook=async req=>webhookAllowed&&req.provider==='FIXTURE';
  const service=()=>createIsolatedPurchaseService({store,
    verifier:createFixturePaymentVerifier({secret,now:()=>now}),authorize,authorizeWebhook,now:()=>now});
  const p=service(),l=createIsolatedCreditLedger({store,authorize,now:()=>now});
  const sign=(event,timestamp=String(now))=>{
    const rawBody=Buffer.from(JSON.stringify(event));
    return {rawBody,timestamp,signature:createHmac('sha256',secret).update(timestamp+'.').update(rawBody).digest('hex')};
  };
  const event=(purchase,paymentId,type='CAPTURED',amountMinor=purchase.amountMinor,eventId=randomUUID())=>
    ({eventId,purchaseId:purchase.purchaseId,paymentId,type,currency:'USD',amountMinor});
  const send=e=>p.applySignedEvent(sign(e));
  const create=(scope,sku='FIXTURE_5',idempotencyKey=randomUUID())=>p.create(scope,{sku,idempotencyKey});
  const original=await l.balance(s);
  const check=async(scope,available,reserved,spent,credited,pending,reversed)=>{
    const w=await l.balance(scope);
    assert.deepEqual([w.available,w.reserved,w.spent,w.credited,w.pendingReversals,w.reversed],
      [available,reserved,spent,credited,pending,reversed]);
    assert.equal(BigInt(w.available)+BigInt(w.reserved)+BigInt(w.spent),BigInt(w.credited));
  };
  const key=randomUUID(),purchase=await create(s,'FIXTURE_5',key);
  assert.equal(purchase.status,'CREATED');assert.equal(purchase.amountMinor,'500');
  assert.equal(purchase.creditAmount,'5000000000000');assert.equal(purchase.paymentEnabled,false);
  assert.equal((await create(s,'FIXTURE_5',key)).purchaseId,purchase.purchaseId);
  await assert.rejects(create(s,'FIXTURE_10',key),{code:'CREDIT_CONFLICT'});
  assert.deepEqual(await l.balance(s),original);
  const capture=event(purchase,'fixture-payment-a');
  await assert.rejects(p.applySignedEvent({...sign(capture),signature:'0'.repeat(64)}),{code:'CREDIT_PAYMENT_SIGNATURE_INVALID'});
  await assert.rejects(p.applySignedEvent(sign(capture,String(now-300001))),{code:'CREDIT_PAYMENT_SIGNATURE_INVALID'});
  await assert.rejects(p.applySignedEvent(sign({...capture,tenantId:s.tenantId})),{code:'CREDIT_PAYMENT_EVENT_INVALID'});
  webhookAllowed=false;
  await assert.rejects(send(capture),{code:'CREDIT_PURCHASE_FORBIDDEN'});
  webhookAllowed=true;
  assert.deepEqual(await l.balance(s),original);
  const race=await Promise.allSettled([send(capture),service().applySignedEvent(sign(capture))]);
  assert.ok(race.some(x=>x.status==='fulfilled'&&x.value.purchase.status==='CREDITED'));
  assert.ok(race.every(x=>x.status==='fulfilled'||x.reason.code==='CREDIT_CONFLICT'));
  const credited=await send(capture);assert.equal(credited.replayed,true);
  const credit=BigInt(purchase.creditAmount);
  const fundedAvailable=(BigInt(original.available)+credit).toString();
  const fundedCredited=(BigInt(original.credited)+credit).toString();
  await check(s,fundedAvailable,original.reserved,original.spent,fundedCredited,0,original.reversed);
  await send(event(purchase,'fixture-payment-a'));
  await check(s,fundedAvailable,original.reserved,original.spent,fundedCredited,0,original.reversed);
  await assert.rejects(send({...capture,amountMinor:'499'}),{code:'CREDIT_CONFLICT'});
  const reused=await create(s);
  await assert.rejects(send(event(reused,'fixture-payment-a')),{code:'CREDIT_CONFLICT'});
  assert.equal((await p.status(s,reused.purchaseId)).status,'CREATED');
  await check(s,fundedAvailable,original.reserved,original.spent,fundedCredited,0,original.reversed);
  const refund=event(purchase,'fixture-payment-a','REFUNDED');
  assert.equal((await send(refund)).purchase.status,'REVERSED');
  assert.equal((await send(refund)).replayed,true);
  assert.equal((await send(event(purchase,'fixture-payment-a','CHARGEBACK'))).purchase.status,'REVERSED');
  await check(s,original.available,original.reserved,original.spent,original.credited,0,(BigInt(original.reversed)+credit).toString());
  // Out-of-order full reversal must block late capture.
  const reversedFirst=await create(s);
  assert.equal((await send(event(reversedFirst,'fixture-reverse-first','REFUNDED'))).purchase.status,'REVERSED_UNFUNDED');
  assert.equal((await send(event(reversedFirst,'fixture-reverse-first'))).purchase.status,'REVERSED_UNFUNDED');
  const underpaid=await create(s);
  assert.equal((await send(event(underpaid,'fixture-underpaid','CAPTURED','499'))).purchase.status,'REVIEW_REQUIRED');
  assert.equal((await send(event(underpaid,'fixture-underpaid'))).purchase.status,'REVIEW_REQUIRED');
  await check(s,original.available,original.reserved,original.spent,original.credited,0,(BigInt(original.reversed)+credit).toString());
  const contradictory=await create(s);
  await send(event(contradictory,'fixture-contradictory','CAPTURED','501'));
  assert.equal((await send(event(contradictory,'fixture-contradictory','REFUNDED'))).purchase.conflictReview,true);
  assert.equal((await p.status(s,contradictory.purchaseId)).status,'REVIEW_REQUIRED');
  await check(s,original.available,original.reserved,original.spent,original.credited,0,(BigInt(original.reversed)+credit).toString());
  // Cross-owner checkout status and payment ID cannot be reused.
  active=foreignToken;activeAccount=foreignAccountId;
  await assert.rejects(p.status(s,purchase.purchaseId),{code:'CREDIT_PURCHASE_FORBIDDEN'});
  await assert.rejects(p.status(foreign,purchase.purchaseId),{code:'CREDIT_PURCHASE_UNAVAILABLE'});
  const f=await create(foreign);
  await assert.rejects(send(event(f,'fixture-payment-a')),{code:'CREDIT_CONFLICT'});
  assert.equal((await p.status(foreign,f.purchaseId)).status,'CREATED');
  assert.equal((await l.balance(foreign)).credited,'0');
  await send(event(f,'fixture-payment-foreign'));
  const selection={providerId:'openai',modelId:'fixture-payment-ledger',fundingMode:'ACG_CREDITS'};
  const registry=createModelRegistry({allowSynthetic:true,descriptors:[{
    providerId:selection.providerId,modelId:selection.modelId,revision:'fixture-1',reviewStatus:'SYNTHETIC_TEST_ONLY',
    fundingModes:['ACG_CREDITS'],capabilities:{input:'TEXT',responseMode:'JSON_OBJECT',separateInstructionChannel:true,
      streaming:false,usageReporting:'PROVIDER_REPORTED',maxContextTokens:8192,maxOutputTokens:2048}}]});
  const model=registry.resolveForOfflineTest(selection);
  const prices=createPricingRegistry({allowSynthetic:true,prices:[{providerId:model.providerId,modelId:model.modelId,
    descriptorId:model.descriptorId,revision:'fixture-price',effectiveFromMs:now-1,effectiveUntilMs:null,
    currency:'USD',rateUnit:'MICRO_USD_PER_MILLION_TOKENS',reviewStatus:'SYNTHETIC_TEST_ONLY',source:'OFFLINE_FIXTURE',additionalFees:'NONE_SYNTHETIC',
    input:{standard:'1000000',cacheRead:null,cacheWriteMode:'NONE',cacheWrite:null,cacheWrite5m:null,cacheWrite1h:null},
    output:{standard:'2000000',reasoning:null}}]});
  const req=()=>{const q=createOfflineRequest({registry,selection,prompt:compilePromptPackage({scope:foreign,profile:'EDUCATION',
    question:'Fixture purchase acceptance',nowMs:now}),inputTokenUpperBound:100,maxOutputTokens:50,nowMs:now});
    return {q,snapshot:prices.pin(q,now),key:randomUUID()};};
  const hold=req();await l.reserve(foreign,hold.key,hold.q,hold.snapshot);
  const partial=event(f,'fixture-payment-foreign','REFUNDED','200');
  assert.equal((await send(partial)).purchase.status,'REVERSAL_PENDING');
  assert.equal((await send(partial)).replayed,true);
  assert.equal((await l.balance(foreign)).pendingReversals,1);
  await assert.rejects(p.reconcileFullReversal(f.purchaseId),{code:'CREDIT_PURCHASE_STATE_INVALID'});
  const other=req();await assert.rejects(l.reserve(foreign,other.key,other.q,other.snapshot),{code:'CREDIT_WALLET_RESTRICTED'});
  await assert.rejects(l.claimDispatch(foreign,hold.key),{code:'CREDIT_WALLET_RESTRICTED'});
  await assert.rejects(create(foreign),{code:'CREDIT_WALLET_RESTRICTED'});
  assert.equal((await send(event(f,'fixture-payment-foreign','CHARGEBACK'))).purchase.status,'REVERSAL_PENDING');
  assert.equal((await l.balance(foreign)).pendingReversals,1);
  assert.equal((await p.reconcileFullReversal(f.purchaseId)).status,'REVERSAL_PENDING');
  await l.releaseBeforeDispatch(foreign,hold.key);
  assert.equal((await service().reconcileFullReversal(f.purchaseId)).status,'REVERSED');
  assert.equal((await p.reconcileFullReversal(f.purchaseId)).status,'REVERSED');
  await check(foreign,'0','0','0','0',0,'5000000000000');
  // Confirm existing spent credits cannot be reversed into a negative wallet.
  const spentPurchase=await create(foreign);
  await send(event(spentPurchase,'fixture-payment-spent'));
  const used=req();await l.reserve(foreign,used.key,used.q,used.snapshot);
  const claim=await l.claimDispatch(foreign,used.key);
  const usage={status:'PROVIDER_REPORTED',inputTokens:20,outputTokens:10,totalTokens:30,cachedInputTokens:null,reasoningOutputTokens:null};
  await l.recordOutcome(foreign,used.key,{attemptId:claim.attemptId,requestId:used.q.requestId,status:'COMPLETED',usage});
  assert.equal((await send(event(spentPurchase,'fixture-payment-spent','CHARGEBACK'))).purchase.status,'REVERSAL_PENDING');
  assert.equal((await p.reconcileFullReversal(spentPurchase.purchaseId)).status,'REVERSAL_PENDING');
  await check(foreign,'4999960000000','0','40000000','5000000000000',1,'5000000000000');
  const conflict=await send(event(spentPurchase,'fixture-payment-spent','REFUNDED','501'));
  assert.equal(conflict.purchase.conflictReview,true);
  await assert.rejects(p.reconcileFullReversal(spentPurchase.purchaseId),{code:'CREDIT_PURCHASE_STATE_INVALID'});
  assert.equal((await l.balance(foreign)).pendingReversals,1);
  // Verify journal and payment event atomicity, immutable events, no secrets.
  const journal=await AiCreditJournal.find({tenantId:foreign.tenantId,actorId:foreign.actorId}).sort({revision:1}).lean();
  assert.equal(journal.filter(e=>e.operation==='PURCHASE_CREDIT').length,2);
  assert.equal(journal.filter(e=>e.operation==='PAYMENT_REVERSAL').length,1);
  assert.ok(journal.every(e=>BigInt(e.available)+BigInt(e.reserved)+BigInt(e.spent)===BigInt(e.credited)));
  const paymentEvents=await AiCreditPaymentEvent.find({purchaseId:purchase.purchaseId}).lean();
  assert.equal(paymentEvents.filter(e=>e.eventId===capture.eventId).length,1);
  assert.ok(paymentEvents.every(e=>!Object.hasOwn(e,'rawBody')&&!Object.hasOwn(e,'signature')));
  await assert.rejects(AiCreditPaymentEvent.updateOne({_id:paymentEvents[0]._id},{$set:{amountMinor:'0'}}),/append-only/);
  // Force journal failure AFTER a wallet CAS: the transaction must roll back.
  const wallet=await AiCreditWallet.findOne({tenantId:foreign.tenantId,actorId:foreign.actorId}).lean();
  await assert.rejects(store.transaction(async t=>{
    await t.updateWallet(foreign,wallet,{...wallet,revision:wallet.revision+1});
    await t.append(journal[0]);
  }),{code:'CREDIT_CONFLICT'});
  assert.equal((await l.balance(foreign)).revision,wallet.revision);
  console.log('PASS Phase 3 purchases signed events, atomic credits, event/payment replay, reversal holds, out-of-order events, ownership, refund recovery and journal rollback');
}
module.exports={runPhase3PurchaseIntegration};
