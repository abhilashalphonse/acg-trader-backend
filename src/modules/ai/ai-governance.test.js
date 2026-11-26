'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAiGovernance } = require('./ai-governance');
const { AppError } = require('../../shared/errors/app-error');
const id = x => x.repeat(24);
function fixture() {
  let value={enabled:true,revision:1}, appendFail=null, failControl=false, calls=0;
  const events=[], errors=[];
  const store={
    async control(tenant){assert.equal(tenant,id('1'));if(failControl)throw Error('secret');return {...value};},
    async append(event){if(appendFail===event.stage)throw Error('secret');events.push(event);},
  };
  const g=createAiGovernance({store,logger:{error(...x){errors.push(x);}},now:()=>1700000000000});
  const request={principal:{tenantId:id('1'),userId:id('2'),sessionId:id('3'),token:'secret'},
    requestedAccountId:id('4'),operation:'TOOL_INVOKE',toolId:'account.positions.read',args:{secret:'hidden'}};
  return {g,request,events,errors,pause:()=>{value={enabled:false,revision:2};},
    change:()=>{value={enabled:true,revision:3};}, fail:stage=>{appendFail=stage;}, failControl:()=>{failControl=true;},
    work:async()=>{calls++;return {balance:'secret'};},calls:()=>calls};
}
const rejects=(p,code)=>assert.rejects(p,e=>e.code===code);
test('durable paired audit events exclude credentials, prompt, arguments and results',async()=>{
  const x=fixture();assert.deepEqual(await x.g.run(x.request,x.work),{balance:'secret'});
  assert.deepEqual(x.events.map(e=>e.stage),['ATTEMPT','ALLOWED']);
  assert.equal(x.events[0]._id.split(':')[0],x.events[1]._id.split(':')[0]);
  assert.equal(x.events[0].requestedAccountId,id('4'));
  assert.equal(x.events[1].revision,1);
  assert.doesNotMatch(JSON.stringify(x.events),/secret|hidden|balance|token|args/);
});
test('missing or disabled governance does not execute work',async()=>{
  const x=fixture();x.pause();
  await rejects(x.g.run(x.request,x.work),'AI_GOVERNANCE_PAUSED');
  assert.equal(x.calls(),0);assert.deepEqual(x.events.map(e=>e.stage),['ATTEMPT','DENIED']);
  const y=fixture();y.failControl();
  await rejects(y.g.run(y.request,y.work),'AI_GOVERNANCE_UNAVAILABLE');
  assert.equal(y.calls(),0);
});
test('audit outage prevents new work or disclosure',async()=>{
  const x=fixture();x.fail('ATTEMPT');
  await rejects(x.g.run(x.request,x.work),'AI_GOVERNANCE_UNAVAILABLE');assert.equal(x.calls(),0);
  const y=fixture();y.fail('ALLOWED');
  await rejects(y.g.run(y.request,y.work),'AI_GOVERNANCE_UNAVAILABLE');assert.equal(y.calls(),1);
  assert.deepEqual(y.events.map(e=>e.stage),['ATTEMPT']);
  assert.doesNotMatch(JSON.stringify(y.errors),/secret/);
});
test('pause or revision change during work prevents response',async()=>{
  const x=fixture();await rejects(x.g.run(x.request,async()=>{x.pause();return 'secret';}),'AI_GOVERNANCE_PAUSED');
  assert.equal(x.events[1].stage,'DENIED');
  const y=fixture();await rejects(y.g.run(y.request,async()=>{y.change();return 'secret';}),'AI_GOVERNANCE_CHANGED');
});
test('revocation remains available during pause and audit outage',async()=>{
  const x=fixture();x.pause();x.fail('ATTEMPT');
  assert.deepEqual(await x.g.run({...x.request,operation:'GRANT_REVOKE'},async()=>({revoked:true})),{revoked:true});
  assert.equal(x.events[0].stage,'ALLOWED');
});
test('denied and unexpected errors are recorded without raw input or error messages',async()=>{
  const x=fixture();await rejects(x.g.run({...x.request,toolId:'secret',requestedAccountId:'secret'},
    async()=>{throw new AppError('secret',{code:'AI_FINANCIAL_BOUNDARY_DENIED',statusCode:403});}),'AI_FINANCIAL_BOUNDARY_DENIED');
  assert.equal(x.events[1].reason,'AI_FINANCIAL_BOUNDARY_DENIED');assert.equal(x.events[0].toolId,null);
  const y=fixture();await assert.rejects(y.g.run(y.request,async()=>{throw Error('secret');}));
  assert.equal(y.events[1].reason,'UNCLASSIFIED_ERROR');
  assert.doesNotMatch(JSON.stringify([...x.events,...y.events]),/secret/);
});

test('suspension during completion audit suppresses response and records suppression',async()=>{
  let control={enabled:true,revision:1};
  const events=[];
  const g=createAiGovernance({store:{
    async control(){return control;},
    async append(e){events.push(e);if(e.stage==='ALLOWED')control={enabled:false,revision:2};},
  }});
  const req={principal:{tenantId:id('1')},operation:'TOOL_INVOKE',toolId:'account.positions.read'};
  await rejects(g.run(req,async()=>({sensitive:true})),'AI_GOVERNANCE_PAUSED');
  assert.deepEqual(events.map(e=>e.stage),['ATTEMPT','ALLOWED','SUPPRESSED']);
});
