'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashCommandPayload, canonicalize } = require('../../src/modules/trading/idempotency.service');

test('idempotency hash is stable across object key order', () => {
  const first = {
    symbol: 'EURUSD',
    side: 'BUY',
    volume: '0.37',
    protection: { stopLoss: '1.1500', takeProfit: '1.1600' },
  };
  const second = {
    protection: { takeProfit: '1.1600', stopLoss: '1.1500' },
    volume: '0.37',
    side: 'BUY',
    symbol: 'EURUSD',
  };

  assert.equal(hashCommandPayload(first), hashCommandPayload(second));
});

test('idempotency hash changes when trading intent changes', () => {
  const buy = hashCommandPayload({ symbol: 'EURUSD', side: 'BUY', volume: '1' });
  const sell = hashCommandPayload({ symbol: 'EURUSD', side: 'SELL', volume: '1' });
  assert.notEqual(buy, sell);
});

test('canonicalization normalizes Date and bigint values', () => {
  const canonical = canonicalize({
    when: new Date('2026-09-16T04:00:00.000Z'),
    sequence: 12n,
  });
  assert.deepEqual(canonical, {
    sequence: '12',
    when: '2026-09-16T04:00:00.000Z',
  });
});
