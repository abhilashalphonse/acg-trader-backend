'use strict';
const mongoose=require('mongoose');
const {Schema}=mongoose;
const id={type:String,required:true,match:/^[a-f0-9]{24}$/};
const uuid={type:String,required:true,match:/^[a-f0-9-]{36}$/};
const hash={type:String,required:true,match:/^[a-f0-9]{64}$/};
const amount={type:String,required:true,match:/^(0|[1-9][0-9]{0,23})$/};
const time={type:Number,required:true,min:1,validate:Number.isSafeInteger};
const revision={type:Number,required:true,min:1,validate:Number.isSafeInteger};
const options={strict:'throw',versionKey:false,autoCreate:false,autoIndex:false,writeConcern:{w:'majority'}};
const purchaseSchema=new Schema({
  _id:uuid,tenantId:id,actorId:id,idempotencyKey:uuid,revision,
  sku:{type:String,required:true,enum:['FIXTURE_5','FIXTURE_10','FIXTURE_25']},
  currency:{type:String,required:true,enum:['USD']},amountMinor:amount,creditAmount:amount,
  catalogVersion:{type:String,required:true,enum:['fixture-purchase-v1']},
  provider:{type:String,required:true,enum:['FIXTURE']},
  paymentId:{type:String,default:null,match:/^[A-Za-z0-9_-]{1,96}$/},
  status:{type:String,required:true,enum:['CREATED','CREDITED','REVIEW_REQUIRED','REVERSAL_PENDING','REVERSED','REVERSED_UNFUNDED']},
  credited:{type:Boolean,required:true,default:false},
  reversalPending:{type:Boolean,required:true,default:false},
  fullReversalVerified:{type:Boolean,required:true,default:false},
  createdAtMs:time,updatedAtMs:time,
},options);
purchaseSchema.index({tenantId:1,actorId:1,idempotencyKey:1},{unique:true});
purchaseSchema.index({provider:1,paymentId:1},{unique:true,partialFilterExpression:{paymentId:{$type:'string'}}});
purchaseSchema.index({tenantId:1,actorId:1,status:1});
const paymentEventSchema=new Schema({_id:hash,eventId:uuid,purchaseId:uuid,tenantId:id,actorId:id,
  provider:{type:String,required:true,enum:['FIXTURE']},payloadDigest:hash,
  type:{type:String,required:true,enum:['CAPTURED','REFUNDED','CHARGEBACK']},
  paymentId:{type:String,required:true,match:/^[A-Za-z0-9_-]{1,96}$/},
  currency:{type:String,required:true,enum:['USD']},amountMinor:amount,
  resultStatus:{type:String,required:true,enum:['CREDITED','REVIEW_REQUIRED','REVERSAL_PENDING','REVERSED','REVERSED_UNFUNDED']},
  receivedAtMs:time},options);
paymentEventSchema.index({provider:1,eventId:1},{unique:true});
paymentEventSchema.index({purchaseId:1,receivedAtMs:1});
function immutable(next){next(Error('Payment events are append-only'));}
paymentEventSchema.pre('save',function(next){if(this.isNew)return next();immutable(next);});
for(const op of ['updateOne','updateMany','findOneAndUpdate','replaceOne','findOneAndReplace','deleteMany','findOneAndDelete','bulkWrite'])paymentEventSchema.pre(op,immutable);
paymentEventSchema.pre('deleteOne',{document:true,query:true},immutable);
const AiCreditPurchase=mongoose.models.AiCreditPurchase||mongoose.model('AiCreditPurchase',purchaseSchema);
const AiCreditPaymentEvent=mongoose.models.AiCreditPaymentEvent||mongoose.model('AiCreditPaymentEvent',paymentEventSchema);
module.exports={AiCreditPurchase,AiCreditPaymentEvent};
