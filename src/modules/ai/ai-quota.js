'use strict';
const crypto=require('crypto');
const { AppError }=require('../../shared/errors/app-error');
const objectId=v=>typeof v==='string'&&/^[a-f0-9]{24}$/.test(v);
function createAiQuota({store,now=Date.now,limit=30,windowMs=60000}) {
  if (!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(windowMs)||windowMs<1000) throw new Error('Invalid AI quota');
  return Object.freeze({
    async consume(principal) {
      if(!objectId(principal?.tenantId)||!objectId(principal?.userId)) throw new AppError('AI identity unavailable',{statusCode:403,code:'AI_IDENTITY_UNAVAILABLE'});
      const at=now();
      if(!Number.isSafeInteger(at)||at<0) throw new AppError('AI quota unavailable',{statusCode:503,code:'AI_QUOTA_UNAVAILABLE'});
      const start=Math.floor(at/windowMs)*windowMs;
      // User-wide, not session-wide: multiple sessions and replicas share this bucket.
      const key=crypto.createHash('sha256').update(JSON.stringify([principal.tenantId,principal.userId,start])).digest('hex');
      let allowed;
      try{allowed=await store.consume({key,limit,expiresAt:new Date(start+windowMs*2)});}
      catch{throw new AppError('AI quota unavailable',{statusCode:503,code:'AI_QUOTA_UNAVAILABLE'});}
      if(allowed!==true) throw new AppError('AI request quota exceeded',{statusCode:429,code:'AI_QUOTA_EXCEEDED'});
    },
  });
}
module.exports={createAiQuota};
