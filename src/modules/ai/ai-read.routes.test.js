'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAiReadRouter } = require('./ai-read.routes');
const { AppError } = require('../../shared/errors/app-error');
const accountId='a'.repeat(24);
const connectionId='c74d81e8-b44a-4b4a-8fd2-4c6333474a2b';
test('HTTP boundary authenticates, rejects untrusted fields and reauthenticates on dispatch',async()=>{
  let authCalls=0, dispatchCalls=0;
  const principal={sessionId:'session1'};
  const authService={async authenticateSessionToken(token){
    authCalls++;
    if(token!=='trusted') throw new AppError('Unauthorized',{statusCode:401,code:'INVALID_TOKEN'});
    return principal;
  }};
  const gateway={async invoke(p,q,reauth){
    dispatchCalls++;assert.equal(p,principal);
    assert.equal(await reauth(),principal);
    return {toolId:q.toolId};
  }};
  const app=express();app.use(express.json());app.use('/v1/ai/read',createAiReadRouter({authService,gateway}));
  app.use((err,_req,res,_next)=>res.status(err.statusCode||500).json({code:err.code}));
  const server=app.listen(0,'127.0.0.1');
  try{
    await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    const url='http://127.0.0.1:'+server.address().port+'/v1/ai/read/invoke';
    const data={accountId,connectionId,toolId:'account.valuation.read',args:{}};
    const send=(body,token)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    assert.equal((await send(data)).status,401);
    assert.equal((await send(data,'bad')).status,401);
    assert.equal((await send({...data,tenantId:'victim'},'trusted')).status,400);
    assert.equal((await send({...data,channel:'EXTERNAL'},'trusted')).status,400);
    assert.equal(dispatchCalls,0);
    const before=authCalls;const result=await send(data,'trusted');
    assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
    assert.equal(authCalls-before,2);assert.equal(dispatchCalls,1);
    assert.deepEqual(await result.json(),{toolId:data.toolId});
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
