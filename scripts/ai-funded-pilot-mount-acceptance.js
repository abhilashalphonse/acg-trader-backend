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
  assert.equal(prior,null,'Funded acceptance requires a fresh dedicated live ledger');
  assert.equal(await LiveAttempt.countDocuments({}),0);
  const caps={dailyPicoUsd:1000000000000,dailyRequests:20,maxOutstandingPicoUsd:1000000000000,maxOutstandingRequests:1};
  const platform=(await admin.setPlatformControl(actor,{...caps,enabled:true,expectedRevision:0}));
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
    const {TIMEFRAME_MS,candleBucketOpenTimeMs}=require('../src/modules/market-data/market.constants');
    for(const timeframe of ['5m','15m','1h']){
      const step=TIMEFRAME_MS[timeframe],end=candleBucketOpenTimeMs(Date.now(),timeframe);
      await Candle.insertMany(Array.from({length:24},(_,i)=>({symbol,timeframe,openTime:new Date(end-(24-i)*step),
        closeTime:new Date(end-(23-i)*step),open:String(100+i),high:String(101+i),low:String(99+i),close:String(100+i),
        complete:true,synthetic:false,source:'BACKFILL',provider:'twelve-data'})));
    }
    const quoteStore=new QuoteStore();
    const marketRuntime={enabled:true,symbols:[symbol],timeframes:['1m','5m','15m','1h'],instrumentRegistry,quoteStore,
      candleEngine:{getCurrent:(s,t)=>({symbol:s,timeframe:t,provider:'twelve-data',complete:false,synthetic:false,
        openTimeMs:candleBucketOpenTimeMs(Date.now(),t),closeTimeMs:candleBucketOpenTimeMs(Date.now(),t)+TIMEFRAME_MS[t],
        open:124,high:125,low:123,close:124})},health:()=>({enabled:true})};
    const tickTime=Date.now()-5;
    quoteStore.set({symbol,providerSymbol:'TEST/USD',source:'twelve-data',bid:123.99,ask:124.01,
      providerTimestampMs:tickTime,receivedAtMs:tickTime,isStale:false,sessionOpen:true,isSyntheticSpread:true});
    const wsEnv={...flags,ACG_AI_FUNDED_WORKSPACE_STREAMING_ENABLED:'true',ACG_AI_FUNDED_WORKSPACE_CHAT_ENABLED:'true',ACG_AI_FUNDED_WORKSPACE_EXPORT_AUTHORIZED:'true',
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
          assert.equal(body.model,'gpt-6-luna');assert.equal(body.store,false);assert.equal(body.stream,true);assert.deepEqual(body.stream_options,{include_usage:true});
          assert.equal(body.reasoning_effort,'low');assert.equal(body.max_completion_tokens,2048);
          assert.equal(body.response_format.json_schema.name,'acg_workspace_answer');
          if(data.question==='Review my account risk'){
            assert.equal(data.account.state.balance,'10000');assert.equal(data.account.source,'PERSISTED_ACCOUNT_SNAPSHOT');
            assert.equal(data.market,null);
          }else{
          assert.equal(data.question,'Analyse the current market structure.');
          assert.equal(data.account,null);
          assert.equal(data.market.symbol,symbol);assert.equal(data.market.provider,'twelve-data');
          assert.equal(data.market.schemaVersion,'adaptive-market-v1');
          assert.equal(data.market.contextSelection.profile,'STRUCTURE');
          assert.deepEqual(data.market.frames.map(f=>f.timeframe),['1m','5m','15m','1h']);
          for(const frame of data.market.frames){
            const eligible=frame.timeframe!=='1m'&&frame.status==='HISTORICAL_ONLY'&&
              frame.quality?.status==='RECENT_CLOSED_BAR'&&frame.quality.gaps===0&&
              frame.quality.exclusions?.synthetic===0&&frame.quality.contiguousCount>=20&&
              frame.freshness?.state==='LATEST_EXPECTED_UTC_BUCKET'&&frame.coverage?.outOfSessionBars===0;
            assert.ok(frame.closedCandles.every(b=>b.length===5));
            if(eligible){
              assert.equal(frame.closedCandles.length,8);
              assert.equal(frame.rawHistoryProjection.mode,'HIGHER_FRAME_SUMMARY_WITH_EXACT_TAIL');
              assert.equal(frame.rawHistoryProjection.derivedEvidenceUsesOriginalWindow,true);
              assert.equal(frame.omittedClosedBars,frame.availableClosedBars-8);
            }else{
              assert.ok(frame.closedCandles.length>=16);
              assert.equal(frame.rawHistoryProjection,undefined);
            }
          }
          assert.ok(data.market.frames.every(f=>f.activeCandle?.complete===false));
          assert.ok(data.market.frames.every(f=>f.advanced.methodVersion==='advanced-market-intelligence-v1'));
          assert.ok(data.market.frames.every(f=>f.advanced.regime.state==='TRENDING_UP'));
          assert.ok(data.market.frames.every(f=>f.advanced.dealingRange.high===124&&f.advanced.dealingRange.low===99));
          assert.ok(data.market.frames.every(f=>f.advanced.liquidity.levels.filter(l=>l.kind==='EXTERNAL_RANGE_BOUNDARY').length===2));
          assert.ok(data.market.frames.every(f=>f.quoteRangeLocation.reference==='TERMINAL_BID_ASK_MID'));
          assert.ok(data.market.frames.every(f=>f.advanced.displacements.length===0));
          assert.equal(data.market.quote.bid,123.99);assert.equal(data.market.quote.ask,124.01);
          assert.equal(data.market.quote.status,'RECENT_PROVIDER_EVENT');
          // The fixture can cross a five-minute boundary between seeding and reading.
          // Assert the classification against the actual snapshot clock and last
          // closed bar rather than assuming the wall clock stayed in one bucket.
          const five=data.market.frames[1];
          const expectedFiveOpen=candleBucketOpenTimeMs(five.asOfMs,'5m');
          assert.equal(five.freshness.currentBucketOpenMs,expectedFiveOpen);
          const lastFiveClose=five.closedCandles.at(-1)[0]+TIMEFRAME_MS['5m'];
          assert.equal(five.freshness.latestClosedAtMs,lastFiveClose);
          assert.equal(five.freshness.state,lastFiveClose===expectedFiveOpen?'LATEST_EXPECTED_UTC_BUCKET':'MISSING_RECENT_CLOSED_BUCKET');
          assert.equal(data.market.sessionClocks.length,3);assert.ok(data.knowledge.length>0);
          assert.equal(data.market.economicCalendar.dataStatus,'FRESH');
          assert.equal(data.market.economicCalendar.events.length,1);
          assert.equal(data.market.economicCalendar.events[0].title,'Synthetic USD release');
          assert.equal(data.market.economicCalendar.events[0].timing,'UPCOMING');
          }
          for(const value of [tenantId,actor.actorId,staff,...ids,'staff-owner',wsEnv.ACG_AI_FUNDED_OPENAI_API_KEY])
            assert.ok(!raw.includes(value));
          res.writeHead(200,{'content-type':'text/event-stream'});
          const id='workspace-fixture-'+randomUUID();
          const emit=(choices,usage=null)=>res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',model:'gpt-6-luna',service_tier:'default',choices,usage})+'\n\n');
          emit([{index:0,finish_reason:null,delta:{role:'assistant',content:'{"answer":"Synthetic '}}]);
          await new Promise(resolve=>setTimeout(resolve,100));
          emit([{index:0,finish_reason:null,delta:{content:'workspace answer."}'}}]);
          emit([{index:0,finish_reason:'stop',delta:{}}]);
          emit([],{prompt_tokens:1000,completion_tokens:40,total_tokens:1040});
          res.end('data: [DONE]\n\n');
        }catch(e){wireError=e;res.destroy();}
      });
      await new Promise(resolve=>tls.listen(0,'127.0.0.1',resolve));
      const app=createApp({marketRuntime,tradingRuntime:{enabled:true,health:()=>({enabled:true}),
        readAiCalendarSnapshot:now=>({dataStatus:'FRESH',fetchedAt:new Date(now-1000).toISOString(),
          coverageFrom:new Date(now-3600000).toISOString(),coverageTo:new Date(now+86400000).toISOString(),
          events:[{title:'Synthetic USD release',currency:'USD',impact:'HIGH',timestamp:new Date(now+1800000).toISOString(),allDay:false},
            {title:'Unrelated EUR release',currency:'EUR',impact:'HIGH',timestamp:new Date(now+1800000).toISOString(),allDay:false}]})},authRuntime:{authService:auth},
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
      const op=randomUUID(),input={intent:'WORKSPACE_CHAT',operationId:op,question:'Analyse the current market structure.',history:[],includeAccount:true,includeMarket:true};
      assert.ok((await wsCall('generate',{...input,accountId:String(other._id)})).status>=400);
      const stream=await fetch(wsRoot+'/v1/ai/pilot/generate',{method:'POST',headers:{'content-type':'application/json',accept:'text/event-stream',authorization:'Bearer '+session.accessToken},body:JSON.stringify({...wsBase,...input})});
      assert.ok(stream.headers.get('content-type').startsWith('text/event-stream'));
      const events=(await stream.text()).trim().split('\n\n').map(block=>{const [kind,data]=block.split('\n');return {kind:kind.slice(7),data:JSON.parse(data.slice(6))};});
      if(wireError)throw wireError;
      assert.deepEqual(events.map(e=>e.kind),['progress','progress','delta','delta','result']);
      assert.equal(events.filter(e=>e.kind==='delta').map(e=>e.data.text).join(''),'Synthetic workspace answer.');
      assert.deepEqual(events.slice(0,2).map(e=>e.data),[{stage:'CONTEXT'},{stage:'GENERATING'}]);
      const answer={status:stream.status,body:events.at(-1).data};
      assert.equal(answer.status,200,JSON.stringify(answer.body.error??{}));
      assert.equal(answer.body.state,'ANSWERED',JSON.stringify(answer.body));
      assert.equal(answer.body.answer,'Synthetic workspace answer.');assert.equal(answer.body.context.account,true);assert.equal(answer.body.context.accountUsed,false);assert.equal(answer.body.context.market,true);
      const settled=await LiveAttempt.findOne({tenantId,operationId:op}).lean();
      assert.equal(settled.state,'SETTLED');assert.equal(settled.actualPicoUsd,120000000);
      assert.equal(requests,1);
      assert.equal((await LivePlatform.findById('platform').lean()).outstandingRequests,0);
      assert.ok((await wsCall('generate',input)).status>=400);assert.equal(requests,1);
      // A distinct synthetic risk request proves the complete account export
      // remains available under the same consent and budget fences.
      const riskOp=randomUUID();
      const riskStream=await fetch(wsRoot+'/v1/ai/pilot/generate',{method:'POST',headers:{'content-type':'application/json',accept:'text/event-stream',authorization:'Bearer '+session.accessToken},body:JSON.stringify({...wsBase,...input,operationId:riskOp,question:'Review my account risk',includeMarket:false})});
      assert.ok(riskStream.headers.get('content-type').startsWith('text/event-stream'));
      const riskEvents=(await riskStream.text()).trim().split('\n\n').map(block=>{const [kind,data]=block.split('\n');return {kind:kind.slice(7),data:JSON.parse(data.slice(6))};});
      if(wireError)throw wireError;
      assert.deepEqual(riskEvents.map(e=>e.kind),['progress','progress','delta','delta','result']);
      const riskAnswer=riskEvents.at(-1).data;
      assert.equal(riskAnswer.state,'ANSWERED');
      assert.equal(riskAnswer.context.account,true);assert.equal(riskAnswer.context.accountUsed,true);assert.equal(riskAnswer.context.market,false);
      assert.equal((await LiveAttempt.findOne({tenantId,operationId:riskOp}).lean()).state,'SETTLED');
      assert.equal(requests,2);
      assert.equal((await LivePlatform.findById('platform').lean()).outstandingRequests,0);
      // Dedicated isolated ledger only: prove both denial paths are typed,
      // terminal, unbilled and do not invoke the TLS provider.
      for(const [index,reason] of ['DAILY_REQUEST_LIMIT','DAILY_SPEND_LIMIT'].entries()){
        const revision=index+1;
        await admin.setControl(actor,{enabled:true,expectedRevision:revision,
          tenantDailyPicoUsd:1000000000000,actorDailyPicoUsd:index===0?1000000000000:1,
          tenantDailyRequests:20,actorDailyRequests:index===0?2:20});
        const current=await wsCall('status');assert.equal(current.status,200);
        assert.equal((await wsCall('grant',{explicitConsent:true,expectedRevision:current.body.revision})).status,200);
        const deniedOp=randomUUID();
        const denied=await fetch(wsRoot+'/v1/ai/pilot/generate',{method:'POST',
          headers:{'content-type':'application/json',accept:'text/event-stream',authorization:'Bearer '+session.accessToken},
          body:JSON.stringify({...wsBase,...input,operationId:deniedOp,question:'Review my account risk',includeMarket:false})});
        const deniedEvents=(await denied.text()).trim().split('\n\n').map(block=>{const [kind,data]=block.split('\n');return {kind:kind.slice(7),data:JSON.parse(data.slice(6))};});
        assert.deepEqual(deniedEvents.map(e=>e.kind),['progress','progress','result']);
        const terminal=deniedEvents.at(-1).data;
        assert.equal(terminal.state,'FAILED');assert.equal(terminal.failureReason,reason);
        assert.equal(terminal.operationId,deniedOp);assert.equal(terminal.executionAllowed,false);
        assert.equal(terminal.usage,undefined);
        assert.equal(await LiveAttempt.countDocuments({tenantId,operationId:deniedOp}),0);
        assert.equal(requests,2);
        assert.equal((await LivePlatform.findById('platform').lean()).outstandingRequests,0);
      }
      // Restore fixture control, then exercise the operator migration on
      // the dedicated isolated ledger without resetting the two used slots.
      await admin.setControl(actor,{enabled:true,expectedRevision:3,tenantDailyPicoUsd:1000000000000,
        actorDailyPicoUsd:1000000000000,tenantDailyRequests:20,actorDailyRequests:20});
      const {LiveBudget,LivePlatformDay,LiveControl}=require('../src/modules/ai/providers/live-admission.model');
      const {migrateStaffRequestCap}=require('../src/modules/ai/providers/funded-staff-request-cap');
      const snapshot=async()=>({tenant:await LiveBudget.find({tenantId}).sort({_id:1}).lean(),platform:await LivePlatformDay.find({}).sort({_id:1}).lean()});
      const before=await snapshot();
      const expanded={...wsEnv,ACG_AI_FUNDED_STAFF_DAILY_REQUEST_LIMIT:'100',ACG_AI_FUNDED_STAFF_REQUEST_LIMIT_EXPIRES_AT_MS:String(Date.now()+3600000)};
      assert.equal((await migrateStaffRequestCap({env:expanded})).dailyRequests,100);
      assert.equal((await LivePlatform.findById('platform').lean()).dailyRequests,100);
      assert.equal((await LiveControl.findById(tenantId).lean()).actorDailyRequests,100);
      assert.deepEqual(await snapshot(),before);
      assert.equal((await migrateStaffRequestCap({env:expanded})).changed,false);
      // Exercise the actual mounted access and grant routes after a 100-slot
      // migration, not just the ledger/bootstrap checks.
      assert.equal((await wsCall('status')).status,403); // old runtime must fail closed
      const expandedBootstrap=await loadFundedPilotBootstrap({env:expanded,marketRuntime});
      assert.equal(expandedBootstrap.dailyRequests,100);
      const expandedApp=createApp({marketRuntime,tradingRuntime:{enabled:true,health:()=>({enabled:true})},
        authRuntime:{authService:auth},restrictedPilotBootstrap:{...expandedBootstrap,
          isolatedWorkspaceLoopback:{port:tls.address().port,ca}}});
      const expandedServer=await new Promise(resolve=>{const s=expandedApp.listen(0,'127.0.0.1',()=>resolve(s));});
      try{
        const expandedRoot='http://127.0.0.1:'+expandedServer.address().port;
        const expandedBase={...wsBase,connectionId:randomUUID()};
        const callExpanded=async(op,extra={},token=session.accessToken)=>{
          const res=await fetch(expandedRoot+'/v1/ai/pilot/'+op,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},
            body:JSON.stringify({...expandedBase,...extra})});return {status:res.status,body:await res.json()};
        };
        const status=await callExpanded('status');assert.equal(status.status,200);assert.equal(status.body.mode,'WORKSPACE_CHAT');
        assert.equal((await callExpanded('status',{},otherSession.accessToken)).status,403);
        assert.equal((await callExpanded('grant',{expectedRevision:status.body.revision,explicitConsent:true})).status,200);
        assert.equal((await callExpanded('status')).body.active,true);
        // Verify expired cap revokes the expanded runtime, without dispatch.
        const capExpiry=expanded.ACG_AI_FUNDED_STAFF_REQUEST_LIMIT_EXPIRES_AT_MS;
        expanded.ACG_AI_FUNDED_STAFF_REQUEST_LIMIT_EXPIRES_AT_MS=String(Date.now()-1);
        assert.ok((await callExpanded('status')).status>=400);
        expanded.ACG_AI_FUNDED_STAFF_REQUEST_LIMIT_EXPIRES_AT_MS=capExpiry;
      }finally{expandedServer.closeAllConnections();await new Promise(resolve=>expandedServer.close(resolve));}
      const reverted={...wsEnv,ACG_AI_FUNDED_STAFF_DAILY_REQUEST_LIMIT:'20'};
      assert.equal((await migrateStaffRequestCap({env:reverted})).dailyRequests,20);
      assert.deepEqual(await snapshot(),before);
      assert.equal((await LivePlatform.findById('platform').lean()).outstandingRequests,0);
      assert.equal(requests,2);
      // Mounted chart-only receipt: real staff session, consent, detector and
      // database candles; never dispatch a provider request or write a trade.
      const originalDrawingFlag=process.env.ACG_AI_CHART_DRAWING_ENABLED;
      try{
        delete process.env.ACG_AI_CHART_DRAWING_ENABLED;
        const drawBase={...wsBase,timeframe:'1h',connectionId:randomUUID()};
        const drawCall=async(op,extra={},token=session.accessToken)=>{
          const res=await fetch(wsRoot+'/v1/ai/pilot/'+op,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({...drawBase,...extra})});
          return {status:res.status,body:await res.json()};
        };
        const end=candleBucketOpenTimeMs(Date.now(),'1h'),step=TIMEFRAME_MS['1h'];
        const drawingInput={actionId:randomUUID(),command:'FVG',chartContextVersion:'e'.repeat(64),latestClosedAtMs:end};
        assert.equal((await drawCall('draw',drawingInput)).status,403);
        process.env.ACG_AI_CHART_DRAWING_ENABLED='true';
        assert.equal((await drawCall('status')).body.chartDrawingEnabled,true);
        assert.equal((await drawCall('grant',{expectedRevision:0,explicitConsent:true})).status,200);
        // Replace only the isolated fixture's hourly candles after the
        // analytical provider acceptance has finished.
        await Candle.deleteMany({symbol,timeframe:'1h'});
        const rows=[[102,104,100,103],[103,105,101,104],[104,105,95,101],[101,104,100,103],[103,106,102,105],[110,112,109,111],[111,113,110,112],[112,114,110,113]];
        await Candle.insertMany(rows.map(([open,high,low,close],i)=>({symbol,timeframe:'1h',openTime:new Date(end-(rows.length-i)*step),closeTime:new Date(end-(rows.length-i-1)*step),open:String(open),high:String(high),low:String(low),close:String(close),complete:true,synthetic:false,source:'BACKFILL',provider:'twelve-data'})));
        const priorAttempts=await LiveAttempt.countDocuments({tenantId});
        const drawn=await drawCall('draw',drawingInput);
        assert.equal(drawn.status,200,JSON.stringify(drawn.body.error??{}));
        assert.equal(drawn.body.state,'DRAWING_READY');assert.equal(drawn.body.executionAllowed,false);
        assert.equal(drawn.body.receipt.actionId,drawingInput.actionId);
        assert.equal(drawn.body.receipt.context.latestClosedAtMs,end);
        assert.ok(drawn.body.receipt.actions.some(a=>a.geometry.type==='rectangle'&&a.geometry.lower===104&&a.geometry.upper===109));
        assert.ok((await drawCall('draw',{...drawingInput,latestClosedAtMs:end-step})).status>=400);
        assert.equal(await LiveAttempt.countDocuments({tenantId}),priorAttempts);
        assert.equal(requests,2);
      }finally{
        if(originalDrawingFlag===undefined)delete process.env.ACG_AI_CHART_DRAWING_ENABLED;
        else process.env.ACG_AI_CHART_DRAWING_ENABLED=originalDrawingFlag;
      }
      wsEnv.ACG_AI_FUNDED_WORKSPACE_EXPORT_AUTHORIZED='false';
      assert.ok((await wsCall('generate',{...input,operationId:randomUUID()})).status>=400);
      assert.equal(requests,2);
      console.log('PASS actual Funded workspace chat: minimized chart-only export, full account-risk export, real TLS fixture, settled budget, replay and export revocation');
    }finally{
      if(tls){tls.closeAllConnections();await new Promise(resolve=>tls.close(resolve));}
      fs.rmSync(dir,{recursive:true,force:true});
    }


  }finally{
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    for(const k of Object.keys(flags)){if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];}
    // Dedicated random test database is dropped by the standalone runner.
    // Never restore, reset or overwrite another suite's ledger.
  }
}
module.exports={runFundedPilotMountAcceptance};
