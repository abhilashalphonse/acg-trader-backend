'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACG_INSTRUMENT_CATALOG } = require('../../src/modules/instruments/instrument-catalog');
const {
  ACG_INDIA_PILOT_CATALOG,
  NSE_EQUITY_HOLIDAYS_2026,
} = require('../../src/modules/instruments/india-pilot-catalog');
const { isInstrumentSessionOpen } = require('../../src/modules/instruments/session-calendar');

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
    assert.deepEqual(item.tradingHolidays, NSE_EQUITY_HOLIDAYS_2026);
  }
});

test('NSE pilot follows the 2026 exchange holiday calendar', () => {
  assert.equal(NSE_EQUITY_HOLIDAYS_2026.length, 16);
  assert.equal(NSE_EQUITY_HOLIDAYS_2026.includes('2026-10-02'), true);

  const hdfc = ACG_INDIA_PILOT_CATALOG.find(item => item.symbol === 'HDFCBANK');
  assert.ok(hdfc);

  // Thursday before Gandhi Jayanti: regular NSE equity session is open.
  assert.equal(
    isInstrumentSessionOpen(hdfc, Date.parse('2026-10-01T04:30:00.000Z')),
    true,
  );

  // Friday, 2 Oct 2026: Gandhi Jayanti trading holiday.
  assert.equal(
    isInstrumentSessionOpen(hdfc, Date.parse('2026-10-02T04:30:00.000Z')),
    false,
  );

  // Monday after the holiday/weekend: normal session resumes.
  assert.equal(
    isInstrumentSessionOpen(hdfc, Date.parse('2026-10-05T04:30:00.000Z')),
    true,
  );
});


test('India pilot equities inherit the versioned stock leverage policy while execution remains disabled', () => {
  for (const item of ACG_INDIA_PILOT_CATALOG) {
    assert.equal(item.assetClass, 'EQUITY');
    assert.equal(item.defaultLeverage, 10, item.symbol);
    assert.equal(item.leveragePolicyVersion, 2, item.symbol);
    assert.equal(item.executionEnabled, false, item.symbol);
    assert.equal(item.executionProvisionVersion, 0, item.symbol);
    assert.equal(item.corporateActionPolicy, 'UNSUPPORTED', item.symbol);
  }
});
