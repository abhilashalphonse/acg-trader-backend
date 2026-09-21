'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeCurrentCandle } = require('../../src/modules/market-data/market.routes');

test('merges provider current candle with post-connect live fragment without losing earlier OHLC', () => {
  const merged = mergeCurrentCandle(
    {
      symbol: 'EURUSD',
      timeframe: '1m',
      openTimeMs: 1_000,
      closeTimeMs: 61_000,
      open: 1.1000,
      high: 1.1004,
      low: 1.0998,
      close: 1.1002,
      providerVolume: 120,
      complete: true,
      synthetic: false,
      source: 'BACKFILL',
      provider: 'twelve-data',
    },
    {
      symbol: 'EURUSD',
      timeframe: '1m',
      openTimeMs: 1_000,
      closeTimeMs: 61_000,
      open: 1.10018,
      high: 1.10035,
      low: 1.1001,
      close: 1.1003,
      tickCount: 14,
      providerVolume: 15,
      complete: false,
      synthetic: false,
      source: 'LIVE',
      provider: 'twelve-data',
    },
  );

  assert.equal(merged.open, 1.1);
  assert.equal(merged.high, 1.1004);
  assert.equal(merged.low, 1.0998);
  assert.equal(merged.close, 1.1003);
  assert.equal(merged.tickCount, 14);
  assert.equal(merged.providerVolume, 120);
  assert.equal(merged.complete, false);
  assert.equal(merged.synthetic, false);
  assert.equal(merged.source, 'LIVE_MERGED');
});
