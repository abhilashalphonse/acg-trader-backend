'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deleteExpiredLive,
  backfillMissingExpiry,
} = require('../../src/modules/market-data/legacy-candle-cleanup');

function cursor(rows) {
  return {
    sort() { return this; },
    limit(value) { this.value = value; return this; },
    async toArray() { return rows.splice(0, this.value || rows.length); },
  };
}

test('legacy cleanup deletes only rows selected as expired LIVE candles', async () => {
  const queued = [{ _id: 'a' }, { _id: 'b' }];
  const deletedFilters = [];
  const collection = {
    find(filter) {
      assert.equal(filter.source, 'LIVE');
      assert.equal(filter.timeframe, '1m');
      assert.ok(filter.openTime.$lte instanceof Date);
      return cursor(queued);
    },
    async deleteMany(filter) {
      deletedFilters.push(filter);
      return { deletedCount: filter._id.$in.length };
    },
  };

  const deleted = await deleteExpiredLive({
    collection,
    timeframe: '1m',
    cutoff: new Date(),
    batchSize: 500,
    delayMs: 0,
    pause: async () => {},
    logger: null,
  });

  assert.equal(deleted, 2);
  assert.deepEqual(deletedFilters, [{ _id: { $in: ['a', 'b'] } }]);
});

test('legacy cleanup backfills expiry metadata without changing market values', async () => {
  const openTime = new Date('2026-09-21T00:00:00.000Z');
  const queued = [{ _id: 'a', openTime }];
  const operationsSeen = [];
  const collection = {
    find(filter) {
      assert.equal(filter.source, 'LIVE');
      assert.equal(filter.timeframe, '1m');
      assert.ok(Array.isArray(filter.$or));
      return cursor(queued);
    },
    async bulkWrite(operations) {
      operationsSeen.push(...operations);
      return { modifiedCount: operations.length };
    },
  };

  const updated = await backfillMissingExpiry({
    collection,
    timeframe: '1m',
    batchSize: 500,
    delayMs: 0,
    pause: async () => {},
    logger: null,
  });

  assert.equal(updated, 1);
  assert.equal(
    operationsSeen[0].updateOne.update.$set.expiresAt.toISOString(),
    '2026-09-23T00:00:00.000Z',
  );
  assert.deepEqual(operationsSeen[0].updateOne.filter, { _id: 'a' });
});
