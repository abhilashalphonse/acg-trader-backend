'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const { createAiGovernanceRouter }=require('./ai-governance.routes');
const { AppError }=require('../../shared/errors/app-error');
const tenantId='a'.repeat(24);
test('governance administration requires explicit independent scopes and derives tenant from service identity',async()=>{
  let calls=[];
  const authService={async authenticateServiceKey({apiKey,requiredScope}){
    const scopes=apiKey==='wild'?['*']:apiKey==='write'?['ai:governance:write']:apiKey==='audit'?['ai:audit:read']:apiKey==='read'?['ai:governance:read']:[];
    if(!scopes.includes(requiredScope)&&!scopes.includes('*'))throw new AppError('Forbidden',{statusCode:403});
    return {tenantId,clientId:'client1',scopes};
  }};
  const store={async control(t){calls.push(['read',t]);return{enabled:false,revision:0};},
    async updateControl(x){calls.push(['write',x]);return{enabled:x.enabled,revision:1};},
    async list(t,n){calls.push(['audit',t,n]);return[];}};
  const app=express();app.use(express.json());app.use('/internal',createAiGovernanceRouter({authService,store}));
  app.use((e,_req,res,_next)=>res.status(e.statusCode||500).json({code:e.code}));
  const server=app.listen(0,'127.0.0.1');
  try{
    await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    const root='http://127.0.0.1:'+server.address().port+'/internal';
    const send=(path,token,body)=>fetch(root+path,{method:body?'PATCH':'GET',headers:{authorization:'Bearer '+token,'x-acg-client-id':'client1','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const input={enabled:false,expectedRevision:0,reason:'INCIDENT_RESPONSE'};
    assert.equal((await send('/control','wild',input)).status,403);
    assert.equal((await send('/control','read',input)).status,403);
    assert.equal((await send('/control','write',{...input,tenantId:'b'.repeat(24)})).status,400);
    assert.equal((await send('/audit','write')).status,403);
    assert.equal(calls.length,0);
    assert.equal((await send('/control','read')).status,200);
    assert.equal((await send('/control','write',input)).status,200);
    assert.equal((await send('/audit?limit=10','audit')).status,200);
    assert.equal(calls[1][1].tenantId,tenantId);
    assert.match(calls[1][1].actorId,/^[a-f0-9]{64}$/);
    assert.deepEqual(calls[2],['audit',tenantId,10]);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
