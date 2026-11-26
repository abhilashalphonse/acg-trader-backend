'use strict';
const {z}=require('zod');
const {randomUUID}=require('node:crypto');
const {digest,freeze}=require('../intelligence/candle-evidence');
const {PROMPT_VERSION,MAX_PACKAGE_BYTES,INTERPRETATION_CODES}=require('../intelligence/prompt-compiler');
const CONTRACT_VERSION='provider-contract-v1';
const MAX_CANDIDATE_BYTES=16384;
const tokenCount=z.number().int().min(0).max(10000000);
const reportedUsage=z.object({
  status:z.literal('PROVIDER_REPORTED'),inputTokens:tokenCount,outputTokens:tokenCount,
  cachedInputTokens:tokenCount.nullable(),reasoningOutputTokens:tokenCount.nullable(),
}).strict().refine(u=>(u.cachedInputTokens===null||u.cachedInputTokens<=u.inputTokens)&&
  (u.reasoningOutputTokens===null||u.reasoningOutputTokens<=u.outputTokens));
const usageSchema=z.union([reportedUsage,z.object({status:z.literal('UNKNOWN')}).strict()]);
const outcomeSchema=z.object({
  requestId:z.uuid(),providerId:z.string().min(1).max(32),modelId:z.string().min(1).max(160),
  descriptorId:z.string().regex(/^[a-f0-9]{64}$/),
  status:z.enum(['COMPLETED','REFUSED','INCOMPLETE','FAILED','CANCELLED','UNKNOWN']),
  candidate:z.string().nullable(),usage:usageSchema,
  errorCode:z.enum(['NONE','AUTHENTICATION','RATE_LIMIT','QUOTA','TIMEOUT','UNAVAILABLE','INVALID_RESPONSE','CANCELLED','UNKNOWN']),
}).strict();
const refId={type:'string',pattern:'^[a-f0-9]{64}$'};
const record=(properties)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array=(items,maxItems)=>({type:'array',items,maxItems});
const CANDIDATE_JSON_SCHEMA=freeze(record({
  schemaVersion:{type:'string',enum:['candidate-response-v2']},
  status:{type:'string',enum:['ANSWER','INSUFFICIENT_EVIDENCE','UNSUPPORTED']},
  observations:array(record({referenceId:refId}),32),
  interpretations:array(record({referenceId:refId,code:{type:'string',enum:Object.keys(INTERPRETATION_CODES)}}),8),
  education:array(record({knowledgeId:refId}),8),
}));
function fail(code){throw Object.assign(Error('Provider contract rejected'),{code});}
const positiveInt=v=>Number.isSafeInteger(v)&&v>0;
// Offline-only request contract. Inputs must originate from trusted server code;
// package hash detects corruption, not authorization. Token count is a caller-
// supplied planning estimate, not a billable count or tokenizer guarantee.
function createOfflineRequest({registry,selection,prompt,inputTokenUpperBound,maxOutputTokens,nowMs}={}){
  if(!registry||typeof registry.resolveForOfflineTest!=='function')fail('INVALID_REGISTRY');
  const model=registry.resolveForOfflineTest(selection);
  if(!prompt||prompt.payload?.schemaVersion!=='prompt-package-v1'||
    prompt.payload.instructions?.version!==PROMPT_VERSION||
    prompt.payload.instructions?.responseContract?.schemaVersion!=='candidate-response-v2'||
    !positiveInt(nowMs)||!positiveInt(prompt.compiledAtMs)||!positiveInt(prompt.expiresAtMs)||
    nowMs<prompt.compiledAtMs||nowMs>=prompt.expiresAtMs)fail('INVALID_OR_EXPIRED_PROMPT');
  let bytes;
  try{bytes=Buffer.byteLength(JSON.stringify(prompt.payload),'utf8');}
  catch{fail('INVALID_PROMPT');}
  if(bytes!==prompt.payloadBytes||bytes>MAX_PACKAGE_BYTES||digest(prompt.payload)!==prompt.packageId)fail('PROMPT_INTEGRITY');
  if(!positiveInt(inputTokenUpperBound)||!positiveInt(maxOutputTokens)||
    maxOutputTokens>model.capabilities.maxOutputTokens||
    inputTokenUpperBound+maxOutputTokens>model.capabilities.maxContextTokens)fail('MODEL_TOKEN_BUDGET_EXCEEDED');
  // Funding metadata is for future orchestration/accounting ONLY, never part
  // of a provider wire payload. No account scope, endpoint, API key or tools.
  const envelope={contractVersion:CONTRACT_VERSION,requestId:randomUUID(),
    executionMode:'OFFLINE_TEST_ONLY',providerId:model.providerId,modelId:model.modelId,
    descriptorId:model.descriptorId,modelRevision:model.revision,fundingMode:selection.fundingMode,
    packageId:prompt.packageId,createdAtMs:nowMs,expiresAtMs:prompt.expiresAtMs,
    budget:{inputTokenUpperBound,maxOutputTokens,tokenCountStatus:'UNVERIFIED_PLANNING_BOUND'},
    request:{instruction:structuredClone(prompt.payload.instructions),
      data:structuredClone(prompt.payload.data),responseMode:model.capabilities.responseMode,
      responseSchema:CANDIDATE_JSON_SCHEMA,maxOutputTokens,stream:false,tools:[]}};
  return freeze(envelope);
}
// An adapter's eventual output must be normalized before verification. This
// function never calls an adapter, settles money, retries, or exposes candidate
// text from non-complete outcomes. Candidate text is still untrusted.
function normalizeOfflineOutcome(request,raw){
  if(request?.contractVersion!==CONTRACT_VERSION||request.executionMode!=='OFFLINE_TEST_ONLY')fail('INVALID_PROVIDER_REQUEST');
  const result=outcomeSchema.safeParse(raw);
  if(!result.success)fail('INVALID_PROVIDER_OUTCOME');
  const v=result.data;
  if(!['requestId','providerId','modelId','descriptorId'].every(k=>v[k]===request[k]))fail('PROVIDER_OUTCOME_MISMATCH');
  const complete=v.status==='COMPLETED';
  if(complete){
    if(v.errorCode!=='NONE'||typeof v.candidate!=='string'||!v.candidate.trim()||
      Buffer.byteLength(v.candidate,'utf8')>MAX_CANDIDATE_BYTES)fail('INVALID_PROVIDER_CANDIDATE');
  }else if(v.candidate!==null||v.errorCode==='NONE')fail('INVALID_PROVIDER_FAILURE');
  const usage=v.usage.status==='PROVIDER_REPORTED'?{...v.usage,totalTokens:v.usage.inputTokens+v.usage.outputTokens}:v.usage;
  // Do not cap or erase reported usage when a provider exceeds a planning
  // bound. Preserve it for reconciliation, not automatic charging.
  const exceedsPlanningBound=usage.status==='PROVIDER_REPORTED'&&
    (usage.inputTokens>request.budget.inputTokenUpperBound||usage.outputTokens>request.budget.maxOutputTokens);
  return freeze({...v,usage,contractVersion:CONTRACT_VERSION,
    candidateTrust:'UNVERIFIED',requiresPhase2Verification:complete,
    usageDisposition:usage.status==='UNKNOWN'||exceedsPlanningBound?'RECONCILIATION_REQUIRED':'UNSETTLED',
    exceedsPlanningBound,automaticRetry:false,automaticFallback:false});
}
module.exports={createOfflineRequest,normalizeOfflineOutcome,CONTRACT_VERSION,CANDIDATE_JSON_SCHEMA,MAX_CANDIDATE_BYTES};
