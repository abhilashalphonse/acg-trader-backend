'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAiQuota}=require('./ai-quota');
test('user quota shares buckets across sessions and gateway instances',async()=>{
  let now=120000;
  const counts=new Map();
  const store={async consume({key,limit,expiresAt}){
    assert.match(key,/^[a-f0-9]{64}$/);assert.ok(expiresAt.getTime()>now);
    const count=counts.get(key)||0;if(count>=limit)return false;counts.set(key,count+1);return true;
  }};
  const a=createAiQuota({store,now:()=>now,limit:2}),b=createAiQuota({store,now:()=>now,limit:2});
  const p={tenantId:'a'.repeat(24),userId:'b'.repeat(24),sessionId:'one'};
  await a.consume(p);await b.consume({...p,sessionId:'two'});
  await assert.rejects(a.consume(p),{code:'AI_QUOTA_EXCEEDED'});
  await a.consume({...p,userId:'c'.repeat(24)});
  await a.consume({...p,tenantId:'d'.repeat(24)});
  now+=60000;await b.consume(p);
});
test('quota storage outage or invalid principal fails closed',async()=>{
  const q=createAiQuota({store:{async consume(){throw Error('private');}}});
  await assert.rejects(q.consume({tenantId:'a'.repeat(24),userId:'b'.repeat(24)}),{code:'AI_QUOTA_UNAVAILABLE'});
  await assert.rejects(q.consume({tenantId:'invalid'}),{code:'AI_IDENTITY_UNAVAILABLE'});
});
