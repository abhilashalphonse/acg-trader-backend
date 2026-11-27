'use strict';
const assert=require('node:assert/strict');
const express=require('express');
const {randomUUID}=require('node:crypto');
const {createIsolatedChatRouter}=require('../src/modules/ai/ai-chat.routes');
const {createIsolatedConversationStore}=require('../src/modules/ai/ai-conversation-store');
const {createIsolatedConversations}=require('../src/modules/ai/ai-conversations');
const {createIsolatedConversationProvider}=require('../src/modules/ai/ai-conversation-provider');
const {createAiGovernance}=require('../src/modules/ai/ai-governance');
const {createAiQuota}=require('../src/modules/ai/ai-quota');
const {createAiQuotaStore}=require('../src/modules/ai/ai-quota-store');
const {AiTransportAdmission}=require('../src/modules/ai/providers/isolated-transport-admission');
const {selectKnowledge}=require('../src/modules/ai/intelligence/knowledge-catalog');
const {AiAuditEvent}=require('../src/modules/ai/ai-governance.model');
async function runPhase4ConversationProviderIntegration({auth,gateway,gs,token,foreignToken,readRequest,scope,
  registry,credentialStore,crypto,transport,admission,requests,setMode,setHook}){
  const descriptor=registry.models().find(d=>d.providerId==='anthropic');
  const selection={providerId:descriptor.providerId,modelId:descriptor.modelId,descriptorId:descriptor.descriptorId,fundingMode:'BYO_API'};
  const store=createIsolatedConversationStore();
  const service=()=>createIsolatedConversations({store:createIsolatedConversationStore(),registry,
    conversationProvider:createIsolatedConversationProvider({registry,store:credentialStore,crypto,transport,admission})});
  let current=service();
  const app=express(),quotaNow=Date.now()+14400000;
  app.use('/v1/ai/chat',createIsolatedChatRouter({authService:auth,gateway,governance:createAiGovernance({store:gs}),
    quota:createAiQuota({store:createAiQuotaStore(),now:()=>quotaNow,limit:100}),registry,
    conversations:{execute:(...args)=>current.execute(...args)},fixtureProviderEnabled:true,authorizePurpose:async r=>{
      assert.equal(r.externalExport,false);assert.equal(r.offlineOnly,true);return r.scope.actorId===scope.actorId&&(!r.selection||r.selection.providerId==='anthropic');
    }}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const root='http://127.0.0.1:'+server.address().port+'/v1/ai/chat/conversations/';
  const authority={accountId:readRequest.accountId,connectionId:readRequest.connectionId};
  const conversationId=randomUUID(),question='Synthetic Phase 4F education fixture: explain BOS.';
  async function call(op,payload={},credential=token){
    const r=await fetch(root+op,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential},
      body:JSON.stringify({...authority,...payload})});
    return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};
  }
  async function ok(op,payload={}){const r=await call(op,payload);assert.equal(r.status,200,op+' '+JSON.stringify(r.body?.error||{}));assert.equal(r.cache,'no-store');return r.body;}
  async function append(){const key={conversationId,messageId:randomUUID()};await ok('append',{...key,text:question});return key;}
  const expected=selectKnowledge('EDUCATION').entries.find(k=>k.id==='MARKET_STRUCTURE').knowledgeId;
  const start=requests();
  try{
    await ok('create',{conversationId,selection,profile:'EDUCATION'});
    const first=await append();
    assert.equal((await call('generate',first,foreignToken)).status,403);
    assert.equal((await call('generate',{...first,question:'forged prompt'})).status,400);
    assert.equal(requests(),start);
    const race=await Promise.all([call('generate',first),call('generate',first)]);
    const verified=race.find(v=>v.status===200&&v.body.providerRun?.state==='VERIFIED'&&v.body.replayed===false);
    assert.ok(verified,'one request must finish verified');
    assert.ok(race.every(v=>[200,409].includes(v.status)));
    const run=verified.body.providerRun;
    assert.deepEqual(run.referenceIds,[expected]);
    assert.equal(verified.body.verifiedEducation.entries[0].knowledgeId,expected);
    assert.equal(verified.body.verifiedEducation.entries[0].reviewStatus,'ENGINEERING_DRAFT');
    assert.equal(verified.body.verifiedEducation.fixtureOnly,true);assert.equal(run.inputTokens,100);assert.equal(run.outputTokens,20);
    assert.equal(verified.body.fixtureProviderOnly,true);assert.equal(verified.body.dispatchAllowed,false);assert.equal(verified.body.creditDeducted,false);
    assert.equal(requests(),start+1);
    // New service, new local orchestrator, same durable conversation claim.
    current=service();
    const replay=await ok('generate',first);assert.equal(replay.replayed,true);assert.deepEqual(replay.providerRun,run);
    assert.equal(requests(),start+1);
    const history=await ok('history',{conversationId});assert.deepEqual(history.messages[0].providerRun,run);assert.deepEqual(history.messages[0].verifiedEducation,verified.body.verifiedEducation);
    assert.ok(!JSON.stringify(run).includes('candidate-response-v2'));assert.ok(!Object.hasOwn(run,'candidate'));
    const invalid=await append();
    setMode('forged');
    const rejected=await ok('generate',invalid);setMode('normal');
    assert.equal(rejected.providerRun.state,'FAILED');assert.deepEqual(rejected.providerRun.referenceIds,[]);
    assert.equal((await ok('generate',invalid)).replayed,true);assert.equal(requests(),start+2);
    const cancelled=await append();
    setHook(async()=>{const r=await ok('cancel',cancelled);assert.equal(r.status,'CANCELLED');assert.equal(r.providerRun.state,'SUPPRESSED');});
    const suppressed=await call('generate',cancelled);setHook(null);
    assert.ok([404,409].includes(suppressed.status));assert.ok(!Object.hasOwn(suppressed.body,'providerRun'));
    assert.equal((await call('generate',cancelled)).status,404);assert.equal(requests(),start+3);
    const uncertain=await append();setMode('timeout');
    const held=await ok('generate',uncertain);setMode('normal');
    assert.equal(held.providerRun.state,'HELD_UNKNOWN');assert.deepEqual(held.providerRun.referenceIds,[]);
    current=service();assert.deepEqual((await ok('generate',uncertain)).providerRun,held.providerRun);
    assert.equal(requests(),start+4);
    const final=await ok('history',{conversationId});
    assert.deepEqual(final.messages.map(m=>m.providerRun.state),['VERIFIED','FAILED','SUPPRESSED','HELD_UNKNOWN']);
    assert.ok(final.messages.slice(1).every(m=>m.providerRun.referenceIds.length===0&&m.verifiedEducation===null));
    const doc=await AiTransportAdmission.findOne({tenantId:scope.tenantId,actorId:scope.actorId}).lean();
    for(const m of [run,rejected.providerRun,held.providerRun]){
      const a=doc.attempts.find(x=>x.operationId===m.operationId);
      assert.ok(a);assert.equal(a.accountId,scope.accountId);
      if(m.state==='HELD_UNKNOWN'){assert.ok(['CLAIMED','HELD_UNKNOWN'].includes(a.state));assert.equal(a.tokens,9216);}
    }
    assert.equal(doc.attempts.filter(a=>a.operationId===run.operationId).length,1);
    const audits=await AiAuditEvent.find({tenantId:scope.tenantId,operation:'CHAT_GENERATE_OFFLINE'}).lean();
    assert.ok(audits.some(a=>a.stage==='ALLOWED'));assert.ok(audits.some(a=>a.stage==='DENIED'));
    assert.ok(audits.every(a=>!Object.hasOwn(a,'question')&&!Object.hasOwn(a,'result')&&!Object.hasOwn(a,'candidate')));
    if(process.env.ACG_AI_PHASE4F_BROWSER_DIR){
      const {spawn}=require('node:child_process');
      const dir=require('node:path').resolve(process.env.ACG_AI_PHASE4F_BROWSER_DIR);
      await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,['tests/ui/ai-phase4f-integrated.mjs'],{cwd:dir,stdio:['pipe','pipe','pipe']});
        let out='',err='';const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
        child.stdout.on('data',v=>{out=(out+v).slice(-16000);});child.stderr.on('data',v=>{err=(err+v).slice(-16000);});
        child.stdin.on('error',()=>{});
        child.once('error',()=>{clearTimeout(timer);reject(Error('Phase 4F response browser runner unavailable'));});
        child.once('close',code=>{
          clearTimeout(timer);
          if(code!==0||!out.includes('PASS Phase 4F verified education browser')){
            const reason=err.includes('TimeoutError')?'timeout':err.includes('AssertionError')?'assertion':'runner';
            reject(Error('Phase 4F response browser acceptance failed: '+reason));return;
          }
          console.log('PASS Phase 4F verified education browser rendering, historical reload and safe failure states');resolve();
        });
        child.stdin.end(JSON.stringify({root:'http://127.0.0.1:'+server.address().port,authority,token,foreignToken,
          providerMode:true,existingConversationId:conversationId}));
      });
      assert.equal(requests(),start+5); // one additional local fixture request, no paid inference
    }
    await ok('delete',{conversationId});
    const row=(await store.read(scope)).conversations.find(c=>c.conversationId===conversationId);
    assert.equal(row.status,'DELETED');assert.equal(row.messages.length,0);
    assert.equal((await call('generate',first)).status,404);assert.equal(requests(),start+(process.env.ACG_AI_PHASE4F_BROWSER_DIR?5:4));
    console.log('PASS Phase 4F durable message/provider claim, real authenticated TLS fixture, reference verification, replay after service restart, invalid reference rejection, in-flight cancellation, unknown hold and deletion');
  }finally{setMode('normal');setHook(null);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
module.exports={runPhase4ConversationProviderIntegration};
