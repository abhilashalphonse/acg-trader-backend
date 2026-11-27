'use strict';
// Unmounted production-readiness primitives. No network, trading, payment, or
// credential access. Use majority-committed transactions on a replica set.
const mongoose=require('mongoose');
const {Schema}=mongoose;
const id={type:String,required:true,match:/^[a-f0-9]{24}$/};
const hash={type:String,required:true,match:/^[a-f0-9]{64}$/};
const uuid={type:String,required:true,match:/^[a-f0-9-]{36}$/};
const int={type:Number,required:true,min:0,validate:Number.isSafeInteger};
const options={strict:'throw',versionKey:false,autoIndex:false,autoCreate:false};
const control=new Schema({_id:id,enabled:{type:Boolean,required:true},revision:int,fence:int,
  tenantDailyPicoUsd:int,actorDailyPicoUsd:int,tenantDailyRequests:int,actorDailyRequests:int},options);
const consent=new Schema({_id:hash,tenantId:id,actorId:id,sessionId:id,accountId:id,connectionId:uuid,
  revision:int,fence:int,active:{type:Boolean,required:true},expiresAtMs:int,
  descriptorId:hash,policyVersion:hash,symbol:{type:String,required:true,match:/^[A-Z0-9._-]{1,32}$/},
  timeframe:{type:String,required:true,enum:['1m','5m','15m','30m','1h','4h','1d','1w']}},options);
const budget=new Schema({_id:hash,tenantId:id,actorId:{type:String,default:null,match:/^[a-f0-9]{24}$/},
  day:{type:String,required:true,match:/^\d{4}-\d{2}-\d{2}$/},requests:int,reservedPicoUsd:int,settledPicoUsd:int},options);
const attempt=new Schema({_id:hash,tenantId:id,actorId:id,sessionId:id,accountId:id,connectionId:uuid,
  operationId:uuid,consentId:hash,consentRevision:int,controlRevision:int,descriptorId:hash,policyVersion:hash,
  day:{type:String,required:true,match:/^\d{4}-\d{2}-\d{2}$/},
  reservedPicoUsd:int,inputRatePicoUsd:int,outputRatePicoUsd:int,maxInputTokens:int,maxOutputTokens:int,
  state:{type:String,required:true,enum:['CLAIMED','DISPATCHING','HELD_UNKNOWN','SETTLED','NOT_SENT']},
  inputTokens:{type:Number,default:null,min:0,validate:v=>v===null||Number.isSafeInteger(v)},
  outputTokens:{type:Number,default:null,min:0,validate:v=>v===null||Number.isSafeInteger(v)},
  actualPicoUsd:{type:Number,default:null,min:0,validate:v=>v===null||Number.isSafeInteger(v)},
  evidenceId:{type:String,default:null,match:/^[a-f0-9]{64}$/},
  createdAtMs:int,updatedAtMs:int},options);
const event=new Schema({_id:uuid,tenantId:id,actorId:id,kind:{type:String,required:true,enum:['CONTROL','CONSENT','REVOKE','CLAIM','DISPATCH','UNKNOWN','SETTLE','NOT_SENT']},
  subject:{type:String,required:true,maxlength:64},revision:int,atMs:int},options);
consent.index({tenantId:1,actorId:1,accountId:1,sessionId:1});
budget.index({tenantId:1,day:1,actorId:1},{unique:true});
attempt.index({tenantId:1,actorId:1,accountId:1,operationId:1},{unique:true});
attempt.index({tenantId:1,state:1,updatedAtMs:1});
event.index({tenantId:1,atMs:-1});
const model=(n,s)=>mongoose.models[n]||mongoose.model(n,s);
const LiveControl=model('AiLiveControl',control),LiveConsent=model('AiLiveConsent',consent),
  LiveBudget=model('AiLiveBudget',budget),LiveAttempt=model('AiLiveAttempt',attempt),LiveEvent=model('AiLiveEvent',event);
const models=[LiveControl,LiveConsent,LiveBudget,LiveAttempt,LiveEvent];
module.exports={LiveControl,LiveConsent,LiveBudget,LiveAttempt,LiveEvent,models};
