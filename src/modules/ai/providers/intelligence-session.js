'use strict';
const {z}=require('zod');
const {isDeepStrictEqual}=require('node:util');
const {freeze}=require('../intelligence/candle-evidence');
const {scopeFor}=require('../ai-read-gateway');
const {createTrustedContextAssembler}=require('../intelligence/trusted-context');
const {createResponseEngine}=require('../intelligence/response-engine');
const {createOfflineOrchestrator}=require('./offline-orchestrator');
const {assertIsolated}=require('./credit-ledger-store');
const {AppError}=require('../../../shared/errors/app-error');
const id=z.string().regex(/^[a-f0-9]{24}$/);
const selectionSchema=z.object({providerId:z.enum(['openai','anthropic','gemini','deepseek','openrouter']),
  modelId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/),fundingMode:z.enum(['BYO_API','ACG_CREDITS'])}).strict();
const marketSchema=z.object({symbol:z.string().regex(/^[A-Z0-9._-]{1,32}$/),
  timeframes:z.array(z.enum(['1m','5m','15m','30m','1h','4h','1d','1w'])).min(1).max(3),
  limit:z.number().int().min(1).max(128),sessionWindows:z.array(z.object({timeframe:z.string(),
    startMs:z.number().int().nonnegative(),endMs:z.number().int().positive()}).strict()).max(3),
  evidenceMode:z.enum(['HISTORICAL_ONLY','RECENT_QUOTE_AND_HISTORY'])}).strict().refine(v=>
    new Set(v.timeframes).size===v.timeframes.length&&v.sessionWindows.every(w=>v.timeframes.includes(w.timeframe)&&
      w.endMs>w.startMs&&w.endMs-w.startMs<=86400000));
const runSchema=z.object({idempotencyKey:z.uuid(),question:z.string().min(1).max(4096),
  inputTokenUpperBound:z.number().int().min(1).max(10000000),maxOutputTokens:z.number().int().min(1).max(1000000),
  stream:z.boolean().default(false),timeoutMs:z.number().int().min(1).max(30000).default(10000)}).strict();
const operations=new Set(['CONTEXT','GENERATE','VERIFY','CACHE_READ','CACHE_WRITE','STATUS','CANCEL','DISCLOSE']);
function fail(code,statusCode=403){throw new AppError('AI integration denied',{code,statusCode});}
function parse(s,v){const p=s.safeParse(v);if(!p.success)fail('AI_INTEGRATION_INVALID',400);return freeze(p.data);}
function equalScope(a,b){return ['tenantId','actorId','sessionId','accountId'].every(k=>a?.[k]===b?.[k]);}
function safeQuestion(q){
  // Conservative obvious-secret filter only. Not a general DLP guarantee.
  return Buffer.byteLength(q,'utf8')<=4096&&q.trim()&&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(q)&&
    !/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{12,}|\b(?:sk-(?:proj-)?|AIza)[A-Za-z0-9_-]{16,}|\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i.test(q);
}
// Isolated composition only. Auth and read grant are real existing boundaries;
// the separate data/compute permission callback is deliberately injected
// synthetic policy, not a production licence or consent implementation.
// One immutable scope/profile/model/market specification per composition.
async function createIsolatedIntelligenceSession({auth,gateway,governance,governanceStore,
  currentToken,accountId,connectionId,selection,profile,market=null,source=null,
  authorizePurpose,policyEpoch,registry,pricingRegistry,adapters,computeBudget,creditLedger,educationCache=null,
  now=Date.now,identityNow=Date.now}={}){
  assertIsolated();
  if(typeof auth?.authenticateSessionToken!=='function'||typeof gateway?.assertDisclosure!=='function'||
    typeof governance?.run!=='function'||typeof governanceStore?.control!=='function'||
    typeof currentToken!=='function'||typeof authorizePurpose!=='function'||
    typeof computeBudget?.reserve!=='function'||typeof policyEpoch!=='string'||!/^[A-Za-z0-9._:-]{1,80}$/.test(policyEpoch))
    fail('AI_INTEGRATION_CONFIG',503);
  accountId=parse(id,accountId);connectionId=parse(z.uuid(),connectionId);
  selection=parse(selectionSchema,selection);
  profile=parse(z.enum(['EDUCATION','MARKET_OVERVIEW','STRUCTURE','SESSION']),profile);
  if(market!==null)market=parse(marketSchema,market);
  if((market===null)!==(profile==='EDUCATION')||market!==null&&!source||
    selection.fundingMode==='ACG_CREDITS'&&!creditLedger)fail('AI_INTEGRATION_CONFIG',503);
  const readRequest=freeze({accountId,connectionId,toolId:'account.valuation.read',args:{}});
  async function principal(){
    const t=await currentToken();
    if(typeof t!=='string'||!t)fail('AI_IDENTITY_UNAVAILABLE');
    return auth.authenticateSessionToken(t);
  }
  const initial=await principal();
  const {channel,...scope}=scopeFor(initial,accountId,identityNow());
  freeze(scope);
  const control=await governanceStore.control(scope.tenantId);
  if(control?.enabled!==true||!Number.isSafeInteger(control.revision)||control.revision<1)fail('AI_GOVERNANCE_PAUSED');
  const revision=control.revision;
  const marketRequest=market===null?null:freeze({scope,symbol:market.symbol,timeframes:market.timeframes,
    limit:market.limit,sessionWindows:market.sessionWindows});
  async function check(operation,requestedScope=scope){
    try{
      assertIsolated();
      if(!operations.has(operation)||!equalScope(requestedScope,scope))return false;
      const fresh=await principal(),actual=scopeFor(fresh,accountId,identityNow());
      if(!equalScope(actual,scope))return false;
      const before=await governanceStore.control(scope.tenantId);
      if(before?.enabled!==true||before.revision!==revision)return false;
      // Baseline grant check only. Does not fetch or export account values.
      await gateway.assertDisclosure(fresh,readRequest);
      if(await authorizePurpose(freeze({scope,operation,selection,profile,market,
        policyEpoch,governanceRevision:revision,externalExport:false,offlineOnly:true}))!==true)return false;
      const last=await governanceStore.control(scope.tenantId);
      return last?.enabled===true&&last.revision===revision;
    }catch{return false;}
  }
  if(!await check('GENERATE'))fail('AI_INTEGRATION_FORBIDDEN');
  const assembler=market===null?null:createTrustedContextAssembler({
    // Historical-only mode does not even call the quote source.
    source:Object.freeze({instrument:s=>source.instrument(s),candles:r=>source.candles(r),
      quote:s=>market.evidenceMode==='HISTORICAL_ONLY'?null:source.quote(s)}),
    authorize:r=>isDeepStrictEqual(r,marketRequest)&&check('CONTEXT',r.scope),now});
  const engine=createResponseEngine({now,authorize:r=>r.profile===profile&&
    isDeepStrictEqual(r.marketRequest,marketRequest)&&check('VERIFY',r.scope)});
  const orchestrator=createOfflineOrchestrator({registry,pricingRegistry,adapters,computeBudget,creditLedger,
    educationCache,cachePolicyEpoch:educationCache===null?null:policyEpoch+':'+revision,now,responseEngine:engine,
    authorize:r=>r.profile===profile&&isDeepStrictEqual(r.selection,selection)&&check(r.operation,r.scope)});
  // Never accept caller-provided scope, context, provider, funding, tool calls,
  // account values or provider credentials in the generation input.
  return Object.freeze({
    async run(input,{signal}={}){
      assertIsolated();const x=parse(runSchema,input);
      const p=await principal();
      if(!equalScope(scopeFor(p,accountId,identityNow()),scope))fail('AI_SCOPE_CHANGED');
      const result=await governance.run({principal:p,operation:'AI_GENERATE_OFFLINE',requestedAccountId:accountId},
        async()=>{
          if(!safeQuestion(x.question))fail('AI_QUESTION_RESTRICTED',400);
          if(!await check('GENERATE'))fail('AI_INTEGRATION_FORBIDDEN');
          const context=assembler?await assembler.assemble(marketRequest):null;
          return orchestrator.run({...x,scope,selection,profile,context},{signal});
        },async()=>{if(!await check('DISCLOSE'))fail('AI_INTEGRATION_FORBIDDEN');});
      // Governance append and final authorization consume time too.
      if(result.response&&now()>=result.response.expiresAtMs)fail('AI_RESPONSE_EXPIRED');
      return result;
    },
    async status(key){assertIsolated();return orchestrator.status(scope,parse(z.uuid(),key));},
    async cancel(key){assertIsolated();return orchestrator.cancel(scope,parse(z.uuid(),key));},
  });
}
module.exports={createIsolatedIntelligenceSession};
