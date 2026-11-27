'use strict';
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {createAiReadStore}=require('../ai-read-store');
const {createLiveAdmission}=require('./live-admission');
const {createLiveRuntimeConfig,assertLiveRuntime,createLiveSessionAuthority}=require('./live-runtime-config');
const {createRestrictedPilotPolicy,createPersonalDemoPilotAccountResolver}=require('./restricted-pilot-policy');
const {createProviderUsageRecorder}=require('./provider-billing-reconciliation');
const {createLiveOpenAiTransport}=require('./live-openai-transport');
const {createMarketContextSource}=require('../intelligence/context-source');
const {createTrustedContextAssembler}=require('../intelligence/trusted-context');
const {createResponseEngine}=require('../intelligence/response-engine');
const {scopeFor}=require('../ai-read-gateway');
const {AppError}=require('../../../shared/errors/app-error');
const id=v=>typeof v==='string'&&/^[a-f0-9]{24}$/.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=()=>new AppError('Restricted AI pilot unavailable',{statusCode:403,code:'AI_PILOT_DENIED'});
const guard=v=>{if(!v)throw fail();};
const questions=Object.freeze({
  HISTORICAL_OVERVIEW:{profile:'MARKET_OVERVIEW',question:'Summarize the available historical closed-candle evidence.'},
  HISTORICAL_STRUCTURE:{profile:'STRUCTURE',question:'Describe the historical closed-candle structure using the supplied references.'}
});
const runtimes=new WeakSet();
// Only trusted application bootstrap may supply release approval, custody,
// membership, data licensing and service-authority ports. No defaults, no
// public config, no externally supplied model, prompt, token cap or tools.
function createRestrictedPilotRuntime({env=process.env,descriptor,policy,secretPort,verifyRelease,verifyApproval,
  resolveMembership,resolveDataRights,validatePayload,countUpperBound,resolveBillingActor,authorizeBilling,
  authService,gateway,governanceStore,marketRuntime}={}){
  if(env.ACG_AI_LIVE_PROVIDER_ENABLED!=='true'||env.ACG_AI_RESTRICTED_PILOT_ENABLED!=='true')return null;
  guard([verifyRelease,verifyApproval,resolveMembership,resolveDataRights,validatePayload,countUpperBound,
    resolveBillingActor,authorizeBilling].every(f=>typeof f==='function'));
  const active=()=>env.ACG_AI_RESTRICTED_PILOT_ENABLED==='true'&&verifyRelease()===true;
  const config=createLiveRuntimeConfig({env,descriptor,secretPort,verifyRelease:active});
  const d=config.descriptor;
  guard(policy?.descriptorId===d.descriptorId&&policy?.policyVersion===d.policyVersion&&policy?.enabled===true);
  const pilot=createRestrictedPilotPolicy({policy,verifyApproval,resolveMembership,resolveDataRights,validatePayload,
    resolveAccount:createPersonalDemoPilotAccountResolver({store:createAiReadStore()})});
  const source=createMarketContextSource(marketRuntime);
  async function context(token,input){
    assertLiveRuntime(config);
    const principal=await authService.authenticateSessionToken(token);
    const {channel,...scope}=scopeFor(principal,input.accountId,Date.now(),input.action!=='revoke');
    const owner=Object.freeze({...scope,connectionId:input.connectionId});
    const authz=createLiveSessionAuthority({authService,gateway,governanceStore,sessionToken:()=>token,marketEntitlement:pilot.marketEntitlement});
    const workspace=Object.freeze({symbol:input.symbol,timeframe:input.timeframe,includeChartContext:true});
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
    async function allowed(purpose='CLAIM'){
      assertLiveRuntime(config);
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
    async grant(token,input){
      const x=await context(token,input);await x.allowed('GRANT');
      return x.admission.grant(x.owner,{...x.binding,expectedRevision:input.expectedRevision,explicitConsent:input.explicitConsent,
        expiresAtMs:Math.min(Date.now()+15*60000,policy.expiresAtMs)});
    },
    async revoke(token,input){
      const x=await context(token,{...input,action:'revoke'});
      return x.admission.revoke(x.owner,input.expectedRevision);
    },
    async generate(token,input,{signal}={}){
      const x=await context(token,input),q=questions[input.intent];guard(q);
      const pinned=await x.admission.assertConsent(x.owner,x.binding);
      const allowed=async()=>{
        await x.allowed();guard(!signal?.aborted);
        await x.admission.assertConsent(x.owner,{...x.binding,consentRevision:pinned.consentRevision});return true;
      };
      const scope=Object.fromEntries(['tenantId','actorId','sessionId','accountId'].map(k=>[k,x.owner[k]]));
      const request={scope,symbol:x.workspace.symbol,timeframes:[x.workspace.timeframe],limit:64,sessionWindows:[]};
      const assembler=createTrustedContextAssembler({source:{instrument:s=>source.instrument(s),candles:r=>source.candles(r),quote:()=>null},
        authorize:async r=>isDeepStrictEqual(r,request)&&await allowed()});
      const engine=createResponseEngine({authorize:async r=>r.profile===q.profile&&isDeepStrictEqual(r.marketRequest,request)&&await allowed()});
      const chart=await assembler.assemble(request);
      const {ticket,prompt}=await engine.prepare({scope,profile:q.profile,question:q.question,context:chart});
      const transport=createLiveOpenAiTransport({config,admission:x.admission,authorizeExport:pilot.authorizeExport,
        countUpperBound,recordUsage:x.recordUsage,verifyCandidate:({ticket,candidate})=>engine.verify({ticket,scope,candidate})});
      const result=await transport.run({scope:x.owner,workspace:x.workspace,prompt,ticket,operationId:input.operationId,
        authorizeMessage:allowed,signal});
      // A late revocation or pause suppresses a verified answer, not billing.
      if(result.state==='VERIFIED'){await allowed();await x.admission.assertDisclosure(x.owner,input.operationId);}
      return result;
    }
  });
  runtimes.add(runtime);return runtime;
}
const isRestrictedPilotRuntime=runtime=>runtimes.has(runtime);
module.exports={createRestrictedPilotRuntime,isRestrictedPilotRuntime};
