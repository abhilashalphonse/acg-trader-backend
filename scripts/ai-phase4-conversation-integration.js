'use strict';
const assert=require('node:assert/strict');
const express=require('express');
const {randomUUID}=require('node:crypto');
const {createIsolatedChatRouter}=require('../src/modules/ai/ai-chat.routes');
const {createIsolatedConversationStore}=require('../src/modules/ai/ai-conversation-store');
const {createIsolatedConversations,TTL_MS}=require('../src/modules/ai/ai-conversations');
const {AiConversationBucket}=require('../src/modules/ai/ai-conversation.model');
const {createModelRegistry}=require('../src/modules/ai/providers/model-registry');
const {createAiGovernance}=require('../src/modules/ai/ai-governance');
const {createAiQuota}=require('../src/modules/ai/ai-quota');
const {createAiQuotaStore}=require('../src/modules/ai/ai-quota-store');
const {AiAuditEvent}=require('../src/modules/ai/ai-governance.model');
async function runPhase4ConversationIntegration({auth,gateway,gs,token,foreignToken,readRequest,scope}){
  const registry=createModelRegistry({allowSynthetic:true,descriptors:[{providerId:'openai',modelId:'fixture-conversation',
    revision:'v1',reviewStatus:'SYNTHETIC_TEST_ONLY',fundingModes:['BYO_API'],
    capabilities:{input:'TEXT',responseMode:'JSON_OBJECT',separateInstructionChannel:true,streaming:false,
      usageReporting:'PROVIDER_REPORTED',maxContextTokens:8192,maxOutputTokens:1024}}]});
  const descriptor=registry.models()[0],selection={providerId:descriptor.providerId,modelId:descriptor.modelId,
    descriptorId:descriptor.descriptorId,fundingMode:'BYO_API'};
  const store=createIsolatedConversationStore();await store.provision();
  let clock=Date.now(),permitHook=null;
  const service=()=>createIsolatedConversations({store:createIsolatedConversationStore(),registry,now:()=>clock});
  let current=service();
  const app=express(),quotaNow=Date.now()+7200000;
  app.use('/v1/ai/chat',createIsolatedChatRouter({authService:auth,gateway,governance:createAiGovernance({store:gs}),
    quota:createAiQuota({store:createAiQuotaStore(),now:()=>quotaNow,limit:100}),registry,
    conversations:{execute:(...a)=>current.execute(...a)},authorizePurpose:async r=>{
      assert.equal(r.externalExport,false);assert.equal(r.offlineOnly,true);
      if(permitHook)await permitHook(r);
      return true;
    }}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const root='http://127.0.0.1:'+server.address().port+'/v1/ai/chat/conversations/';
  const authority={accountId:readRequest.accountId,connectionId:readRequest.connectionId};
  const conversationId=randomUUID(),create={conversationId,selection,profile:'EDUCATION'},text='Fixture discussion: BOS and confirmed structure.';
  async function call(op,payload={},credential=token){
    const r=await fetch(root+op,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential},
      body:JSON.stringify({...authority,...payload})});
    return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};
  }
  async function ok(op,payload={}){const v=await call(op,payload);assert.equal(v.status,200,op+' '+JSON.stringify(v.body?.error||{}));return v.body;}
  const direct=async(op,x,s=scope)=>current.execute(s,op,x,async()=>{});
  try{
    const creates=await Promise.all([ok('create',create),ok('create',create)]);
    assert.deepEqual(creates[0],creates[1]);assert.equal(creates[0].messageCount,0);
    assert.equal((await ok('list')).conversations.length,1);
    assert.equal((await call('history',{conversationId},foreignToken)).status,403);
    assert.equal((await call('history',{conversationId,actorId:scope.actorId})).status,400);
    const first={conversationId,messageId:randomUUID(),text};
    const twins=await Promise.all([ok('append',first),ok('append',first)]);
    assert.deepEqual(twins[0],twins[1]);assert.equal(twins[0].sequence,1);
    assert.equal(twins[0].status,'STORED_OFFLINE');assert.equal(twins[0].dispatchAllowed,false);
    assert.equal(twins[0].creditDeducted,false);assert.ok(!JSON.stringify(twins[0]).includes(text));
    assert.equal((await call('append',{...first,text:'Conflicting duplicate'})).status,409);
    assert.equal((await call('append',{...first,messageId:randomUUID(),text:'api_key=fixture_secret'})).status,400);
    assert.equal((await call('append',{...first,messageId:randomUUID(),text:'€'.repeat(1366)})).status,400);
    assert.equal((await call('append',{...first,messageId:randomUUID(),role:'ASSISTANT'})).status,400);
    const long='a'.repeat(4096);
    const second=await ok('append',{conversationId,messageId:randomUUID(),text:long});assert.equal(second.sequence,2);
    const remaining=Array.from({length:14},()=>({conversationId,messageId:randomUUID(),text:'Concurrent offline fixture'}));
    // Parallel writers compete on one document; every successful message gets
    // exactly one stable sequence even under retryable CAS contention.
    for(let i=0;i<remaining.length;i+=4){
      const group=await Promise.all(remaining.slice(i,i+4).map(x=>direct('append',x)));
      assert.equal(new Set(group.map(x=>x.value.sequence)).size,group.length);
    }
    assert.equal((await call('append',{...first,messageId:randomUUID()})).status,429);
    // New service object and store read the durable state, not a local queue.
    current=service();
    const page1=await ok('history',{conversationId,limit:8});
    const page2=await ok('history',{conversationId,afterSequence:page1.nextAfterSequence,limit:8});
    assert.deepEqual([...page1.messages,...page2.messages].map(m=>m.sequence),Array.from({length:16},(_,i)=>i+1));
    assert.equal(page2.nextAfterSequence,null);assert.equal(page1.messages[1].text,long);
    assert.ok(page1.messages.every(m=>m.role==='USER'&&m.dispatchAllowed===false));
    const cancelled=await ok('cancel',{conversationId,messageId:first.messageId});
    assert.equal(cancelled.status,'CANCELLED');
    assert.deepEqual(await ok('append',first),cancelled);
    // Same owner/account with a new session can recover only through the
    // trusted service scope; HTTP fresh auth/grant is separately exercised.
    const another={...scope,sessionId:'f'.repeat(24)};
    assert.equal((await direct('history',{conversationId},another)).value.messages[0].status,'CANCELLED');
    for(const key of ['tenantId','actorId','accountId']){
      const foreign={...scope,[key]:scope[key]==='f'.repeat(24)?'e'.repeat(24):'f'.repeat(24)};
      assert.equal((await direct('list',{},foreign)).value.conversations.length,0);
      await assert.rejects(direct('history',{conversationId},foreign),{code:'AI_CHAT_NOT_FOUND'});
    }
    // Delete between read and final disclosure. No stale plaintext response.
    let selectedChecks=0;
    permitHook=async r=>{
      if(r.operation==='CHAT_HISTORY_OFFLINE'&&r.selection&&++selectedChecks===2)
        await direct('delete',{conversationId});
    };
    const suppressed=await call('history',{conversationId});permitHook=null;
    assert.equal(suppressed.status,409);assert.equal(suppressed.body.error.code,'AI_CHAT_CHANGED');
    assert.ok(!JSON.stringify(suppressed.body).includes(text));
    assert.equal((await ok('list')).conversations.length,0);
    assert.equal((await call('history',{conversationId})).status,404);
    assert.equal((await call('create',create)).status,409);
    assert.deepEqual(await ok('delete',{conversationId}),await ok('delete',{conversationId}));
    const persisted=await store.read(scope);
    const deleted=persisted.conversations.find(c=>c.conversationId===conversationId);
    assert.equal(deleted.status,'DELETED');assert.equal(deleted.messages.length,0);
    assert.equal(deleted.selection,null);assert.equal(deleted.profile,null);
    assert.ok(!JSON.stringify(persisted).includes(text));
    const slots=Array.from({length:7},()=>({...create,conversationId:randomUUID()}));
    for(const x of slots)await direct('create',x);
    await assert.rejects(direct('create',{...create,conversationId:randomUUID()}),{code:'AI_CHAT_CAPACITY'});
    const expiring=slots[0].conversationId;
    await direct('append',{conversationId:expiring,messageId:randomUUID(),text:'Expiry fixture'});
    const beforeExpiry=await direct('history',{conversationId:expiring});
    clock+=TTL_MS+1;
    await assert.rejects(beforeExpiry.fence(),{code:'AI_CHAT_EXPIRED'});
    assert.equal((await direct('list',{})).value.conversations.length,0);
    await assert.rejects(direct('history',{conversationId:expiring}),{code:'AI_CHAT_NOT_FOUND'});
    await direct('create',{...create,conversationId:randomUUID()});
    assert.equal((await store.read(scope)).conversations.length,1);
    const indexes=await AiConversationBucket.collection.indexes();
    assert.ok(indexes.some(i=>i.expireAfterSeconds===0&&i.key.expiresAt===1));
    const audits=await AiAuditEvent.find({tenantId:scope.tenantId,operation:'CHAT_HISTORY_OFFLINE'}).lean();
    assert.ok(audits.some(e=>e.stage==='SUPPRESSED'&&e.reason==='AI_CHAT_CHANGED'));
    assert.ok(audits.every(e=>!Object.hasOwn(e,'text')&&!Object.hasOwn(e,'question')&&!Object.hasOwn(e,'result')));
    console.log('PASS Phase 4C real Mongo conversation CAS, duplicate submission, 16 ordered messages, cancellation, reload, foreign scope, deletion fence, tombstone and retention limits');
    if(process.env.ACG_AI_PHASE4F_BROWSER_DIR){
      const {spawn}=require('node:child_process');
      const path=require('node:path');
      const dir=path.resolve(process.env.ACG_AI_PHASE4F_BROWSER_DIR);
      // Synthetic session is passed on stdin only, never CLI args or browser JS.
      await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,['tests/ui/ai-phase4f-integrated.mjs'],{cwd:dir,stdio:['pipe','pipe','pipe']});
        let out='',err='';
        const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
        child.stdout.on('data',v=>{out=(out+v).slice(-16000);});
        child.stderr.on('data',v=>{err=(err+v).slice(-16000);});
        child.stdin.on('error',()=>{});
        child.once('error',()=>{clearTimeout(timer);reject(Error('Phase 4F browser runner unavailable'));});
        child.once('close',code=>{
          clearTimeout(timer);
          if(code!==0||!out.includes('PASS Phase 4F native desktop/mobile browser')){
            // Never echo child output; a browser error can include fixture session data.
            const reason=err.includes('TimeoutError')?'timeout':err.includes('AssertionError')?'assertion':'runner';
            reject(Error('Phase 4F browser acceptance failed: '+reason));return;
          }
          console.log('PASS Phase 4F real authenticated loopback desktop/mobile browser lifecycle and foreign-session denial');
          resolve();
        });
        child.stdin.end(JSON.stringify({root:'http://127.0.0.1:'+server.address().port,authority,token,foreignToken}));
      });
    }
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
module.exports={runPhase4ConversationIntegration};
