'use strict';
const {z}=require('zod');
const {randomUUID}=require('node:crypto');
const {digest,freeze}=require('../intelligence/candle-evidence');
const {envelopeSchema}=require('./credential-crypto');
const id=z.string().regex(/^[a-f0-9]{24}$/);
const scopeSchema=z.object({tenantId:id,actorId:id,sessionId:id}).strict();
const provider=z.enum(['openai','anthropic','gemini','deepseek','openrouter']);
const revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER-1);
const secret=z.string().min(1).max(4096).regex(/^[!-~]+$/);
const changeSchema=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('CONNECT'),providerId:provider,expectedRevision:z.literal(0),secret}).strict(),
  z.object({operation:z.literal('REPLACE'),providerId:provider,expectedRevision:revision,secret}).strict(),
  z.object({operation:z.literal('RECONNECT'),providerId:provider,expectedRevision:revision,secret}).strict(),
  z.object({operation:z.literal('REVOKE'),providerId:provider,expectedRevision:revision}).strict(),
  z.object({operation:z.literal('REWRAP'),providerId:provider,expectedRevision:revision}).strict(),
]);
function fail(code){throw Object.assign(Error('Credential operation unavailable'),{code});}
function parse(schema,value){
  const p=schema.safeParse(value);if(!p.success)fail('CREDENTIAL_REQUEST_INVALID');return p.data;
}
function connectionId(scope,providerId){return digest([scope.tenantId,scope.actorId,providerId]);}
function binding(doc){return {tenantId:doc.tenantId,actorId:doc.actorId,providerId:doc.providerId,connectionId:doc._id,generation:doc.generation};}
function metadata(doc){
  return freeze({connectionId:doc._id,providerId:doc.providerId,revision:doc.revision,status:doc.status,
    changedAt:new Date(doc.changedAt).toISOString(),revokedAt:doc.revokedAt?new Date(doc.revokedAt).toISOString():null,
    runtimeEnabled:false,providerVerified:false});
}
// Internal, unmounted vault. The caller must bind authorize to a current
// authenticated identity and action-specific permissions; no default policy.
// Revocation should remain independently possible when inference is disabled.
function createCredentialVault({store,crypto,authorize,now=Date.now}={}){
  if(!store||!['list','get','commit'].every(k=>typeof store[k]==='function')||
    !crypto||!['encrypt','rewrap'].every(k=>typeof crypto[k]==='function')||
    typeof authorize!=='function')fail('CREDENTIAL_VAULT_CONFIG_INVALID');
  async function check(request){
    let allowed=false;try{allowed=await authorize(request)===true;}catch{}
    if(!allowed)fail('CREDENTIAL_FORBIDDEN');
  }
  async function read(work){
    try{return await work();}catch(e){
      if(e?.code==='CREDENTIAL_CONFLICT')fail('CREDENTIAL_CONFLICT');fail('CREDENTIAL_STORE_FAILED');
    }
  }
  return Object.freeze({
    async list(scopeInput){
      const scope=freeze(parse(scopeSchema,scopeInput));
      const request=freeze({scope,operation:'LIST'});
      await check(request);
      const rows=await read(()=>store.list(scope));
      if(!Array.isArray(rows)||rows.length>5||rows.some(d=>d.tenantId!==scope.tenantId||d.actorId!==scope.actorId||
        !provider.safeParse(d.providerId).success||d._id!==connectionId(scope,d.providerId)))fail('CREDENTIAL_STORE_SCOPE_MISMATCH');
      const result=freeze(rows.map(metadata));
      await check(request);
      return result;
    },
    async change(scopeInput,input){
      const scope=freeze(parse(scopeSchema,scopeInput)),change=parse(changeSchema,input);
      const {operation,providerId,expectedRevision}=change;
      const key=connectionId(scope,providerId);
      // Neither credentials nor ciphertext are supplied to authorization.
      const request=freeze({scope,operation,providerId,connectionId:key,expectedRevision});
      await check(request);
      const previous=await read(()=>store.get(scope,key,operation==='REWRAP'));
      if(previous&&(previous._id!==key||previous.tenantId!==scope.tenantId||previous.actorId!==scope.actorId||
        previous.providerId!==providerId||!revision.safeParse(previous.revision).success||
        !['STORED_UNVERIFIED','REVOKED'].includes(previous.status)))fail('CREDENTIAL_STORE_SCOPE_MISMATCH');
      if((previous?.revision??0)!==expectedRevision)fail('CREDENTIAL_CONFLICT');
      if(operation==='CONNECT'&&previous!==null||
        operation==='RECONNECT'&&previous?.status!=='REVOKED'||
        ['REPLACE','REVOKE','REWRAP'].includes(operation)&&previous?.status!=='STORED_UNVERIFIED')fail('CREDENTIAL_STATE_INVALID');
      const t=now();if(!Number.isSafeInteger(t)||t<=0||t>=8640000000000000)fail('CREDENTIAL_CLOCK_INVALID');
      const next={_id:key,tenantId:scope.tenantId,actorId:scope.actorId,providerId,revision:expectedRevision+1,
        status:operation==='REVOKE'?'REVOKED':'STORED_UNVERIFIED',
        generation:['CONNECT','RECONNECT','REPLACE'].includes(operation)?randomUUID():previous.generation,
        envelope:null,changedAt:new Date(t),revokedAt:operation==='REVOKE'?new Date(t):null};
      let temporary;
      try{
        if(['CONNECT','RECONNECT','REPLACE'].includes(operation)){
          temporary=Buffer.from(change.secret,'utf8');next.envelope=crypto.encrypt(temporary,binding(next));
        }else if(operation==='REWRAP'){
          next.envelope=crypto.rewrap(previous.envelope,binding(next));
        }
        if(operation!=='REVOKE'&&!envelopeSchema.safeParse(next.envelope).success)fail('CREDENTIAL_CRYPTO_FAILED');
      }catch{fail('CREDENTIAL_CRYPTO_FAILED');}finally{temporary?.fill(0);delete change.secret;}
      const event={_id:randomUUID(),tenantId:scope.tenantId,actorId:scope.actorId,sessionId:scope.sessionId,
        connectionId:key,providerId,revision:next.revision,operation,occurredAt:new Date(t)};
      await check(request);
      await read(()=>store.commit({scope,previous,next,event}));
      // A successful commit may outlive a permission change during the DB
      // transaction. Suppress response on a late denial; reconcile via list.
      await check(request);
      return metadata(next);
    },
  });
}
module.exports={createCredentialVault,connectionId};
