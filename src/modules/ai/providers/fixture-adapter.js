'use strict';
const {normalizeOfflineOutcome,CONTRACT_VERSION}=require('./provider-contract');
const {freeze}=require('../intelligence/candle-evidence');
// Concrete reference implementation of the future one-shot adapter method.
// No SDK, fetch, credentials, network, callback or provider-specific wire data.
// Only offline fixtures. Streaming and cancellation transport follow in 3C/3D.
function createFixtureAdapter({providerId,modelId,fixture}={}){
  if(typeof providerId!=='string'||typeof modelId!=='string'||!fixture||typeof fixture!=='object')
    throw Error('Invalid offline fixture');
  const pinned=freeze(structuredClone(fixture));
  return Object.freeze({
    contractVersion:CONTRACT_VERSION,providerId,modelId,executionMode:'OFFLINE_TEST_ONLY',
    async generate(request){
      if(request?.contractVersion!==CONTRACT_VERSION||request.executionMode!=='OFFLINE_TEST_ONLY'||
         request.providerId!==providerId||request.modelId!==modelId)
        throw Object.assign(Error('Adapter binding mismatch'),{code:'ADAPTER_BINDING_MISMATCH'});
      return normalizeOfflineOutcome(request,{...pinned,requestId:request.requestId,
        providerId,modelId,descriptorId:request.descriptorId});
    },
  });
}
module.exports={createFixtureAdapter};
