'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {requestCap,validateCaps}=require('../src/modules/ai/providers/funded-staff-request-cap');
const now=1795836600000;
const approved={ACG_AI_FUNDED_STAFF_DAILY_REQUEST_LIMIT:'100',ACG_AI_FUNDED_STAFF_REQUEST_LIMIT_EXPIRES_AT_MS:String(now+3600000)};
test('default is unchanged; 100 only in explicitly authorized bounded workspace mode',()=>{
 assert.deepEqual(requestCap({},true,now),{dailyRequests:20,expiresAtMs:null});
 assert.deepEqual(requestCap(approved,true,now),{dailyRequests:100,expiresAtMs:now+3600000});
 for(const env of [{...approved,ACG_AI_FUNDED_STAFF_DAILY_REQUEST_LIMIT:'101'},
    {...approved,ACG_AI_FUNDED_STAFF_REQUEST_LIMIT_EXPIRES_AT_MS:String(now)},
    {...approved,ACG_AI_FUNDED_STAFF_REQUEST_LIMIT_EXPIRES_AT_MS:String(now+86400001)},
    {ACG_AI_FUNDED_STAFF_DAILY_REQUEST_LIMIT:'100'}])assert.throws(()=>requestCap(env,true,now));
 assert.throws(()=>requestCap(approved,false,now));
});
test('exact matching request ceilings and unchanged monetary/concurrency safeguards required',()=>{
 const p={enabled:true,dailyPicoUsd:1e12,dailyRequests:100,maxOutstandingRequests:1,maxOutstandingPicoUsd:1e12};
 const t={enabled:true,tenantDailyPicoUsd:1e12,actorDailyPicoUsd:1e12,tenantDailyRequests:100,actorDailyRequests:100};
 assert.equal(validateCaps(p,t,100),true);
 assert.equal(validateCaps(p,t,20),false);
 assert.equal(validateCaps({...p,maxOutstandingRequests:2},t,100),false);
 assert.equal(validateCaps({...p,dailyPicoUsd:2e12},t,100),false);
 assert.equal(validateCaps(p,{...t,actorDailyPicoUsd:2e12},100),false);
});
