'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {projectEconomicCalendar,attachEconomicCalendar}=require('../src/modules/ai/intelligence/economic-calendar-context');
const now=Date.parse('2026-11-27T09:00:00Z'),iso=x=>new Date(x).toISOString();
const market={symbol:'XAUUSD',instrument:{assetClass:'METAL',quoteCurrency:'USD'},limitations:['READ_ONLY','NO_NEWS_CONTEXT']};
const event=(title,currency,minutes)=>({title,currency,impact:'HIGH',timestamp:iso(now+minutes*60000),date:'2026-11-27',allDay:false});
const snapshot={dataStatus:'FRESH',fetchedAt:iso(now-60000),coverageFrom:iso(now-4*3600000),coverageTo:iso(now+28*3600000),
  events:[event('US releases','USD',20),event('EUR release','EUR',10),event('US release passed','USD',-30)],
  verification:{officialBls:'AVAILABLE',upstreamDiscrepancy:false},lastRefreshError:'private upstream detail',snapshotVersion:'internal-id'};
test('calendar includes related scheduled events, direction of time and source limitations',()=>{
  const c=projectEconomicCalendar({snapshot,market,nowMs:now});
  assert.equal(c.dataStatus,'FRESH');assert.equal(c.events.length,2);
  assert.deepEqual(c.events.map(e=>[e.title,e.timing,e.minutesFromNow]),[['US release passed','SCHEDULED_TIME_PASSED',-30],['US releases','UPCOMING',20]]);
  assert.equal(c.officialBlsCrossCheck,'AVAILABLE');
  assert.equal(c.windowFrom,snapshot.coverageFrom);
  assert.equal(c.noMatchingEventsInCoveredWindow,false);
  assert.ok(!JSON.stringify(c).includes('internal-id'));assert.ok(!JSON.stringify(c).includes('private upstream detail'));
});
test('expired, missing, pending or uncovered calendar never implies a clear calendar',()=>{
  assert.equal(projectEconomicCalendar({snapshot:null,market,nowMs:now}).dataStatus,'UNAVAILABLE');
  const expired=projectEconomicCalendar({snapshot:{...snapshot,dataStatus:'EXPIRED'},market,nowMs:now});
  assert.equal(expired.events.length,0);assert.notEqual(expired.noMatchingEventsInCoveredWindow,true);
  for(const dataStatus of ['VALID_GRACE','PENDING_VALIDATION']){
    const c=projectEconomicCalendar({snapshot:{...snapshot,dataStatus,events:[]},market,nowMs:now});
    assert.equal(c.dataStatus,dataStatus);assert.equal(c.noMatchingEventsInCoveredWindow,false);
  }
  const clear=projectEconomicCalendar({snapshot:{...snapshot,events:[]},market,nowMs:now});
  assert.equal(clear.noMatchingEventsInCoveredWindow,true);
  assert.equal(projectEconomicCalendar({snapshot:{...snapshot,coverageTo:iso(now-1)},market,nowMs:now}).dataStatus,'UNAVAILABLE');
  assert.equal(projectEconomicCalendar({snapshot:{...snapshot,events:[],verification:{upstreamDiscrepancy:true}},market,nowMs:now}).noMatchingEventsInCoveredWindow,false);
});
test('bounded events, unknown intraday timing and no mutation or extra fetch',()=>{
  const data={...snapshot,events:[{title:'USD all day release',currency:'USD',impact:'HIGH',date:'2026-11-27',allDay:true},
    ...Array.from({length:10},(_,i)=>event('USD '+i,'USD',60+i))]};
  let calls=0;
  const m=attachEconomicCalendar(market,()=>{calls++;return data;},now);
  assert.equal(calls,1);assert.equal(m.economicCalendar.events.length,6);assert.equal(m.economicCalendar.omittedEvents,5);
  assert.equal(m.economicCalendar.events.find(e=>e.allDay).timestamp,null);
  assert.ok(m.limitations.includes('NO_LIVE_NEWS_OR_RELEASE_ACTUALS'));assert.ok(!m.limitations.includes('NO_NEWS_CONTEXT'));
  assert.equal(market.economicCalendar,undefined);assert.equal(attachEconomicCalendar(null,()=>{throw Error('must not read');},now),null);
});
