'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Instrument } = require('../../src/modules/instruments/instrument.model');
const { enforceCatalogLeveragePolicy } = require('../../src/modules/instruments/instrument-catalog.service');
const { ACG_INSTRUMENT_CATALOG, ACG_LEVERAGE_BY_ASSET_CLASS } = require('../../src/modules/instruments/instrument-catalog');
const { ACG_INDIA_PILOT_CATALOG } = require('../../src/modules/instruments/india-pilot-catalog');

test('leverage startup migration updates all existing main and chart-only India records without any exposure writes', async () => {
  const original = Instrument.bulkWrite;
  let operations;
  Instrument.bulkWrite = async input => {
    operations = input;
    return { matchedCount: input.length, modifiedCount: input.length };
  };
  try {
    const result = await enforceCatalogLeveragePolicy();
    assert.equal(result.matched, 305);
    assert.equal(result.modified, 305);
  } finally {
    Instrument.bulkWrite = original;
  }
  assert.equal(operations.length, ACG_INSTRUMENT_CATALOG.length + ACG_INDIA_PILOT_CATALOG.length);
  const symbols = new Set();
  const pilot = new Set(ACG_INDIA_PILOT_CATALOG.map(i => i.symbol));
  let checkedPilot = 0;
  for (const { updateOne } of operations) {
    assert.equal(typeof updateOne.filter.symbol, 'string');
    assert.equal(updateOne.upsert, false, 'Startup must not create execution-capable instruments');
    assert.deepEqual(Object.keys(updateOne.update), ['$set']);
    assert.deepEqual(Object.keys(updateOne.update.$set), ['defaultLeverage'], 'Startup must not mutate execution flag, open-position margins, account balances or ledgers');
    assert.equal(symbols.has(updateOne.filter.symbol), false, 'No duplicate symbol operations');
    symbols.add(updateOne.filter.symbol);
    if (pilot.has(updateOne.filter.symbol)) {
      checkedPilot++;
      assert.equal(updateOne.update.$set.defaultLeverage, ACG_LEVERAGE_BY_ASSET_CLASS.EQUITY);
    }
  }
  assert.equal(checkedPilot, 5, 'All already-existing NSE records are included even without India market enabled');
});
