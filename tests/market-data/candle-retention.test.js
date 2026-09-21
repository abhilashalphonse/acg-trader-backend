'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CANDLE_RETENTION_MS, candleExpiresAt } = require('../../src/modules/market-data/candle-retention');

test('candle retention keeps launch storage bounded by timeframe', () => {
  assert.equal(CANDLE_RETENTION_MS['1h'], 30 * 86_400_000);
  assert.equal(CANDLE_RETENTION_MS['4h'], 90 * 86_400_000);
  assert.equal(CANDLE_RETENTION_MS['1d'], 730 * 86_400_000);
  assert.equal(CANDLE_RETENTION_MS['1w'], null);
});

test('candle expiry is derived from candle open time', () => {
  const open = Date.parse('2026-09-21T00:00:00.000Z');
  assert.equal(
    candleExpiresAt('1h', open).toISOString(),
    '2026-10-21T00:00:00.000Z',
  );
  assert.equal(candleExpiresAt('1w', open), null);
  assert.equal(candleExpiresAt('1m', open), null);
});
