'use strict';
const mongoose=require('mongoose');
const {Schema}=mongoose;
const id={type:String,required:true,match:/^[a-f0-9]{24}$/};
const uuid={type:String,required:true,match:/^[a-f0-9-]{36}$/};
const time={type:Number,required:true,min:1,validate:Number.isSafeInteger};
const selection=new Schema({providerId:{type:String,required:true,enum:['openai','anthropic','gemini','deepseek','openrouter']},
  modelId:{type:String,required:true,maxlength:160},descriptorId:{type:String,required:true,match:/^[a-f0-9]{64}$/},
  fundingMode:{type:String,required:true,enum:['BYO_API']}},{_id:false,strict:'throw'});
const message=new Schema({messageId:uuid,sequence:{type:Number,required:true,min:1,max:16,validate:Number.isSafeInteger},
  text:{type:String,required:true,validate:v=>Buffer.byteLength(v,'utf8')<=4096},
  status:{type:String,required:true,enum:['STORED_OFFLINE','CANCELLED']},createdAtMs:time,updatedAtMs:time},{_id:false,strict:'throw'});
const workspace=new Schema({symbol:{type:String,required:true,match:/^[A-Z0-9._-]{1,32}$/},
  timeframe:{type:String,required:true,enum:['1m','5m','15m','30m','1h','4h','1d','1w']},
  includeChartContext:{type:Boolean,required:true,validate:v=>v===true}},{_id:false,strict:'throw'});
const conversation=new Schema({conversationId:uuid,status:{type:String,required:true,enum:['ACTIVE','DELETED']},
  selection:{type:selection,default:null},profile:{type:String,enum:['EDUCATION','MARKET_OVERVIEW','STRUCTURE',null],default:null},workspace:{type:workspace,default:null},
  createdAtMs:time,updatedAtMs:time,expiresAtMs:time,
  messages:{type:[message],required:true,validate:v=>v.length<=16}},{_id:false,strict:'throw'});
const bucket=new Schema({_id:{type:String,required:true,match:/^[a-f0-9]{64}$/},tenantId:id,actorId:id,accountId:id,
  generation:uuid,revision:{type:Number,required:true,min:1,validate:Number.isSafeInteger},expiresAt:{type:Date,required:true},
  conversations:{type:[conversation],required:true,validate:v=>v.length<=8}},
  {strict:'throw',versionKey:false,autoCreate:false,autoIndex:false,writeConcern:{w:'majority'}});
bucket.index({tenantId:1,actorId:1,accountId:1},{unique:true});
bucket.index({expiresAt:1},{expireAfterSeconds:0});
const AiConversationBucket=mongoose.models.AiConversationBucket||mongoose.model('AiConversationBucket',bucket);
module.exports={AiConversationBucket};
