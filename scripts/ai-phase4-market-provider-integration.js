'use strict';
const assert=require('node:assert/strict');
const express=require('express');
const {randomUUID}=require('node:crypto');
const {createIsolatedChatRouter}=require('../src/modules/ai/ai-chat.routes');
const {createIsolatedConversationStore}=require('../src/modules/ai/ai-conversation-store');
const {createIsolatedConversations}=require('../src/modules/ai/ai-conversations');
const {createIsolatedConversationProvider}=require('../src/modules/ai/ai-conversation-provider');
const {createIsolatedWorkspaceAnalysis}=require('../src/modules/ai/ai-workspace-analysis');
const {createCredentialVault}=require('../src/modules/ai/providers/credential-vault');
const {createAiGovernance}=require('../src/modules/ai/ai-governance');
const {createAiQuota}=require('../src/modules/ai/ai-quota');
const {createAiQuotaStore}=require('../src/modules/ai/ai-quota-store');
const {AiTransportAdmission}=require('../src/modules/ai/providers/isolated-transport-admission');
const {Candle}=require('../src/modules/market-data/candle.model');
async function runPhase4MarketProviderIntegration({auth,gateway,gs,token,foreignToken,readRequest,scope,source,asOf,registry,
  credentialStore,crypto,transport,admission,secret,requests,setMode,setHook}){
  const {tenantId,actorId,sessionId}=scope;
  const vault=createCredentialVault({store:credentialStore,crypto,authorize:async r=>{
    if(!Object.entries({tenantId,actorId,sessionId}).every(([k,v])=>r.scope[k]===v))return false;
    const principal=await auth.authenticateSessionToken(token);await gateway.assertDisclosure(principal,readRequest);return true;
  }});
  const vs={tenantId,actorId,sessionId};
  const existing=(await vault.list(vs)).find(d=>d.providerId==='anthropic');
  await vault.change(vs,{operation:existing?(existing.status==='REVOKED'?'RECONNECT':'REPLACE'):'CONNECT',providerId:'anthropic',
    expectedRevision:existing?.revision??0,secret});
  let reads=0,allow=true;
  // Explicitly use the existing historical fixture cutoff, never present old
  // candles as current. The provider verifier runs against the real clock.
  const marketSource={instrument:s=>source.instrument(s),async candles(r){reads++;return source.candles({...r,asOfMs:asOf});}};
  const store=createIsolatedConversationStore();
  const service=()=>createIsolatedConversations({store,registry,workspaceAnalysis:createIsolatedWorkspaceAnalysis({source:marketSource}),
    conversationProvider:createIsolatedConversationProvider({registry,store:credentialStore,crypto,transport,admission,marketSource})});
  let current=service();
  const app=express(),quotaNow=Date.now()+18000000;
  app.use('/v1/ai/chat',createIsolatedChatRouter({authService:auth,gateway,governance:createAiGovernance({store:gs}),
    quota:createAiQuota({store:createAiQuotaStore(),now:()=>quotaNow,limit:100}),registry,conversations:{execute:(...args)=>current.execute(...args)},
    fixtureProviderEnabled:true,workspaceAnalysisEnabled:true,marketProviderEnabled:true,
    authorizePurpose:async r=>{
      assert.equal(r.externalExport,false);assert.equal(r.offlineOnly,true);
      return r.scope.actorId===scope.actorId&&(!r.selection||r.selection.providerId==='anthropic')&&
        (!r.workspace||(allow&&r.workspace.symbol==='XAUUSD'&&r.workspace.timeframe==='1m'&&r.workspace.includeChartContext===true));
    }}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const root='http://127.0.0.1:'+server.address().port+'/v1/ai/chat/conversations/';
  const authority={accountId:readRequest.accountId,connectionId:readRequest.connectionId};
  const d=registry.models().find(x=>x.providerId==='anthropic'),selection={providerId:d.providerId,modelId:d.modelId,descriptorId:d.descriptorId,fundingMode:'BYO_API'};
  const workspace={symbol:'XAUUSD',timeframe:'1m',includeChartContext:true},conversationId=randomUUID();
  const config={conversationId,selection,profile:'STRUCTURE',workspace};
  async function call(op,payload={},credential=token){
    const r=await fetch(root+op,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential},
      body:JSON.stringify({...authority,...payload})});
    return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};
  }
  async function ok(op,payload={}){const r=await call(op,payload);assert.equal(r.status,200,op+' '+JSON.stringify(r.body.error||{}));assert.equal(r.cache,'no-store');return r.body;}
  async function append(){const key={conversationId,messageId:randomUUID()};await ok('append',{...key,text:'What is the historical closed price?'});return key;}
  const start=requests(),candleCount=await Candle.countDocuments({});
  try{
    assert.equal((await call('create',{...config,workspace:{...workspace,includeChartContext:false}})).status,400);
    assert.equal((await call('create',{...config,workspace:{...workspace,symbol:'EURUSD'}})).status,403);
    await ok('create',config);
    const key=await append();
    assert.equal((await call('generate',{...key,context:{price:999}})).status,400);
    assert.equal((await call('generate',key,foreignToken)).status,403);
    allow=false;assert.equal((await call('generate',key)).status,403);allow=true;
    assert.equal(reads,0);assert.equal(requests(),start);
    const verified=await ok('generate',key),r=verified.verifiedMarket?.response;
    assert.equal(verified.providerRun.state,'VERIFIED');assert.equal(verified.verifiedMarket.mode,'FIXTURE_PROVIDER_MARKET_REPORT');
    assert.equal(verified.verifiedMarket.semanticAnswer,false);assert.equal(verified.verifiedMarket.fixtureProviderOnly,true);
    assert.deepEqual(verified.verifiedMarket.workspace,workspace);assert.equal(r.symbol,'XAUUSD');assert.equal(r.quoteStatus,'UNAVAILABLE');
    assert.equal(r.responseId,verified.providerRun.responseId);
    const price=r.observations.find(o=>o.data.kind==='LAST_CLOSED_PRICE');
    assert.equal(price.data.value,'119');assert.ok(price.data.throughCloseTimeMs<=asOf);
    assert.ok(r.asOfMs>asOf);assert.ok(r.frames[0].quality.ageMs>0);
    assert.equal(reads,1);assert.equal(requests(),start+1);
    current=service();
    const replay=await ok('generate',key);assert.equal(replay.replayed,true);assert.equal(replay.providerRun.state,'VERIFIED');
    assert.ok(!replay.verifiedMarket);assert.equal(requests(),start+1);assert.equal(reads,1);
    const history=await ok('history',{conversationId});assert.equal(history.messages[0].providerRun.responseId,r.responseId);
    assert.ok(!history.messages[0].verifiedMarket);assert.equal(history.messages[0].verifiedEducation,null);
    const invalid=await append();setMode('forged');
    const rejected=await ok('generate',invalid);setMode('normal');
    assert.equal(rejected.providerRun.state,'FAILED');assert.ok(!rejected.verifiedMarket);
    const cancelled=await append();setHook(async()=>{await ok('cancel',cancelled);});
    const suppressed=await call('generate',cancelled);setHook(null);
    assert.ok([404,409].includes(suppressed.status));assert.ok(!suppressed.body.verifiedMarket);
    assert.equal((await call('generate',cancelled)).status,404);
    assert.equal(requests(),start+3);assert.equal(reads,3);
    const admissionDoc=await AiTransportAdmission.findOne({tenantId,actorId}).lean();
    assert.equal(admissionDoc.attempts.filter(a=>a.operationId===verified.providerRun.operationId).length,1);
    assert.equal(await Candle.countDocuments({}),candleCount);
    await ok('delete',{conversationId});
    console.log('PASS Phase 4F authenticated chart-aware TLS provider, verified historical reference, consent, scope, replay, forged reference and cancellation; no candle writes');
  }finally{setMode('normal');setHook(null);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
module.exports={runPhase4MarketProviderIntegration};
