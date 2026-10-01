'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACG_INSTRUMENT_CATALOG } = require('../../src/modules/instruments/instrument-catalog');
const { ACG_INDIA_PILOT_CATALOG } = require('../../src/modules/instruments/india-pilot-catalog');

test('NSE pilot stays separate and execution-disabled', () => {
  const expected = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'SBIN'];
  assert.deepEqual(ACG_INDIA_PILOT_CATALOG.map(item => item.symbol), expected);
  const normal = new Set(ACG_INSTRUMENT_CATALOG.map(item => item.symbol));
  for (const item of ACG_INDIA_PILOT_CATALOG) {
    assert.equal(normal.has(item.symbol), false);
    assert.equal(item.executionEnabled, false);
    assert.equal(item.chartEnabled, true);
    assert.equal(item.providerMappings.accelpix, item.symbol);
    assert.equal(item.quoteCurrency, 'INR');
    assert.equal(item.timezone, 'Asia/Kolkata');
  }
});
