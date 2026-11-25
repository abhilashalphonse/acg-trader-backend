'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const mongoose=require('mongoose');
const {EventEmitter}=require('node:events');
const {WebSocket}=require('ws');
const {Tenant}=require('../../src/modules/tenancy/tenant.model');
const {TradingAccount}=require('../../src/modules/accounts/trading-account.model');
const {Instrument}=require('../../src/modules/instruments/instrument.model');
const {Order}=require('../../src/modules/trading/order.model');
const {Deal}=require('../../src/modules/trading/deal.model');
const {Position}=require('../../src/modules/trading/position.model');
const {AuthService}=require('../../src/modules/auth/auth.service');
const {ServiceApiKey}=require('../../src/modules/auth/service-api-key.model');
const {AccountControlService}=require('../../src/modules/trading/account-control.service');
const {AccountLedgerService}=require('../../src/modules/accounts/account-ledger.service');
const {MarketOrderService}=require('../../src/modules/trading/market-order.service');
const {TradingHistoryService}=require('../../src/modules/trading/trading-history.service');
const {ValuationEngine}=require('../../src/modules/trading/valuation-engine');
const {PlatformEventRelay,signEnvelope}=require('../../src/modules/integration/platform-event-relay');
const {PlatformEventOutbox}=require('../../src/modules/integration/platform-event-outbox.model');
const {createAccountControlRouter}=require('../../src/modules/trading/account-control.routes');
const {createAccountLedgerRouter}=require('../../src/modules/accounts/account-ledger.routes');
const {createInternalAuthRouter}=require('../../src/modules/auth/internal-auth.routes');
const {createTradingRouter}=require('../../src/modules/trading/trading.routes');
const {createMarketWebSocketServer}=require('../../src/realtime/market-ws-server');
const {ensureCriticalIndexes}=require('../../src/config/indexes');
const {errorHandler}=require('../../src/shared/http/error-middleware');

const uri=process.env.B2B_TEST_MONGODB_URI;
test('B2B Mongo/HTTP/WS: two firms, same external references, independent credentials, fills, ledger and webhook routing', {skip:!uri,timeout:90000},async()=>{
  if(!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/acg_b2b_isolation_test(?:\?|$)/.test(uri))throw new Error('Dedicated local B2B replica-set required');
  mongoose.set('sanitizeFilter',true);
  let server,sockets,engine;
  const clients=[];
  const eventBus=new EventEmitter();
  const logger={info(){},warn(){},error(){},debug(){}};
  const quoteStore={get:()=>({symbol:'EURUSD',bid:1.101,ask:1.1012,receivedAtMs:Date.now(),isStale:false,sequence:1,source:'b2b-test'})};
  try{
    await mongoose.connect(uri);await ensureCriticalIndexes();
    const a=await Tenant.create({name:'Funded reference fixture',slug:'b2b-reference'});
    const b=await Tenant.create({name:'Independent partner fixture',slug:'b2b-independent'});
    const auth=new AuthService();
    const ka=await auth.createServiceApiKey({tenantId:a.id,clientId:'reference-client',scopes:['accounts:write','federation:write']});
    const kb=await auth.createServiceApiKey({tenantId:b.id,clientId:'independent-client',scopes:['accounts:provision','accounts:read','accounts:control','credentials:write','federation:write','ledger:read']});
    const sent=[];let failA=true;
    const secrets=['reference-fixture-secret','independent-fixture-secret'];
    const relay=new PlatformEventRelay({enabled:true,legacyTenantId:a.id,webhookUrl:'https://reference.example.test/hook',webhookSecret:secrets[0],
      partnerRoutes:[{tenantId:b.id,url:'https://independent.example.test/hook',secret:secrets[1]}],eventBus,logger,
      fetchImpl:async(url,request)=>{const body=JSON.parse(request.body);sent.push({url,body,headers:request.headers});return {ok:!url.includes('reference.')||!failA,status:503};}});
    const controls=new AccountControlService({eventBus,logger,platformEventRelay:relay});
    const ledger=new AccountLedgerService({eventBus,logger});
    const market=new MarketOrderService({quoteStore,eventBus,logger,platformEventRelay:relay});
    await Instrument.create({symbol:'EURUSD',displaySymbol:'EUR/USD',name:'Euro / US Dollar',assetClass:'FOREX',baseCurrency:'EUR',quoteCurrency:'USD',digits:5,tickSize:'0.00001',pipSize:'0.0001',contractSize:'100000',minVolume:'0.01',maxVolume:'100',volumeStep:'0.01',defaultLeverage:100,executionEnabled:true,commissionPerLot:'0',tradingSessions:[]});
    engine=new ValuationEngine({quoteStore,eventBus,logger});await engine.start();
    const runtime={enabled:true,accountControlService:controls,accountLedgerService:ledger,commandQueue:controls.commandQueue,marketOrderService:market,tradingHistoryService:new TradingHistoryService(),valuationEngine:engine,tradingPermissionPolicyService:{assertExposureIncreaseAllowed:async()=>{}},health:()=>({})};
    const app=express();app.use(express.json());
    app.use('/internal/accounts/:accountId/ledger',createAccountLedgerRouter(runtime,auth));
    app.use('/internal/accounts',createAccountControlRouter(runtime,auth));
    app.use('/internal/auth',createInternalAuthRouter(auth));
    app.use('/trading',createTradingRouter(runtime,auth));app.use(errorHandler);
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const origin='http://127.0.0.1:'+server.address().port;
    async function request(path,key,method='GET',body){
      const headers={Authorization:'Bearer '+(typeof key==='string'?key:key.apiKey),'Content-Type':'application/json'};
      if(typeof key!=='string')headers['x-acg-client-id']=key.clientId;
      const response=await fetch(origin+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,body:await response.json()};
    }
    const common={externalRef:'same-ref',ownerExternalRef:'same-owner',accountCode:'SAME-CODE',accountType:'CHALLENGE',initialBalance:'100000',tradingPermissions:{newsTrading:true,weekendHolding:true},tradingPermissionsVersion:1};
    const pa=await request('/internal/accounts/provision',ka,'POST',{...common,metadata:{fundedAccountId:'funded-legacy-id'}});
    const pb=await request('/internal/accounts/provision',kb,'POST',{...common,riskPolicy:{maxOpenPositions:2}});
    assert.equal(pa.status,201,JSON.stringify(pa.body));assert.equal(pb.status,201,JSON.stringify(pb.body));
    const aid=pa.body.account.id,bid=pb.body.account.id;
    assert.notEqual(aid,bid);
    assert.equal((await request('/internal/accounts/provision',kb,'POST',{...common,riskPolicy:{maxOpenPositions:2}})).status,200);
    assert.equal((await request('/internal/accounts/'+aid,kb)).status,404);
    assert.equal((await request('/internal/accounts/'+bid,ka)).status,404);
    assert.equal((await request('/internal/accounts/'+aid+'/pause',kb,'POST',{})).status,404);
    assert.equal((await request('/internal/accounts/'+bid+'/ledger',kb,'POST',{})).status,403);
    assert.equal((await request('/internal/accounts/'+bid+'/ledger',kb)).body.entries.length,1);
    assert.equal((await request('/internal/auth/accounts/'+aid+'/credentials',kb,'POST',{})).status,404);
    const credential=await request('/internal/auth/accounts/'+bid+'/credentials',kb,'POST',{login:'b2b-fixture',password:'fixture-password-123!'});
    assert.equal(credential.status,201);
    const native=await auth.loginNative({tenant:b.slug,login:'b2b-fixture',password:'fixture-password-123!'});
    const wrong=await request('/internal/auth/federation/tickets',ka,'POST',{ownerExternalRef:'same-owner',accountIds:[bid]});
    assert.equal(wrong.status,403);
    const ticket=await request('/internal/auth/federation/tickets',ka,'POST',{ownerExternalRef:'same-owner',accountIds:[aid]});
    assert.equal(ticket.status,201);
    const federated=await auth.exchangeFederationTicket(ticket.body.ticket);
    await assert.rejects(auth.exchangeFederationTicket(ticket.body.ticket),{code:'FEDERATION_TICKET_INVALID'});
    const principals=await Promise.all([auth.authenticateSessionToken(federated.accessToken),auth.authenticateSessionToken(native.accessToken)]);
    assert.deepEqual(principals.map(p=>p.accountIds),[[aid],[bid]]);
    const trade=(accountId)=>({accountId,clientOrderId:'same-client-order',symbol:'EURUSD',side:'BUY',volume:'0.1'});
    assert.equal((await request('/trading/orders/market',native.accessToken,'POST',trade(aid))).status,403);
    const fillA=await request('/trading/orders/market',federated.accessToken,'POST',trade(aid));
    const fillB=await request('/trading/orders/market',native.accessToken,'POST',trade(bid));
    assert.equal(fillA.status,201,JSON.stringify(fillA.body));assert.equal(fillB.status,201,JSON.stringify(fillB.body));
    assert.equal(await Deal.countDocuments({tenantId:a.id,accountId:aid}),1);
    assert.equal(await Deal.countDocuments({tenantId:b.id,accountId:bid}),1);
    assert.equal((await request('/trading/accounts/'+aid+'/history/deals',native.accessToken)).status,403);
    assert.equal((await request('/trading/accounts/'+bid+'/history/deals',native.accessToken)).body.items.length,1);
    assert.equal((await request('/trading/positions/'+fillA.body.position.id+'/valuation',native.accessToken)).status,404);
    sockets=createMarketWebSocketServer({server,runtime:{eventBus,health:()=>({}),symbols:['EURUSD'],timeframes:[]},tradingRuntime:runtime,authService:auth,path:'/v1/ws',corsOrigins:[],pingIntervalMs:10000,maxBufferBytes:1048576,logger});
    for(const session of [federated,native]){
      const ws=new WebSocket(origin.replace('http:','ws:')+'/v1/ws',['acg-trader','auth.'+session.accessToken]);
      const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));ws.on('error',()=>{});
      clients.push({ws,messages});
    }
    const until=async(check)=>{for(let i=0;i<200&&!check();i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(check(),'timed out awaiting isolated snapshot');};
    await until(()=>clients.every(c=>c.messages.some(m=>m.type==='trading.state.snapshot')));
    for(const [i,id] of [aid,bid].entries()){
      const snapshot=clients[i].messages.find(m=>m.type==='trading.state.snapshot').data.accounts;
      assert.deepEqual(snapshot.map(s=>s.account.id),[id]);assert.equal(snapshot[0].fills.length,1);
      assert.equal(snapshot[0].fills[0].accountId,id);
    }
    // Exercise tenant-event guard independently of unique account IDs.
    eventBus.emit('trading.deal.created',{accountId:aid,tenantId:b.id,dealId:'wrong-tenant-event'});
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(clients.every(c=>!JSON.stringify(c.messages).includes('wrong-tenant-event')));
    // Outbox facts committed by the real market execution transaction.
    assert.equal(await PlatformEventOutbox.countDocuments({eventType:'DEAL_CREATED'}),2);
    await relay.flush();
    assert.equal(await PlatformEventOutbox.countDocuments({tenantId:b.id,eventType:'DEAL_CREATED',status:'DELIVERED'}),1);
    assert.equal(await PlatformEventOutbox.countDocuments({tenantId:a.id,eventType:'DEAL_CREATED',status:'PENDING'}),1);
    await PlatformEventOutbox.updateMany({tenantId:a.id,status:'PENDING'},{$set:{nextAttemptAt:new Date(0)}});
    failA=false;await relay.flush();
    assert.equal(await PlatformEventOutbox.countDocuments({eventType:'DEAL_CREATED',status:'DELIVERED'}),2);
    for(const item of sent){
      const isA=item.url.includes('reference.');assert.equal(item.body.metadata.tenantId,isA?a.id:b.id);
      assert.equal(item.body.aggregateId,isA?'funded-legacy-id':'same-ref');
      assert.equal(item.headers['x-acg-event-signature'],signEnvelope(secrets[isA?0:1],item.headers['x-acg-event-timestamp'],item.body));
    }
    await ServiceApiKey.updateOne({clientId:kb.clientId},{$set:{status:'REVOKED'}});
    assert.equal((await request('/internal/accounts/'+bid,kb)).status,401);
    assert.ok((await PlatformEventOutbox.collection.indexes()).some(x=>x.key.tenantId===1&&x.key.status===1&&x.key.nextAttemptAt===1));
    assert.equal((await TradingAccount.findById(aid)).status,'ACTIVE');
    assert.equal(await Position.countDocuments({tenantId:a.id,accountId:aid}),1);
    assert.equal(await Order.countDocuments({tenantId:b.id,accountId:bid}),1);
  }finally{
    for(const c of clients)c.ws.terminate();
    if(sockets)await sockets.close();
    if(server)await new Promise(resolve=>server.close(resolve));
    if(engine)await engine.stop();
    if(mongoose.connection.readyState===1)await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
