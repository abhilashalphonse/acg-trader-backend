'use strict';
const {createHash}=require('node:crypto');
const {z}=require('zod');
const {createMarketContextSource}=require('../intelligence/context-source');
const {LivePlatform,LiveControl}=require('./live-admission.model');
const {requestCap,validateCaps}=require('./funded-staff-request-cap');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const objectId=z.string().regex(/^[a-f0-9]{24}$/);
const approvalSchema=z.object({
  approvalId:z.string().regex(/^[A-Za-z0-9._-]{8,128}$/),
  rightsEvidence:z.string().min(12).max(256),
  expiresAtMs:z.number().int().positive(),
  tenantId:objectId,
  provider:z.enum(['twelve-data','accelpix']),
  instruments:z.array(z.object({symbol:z.string().regex(/^[A-Z0-9._-]{1,32}$/),
    timeframe:z.enum(['1m','5m','15m','30m','1h','4h','1d','1w'])}).strict()).min(1).max(10),
}).strict();
const fail=()=>Object.assign(Error('Funded live pilot configuration unavailable'),{code:'AI_FUNDED_CONFIG_DENIED'});
const requireTrue=x=>{if(!x)throw fail();};
const read=q=>q.read('primary').readConcern('majority').maxTimeMS(2000).lean();
// Operator-provided approval record references independently reviewed contractual
// evidence. It is not itself proof of a market-data license. A missing record,
// stale price/rights approval, key or disabled ledger leaves preview intact.
async function loadFundedPilotBootstrap({env=process.env,marketRuntime,now=Date.now}={}){
  if(env.ACG_AI_FUNDED_LIVE_ENABLED!=='true'||env.ACG_AI_LIVE_PROVIDER_ENABLED!=='true'||
    env.ACG_AI_RESTRICTED_PILOT_ENABLED!=='true')return null;
  const workspaceChat=env.ACG_AI_FUNDED_WORKSPACE_CHAT_ENABLED==='true';
  const workspaceStreaming=workspaceChat&&env.ACG_AI_FUNDED_WORKSPACE_STREAMING_ENABLED==='true';
  const educationOnly=!workspaceChat&&env.ACG_AI_FUNDED_EDUCATION_ONLY==='true';
  const raw=workspaceChat?env.ACG_AI_FUNDED_WORKSPACE_EXPIRES_AT_MS:educationOnly?env.ACG_AI_FUNDED_EDUCATION_EXPIRES_AT_MS:env.ACG_AI_FUNDED_EXPORT_APPROVAL_JSON;
  requireTrue(typeof raw==='string'&&Buffer.byteLength(raw)<=8192);
  let a;
  if(workspaceChat){
    // Operator authorization for a staff-only test, not a representation
    // that a third-party market-data agreement has been independently reviewed.
    requireTrue(/^\d{13}$/.test(raw)&&env.ACG_AI_FUNDED_WORKSPACE_EXPORT_AUTHORIZED==='true');
    a={approvalId:'staff-workspace-operator-authorized-v1',tenantId:env.ACG_AI_STAFF_PREVIEW_TENANT_ID,
      expiresAtMs:Number(raw),instruments:[],workspaceChat:true};
  }else if(educationOnly){
    requireTrue(/^\d{13}$/.test(raw)&&!env.ACG_AI_FUNDED_EXPORT_APPROVAL_JSON);
    a={approvalId:'staff-education-only-v1',tenantId:env.ACG_AI_STAFF_PREVIEW_TENANT_ID,
      expiresAtMs:Number(raw),instruments:[{symbol:'EDUCATION',timeframe:'1m'}]};
  }else{
    let parsed;try{parsed=approvalSchema.safeParse(JSON.parse(raw));}catch{throw fail();}
    requireTrue(parsed.success);a=parsed.data;
  }
  const staff=env.ACG_AI_STAFF_PREVIEW_EMAIL?.trim().toLowerCase();
  requireTrue(objectId.safeParse(a.tenantId).success&&a.tenantId===env.ACG_AI_STAFF_PREVIEW_TENANT_ID&&env.ACG_AI_STAFF_PREVIEW_ENABLED==='true'&&
    typeof staff==='string'&&staff.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(staff)&&
    a.expiresAtMs>now()&&a.expiresAtMs-now()<=86400000&&typeof env.ACG_AI_FUNDED_OPENAI_API_KEY==='string'&&
    /^sk-[\x21-\x7e]{20,4090}$/.test(env.ACG_AI_FUNDED_OPENAI_API_KEY));
  const actorId=hash(['funded-staff-ai-v1',a.tenantId,staff]).slice(0,24);
  const billingActor=Object.freeze({tenantId:a.tenantId,actorId:hash(['funded-ai-internal-billing-v1',a.tenantId]).slice(0,24)});
  const policyFields={enabled:true,expiresAtMs:a.expiresAtMs,members:[{tenantId:a.tenantId,actorId}],instruments:a.instruments,approvalDigest:hash(a),...(workspaceChat?{workspaceChat:true,workspaceReasoningEffort:'low',...(workspaceStreaming?{workspaceStreaming:true}:{})}:{})};
  const policyVersion=hash(policyFields);
  // Official standard rates reviewed 2026-11-27; pico-USD per token.
  // Treat cached tokens as uncached for the reservation. No tools or other tiers.
  const fields={providerId:'openai',modelId:'gpt-6-luna',policyVersion,inputRatePicoUsd:100000,outputRatePicoUsd:500000,
    maxInputTokens:32768,maxOutputTokens:workspaceChat?2048:1024,responseMode:'JSON_SCHEMA',store:false,streaming:workspaceStreaming,reviewStatus:'APPROVED_LIVE'};
  const descriptor=Object.freeze({...fields,descriptorId:hash(fields)});
  const policy=Object.freeze({...policyFields,policyVersion,descriptorId:descriptor.descriptorId});
  const cap=requestCap(env,workspaceChat,now());
  const capActive=()=>{try{const current=requestCap(env,workspaceChat,now());return current.dailyRequests===cap.dailyRequests&&current.expiresAtMs===cap.expiresAtMs;}catch{return false;}};
  const active=()=>capActive()&& (env.ACG_AI_FUNDED_WORKSPACE_STREAMING_ENABLED==='true')===workspaceStreaming&&env.ACG_AI_FUNDED_LIVE_ENABLED==='true'&&env.ACG_AI_STAFF_PREVIEW_ENABLED==='true'&&
    env.ACG_AI_LIVE_PROVIDER_ENABLED==='true'&&env.ACG_AI_RESTRICTED_PILOT_ENABLED==='true'&&
    (workspaceChat?env.ACG_AI_FUNDED_WORKSPACE_CHAT_ENABLED==='true'&&env.ACG_AI_FUNDED_WORKSPACE_EXPORT_AUTHORIZED==='true'&&env.ACG_AI_FUNDED_WORKSPACE_EXPIRES_AT_MS===raw:
      env.ACG_AI_FUNDED_WORKSPACE_CHAT_ENABLED!=='true'&&(educationOnly?env.ACG_AI_FUNDED_EDUCATION_ONLY==='true'&&env.ACG_AI_FUNDED_EDUCATION_EXPIRES_AT_MS===raw&&!env.ACG_AI_FUNDED_EXPORT_APPROVAL_JSON:
      env.ACG_AI_FUNDED_EDUCATION_ONLY!=='true'&&env.ACG_AI_FUNDED_EXPORT_APPROVAL_JSON===raw))&&env.ACG_AI_STAFF_PREVIEW_TENANT_ID===a.tenantId&&
    env.ACG_AI_STAFF_PREVIEW_EMAIL?.trim().toLowerCase()===staff&&now()<a.expiresAtMs&&
    typeof env.ACG_AI_FUNDED_OPENAI_API_KEY==='string'&&/^sk-[\x21-\x7e]{20,4090}$/.test(env.ACG_AI_FUNDED_OPENAI_API_KEY);
  const p=await read(LivePlatform.findById('platform')),t=await read(LiveControl.findById(a.tenantId));
  requireTrue(validateCaps(p,t,cap.dailyRequests));
  const source=educationOnly?null:createMarketContextSource(marketRuntime);
  const belongs=s=>s?.tenantId===a.tenantId&&s?.actorId===actorId;
  return Object.freeze({
    fundedStaff:true,educationOnly,workspaceChat,descriptor,policy,dailyRequests:cap.dailyRequests,verifyRelease:active,
    verifyApproval:async v=>active()&&v.policyVersion===policyVersion&&v.descriptorId===descriptor.descriptorId,
    resolveMembership:async(s,v)=>active()&&belongs(s)&&v===policyVersion,
    resolveDataRights:async({scope,symbol,timeframe,policyVersion:v,providerId,sourceProvider})=>{
      if(!active()||!belongs(scope)||v!==policyVersion||providerId!=='openai')return false;
      if(workspaceChat)return typeof symbol==='string'&&/^[A-Z0-9._-]{1,32}$/.test(symbol)&&
        ['1m','5m','15m','30m','1h','4h','1d','1w'].includes(timeframe)&&
        (sourceProvider===undefined||['twelve-data','accelpix'].includes(sourceProvider));
      if(!a.instruments.some(i=>i.symbol===symbol&&i.timeframe===timeframe)||
        (sourceProvider!==undefined&&sourceProvider!==a.provider))return false;
      if(educationOnly)return symbol==='EDUCATION'&&timeframe==='1m'&&sourceProvider===undefined;
      const i=await source.instrument(symbol);return i?.provider===a.provider;
    },
    // The runtime additionally requires exact canonical server-minted body
    // equality. Workspace mode accepts user text and scoped account projections;
    // historical and education modes retain their previous narrower contracts.
    validatePayload:async({scope,workspace,payload})=>{
      if(!active()||!belongs(scope)||payload.model!==descriptor.modelId||payload.store!==false||
        typeof payload.stream!=='boolean'||(payload.stream===true&&(!workspaceStreaming||payload.stream_options?.include_usage!==true||Object.keys(payload.stream_options).length!==1))||(payload.stream===false&&Object.hasOwn(payload,'stream_options'))||payload.max_completion_tokens!==descriptor.maxOutputTokens)return false;
      try{
        const data=JSON.parse(payload.messages[1].content);
        const keys=Object.keys(data).sort().join(',');
        if(workspaceChat){
          if(payload.reasoning_effort!=='low')return false;
          const {safeQuestion}=require('./funded-workspace-context');
          return keys==='account,history,knowledge,market,question'&&safeQuestion(data.question)&&Array.isArray(data.history)&&data.history.length<=6&&
            data.history.every(m=>['user','assistant'].includes(m.role)&&safeQuestion(m.text))&&
            (data.market===null||data.market?.schemaVersion==='adaptive-market-v1'&&data.market.symbol===workspace.symbol&&
              data.market.selectedTimeframe===workspace.timeframe&&Array.isArray(data.market.frames)&&data.market.frames.length>=1&&data.market.frames.length<=6&&
              data.market.frames[0].timeframe===workspace.timeframe&&new Set(data.market.frames.map(f=>f.timeframe)).size===data.market.frames.length&&
              data.market.frames.every(f=>['1m','5m','15m','30m','1h','4h','1d','1w'].includes(f.timeframe)&&Array.isArray(f.closedCandles)&&f.closedCandles.length<=128&&
                f.closedCandles.every(b=>Array.isArray(b)&&b.length===5&&b.every(Number.isFinite)))&&['twelve-data','accelpix'].includes(data.market.provider))&&
            (data.account===null||data.account?.source==='PERSISTED_ACCOUNT_SNAPSHOT')&&
            payload.response_format?.json_schema?.name==='acg_workspace_answer'&&
            ![scope.tenantId,scope.actorId,scope.sessionId,scope.accountId,staff].some(v=>JSON.stringify(payload).includes(v));
        }
        if(educationOnly){
          return keys==='evidence,knowledge,profile,question'&&data.profile==='EDUCATION'&&data.evidence===null&&
            ['Explain market structure and break of structure.','Explain potential liquidity references.','Explain fair value gaps.'].includes(data.question)&&
            workspace.symbol==='EDUCATION'&&workspace.timeframe==='1m'&&workspace.includeChartContext===false&&
            ![scope.tenantId,scope.actorId,scope.sessionId,scope.accountId,staff].some(v=>JSON.stringify(payload).includes(v));
        }
        const expected={MARKET_OVERVIEW:'Summarize the available historical closed-candle evidence.',
          STRUCTURE:'Describe the historical closed-candle structure using the supplied references.'};
        return keys==='evidence,knowledge,profile,question'&&Object.hasOwn(expected,data.profile)&&
          data.question===expected[data.profile]&&data.evidence?.symbol===workspace.symbol&&
          data.evidence?.quoteStatus==='UNAVAILABLE'&&data.evidence.frames?.length===1&&
          data.evidence.frames[0].timeframe===workspace.timeframe&&
          ![scope.tenantId,scope.actorId,scope.sessionId,scope.accountId,staff].some(v=>JSON.stringify(payload).includes(v));
      }catch{return false;}
    },
    // Conservative byte bound for text + schema and protocol framing.
    // Reject oversized requests rather than lower the reserved amount.
    countUpperBound:async body=>Buffer.byteLength(JSON.stringify(body),'utf8')+4096,
    secretPort:{async withSecret(fn){
      requireTrue(active());const buf=Buffer.from(env.ACG_AI_FUNDED_OPENAI_API_KEY,'ascii');
      try{return await fn(buf);}finally{buf.fill(0);}
    }},
    resolveBillingActor:async tenant=>tenant===a.tenantId?billingActor:null,
    authorizeBilling:async(actor,owner,data)=>actor?.tenantId===billingActor.tenantId&&actor?.actorId===billingActor.actorId&&
      belongs(owner)&&data.descriptorId===descriptor.descriptorId,
  });
}
module.exports={loadFundedPilotBootstrap};
