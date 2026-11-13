'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NewsCalendarSnapshotService } = require('../../src/modules/trading/news-calendar-snapshot.service');
const { normalizeCalendarEvent } = require('../../src/modules/trading/trading-permission-policy.service');
function fixture(fetchImpl, timeout = 30) {
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const state = { _id: 'financecalendar-high-impact', generation: 0, leaseUntil: new Date(0), nextRefreshAt: new Date(0) };
  const snapshots = new Map();
  const matches = filter => Object.entries(filter).every(([key, value]) => value?.$lte !== undefined ? state[key] <= value.$lte : value?.$gt !== undefined ? state[key] > value.$gt : state[key] === value);
  const apply = patch => { Object.assign(state, patch.$set); if (patch.$inc) state.generation++; };
  const stateModel = {
    updateOne: async (filter, patch) => { if (matches(filter)) apply(patch); },
    findById: () => ({ lean: async () => ({ ...state }) }),
    findOneAndUpdate: (filter, patch) => ({ lean: async () => { if (!matches(filter)) return null; apply(patch); return { ...state }; } }),
  };
  const snapshotModel = { create: async data => snapshots.set(data._id, structuredClone(data)), findById: id => ({ lean: async () => snapshots.get(id) }) };
  const config = { financeCalendarBaseUrl: 'https://calendar.invalid', newsCalendarHttpTimeoutMs: timeout, newsCalendarCacheTtlMs: 60000, newsCalendarStaleMaxMs: 900000 };
  const options = { config, normalizeEvent: normalizeCalendarEvent, stateModel, snapshotModel, fetchImpl, now: () => clock };
  return { service: new NewsCalendarSnapshotService(options), second: () => new NewsCalendarSnapshotService(options), state, snapshots, advance: ms => { clock += ms; } };
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
