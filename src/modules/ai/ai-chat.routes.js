'use strict';
const express=require('express');
const {z}=require('zod');
const {requireTraderSession,bearerToken}=require('../auth/auth.middleware');
const {AppError}=require('../../shared/errors/app-error');
const {aiJsonBoundary,aiSafeError,createConcurrencyGate}=require('./ai-http-security');
const {scopeFor}=require('./ai-read-gateway');
const {assertIsolated}=require('./providers/credit-ledger-store');
const {createModelRegistry,REGISTRY_VERSION}=require('./providers/model-registry');
const {freeze}=require('./intelligence/candle-evidence');
const {schemas}=require('./ai-conversations');
const id=z.string().regex(/^[a-f0-9]{24}$/);
const authority=z.object({accountId:id,connectionId:z.uuid()}).strict();
const selection=z.object({providerId:z.enum(['openai','anthropic','gemini','deepseek','openrouter']),
  modelId:z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  descriptorId:z.string().regex(/^[a-f0-9]{64}$/),fundingMode:z.enum(['BYO_API','ACG_CREDITS'])}).strict();
const preflight=authority.extend({selection,profile:z.enum(['EDUCATION','MARKET_OVERVIEW','STRUCTURE']),workspace:schemas.create.shape.workspace}).strict();
const deny=(code,statusCode=403)=>new AppError('AI chat request denied',{code,statusCode});
const parse=(schema,value)=>{const p=schema.safeParse(value);if(!p.success)throw deny('AI_INVALID_REQUEST',400);return p.data;};
const scopeEqual=(a,b)=>['tenantId','actorId','sessionId','accountId'].every(k=>a[k]===b[k]);
const contractVersion='native-chat-v1';
// This API is an isolated contract rehearsal, not a production route.
// Optional bounded conversation storage and local TLS fixture only; no public provider, pricing or orders.
function createIsolatedChatRouter({authService,gateway,governance,quota,authorizePurpose,
  registry=createModelRegistry(),conversations=null,fixtureProviderEnabled=false,workspaceAnalysisEnabled=false,marketProviderEnabled=false,now=Date.now}={}){
  assertIsolated();
  if(typeof authService?.authenticateSessionToken!=='function'||typeof gateway?.assertDisclosure!=='function'||
    typeof governance?.run!=='function'||typeof quota?.consume!=='function'||typeof authorizePurpose!=='function'||
    typeof registry?.models!=='function'||typeof registry?.providers!=='function')throw deny('AI_CHAT_CONFIG',503);
  const router=express.Router(),admit=createConcurrencyGate(8);
  router.use(aiJsonBoundary({maxStringLength:conversations?4096:512}));
  router.use((_req,_res,next)=>{try{assertIsolated();next();}catch(e){next(e);}});
  router.use(requireTraderSession(authService));
  const audited=(operation,schema,work)=>async(req,res)=>{
    const result=await admit(async()=>{
      const principal=req.traderPrincipal;
      await quota.consume(principal);
      let scope,readRequest,disclosures=[],fences=[],governanceFence;
      async function check(selection=null,profile=null,workspace=null){
        if(typeof governanceFence!=='function')throw deny('AI_CHAT_CONFIG',503);
        await governanceFence();
        const fresh=await authService.authenticateSessionToken(bearerToken(req));
        if(!scopeEqual(scope,scopeFor(fresh,readRequest.accountId,now())))throw deny('AI_SCOPE_CHANGED');
        await gateway.assertDisclosure(fresh,readRequest);
        const permitted=await authorizePurpose(freeze({scope:{...scope},operation,selection,profile,workspace,offlineOnly:true,externalExport:false}));
        if(permitted!==true)throw deny('AI_CHAT_PURPOSE_DENIED');
        const again=await authService.authenticateSessionToken(bearerToken(req));
        if(!scopeEqual(scope,scopeFor(again,readRequest.accountId,now())))throw deny('AI_SCOPE_CHANGED');
        await gateway.assertDisclosure(again,readRequest);
        await governanceFence();
      }
      return governance.run({principal,operation,requestedAccountId:req.body?.accountId},async assertCurrent=>{
        governanceFence=assertCurrent;
        if(Object.keys(req.query).length)throw deny('AI_INVALID_REQUEST',400);
        const input=parse(schema,req.body);
        scope=scopeFor(principal,input.accountId,now());
        readRequest=freeze({accountId:input.accountId,connectionId:input.connectionId,toolId:'account.valuation.read',args:{}});
        await check();
        const value=await work(input,async(s,p,w=null)=>{await check(s,p,w);if(!disclosures.some(v=>JSON.stringify(v)===JSON.stringify([s,p,w])))disclosures.push([s,p,w]);},scope,f=>fences.push(f));
        return freeze(value);
      },async()=>{
        await check();
        for(const [s,p,w] of disclosures)await check(s,p,w);
        for(const fence of fences)await fence();
      }).then(async value=>{for(const fence of fences)await fence();return value;});
    });
    res.status(200).json(result);
  };
  router.post('/capabilities',audited('CHAT_DISCOVER_OFFLINE',authority,async(_input,permit)=>{
    const options=[];
    // Never advertise proposed/disabled/custom or synthetic descriptors as live.
    // Restrict the rehearsal to BYO and education; no implied payment entitlement.
    let reviewed=0;
    for(const d of registry.models()){
      if(d.reviewStatus!=='SYNTHETIC_TEST_ONLY'||d.providerId==='custom'||!d.fundingModes.includes('BYO_API'))continue;
      if(++reviewed>16)break;
      const s={providerId:d.providerId,modelId:d.modelId,descriptorId:d.descriptorId,fundingMode:'BYO_API'};
      try{registry.resolveForOfflineTest(s);}catch{continue;}
      try{await permit(s,'EDUCATION');}catch(e){if(e?.code==='AI_CHAT_PURPOSE_DENIED')continue;throw e;}
      options.push({...s,profile:'EDUCATION',status:'SYNTHETIC_TEST_ONLY',runtimeEnabled:false});
      if(options.length>=16)break;
    }
    return {contractVersion,registryVersion:REGISTRY_VERSION,runtimeEnabled:false,sendEnabled:false,
      fixtureProviderEnabled:fixtureProviderEnabled===true&&conversations!==null,
      workspaceAnalysisEnabled:workspaceAnalysisEnabled===true&&conversations!==null,
      marketProviderEnabled:marketProviderEnabled===true&&workspaceAnalysisEnabled===true&&fixtureProviderEnabled===true&&conversations!==null,
      providers:registry.providers().map(p=>({id:p.id,name:p.name,integrationStatus:'PLANNED',runtimeEnabled:false})),
      rehearsalOptions:options,fundingModes:[{id:'BYO_API',runtimeEnabled:false},{id:'ACG_CREDITS',runtimeEnabled:false}],
      profiles:[{id:'EDUCATION',rehearsalOnly:true},...(workspaceAnalysisEnabled===true&&conversations!==null?
        ['MARKET_OVERVIEW','STRUCTURE'].map(id=>({id,rehearsalOnly:true,requiresChartConsent:true})):[])],maxQuestionBytes:4096};
  }));
  router.post('/preflight',audited('CHAT_PREFLIGHT_OFFLINE',preflight,async(input,permit)=>{
    const s=input.selection;
    if(s.fundingMode!=='BYO_API')throw deny('AI_CHAT_FUNDING_DISABLED');
    let d;try{d=registry.resolveForOfflineTest(s);}catch{throw deny('AI_CHAT_MODEL_UNAVAILABLE',409);}
    if(s.descriptorId!==d.descriptorId)throw deny('AI_CHAT_MODEL_CHANGED',409);
    if((input.profile==='EDUCATION')===Boolean(input.workspace))throw deny('AI_WORKSPACE_INVALID',400);
    if(input.workspace&&(workspaceAnalysisEnabled!==true||conversations===null))throw deny('AI_WORKSPACE_DISABLED');
    await permit(s,input.profile,input.workspace??null);
    return {contractVersion,status:'VALIDATED_OFFLINE_ONLY',runtimeEnabled:false,sendEnabled:false,
      selection:s,profile:input.profile,...(input.workspace?{workspace:input.workspace}:{}),dispatchAllowed:false,creditDeducted:false};
  }));
  if(conversations!==null){
    if(typeof conversations.execute!=='function')throw deny('AI_CHAT_CONFIG',503);
    for(const op of Object.keys(schemas)){
      router.post('/conversations/'+op,audited('CHAT_'+op.toUpperCase()+'_OFFLINE',
        authority.extend(schemas[op].shape).strict(),async(input,permit,scope,addFence)=>{
          const {accountId:ignoredAccount,connectionId:ignoredConnection,...payload}=input;
          const result=await conversations.execute({...scope,connectionId:input.connectionId},op,payload,permit);
          if(result.fence)addFence(result.fence);
          return {contractVersion,runtimeEnabled:false,...result.value};
        }));
    }
  }
  router.use(aiSafeError);
  return router;
}
module.exports={createIsolatedChatRouter};
