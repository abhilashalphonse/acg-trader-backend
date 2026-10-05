'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createOperationsRouter } = require('../../src/modules/operations/operations.routes');
const { errorHandler } = require('../../src/shared/http/error-middleware');

test('operator control route requires service authentication and derives tenant/actor from that principal', async () => {
  const calls = [];
  const app = express(); app.use(express.json());
  const metricCalls = [];
  app.use('/operations', createOperationsRouter({ enabled: true,
    policyMetricsService: { summary: async (...args) => { metricCalls.push(args); return { groups: [] }; } },
    policyControlService: { update: async input => { calls.push(input); return { revision: 1 }; } } }, {
    authenticateServiceKey: async ({ clientId, apiKey, requiredScope }) => {
      assert.equal(requiredScope, 'accounts:write');
      if (clientId !== 'operator' || apiKey !== 'test-key') throw Object.assign(new Error('Unauthorized'), { statusCode: 401, code: 'INVALID_SERVICE_KEY' });
      return { tenantId: '000000000000000000000001', clientId };
    },
  }));
  app.use(errorHandler);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/operations/enforcement-control`;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test-key', 'x-acg-client-id': 'operator' };
  const body = { expectedRevision: 0, weekendDisabled: true, reason: 'Incident investigation' };
  try {
    assert.equal((await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
    assert.equal((await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ ...body, tenantId: '000000000000000000000002' }) })).status, 400);
    assert.equal((await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ ...body, reason: '' }) })).status, 400);
    const response = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { ...body, tenantId: '000000000000000000000001', actor: 'operator' });
    const metricsUrl = url.replace('/enforcement-control', '/policy-metrics');
    assert.equal((await fetch(metricsUrl)).status, 401);
    assert.equal((await fetch(`${metricsUrl}?hours=169`, { headers })).status, 400);
    assert.equal((await fetch(`${metricsUrl}?tenantId=000000000000000000000002`, { headers })).status, 400);
    assert.equal((await fetch(`${metricsUrl}?hours=48`, { headers })).status, 200);
    assert.deepEqual(metricCalls, [['000000000000000000000001', { hours: 48 }]]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
