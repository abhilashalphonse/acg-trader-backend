'use strict';
const mongoose=require('mongoose');
const {Schema}=mongoose;
const id={type:String,required:true,match:/^[a-f0-9]{24}$/};
const hash={type:String,required:true,match:/^[a-f0-9]{64}$/};
const uuid={type:String,required:true,match:/^[a-f0-9-]{36}$/};
const amount={type:String,required:true,match:/^(0|[1-9][0-9]{0,23})$/};
const revision={type:Number,required:true,min:0,validate:Number.isSafeInteger};
const time={type:Number,required:true,min:1,validate:Number.isSafeInteger};
const options={strict:'throw',versionKey:false,autoCreate:false,autoIndex:false,writeConcern:{w:'majority'}};
const walletSchema=new Schema({_id:hash,tenantId:id,actorId:id,
  available:amount,reserved:amount,spent:amount,credited:amount,revision},options);
walletSchema.index({tenantId:1,actorId:1},{unique:true});
const reservationSchema=new Schema({_id:hash,tenantId:id,actorId:id,sessionId:id,accountId:id,
  idempotencyKey:uuid,requestId:uuid,requestFingerprint:hash,revision,
  status:{type:String,required:true,enum:['RESERVED','DISPATCHED','RECONCILIATION_REQUIRED','SETTLED','RELEASED']},
  amount,charged:{...amount,default:'0'},attemptId:{type:String,default:null,match:/^[a-f0-9-]{36}$/},
  requestMeta:{type:String,required:true,maxlength:4096},pricingSnapshot:{type:String,required:true,maxlength:16384},
  createdAtMs:time,expiresAtMs:time,updatedAtMs:time,usageDigest:{type:String,default:null,match:/^[a-f0-9]{64}$/},
  reason:{type:String,default:null,enum:[null,'EXPIRED_BEFORE_DISPATCH','CANCELLED_BEFORE_DISPATCH','OUTCOME_UNKNOWN','USAGE_UNCERTAIN','RECOVERED_AMBIGUOUS','VERIFIED_USAGE']},
},options);
reservationSchema.index({tenantId:1,actorId:1,idempotencyKey:1},{unique:true});
reservationSchema.index({requestId:1},{unique:true});
reservationSchema.index({tenantId:1,actorId:1,status:1,expiresAtMs:1});
const eventSchema=new Schema({_id:hash,tenantId:id,actorId:id,walletId:hash,
  reservationId:{type:String,default:null,match:/^[a-f0-9]{64}$/},
  operation:{type:String,required:true,enum:['FIXTURE_CREDIT','RESERVE','DISPATCH','HOLD','SETTLE','RELEASE']},
  reference:{type:String,required:true,maxlength:64},revision,amount,available:amount,reserved:amount,spent:amount,credited:amount,
  occurredAtMs:time},options);
eventSchema.index({walletId:1,revision:1},{unique:true});
function immutable(next){next(Error('Credit journal is append-only'));}
eventSchema.pre('save',function(next){if(this.isNew)return next();immutable(next);});
for(const op of ['updateOne','updateMany','findOneAndUpdate','replaceOne','findOneAndReplace','deleteMany','findOneAndDelete','bulkWrite'])eventSchema.pre(op,immutable);
eventSchema.pre('deleteOne',{document:true,query:true},immutable);
const AiCreditWallet=mongoose.models.AiCreditWallet||mongoose.model('AiCreditWallet',walletSchema);
const AiCreditReservation=mongoose.models.AiCreditReservation||mongoose.model('AiCreditReservation',reservationSchema);
const AiCreditJournal=mongoose.models.AiCreditJournal||mongoose.model('AiCreditJournal',eventSchema);
module.exports={AiCreditWallet,AiCreditReservation,AiCreditJournal};
