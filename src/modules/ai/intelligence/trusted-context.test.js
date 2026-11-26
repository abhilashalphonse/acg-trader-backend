'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTrustedContextAssembler,quoteEvidence,TTL_MS}=require('./trusted-context');
const {classifyCoverage}=require('./calendar-coverage');
const {createCandleEvidence}=require('./candle-evidence');
const start=Date.UTC(2026,0,5,10),step=60000,asOf=start+3*step;
const scope={tenantId:'a'.repeat(24),actorId:'b'.repeat(24),sessionId:'c'.repeat(24),accountId:'d'.repeat(24)};
const instrument=()=>({symbol:'XAUUSD',status:'ACTIVE',chartEnabled:true,provider:'twelve-data',providerSymbol:'XAU/USD',
  quoteCurrency:'USD',timezone:'UTC',scheduleVersion:1,tradingSessions:[{days:[1,2,3,4,5],open:'10:00',close:'10:02'}],
  tradingHolidays:[],sessionOverrides:[],maxQuoteAgeMs:30000});
const bar=(n,extra={})=>({symbol:'XAUUSD',timeframe:'1m',openTimeMs:start+n*step,closeTimeMs:start+(n+1)*step,
  open:100,high:101,low:99,close:100,source:'BACKFILL',provider:'twelve-data',complete:true,synthetic:false,...extra});
const input=(bars,at=asOf)=>createCandleEvidence({symbol:'XAUUSD',timeframe:'1m',asOfMs:at,candles:bars});
const q=()=>({symbol:'XAUUSD',providerSymbol:'XAU/USD',source:'twelve-data',receivedAtMs:asOf-1000,
  providerTimestampMs:asOf-2000,isStale:false,sessionOpen:true,bid:100,ask:101,isSyntheticSpread:true});
const req={scope,symbol:'XAUUSD',timeframes:['1m'],limit:3};
function fixture(){
  let auth=true,reads=0,checks=0,clock=asOf,inst=instrument(),candles=[bar(0),bar(1)],quote=q(),after=null;
  const source={async instrument(){reads++;return inst;},quote(){reads++;return quote;},
    async candles(){reads++;if(after)after();return candles;}};
  const a=createTrustedContextAssembler({source,now:()=>clock,authorize:async request=>{
    checks++;assert.deepEqual(request.scope,scope);return auth;
  }});
  return {a,reads:()=>reads,checks:()=>checks,deny:()=>{auth=false;},advance:n=>{clock+=n;},
    after:f=>{after=f;},change:()=>{inst={...inst,scheduleVersion:2};},bars:v=>{candles=v;},setQuote:v=>{quote=v;}};
}
test('calendar distinguishes missing open buckets, closed gaps and out-of-session rows',()=>{
  const i=instrument();
  const valid=classifyCoverage(input([bar(0),bar(1)]),i);
  assert.equal(valid.status,'MATCHES_CONFIGURED_CALENDAR');
  assert.equal(valid.closedGapBuckets,1);assert.equal(valid.coverageVerified,false);
  assert.equal(classifyCoverage(input([bar(0)]),i).missingOpenBuckets,1);
  assert.equal(classifyCoverage(input([bar(0),bar(1),bar(2)]),i).outOfSessionBars,1);
  assert.equal(classifyCoverage(input([bar(0),bar(1)]),{...i,sessionOverrides:[{date:'2026-01-05',closed:true,sessions:[]}]}).outOfSessionBars,2);
  assert.equal(classifyCoverage(input([bar(0)]),{...i,tradingSessions:[]}).status,'UNKNOWN');
  assert.equal(classifyCoverage(input([bar(0)]),{...i,provider:'accelpix'}).status,'UNKNOWN');
});
test('quote evidence uses provider time, exact mapping and both session checks',()=>{
  const i={...instrument(),tradingSessions:[{days:[1],open:'00:00',close:'23:59'}]};
  assert.equal(quoteEvidence(q(),i,asOf).status,'RECENT_PROVIDER_EVENT');
  assert.equal(quoteEvidence(q(),i,asOf).executable,false);
  assert.equal(quoteEvidence(q(),i,asOf).isSyntheticSpread,true);
  for(const raw of [null,{...q(),providerTimestampMs:null},{...q(),providerTimestampMs:asOf-60000},
    {...q(),receivedAtMs:asOf+1},{...q(),source:'twelve-data-rest'},{...q(),providerSymbol:'GOLD'},
    {...q(),isStale:true},{...q(),ask:99}]){
    assert.equal(quoteEvidence(raw,i,asOf).status,'UNAVAILABLE');
  }
  assert.equal(quoteEvidence(q(),instrument(),asOf).reason,'SESSION_CLOSED_OR_UNKNOWN');
});
test('authorization before reading and before disclosure, including scope and bounds',async()=>{
  const x=fixture();x.deny();
  await assert.rejects(x.a.assemble(req),{code:'CONTEXT_FORBIDDEN'});assert.equal(x.reads(),0);
  const y=fixture();
  for(const bad of [{...req,scope:{...scope,accountId:'bad'}},{...req,limit:129},
    {...req,timeframes:['1m','1m']},{...req,timeframes:['1s']}])
    await assert.rejects(y.a.assemble(bad),{code:'INVALID_CONTEXT_REQUEST'});
  assert.equal(y.reads(),0);
  y.after(y.deny);await assert.rejects(y.a.assemble(req),{code:'CONTEXT_FORBIDDEN'});
  assert.equal(y.checks(),2);
});
test('immutable snapshot retains explicit evidence limits and suppresses closed-session bars',async()=>{
  const x=fixture();const a=await x.a.assemble(req);
  assert.equal(a.quote.status,'UNAVAILABLE');assert.equal(a.series[0].coverage.closedGapBuckets,1);
  assert.equal(a.series[0].analysis.evidence.quality.closedCount,2);
  assert.ok(Object.isFrozen(a.scope));assert.ok(Object.isFrozen(a.series[0]));
  assert.equal(a.expiresAtMs,asOf+TTL_MS);assert.match(a.contextId,/^[a-f0-9]{64}$/);
  assert.equal((await x.a.assemble(req)).contextId,a.contextId);
  x.bars([bar(0),bar(1),bar(2)]);const b=await x.a.assemble(req);
  assert.equal(b.series[0].analysis,null);assert.equal(b.series[0].status,'OUT_OF_SESSION_DATA_REJECTED');
});
test('reject source drift, excessive history, foreign provider and expired assembly',async()=>{
  const x=fixture();x.after(x.change);await assert.rejects(x.a.assemble(req),{code:'CONTEXT_SOURCE_CHANGED'});
  const y=fixture();y.bars([bar(0),bar(1),bar(2),bar(3)]);await assert.rejects(y.a.assemble(req),{code:'SOURCE_LIMIT_VIOLATION'});
  const z=fixture();z.bars([bar(0,{provider:'accelpix'})]);await assert.rejects(z.a.assemble(req),{code:'CANDLE_PROVIDER_MISMATCH'});
  const t=fixture();t.after(()=>t.advance(TTL_MS));await assert.rejects(t.a.assemble(req),{code:'CONTEXT_EXPIRED'});
});

test('explicit server session window is attached to scoped context; bad windows are rejected',async()=>{
  const x=fixture();
  const a=await x.a.assemble({...req,sessionWindows:[{timeframe:'1m',startMs:start,endMs:start+2*step}]});
  assert.equal(a.series[0].sessions[0].status,'OBSERVED_WINDOW_COMPLETE');
  assert.equal(a.series[0].sessions[0].observedRange.high,'101');
  assert.equal(a.crossTimeframe.alignment,'INSUFFICIENT_QUALIFIED_FRAMES');
  await assert.rejects(x.a.assemble({...req,sessionWindows:[{timeframe:'5m',startMs:start,endMs:start+2*step}]}),{code:'INVALID_CONTEXT_REQUEST'});
});
