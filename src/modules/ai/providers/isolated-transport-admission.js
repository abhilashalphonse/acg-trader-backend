'use strict';
const mongoose=require('mongoose');
const {randomUUID}=require('node:crypto');
const {digest}=require('../intelligence/candle-evidence');
const {assertIsolated}=require('./credit-ledger-store');
const {CONTRACT_VERSION}=require('./provider-contract');
const {Schema}=mongoose;
const id={type:String,required:true,match:/^[a-f0-9]{24}$/};
const uuid={type:String,required:true,match:/^[a-f0-9-]{36}$/};
const hash={type:String,required:true,match:/^[a-f0-9]{64}$/};
const int={type:Number,required:true,min:0,validate:Number.isSafeInteger};
const MAX_ATTEMPTS=16,MAX_TOKENS=100000;
const attemptSchema=new Schema({operationId:uuid,accountId:id,sessionId:id,requestId:uuid,descriptorId:hash,lease:uuid,
  tokens:int,state:{type:String,required:true,enum:['CLAIMED','ACCOUNTED_OFFLINE','HELD_UNKNOWN']},
  outcome:{type:String,default:null,enum:[null,'COMPLETED','REFUSED','INCOMPLETE','FAILED','CANCELLED','UNKNOWN']},
  reportedTokens:{type:Number,default:null,min:0,validate:v=>v===null||Number.isSafeInteger(v)}},
  {_id:false,strict:'throw'});
const ownerSchema=new Schema({_id:hash,tenantId:id,actorId:id,revision:int,
  reservedTokens:int,attempts:{type:[attemptSchema],required:true,validate:v=>v.length<=MAX_ATTEMPTS}},
  {strict:'throw',versionKey:false,autoIndex:false,autoCreate:false,writeConcern:{w:'majority'}});
ownerSchema.index({tenantId:1,actorId:1},{unique:true});
const AiTransportAdmission=mongoose.models.AiTransportAdmission||mongoose.model('AiTransportAdmission',ownerSchema);
const fail=code=>Object.assign(Error('Provider admission unavailable'),{code});
const isId=v=>typeof v==='string'&&/^[a-f0-9]{24}$/.test(v);
const isUuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
function identity(s){
  if(!['tenantId','actorId','sessionId','accountId'].every(k=>isId(s?.[k])))throw fail('TRANSPORT_SCOPE_INVALID');
  return {_id:digest([s.tenantId,s.actorId]),tenantId:s.tenantId,actorId:s.actorId};
}
function validate(q,op){
  if(q?.contractVersion!==CONTRACT_VERSION||q.executionMode!=='OFFLINE_TEST_ONLY'||q.fundingMode!=='BYO_API'||
    !isUuid(q.requestId)||!isUuid(op)||typeof q.descriptorId!=='string'||!/^[a-f0-9]{64}$/.test(q.descriptorId)||
    ![q.budget?.inputTokenUpperBound,q.budget?.maxOutputTokens].every(v=>Number.isSafeInteger(v)&&v>0&&v<=MAX_TOKENS))
    throw fail('TRANSPORT_ADMISSION_INVALID');
}
function createIsolatedTransportAdmission(){
  assertIsolated();
  async function mutate(s,work){
    assertIsolated();const filter=identity(s);
    for(let i=0;i<12;i++){
      let before;
      try{before=await AiTransportAdmission.findOne(filter).read('primary').readConcern('majority').maxTimeMS(2000).lean();}
      catch{throw fail('TRANSPORT_ADMISSION_UNAVAILABLE');}
      const next=structuredClone(before??{...filter,revision:0,reservedTokens:0,attempts:[]});
      const value=work(next);next.revision++;
      try{
        if(!before){await AiTransportAdmission.create(next);return value;}
        const r=await AiTransportAdmission.replaceOne({...filter,revision:before.revision},next,
          {runValidators:true,writeConcern:{w:'majority'},maxTimeMS:2000});
        if(r.matchedCount===1)return value;
      }catch(e){if(e?.code===11000)continue;throw fail('TRANSPORT_ADMISSION_UNCERTAIN');}
    }
    throw fail('TRANSPORT_ADMISSION_CONFLICT');
  }
  return Object.freeze({
    async provision(){assertIsolated();await AiTransportAdmission.createCollection();await AiTransportAdmission.createIndexes();},
    async claim(s,q,operationId){
      validate(q,operationId);
      const lease=randomUUID(),tokens=q.budget.inputTokenUpperBound+q.budget.maxOutputTokens;
      return mutate(s,next=>{
        // Cross-session retry and duplicate operation are denied for the
        // lifetime of the isolated database. Unknown outcomes retain full hold.
        if(next.attempts.some(a=>a.requestId===q.requestId||a.accountId===s.accountId&&a.operationId===operationId))throw fail('TRANSPORT_ALREADY_CLAIMED');
        if(next.attempts.length>=MAX_ATTEMPTS||next.reservedTokens+tokens>MAX_TOKENS)throw fail('TRANSPORT_ADMISSION_LIMIT');
        next.attempts.push({operationId,accountId:s.accountId,sessionId:s.sessionId,requestId:q.requestId,
          descriptorId:q.descriptorId,lease,tokens,state:'CLAIMED',outcome:null,reportedTokens:null});
        next.reservedTokens+=tokens;
        return lease;
      });
    },
    async finish(s,q,operationId,lease,v){
      validate(q,operationId);
      return mutate(s,next=>{
        const a=next.attempts.find(x=>x.requestId===q.requestId&&x.operationId===operationId&&x.accountId===s.accountId&&
          x.sessionId===s.sessionId&&x.lease===lease&&x.descriptorId===q.descriptorId);
        if(!a||a.state!=='CLAIMED')throw fail('TRANSPORT_ADMISSION_INVALID');
        const u=v?.usage,valid=v?.requestId===q.requestId&&v.descriptorId===q.descriptorId&&v.providerId===q.providerId&&v.modelId===q.modelId&&
          ['COMPLETED','REFUSED','INCOMPLETE','FAILED'].includes(v.status)&&v.usageDisposition==='UNSETTLED'&&
          u?.status==='PROVIDER_REPORTED'&&Number.isSafeInteger(u.inputTokens)&&u.inputTokens>=0&&u.inputTokens<=q.budget.inputTokenUpperBound&&
          Number.isSafeInteger(u.outputTokens)&&u.outputTokens>=0&&u.outputTokens<=q.budget.maxOutputTokens&&u.totalTokens===u.inputTokens+u.outputTokens;
        a.state=valid?'ACCOUNTED_OFFLINE':'HELD_UNKNOWN';
        a.outcome=['COMPLETED','REFUSED','INCOMPLETE','FAILED','CANCELLED','UNKNOWN'].includes(v?.status)?v.status:'UNKNOWN';
        a.reportedTokens=valid?u.totalTokens:null;
        if(valid)next.reservedTokens-=a.tokens-u.totalTokens;
        return a.state;
      });
    },
  });
}
module.exports={createIsolatedTransportAdmission,AiTransportAdmission,MAX_ATTEMPTS,MAX_TOKENS};
