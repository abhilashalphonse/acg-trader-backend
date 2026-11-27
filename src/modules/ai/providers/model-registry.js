'use strict';
const {z}=require('zod');
const {digest,freeze}=require('../intelligence/candle-evidence');
const REGISTRY_VERSION='provider-registry-v1';
// Integration targets only. No live model availability, capability or pricing
// assertions are made until provider-specific adapter acceptance.
const PROVIDERS=freeze([
  {id:'openai',name:'OpenAI',kind:'DIRECT'},
  {id:'anthropic',name:'Anthropic',kind:'DIRECT'},
  {id:'gemini',name:'Google Gemini',kind:'DIRECT'},
  {id:'deepseek',name:'DeepSeek',kind:'DIRECT'},
  {id:'openrouter',name:'OpenRouter',kind:'AGGREGATOR'},
  {id:'custom',name:'Custom endpoint',kind:'CUSTOM'},
].map(p=>({...p,integrationStatus:'PLANNED',runtimeEnabled:false})));
const providerIds=PROVIDERS.map(p=>p.id);
const modelId=z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const descriptorSchema=z.object({
  providerId:z.enum(providerIds),modelId,revision:z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  reviewStatus:z.enum(['PROPOSED','DISABLED','SYNTHETIC_TEST_ONLY']),
  fundingModes:z.array(z.enum(['BYO_API','ACG_CREDITS'])).min(1).max(2),
  capabilities:z.object({
    input:z.literal('TEXT'),responseMode:z.enum(['JSON_SCHEMA','JSON_OBJECT','UNSUPPORTED']),
    separateInstructionChannel:z.boolean(),streaming:z.boolean(),
    usageReporting:z.enum(['PROVIDER_REPORTED','UNKNOWN']),
    maxContextTokens:z.number().int().min(1).max(10000000),
    maxOutputTokens:z.number().int().min(1).max(1000000),
  }).strict(),
}).strict().refine(d=>d.capabilities.maxOutputTokens<=d.capabilities.maxContextTokens&&
  new Set(d.fundingModes).size===d.fundingModes.length,'Invalid model bounds or funding modes');
const key=(p,m)=>JSON.stringify([p,m]);
function fail(code){throw Object.assign(Error('Model selection unavailable'),{code});}
// Only server-owned descriptors. Never accept a model/client advertisement as
// verified. Empty default catalog deliberately prevents fictional live models.
function createModelRegistry({descriptors=[],allowSynthetic=false}={}){
  if(!Array.isArray(descriptors)||descriptors.length>128)fail('INVALID_MODEL_CATALOG');
  const entries=new Map();
  for(const raw of descriptors){
    const parsed=descriptorSchema.safeParse(raw);
    if(!parsed.success)fail('INVALID_MODEL_DESCRIPTOR');
    const d=parsed.data;
    if(d.reviewStatus==='SYNTHETIC_TEST_ONLY'&&allowSynthetic!==true)fail('SYNTHETIC_MODEL_FORBIDDEN');
    const k=key(d.providerId,d.modelId);
    if(entries.has(k))fail('DUPLICATE_MODEL');
    const value={...d,registryVersion:REGISTRY_VERSION,runtimeEnabled:false};
    entries.set(k,freeze({...value,descriptorId:digest(value)}));
  }
  return Object.freeze({
    providers:()=>PROVIDERS,
    models:()=>freeze([...entries.values()]),
    resolveForOfflineTest({providerId,modelId:requestedModel,fundingMode}={}){
      const d=entries.get(key(providerId,requestedModel));
      if(!d)fail('MODEL_NOT_REGISTERED');
      if(allowSynthetic!==true||d.reviewStatus!=='SYNTHETIC_TEST_ONLY')fail('MODEL_NOT_TEST_ENABLED');
      if(!d.fundingModes.includes(fundingMode))fail('FUNDING_MODE_UNSUPPORTED');
      const c=d.capabilities;
      if(!c.separateInstructionChannel||c.responseMode==='UNSUPPORTED'||c.usageReporting!=='PROVIDER_REPORTED')
        fail('MODEL_CAPABILITY_UNSUPPORTED');
      return d;
    },
    resolveForRuntime(){fail('AI_PROVIDER_RUNTIME_DISABLED');},
  });
}
module.exports={createModelRegistry,REGISTRY_VERSION,PROVIDERS};
