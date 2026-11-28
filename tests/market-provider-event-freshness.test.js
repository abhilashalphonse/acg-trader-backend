'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {quoteAgeMs}=require('../src/modules/market-data/quote-freshness');
const {QuoteStore}=require('../src/modules/market-data/quote-store');
const {MarketGateway}=require('../src/modules/market-data/market-gateway');
test('recent receipt cannot disguise an old provider event',()=>{
  const now=1800000000000;
  assert.equal(quoteAgeMs({receivedAtMs:now-100,providerTimestampMs:now-60000},now),60000);
  assert.equal(quoteAgeMs({receivedAtMs:now-1000,providerTimestampMs:now-2000},now),2000);
  assert.equal(quoteAgeMs({receivedAtMs:now-1000,providerTimestampMs:null},now),1000);
  assert.equal(quoteAgeMs({receivedAtMs:now-1000,providerTimestampMs:now+1000},now),1000);
  assert.equal(quoteAgeMs(null,now),Infinity);
});
function fixture(providerTime){
  const quoteStore=new QuoteStore(),eventBus=new EventEmitter();
  const instrument={symbol:'BTCUSD',provider:'twelve-data',providerSymbol:'BTC/USD',configured:true,status:'ACTIVE',timezone:'UTC',tradingSessions:[],tradingHolidays:[],softQuoteAgeMs:10000,maxQuoteAgeMs:35000};
  let calls=0;
  const gateway=new MarketGateway({symbols:['BTCUSD'],staleCheckMs:1000,quoteStore,eventBus,
    adapter:{providerName:'twelve-data',async fetchLatestPrice(){calls++;return {price:60000,providerTimestampMs:providerTime(),source:'twelve-data-rest'};}},
    instrumentRegistry:{get:()=>instrument,provider:()=>instrument.provider,providerSymbol:()=>instrument.providerSymbol},
    candleEngine:{setSymbolLive(){},processTick(){}},
    tickSanityFilter:{inspect:({raw,receivedAtMs})=>({accepted:[{raw,receivedAtMs}]}),snapshot:()=>({})},
    executionPricing:{priceQuote:()=>({bid:59999,ask:60001,mid:60000,isSyntheticSpread:true})},
    logger:{info(){},warn(){},debug(){}}});
  const now=Date.now();
  quoteStore.set({symbol:'BTCUSD',providerSymbol:'BTC/USD',source:'twelve-data',providerTimestampMs:now-60000,receivedAtMs:now,isStale:false});
  return {gateway,quoteStore,calls:()=>calls};
}
test('gateway recovers stale provider event even when receipt was recent and preserves new event time',async()=>{
  const f=fixture(()=>Date.now()-100);
  const q=await f.gateway.ensureFreshQuote('BTCUSD');
  assert.equal(f.calls(),1);
  assert.equal(q.isStale,false);
  assert.equal(q.source,'twelve-data-rest');
  const status=f.gateway.status().symbols[0];
  assert.ok(status.providerEventAgeMs>=100);
  assert.ok(status.ageMs>=status.receiptAgeMs);
  await f.gateway.ensureFreshQuote('BTCUSD');
  assert.equal(f.calls(),1);
});
test('repeated stale REST event stays stale and existing cooldown prevents request storm',async()=>{
  const f=fixture(()=>Date.now()-60000);
  const q=await f.gateway.ensureFreshQuote('BTCUSD');
  assert.equal(f.calls(),1);
  assert.equal(q.isStale,true);
  assert.equal(f.gateway.status().symbols[0].state,'STALE');
  assert.ok(f.gateway.status().symbols[0].ageMs>=60000);
  await f.gateway.ensureFreshQuote('BTCUSD');
  assert.equal(f.calls(),1);
  assert.equal(f.quoteStore.get('BTCUSD').isStale,true);
});
