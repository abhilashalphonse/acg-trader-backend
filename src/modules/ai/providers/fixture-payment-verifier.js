'use strict';
const {createHmac,timingSafeEqual}=require('node:crypto');
const {z}=require('zod');
const {digest,freeze}=require('../intelligence/candle-evidence');
const {assertIsolated}=require('./credit-ledger-store');
const uuid=z.uuid().refine(v=>v===v.toLowerCase());
const schema=z.object({eventId:uuid,purchaseId:uuid,paymentId:z.string().regex(/^[A-Za-z0-9_-]{1,96}$/),
  type:z.enum(['CAPTURED','REFUNDED','CHARGEBACK']),currency:z.literal('USD'),
  amountMinor:z.string().regex(/^[1-9][0-9]{0,11}$/)}).strict();
function fail(code){throw Object.assign(Error('Payment event rejected'),{code});}
// Synthetic protocol only. Not a real provider signature scheme.
// Signature covers exact raw bytes and timestamp, with a dedicated injected key.
// REFUNDED/CHARGEBACK amount is cumulative confirmed reversal, never a delta.
function createFixturePaymentVerifier({secret,now=Date.now}={}){
  assertIsolated();
  if(!Buffer.isBuffer(secret)||secret.length!==32||typeof now!=='function')fail('CREDIT_PAYMENT_CONFIG_INVALID');
  const key=Buffer.from(secret);
  return Object.freeze({verify({rawBody,timestamp,signature}={}){
    assertIsolated();
    const at=now();
    if(!Buffer.isBuffer(rawBody)||rawBody.length<1||rawBody.length>4096||
      typeof timestamp!=='string'||!/^[1-9][0-9]{0,15}$/.test(timestamp)||
      typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||
      !Number.isSafeInteger(at)||!Number.isSafeInteger(Number(timestamp))||
      Math.abs(at-Number(timestamp))>300000)fail('CREDIT_PAYMENT_SIGNATURE_INVALID');
    const expected=createHmac('sha256',key).update(timestamp+'.').update(rawBody).digest();
    if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))fail('CREDIT_PAYMENT_SIGNATURE_INVALID');
    let parsed;try{parsed=schema.safeParse(JSON.parse(rawBody.toString('utf8')));}catch{fail('CREDIT_PAYMENT_EVENT_INVALID');}
    // Canonical synthetic JSON excludes ambiguous duplicate keys/encoding.
    if(!parsed.success||!rawBody.equals(Buffer.from(JSON.stringify(parsed.data),'utf8')))fail('CREDIT_PAYMENT_EVENT_INVALID');
    return freeze({...parsed.data,payloadDigest:digest(parsed.data)});
  }});
}
module.exports={createFixturePaymentVerifier};
