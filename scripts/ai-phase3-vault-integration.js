'use strict';
// Existing Phase 1 loopback CI fixture supplies real Supabase sessions and
// disposable Mongo rs0. No production connection or key material is accepted.
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const {createEnvelopeCrypto}=require('../src/modules/ai/providers/credential-crypto');
const {AiProviderConnection,AiCredentialAudit}=require('../src/modules/ai/providers/credential-vault.model');
const {createCredentialVaultStore}=require('../src/modules/ai/providers/credential-vault-store');
const {createCredentialVault}=require('../src/modules/ai/providers/credential-vault');
async function runPhase3VaultIntegration({auth,token,foreignToken}){
  if(process.env.NODE_ENV!=='test'||process.env.ACG_AI_ISOLATED_CI!=='true'||
    !/^acg_ai_ci_[a-f0-9]{24}$/.test(mongoose.connection.name)||
    mongoose.connection.host!=='127.0.0.1')throw Error('Phase 3 vault requires isolated CI database');
  for(const model of [AiProviderConnection,AiCredentialAudit]){await model.createCollection();await model.createIndexes();}
  assert.ok((await AiProviderConnection.collection.indexes()).some(i=>i.unique&&i.key.tenantId===1&&i.key.actorId===1&&i.key.providerId===1));
  async function scopeOf(t){const p=await auth.authenticateSessionToken(t);assert.equal(p.authMethod,'SUPABASE');
    return {tenantId:p.tenantId,actorId:p.userId,sessionId:p.sessionId};}
  const scope=await scopeOf(token),foreign=await scopeOf(foreignToken);
  let active=token;
  const authorize=async req=>{try{const s=await scopeOf(active);return Object.keys(s).every(k=>s[k]===req.scope[k]);}catch{return false;}};
  const store=createCredentialVaultStore();
  const keys=[{id:'fixture1',key:Buffer.alloc(32,1)},{id:'fixture2',key:Buffer.alloc(32,2)}];
  const crypto=createEnvelopeCrypto({keys,activeKeyId:'fixture1'});
  const vault=createCredentialVault({store,crypto,authorize});
  const providerId='openai',secret='isolated-not-a-provider-key';
  const connect={operation:'CONNECT',providerId,expectedRevision:0,secret};
  const race=await Promise.allSettled([vault.change(scope,connect),vault.change(scope,connect)]);
  assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(race.find(x=>x.status==='rejected').reason.code,'CREDENTIAL_CONFLICT');
  const created=race.find(x=>x.status==='fulfilled').value;
  assert.equal(created.revision,1);
  const persisted=await AiProviderConnection.collection.findOne({_id:created.connectionId});
  assert.equal(persisted.envelope.keyId,'fixture1');
  assert.equal(JSON.stringify(persisted).includes(secret),false);
  assert.equal((await store.get(scope,created.connectionId)).envelope,undefined);
  assert.equal((await store.get(scope,created.connectionId,true)).envelope.keyId,'fixture1');
  assert.equal((await vault.list(scope))[0].connectionId,created.connectionId);
  active=foreignToken;
  await assert.rejects(vault.list(scope),{code:'CREDENTIAL_FORBIDDEN'});
  assert.deepEqual(await vault.list(foreign),[]);
  assert.equal(await store.get(foreign,created.connectionId,true),null);
  active=token;
  const replacement={operation:'REPLACE',providerId,expectedRevision:1,secret:'new-isolated-not-a-key'};
  const writes=await Promise.allSettled([vault.change(scope,replacement),vault.change(scope,replacement)]);
  assert.equal(writes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(writes.find(x=>x.status==='rejected').reason.code,'CREDENTIAL_CONFLICT');
  const rotating=createCredentialVault({store,crypto:createEnvelopeCrypto({keys,activeKeyId:'fixture2'}),authorize});
  assert.equal((await rotating.change(scope,{operation:'REWRAP',providerId,expectedRevision:2})).revision,3);
  const current=await store.get(scope,created.connectionId,true);
  assert.equal(current.envelope.keyId,'fixture2');
  const binding={tenantId:scope.tenantId,actorId:scope.actorId,connectionId:current._id,providerId,generation:current.generation};
  const opened=createEnvelopeCrypto({keys:[keys[1]],activeKeyId:'fixture2'}).decrypt(current.envelope,binding);
  assert.equal(opened.toString(),'new-isolated-not-a-key');opened.fill(0);
  // Force a duplicate audit insert AFTER the credential CAS; transaction must roll back.
  const existing=await AiCredentialAudit.findOne({connectionId:current._id}).lean();
  await assert.rejects(store.commit({scope,previous:current,next:{...current,revision:4,status:'REVOKED',envelope:null,
    revokedAt:new Date(),changedAt:new Date()},event:existing}),{code:'CREDENTIAL_CONFLICT'});
  assert.equal((await store.get(scope,current._id,true)).revision,3);
  assert.equal((await store.get(scope,current._id,true)).envelope.keyId,'fixture2');
  const revoked=await rotating.change(scope,{operation:'REVOKE',providerId,expectedRevision:3});
  assert.equal(revoked.status,'REVOKED');assert.equal((await store.get(scope,current._id,true)).envelope,null);
  assert.equal((await rotating.change(scope,{operation:'RECONNECT',providerId,expectedRevision:4,secret})).revision,5);
  const audit=await AiCredentialAudit.find({connectionId:current._id}).sort({revision:1}).lean();
  assert.deepEqual(audit.map(x=>x.operation),['CONNECT','REPLACE','REWRAP','REVOKE','RECONNECT']);
  assert.ok(audit.every(x=>!Object.hasOwn(x,'secret')&&!Object.hasOwn(x,'envelope')));
  await assert.rejects(AiCredentialAudit.updateOne({_id:audit[0]._id},{$set:{revision:100}}),/append-only/);
  console.log('PASS Phase 3 vault real Mongo encryption, current session ownership, concurrent CAS, rewrap, transactional audit rollback and revocation');
}
module.exports={runPhase3VaultIntegration};
