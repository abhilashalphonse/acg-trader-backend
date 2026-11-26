'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Instrument } = require('../../src/modules/instruments/instrument.model');
const { syncInstrumentCatalog } = require('../../src/modules/instruments/instrument-catalog.service');

test('catalog sync preserves operator-configured trading holidays and date-specific early closes', async () => {
  const original = Instrument.bulkWrite;
  const batches = [];
  Instrument.bulkWrite = async operations => {
    batches.push(operations);
    return { matchedCount: operations.length, modifiedCount: 0, upsertedCount: 0 };
  };
  try {
    await syncInstrumentCatalog({ logger: { info() {} } });
    assert.ok(batches.length >= 2);
    const gold = batches[0].find(op => op.updateOne.filter.symbol === 'XAUUSD');
    assert.ok(gold);
    assert.ok(gold.updateOne.update.$set.tradingSessions.length > 0);
    assert.equal(gold.updateOne.update.$set.timezone, 'America/New_York');
    assert.equal(Object.hasOwn(gold.updateOne.update.$set, 'tradingHolidays'), false);
    assert.equal(Object.hasOwn(gold.updateOne.update.$set, 'sessionOverrides'), false);
    assert.deepEqual(gold.updateOne.update.$setOnInsert.tradingHolidays, []);
  } finally {
    Instrument.bulkWrite = original;
  }
});
