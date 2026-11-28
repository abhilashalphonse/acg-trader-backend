'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {answerPrefix,readWorkspaceProviderStream}=require('../src/modules/ai/providers/workspace-provider-stream');
const d={modelId:'fixture-model',maxInputTokens:32768,maxOutputTokens:2048};
const event=(choices,usage=null,extra={})=>'data: '+JSON.stringify({id:'fixture-1',model:d.modelId,object:'chat.completion.chunk',choices,usage,...extra})+'\n\n';
const first=event([{index:0,finish_reason:null,delta:{role:'assistant',content:'{"answer":"Hello '}}]);
const next=event([{index:0,finish_reason:null,delta:{content:'world."}'}}]);
const finish=event([{index:0,finish_reason:'stop',delta:{}}]);
const usage=event([],{prompt_tokens:1000,completion_tokens:40,total_tokens:1040});
const done='data: [DONE]\n\n';
const chunks=async function*(s){const b=Buffer.from(s);for(let i=0;i<b.length;i+=7)yield b.subarray(i,i+7);};
test('partial answer extraction never exposes JSON framing or unfinished escapes',()=>{
 assert.equal(answerPrefix('{"ans'),'');
 assert.equal(answerPrefix('{"answer":"hello\\'),'hello');
 assert.equal(answerPrefix('{"answer":"hello\\uD83D'),'hello');
 assert.equal(answerPrefix('{"answer":"hello\\uD83D\\uDE00"}'),'hello😀');
 assert.equal(answerPrefix('{"answer":"hello\\nworld"}'),'hello\nworld');
});
test('provider streaming extracts ordered assistant text and settles from final usage',async()=>{
 const deltas=[];
 const raw=await readWorkspaceProviderStream(chunks(first+next+finish+usage+done),{descriptor:d,timeoutMs:2000,onDelta:async text=>{await Promise.resolve();deltas.push(text);}});
 assert.deepEqual(deltas,['Hello ','world.']);
 assert.equal(JSON.parse(raw.choices[0].message.content).answer,deltas.join(''));
 assert.equal(raw.id,'fixture-1');assert.equal(raw.usage.total_tokens,1040);
});
test('rejects missing usage, missing DONE, identity changes, tools, over-budget and replayed events',async()=>{
 for(const input of [first+next+finish+done,first+next+finish+usage,
 first+event([{index:0,delta:{content:'bad'}}],null,{id:'other'})+finish+usage+done,
 first+event([{index:0,delta:{tool_calls:[{}]}}])+finish+usage+done,
 first+next+finish+event([],{prompt_tokens:32769,completion_tokens:40,total_tokens:32809})+done,
 first+next+finish+usage+done+next]){
   await assert.rejects(readWorkspaceProviderStream(chunks(input),{descriptor:d,timeoutMs:2000,onDelta:async()=>{}}));
 }
});
test('authorization callback denial aborts further delivery',async()=>{
 let n=0;
 await assert.rejects(readWorkspaceProviderStream(chunks(first+next+finish+usage+done),{descriptor:d,timeoutMs:2000,onDelta:async()=>{n++;throw Error('denied');}}));
 assert.equal(n,1);
});
