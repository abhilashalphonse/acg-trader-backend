'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {gzipSync}=require('node:zlib');
const {validateInput,aiJsonBoundary,aiSafeError,createConcurrencyGate}=require('./ai-http-security');
test('input complexity and prototype/operator keys are rejected',()=>{
  for(const value of [JSON.parse('{"__proto__":{"polluted":true}}'),{nested:{constructor:1}},{args:{$where:'x'}},{'a.b':1}])
    assert.throws(()=>validateInput(value),{code:'AI_INVALID_INPUT'});
  for(const value of [{x:'a'.repeat(513)},Array(17).fill(0),{a:{b:{c:{d:{e:{f:1}}}}}}])
    assert.throws(()=>validateInput(value),{code:'AI_INPUT_TOO_COMPLEX'});
  assert.doesNotThrow(()=>validateInput({accountId:'a'.repeat(24),args:{limit:20}}));
});
test('concurrency cap releases capacity after completion and failure',async()=>{
  const run=createConcurrencyGate(1);
  let finish;
  const first=run(()=>new Promise(resolve=>{finish=resolve;}));
  await assert.rejects(run(()=>assert.fail('must not run')),{code:'AI_BUSY'});
  finish();await first;
  await assert.rejects(run(()=>{throw Error('failure');}));
  assert.equal(await run(()=>7),7);
});
test('AI HTTP boundary rejects oversized, compressed and invalid payloads without leaking error content',async()=>{
  const app=express();
  app.use('/ai',aiJsonBoundary());
  app.use(express.json({limit:'512kb'}));
  let calls=0;
  app.post('/ai',(_req,res)=>{calls++;res.json({ok:true});});
  app.get('/ai/error',()=>{throw Error('SECRET_INTERNAL_DETAIL');});
  app.use('/ai',aiSafeError);
  const server=app.listen(0,'127.0.0.1');
  try{
    await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    const root='http://127.0.0.1:'+server.address().port+'/ai';
    const send=(body,extra={})=>fetch(root,{method:'POST',headers:{'content-type':'application/json',...extra},body});
    assert.equal((await send(JSON.stringify({x:'a'.repeat(9000)}))).status,413);
    assert.equal((await send(gzipSync('{}'),{'content-encoding':'gzip'})).status,415);
    assert.equal((await send('{"__proto__":{"x":1}}')).status,400);
    assert.equal((await send('SECRET_BAD_JSON')).status,400);
    assert.equal((await send('{}',{'content-type':'text/plain'})).status,415);
    assert.equal(calls,0);
    const ok=await send('{"args":{}}');assert.equal(ok.status,200);assert.equal(calls,1);
    const error=await fetch(root+'/error');
    assert.equal(error.status,500);assert.doesNotMatch(await error.text(),/SECRET_INTERNAL_DETAIL/);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
