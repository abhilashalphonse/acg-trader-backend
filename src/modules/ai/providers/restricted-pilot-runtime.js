'use strict';
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {createAiReadStore}=require('../ai-read-store');
const {createLiveAdmission}=require('./live-admission');
const {LivePlatform,LiveControl,LiveConsent}=require('./live-admission.model');
const {createLiveRuntimeConfig,assertLiveRuntime,createLiveSessionAuthority}=require('./live-runtime-config');
const {createRestrictedPilotPolicy,createPersonalDemoPilotAccountResolver}=require('./restricted-pilot-policy');
const {createProviderUsageRecorder}=require('./provider-billing-reconciliation');
const {createLiveOpenAiTransport,buildBody}=require('./live-openai-transport');
const {createMarketContextSource}=require('../intelligence/context-source');
const {attachEconomicCalendar}=require('../intelligence/economic-calendar-context');
const {createTrustedContextAssembler}=require('../intelligence/trusted-context');
const {createResponseEngine}=require('../intelligence/response-engine');
const {scopeFor}=require('../ai-read-gateway');
const {createFundedStaffAuthority}=require('./funded-staff-authority');
const {AppError}=require('../../../shared/errors/app-error');
const {workspaceStage}=require('../ai-http-security');
const {classifyWorkspaceQuestion}=require('../intelligence/workspace-context-selection');
const id=v=>typeof v==='string'&&/^[a-f0-9]{24}$/.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=()=>new AppError('Restricted AI pilot unavailable',{statusCode:403,code:'AI_PILOT_DENIED'});
const guard=v=>{if(!v)throw fail();};
const questions=Object.freeze({
  HISTORICAL_OVERVIEW:{profile:'MARKET_OVERVIEW',question:'Summarize the available historical closed-candle evidence.'},
  HISTORICAL_STRUCTURE:{profile:'STRUCTURE',question:'Describe the historical closed-candle structure using the supplied references.'}
});
const educationQuestions=Object.freeze({
  EDUCATION_STRUCTURE:{profile:'EDUCATION',question:'Explain market structure and break of structure.'},
  EDUCATION_LIQUIDITY:{profile:'EDUCATION',question:'Explain potential liquidity references.'},
  EDUCATION_FVG:{profile:'EDUCATION',question:'Explain fair value gaps.'}
});
const runtimes=new WeakSet();
// Only trusted application bootstrap may supply release approval, custody,
// membership, data licensing and service-authority ports. No defaults, no
// public config, no externally supplied model, prompt, token cap or tools.
function createRestrictedPilotRuntime({env=process.env,descriptor,policy,secretPort,verifyRelease,verifyApproval,
  resolveMembership,resolveDataRights,validatePayload,countUpperBound,resolveBillingActor,authorizeBilling,
  authService,gateway,governanceStore,marketRuntime,readAiCalendarSnapshot=null,fundedStaff=false,educationOnly=false,workspaceChat=false,isolatedWorkspaceLoopback=null}={}){
  if(env.ACG_AI_LIVE_PROVIDER_ENABLED!=='true'||env.ACG_AI_RESTRICTED_PILOT_ENABLED!=='true')return null;
  guard([verifyRelease,verifyApproval,resolveMembership,resolveDataRights,validatePayload,countUpperBound,
    resolveBillingActor,authorizeBilling].every(f=>typeof f==='function'));
  const active=()=>env.ACG_AI_RESTRICTED_PILOT_ENABLED==='true'&&verifyRelease()===true;
  const config=createLiveRuntimeConfig({env,descriptor,secretPort,verifyRelease:active});
  const d=config.descriptor;
  guard(policy?.descriptorId===d.descriptorId&&policy?.policyVersion===d.policyVersion&&policy?.enabled===true);
  const expiresAtMs=policy.expiresAtMs;
  const funded=fundedStaff===true?createFundedStaffAuthority({authService,env}):null;
  const pilot=createRestrictedPilotPolicy({policy,verifyApproval,resolveMembership,resolveDataRights,validatePayload,
    resolveAccount:funded?null:createPersonalDemoPilotAccountResolver({store:createAiReadStore()}),fundedStaff:!!funded});
  guard((!educationOnly&&!workspaceChat)||fundedStaff===true);
  guard(!workspaceChat||(!educationOnly&&policy.workspaceChat===true));
  const workspaceSource=workspaceChat?require('./funded-workspace-context').createWorkspaceContext({marketRuntime}):null;
  const source=educationOnly?null:createMarketContextSource(marketRuntime);
  async function context(token,input){
    assertLiveRuntime(config);
    let owner,authz;
    if(funded){
      owner=await funded.resolve(token,input.accountId,input.connectionId);
      const resolve=async(s,purpose)=>{
        const current=await funded.resolve(token,s.accountId,s.connectionId);
        guard(isDeepStrictEqual(current,owner)&&isDeepStrictEqual(current,s));
        return current;
      };
      authz={authorizeSession:resolve,authorizeMarket:async(s,w,purpose)=>{
        await resolve(s,purpose);
        if(await pilot.marketEntitlement(s,w,purpose)!==true)return false;
        await resolve(s,purpose);return true;
      }};
    }else{
      const principal=await authService.authenticateSessionToken(token);
      const {channel,...scope}=scopeFor(principal,input.accountId,Date.now(),input.action!=='revoke');
      owner=Object.freeze({...scope,connectionId:input.connectionId});
      authz=createLiveSessionAuthority({authService,gateway,governanceStore,sessionToken:()=>token,marketEntitlement:pilot.marketEntitlement});
    }
    if(educationOnly)guard(input.symbol==='EDUCATION'&&input.timeframe==='1m');
    const workspace=Object.freeze({symbol:input.symbol,timeframe:input.timeframe,includeChartContext:!educationOnly});
    const binding={descriptorId:d.descriptorId,policyVersion:d.policyVersion,symbol:workspace.symbol,timeframe:workspace.timeframe};
    // A reconciliation witness is local to this authenticated request and
    // tied to its exact provider response. It cannot be submitted by clients.
    let witness=null;
    const admission=createLiveAdmission({...authz,resolvePrice:config.resolvePrice,
      authorizeAdmin:async()=>false,authorizePlatformAdmin:async()=>false,
      authorizeReconciliation:async(actor,key,kind,evidenceId,usage)=>{
        if(!witness||!isDeepStrictEqual(witness.actor,actor)||key!==witness.data.attemptId||kind!==witness.data.kind||
          evidenceId!==hash(['provider-usage-v1',witness.data])||
          !['inputTokens','outputTokens','providerResponseHash'].every(k=>usage[k]===witness.data[k]))return false;
        return await authorizeBilling(actor,owner,witness.data)===true;
      }});
    // Proposed pilot ceilings are maxima, never automatic enablement. Read
    // majority-committed control values; revision fencing in the ledger
    // invalidates consent if either control changes before dispatch.
    async function checkPilotLimits(){
      const p=await LivePlatform.findById('platform').read('primary').readConcern('majority').maxTimeMS(2000).lean();
      const t=await LiveControl.findById(owner.tenantId).read('primary').readConcern('majority').maxTimeMS(2000).lean();
      guard(p?.enabled===true&&t?.enabled===true&&p.dailyPicoUsd<=1000000000000&&
        p.maxOutstandingPicoUsd<=1000000000000&&p.maxOutstandingRequests===1&&p.dailyRequests<=100&&
        t.tenantDailyPicoUsd<=1000000000000&&t.actorDailyPicoUsd<=1000000000000&&t.actorDailyRequests<=20);
    }
    async function allowed(purpose='CLAIM'){
      assertLiveRuntime(config);await checkPilotLimits();
      const fresh=await authz.authorizeSession(owner,purpose);
      guard(isDeepStrictEqual(fresh,owner)&&await authz.authorizeMarket(owner,binding,purpose)===true);
      return true;
    }
    async function recordUsage(input){
      // Only called by the closed-over TLS adapter; no HTTP billing route.
      const actor=await resolveBillingActor(owner.tenantId);
      guard(actor?.tenantId===owner.tenantId&&id(actor.actorId)&&actor.actorId!==owner.actorId);
      const recorder=createProviderUsageRecorder({admission,actor,authenticateEvidence:async(data)=>{
        if(await authorizeBilling(actor,owner,data)!==true)return false;
        witness={actor:Object.freeze({...actor}),data};return true;
      }});
      try{return await recorder(input);}finally{witness=null;}
    }
    return {owner,workspace,binding,admission,allowed,recordUsage};
  }
  const runtime=Object.freeze({
    mode:workspaceChat?'WORKSPACE_CHAT':educationOnly?'EDUCATION_ONLY':'HISTORICAL_REFERENCE_ONLY',
    async quotaPrincipal(token,input,principal){
      if(!funded)return principal;
      const s=await funded.resolve(token,input.accountId,input.connectionId);
      return {tenantId:s.tenantId,userId:s.actorId};
    },
    async status(token,input){
      const x=await context(token,input);await x.allowed('GRANT');
      const key=hash(['consent',...['tenantId','actorId','sessionId','accountId','connectionId'].map(k=>x.owner[k])]);
      const g=await LiveConsent.findById(key).read('primary').readConcern('majority').maxTimeMS(2000).lean();
      return {revision:g?.revision??0,active:g?.active===true&&g.expiresAtMs>Date.now()&&g.descriptorId===d.descriptorId&&g.policyVersion===d.policyVersion&&g.symbol===input.symbol&&g.timeframe===input.timeframe,expiresAtMs:g?.expiresAtMs??null,model:d.modelId};
    },
    async grant(token,input){
      const x=await context(token,input);await x.allowed('GRANT');
      return x.admission.grant(x.owner,{...x.binding,expectedRevision:input.expectedRevision,explicitConsent:input.explicitConsent,
        expiresAtMs:Math.min(Date.now()+15*60000,expiresAtMs)});
    },
    async revoke(token,input){
      const x=await context(token,{...input,action:'revoke'});
      return x.admission.revoke(x.owner,input.expectedRevision);
    },
    async generate(token,input,{signal}={}){
      const x=workspaceChat?await workspaceStage('ACCESS',()=>context(token,input)):await context(token,input);
      if(workspaceChat){
        const {safeQuestion,buildWorkspaceBody}=require('./funded-workspace-context');
        guard(input.intent==='WORKSPACE_CHAT'&&safeQuestion(input.question)&&Array.isArray(input.history)&&
          typeof input.includeAccount==='boolean'&&typeof input.includeMarket==='boolean');
        const pinned=await x.admission.assertConsent(x.owner,x.binding);
        const allowed=async()=>{
          await x.allowed();guard(!signal?.aborted);
          await x.admission.assertConsent(x.owner,{...x.binding,consentRevision:pinned.consentRevision});return true;
        };
        const scope=Object.fromEntries(['tenantId','actorId','sessionId','accountId'].map(k=>[k,x.owner[k]]));
        const profile=classifyWorkspaceQuestion(input.question,input.history);
        const snapshot=await workspaceStage('ACCESS',()=>workspaceSource.read({scope,workspace:x.workspace,includeAccount:input.includeAccount&&profile==='FULL',includeMarket:input.includeMarket,authorize:allowed}));
        const market=await workspaceStage('CALENDAR_CONTEXT',()=>attachEconomicCalendar(snapshot.market,readAiCalendarSnapshot));
        const body=await workspaceStage('PROMPT_BUILD',()=>buildWorkspaceBody(d,{question:input.question,history:input.history,...snapshot,market}));
        const prompt={packageId:hash(body),expiresAtMs:Date.now()+28000};
        const transport=createLiveOpenAiTransport({config,admission:x.admission,workspaceChat:true,isolatedLoopback:isolatedWorkspaceLoopback,
          authorizeExport:async request=>isDeepStrictEqual(request.payload,body)&&await pilot.authorizeExport(request),
          countUpperBound,recordUsage:x.recordUsage,verifyCandidate:async()=>({verified:false})});
        const result=await workspaceStage('PROVIDER_ADMISSION_OR_RESPONSE',()=>transport.run({scope:x.owner,workspace:x.workspace,prompt,workspaceBody:body,
          operationId:input.operationId,authorizeMessage:allowed,signal}));
        if(result.state==='ANSWERED')await workspaceStage('DISCLOSURE',async()=>{await allowed();await x.admission.assertDisclosure(x.owner,input.operationId);});
        return {...result,operationId:input.operationId,workspace:{symbol:input.symbol,timeframe:input.timeframe},
          context:{market:!!snapshot.market,account:!!snapshot.account,marketAsOfMs:snapshot.market?.asOfMs??null,accountAsOfMs:snapshot.account?.asOfMs??null,
            quoteStatus:snapshot.market?.quote?.status??null,quoteReason:snapshot.market?.quote?.reason??null,
            quoteSessionVerification:snapshot.market?.quote?.sessionVerification??null,quoteObservationAvailable:!!snapshot.market?.quote?.observedQuote}};
      }
      const q=(educationOnly?educationQuestions:questions)[input.intent];guard(q);
      guard(!Object.hasOwn(input,'question')&&!Object.hasOwn(input,'history')&&!Object.hasOwn(input,'includeAccount')&&!Object.hasOwn(input,'includeMarket'));
      const pinned=await x.admission.assertConsent(x.owner,x.binding);
      const allowed=async()=>{
        await x.allowed();guard(!signal?.aborted);
        await x.admission.assertConsent(x.owner,{...x.binding,consentRevision:pinned.consentRevision});return true;
      };
      const scope=Object.fromEntries(['tenantId','actorId','sessionId','accountId'].map(k=>[k,x.owner[k]]));
      const request=educationOnly?null:{scope,symbol:x.workspace.symbol,timeframes:[x.workspace.timeframe],limit:64,sessionWindows:[]};
      const assembler=educationOnly?null:createTrustedContextAssembler({source:{instrument:s=>source.instrument(s),candles:r=>source.candles(r),quote:()=>null},
        authorize:async r=>isDeepStrictEqual(r,request)&&await allowed()});
      const engine=createResponseEngine({authorize:async r=>r.profile===q.profile&&isDeepStrictEqual(r.marketRequest,request)&&await allowed()});
      const chart=educationOnly?null:await assembler.assemble(request);
      const sourceProvider=educationOnly?undefined:chart.instrument.provider;
      const sourceApproved=async()=>educationOnly||!funded||await resolveDataRights({scope:x.owner,...x.binding,providerId:'openai',sourceProvider})===true;
      guard(await sourceApproved());
      const {ticket,prompt}=await engine.prepare({scope,profile:q.profile,question:q.question,context:chart});
      const body=buildBody(d,prompt);
      const transport=createLiveOpenAiTransport({config,admission:x.admission,educationOnly,authorizeExport:async request=>
        isDeepStrictEqual(request.payload,body)&&await sourceApproved()&&await pilot.authorizeExport(request),
        countUpperBound,recordUsage:x.recordUsage,verifyCandidate:({ticket,candidate})=>engine.verify({ticket,scope,candidate})});
      const result=await transport.run({scope:x.owner,workspace:x.workspace,prompt,ticket,operationId:input.operationId,
        authorizeMessage:allowed,signal});
      // A late revocation or pause suppresses a verified answer, not billing.
      if(result.state==='VERIFIED'){await allowed();await x.admission.assertDisclosure(x.owner,input.operationId);}
      return {...result,source:{provider:educationOnly?'ACG_INTERNAL_ORIGINAL':sourceProvider},workspace:x.workspace,operationId:input.operationId};
    }
  });
  runtimes.add(runtime);return runtime;
}
const isRestrictedPilotRuntime=runtime=>runtimes.has(runtime);
module.exports={createRestrictedPilotRuntime,isRestrictedPilotRuntime};
