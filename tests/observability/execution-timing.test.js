'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createExecutionTiming,
  timeAsync,
  addDuration,
  setDuration,
  setExecutionContext,
  finalizeExecutionTiming,
  serverTimingHeader,
  marketExecutionOperation,
} = require('../../src/shared/observability/execution-timing');

test('execution timing accumulates phases and emits a Server-Timing header', async () => {
  const timing = createExecutionTiming({ requestId: 'req-1', operation: 'MARKET_OPEN' });
  addDuration(timing, 'queue_wait', 2.5);
  addDuration(timing, 'queue_wait', 1.5);
  setDuration(timing, 'quote', 7.25);
  setExecutionContext(timing, { symbol: 'EURUSD', accountId: 'abc' });
  await timeAsync(timing, 'work', async () => 42);

  const snapshot = finalizeExecutionTiming(timing, { statusCode: 201 });
  assert.equal(snapshot.requestId, 'req-1');
  assert.equal(snapshot.operation, 'MARKET_OPEN');
  assert.equal(snapshot.statusCode, 201);
  assert.equal(snapshot.context.symbol, 'EURUSD');
  assert.equal(snapshot.metrics.queue_wait, 4);
  assert.equal(snapshot.metrics.quote, 7.25);
  assert.ok(snapshot.metrics.work >= 0);
  assert.ok(snapshot.metrics.request_total >= 0);

  const header = serverTimingHeader(timing);
  assert.match(header, /queue_wait;dur=4\.0/);
  assert.match(header, /quote;dur=7\.3/);
  assert.match(header, /request_total;dur=/);
});

test('market execution timing only targets market open and close mutations', () => {
  assert.equal(marketExecutionOperation({ method: 'POST', path: '/orders/market' }), 'MARKET_OPEN');
  assert.equal(marketExecutionOperation({ method: 'POST', path: '/positions/123/close' }), 'MARKET_CLOSE');
  assert.equal(marketExecutionOperation({ method: 'GET', path: '/orders/market' }), null);
  assert.equal(marketExecutionOperation({ method: 'POST', path: '/orders/pending' }), null);
});
