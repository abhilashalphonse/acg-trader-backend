'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultTwelveDataSymbol, normalizeSymbol, clampInteger } = require('../../src/modules/market-data/market.utils');

test('normalizes ACG canonical symbols', () => {
  assert.equal(normalizeSymbol('eur/usd'), 'EURUSD');
  assert.equal(normalizeSymbol(' XAUUSD '), 'XAUUSD');
});

test('maps common canonical symbols to Twelve Data symbols', () => {
  assert.equal(defaultTwelveDataSymbol('EURUSD'), 'EUR/USD');
  assert.equal(defaultTwelveDataSymbol('XAUUSD'), 'XAU/USD');
  assert.equal(defaultTwelveDataSymbol('US30'), 'DJI');
});

test('clamps integer query values safely', () => {
  assert.equal(clampInteger('5000', 1, 1000, 160), 1000);
  assert.equal(clampInteger('bad', 1, 1000, 160), 160);
});
