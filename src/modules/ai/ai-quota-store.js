'use strict';
const mongoose=require('mongoose');
const schema=new mongoose.Schema({
  _id:{type:String,required:true},
  count:{type:Number,required:true},
  expiresAt:{type:Date,required:true},
},{versionKey:false,strict:'throw',autoIndex:false});
schema.index({expiresAt:1},{expireAfterSeconds:0});
const AiQuotaBucket=mongoose.models.AiQuotaBucket||mongoose.model('AiQuotaBucket',schema);
function createAiQuotaStore(){
  return Object.freeze({
    async consume({key,limit,expiresAt}){
      // _id uniqueness plus atomic conditional increment prevents oversubscription
      // across replicas. Concurrent initial inserts may race; retry update only.
      const filter={_id:key,count:mongoose.trusted({$lt:limit})};
      const opts={maxTimeMS:2000,writeConcern:{w:'majority',wtimeout:2000}};
      try{
        const r=await AiQuotaBucket.updateOne(filter,{$inc:{count:1},$setOnInsert:{expiresAt}},{...opts,upsert:true,setDefaultsOnInsert:false});
        return r.modifiedCount===1||r.upsertedCount===1;
      }catch(error){
        if(error?.code!==11000)throw error;
        const r=await AiQuotaBucket.updateOne(filter,{$inc:{count:1}},opts);
        return r.modifiedCount===1;
      }
    },
  });
}
module.exports={AiQuotaBucket,createAiQuotaStore};
