'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AlertShadowWorker } = require('../src/modules/alerts/alert-worker');
const { DurableAlertStream } = require('../src/modules/alerts/alert-journal');

test('keyset paging serves all 475 active rules, including those beyond first 200', async () => {
  const rows = Array.from({ length: 475 }, (_, i) => ({
    _id: String(i + 1).padStart(4, '0'),
    status: 'MONITORING',
  }));
  const seen = new Map();
  const fakeRuleModel = {
    find(criteria) {
      const query = {
        sort() { return this; },
        limit(n) { this.limitAmount = n; return this; },
        async lean() {
          const start = criteria._id?.$gt || '';
          return rows.filter(r => r.status === 'MONITORING' && r._id > start)
            .slice(0, this.limitAmount);
        },
      };
      return query;
    },
  };
  const worker = new AlertShadowWorker({ ruleModel: fakeRuleModel });
  worker.token = 1;
  worker.renewLease = async () => true;
  worker.processRule = async rule => {
    seen.set(rule._id, (seen.get(rule._id) || 0) + 1);
    return true;
  };
  const outputs = [];
  for (let i = 0; i < 3; i++) outputs.push(await worker.pumpOnce({ maxRules: 200 }));
  assert.deepEqual(outputs.map(r => r.checkedRules), [200, 200, 75]);
  assert.equal(seen.size, 475);
  assert.equal([...seen.values()].every(count => count === 1), true);

  // A new sweep must start again after reaching the end, without starvation.
  const next = await worker.pumpOnce({ maxRules: 200 });
  assert.equal(next.checkedRules, 200);
  assert.equal(seen.get('0001'), 2);
});

test('capture exclusive lease prevents ping-pong takeover; fenced owner stands down', async () => {
  const record = { _id: 'twelve-data:XAUUSD', generation: 0,
    captureToken: 0, captureOwnerId: null, captureLeaseUntil: null, status: 'STARTING' };
  function selectorAllows(query) {
    if (query._id !== record._id) return false;
    if (query.generation != null && query.generation !== record.generation) return false;
    if (query.captureOwnerId != null && query.captureOwnerId !== record.captureOwnerId) return false;
    if (query.captureToken != null && query.captureToken !== record.captureToken) return false;
    if (query.captureLeaseUntil?.$gt && !(record.captureLeaseUntil > query.captureLeaseUntil.$gt)) return false;
    if (query.captureLeaseUntil?.$lte && !(record.captureLeaseUntil <= query.captureLeaseUntil.$lte)) return false;
    if (query.$or) {
      return query.$or.some(part => {
        if (part.captureLeaseUntil?.$lte) return record.captureLeaseUntil != null
          && record.captureLeaseUntil <= part.captureLeaseUntil.$lte;
        if (part.captureLeaseUntil?.$exists === false) return !('captureLeaseUntil' in record);
        if (part.captureLeaseUntil === null) return record.captureLeaseUntil == null;
        return Object.entries(part).every(([key, v]) => {
          if (key === 'captureLeaseUntil' && v?.$gt) return record.captureLeaseUntil > v.$gt;
          return record[key] === v;
        });
      });
    }
    return true;
  }
  const fakeCoverage = {
    findOneAndUpdate(query, update) {
      if (!selectorAllows(query)) {
        const error = new Error('E11000 duplicate key');
        error.code = 11000;
        throw error;
      }
      for (const [key,value] of Object.entries(update.$inc || {})) record[key] += value;
      Object.assign(record, update.$set || {});
      return { lean: async () => ({ ...record }) };
    },
    async updateOne(query, update) {
      if (!selectorAllows(query)) return { matchedCount: 0 };
      Object.assign(record, update.$set || {});
      return { matchedCount: 1 };
    },
  };
  const first = new DurableAlertStream({ streamId: record._id,
    ownerId: 'first-owner', coverageModel: fakeCoverage });
  const second = new DurableAlertStream({ streamId: record._id,
    ownerId: 'second-owner', coverageModel: fakeCoverage });
  try {
    assert.equal(await first.start(), true);
    assert.equal(first.generation, 1);
    assert.equal(await second.start(), false);
    assert.equal(second.standby, true);
    assert.equal(record.generation, 1);
    assert.equal(await first.renewLease(), true);

    // Model an expired first lease and an overlapping new instance.
    record.captureLeaseUntil = new Date(0);
    assert.equal(await second.start(), true);
    assert.equal(record.generation, 2);
    assert.equal(await first.renewLease(), false);
    assert.equal(first.superseded, true);
    assert.equal(await first.restart(), false);
    assert.equal(record.generation, 2);
    assert.equal(record.captureOwnerId, 'second-owner');
  } finally {
    first.buffer = [];
    second.buffer = [];
    await first.stop();
    await second.stop();
  }
});
