'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { AuthService, hashToken } = require('../../src/modules/auth/auth.service');
const { createAccountControlRouter } = require('../../src/modules/trading/account-control.routes');
const { createAccountLedgerRouter } = require('../../src/modules/accounts/account-ledger.routes');
const { errorHandler } = require('../../src/shared/http/error-middleware');

test('read-only partner credentials cannot mutate or read another tenant account', async () => {
  const tenantId = '64a000000000000000000001';
  const own = '64b000000000000000000001', foreign = '64b000000000000000000002';
  const records = {
    reader: { clientId:'reader', keyHash:hashToken('reader-token'), tenantId, scopes:['accounts:read','ledger:read'] },
    legacy: { clientId:'legacy', keyHash:hashToken('legacy-token'), tenantId, scopes:['accounts:write'] },
  };
  const authService = new AuthService({
    serviceApiKeyModel: { findOne:async q=>records[q.clientId], updateOne:async()=>({}) },
    tenantModel: { findOne:()=>({lean:async()=>({slug:'tenant-a'})}) },
  });
  const queries = [];
  let writes=0;
  const runtime = {enabled:true,accountControlService:{
    accountModel:{findOne(q){queries.push(q);return {select(){return {lean:async()=>q.tenantId===tenantId&&q._id===own?{_id:own}:null};}};}},
    getById:async id=>({id}), pause:async()=>{writes++;return{};},
  },accountLedgerService:{list:async()=>[],mutate:async()=>{writes++;return{};}}};
  const app=express();app.use(express.json());
  app.use('/accounts/:accountId/ledger',createAccountLedgerRouter(runtime,authService));
  app.use('/accounts',createAccountControlRouter(runtime,authService));app.use(errorHandler);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port+'/accounts/';
  const headers={Authorization:'Bearer reader-token','x-acg-client-id':'reader','Content-Type':'application/json'};
  try {
    assert.equal((await fetch(base+own,{headers})).status,200);
    assert.equal((await fetch(base+foreign,{headers})).status,404);
    assert.equal((await fetch(base+own+'/ledger',{headers})).status,200);
    assert.equal((await fetch(base+foreign+'/ledger',{headers})).status,404);
    assert.equal((await fetch(base+own+'/pause',{method:'POST',headers,body:'{}'})).status,403);
    assert.equal((await fetch(base+own+'/ledger',{method:'POST',headers,body:'{}'})).status,403);
    assert.equal((await fetch(base+own+'/admin-observability',{headers})).status,403);
    assert.equal((await fetch(base+own+'/ADMIN-OBSERVABILITY/',{headers})).status,403);
    assert.equal(writes,0);
    assert.ok(queries.every(q=>q.tenantId===tenantId));
    const legacy={...headers,Authorization:'Bearer legacy-token','x-acg-client-id':'legacy'};
    assert.equal((await fetch(base+own,{headers:legacy})).status,200);
    assert.equal((await fetch(base+own+'/pause',{method:'POST',headers:legacy,body:'{}'})).status,200);
    assert.equal(writes,1);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
