'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {publicIPv4,makeBody,parseResponse,runApprovedSmoke,MODEL,APPROVAL}=require('./openai-live-smoke');
const reference='a'.repeat(64);
test('public OpenAI smoke excludes private, reserved and non-IPv4 destinations',()=>{
  for(const v of ['127.0.0.1','10.1.2.3','172.31.0.1','192.168.1.1','169.254.169.254','100.64.0.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.1.1.1','255.255.255.255','::1','::ffff:8.8.8.8','invalid'])
    assert.equal(publicIPv4(v),false,v);
  assert.equal(publicIPv4('8.8.8.8'),true);
});
test('fixed synthetic request, pinned model and output cap; no exported internal catalog or context',()=>{
  const b=makeBody(reference);
  assert.equal(b.model,MODEL);assert.equal(b.store,false);assert.equal(b.stream,false);assert.equal(b.max_completion_tokens,512);
  const raw=JSON.stringify(b);assert.ok(raw.includes(reference));assert.ok(!raw.includes('tenantId'));assert.ok(!raw.includes('ACG_INTERNAL_ORIGINAL'));assert.ok(!Object.hasOwn(b,'tools'));
  assert.throws(()=>makeBody('bad'),{code:'SMOKE_INVALID_REFERENCE'});
});
test('actual response parser requires pinned model, complete candidate and bounded usage',()=>{
  const raw={model:MODEL,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'{}'}}],
    usage:{prompt_tokens:123,completion_tokens:22,total_tokens:145}};
  assert.deepEqual(parseResponse(raw),{candidate:'{}',inputTokens:123,outputTokens:22});
  for(const modify of [v=>v.model='other',v=>v.choices[0].finish_reason='length',v=>v.choices[0].message.tool_calls=[{}],v=>v.usage.total_tokens=0,v=>{v.usage={prompt_tokens:9000,completion_tokens:1,total_tokens:9001};}]){
    const v=structuredClone(raw);modify(v);assert.throws(()=>parseResponse(v));
  }
});
test('normal test environment cannot claim or dispatch actual paid smoke',async()=>{
  let claimed=false;
  await assert.rejects(runApprovedSmoke({approval:APPROVAL,key:Buffer.alloc(32,65),claim:async()=>{claimed=true;},finish:async()=>{}}),{code:'SMOKE_DISABLED'});
  assert.equal(claimed,false);
});
