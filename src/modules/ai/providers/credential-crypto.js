'use strict';
const {randomBytes,createCipheriv,createDecipheriv}=require('node:crypto');
const {z}=require('zod');
const VERSION='aes-256-gcm-envelope-v1';
const keyIdSchema=z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const b64=(max)=>z.string().min(1).max(max).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const boxSchema=z.object({iv:b64(16),tag:b64(24),ciphertext:b64(5500)}).strict();
const envelopeSchema=z.object({version:z.literal(VERSION),keyId:keyIdSchema,wrappedKey:boxSchema,secret:boxSchema}).strict();
function fail(){throw Object.assign(Error('Credential cryptography unavailable'),{code:'CREDENTIAL_CRYPTO_FAILED'});}
const bytes=value=>Buffer.from(JSON.stringify(value),'utf8');
function decoded(value,size){
  const b=Buffer.from(value,'base64');
  if(b.toString('base64')!==value||(size!==undefined&&b.length!==size))fail();
  return b;
}
function aad(binding,purpose,keyId=null){
  if(!binding||!['tenantId','actorId'].every(k=>typeof binding[k]==='string'&&/^[a-f0-9]{24}$/.test(binding[k]))||
     typeof binding.connectionId!=='string'||!/^[a-f0-9]{64}$/.test(binding.connectionId)||
     typeof binding.generation!=='string'||!/^[a-f0-9-]{36}$/.test(binding.generation)||
     !['openai','anthropic','gemini','deepseek','openrouter'].includes(binding.providerId))fail();
  return bytes([VERSION,purpose,binding.tenantId,binding.actorId,binding.connectionId,binding.providerId,binding.generation,keyId]);
}
function seal(key,plain,associated){
  const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);
  c.setAAD(associated);
  const ciphertext=Buffer.concat([c.update(plain),c.final()]);
  return {iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}
function open(key,box,associated,size){
  const iv=decoded(box.iv,12),tag=decoded(box.tag,16),ciphertext=decoded(box.ciphertext,size);
  const d=createDecipheriv('aes-256-gcm',key,iv);d.setAAD(associated);d.setAuthTag(tag);
  let partial;
  try{partial=d.update(ciphertext);return Buffer.concat([partial,d.final()]);}
  finally{partial?.fill(0);}
}
// Keyring is injected by trusted infrastructure. No env reader, defaults,
// production key material, network/KMS calls or credential logging.
function createEnvelopeCrypto({keys,activeKeyId}={}){
  if(!Array.isArray(keys)||keys.length<1||keys.length>8||!keyIdSchema.safeParse(activeKeyId).success)fail();
  const ring=new Map();
  for(const item of keys){
    if(!keyIdSchema.safeParse(item?.id).success||!Buffer.isBuffer(item.key)||item.key.length!==32||ring.has(item.id))fail();
    ring.set(item.id,Buffer.from(item.key));
  }
  if(!ring.has(activeKeyId))fail();
  function parse(envelope){const p=envelopeSchema.safeParse(envelope);if(!p.success)fail();return p.data;}
  function unwrap(e,binding){
    const key=ring.get(e.keyId);if(!key)fail();
    return open(key,e.wrappedKey,aad(binding,'WRAP',e.keyId),32);
  }
  return Object.freeze({
    activeKeyId,
    encrypt(secret,binding){
      if(!Buffer.isBuffer(secret)||secret.length<1||secret.length>4096)fail();
      const dek=randomBytes(32);
      try{return {version:VERSION,keyId:activeKeyId,wrappedKey:seal(ring.get(activeKeyId),dek,aad(binding,'WRAP',activeKeyId)),
        secret:seal(dek,secret,aad(binding,'SECRET'))};}
      catch{fail();}finally{dek.fill(0);}
    },
    // Infrastructure-only primitive. Vault service exposes no decrypt method.
    decrypt(envelope,binding){
      let dek;
      try{const e=parse(envelope);dek=unwrap(e,binding);return open(dek,e.secret,aad(binding,'SECRET'));}
      catch{fail();}finally{dek?.fill(0);}
    },
    rewrap(envelope,binding){
      let dek,plain;
      try{
        const e=parse(envelope);dek=unwrap(e,binding);
        // Authenticate the payload as well, before claiming a successful rotation.
        plain=open(dek,e.secret,aad(binding,'SECRET'));
        return {version:VERSION,keyId:activeKeyId,wrappedKey:seal(ring.get(activeKeyId),dek,aad(binding,'WRAP',activeKeyId)),secret:e.secret};
      }catch{fail();}finally{dek?.fill(0);plain?.fill(0);}
    },
  });
}
module.exports={createEnvelopeCrypto,envelopeSchema,VERSION};
