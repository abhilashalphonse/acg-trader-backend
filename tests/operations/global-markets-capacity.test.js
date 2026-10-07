'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  percentile,
  summarize,
  evaluate,
} = require('../../scripts/capacity-global-markets-preview');

test('capacity percentile uses the nearest-rank latency boundary', () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(values, 0.50), 50);
  assert.equal(percentile(values, 0.95), 100);
  assert.equal(percentile(values, 0.99), 100);
});

test('capacity summary reports latency and failure distributions', () => {
  const summary = summarize([
    { ok: true, status: 200, elapsedMs: 10, code: null },
    { ok: true, status: 200, elapsedMs: 20, code: null },
    { ok: false, status: 409, elapsedMs: 30, code: 'ACCOUNT_VALUATION_NOT_LIVE' },
    { ok: true, status: 200, elapsedMs: 40, code: null },
  ]);

  assert.equal(summary.requests, 4);
  assert.equal(summary.success, 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.errorRate, 0.25);
  assert.equal(summary.latencyMs.p50, 20);
  assert.equal(summary.latencyMs.p95, 40);
  assert.equal(summary.statusCounts['200'], 3);
  assert.equal(summary.errorCodes.ACCOUNT_VALUATION_NOT_LIVE, 1);
});

test('capacity evaluation has no invented pass threshold when none is configured', () => {
  const result = evaluate({ latencyMs: { p95: 120 }, errorRate: 0 });
  assert.equal(result.thresholdsConfigured, false);
  assert.equal(result.pass, null);
  assert.deepEqual(result.gates, []);
});
