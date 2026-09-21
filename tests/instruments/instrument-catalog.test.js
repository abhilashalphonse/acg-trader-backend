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

test('every ACG Funded instrument uses the advertised 1:100 leverage', () => {
  for (const item of ACG_INSTRUMENT_CATALOG) {
    assert.equal(item.defaultLeverage, 100, item.symbol);
    assert.equal(item.marginRate, null, item.symbol);
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
  assert.equal(eurusd.spread.mode, 'DYNAMIC');
  assert.equal(eurusd.spread.normalPoints, '2');
  assert.equal(eurusd.commissionPerLotPerSide, '2.5');
  assert.equal(xauusd.providerMappings.twelveData, 'XAU/USD');
  assert.equal(xauusd.tickSize, '0.01');
  assert.equal(xauusd.contractSize, '100');
  assert.equal(xauusd.volumeStep, '0.01');
  assert.equal(xauusd.spread.mode, 'DYNAMIC');
  assert.equal(xauusd.spread.normalPoints, '20');
  assert.equal(xauusd.commissionPerLotPerSide, '2.5');
});


test('catalog defines a soft recovery threshold below the hard execution cutoff', () => {
  for (const item of ACG_INSTRUMENT_CATALOG) {
    assert.ok(Number(item.softQuoteAgeMs) > 0, item.symbol);
    assert.ok(Number(item.maxQuoteAgeMs) > Number(item.softQuoteAgeMs), item.symbol);
  }
});

test('alt crypto receives a wider hard freshness window than major crypto', () => {
  const btc = ACG_INSTRUMENT_CATALOG.find(item => item.symbol === 'BTCUSD');
  const aave = ACG_INSTRUMENT_CATALOG.find(item => item.symbol === 'AAVEUSD');
  assert.equal(btc.softQuoteAgeMs, 10000);
  assert.equal(btc.maxQuoteAgeMs, 35000);
  assert.equal(aave.softQuoteAgeMs, 15000);
  assert.equal(aave.maxQuoteAgeMs, 60000);
});
