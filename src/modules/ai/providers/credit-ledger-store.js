'use strict';
const mongoose=require('mongoose');
const {AiCreditWallet,AiCreditReservation,AiCreditJournal}=require('./credit-ledger.model');
const {AiCreditPurchase,AiCreditPaymentEvent}=require('./credit-purchase.model');
const models=[AiCreditWallet,AiCreditReservation,AiCreditJournal,AiCreditPurchase,AiCreditPaymentEvent];
// Deliberately inaccessible outside the existing isolated replica-set CI.
function assertIsolated(){
  if(process.env.NODE_ENV!=='test'||process.env.ACG_AI_ISOLATED_CI!=='true'||
    !/^acg_ai_ci_[a-f0-9]{24}$/.test(mongoose.connection.name)||
    mongoose.connection.host!=='127.0.0.1'||mongoose.connection.readyState!==1)
    throw Object.assign(Error('Credit ledger isolated database required'),{code:'CREDIT_LEDGER_DISABLED'});
}
function fail(code){throw Object.assign(Error('Credit ledger store unavailable'),{code});}
const owner=s=>({tenantId:s.tenantId,actorId:s.actorId});
function createIsolatedCreditStore(){
  assertIsolated();
  return Object.freeze({
    async provision(){assertIsolated();for(const m of models){await m.createCollection();await m.createIndexes();}},
    async transaction(work){
      assertIsolated();let session;
      try{
        session=await mongoose.startSession();
        let result;
        await session.withTransaction(async()=>{
          const query=(m,filter)=>m.findOne(filter).session(session).maxTimeMS(2000).lean();
          const update=async(m,previous,next,scope)=>{
            const {_id,...fields}=next;
            const r=await m.updateOne({_id:previous._id,...owner(scope),revision:previous.revision},
              {$set:fields},{session,runValidators:true,maxTimeMS:2000});
            if(r.matchedCount!==1)fail('CREDIT_CONFLICT');
          };
          result=await work(Object.freeze({
            wallet:(s,id)=>query(AiCreditWallet,{_id:id,...owner(s)}),
            reservation:(s,id)=>query(AiCreditReservation,{_id:id,...owner(s)}),
            journal:(s,id)=>query(AiCreditJournal,{_id:id,...owner(s)}),
            purchase:(id)=>query(AiCreditPurchase,{_id:id}),
            purchaseByKey:(s,key)=>query(AiCreditPurchase,{...owner(s),idempotencyKey:key}),
            paymentEvent:(id)=>query(AiCreditPaymentEvent,{_id:id}),
            createPurchase:async d=>{await AiCreditPurchase.create([d],{session});},
            updatePurchase:(s,p,n)=>update(AiCreditPurchase,p,n,s),
            appendPaymentEvent:async d=>{await AiCreditPaymentEvent.create([d],{session});},
            createWallet:async d=>{await AiCreditWallet.create([d],{session});},
            createReservation:async d=>{await AiCreditReservation.create([d],{session});},
            updateWallet:(s,p,n)=>update(AiCreditWallet,p,n,s),
            updateReservation:(s,p,n)=>update(AiCreditReservation,p,n,s),
            append:async d=>{await AiCreditJournal.create([d],{session});},
          }));
        },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary',maxCommitTimeMS:2000});
        return result;
      }catch(e){
        if(e?.code===11000)fail('CREDIT_CONFLICT');
        if(typeof e?.code==='string'&&/^CREDIT_[A-Z_]+$/.test(e.code))fail(e.code);
        fail('CREDIT_STORE_UNCERTAIN');
      }finally{if(session)await session.endSession();}
    },
  });
}
module.exports={createIsolatedCreditStore,assertIsolated};
