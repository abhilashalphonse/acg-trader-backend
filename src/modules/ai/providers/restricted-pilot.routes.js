'use strict';
const express=require('express');
const {z}=require('zod');
const {requireTraderSession,bearerToken}=require('../../auth/auth.middleware');
const {aiJsonBoundary,aiSafeError,createConcurrencyGate}=require('../ai-http-security');
const {isRestrictedPilotRuntime}=require('./restricted-pilot-runtime');
const {AppError}=require('../../../shared/errors/app-error');
const base=z.object({accountId:z.string().regex(/^[a-f0-9]{24}$/),connectionId:z.uuid(),
  symbol:z.string().regex(/^[A-Z0-9._-]{1,32}$/),timeframe:z.enum(['1m','5m','15m','30m','1h','4h','1d','1w'])}).strict();
const schemas={
  status:base,
  grant:base.extend({expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),explicitConsent:z.literal(true)}).strict(),
  revoke:base.extend({expectedRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1)}).strict(),
  generate:z.union([base.extend({operationId:z.uuid(),intent:z.enum(['HISTORICAL_OVERVIEW','HISTORICAL_STRUCTURE','EDUCATION_STRUCTURE','EDUCATION_LIQUIDITY','EDUCATION_FVG'])}).strict(),
    base.extend({operationId:z.uuid(),intent:z.literal('WORKSPACE_CHAT'),question:z.string().min(1).max(4096),
      history:z.array(z.object({role:z.enum(['user','assistant']),text:z.string().min(1).max(4096)}).strict()).max(6),
      includeAccount:z.boolean(),includeMarket:z.boolean()}).strict()])
};
const deny=(code='AI_PILOT_DENIED',statusCode=403)=>new AppError('Restricted AI pilot unavailable',{code,statusCode});
function createRestrictedPilotRouter({runtime,authService,quota,enabled}={}){
  if(!isRestrictedPilotRuntime(runtime)||typeof enabled!=='function'||typeof quota?.consume!=='function')throw deny();
  const router=express.Router(),admit=createConcurrencyGate(4);
  router.use(aiJsonBoundary({maxStringLength:runtime.mode==='WORKSPACE_CHAT'?4096:512}));
  router.use((_req,_res,next)=>enabled()===true?next():next(deny('AI_PILOT_DISABLED',404)));
  router.use(requireTraderSession(authService));
  for(const action of Object.keys(schemas))router.post('/'+action,async(req,res)=>{
    const result=await admit(async()=>{
      if(Object.keys(req.query).length)throw deny('AI_INVALID_REQUEST',400);
      const p=schemas[action].safeParse(req.body);
      if(!p.success)throw deny('AI_INVALID_REQUEST',400);
      await quota.consume(await runtime.quotaPrincipal(bearerToken(req),p.data,req.traderPrincipal));
      if(enabled()!==true)throw deny('AI_PILOT_DISABLED',404);
      const controller=new AbortController(),abort=()=>controller.abort();
      res.once('close',abort);
      try{
        const value=await runtime[action](bearerToken(req),p.data,{signal:controller.signal});
        if(controller.signal.aborted||enabled()!==true)throw deny('AI_PILOT_DISABLED',404);
        return {contractVersion:'restricted-pilot-v1',mode:runtime.mode,executionAllowed:false,...value};
      }finally{res.removeListener('close',abort);}
    });
    if(action==='generate'&&runtime.mode==='WORKSPACE_CHAT'&&result.state!=='ANSWERED'){
      // Aggregate diagnosis only. Never log the prompt, answer, account or provider response.
      req.log?.warn({aiOutcome:result.state,aiFailureReason:result.failureReason??'UNCLASSIFIED',
        aiInputTokens:result.usage?.inputTokens??null,aiOutputTokens:result.usage?.outputTokens??null},'AI workspace response incomplete');
    }
    res.json(result);
  });
  router.use(aiSafeError);return router;
}
module.exports={createRestrictedPilotRouter};
