'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IdempotencyService, hashCommandPayload, canonicalize } = require('../../src/modules/trading/idempotency.service');

test('idempotency hash is stable across object key order', () => {
  const first = {
    symbol: 'EURUSD',
    side: 'BUY',
    volume: '0.37',
    protection: { stopLoss: '1.1500', takeProfit: '1.1600' },
  };
  const second = {
    protection: { takeProfit: '1.1600', stopLoss: '1.1500' },
    volume: '0.37',
    side: 'BUY',
    symbol: 'EURUSD',
  };

  assert.equal(hashCommandPayload(first), hashCommandPayload(second));
});

test('idempotency hash changes when trading intent changes', () => {
  const buy = hashCommandPayload({ symbol: 'EURUSD', side: 'BUY', volume: '1' });
  const sell = hashCommandPayload({ symbol: 'EURUSD', side: 'SELL', volume: '1' });
  assert.notEqual(buy, sell);
});

test('canonicalization normalizes Date and bigint values', () => {
  const canonical = canonicalize({
    when: new Date('2026-09-16T04:00:00.000Z'),
    sequence: 12n,
  });
  assert.deepEqual(canonical, {
    sequence: '12',
    when: '2026-09-16T04:00:00.000Z',
  });
});


test('retryable failed idempotency record is atomically reopened', async () => {
  const payload = { symbol: 'EURUSD', side: 'BUY', volume: '1' };
  const record = {
    _id: 'idem-1',
    requestHash: hashCommandPayload(payload),
    state: 'FAILED',
    retryable: true,
    leaseExpiresAt: null,
  };
  const model = {
    async create() { const error = new Error('duplicate'); error.code = 11000; throw error; },
    async findOne() { return record; },
    async findOneAndUpdate(_filter, update) {
      Object.assign(record, update.$set);
      return record;
    },
  };
  const service = new IdempotencyService({ model, now: () => new Date('2026-09-18T12:00:00.000Z') });
  const result = await service.reserve({ accountId: 'a1', scope: 'MARKET_OPEN', key: 'order-1', payload });
  assert.equal(result.created, true);
  assert.equal(result.recovered, true);
  assert.equal(result.record.state, 'IN_PROGRESS');
  assert.equal(result.record.retryable, false);
});

test('stale in-progress idempotency lease can be recovered after a process crash', async () => {
  const payload = { symbol: 'EURUSD', side: 'SELL', volume: '1' };
  const record = {
    _id: 'idem-2',
    requestHash: hashCommandPayload(payload),
    state: 'IN_PROGRESS',
    retryable: false,
    leaseExpiresAt: new Date('2026-09-18T11:00:00.000Z'),
  };
  const model = {
    async create() { const error = new Error('duplicate'); error.code = 11000; throw error; },
    async findOne() { return record; },
    async findOneAndUpdate(_filter, update) {
      Object.assign(record, update.$set);
      return record;
    },
  };
  const service = new IdempotencyService({ model, now: () => new Date('2026-09-18T12:00:00.000Z') });
  const result = await service.reserve({ accountId: 'a1', scope: 'MARKET_OPEN', key: 'order-2', payload });
  assert.equal(result.created, true);
  assert.equal(result.recovered, true);
  assert.ok(result.record.leaseExpiresAt > new Date('2026-09-18T12:00:00.000Z'));
});
