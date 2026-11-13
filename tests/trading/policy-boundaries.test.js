'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { TradingPermissionPolicyService, normalizeCalendarEvent, symbolAffectedByEvent } = require('../../src/modules/trading/trading-permission-policy.service');
const { WeekendHoldingEngine } = require('../../src/modules/trading/weekend-holding.engine');
const { Order } = require('../../src/modules/trading/order.model');
const { Instrument } = require('../../src/modules/instruments/instrument.model');
const nowMs = Date.parse('2026-10-02T21:56:00Z');
const instrument = { symbol: 'EURUSD', assetClass: 'FOREX', baseCurrency: 'EUR', quoteCurrency: 'USD', timezone: 'UTC', tradingSessions: [{ days: [1,2,3,4,5], open: '00:00', close: '22:00' }] };
const event = { id: 'cpi', timestamp: new Date(nowMs).toISOString(), impact: 'HIGH', currency: 'USD', title: 'US CPI' };
function fixture(config = {}, dataStatus = 'FRESH') {
  const account = { _id: 'a1', tenantId: 't1', tradingPermissionsVersion: 1, tradingPermissions: { newsTrading: false, weekendHolding: false }, save: async () => {} };
  const service = new TradingPermissionPolicyService({ now: () => new Date(nowMs),
    config: { shadowEnabled: false, newsEnforcementEnabled: false, weekendEnforcementEnabled: true, newsRolloutPercent: 100, weekendRolloutPercent: 100, ...config },
    calendarSnapshots: { read: () => ({ dataStatus, events: [event], snapshotVersion: 'v1' }) },
    accountModel: { findById: () => ({ lean: async () => account, select() { return this; } }) },
    instrumentModel: { findOne: () => ({ lean: async () => instrument }) },
  });
  return { account, service };
}

test('shadow news never overrides enforced weekend; both decisions are retained', async () => {
  const { service } = fixture();
  const decision = await service.evaluateExposureIncrease({ accountId: 'a1', symbol: 'EURUSD' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.kind, 'WEEKEND');
  assert.deepEqual(decision.decisions.map(value => value.kind), ['NEWS', 'WEEKEND']);
});

test('expired data pauses only enforced new exposure and is visible in shadow', async () => {
  const { account, service } = fixture({ newsEnforcementEnabled: true, weekendEnforcementEnabled: false }, 'EXPIRED');
  await assert.rejects(service.authorizeExecution({ account, instrument, action: 'MARKET_OPEN' }), { code: 'NEWS_CALENDAR_UNAVAILABLE' });
  service.config.newsEnforcementEnabled = false;
  assert.equal((await service.authorizeExecution({ account, instrument, action: 'MARKET_OPEN' })).allowed, true);
});

test('execution uses transaction documents and performs no account/calendar network lookup', async () => {
  const { account, service } = fixture({ weekendEnforcementEnabled: false });
  service.accountModel.findById = () => { throw new Error('unexpected account lookup'); };
  service.instrumentModel.findOne = () => { throw new Error('unexpected instrument lookup'); };
  service.fetch = () => { throw new Error('unexpected calendar fetch'); };
  assert.equal((await service.authorizeExecution({ account, instrument, action: 'MARKET_OPEN' })).allowed, true);
});

test('slow shadow telemetry cannot hold execution open', async () => {
  const { account, service } = fixture({ shadowEnabled: true, weekendEnforcementEnabled: false });
  let release;
  service.shadowEventModel = { updateOne: () => new Promise(resolve => { release = resolve; }) };
  const decision = await service.authorizeExecution({ account, instrument, action: 'MARKET_OPEN' });
  assert.equal(decision.allowed, true);
  assert.ok(service.pendingTelemetry > 0);
  release?.();
});

test('missing impact is not promoted to high and oil events do not affect FX', () => {
  assert.equal(normalizeCalendarEvent({ ...event, impact: undefined }), null);
  assert.equal(symbolAffectedByEvent('EURUSD', instrument, { currency: 'USD', title: 'EIA Crude Oil Inventories' }), false);
});

test('scanner traverses 600 accounts and isolates an account failure', async () => {
  const accounts = Array.from({ length: 600 }, (_, i) => ({ _id: String(i).padStart(5, '0') }));
  const visited = new Set();
  const engine = new WeekendHoldingEngine({
    accountModel: { find: filter => ({ select() { return this; }, sort() { return this; }, limit(n) { this.n = n; return this; },
      lean() { return accounts.filter(a => !filter._id || a._id > filter._id.$gt).slice(0, this.n); } }) },
    positionModel: { find: filter => { visited.add(filter.accountId); return { select() { return this; }, lean() { if (filter.accountId === '00003') throw new Error('bad account'); return []; } }; } },
    orderModel: { find: () => ({ select() { return this; }, lean: async () => [] }) },
  });
  await engine.scanOnce();
  assert.equal(visited.size, 600);
});

test('calendar outage does not restrict an instrument outside every supported news mapping', async () => {
  const { account, service } = fixture({ newsEnforcementEnabled: true, weekendEnforcementEnabled: false }, 'EXPIRED');
  const result = await service.evaluateExposureIncrease({ accountId: account._id, account, symbol: 'BTCUSD', instrument: { symbol: 'BTCUSD', assetClass: 'CRYPTO', tradingSessions: [] } });
  assert.equal(result.allowed, true);
  assert.equal(result.status.news.dataStatus, 'NOT_APPLICABLE');
});

test('actual scanner queries cast with application sanitizeFilter settings', async () => {
  const previous = mongoose.get('sanitizeFilter');
  mongoose.set('sanitizeFilter', true);
  let instrumentQueries = 0;
  const checkedQuery = (Model, filter, rows) => {
    const query = Model.find(filter);
    query._castConditions();
    assert.ifError(query.error());
    return { select() { return this; }, lean: async () => rows };
  };
  let scanError;
  try {
    await new WeekendHoldingEngine({
      accountModel: { find: () => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => [{ _id: '000000000000000000000001' }] }) },
      positionModel: { find: () => ({ select() { return this; }, lean: async () => [] }) },
      orderModel: { find: filter => checkedQuery(Order, filter, [{ _id: 'o1', symbol: 'EURUSD' }]) },
      instrumentModel: { find: filter => { instrumentQueries++; return checkedQuery(Instrument, filter, [instrument]); } },
      policyService: { policyStatus: async () => ({ weekend: { active: false } }) },
      logger: { error: error => { scanError = error; } },
    }).scanOnce();
    assert.equal(scanError, undefined);
    assert.equal(instrumentQueries, 1);
  } finally { mongoose.set('sanitizeFilter', previous); }
});

test('provisional free-calendar events never authorize new exposure for enforced accounts', async () => {
  const { account, service } = fixture({ newsEnforcementEnabled: true, weekendEnforcementEnabled: false }, 'PENDING_VALIDATION');
  const decision = await service.evaluateExposureIncrease({ accountId: account._id, account,
    instrument, symbol: 'EURUSD', action: 'MARKET_OPEN' });
  assert.equal(decision.status.news.authoritative, false);
  assert.equal(decision.status.news.active, false, 'provisional event is never treated as confirmed');
  assert.equal(decision.allowed, false);
  assert.equal(decision.kind, 'NEWS_DATA_UNAVAILABLE');
  await assert.rejects(service.authorizeExecution({ account, instrument, action: 'PENDING_ENTRY' }),
    { code: 'NEWS_CALENDAR_UNAVAILABLE' });
  service.config.newsEnforcementEnabled = false;
  assert.equal((await service.evaluateExposureIncrease({ accountId: account._id, account,
    instrument, symbol: 'EURUSD', action: 'MARKET_OPEN' })).allowed, true,
  'information-only customers are not blocked by unvalidated data');
});
