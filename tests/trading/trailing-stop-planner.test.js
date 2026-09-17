'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planTrailingConfiguration,
  planTrailingAdvance,
  trailingStopFromBest,
} = require('../../src/modules/trading/trailing-stop-planner');

function position(overrides = {}) {
  return {
    _id: '507f191e810c19729de860ea',
    accountId: '507f1f77bcf86cd799439011',
    symbol: 'EURUSD',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '1',
    entryPrice: '1.1',
    stopLoss: null,
    takeProfit: '1.12',
    trailing: { enabled: false, distancePoints: null, bestPrice: null, activatedAt: null },
    ...overrides,
  };
}

const instrument = { symbol: 'EURUSD', tickSize: '0.00001', maxQuoteAgeMs: 5000 };
function tick(overrides = {}) {
  return { symbol: 'EURUSD', bid: 1.105, ask: 1.1052, receivedAtMs: 10_000, sequence: 1, isStale: false, source: 'test', ...overrides };
}

test('enabling trailing on a long creates an initial SL below BID', () => {
  const plan = planTrailingConfiguration({ position: position(), instrument, quote: tick(), enabled: true, distancePoints: '20', nowMs: 10_100 });
  assert.equal(plan.enabled, true);
  assert.equal(plan.bestPrice, '1.105');
  assert.equal(plan.stopLoss, '1.1048');
});

test('existing safer long SL is never widened when trailing is enabled', () => {
  const plan = planTrailingConfiguration({ position: position({ stopLoss: '1.1049' }), instrument, quote: tick(), enabled: true, distancePoints: '20', nowMs: 10_100 });
  assert.equal(plan.stopLoss, '1.1049');
});

test('long trailing advances best BID and only tightens SL', () => {
  const p = position({ stopLoss: '1.1048', trailing: { enabled: true, distancePoints: '20', bestPrice: '1.105', activatedAt: new Date() } });
  const up = planTrailingAdvance({ position: p, instrument, tick: tick({ bid: 1.106, ask: 1.1062 }), nowMs: 10_100 });
  assert.equal(up.bestPrice, '1.106');
  assert.equal(up.stopLoss, '1.1058');
  const down = planTrailingAdvance({ position: { ...p, stopLoss: '1.1058', trailing: { ...p.trailing, bestPrice: '1.106' } }, instrument, tick: tick({ bid: 1.1055, ask: 1.1057 }), nowMs: 10_100 });
  assert.equal(down.stopLoss, '1.1058');
  assert.equal(down.changed, false);
});

test('short trailing uses ASK and only moves SL downward', () => {
  const p = position({ side: 'SELL', entryPrice: '1.11', stopLoss: '1.1054', takeProfit: '1.09', trailing: { enabled: true, distancePoints: '20', bestPrice: '1.1052', activatedAt: new Date() } });
  const plan = planTrailingAdvance({ position: p, instrument, tick: tick({ bid: 1.1038, ask: 1.104 }), nowMs: 10_100 });
  assert.equal(plan.bestPrice, '1.104');
  assert.equal(plan.stopLoss, '1.1042');
});

test('stale ticks never advance trailing state', () => {
  const p = position({ trailing: { enabled: true, distancePoints: '20', bestPrice: '1.105', activatedAt: new Date() } });
  assert.equal(planTrailingAdvance({ position: p, instrument, tick: tick({ isStale: true }), nowMs: 10_100 }), null);
});

test('disabling trailing preserves the last stop loss', () => {
  const p = position({ stopLoss: '1.1048', trailing: { enabled: true, distancePoints: '20', bestPrice: '1.105', activatedAt: new Date() } });
  const plan = planTrailingConfiguration({ position: p, instrument: null, quote: null, enabled: false, distancePoints: null, nowMs: 10_100 });
  assert.equal(plan.enabled, false);
  assert.equal(plan.stopLoss, '1.1048');
});

test('trailing stop calculation quantizes to the instrument point', () => {
  assert.equal(trailingStopFromBest({ side: 'BUY', bestPrice: '1.10503', distancePoints: '2', pointSize: '0.0001' }), '1.1048');
  assert.equal(trailingStopFromBest({ side: 'SELL', bestPrice: '1.10503', distancePoints: '2', pointSize: '0.0001' }), '1.1053');
});
