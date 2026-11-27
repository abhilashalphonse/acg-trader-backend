'use strict';
const assert=require('node:assert/strict');
const https=require('node:https');
const {mkdtempSync,readFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {execFileSync}=require('node:child_process');
const {randomBytes,randomUUID}=require('node:crypto');
const {scopeFor}=require('../src/modules/ai/ai-read-gateway');
const {createCredentialVault}=require('../src/modules/ai/providers/credential-vault');
const {createCredentialVaultStore}=require('../src/modules/ai/providers/credential-vault-store');
const {createEnvelopeCrypto}=require('../src/modules/ai/providers/credential-crypto');
const {createModelRegistry}=require('../src/modules/ai/providers/model-registry');
const {createOfflineRequest}=require('../src/modules/ai/providers/provider-contract');
const {createResponseEngine}=require('../src/modules/ai/intelligence/response-engine');
const {createIsolatedHttpsTransport}=require('../src/modules/ai/providers/isolated-https-transport');
const {createIsolatedCredentialAdapter}=require('../src/modules/ai/providers/isolated-credential-adapter');
const {createIsolatedTransportAdmission,AiTransportAdmission}=require('../src/modules/ai/providers/isolated-transport-admission');
const {buildWireRequest}=require('../src/modules/ai/providers/provider-wire');
const {assertIsolated}=require('../src/modules/ai/providers/credit-ledger-store');
const {createOfflineOrchestrator}=require('../src/modules/ai/providers/offline-orchestrator');
const {createOfflineBudget}=require('../src/modules/ai/providers/compute-budget');
async function runPhase4TransportIntegration({auth,gateway,gs,token,foreignToken,readRequest}){
  assertIsolated();
  const {channel,...scope}=scopeFor(await auth.authenticateSessionToken(token),readRequest.accountId,Date.now());
  const vs={tenantId:scope.tenantId,actorId:scope.actorId,sessionId:scope.sessionId};
  const rev=(await gs.control(scope.tenantId)).revision;
  const providers=['openai','anthropic','gemini','deepseek','openrouter'],modelId='fixture-transport-v1';
  const registry=createModelRegistry({allowSynthetic:true,descriptors:providers.map(providerId=>({
    providerId,modelId,revision:'fixture-1',reviewStatus:'SYNTHETIC_TEST_ONLY',fundingModes:['BYO_API'],
    capabilities:{input:'TEXT',responseMode:'JSON_OBJECT',separateInstructionChannel:true,streaming:true,
      usageReporting:'PROVIDER_REPORTED',maxContextTokens:16384,maxOutputTokens:2048}}))});
  let activeToken=token,allow=true,mode='normal',hook=null,requests=0,lastError=null;
  async function fresh(s){
    try{
      if(!allow)return false;
      const p=await auth.authenticateSessionToken(activeToken);
      const current=scopeFor(p,readRequest.accountId,Date.now());
      if(!Object.keys(s).every(k=>current[k]===s[k]))return false;
      await gateway.assertDisclosure(p,readRequest);
      const c=await gs.control(scope.tenantId);return c.enabled===true&&c.revision===rev;
    }catch{return false;}
  }
  const store=createCredentialVaultStore(),crypto=createEnvelopeCrypto({keys:[{id:'transport-fixture',key:randomBytes(32)}],activeKeyId:'transport-fixture'});
  const vault=createCredentialVault({store,crypto,authorize:r=>fresh(r.scope)});
  const secret='isolated-transport-fixture-'+randomBytes(24).toString('hex');
  for(const providerId of providers){
    const existing=(await vault.list(vs)).find(d=>d.providerId===providerId);
    await vault.change(vs,{operation:existing?'REPLACE':'CONNECT',providerId,expectedRevision:existing?.revision??0,secret});
  }
  const admission=createIsolatedTransportAdmission();await admission.provision();
  const dir=mkdtempSync(join(tmpdir(),'acg-ai-tls-'));let server;const sockets=new Set();
  try{
    for(const name of ['trusted','untrusted']){
      execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1',
        '-addext','subjectAltName=IP:127.0.0.1','-keyout',join(dir,name+'.key'),'-out',join(dir,name+'.crt')],{stdio:'ignore'});
    }
    const ca=readFileSync(join(dir,'trusted.crt'));
    const engine=createResponseEngine({authorize:r=>fresh(r.scope)});
    const selection=p=>({providerId:p,modelId,fundingMode:'BYO_API'});
    const prepare=async(p,stream=false)=>{
      const {ticket,prompt}=await engine.prepare({scope,profile:'EDUCATION',question:'Explain BOS.'});
      const q=createOfflineRequest({registry,selection:selection(p),prompt,inputTokenUpperBound:8192,maxOutputTokens:1024,nowMs:Date.now(),stream});
      return {ticket,q};
    };
    const event=(v)=>'data: '+(typeof v==='string'?v:JSON.stringify(v))+'\n\n';
    server=https.createServer({key:readFileSync(join(dir,'trusted.key')),cert:ca},async(req,res)=>{
      requests++;
      try{
        const parts=[];for await(const part of req)parts.push(part);
        const raw=Buffer.concat(parts).toString('utf8'),wire=JSON.parse(raw);
        assert.equal(req.method,'POST');assert.equal(req.headers['accept-encoding'],'identity');
        assert.ok(!raw.includes(secret));for(const v of Object.values(scope))assert.ok(!raw.includes(v));
        const p=req.url.startsWith('/v1beta/')?'gemini':req.url==='/v1/messages'?'anthropic':req.url.startsWith('/api/v1/')?'openrouter':
          req.url==='/chat/completions'?'deepseek':'openai';
        assert.equal(req.headers[p==='gemini'?'x-goog-api-key':p==='anthropic'?'x-api-key':'authorization'],
          ['gemini','anthropic'].includes(p)?secret:'Bearer '+secret);
        const data=JSON.parse(p==='gemini'?wire.contents[0].parts[0].text:wire.messages.at(-1).content);
        const candidate=JSON.stringify({schemaVersion:'candidate-response-v2',status:'ANSWER',observations:[],interpretations:[],
          education:[{knowledgeId:data.knowledge.entries.find(k=>k.id==='MARKET_STRUCTURE').knowledgeId}]});
        if(mode==='redirect'){res.writeHead(302,{location:'https://invalid.example/never-follow'});res.end('not read');return;}
        if(mode==='timeout')return;
        if(hook)await hook();
        if(wire.stream){
          res.writeHead(200,{'content-type':'text/event-stream'});
          const s=event({model:modelId,choices:[{index:0,delta:{content:candidate},finish_reason:'stop'}]})+
            event({model:modelId,choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+event('[DONE]');
          res.end(mode==='truncated'?s.slice(0,-3):s);return;
        }
        const payload=p==='anthropic'?{role:'assistant',model:modelId,content:[{type:'text',text:candidate}],stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:20}}:
          p==='gemini'?{modelVersion:modelId,candidates:[{content:{parts:[{text:candidate}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,totalTokenCount:120}}:
          {model:modelId,choices:[{index:0,message:{role:'assistant',content:candidate},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}};
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(payload));
      }catch(e){lastError=e;res.destroy();}
    });
    server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const transport=createIsolatedHttpsTransport({port:server.address().port,ca});
    const adapter=(p,operationId=randomUUID(),overrides={})=>createIsolatedCredentialAdapter({scope,selection:selection(p),registry,
      store,crypto,transport,admission:createIsolatedTransportAdmission(),operationId,authorize:r=>fresh(r.scope),...overrides});
    for(const p of providers){
      const {ticket,q}=await prepare(p);
      const v=await adapter(p).generate(q);
      assert.equal(v.status,'COMPLETED',p);assert.equal(v.usage.totalTokens,120);assert.equal(v.usageDisposition,'UNSETTLED');
      const verified=await engine.verify({ticket,scope,candidate:v.candidate});
      assert.equal(verified.verified,true);assert.equal(verified.response.education[0].id,'MARKET_STRUCTURE');
    }
    // Full Phase 3 orchestration: bounded synthetic budget, credential transport,
    // provider response normalization and one-use reference verification.
    const operationId=randomUUID(),policy={maxInputTokens:8192,maxOutputTokens:1024,maxRequestsPerUtcDay:4,maxTokensPerUtcDay:40000,
      maxCostPicoUsdPerRequest:null,maxCostPicoUsdPerUtcDay:null};
    const orchestrator=createOfflineOrchestrator({registry,responseEngine:engine,adapters:[adapter('openai',operationId)],
      authorize:r=>fresh(r.scope),computeBudget:createOfflineBudget({policies:{BYO_API:policy,ACG_CREDITS:policy}})});
    const result=await orchestrator.run({scope,idempotencyKey:operationId,selection:selection('openai'),profile:'EDUCATION',
      question:'Explain BOS.',context:null,inputTokenUpperBound:8192,maxOutputTokens:1024,stream:true,timeoutMs:10000});
    assert.equal(result.receipt.status,'COMPLETED');assert.equal(result.response.education[0].id,'MARKET_STRUCTURE');
    assert.equal(result.receipt.budget.status,'ACCOUNTED_OFFLINE');
    const seen=requests;
    // New adapter, new request UUID, same logical operation: durable denial.
    assert.equal((await adapter('openai',operationId).generate((await prepare('openai')).q)).status,'UNKNOWN');
    assert.equal(requests,seen);
    const denied=(await prepare('openai')).q;
    activeToken=foreignToken;assert.equal((await adapter('openai').generate(denied)).status,'UNKNOWN');activeToken=token;
    assert.equal(requests,seen);
    mode='redirect';assert.equal((await adapter('openai').generate((await prepare('openai')).q)).errorCode,'INVALID_RESPONSE');
    assert.equal(requests,seen+1);
    mode='timeout';const slow=await adapter('openai').generate((await prepare('openai')).q,{timeoutMs:250});
    assert.equal(slow.errorCode,'TIMEOUT');
    mode='truncated';const cut=await adapter('openai').generate((await prepare('openai',true)).q);
    assert.notEqual(cut.status,'COMPLETED');assert.equal(cut.candidate,null);
    mode='normal';
    const wrongCA=createIsolatedHttpsTransport({port:server.address().port,ca:readFileSync(join(dir,'untrusted.crt'))});
    const beforeTls=requests;
    assert.equal((await adapter('openai',randomUUID(),{transport:wrongCA}).generate((await prepare('openai')).q)).status,'UNKNOWN');
    assert.equal(requests,beforeTls);
    // Credential revoked after the TLS request was received: no candidate escapes.
    hook=async()=>{const d=(await vault.list(vs)).find(v=>v.providerId==='openai');await vault.change(vs,{operation:'REVOKE',providerId:'openai',expectedRevision:d.revision});};
    const revoked=await adapter('openai').generate((await prepare('openai')).q);hook=null;
    assert.equal(revoked.status,'UNKNOWN');assert.equal(revoked.candidate,null);
    const afterRev=requests;
    assert.equal((await adapter('openai').generate((await prepare('openai')).q)).status,'UNKNOWN');assert.equal(requests,afterRev);
    assert.equal(lastError,null);
    const doc=await AiTransportAdmission.findOne({tenantId:scope.tenantId,actorId:scope.actorId}).lean();
    assert.equal(doc.attempts.length,11);
    assert.equal(doc.attempts.filter(a=>a.state==='ACCOUNTED_OFFLINE').length,7);
    assert.equal(doc.attempts.filter(a=>a.state==='HELD_UNKNOWN').length,4);
    assert.equal(doc.reservedTokens,7*120+4*9216);
    assert.ok(!JSON.stringify(doc).includes(secret));assert.ok(!JSON.stringify(doc).includes('Explain BOS.'));
    console.log('PASS Phase 4E five protocol HTTPS fixtures, real TLS verification, encrypted key custody, durable one-shot admission, orchestrated verified answer, uncertain holds, redirect/timeout/truncation and revocation denial');
  }finally{for(const s of sockets)s.destroy();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
}
module.exports={runPhase4TransportIntegration};
