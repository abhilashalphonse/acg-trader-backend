'use strict';
const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {createApp}=require('../src/app');
const {Tenant}=require('../src/modules/tenancy/tenant.model');
const {TradingAccount}=require('../src/modules/accounts/trading-account.model');
const {FederationTicket}=require('../src/modules/auth/federation-ticket.model');
const {assertIsolated}=require('../src/modules/ai/providers/credit-ledger-store');
const {createLiveAdmission}=require('../src/modules/ai/providers/live-admission');
const {LivePlatform,LiveAttempt}=require('../src/modules/ai/providers/live-admission.model');
const {createFundedStaffAuthority}=require('../src/modules/ai/providers/funded-staff-authority');
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function runFundedPilotMountAcceptance({auth,foreignToken}){
  assertIsolated();
  await FederationTicket.createCollection();await FederationTicket.createIndexes();
  const tenant=await Tenant.create({name:'Funded synthetic pilot',slug:'funded-pilot-fixture',authModes:['FEDERATED']});
  const tenantId=String(tenant._id),staff='staff@example.test';
  const account=async(ref,owner)=>TradingAccount.create({tenantId,ownerExternalRef:owner,externalRef:ref,accountCode:ref,
    accountType:'CHALLENGE',riskDayKey:'2026-01-01',state:{initialBalance:'10000',balance:'10000',equity:'10000',freeMargin:'10000',dailyStartEquity:'10000'}});
  const a=await account('STAFFA','staff-owner'),b=await account('STAFFB','staff-alias'),other=await account('STAFFC','other-owner');
  const ids=[a,b].map(x=>String(x._id));
  const ticket=await auth.createFederationTicket({tenantId,ownerExternalRef:'staff-owner',ownerExternalRefs:['staff-alias'],accountIds:ids,
    metadata:{fundedCustomerEmail:staff}});
  const session=await auth.exchangeFederationTicket(ticket.ticket);
  const otherTicket=await auth.createFederationTicket({tenantId,ownerExternalRef:'other-owner',accountIds:[String(other._id)],metadata:{fundedCustomerEmail:'other@example.test'}});
  const otherSession=await auth.exchangeFederationTicket(otherTicket.ticket);
  const actor={tenantId,actorId:digest(['funded-staff-ai-v1',tenantId,staff]).slice(0,24)};
  const admin=createLiveAdmission({authorizeSession:async()=>null,authorizeMarket:async()=>false,
    authorizeAdmin:async x=>x.actorId===actor.actorId,authorizePlatformAdmin:async x=>x.actorId===actor.actorId,
    authorizeReconciliation:async()=>false,resolvePrice:async()=>null});
  const prior=await LivePlatform.findById('platform').lean();
  const caps={dailyPicoUsd:1000000000000,dailyRequests:20,maxOutstandingPicoUsd:1000000000000,maxOutstandingRequests:1};
  const platform=(await admin.setPlatformControl(actor,{...caps,enabled:true,expectedRevision:prior.revision}));
  await admin.setControl(actor,{enabled:true,expectedRevision:0,tenantDailyPicoUsd:1000000000000,actorDailyPicoUsd:1000000000000,tenantDailyRequests:20,actorDailyRequests:20});
  const fields={enabled:true,expiresAtMs:Date.now()+120000,members:[actor],instruments:[{symbol:'XAUUSD',timeframe:'1m'}],approvalDigest:'a'.repeat(64)};
  const policyVersion=digest(fields);
  const d={providerId:'openai',modelId:'synthetic-funded-mount-only',policyVersion,inputRatePicoUsd:100000,outputRatePicoUsd:500000,
    maxInputTokens:32768,maxOutputTokens:1024,responseMode:'JSON_SCHEMA',store:false,streaming:false,reviewStatus:'APPROVED_LIVE'};
  const descriptor={...d,descriptorId:digest(d)};
  let rights=true,secretReads=0;
  const bootstrap={fundedStaff:true,descriptor,policy:{...fields,policyVersion,descriptorId:descriptor.descriptorId},
    verifyRelease:()=>true,verifyApproval:async x=>x.policyVersion===policyVersion&&x.descriptorId===descriptor.descriptorId,
    resolveMembership:async s=>s.tenantId===tenantId&&s.actorId===actor.actorId,resolveDataRights:async()=>rights,
    validatePayload:async()=>false,countUpperBound:async()=>{throw Error('No calls permitted');},
    resolveBillingActor:async()=>null,authorizeBilling:async()=>false,secretPort:{withSecret(){secretReads++;throw Error('No provider calls permitted');}}};
  const flags={ACG_AI_READ_GATEWAY_ENABLED:'false',ACG_AI_FUNDED_LIVE_ENABLED:'true',ACG_AI_LIVE_PROVIDER_ENABLED:'true',
    ACG_AI_RESTRICTED_PILOT_ENABLED:'true',ACG_AI_STAFF_PREVIEW_ENABLED:'true',ACG_AI_STAFF_PREVIEW_TENANT_ID:tenantId,ACG_AI_STAFF_PREVIEW_EMAIL:staff};
  const original=Object.fromEntries(Object.keys(flags).map(k=>[k,process.env[k]]));
  let server;
  try{
    Object.assign(process.env,flags);
    const authority=createFundedStaffAuthority({authService:auth});
    const one=await authority.resolve(session.accessToken,ids[0],randomUUID()),two=await authority.resolve(session.accessToken,ids[1],randomUUID());
    assert.equal(one.actorId,two.actorId);assert.equal(one.actorId,actor.actorId);
    const app=createApp({marketRuntime:{enabled:false,health:()=>({enabled:false})},tradingRuntime:{enabled:true,health:()=>({enabled:true})},
      authRuntime:{authService:auth},restrictedPilotBootstrap:bootstrap});
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const root='http://127.0.0.1:'+server.address().port;
    const base={accountId:ids[0],connectionId:randomUUID(),symbol:'XAUUSD',timeframe:'1m'};
    const call=async(op,body={},token=session.accessToken)=>{
      const r=await fetch(root+'/v1/ai/pilot/'+op,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},
        body:JSON.stringify({...base,...body})});return {status:r.status,body:await r.json()};
    };
    const cap=await fetch(root+'/v1/ai/staff-preview/capability?accountId='+ids[0],{headers:{authorization:'Bearer '+session.accessToken}});
    assert.equal((await cap.json()).runtimeEnabled,true);
    assert.equal((await call('status')).status,200);
    assert.equal((await call('status',{accountId:ids[1]})).status,200);
    assert.equal((await call('status',{accountId:String(other._id)})).status,403);
    assert.equal((await call('status',{accountId:String(other._id)},otherSession.accessToken)).status,403);
    assert.equal((await call('status',{},foreignToken)).status,403);
    rights=false;assert.equal((await call('grant',{expectedRevision:0,explicitConsent:true})).status,403);rights=true;
    const count=await LiveAttempt.countDocuments({});
    const g=await call('grant',{expectedRevision:0,explicitConsent:true});assert.equal(g.status,200,JSON.stringify(g.body.error??{}));
    assert.equal((await call('revoke',{expectedRevision:g.body.revision})).status,200);
    assert.ok((await call('generate',{operationId:randomUUID(),intent:'HISTORICAL_OVERVIEW'})).status>=400);
    await TradingAccount.updateOne({_id:b._id},{$set:{status:'CLOSED'}});
    assert.equal((await call('status',{accountId:ids[1]})).status,403);
    process.env.ACG_AI_FUNDED_LIVE_ENABLED='false';
    assert.equal((await call('status')).status,404);
    assert.equal(await LiveAttempt.countDocuments({}),count);assert.equal(secretReads,0);
    console.log('PASS actual Funded federation staff authority across accounts, isolated budget actor, mounted status/consent, rights and account revocation; zero provider dispatch');
    // Exercise the education-only route through the same real federation and
    // billing authority. Capture the exact proposed body and deny it before
    // any reservation or secret access. No public network is used by this test.
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;
    process.env.ACG_AI_FUNDED_LIVE_ENABLED='true';
    const {loadFundedPilotBootstrap}=require('../src/modules/ai/providers/funded-pilot-bootstrap');
    const eduEnv={...flags,ACG_AI_FUNDED_EDUCATION_ONLY:'true',ACG_AI_FUNDED_EDUCATION_EXPIRES_AT_MS:String(Date.now()+120000),
      ACG_AI_FUNDED_OPENAI_API_KEY:'sk-synthetic-do-not-send-'.padEnd(40,'x')};
    const realBootstrap=await loadFundedPilotBootstrap({env:eduEnv,marketRuntime:null});
    assert.equal(realBootstrap.educationOnly,true);assert.equal(realBootstrap.descriptor.modelId,'gpt-6-luna');
    assert.equal(await realBootstrap.resolveDataRights({scope:actor,symbol:'XAUUSD',timeframe:'1m',providerId:'openai',policyVersion:realBootstrap.policy.policyVersion}),false);
    eduEnv.ACG_AI_FUNDED_EDUCATION_ONLY='false';assert.equal(realBootstrap.verifyRelease(),false);
    const eduFields={...fields,instruments:[{symbol:'EDUCATION',timeframe:'1m'}],approvalDigest:'b'.repeat(64)};
    const eduPolicyVersion=digest(eduFields);
    const eduDescriptorFields={...d,policyVersion:eduPolicyVersion};
    const eduDescriptor={...eduDescriptorFields,descriptorId:digest(eduDescriptorFields)};
    let examined=0;
    const eduBootstrap={...bootstrap,educationOnly:true,descriptor:eduDescriptor,
      policy:{...eduFields,policyVersion:eduPolicyVersion,descriptorId:eduDescriptor.descriptorId},
      verifyApproval:async v=>v.policyVersion===eduPolicyVersion&&v.descriptorId===eduDescriptor.descriptorId,
      resolveDataRights:async w=>w.symbol==='EDUCATION'&&w.timeframe==='1m'&&w.sourceProvider===undefined,
      validatePayload:async ({payload})=>{
        const data=JSON.parse(payload.messages[1].content);
        assert.equal(data.evidence,null);assert.equal(data.profile,'EDUCATION');
        assert.equal(data.question,'Explain fair value gaps.');
        assert.ok(data.knowledge.entries.every(x=>x.origin==='ACG_INTERNAL_ORIGINAL'));
        for(const v of [tenantId,actor.actorId,staff,...ids])assert.ok(!JSON.stringify(payload).includes(v));
        assert.equal(payload.store,false);assert.equal(payload.stream,false);examined++;
        return false;
      }};
    const eduApp=createApp({marketRuntime:{enabled:false,health:()=>({enabled:false})},
      tradingRuntime:{enabled:true,health:()=>({enabled:true})},authRuntime:{authService:auth},restrictedPilotBootstrap:eduBootstrap});
    server=await new Promise(resolve=>{const s=eduApp.listen(0,'127.0.0.1',()=>resolve(s));});
    const eduRoot='http://127.0.0.1:'+server.address().port;
    const eduBase={...base,connectionId:randomUUID(),symbol:'EDUCATION'};
    const eduCall=async(op,extra={})=>{
      const response=await fetch(eduRoot+'/v1/ai/pilot/'+op,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+session.accessToken},
        body:JSON.stringify({...eduBase,...extra})});return {status:response.status,body:await response.json()};
    };
    const eduCap=await fetch(eduRoot+'/v1/ai/staff-preview/capability?accountId='+ids[0],{headers:{authorization:'Bearer '+session.accessToken}});
    assert.equal((await eduCap.json()).runtimeMode,'EDUCATION_ONLY');
    const eduGrant=await eduCall('grant',{explicitConsent:true,expectedRevision:0});
    assert.equal(eduGrant.status,200,JSON.stringify(eduGrant.body.error??{}));assert.equal(eduGrant.body.mode,'EDUCATION_ONLY');
    assert.ok((await eduCall('generate',{intent:'HISTORICAL_STRUCTURE',operationId:randomUUID()})).status>=400);
    assert.ok((await eduCall('generate',{intent:'EDUCATION_FVG',operationId:randomUUID(),symbol:'XAUUSD'})).status>=400);
    assert.ok((await eduCall('generate',{intent:'EDUCATION_FVG',operationId:randomUUID()})).status>=400);
    assert.equal(examined,1);assert.equal(secretReads,0);assert.equal(await LiveAttempt.countDocuments({}),count);
    console.log('PASS Funded education-only actual mounted API rejects chart intents and exports only canonical original catalog, no provider calls');
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;
    const https=require('node:https'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const {execFileSync}=require('node:child_process');
    const {Instrument}=require('../src/modules/instruments/instrument.model');
    const {Candle}=require('../src/modules/market-data/candle.model');
    const {InstrumentRegistry}=require('../src/modules/market-data/instrument-registry');
    const {QuoteStore}=require('../src/modules/market-data/quote-store');
    const symbol='AIWORKSPACE',start=Math.floor(Date.now()/60000)*60000-25*60000;
    await Instrument.create({symbol,displaySymbol:symbol,name:'Synthetic workspace',assetClass:'METAL',quoteCurrency:'USD',
      digits:2,tickSize:'0.01',pipSize:'0.1',contractSize:'100',minVolume:'0.01',maxVolume:'100',volumeStep:'0.01',
      defaultLeverage:50,providerMappings:{twelveData:'TEST/USD'},tradingSessions:[{days:[0,1,2,3,4,5,6],open:'00:00',close:'23:59'}],
      timezone:'UTC',maxQuoteAgeMs:30000,scheduleVersion:1,chartEnabled:true,status:'ACTIVE'});
    await Candle.insertMany(Array.from({length:24},(_,i)=>({symbol,timeframe:'1m',openTime:new Date(start+i*60000),
      closeTime:new Date(start+(i+1)*60000),open:String(100+i),high:String(101+i),low:String(99+i),close:String(100+i),
      complete:true,synthetic:false,source:'BACKFILL',provider:'twelve-data'})));
    const instrumentRegistry=new InstrumentRegistry({symbols:[symbol],defaultMaxQuoteAgeMs:30000,logger:{warn(){}}});
    await instrumentRegistry.load();
    const marketRuntime={enabled:true,symbols:[symbol],timeframes:['1m'],instrumentRegistry,quoteStore:new QuoteStore(),health:()=>({enabled:true})};
    const wsEnv={...flags,ACG_AI_FUNDED_WORKSPACE_CHAT_ENABLED:'true',ACG_AI_FUNDED_WORKSPACE_EXPORT_AUTHORIZED:'true',
      ACG_AI_FUNDED_WORKSPACE_EXPIRES_AT_MS:String(Date.now()+120000),ACG_AI_FUNDED_OPENAI_API_KEY:'sk-synthetic-workspace-'.padEnd(40,'x')};
    const ws=await loadFundedPilotBootstrap({env:wsEnv,marketRuntime});
    assert.equal(ws.workspaceChat,true);assert.equal(ws.educationOnly,false);
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'acg-ws-tls-'));
    let tls,requests=0,wireError=null;
    try{
      execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1',
        '-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem')],{stdio:'ignore'});
      const ca=fs.readFileSync(path.join(dir,'cert.pem'));
      tls=https.createServer({key:fs.readFileSync(path.join(dir,'key.pem')),cert:ca},async(req,res)=>{
        try{
          requests++;
          const parts=[];for await(const p of req)parts.push(p);
          const raw=Buffer.concat(parts).toString(),body=JSON.parse(raw),data=JSON.parse(body.messages[1].content);
          assert.equal(body.model,'gpt-6-luna');assert.equal(body.store,false);assert.equal(body.stream,false);
          assert.equal(body.response_format.json_schema.name,'acg_workspace_answer');
          assert.equal(data.question,'Review my account and chart.');
          assert.equal(data.account.state.balance,'10000');assert.equal(data.account.source,'PERSISTED_ACCOUNT_SNAPSHOT');
          assert.equal(data.market.symbol,symbol);assert.equal(data.market.provider,'twelve-data');
          assert.ok(data.market.frames.length===1);assert.ok(data.knowledge.length>0);
          for(const value of [tenantId,actor.actorId,staff,...ids,'staff-owner',wsEnv.ACG_AI_FUNDED_OPENAI_API_KEY])
            assert.ok(!raw.includes(value));
          res.writeHead(200,{'content-type':'application/json'});
          res.end(JSON.stringify({id:'workspace-fixture-'+randomUUID(),model:'gpt-6-luna',service_tier:'default',
            choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({answer:'Synthetic workspace answer.'})}}],
            usage:{prompt_tokens:1000,completion_tokens:40,total_tokens:1040}}));
        }catch(e){wireError=e;res.destroy();}
      });
      await new Promise(resolve=>tls.listen(0,'127.0.0.1',resolve));
      const app=createApp({marketRuntime,tradingRuntime:{enabled:true,health:()=>({enabled:true})},authRuntime:{authService:auth},
        restrictedPilotBootstrap:{...ws,isolatedWorkspaceLoopback:{port:tls.address().port,ca}}});
      server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
      const wsRoot='http://127.0.0.1:'+server.address().port,wsBase={...base,connectionId:randomUUID(),symbol};
      const wsCall=async(op,extra={},token=session.accessToken)=>{
        const res=await fetch(wsRoot+'/v1/ai/pilot/'+op,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},
          body:JSON.stringify({...wsBase,...extra})});return {status:res.status,body:await res.json()};
      };
      const status=await wsCall('status');assert.equal(status.status,200);assert.equal(status.body.mode,'WORKSPACE_CHAT');
      assert.equal((await wsCall('status',{},otherSession.accessToken)).status,403);
      assert.equal((await wsCall('grant',{expectedRevision:0,explicitConsent:true})).status,200);
      const op=randomUUID(),input={intent:'WORKSPACE_CHAT',operationId:op,question:'Review my account and chart.',history:[],includeAccount:true,includeMarket:true};
      assert.ok((await wsCall('generate',{...input,accountId:String(other._id)})).status>=400);
      const answer=await wsCall('generate',input);
      if(wireError)throw wireError;
      assert.equal(answer.status,200,JSON.stringify(answer.body.error??{}));
      assert.equal(answer.body.state,'ANSWERED',JSON.stringify(answer.body));
      assert.equal(answer.body.answer,'Synthetic workspace answer.');assert.equal(answer.body.context.account,true);assert.equal(answer.body.context.market,true);
      const settled=await LiveAttempt.findOne({tenantId,operationId:op}).lean();
      assert.equal(settled.state,'SETTLED');assert.equal(settled.actualPicoUsd,120000000);
      assert.equal(requests,1);
      assert.equal((await LivePlatform.findById('platform').lean()).outstandingRequests,0);
      assert.ok((await wsCall('generate',input)).status>=400);assert.equal(requests,1);
      wsEnv.ACG_AI_FUNDED_WORKSPACE_EXPORT_AUTHORIZED='false';
      assert.ok((await wsCall('generate',{...input,operationId:randomUUID()})).status>=400);
      console.log('PASS actual Funded workspace chat: selected account and synthetic chart, normal response, real TLS fixture, settled budget, replay and export revocation');
    }finally{
      if(tls){tls.closeAllConnections();await new Promise(resolve=>tls.close(resolve));}
      fs.rmSync(dir,{recursive:true,force:true});
    }


  }finally{
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    for(const k of Object.keys(flags)){if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];}
    await admin.setPlatformControl(actor,{enabled:prior.enabled,expectedRevision:platform.revision,dailyPicoUsd:prior.dailyPicoUsd,
      dailyRequests:prior.dailyRequests,maxOutstandingPicoUsd:prior.maxOutstandingPicoUsd,maxOutstandingRequests:prior.maxOutstandingRequests});
  }
}
module.exports={runFundedPilotMountAcceptance};
