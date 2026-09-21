'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeCurrentCandle } = require('../../src/modules/market-data/market.routes');

test('merges provider current candle with post-connect live fragment without changing OHLC semantics', () => {
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
      tickCount: 0,
      providerVolume: 120,
      displayVolume: 120,
      volumeSource: 'provider',
      volumeMode: 'provider',
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
      displayVolume: 120,
      volumeSource: 'provider',
      volumeMode: 'provider',
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
  assert.equal(merged.providerVolume, 15);
  assert.equal(merged.displayVolume, 120);
  assert.equal(merged.volumeSource, 'provider');
  assert.equal(merged.volumeMode, 'provider');
  assert.equal(merged.complete, false);
  assert.equal(merged.synthetic, false);
  assert.equal(merged.source, 'LIVE_MERGED');
});

test('tick volume mode never mixes provider volume into the displayed value', () => {
  const merged = mergeCurrentCandle(
    {
      symbol: 'XAUUSD',
      timeframe: '1m',
      openTimeMs: 1_000,
      closeTimeMs: 61_000,
      open: 4300,
      high: 4302,
      low: 4299,
      close: 4301,
      tickCount: 28,
      providerVolume: 0,
      displayVolume: 28,
      volumeSource: 'tick',
      volumeMode: 'tick',
    },
    {
      symbol: 'XAUUSD',
      timeframe: '1m',
      openTimeMs: 1_000,
      closeTimeMs: 61_000,
      open: 4301,
      high: 4303,
      low: 4300,
      close: 4302,
      tickCount: 35,
      providerVolume: 5000,
      displayVolume: 35,
      volumeSource: 'tick',
      volumeMode: 'tick',
    },
  );

  assert.equal(merged.displayVolume, 35);
  assert.equal(merged.volumeSource, 'tick');
  assert.equal(merged.volumeMode, 'tick');
});
