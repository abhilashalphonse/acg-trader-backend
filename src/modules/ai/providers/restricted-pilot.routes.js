'use strict';
const express=require('express');
const {z}=require('zod');
const {requireTraderSession,bearerToken}=require('../../auth/auth.middleware');
const {aiJsonBoundary,aiSafeError,createConcurrencyGate,workspaceFailureDiagnostic}=require('../ai-http-security');
const {isRestrictedPilotRuntime}=require('./restricted-pilot-runtime');
const {AppError}=require('../../../shared/errors/app-error');
const {classifyWorkspaceIntent}=require('../intelligence/workspace-context-selection');
const base=z.object({accountId:z.string().regex(/^[a-f0-9]{24}$/),connectionId:z.uuid(),
  symbol:z.string().regex(/^[A-Z0-9._-]{1,32}$/),timeframe:z.enum(['1m','5m','15m','30m','1h','4h','1d','1w'])}).strict();
const schemas={
  status:base,
  grant:base.extend({expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),explicitConsent:z.literal(true)}).strict(),
  revoke:base.extend({expectedRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1)}).strict(),
  draw:base.extend({actionId:z.uuid(),command:z.enum(['LIQUIDITY','FVG']),chartContextVersion:z.string().regex(/^[a-f0-9]{64}$/),latestClosedAtMs:z.number().int().positive().max(4102444800000)}).strict(),
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
    const wantsStream=action==='generate'&&runtime.mode==='WORKSPACE_CHAT'&&req.accepts(['application/json','text/event-stream'])==='text/event-stream';
    let opened=false,aiIntent=null,deltaCount=0,firstDeltaMs=null,startedAt=null,promptAudit=null;
    const event=(name,payload)=>{
      if(res.destroyed||res.writableEnded)return;
      if(!opened){
        res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'});
        res.vary('Accept');res.flushHeaders();opened=true;
      }
      res.write('event: '+name+'\ndata: '+JSON.stringify(payload)+'\n\n');res.flush?.();
    };
    try{
    const result=await admit(async()=>{
      if(Object.keys(req.query).length)throw deny('AI_INVALID_REQUEST',400);
      const p=schemas[action].safeParse(req.body);
      if(!p.success)throw deny('AI_INVALID_REQUEST',400);
      await quota.consume(await runtime.quotaPrincipal(bearerToken(req),p.data,req.traderPrincipal));
      if(enabled()!==true)throw deny('AI_PILOT_DISABLED',404);
      if(action==='generate'&&runtime.mode==='WORKSPACE_CHAT'&&p.data.intent==='WORKSPACE_CHAT'){
        aiIntent=classifyWorkspaceIntent(p.data.question,p.data.history);startedAt=Date.now();
      }
      const controller=new AbortController(),abort=()=>controller.abort();
      res.once('close',abort);
      try{
        const value=await runtime[action](bearerToken(req),p.data,{signal:controller.signal,onPromptAudit:aiIntent===null?undefined:audit=>{promptAudit=audit;},onProgress:wantsStream?stage=>{
          if(!controller.signal.aborted&&enabled()===true&&['CONTEXT','GENERATING'].includes(stage))event('progress',{stage});
        }:undefined,onDelta:wantsStream?delta=>{
          if(controller.signal.aborted||enabled()!==true||res.destroyed||res.writableEnded)throw deny('AI_PILOT_DISABLED',404);
          if(typeof delta!=='string'||!delta||Buffer.byteLength(delta,'utf8')>12000)throw deny('AI_INVALID_RESPONSE',500);
          event('delta',{text:delta});
          if(deltaCount===0)firstDeltaMs=Date.now()-startedAt;
          deltaCount++;
        }:undefined});
        if(controller.signal.aborted||enabled()!==true)throw deny('AI_PILOT_DISABLED',404);
        return {contractVersion:'restricted-pilot-v1',mode:runtime.mode,executionAllowed:false,...value};
      }finally{
        res.removeListener('close',abort);
        if(aiIntent!==null)req.log?.info({aiIntent,aiStreamRequested:wantsStream,aiDeltaCount:deltaCount,aiFirstDeltaMs:firstDeltaMs,aiRequestAborted:controller.signal.aborted},'AI workspace request telemetry');
      }
    });
    if(action==='generate'&&runtime.mode==='WORKSPACE_CHAT'&&result.state==='ANSWERED'){
      req.log?.info({aiIntent,aiOutcome:result.state,aiInputTokens:result.usage?.inputTokens??null,aiOutputTokens:result.usage?.outputTokens??null,aiDurationMs:startedAt===null?null:Date.now()-startedAt,aiStreamRequested:wantsStream,aiDeltaCount:deltaCount,aiFirstDeltaMs:firstDeltaMs,aiAccountUsed:result.context?.accountUsed??null,...promptAudit},'AI workspace response completed');
    }
    if(action==='generate'&&runtime.mode==='WORKSPACE_CHAT'&&result.state!=='ANSWERED'){
      // Aggregate diagnosis only. Never log the prompt, answer, account or provider response.
      req.log?.warn({aiOutcome:result.state,aiFailureReason:result.failureReason??'UNCLASSIFIED',
        aiInputTokens:result.usage?.inputTokens??null,aiOutputTokens:result.usage?.outputTokens??null,aiIntent,aiDurationMs:startedAt===null?null:Date.now()-startedAt,aiStreamRequested:wantsStream,aiDeltaCount:deltaCount,aiFirstDeltaMs:firstDeltaMs,aiAccountUsed:result.context?.accountUsed??null,...promptAudit},'AI workspace response incomplete');
    }
    if(action==='generate'&&runtime.mode==='WORKSPACE_CHAT'&&result.context?.market){
      req.log?.info({aiQuoteStatus:result.context.quoteStatus,aiQuoteReason:result.context.quoteReason,
        aiQuoteSessionVerification:result.context.quoteSessionVerification,aiQuoteObservationAvailable:result.context.quoteObservationAvailable},'AI workspace quote evidence');
    }
    if(wantsStream){if(!res.destroyed&&!res.writableEnded){event('result',result);res.end();}}
    else res.json(result);
    }catch(error){
      if(!opened)throw error;
      // After headers, do not delegate raw exceptions to Express or expose details.
      req.log?.warn({statusCode:500,code:'AI_UNAVAILABLE',...workspaceFailureDiagnostic(error)},'AI workspace stream failed');
      if(!res.destroyed&&!res.writableEnded){event('error',{code:'AI_UNAVAILABLE'});res.end();}
    }
  });
  router.use(aiSafeError);return router;
}
module.exports={createRestrictedPilotRouter};
