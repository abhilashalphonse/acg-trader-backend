'use strict';
const {z}=require('zod');
const {digest,freeze}=require('../intelligence/candle-evidence');
const {CONTRACT_VERSION}=require('./provider-contract');
const VERSION='compute-pricing-v1';
// One rate unit = one micro-USD per million tokens = one pico-USD per token.
// Strings at all monetary boundaries. No binary floating point or per-line rounding.
const rate=z.string().regex(/^(0|[1-9][0-9]{0,12})$/);
const count=z.number().int().min(0).max(10000000);
const instant=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const hex=z.string().regex(/^[a-f0-9]{64}$/);
const descriptor=z.object({
  providerId:z.enum(['openai','anthropic','gemini','deepseek','openrouter']),
  modelId:z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  descriptorId:hex,revision:z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  effectiveFromMs:instant,effectiveUntilMs:instant.nullable(),
  currency:z.literal('USD'),rateUnit:z.literal('MICRO_USD_PER_MILLION_TOKENS'),
  reviewStatus:z.literal('SYNTHETIC_TEST_ONLY'),
  source:z.literal('OFFLINE_FIXTURE'),
  additionalFees:z.literal('NONE_SYNTHETIC'),
  input:z.object({standard:rate,cacheRead:rate.nullable(),
    cacheWriteMode:z.enum(['NONE','UNIFORM','TTL_SPLIT']),cacheWrite:rate.nullable(),
    cacheWrite5m:rate.nullable(),cacheWrite1h:rate.nullable()}).strict(),
  output:z.object({standard:rate,reasoning:rate.nullable()}).strict(),
}).strict().refine(p=>{
  const i=p.input;
  return (p.effectiveUntilMs===null||p.effectiveUntilMs>p.effectiveFromMs)&&
    (i.cacheWriteMode==='NONE'&&i.cacheWrite===null&&i.cacheWrite5m===null&&i.cacheWrite1h===null||
     i.cacheWriteMode==='UNIFORM'&&i.cacheWrite!==null&&i.cacheWrite5m===null&&i.cacheWrite1h===null||
     i.cacheWriteMode==='TTL_SPLIT'&&i.cacheWrite===null&&i.cacheWrite5m!==null&&i.cacheWrite1h!==null);
});
const usageSchema=z.object({
  status:z.literal('PROVIDER_REPORTED'),inputTokens:count,outputTokens:count,totalTokens:z.number().int().min(0).max(20000000),
  cachedInputTokens:count.nullable(),reasoningOutputTokens:count.nullable(),
  cacheWriteInputTokens:count.nullable().optional(),cacheWrite5mInputTokens:count.nullable().optional(),
  cacheWrite1hInputTokens:count.nullable().optional(),
}).strict().refine(u=>u.totalTokens===u.inputTokens+u.outputTokens&&
  (u.cachedInputTokens??0)+(u.cacheWriteInputTokens??0)<=u.inputTokens&&
  (u.reasoningOutputTokens??0)<=u.outputTokens&&
  (u.cacheWrite5mInputTokens??0)+(u.cacheWrite1hInputTokens??0)<=(u.cacheWriteInputTokens??0)&&
  (u.cacheWrite5mInputTokens==null||u.cacheWrite1hInputTokens==null||
   u.cacheWrite5mInputTokens+u.cacheWrite1hInputTokens===u.cacheWriteInputTokens));
function fail(code){throw Object.assign(Error('Compute pricing unavailable'),{code});}
const modelKey=p=>JSON.stringify([p.providerId,p.modelId,p.descriptorId]);
const maxRate=r=>r.filter(v=>v!==null).map(BigInt).reduce((a,b)=>a>b?a:b,0n);
function validRequest(q){
  return q?.contractVersion===CONTRACT_VERSION&&q.executionMode==='OFFLINE_TEST_ONLY'&&
    z.uuid().safeParse(q.requestId).success&&hex.safeParse(q.descriptorId).success&&
    ['BYO_API','ACG_CREDITS'].includes(q.fundingMode)&&instant.safeParse(q.createdAtMs).success&&
    instant.safeParse(q.expiresAtMs).success&&q.expiresAtMs>q.createdAtMs&&
    count.safeParse(q.budget?.inputTokenUpperBound).success&&q.budget.inputTokenUpperBound>0&&
    count.safeParse(q.budget?.maxOutputTokens).success&&q.budget.maxOutputTokens>0;
}
// Server-owned immutable catalog, explicitly synthetic. No live rate assertion.
// Overlaps and duplicate revisions are invalid; gaps fail closed at selection.
function createPricingRegistry({prices=[],allowSynthetic=false}={}){
  if(!Array.isArray(prices)||prices.length>256||prices.length&&allowSynthetic!==true)fail('PRICE_CATALOG_INVALID');
  const groups=new Map();
  for(const raw of prices){
    const p=descriptor.safeParse(raw);
    if(!p.success)fail('PRICE_DESCRIPTOR_INVALID');
    const d=p.data,k=modelKey(d),list=groups.get(k)??[];
    if(list.some(v=>v.revision===d.revision))fail('PRICE_REVISION_DUPLICATE');
    const body={...d,pricingVersion:VERSION,runtimeEnabled:false};
    list.push(freeze({...body,priceId:digest(body)}));groups.set(k,list);
  }
  for(const list of groups.values()){
    list.sort((a,b)=>a.effectiveFromMs-b.effectiveFromMs);
    for(let i=1;i<list.length;i++)if(list[i-1].effectiveUntilMs===null||
      list[i].effectiveFromMs<list[i-1].effectiveUntilMs)fail('PRICE_INTERVAL_OVERLAP');
  }
  function pin(q,atMs){
    if(!validRequest(q)||!instant.safeParse(atMs).success||atMs<q.createdAtMs||atMs>=q.expiresAtMs)
      fail('PRICE_REQUEST_INVALID');
    const p=(groups.get(modelKey(q))??[]).find(v=>v.effectiveFromMs<=atMs&&
      (v.effectiveUntilMs===null||atMs<v.effectiveUntilMs));
    if(!p)fail('PRICE_NOT_AVAILABLE');
    const i=p.input,o=p.output;
    const bound=BigInt(q.budget.inputTokenUpperBound)*maxRate([i.standard,i.cacheRead,i.cacheWrite,i.cacheWrite5m,i.cacheWrite1h])+
      BigInt(q.budget.maxOutputTokens)*maxRate([o.standard,o.reasoning]);
    const body={pricingVersion:VERSION,requestId:q.requestId,providerId:q.providerId,modelId:q.modelId,
      descriptorId:q.descriptorId,fundingMode:q.fundingMode,pinnedAtMs:atMs,
      inputTokenUpperBound:q.budget.inputTokenUpperBound,maxOutputTokens:q.budget.maxOutputTokens,
      price:p,currency:'USD',moneyUnit:'PICO_USD',
      upperBoundPicoUsd:bound.toString(),boundStatus:'UNVERIFIED_PLANNING_BOUND',offlineOnly:true};
    return freeze({...body,snapshotId:digest(body)});
  }
  return Object.freeze({prices:()=>freeze([...groups.values()].flat()),pin,
    resolveForRuntime(){fail('PRICE_RUNTIME_DISABLED');}});
}
function verifySnapshot(q,s){
  if(!validRequest(q)||!s||s.pricingVersion!==VERSION||s.offlineOnly!==true||
    !['requestId','providerId','modelId','descriptorId','fundingMode'].every(k=>s[k]===q[k])||
    s.inputTokenUpperBound!==q.budget.inputTokenUpperBound||s.maxOutputTokens!==q.budget.maxOutputTokens)
    fail('PRICE_SNAPSHOT_MISMATCH');
  const {snapshotId,...body}=s;
  if(digest(body)!==snapshotId)fail('PRICE_SNAPSHOT_INTEGRITY');
  const {priceId,pricingVersion,runtimeEnabled,...d}=s.price??{};
  if(pricingVersion!==VERSION||runtimeEnabled!==false||!descriptor.safeParse(d).success||
    digest({...d,pricingVersion,runtimeEnabled})!==priceId||modelKey(d)!==modelKey(q))
    fail('PRICE_SNAPSHOT_INTEGRITY');
  // Recompute all derived fields from the original, not today's price.
  const expected=createPricingRegistry({prices:[d],allowSynthetic:true}).pin(q,s.pinnedAtMs);
  if(expected.snapshotId!==snapshotId)fail('PRICE_SNAPSHOT_INTEGRITY');
}
// Pure offline meter. Hashes detect corruption; they are not authorization or
// origin proofs. No amount is booked and no provider invoice is asserted.
function meterOfflineUsage(q,s,usage){
  verifySnapshot(q,s);
  const base={pricingVersion:VERSION,requestId:q.requestId,snapshotId:s.snapshotId,priceId:s.price.priceId,
    fundingMode:q.fundingMode,currency:'USD',moneyUnit:'PICO_USD',upperBoundPicoUsd:s.upperBoundPicoUsd,
    offlineOnly:true,settled:false,creditDeducted:false};
  const unresolved=reason=>freeze({...base,status:'RECONCILIATION_REQUIRED',reason,
    costPicoUsd:null,proposedCreditDebitPicoUsd:q.fundingMode==='BYO_API'?'0':null,lines:[]});
  const parsed=usageSchema.safeParse(usage);
  if(!parsed.success)return unresolved(usage?.status==='UNKNOWN'?'USAGE_UNKNOWN':'USAGE_INVALID');
  const u=parsed.data,i=s.price.input,o=s.price.output;
  if(u.inputTokens>s.inputTokenUpperBound||u.outputTokens>s.maxOutputTokens)return unresolved('USAGE_EXCEEDS_PLANNING_BOUND');
  const lines=[];
  function add(dimension,tokens,r){
    lines.push({dimension,tokens,rateMicroUsdPerMillion:r,costPicoUsd:(BigInt(tokens)*BigInt(r)).toString()});
  }
  let standardInput=u.inputTokens,standardOutput=u.outputTokens;
  if(i.cacheRead!==null){
    if(u.cachedInputTokens===null)return unresolved('CACHE_READ_UNKNOWN');
    standardInput-=u.cachedInputTokens;add('CACHE_READ',u.cachedInputTokens,i.cacheRead);
  }
  if(i.cacheWriteMode==='NONE'){
    if((u.cacheWriteInputTokens??0)!==0)return unresolved('CACHE_WRITE_UNSUPPORTED');
    // NONE is a fixture-only declaration that no separate cache-write billing exists.
  }else{
    if(u.cacheWriteInputTokens==null)return unresolved('CACHE_WRITE_UNKNOWN');
    standardInput-=u.cacheWriteInputTokens;
    if(i.cacheWriteMode==='UNIFORM')add('CACHE_WRITE',u.cacheWriteInputTokens,i.cacheWrite);
    else{
      if(u.cacheWrite5mInputTokens==null||u.cacheWrite1hInputTokens==null||
        u.cacheWrite5mInputTokens+u.cacheWrite1hInputTokens!==u.cacheWriteInputTokens)
        return unresolved('CACHE_WRITE_TTL_UNKNOWN');
      add('CACHE_WRITE_5M',u.cacheWrite5mInputTokens,i.cacheWrite5m);
      add('CACHE_WRITE_1H',u.cacheWrite1hInputTokens,i.cacheWrite1h);
    }
  }
  if(o.reasoning!==null){
    if(u.reasoningOutputTokens===null)return unresolved('REASONING_USAGE_UNKNOWN');
    standardOutput-=u.reasoningOutputTokens;add('REASONING_OUTPUT',u.reasoningOutputTokens,o.reasoning);
  }
  if(standardInput<0||standardOutput<0)return unresolved('USAGE_INVALID');
  add('STANDARD_INPUT',standardInput,i.standard);add('STANDARD_OUTPUT',standardOutput,o.standard);
  const cost=lines.reduce((sum,x)=>sum+BigInt(x.costPicoUsd),0n);
  if(cost>BigInt(s.upperBoundPicoUsd))return unresolved('COST_EXCEEDS_PLANNING_BOUND');
  return freeze({...base,status:'CALCULATED_OFFLINE',reason:null,costPicoUsd:cost.toString(),
    proposedCreditDebitPicoUsd:q.fundingMode==='BYO_API'?'0':cost.toString(),lines});
}
module.exports={createPricingRegistry,meterOfflineUsage,VERSION};
