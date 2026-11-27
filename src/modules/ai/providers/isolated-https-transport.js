'use strict';
const https=require('node:https');
const {performance}=require('node:perf_hooks');
const {assertIsolated}=require('./credit-ledger-store');
const {buildWireRequest}=require('./provider-wire');
const {normalizeFixtureResponse}=require('./provider-response');
const {normalizeOfflineOutcome,CONTRACT_VERSION}=require('./provider-contract');
const fail=code=>Object.assign(Error('Provider transport unavailable'),{code});
// Real TLS/HTTP mechanics, isolated rehearsal only. No arbitrary URL or DNS,
// no redirects, proxy, decompression, retry, fallback or public network.
// The provider-specific path is taken from the server-owned wire builder.
function createIsolatedHttpsTransport({port,ca,now=Date.now}={}){
  assertIsolated();
  if(!Number.isInteger(port)||port<1||port>65535||!Buffer.isBuffer(ca)||!ca.length||ca.length>65536)throw fail('TRANSPORT_CONFIG_INVALID');
  const trustedCa=Buffer.from(ca);
  return Object.freeze({
    async exchange(q,secret,{signal,timeoutMs=3000,beforeWrite=null}={}){
      assertIsolated();
      const wire=buildWireRequest(q);
      if(q.fundingMode!=='BYO_API'||!Buffer.isBuffer(secret)||secret.length<1||secret.length>4096||
        !secret.every(v=>v>=33&&v<=126)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)
        throw fail('TRANSPORT_REQUEST_INVALID');
      const base={requestId:q.requestId,providerId:q.providerId,modelId:q.modelId,descriptorId:q.descriptorId};
      const failure=(status,errorCode)=>normalizeOfflineOutcome(q,{...base,status,errorCode,candidate:null,usage:{status:'UNKNOWN'}});
      const at=now(),duration=Math.min(timeoutMs,q.expiresAtMs-at);
      if(signal?.aborted)return failure('CANCELLED','CANCELLED');
      if(!Number.isSafeInteger(at)||at<q.createdAtMs||!Number.isSafeInteger(duration)||duration<=0)return failure('UNKNOWN','TIMEOUT');
      const target=new URL(wire.url);
      const body=Buffer.from(JSON.stringify(wire.body),'utf8');
      if(body.length>131072)throw fail('TRANSPORT_REQUEST_INVALID');
      const headers={...wire.headers,accept:q.request.stream?'text/event-stream':'application/json',
        'accept-encoding':'identity','content-length':body.length};
      // Node's HTTP client requires strings internally; buffer wiping is best
      // effort, not a claim that the runtime erases all copies of a secret.
      const auth=secret.toString('ascii');
      if(wire.authScheme==='BEARER')headers.authorization='Bearer '+auth;
      else if(wire.authScheme==='X_API_KEY')headers['x-api-key']=auth;
      else if(wire.authScheme==='X_GOOG_API_KEY')headers['x-goog-api-key']=auth;
      else throw fail('TRANSPORT_REQUEST_INVALID');
      const controller=new AbortController();
      const onAbort=()=>controller.abort();
      let timedOut=false,request,response;
      const started=performance.now();
      const timer=setTimeout(()=>{timedOut=true;controller.abort();},duration);
      signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted)onAbort();
      try{
        if(beforeWrite!==null){if(typeof beforeWrite!=='function')throw fail('TRANSPORT_CONFIG_INVALID');await beforeWrite();}
        if(controller.signal.aborted||now()>=q.expiresAtMs)return failure('UNKNOWN','TIMEOUT');
        response=await new Promise((resolve,reject)=>{
          request=https.request({hostname:'127.0.0.1',port,method:'POST',path:target.pathname+target.search,
            headers,ca:trustedCa,rejectUnauthorized:true,minVersion:'TLSv1.2',agent:false,signal:controller.signal,
            maxHeaderSize:16384},resolve);
          request.on('error',reject);
          request.end(body);
        });
        // Reject encoded or redirected bodies. Do not read error payloads.
        const status=response.statusCode;
        if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity')
          return failure('FAILED','INVALID_RESPONSE');
        const remaining=Math.max(1,Math.floor(duration-(performance.now()-started)));
        const result=await normalizeFixtureResponse(q,{httpStatus:status,contentType:response.headers['content-type'],
          chunks:response,signal:controller.signal,timeoutMs:remaining,now});
        if(timedOut)return failure('UNKNOWN','TIMEOUT');
        if(signal?.aborted)return failure('CANCELLED','CANCELLED');
        if(status>=300&&status<400)return failure('FAILED','INVALID_RESPONSE');
        return result;
      }catch{
        if(timedOut)return failure('UNKNOWN','TIMEOUT');
        if(signal?.aborted)return failure('CANCELLED','CANCELLED');
        return failure('UNKNOWN','UNAVAILABLE');
      }finally{
        clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
        response?.destroy();request?.destroy();body.fill(0);
        delete headers.authorization;delete headers['x-api-key'];delete headers['x-goog-api-key'];
      }
    },
  });
}
module.exports={createIsolatedHttpsTransport};
