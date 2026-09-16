'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planPendingOrder,
  detectPendingOrderAction,
  resolveExpiry,
  nextLocalMidnightMs,
} = require('../../src/modules/trading/pending-order-planner');

function account(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    status: 'ACTIVE',
    tradingEnabled: true,
    currency: 'USD',
    leverage: 100,
    riskTimezone: 'UTC',
    riskPolicy: { allowedSymbols: [] },
    state: { balance: '10000', equity: '10000', freeMargin: '10000', usedMargin: '0' },
    ...overrides,
  };
}

function instrument(overrides = {}) {
  return {
    symbol: 'EURUSD',
    status: 'ACTIVE',
    executionEnabled: true,
    quoteCurrency: 'USD',
    tickSize: '0.00001',
    minVolume: '0.01',
    maxVolume: '100',
    volumeStep: '0.01',
    contractSize: '100000',
    defaultLeverage: 100,
    marginRate: null,
    commissionPerLot: '0',
    maxQuoteAgeMs: 5000,
    ...overrides,
  };
}

function quote(overrides = {}) {
  return {
    symbol: 'EURUSD',
    bid: 1.1,
    ask: 1.1002,
    sequence: 1,
    receivedAtMs: 10_000,
    source: 'test',
    isStale: false,
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    id: 'o1',
    accountId: 'a1',
    symbol: 'EURUSD',
    side: 'BUY',
    type: 'LIMIT',
    status: 'PENDING',
    limitPrice: '1.099',
    stopPrice: null,
    expiresAt: null,
    ...overrides,
  };
}

test('plans BUY LIMIT away from current ASK without reserving margin', () => {
  const plan = planPendingOrder({
    account: account(),
    instrument: instrument(),
    quote: quote(),
    type: 'LIMIT',
    side: 'BUY',
    volume: '1',
    limitPrice: '1.09900',
    stopLoss: '1.09',
    takeProfit: '1.12',
    nowMs: 10_100,
  });
  assert.equal(plan.limitPrice, '1.099');
  assert.equal(plan.timeInForce, 'GTC');
  assert.equal(plan.expiresAt, null);
  assert.equal(Object.hasOwn(plan, 'requiredMargin'), false);
});

test('LIMIT trigger uses ASK for buys and BID for sells', () => {
  assert.equal(detectPendingOrderAction({ order: order(), tick: quote({ ask: 1.0989 }), nowMs: 10_100 }).action, 'FILL');
  assert.equal(detectPendingOrderAction({ order: order(), tick: quote({ ask: 1.0991 }), nowMs: 10_100 }), null);
  const sell = order({ side: 'SELL', limitPrice: '1.101' });
  assert.equal(detectPendingOrderAction({ order: sell, tick: quote({ bid: 1.1011 }), nowMs: 10_100 }).action, 'FILL');
});

test('STOP trigger uses ASK for buys and BID for sells', () => {
  const buy = order({ type: 'STOP', limitPrice: null, stopPrice: '1.101' });
  assert.equal(detectPendingOrderAction({ order: buy, tick: quote({ ask: 1.1011 }), nowMs: 10_100 }).action, 'FILL');
  const sell = order({ type: 'STOP', side: 'SELL', limitPrice: null, stopPrice: '1.099' });
  assert.equal(detectPendingOrderAction({ order: sell, tick: quote({ bid: 1.0989 }), nowMs: 10_100 }).action, 'FILL');
});

test('STOP_LIMIT activates first and then behaves as LIMIT', () => {
  const pending = order({ type: 'STOP_LIMIT', stopPrice: '1.101', limitPrice: '1.102' });
  const tick = quote({ ask: 1.1015 });
  assert.equal(detectPendingOrderAction({ order: pending, tick, nowMs: 10_100 }).action, 'ACTIVATE');
  const triggered = { ...pending, status: 'TRIGGERED' };
  assert.equal(detectPendingOrderAction({ order: triggered, tick, nowMs: 10_100 }).action, 'FILL');
});

test('rejects pending prices on the wrong side of the market and invalid STOP_LIMIT geometry', () => {
  assert.throws(
    () => planPendingOrder({ account: account(), instrument: instrument(), quote: quote(), type: 'LIMIT', side: 'BUY', volume: '1', limitPrice: '1.101', nowMs: 10_100 }),
    error => error.code === 'INVALID_PENDING_PRICE',
  );
  assert.throws(
    () => planPendingOrder({ account: account(), instrument: instrument(), quote: quote(), type: 'STOP_LIMIT', side: 'BUY', volume: '1', stopPrice: '1.101', limitPrice: '1.1005', nowMs: 10_100 }),
    error => error.code === 'INVALID_PENDING_PRICE',
  );
});

test('validates protection around the pending entry reference', () => {
  assert.throws(
    () => planPendingOrder({ account: account(), instrument: instrument(), quote: quote(), type: 'STOP', side: 'BUY', volume: '1', stopPrice: '1.101', stopLoss: '1.102', nowMs: 10_100 }),
    error => error.code === 'INVALID_PROTECTION_PRICE',
  );
});

test('TODAY and SPECIFIED expiries resolve to durable future timestamps', () => {
  const nowMs = Date.parse('2026-09-16T12:00:00Z');
  assert.equal(nextLocalMidnightMs(nowMs, 'UTC'), Date.parse('2026-09-17T00:00:00Z'));
  const today = resolveExpiry({ timeInForce: 'TODAY', riskTimezone: 'UTC', nowMs });
  assert.equal(today.expiresAt.toISOString(), '2026-09-17T00:00:00.000Z');
  const specified = resolveExpiry({ timeInForce: 'SPECIFIED', expiresAt: '2026-09-16T13:00:00Z', nowMs });
  assert.equal(specified.expiresAt.toISOString(), '2026-09-16T13:00:00.000Z');
  assert.throws(
    () => resolveExpiry({ timeInForce: 'SPECIFIED', expiresAt: '2026-09-16T11:00:00Z', nowMs }),
    error => error.code === 'INVALID_ORDER_EXPIRY',
  );
});

test('expiry wins over a market trigger and stale ticks never fill', () => {
  const expired = order({ expiresAt: '2026-09-16T12:00:00Z' });
  assert.equal(detectPendingOrderAction({ order: expired, tick: quote({ ask: 1.098 }), nowMs: Date.parse('2026-09-16T12:00:01Z') }).action, 'EXPIRE');
  assert.equal(detectPendingOrderAction({ order: order(), tick: quote({ ask: 1.098, isStale: true }), nowMs: 10_100 }), null);
});
