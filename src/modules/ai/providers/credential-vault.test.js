'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createEnvelopeCrypto}=require('./credential-crypto');
const {createCredentialVault,connectionId}=require('./credential-vault');
const scope={tenantId:'a'.repeat(24),actorId:'b'.repeat(24),sessionId:'c'.repeat(24)};
const other={...scope,actorId:'d'.repeat(24)};
const providerId='openai',secret='synthetic-fixture-key-not-real';
const keys=[{id:'old',key:Buffer.alloc(32,11)},{id:'new',key:Buffer.alloc(32,22)}];
const cryptoFor=(activeKeyId='old',ring=keys)=>createEnvelopeCrypto({keys:ring,activeKeyId});
const binding=d=>({tenantId:d.tenantId,actorId:d.actorId,connectionId:d._id,providerId:d.providerId,generation:d.generation});
const fixtureBinding={...scope,providerId,connectionId:connectionId(scope,providerId),generation:'12345678-1234-4234-8234-123456789abc'};
function fixture(){
  let allowed=true,reads=0,checks=0,commits=0,hook=null;
  const docs=new Map(),events=[];
  const store={
    async list(s){reads++;return [...docs.values()].filter(d=>d.tenantId===s.tenantId&&d.actorId===s.actorId).map(({envelope,...d})=>structuredClone(d));},
    async get(s,key,include=false){reads++;const d=docs.get(key);if(!d||d.tenantId!==s.tenantId||d.actorId!==s.actorId)return null;
      const copy=structuredClone(d);if(!include)delete copy.envelope;return copy;},
    async commit({scope:s,previous,next,event}){
      const current=docs.get(next._id);
      if((current?.revision??0)!==(previous?.revision??0))throw Object.assign(Error('conflict'),{code:'CREDENTIAL_CONFLICT'});
      docs.set(next._id,structuredClone(next));events.push(structuredClone(event));commits++;
    }
  };
  const authorize=async req=>{checks++;assert.equal(JSON.stringify(req).includes(secret),false);if(hook)hook(checks);return allowed;};
  const vault=createCredentialVault({store,crypto:cryptoFor(),authorize,now:()=>Date.UTC(2026,0,1)});
  return {vault,store,authorize,docs,events,counts:()=>({reads,checks,commits}),deny:()=>{allowed=false;},hook:f=>{hook=f;}};
}
test('authenticated envelopes are randomized, owner-bound, tamper-evident and rotatable',()=>{
  const c=cryptoFor(),p=Buffer.from(secret);
  const a=c.encrypt(p,fixtureBinding),b=c.encrypt(p,fixtureBinding);
  assert.notDeepEqual(a,b);assert.equal(JSON.stringify(a).includes(secret),false);
  assert.deepEqual(c.decrypt(a,fixtureBinding),p);
  for(const change of [{tenantId:other.actorId},{actorId:other.actorId},{providerId:'gemini'},
    {connectionId:'0'.repeat(64)},{generation:'87654321-1234-4234-8234-123456789abc'}]){
    assert.throws(()=>c.decrypt(a,{...fixtureBinding,...change}),{code:'CREDENTIAL_CRYPTO_FAILED'});
  }
  for(const field of ['secret','wrappedKey']){
    const broken=structuredClone(a),tag=Buffer.from(broken[field].tag,'base64');
    tag[0]^=1;broken[field].tag=tag.toString('base64');
    assert.throws(()=>c.decrypt(broken,fixtureBinding),{code:'CREDENTIAL_CRYPTO_FAILED'});
    assert.throws(()=>cryptoFor('new').rewrap(broken,fixtureBinding),{code:'CREDENTIAL_CRYPTO_FAILED'});
  }
  const rotated=cryptoFor('new').rewrap(a,fixtureBinding);
  assert.equal(rotated.keyId,'new');assert.deepEqual(rotated.secret,a.secret);
  const newOnly=cryptoFor('new',[keys[1]]);
  assert.deepEqual(newOnly.decrypt(rotated,fixtureBinding),p);
  assert.throws(()=>newOnly.decrypt(a,fixtureBinding),{code:'CREDENTIAL_CRYPTO_FAILED'});
  assert.throws(()=>createEnvelopeCrypto({keys:[{id:'bad',key:Buffer.alloc(31)}],activeKeyId:'bad'}),{code:'CREDENTIAL_CRYPTO_FAILED'});
});
test('connect, replace, revoke, reconnect and rewrap preserve revision and return metadata only',async()=>{
  const f=fixture(),change=(operation,expectedRevision,extra={})=>f.vault.change(scope,{operation,providerId,expectedRevision,...extra});
  const created=await change('CONNECT',0,{secret});const key=created.connectionId;
  assert.equal(created.status,'STORED_UNVERIFIED');assert.equal(created.providerVerified,false);
  assert.equal(created.runtimeEnabled,false);assert.equal(created.revision,1);
  assert.equal(JSON.stringify(created).includes('envelope'),false);
  const first=f.docs.get(key);
  assert.equal(JSON.stringify(first).includes(secret),false);
  assert.equal(cryptoFor().decrypt(first.envelope,binding(first)).toString(),secret);
  assert.deepEqual(await f.vault.list(other),[]);
  await assert.rejects(f.vault.change(other,{operation:'REVOKE',providerId,expectedRevision:1}),{code:'CREDENTIAL_CONFLICT'});
  await assert.rejects(change('CONNECT',0,{secret}),{code:'CREDENTIAL_CONFLICT'});
  const updated=await change('REPLACE',1,{secret:'replacement-fixture'});
  assert.equal(updated.revision,2);assert.notEqual(f.docs.get(key).generation,first.generation);
  const rotation=createCredentialVault({store:f.store,crypto:cryptoFor('new'),authorize:f.authorize,now:()=>Date.UTC(2026,0,2)});
  const r=await rotation.change(scope,{operation:'REWRAP',providerId,expectedRevision:2});
  assert.equal(r.revision,3);assert.equal(f.docs.get(key).envelope.keyId,'new');
  assert.equal(cryptoFor('new',[keys[1]]).decrypt(f.docs.get(key).envelope,binding(f.docs.get(key))).toString(),'replacement-fixture');
  assert.equal((await change('REVOKE',3)).status,'REVOKED');assert.equal(f.docs.get(key).envelope,null);
  await assert.rejects(change('REPLACE',4,{secret}),{code:'CREDENTIAL_STATE_INVALID'});
  assert.equal((await change('RECONNECT',4,{secret})).revision,5);
  assert.deepEqual(f.events.map(e=>e.operation),['CONNECT','REPLACE','REWRAP','REVOKE','RECONNECT']);
  assert.equal(JSON.stringify(f.events).includes(secret),false);
  assert.ok(f.events.every(e=>!Object.hasOwn(e,'envelope')));
  assert.equal(typeof f.vault.decrypt,'undefined');
});
test('permission checks before reads and mutation, late suppression, bounded strict inputs',async()=>{
  const f=fixture();f.deny();
  await assert.rejects(f.vault.change(scope,{operation:'CONNECT',providerId,expectedRevision:0,secret}),{code:'CREDENTIAL_FORBIDDEN'});
  assert.equal(f.counts().reads,0);
  const a=fixture();a.hook(n=>{if(n===2)a.deny();});
  await assert.rejects(a.vault.change(scope,{operation:'CONNECT',providerId,expectedRevision:0,secret}),{code:'CREDENTIAL_FORBIDDEN'});
  assert.equal(a.counts().commits,0);
  const b=fixture();b.hook(n=>{if(n===3)b.deny();});
  await assert.rejects(b.vault.change(scope,{operation:'CONNECT',providerId,expectedRevision:0,secret}),{code:'CREDENTIAL_FORBIDDEN'});
  assert.equal(b.counts().commits,1);
  const c=fixture();
  for(const input of [{providerId:'custom'},{secret:'line\nbreak'},{secret:'x'.repeat(4097)},{endpoint:'https://bad.invalid'},{expectedRevision:1}]){
    await assert.rejects(c.vault.change(scope,{operation:'CONNECT',providerId,expectedRevision:0,secret,...input}),{code:'CREDENTIAL_REQUEST_INVALID'});
  }
  assert.equal(c.counts().reads,0);
});
test('concurrent replacement has a single revision winner; no duplicate audit',async()=>{
  const f=fixture();await f.vault.change(scope,{operation:'CONNECT',providerId,expectedRevision:0,secret});
  const input={operation:'REPLACE',providerId,expectedRevision:1,secret:'replacement'};
  const res=await Promise.allSettled([f.vault.change(scope,input),f.vault.change(scope,input)]);
  assert.equal(res.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(res.find(x=>x.status==='rejected').reason.code,'CREDENTIAL_CONFLICT');
  assert.equal(f.events.length,2);
});
