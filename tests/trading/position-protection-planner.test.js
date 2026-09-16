'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planPositionProtection } = require('../../src/modules/trading/position-protection-planner');

function position(overrides = {}) {
  return {
    _id: '507f191e810c19729de860ea',
    accountId: '507f1f77bcf86cd799439011',
    symbol: 'EURUSD',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '1',
    entryPrice: '1.1',
    stopLoss: '1.09',
    takeProfit: '1.12',
    ...overrides,
  };
}

function instrument(overrides = {}) {
  return {
    symbol: 'EURUSD',
    tickSize: '0.00001',
    maxQuoteAgeMs: 5000,
    ...overrides,
  };
}

function quote(overrides = {}) {
  return {
    symbol: 'EURUSD',
    bid: 1.105,
    ask: 1.1052,
    sequence: 9,
    receivedAtMs: 10_000,
    source: 'test',
    isStale: false,
    ...overrides,
  };
}

test('long protection validates against current BID and preserves unspecified TP', () => {
  const plan = planPositionProtection({
    position: position(),
    instrument: instrument(),
    quote: quote(),
    stopLoss: '1.101',
    nowMs: 10_100,
  });
  assert.equal(plan.stopLoss, '1.101');
  assert.equal(plan.takeProfit, '1.12');
  assert.equal(plan.executablePrice, '1.105');
  assert.equal(plan.changed, true);
});

test('short protection validates against current ASK', () => {
  const plan = planPositionProtection({
    position: position({ side: 'SELL', entryPrice: '1.11', stopLoss: '1.12', takeProfit: '1.09' }),
    instrument: instrument(),
    quote: quote({ bid: 1.1048, ask: 1.105 }),
    stopLoss: '1.115',
    takeProfit: '1.1',
    nowMs: 10_100,
  });
  assert.equal(plan.stopLoss, '1.115');
  assert.equal(plan.takeProfit, '1.1');
  assert.equal(plan.executablePrice, '1.105');
});

test('rejects protection that would already be triggerable at the current market', () => {
  assert.throws(
    () => planPositionProtection({
      position: position(), instrument: instrument(), quote: quote(), stopLoss: '1.106', nowMs: 10_100,
    }),
    error => error.code === 'INVALID_PROTECTION_PRICE',
  );
  assert.throws(
    () => planPositionProtection({
      position: position({ side: 'SELL', entryPrice: '1.11', stopLoss: '1.12', takeProfit: '1.09' }),
      instrument: instrument(), quote: quote(), takeProfit: '1.106', nowMs: 10_100,
    }),
    error => error.code === 'INVALID_PROTECTION_PRICE',
  );
});

test('can remove both SL and TP explicitly', () => {
  const plan = planPositionProtection({
    position: position(), instrument: instrument(), quote: quote(), stopLoss: null, takeProfit: null, nowMs: 10_100,
  });
  assert.equal(plan.stopLoss, null);
  assert.equal(plan.takeProfit, null);
  assert.equal(plan.changed, true);
});

test('break-even moves long stop to entry only after BID has moved beyond entry', () => {
  const plan = planPositionProtection({
    position: position(), instrument: instrument(), quote: quote(), breakEven: true, nowMs: 10_100,
  });
  assert.equal(plan.stopLoss, '1.1');
  assert.equal(plan.takeProfit, '1.12');
  assert.equal(plan.breakEven, true);

  assert.throws(
    () => planPositionProtection({
      position: position(), instrument: instrument(), quote: quote({ bid: 1.0999, ask: 1.1001 }), breakEven: true, nowMs: 10_100,
    }),
    error => error.code === 'BREAK_EVEN_NOT_AVAILABLE',
  );
});

test('break-even for a short requires ASK below entry', () => {
  const plan = planPositionProtection({
    position: position({ side: 'SELL', entryPrice: '1.11', stopLoss: '1.12', takeProfit: '1.09' }),
    instrument: instrument(),
    quote: quote({ bid: 1.1048, ask: 1.105 }),
    breakEven: true,
    nowMs: 10_100,
  });
  assert.equal(plan.stopLoss, '1.11');
});

test('protection price must align to tick size', () => {
  assert.throws(
    () => planPositionProtection({
      position: position(), instrument: instrument({ tickSize: '0.0001' }), quote: quote(), stopLoss: '1.10105', nowMs: 10_100,
    }),
    error => error.code === 'INVALID_PROTECTION_PRICE_STEP',
  );
});

test('stale quotes pause protection modification', () => {
  assert.throws(
    () => planPositionProtection({
      position: position(), instrument: instrument(), quote: quote({ isStale: true }), stopLoss: '1.101', nowMs: 10_100,
    }),
    error => error.code === 'QUOTE_STALE',
  );
});
