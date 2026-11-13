'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NewsCalendarSnapshotService } = require('../../src/modules/trading/news-calendar-snapshot.service');
const { normalizeCalendarEvent } = require('../../src/modules/trading/trading-permission-policy.service');
function fixture(fetchImpl, timeout = 30, configOverrides = {}) {
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const state = { _id: configOverrides.calendarProvider === 'showmytrades' ? 'showmytrades-high-impact' : 'financecalendar-high-impact', generation: 0, leaseUntil: new Date(0), nextRefreshAt: new Date(0) };
  const snapshots = new Map();
  const matches = filter => Object.entries(filter).every(([key, value]) => value?.$lte !== undefined ? state[key] <= value.$lte : value?.$gt !== undefined ? state[key] > value.$gt : state[key] === value);
  const apply = patch => { Object.assign(state, patch.$set); if (patch.$inc) state.generation++; };
  const stateModel = {
    updateOne: async (filter, patch) => { if (matches(filter)) apply(patch); },
    findById: () => ({ lean: async () => ({ ...state }) }),
    findOneAndUpdate: (filter, patch) => ({ lean: async () => { if (!matches(filter)) return null; apply(patch); return { ...state }; } }),
  };
  const snapshotModel = { create: async data => snapshots.set(data._id, structuredClone(data)), findById: id => ({ lean: async () => snapshots.get(id) }) };
  const config = { financeCalendarBaseUrl: 'https://calendar.invalid', newsCalendarHttpTimeoutMs: timeout, newsCalendarCacheTtlMs: 60000, newsCalendarStaleMaxMs: 900000, ...configOverrides };
  const options = { config, normalizeEvent: normalizeCalendarEvent, stateModel, snapshotModel, fetchImpl, now: () => clock };
  return { service: new NewsCalendarSnapshotService(options), second: () => new NewsCalendarSnapshotService(options), state, snapshots, advance: ms => { clock += ms; }, currentTime: () => clock };
}
const event = { id: 'cpi', timestamp: '2026-10-02T13:30:00Z', impact: 'high', currency: 'USD', title: 'US CPI' };

test('25 concurrent refreshes share work and a second instance reloads the durable pointer', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { ok: true, json: async () => [event] }; });
  await Promise.all(Array.from({ length: 25 }, () => f.service.tick()));
  assert.equal(calls, 1);
  assert.equal(f.snapshots.size, 1);
  const second = f.second();
  await second.tick();
  assert.equal(calls, 1);
  assert.equal(second.read().snapshotVersion, f.service.read().snapshotVersion);
});

test('a second refresh owner cannot publish over the current lease', async () => {
  let release;
  let calls = 0;
  const f = fixture(async () => { calls++; await new Promise(resolve => { release = resolve; }); return { ok: true, json: async () => [event] }; }, 1000);
  const pending = f.service.tick();
  await new Promise(resolve => setImmediate(resolve));
  await f.second().tick();
  assert.equal(calls, 1);
  f.state.generation++; // A newer lease generation fences this response.
  release();
  await pending;
  assert.equal(f.state.activeVersion, undefined);
  assert.equal(f.service.read().dataStatus, 'UNAVAILABLE');
});

test('slow response body is bounded and cannot publish after timeout', async () => {
  let signal;
  let resolveBody;
  const f = fixture(async (_url, options) => { signal = options.signal; return { ok: true, json: () => new Promise(resolve => { resolveBody = resolve; }) }; });
  await f.service.tick();
  assert.equal(signal.aborted, true);
  assert.equal(f.service.read().dataStatus, 'UNAVAILABLE');
  resolveBody([event]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.snapshots.size, 0);
});

test('invalid payload does not replace a valid snapshot; grace and expiry are derived', async () => {
  let payload = [event];
  const f = fixture(async () => ({ ok: true, json: async () => payload }));
  await f.service.tick();
  const version = f.service.read().snapshotVersion;
  payload = { error: 'unavailable' };
  f.advance(60001);
  await f.service.tick();
  assert.equal(f.service.read().dataStatus, 'VALID_GRACE');
  assert.equal(f.service.read().snapshotVersion, version);
  f.advance(900000);
  assert.equal(f.service.read().dataStatus, 'EXPIRED');
});

test('unexpected removal of an upcoming event keeps the previous snapshot', async () => {
  let payload = [event];
  const f = fixture(async () => ({ ok: true, json: async () => payload }));
  await f.service.tick();
  payload = [];
  f.advance(60001);
  await f.service.tick();
  assert.equal(f.service.read().events.length, 1);
  assert.match(f.service.lastError, /removed/);
});

test('calendar requests authenticate with a server-side key without leaking it into URLs', async () => {
  let requestedUrl;
  let requestedHeaders;
  const f = fixture(async (url, options) => {
    requestedUrl = url.toString();
    requestedHeaders = options.headers;
    return { ok: true, json: async () => ({ events: [event] }) };
  });
  f.service.config.financeCalendarApiKey = 'secret-calendar-key';
  await f.service.tick();
  assert.equal(requestedHeaders['X-API-Key'], 'secret-calendar-key');
  assert.equal(requestedHeaders.Accept, 'application/json');
  assert.equal(requestedUrl.includes('secret-calendar-key'), false);
  assert.equal(f.service.read().dataStatus, 'FRESH');
});

test('calendar HTTP 401 retains the unavailable state rather than publishing events', async () => {
  const f = fixture(async () => ({ ok: false, status: 401 }));
  await f.service.tick();
  assert.equal(f.service.read().dataStatus, 'UNAVAILABLE');
  assert.match(f.service.lastError, /401/);
  assert.equal(f.snapshots.size, 0);
});

const blsCalendar = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:cpi-oct-2026',
  'SUMMARY:Consumer Price Index for September 2026',
  'DTSTART;TZID=America/New_York:20261002T093000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function freeFixture({ blsError = false, validated = false, primaryFailure = false } = {}) {
  let observedCalls = [];
  let currentTime = () => Date.parse('2026-10-02T12:00:00Z');
  const fetchImpl = async (url, options) => {
    observedCalls.push({url:String(url), accept:options.headers.Accept});
    if (String(url).includes('showmytrades.com')) {
      if (primaryFailure) return {ok:false,status:503};
      const time = '2026-10-02T13:30:00Z';
      return {ok:true,json: async () => ({
        server_time: currentTime()/1000, count:1,
        events:[{id:'us-cpi-2026',time,ts:Date.parse(time)/1000,impact:'high',currency:'USD',title:'US CPI'}],
      })};
    }
    if (String(url).includes('bls.gov')) {
      if (blsError) return {ok:false,status:403};
      return {ok:true,text:async () => blsCalendar};
    }
    throw new Error('unexpected provider URL');
  };
  const f = fixture(fetchImpl,30,{
    calendarProvider:'showmytrades',
    freeCalendarValidated:validated,
    showMyTradesCalendarUrl:'https://showmytrades.com/api/public/calendar/v1',
    blsReleaseCalendarUrl:'https://www.bls.gov/schedule/news_release/bls.ics',
  });
  currentTime=f.currentTime;
  return {...f, observedCalls};
}

test('free-feed snapshot is segregated, normalized and provisional before validation', async () => {
  const f=freeFixture();
  await f.service.tick();
  const result=f.service.read();
  assert.equal(result.dataStatus,'PENDING_VALIDATION');
  assert.equal(result.provider,'showmytrades+bls');
  assert.equal(result.verification.officialBls,'AVAILABLE');
  assert.equal(result.verification.confirmed,1);
  assert.equal(result.events.length,1);
  assert.equal(result.events[0].currency,'USD');
  assert.equal(f.state._id,'showmytrades-high-impact');
  assert.match(f.observedCalls[0].url,/impact=high/);
  assert.match(f.observedCalls[0].url,/days=3/);
  assert.equal(f.observedCalls[1].accept,'text/calendar');
  const second=f.second();
  await second.tick();
  assert.equal(second.read().snapshotVersion,result.snapshotVersion);
});

test('official BLS cross-check failure is explicitly degraded, not misreported as verified', async () => {
  const f=freeFixture({blsError:true});
  await f.service.tick();
  assert.equal(f.service.read().verification.officialBls,'UNAVAILABLE');
  assert.equal(f.service.read().dataStatus,'PENDING_VALIDATION');
  f.advance(900001);
  assert.equal(f.service.read().dataStatus,'EXPIRED');
});

test('validated feed can become fresh but primary HTTP failure never publishes a snapshot', async () => {
  const good=freeFixture({validated:true});
  await good.service.tick();
  assert.equal(good.service.read().dataStatus,'FRESH');
  const failed=freeFixture({primaryFailure:true});
  await failed.service.tick();
  assert.equal(failed.service.read().dataStatus,'UNAVAILABLE');
  assert.match(failed.service.lastError,/503/);
  assert.equal(failed.snapshots.size,0);
});
