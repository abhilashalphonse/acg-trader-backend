'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACG_INSTRUMENT_CATALOG } = require('../../src/modules/instruments/instrument-catalog');

test('initial ACG catalog defines explicit EURUSD and XAUUSD execution specifications', () => {
  const eurusd = ACG_INSTRUMENT_CATALOG.find(item => item.symbol === 'EURUSD');
  const xauusd = ACG_INSTRUMENT_CATALOG.find(item => item.symbol === 'XAUUSD');

  assert.ok(eurusd);
  assert.ok(xauusd);
  assert.equal(eurusd.providerMappings.twelveData, 'EUR/USD');
  assert.equal(eurusd.tickSize, '0.00001');
  assert.equal(eurusd.contractSize, '100000');
  assert.equal(eurusd.volumeStep, '0.01');
  assert.equal(eurusd.spread.mode, 'SYNTHETIC');
  assert.equal(eurusd.executionEnabled, false);

  assert.equal(xauusd.providerMappings.twelveData, 'XAU/USD');
  assert.equal(xauusd.tickSize, '0.01');
  assert.equal(xauusd.contractSize, '100');
  assert.equal(xauusd.volumeStep, '0.01');
  assert.equal(xauusd.spread.mode, 'SYNTHETIC');
  assert.equal(xauusd.executionEnabled, false);
});
