'use strict';
const mongoose=require('mongoose');
const {createHash}=require('node:crypto');
const {AiConversationBucket}=require('./ai-conversation.model');
const {assertIsolated}=require('./providers/credit-ledger-store');
const {AppError}=require('../../shared/errors/app-error');
const deny=(code,statusCode=503)=>new AppError('AI conversation store unavailable',{code,statusCode});
function owner(scope){
  if(!['tenantId','actorId','sessionId','accountId'].every(k=>typeof scope?.[k]==='string'&&/^[a-f0-9]{24}$/.test(scope[k])))throw deny('AI_CHAT_SCOPE_INVALID',403);
  const {tenantId,actorId,accountId}=scope;
  const _id=createHash('sha256').update(JSON.stringify([tenantId,actorId,accountId])).digest('hex');
  return {_id,tenantId,actorId,accountId};
}
function createIsolatedConversationStore(){
  assertIsolated();
  return Object.freeze({
    async provision(){assertIsolated();await AiConversationBucket.createCollection();await AiConversationBucket.createIndexes();},
    async read(scope){
      assertIsolated();const filter=owner(scope);
      try{return await AiConversationBucket.findOne(filter).read('primary').readConcern('majority').maxTimeMS(2000).lean();}
      catch{throw deny('AI_CHAT_STORE_UNAVAILABLE');}
    },
    // Pure mutation callback; no external actions, no authorization callbacks
    // or side effects inside retryable database work. CAS on one bounded doc.
    async mutate(scope,work){
      assertIsolated();const filter=owner(scope);
      for(let retry=0;retry<12;retry++){
        const current=await this.read(scope);
        const {next,value}=work(current);
        if(next===null)return value;
        const revision=(current?.revision||0)+1;
        const doc={...filter,revision,expiresAt:new Date(Math.max(...next.map(c=>c.expiresAtMs))),conversations:next};
        try{
          if(!current){await AiConversationBucket.create(doc);return value;}
          const result=await AiConversationBucket.replaceOne({...filter,revision:current.revision},doc,
            {runValidators:true,writeConcern:{w:'majority'},maxTimeMS:2000});
          if(result.matchedCount===1)return value;
        }catch(e){
          if(e?.code===11000)continue;
          throw deny('AI_CHAT_STORE_UNCERTAIN');
        }
      }
      throw deny('AI_CHAT_CONFLICT',409);
    },
  });
}
module.exports={createIsolatedConversationStore};
