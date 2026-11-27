'use strict';
const mongoose=require('mongoose');
const {Schema}=mongoose;
const providers=['openai','anthropic','gemini','deepseek','openrouter'];
const ownerId={type:String,required:true,match:/^[a-f0-9]{24}$/};
const hash={type:String,required:true,match:/^[a-f0-9]{64}$/};
const revision={type:Number,required:true,min:1,validate:Number.isSafeInteger};
const box=new Schema({iv:{type:String,required:true,maxlength:16},tag:{type:String,required:true,maxlength:24},
  ciphertext:{type:String,required:true,maxlength:5500}},{_id:false,strict:'throw'});
const envelope=new Schema({version:{type:String,required:true,enum:['aes-256-gcm-envelope-v1']},
  keyId:{type:String,required:true,match:/^[A-Za-z0-9_-]{1,64}$/},wrappedKey:{type:box,required:true},
  secret:{type:box,required:true}},{_id:false,strict:'throw'});
const connectionSchema=new Schema({
  _id:hash,tenantId:{...ownerId,immutable:true},actorId:{...ownerId,immutable:true},
  providerId:{type:String,required:true,enum:providers,immutable:true},
  revision,status:{type:String,required:true,enum:['STORED_UNVERIFIED','REVOKED']},
  generation:{type:String,required:true,match:/^[a-f0-9-]{36}$/},
  envelope:{type:envelope,default:null,select:false},
  changedAt:{type:Date,required:true},revokedAt:{type:Date,default:null},
},{versionKey:false,strict:'throw',autoCreate:false,autoIndex:false,writeConcern:{w:'majority'}});
connectionSchema.index({tenantId:1,actorId:1,providerId:1},{unique:true});
connectionSchema.set('toJSON',{transform:(_doc,value)=>{delete value.envelope;return value;}});
const auditSchema=new Schema({
  _id:{type:String,required:true,maxlength:36},tenantId:ownerId,actorId:ownerId,sessionId:ownerId,
  connectionId:hash,providerId:{type:String,required:true,enum:providers},revision,
  operation:{type:String,required:true,enum:['CONNECT','REPLACE','RECONNECT','REVOKE','REWRAP']},
  occurredAt:{type:Date,required:true},
},{versionKey:false,strict:'throw',autoCreate:false,autoIndex:false,writeConcern:{w:'majority'}});
auditSchema.index({tenantId:1,actorId:1,occurredAt:-1,_id:-1});
function immutable(next){next(Error('Credential audit events are append-only'));}
auditSchema.pre('save',function(next){if(this.isNew)return next();immutable(next);});
for(const op of ['updateOne','updateMany','findOneAndUpdate','replaceOne','findOneAndReplace','deleteMany','findOneAndDelete','bulkWrite'])auditSchema.pre(op,immutable);
auditSchema.pre('deleteOne',{document:true,query:true},immutable);
const AiProviderConnection=mongoose.models.AiProviderConnection||mongoose.model('AiProviderConnection',connectionSchema);
const AiCredentialAudit=mongoose.models.AiCredentialAudit||mongoose.model('AiCredentialAudit',auditSchema);
module.exports={AiProviderConnection,AiCredentialAudit};
