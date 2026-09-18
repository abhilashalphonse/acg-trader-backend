'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACG_INSTRUMENT_CATALOG,
  FOREX_PAIRS,
  COMMODITIES,
  INDICES,
  US_EQUITIES,
  CRYPTO_PAIRS,
} = require('../../src/modules/instruments/instrument-catalog');

test('ACG production catalog contains exactly 300 unique instruments', () => {
  assert.equal(ACG_INSTRUMENT_CATALOG.length, 300);
  assert.equal(new Set(ACG_INSTRUMENT_CATALOG.map(item => item.symbol)).size, 300);
  assert.equal(new Set(ACG_INSTRUMENT_CATALOG.map(item => item.providerMappings.twelveData)).size, 300);
});

test('ACG catalog keeps the intended 80/20/20/160/20 asset distribution', () => {
  assert.equal(FOREX_PAIRS.length, 80);
  assert.equal(COMMODITIES.length, 20);
  assert.equal(INDICES.length, 20);
  assert.equal(US_EQUITIES.length, 160);
  assert.equal(CRYPTO_PAIRS.length, 20);
});

test('every catalog instrument is chartable, mapped to Twelve Data, and safe-by-default for execution', () => {
  for (const item of ACG_INSTRUMENT_CATALOG) {
    assert.equal(item.chartEnabled, true, item.symbol);
    assert.equal(item.executionEnabled, false, item.symbol);
    assert.equal(item.status, 'ACTIVE', item.symbol);
    assert.equal(typeof item.providerMappings.twelveData, 'string', item.symbol);
    assert.ok(item.providerMappings.twelveData.length > 0, item.symbol);
    assert.ok(Number(item.tickSize) > 0, item.symbol);
    assert.ok(Number(item.contractSize) > 0, item.symbol);
    assert.ok(Number(item.volumeStep) > 0, item.symbol);
  }
});

test('core launch symbols preserve EURUSD and XAUUSD execution specifications', () => {
  const eurusd = ACG_INSTRUMENT_CATALOG.find(item => item.symbol === 'EURUSD');
  const xauusd = ACG_INSTRUMENT_CATALOG.find(item => item.symbol === 'XAUUSD');
  assert.ok(eurusd);
  assert.ok(xauusd);
  assert.equal(eurusd.providerMappings.twelveData, 'EUR/USD');
  assert.equal(eurusd.tickSize, '0.00001');
  assert.equal(eurusd.contractSize, '100000');
  assert.equal(eurusd.volumeStep, '0.01');
  assert.equal(xauusd.providerMappings.twelveData, 'XAU/USD');
  assert.equal(xauusd.tickSize, '0.01');
  assert.equal(xauusd.contractSize, '100');
  assert.equal(xauusd.volumeStep, '0.01');
});
