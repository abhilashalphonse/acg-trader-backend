'use strict';
// Called only from the existing loopback, random-database Phase 1 CI suite.
// Synthetic entitlement is deliberately NOT a production authorization adapter.
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const {Instrument}=require('../src/modules/instruments/instrument.model');
const {Candle}=require('../src/modules/market-data/candle.model');
const {InstrumentRegistry}=require('../src/modules/market-data/instrument-registry');
const {QuoteStore}=require('../src/modules/market-data/quote-store');
const {createMarketContextSource}=require('../src/modules/ai/intelligence/context-source');
const {createTrustedContextAssembler}=require('../src/modules/ai/intelligence/trusted-context');
const {createResponseEngine}=require('../src/modules/ai/intelligence/response-engine');
const {scopeFor}=require('../src/modules/ai/ai-read-gateway');
const {assertPhaseOneRead}=require('../src/modules/ai/financial-safety-boundary');
async function runPhase2Integration({auth,gateway,gs,token,readRequest,foreignToken}){
  if(process.env.NODE_ENV!=='test'||process.env.ACG_AI_ISOLATED_CI!=='true'||
    !/^acg_ai_ci_[a-f0-9]{24}$/.test(mongoose.connection.name)||
    mongoose.connection.host!=='127.0.0.1')throw Error('Phase 2 requires isolated CI database');
  for(const model of [Instrument,Candle]){await model.createCollection();await model.createIndexes();}
  const symbol='XAUUSD',start=Date.UTC(2026,0,5,10),asOf=start+20*60000;
  await Instrument.create({symbol,displaySymbol:symbol,name:'Synthetic gold fixture',assetClass:'METAL',
    quoteCurrency:'USD',digits:2,tickSize:'0.01',pipSize:'0.1',contractSize:'100',minVolume:'0.01',
    maxVolume:'100',volumeStep:'0.01',defaultLeverage:50,providerMappings:{twelveData:'XAU/USD'},
    tradingSessions:[{days:[1],open:'00:00',close:'23:59'}],timezone:'UTC',maxQuoteAgeMs:30000,
    scheduleVersion:1,chartEnabled:true,executionEnabled:false,status:'ACTIVE'});
  const row=(sym,tf,t,step,p,extra={})=>({symbol:sym,timeframe:tf,openTime:new Date(t),closeTime:new Date(t+step),
    open:String(p),high:String(p+1),low:String(p-1),close:String(p),complete:true,synthetic:false,
    source:'BACKFILL',provider:'twelve-data',...extra});
  await Candle.insertMany([
    ...Array.from({length:20},(_,i)=>row(symbol,'1m',start+i*60000,60000,100+i)),
    ...Array.from({length:4},(_,i)=>row(symbol,'5m',start+i*300000,300000,100+i*5)),
    row(symbol,'1m',asOf+60000,60000,999),row('EURUSD','1m',start,60000,999)
  ]);
  const registry=new InstrumentRegistry({symbols:[symbol],defaultMaxQuoteAgeMs:30000,logger:{warn(){}}});
  await registry.load();
  const quoteStore=new QuoteStore();
  quoteStore.set({symbol,providerSymbol:'XAU/USD',source:'twelve-data',receivedAtMs:asOf-1000,
    providerTimestampMs:asOf-2000,isStale:false,sessionOpen:true,bid:119,ask:120,isSyntheticSpread:true});
  const runtime={enabled:true,symbols:[symbol],timeframes:['1m','5m'],instrumentRegistry:registry,quoteStore,
    get historyService(){throw Error('Unexpected provider history access');},
    get ensureFreshQuote(){throw Error('Unexpected provider refresh');}};
  const source=createMarketContextSource(runtime);
  const principal=await auth.authenticateSessionToken(token);
  const {channel,...scope}=scopeFor(principal,readRequest.accountId,Date.now());
  const revision=(await gs.control(scope.tenantId)).revision;
  let entitlement=true,checks=0,activeToken=token,clock=asOf;
  const authorize=async r=>{
    checks++;
    try{
      if(!entitlement||!['tenantId','actorId','sessionId','accountId'].every(k=>r.scope[k]===scope[k]))return false;
      const market=r.marketRequest??r;
      if(market.symbol!==symbol||!Array.isArray(market.timeframes)||!market.timeframes.every(t=>runtime.timeframes.includes(t)))return false;
      const fresh=await auth.authenticateSessionToken(activeToken);
      const actual=scopeFor(fresh,readRequest.accountId,Date.now());
      if(!['tenantId','actorId','sessionId','accountId'].every(k=>actual[k]===scope[k]))return false;
      const control=await gs.control(scope.tenantId);
      if(!control.enabled||control.revision!==revision)return false;
      // Existing account read grant is a baseline only; it is NOT a market entitlement.
      await gateway.assertDisclosure(fresh,readRequest);
      return true;
    }catch{return false;}
  };
  const assembler=createTrustedContextAssembler({source,authorize,now:()=>clock});
  const engine=createResponseEngine({authorize,now:()=>clock});
  const req={scope,symbol,timeframes:['1m','5m'],limit:20};
  const countBefore=await Candle.countDocuments({});
  const ctx=await assembler.assemble(req);
  assert.equal(ctx.series[0].analysis.evidence.bars.length,20);
  assert.equal(ctx.series[1].analysis.evidence.bars.length,4);
  assert.equal(ctx.series[0].coverage.status,'MATCHES_CONFIGURED_CALENDAR');
  assert.equal(ctx.quote.status,'RECENT_PROVIDER_EVENT');
  assert.equal(ctx.quote.executable,false);
  const prepare=()=>engine.prepare({scope,profile:'MARKET_OVERVIEW',question:'Describe the observed market.',context:ctx});
  const {ticket,prompt}=await prepare();
  const ref=prompt.payload.data.evidence.references.find(r=>r.timeframe==='1m'&&r.type==='FACT'&&r.data.kind==='LAST_CLOSED_PRICE');
  assert.equal(ref.data.value,'119');
  const candidate=JSON.stringify({schemaVersion:'candidate-response-v2',status:'ANSWER',observations:[{referenceId:ref.referenceId}],interpretations:[],education:[]});
  const res=await engine.verify({ticket,scope,candidate});
  assert.equal(res.verified,true);assert.equal(res.response.observations[0].data.value,'119');
  assert.ok(checks>=5);
  assert.equal(await Candle.countDocuments({}),countBefore);
  assert.equal(await Instrument.countDocuments({}),1);
  assert.throws(()=>assertPhaseOneRead('market.candles.read'),{code:'AI_FINANCIAL_BOUNDARY_DENIED'});
  assert.throws(()=>assertPhaseOneRead('trade.execute'),{code:'AI_FINANCIAL_BOUNDARY_DENIED'});
  console.log('PASS Phase 2 real Mongo source, registry, cached quote, scoped context, prompt and recomputed response');
  await assert.rejects(assembler.assemble({...req,symbol:'EURUSD'}),{code:'CONTEXT_FORBIDDEN'});
  activeToken=foreignToken;
  await assert.rejects(assembler.assemble(req),{code:'CONTEXT_FORBIDDEN'});
  activeToken=token;
  const revoked=await prepare();entitlement=false;
  assert.equal((await engine.verify({ticket:revoked.ticket,scope,candidate})).code,'RESPONSE_FORBIDDEN');
  entitlement=true;
  const expired=await prepare();clock=asOf+10000;
  assert.equal((await engine.verify({ticket:expired.ticket,scope,candidate})).code,'RESPONSE_EXPIRED');
  clock=asOf;
  // Inconsistent catalog mapping is rejected before any analysis.
  await Instrument.updateOne({symbol},{$set:{'providerMappings.twelveData':'WRONG'}});
  await assert.rejects(assembler.assemble(req),{code:'INSTRUMENT_UNAVAILABLE'});
  await Instrument.updateOne({symbol},{$set:{'providerMappings.twelveData':'XAU/USD'}});
  console.log('PASS Phase 2 foreign scope, synthetic entitlement revocation, expiration, catalog mismatch and read-only boundary');
  // Later Phase 1 test changes actual control revision and revokes actual grant.
  return async()=>{await assert.rejects(assembler.assemble(req),{code:'CONTEXT_FORBIDDEN'});};
}
module.exports={runPhase2Integration};
