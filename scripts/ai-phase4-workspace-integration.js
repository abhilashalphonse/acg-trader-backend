'use strict';
const assert=require('node:assert/strict');
const express=require('express');
const {randomUUID}=require('node:crypto');
const {createIsolatedChatRouter}=require('../src/modules/ai/ai-chat.routes');
const {createIsolatedConversationStore}=require('../src/modules/ai/ai-conversation-store');
const {createIsolatedConversations}=require('../src/modules/ai/ai-conversations');
const {createIsolatedWorkspaceAnalysis}=require('../src/modules/ai/ai-workspace-analysis');
const {createModelRegistry}=require('../src/modules/ai/providers/model-registry');
const {createAiGovernance}=require('../src/modules/ai/ai-governance');
const {createAiQuota}=require('../src/modules/ai/ai-quota');
const {createAiQuotaStore}=require('../src/modules/ai/ai-quota-store');
const {AiAuditEvent}=require('../src/modules/ai/ai-governance.model');
const {Candle}=require('../src/modules/market-data/candle.model');
async function runPhase4WorkspaceIntegration({auth,gateway,gs,token,foreignToken,readRequest,scope,source,asOf}){
  let clock=asOf,reads=0,allow=true,duringRead=null;
  const registry=createModelRegistry({allowSynthetic:true,descriptors:[{providerId:'openai',modelId:'fixture-workspace',revision:'v1',
    reviewStatus:'SYNTHETIC_TEST_ONLY',fundingModes:['BYO_API'],capabilities:{input:'TEXT',responseMode:'JSON_OBJECT',
      separateInstructionChannel:true,streaming:false,usageReporting:'PROVIDER_REPORTED',maxContextTokens:8192,maxOutputTokens:1024}}]});
  const d=registry.models()[0],selection={providerId:d.providerId,modelId:d.modelId,descriptorId:d.descriptorId,fundingMode:'BYO_API'};
  // Phase 4C already provisioned the disposable collection. Use the same actual identity.
  const store=createIsolatedConversationStore();
  const analysis=createIsolatedWorkspaceAnalysis({now:()=>clock,source:{
    instrument:s=>source.instrument(s),
    async candles(r){reads++;if(duringRead)await duringRead();return source.candles(r);},
    quote(){throw Error('Historical report cannot request quotes');}
  }});
  const conversations=createIsolatedConversations({store,registry,workspaceAnalysis:analysis});
  const app=express(),quotaNow=Date.now()+10800000;
  app.use('/v1/ai/chat',createIsolatedChatRouter({authService:auth,gateway,governance:createAiGovernance({store:gs}),
    quota:createAiQuota({store:createAiQuotaStore(),now:()=>quotaNow,limit:100}),registry,conversations,workspaceAnalysisEnabled:true,
    authorizePurpose:async r=>{
      assert.equal(r.externalExport,false);assert.equal(r.offlineOnly,true);
      if(!r.workspace)return true;
      return allow&&r.workspace.symbol==='XAUUSD'&&r.workspace.timeframe==='1m'&&r.workspace.includeChartContext===true;
    }}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const root='http://127.0.0.1:'+server.address().port+'/v1/ai/chat/conversations/';
  const a={accountId:readRequest.accountId,connectionId:readRequest.connectionId};
  const workspace={symbol:'XAUUSD',timeframe:'1m',includeChartContext:true};
  const conversationId=randomUUID(),messageId=randomUUID(),create={conversationId,selection,profile:'STRUCTURE',workspace};
  const question='Fixture historical report. Do not invent a live price.';
  async function call(op,payload,credential=token){
    const res=await fetch(root+op,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential},
      body:JSON.stringify({...a,...payload})});
    return {status:res.status,body:await res.json(),cache:res.headers.get('cache-control')};
  }
  async function ok(op,payload){const res=await call(op,payload);assert.equal(res.status,200,op+' '+JSON.stringify(res.body.error||{}));return res.body;}
  const key={conversationId,messageId};
  const before=await Candle.countDocuments({});
  try{
    assert.equal((await call('create',{...create,workspace:{...workspace,includeChartContext:false}})).status,400);
    assert.equal((await call('create',{...create,workspace:{...workspace,symbol:'EURUSD'}})).status,403);
    assert.equal((await call('create',{...create,workspace:{...workspace,candles:[999]}})).status,400);
    assert.equal((await call('create',{...create,profile:'EDUCATION'})).status,400);
    assert.deepEqual((await ok('create',create)).workspace,workspace);
    await ok('append',{...key,text:question});
    assert.equal((await call('analyze',{...key,price:999})).status,400);
    assert.equal((await call('analyze',key,foreignToken)).status,403);
    assert.equal(reads,0);
    const first=await call('analyze',key);
    assert.equal(first.status,200,JSON.stringify(first.body.error||{}));assert.equal(first.cache,'no-store');
    const body=first.body,r=body.response;
    assert.equal(body.mode,'DETERMINISTIC_HISTORICAL_REPORT');assert.equal(body.semanticAnswer,false);
    assert.equal(body.dispatchAllowed,false);assert.equal(body.creditDeducted,false);
    assert.deepEqual(body.workspace,workspace);assert.equal(body.messageId,messageId);
    assert.equal(r.schemaVersion,'verified-response-v1');assert.equal(r.symbol,'XAUUSD');assert.equal(r.quoteStatus,'UNAVAILABLE');
    assert.equal(r.asOfMs,asOf);assert.equal(r.expiresAtMs,asOf+10000);
    assert.equal(r.observations.find(x=>x.data.kind==='LAST_CLOSED_PRICE').data.value,'119');
    assert.ok(r.observations.every(x=>x.timeframe==='1m'&&x.type==='FACT'&&x.sourceId));
    assert.ok(r.limitations.includes('NO_SEMANTIC_RELEVANCE_OR_COMPLETENESS_PROOF'));
    assert.equal(body.source.provider,'twelve-data');assert.equal(reads,1);
    for(const value of [...Object.values(scope),a.connectionId,question])assert.ok(!JSON.stringify(body).includes(value));
    const stored=await store.read(scope);const c=stored.conversations.find(x=>x.conversationId===conversationId);
    assert.equal(c.messages.length,1);assert.ok(!Object.hasOwn(c.messages[0],'response'));
    allow=false;assert.equal((await call('analyze',key)).status,403);assert.equal(reads,1);allow=true;
    const direct=await conversations.execute(scope,'analyze',key,async()=>{});
    clock=asOf+10000;await assert.rejects(direct.fence(),{code:'AI_RESPONSE_EXPIRED'});clock=asOf;
    // Cancel during the actual market read; response is suppressed, never cached.
    duringRead=async()=>{await conversations.execute(scope,'cancel',key,async()=>{});};
    const denied=await call('analyze',key);duringRead=null;
    assert.notEqual(denied.status,200);assert.ok(!denied.body.response);
    assert.equal((await call('analyze',key)).status,404);
    const second={conversationId,messageId:randomUUID()};
    await ok('append',{...second,text:'Repeat fixture'});
    duringRead=async()=>{clock=asOf+10000;};
    const stale=await call('analyze',second);duringRead=null;clock=asOf;
    assert.notEqual(stale.status,200);assert.ok(!stale.body.response);
    assert.equal(await Candle.countDocuments({}),before);
    const audits=await AiAuditEvent.find({tenantId:scope.tenantId,operation:'CHAT_ANALYZE_OFFLINE'}).lean();
    assert.ok(audits.some(e=>e.stage==='ALLOWED'));assert.ok(audits.some(e=>e.stage==='DENIED'));
    assert.ok(audits.every(e=>!Object.hasOwn(e,'workspace')&&!Object.hasOwn(e,'text')&&!Object.hasOwn(e,'result')));
    await ok('delete',{conversationId});
    if(process.env.ACG_AI_PHASE4F_BROWSER_DIR){
      const {spawn}=require('node:child_process');
      const dir=require('node:path').resolve(process.env.ACG_AI_PHASE4F_BROWSER_DIR);
      const readsBefore=reads;
      await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,['tests/ui/ai-phase4f-integrated.mjs'],{cwd:dir,stdio:['pipe','pipe','pipe']});
        let out='',err='';const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
        child.stdout.on('data',v=>{out=(out+v).slice(-16000);});child.stderr.on('data',v=>{err=(err+v).slice(-16000);});
        child.stdin.on('error',()=>{});
        child.once('error',()=>{clearTimeout(timer);reject(Error('Phase 4F workspace browser runner unavailable'));});
        child.once('close',code=>{
          clearTimeout(timer);
          if(code!==0||!out.includes('PASS Phase 4F workspace browser')){
            const reason=err.includes('TimeoutError')?'timeout':err.includes('AssertionError')?'assertion':'runner';
            reject(Error('Phase 4F workspace browser acceptance failed: '+reason));return;
          }
          console.log('PASS Phase 4F chart conversation browser consent, market evidence, mobile history, expiry and cancellation');resolve();
        });
        child.stdin.end(JSON.stringify({root:'http://127.0.0.1:'+server.address().port,authority:a,token,foreignToken,workspaceMode:true,asOf}));
      });
      assert.equal(reads,readsBefore+2,'Only explicit report requests may read candles');
      assert.equal(await Candle.countDocuments({}),before);
    }
    console.log('PASS Phase 4D real Mongo chart context opt-in, pinned symbol/timeframe, deterministic reference verification, source/expiry, no quotes, cancellation and purpose denial, no market or credit writes');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
module.exports={runPhase4WorkspaceIntegration};
