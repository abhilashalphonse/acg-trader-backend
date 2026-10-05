'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PolicyMetricsService, latencySummary } = require('../../src/modules/trading/policy-metrics.service');
const tenantId = '000000000000000000000001';
const observation = { tenantId, stage: 'EXECUTION', action: 'MARKET_OPEN', latencyMs: 12,
  decision: { allowed: false, wouldBlock: true, decisions: [{ kind: 'NEWS' }], status: { news: { dataStatus: 'FRESH' } } } };

test('metrics retry an uncertain acknowledgement without double-counting persisted observations', async () => {
  const docs = new Map();
  let attempts = 0;
  const metrics = new PolicyMetricsService({ model: { async bulkWrite(operations) {
    for (const { updateOne } of operations) docs.set(updateOne.filter._id, structuredClone(updateOne.update.$set));
    if (++attempts === 1) throw new Error('Connection lost after server applied write');
  } } });
  metrics.observe(observation);
  assert.equal(await metrics.flush(), false);
  metrics.observe(observation);
  assert.equal(await metrics.flush(), true);
  assert.equal(docs.size, 1);
  assert.equal([...docs.values()][0].evaluations, 2);
  assert.equal([...docs.values()][0].blocked, 2);
  assert.equal(metrics.health().lastError, null);
});

test('metrics preserve observations received while a flush is in flight', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const writes = [];
  const metrics = new PolicyMetricsService({ model: { async bulkWrite(operations) {
    writes.push(structuredClone(operations));
    if (writes.length === 1) await blocked;
  } } });
  metrics.observe(observation);
  const first = metrics.flush();
  assert.equal(metrics.flush(), first);
  metrics.observe(observation);
  release();
  await first;
  await metrics.flush();
  assert.equal(writes[0][0].updateOne.update.$set.evaluations, 1);
  assert.equal(writes[1][0].updateOne.update.$set.evaluations, 2);
});

test('metrics bound memory during database outages and retire flushed previous-hour groups', async () => {
  let clock = Date.UTC(2026, 9, 4, 10);
  let failed = true;
  const metrics = new PolicyMetricsService({ now: () => clock, maxGroups: 1, model: { async bulkWrite() { if (failed) throw new Error('Offline'); } } });
  metrics.observe(observation);
  await metrics.flush();
  clock += 3600000;
  metrics.observe(observation);
  assert.equal(metrics.health().dropped, 1);
  assert.equal(metrics.health().bufferedGroups, 1);
  failed = false;
  await metrics.flush();
  assert.equal(metrics.health().bufferedGroups, 0);
  metrics.observe(observation);
  assert.equal(metrics.health().bufferedGroups, 1);
});

test('latency summary reports histogram bounds rather than claiming exact quantiles', () => {
  assert.deepEqual(latencySummary({ latency0: 94, latency5: 5, latency10: 1 }).p95, { upperBoundMs: 50 });
  assert.deepEqual(latencySummary({ latency0: 98, latency10: 2 }).p99, { greaterThanMs: 1000 });
  assert.equal(latencySummary({}).p95, null);
});
