'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectProtectionTrigger } = require('../../src/modules/trading/protection-trigger');

function position(overrides = {}) {
  return {
    id: 'p1',
    accountId: 'a1',
    symbol: 'EURUSD',
    side: 'BUY',
    status: 'OPEN',
    stopLoss: '1.09',
    takeProfit: '1.12',
    ...overrides,
  };
}

function tick(overrides = {}) {
  return {
    symbol: 'EURUSD',
    bid: 1.1,
    ask: 1.1002,
    sequence: 10,
    receivedAtMs: 1000,
    source: 'test',
    isStale: false,
    ...overrides,
  };
}

test('long stop loss and take profit trigger on BID', () => {
  const sl = detectProtectionTrigger({ position: position(), tick: tick({ bid: 1.0899, ask: 1.0901 }) });
  assert.equal(sl.reason, 'STOP_LOSS');
  assert.equal(sl.triggerPrice, '1.09');
  assert.equal(sl.executablePrice, '1.0899');

  const tp = detectProtectionTrigger({ position: position(), tick: tick({ bid: 1.1201, ask: 1.1203 }) });
  assert.equal(tp.reason, 'TAKE_PROFIT');
  assert.equal(tp.triggerPrice, '1.12');
});

test('short stop loss and take profit trigger on ASK', () => {
  const short = position({ side: 'SELL', stopLoss: '1.12', takeProfit: '1.09' });
  const sl = detectProtectionTrigger({ position: short, tick: tick({ bid: 1.1198, ask: 1.1201 }) });
  assert.equal(sl.reason, 'STOP_LOSS');
  assert.equal(sl.executablePrice, '1.1201');

  const tp = detectProtectionTrigger({ position: short, tick: tick({ bid: 1.0897, ask: 1.0899 }) });
  assert.equal(tp.reason, 'TAKE_PROFIT');
  assert.equal(tp.executablePrice, '1.0899');
});

test('stale or non-triggering ticks never fire protection', () => {
  assert.equal(detectProtectionTrigger({ position: position(), tick: tick({ isStale: true, bid: 1.08 }) }), null);
  assert.equal(detectProtectionTrigger({ position: position(), tick: tick({ bid: 1.10, ask: 1.1002 }) }), null);
  assert.equal(detectProtectionTrigger({ position: position({ stopLoss: null, takeProfit: null }), tick: tick({ bid: 1.08 }) }), null);
});
