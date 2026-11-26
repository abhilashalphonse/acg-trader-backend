'use strict';
const mongoose=require('mongoose');
const {AiProviderConnection,AiCredentialAudit}=require('./credential-vault.model');
const projection='_id tenantId actorId providerId revision status generation changedAt revokedAt';
const read=q=>q.read('primary').readConcern('majority').maxTimeMS(2000).lean();
const match=s=>({tenantId:s.tenantId,actorId:s.actorId});
function safeFailure(code){return Object.assign(Error('Credential store unavailable'),{code});}
function createCredentialVaultStore(){
  return Object.freeze({
    async list(scope){
      try{return await read(AiProviderConnection.find(match(scope)).select(projection).sort({providerId:1}).limit(5));}
      catch{throw safeFailure('CREDENTIAL_STORE_FAILED');}
    },
    async get(scope,connectionId,includeEnvelope=false){
      try{return await read(AiProviderConnection.findOne({...match(scope),_id:connectionId})
        .select(projection+(includeEnvelope?' +envelope':'')));}
      catch{throw safeFailure('CREDENTIAL_STORE_FAILED');}
    },
    async commit({scope,previous,next,event}){
      let session;
      try{
        session=await mongoose.startSession();
        await session.withTransaction(async()=>{
          if(previous===null){
            await AiProviderConnection.create([next],{session});
          }else{
            const {revision,status,generation,envelope,changedAt,revokedAt}=next;
            const res=await AiProviderConnection.updateOne({...match(scope),_id:next._id,providerId:next.providerId,
              revision:previous.revision,status:previous.status,generation:previous.generation},
              {$set:{revision,status,generation,envelope,changedAt,revokedAt}},
              {session,runValidators:true,maxTimeMS:2000});
            if(res.matchedCount!==1)throw safeFailure('CREDENTIAL_CONFLICT');
          }
          await AiCredentialAudit.create([event],{session});
        },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary',maxCommitTimeMS:2000});
      }catch(e){
        // Never propagate raw DB/validation errors containing secret material.
        throw safeFailure(e?.code===11000||e?.code==='CREDENTIAL_CONFLICT'?'CREDENTIAL_CONFLICT':'CREDENTIAL_STORE_FAILED');
      }finally{if(session)await session.endSession();}
    },
  });
}
module.exports={createCredentialVaultStore};
