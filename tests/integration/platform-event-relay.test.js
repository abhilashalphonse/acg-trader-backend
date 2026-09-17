'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { signEnvelope, canonicalJson, retryDelayMs } = require('../../src/modules/integration/platform-event-relay');

const SECRET = 'test-secret-at-least-16-chars';

test('platform webhook signature is deterministic and canonical', () => {
  const first = { b: 2, a: { z: 3, y: 2 }, c: [3, { q: 1, p: 2 }] };
  const second = { c: [3, { p: 2, q: 1 }], a: { y: 2, z: 3 }, b: 2 };
  assert.equal(canonicalJson(first), canonicalJson(second));
  const timestamp = '1790000000000';
  assert.equal(signEnvelope(SECRET, timestamp, first), signEnvelope(SECRET, timestamp, second));
});

test('platform webhook signature uses HMAC SHA-256', () => {
  const body = { eventId: 'acg-trader:1', aggregateId: 'funded-1', payload: { equity: '100' } };
  const timestamp = '1790000000000';
  const expected = `sha256=${crypto.createHmac('sha256', SECRET).update(`${timestamp}.${canonicalJson(body)}`).digest('hex')}`;
  assert.equal(signEnvelope(SECRET, timestamp, body), expected);
});

test('platform event retry uses capped exponential backoff', () => {
  assert.equal(retryDelayMs(1), 500);
  assert.equal(retryDelayMs(2), 1000);
  assert.equal(retryDelayMs(8), 60000);
  assert.equal(retryDelayMs(20), 60000);
});
