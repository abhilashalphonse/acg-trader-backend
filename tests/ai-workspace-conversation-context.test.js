'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compactWorkspaceHistory,dropOldestExchange,protectedTailSize,HISTORY_TARGET_BYTES}=require('../src/modules/ai/intelligence/workspace-conversation-context');
const {buildWorkspaceBody}=require('../src/modules/ai/providers/funded-workspace-context');
const turn=(user,assistant)=>[{role:'user',text:user},{role:'assistant',text:assistant}];
test('short history preserves exact dialogue, including financial numbers and multilingual text',()=>{
 const h=[...turn('What was the level?','XAUUSD 2712.34567'),...turn('അടുത്ത ലെവൽ?', 'Wait for the 5m close.')];
 assert.deepEqual(compactWorkspaceHistory(h),h);
 assert.notEqual(compactWorkspaceHistory(h),h);
});
test('older complete turns are removed when exceeding the soft history budget',()=>{
 const h=[...turn('Review the old chart','a'.repeat(3500)),...turn('Review the second chart','b'.repeat(3500)),...turn('Check 2712.34567','Retest 2712.34567, invalidation 2714.1')];
 const original=structuredClone(h),result=compactWorkspaceHistory(h);
 assert.deepEqual(result,h.slice(2));
 assert.ok(Buffer.byteLength(JSON.stringify(result),'utf8')<=HISTORY_TARGET_BYTES);
 assert.deepEqual(h,original);
 assert.equal(protectedTailSize(result),2);
});
test('latest complete exchange is never truncated to satisfy a soft target',()=>{
 const h=turn('x'.repeat(3800),'y'.repeat(3800));
 assert.deepEqual(compactWorkspaceHistory(h),h);
 const prefix=[{role:'assistant',text:'orphan'},...h];
 assert.deepEqual(compactWorkspaceHistory(prefix),h);
 assert.equal(dropOldestExchange(prefix),true);
 assert.deepEqual(prefix,h);
 assert.equal(dropOldestExchange(prefix),true);
 assert.deepEqual(prefix,[]);
 assert.equal(dropOldestExchange(prefix),false);
});
test('wire body preserves latest exact context and keeps history untrusted',()=>{
 const history=[...turn('Old question','a'.repeat(3500)),...turn('Older question','b'.repeat(3500)),...turn('What is the invalidation?','2714.1 conditional')];
 const body=buildWorkspaceBody({modelId:'fixture',maxInputTokens:32768,maxOutputTokens:2048},{question:'What about that level?',history,market:null,account:null});
 const data=JSON.parse(body.messages[1].content);
 assert.deepEqual(data.history,history.slice(2));
 assert.match(body.messages[0].content,/Revalidate prior market conclusions and account values/);
 assert.match(body.messages[0].content,/not complete memory/);
 assert.deepEqual(Object.keys(data).sort(),['account','history','knowledge','market','question']);
});
