'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isPausedIndiaInstrument } = require('../../src/modules/instruments/india-market-availability');

test('Accelpix/NSE equity is hidden while licensing is paused', () => {
  const reliance = { symbol: 'RELIANCE', assetClass: 'EQUITY', timezone: 'Asia/Kolkata', providerMappings: { accelpix: 'RELIANCE' } };
  assert.equal(isPausedIndiaInstrument(reliance, false), true);
  assert.equal(isPausedIndiaInstrument(reliance, true), false);
});

test('the pause also covers persisted Map mappings and unmapped NSE equities', () => {
  assert.equal(isPausedIndiaInstrument({ providerMappings: new Map([['accelpix', 'SBIN']]) }, false), true);
  assert.equal(isPausedIndiaInstrument({ assetClass: 'EQUITY', timezone: 'Asia/Kolkata' }, false), true);
});

test('US stocks and non-NSE symbols stay visible', () => {
  assert.equal(isPausedIndiaInstrument({ symbol: 'AAPL', assetClass: 'EQUITY', timezone: 'America/New_York' }, false), false);
  assert.equal(isPausedIndiaInstrument({ symbol: 'XAUUSD', assetClass: 'METAL' }, false), false);
  assert.equal(isPausedIndiaInstrument(null, false), false);
});
