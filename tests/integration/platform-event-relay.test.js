'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { PlatformEventRelay, signEnvelope, canonicalJson, retryDelayMs } = require('../../src/modules/integration/platform-event-relay');

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


test('deal facts are inserted into the outbox with the caller transaction session', async () => {
  const calls = [];
  const session = { id: 'tx-1' };
  const relay = new PlatformEventRelay({
    enabled: true,
    eventBus: { on() {}, off() {} },
    webhookUrl: 'https://funded.example.test/webhook',
    webhookSecret: 'test-secret-at-least-16-chars',
    outboxModel: {
      async create(documents, options) {
        calls.push({ documents, options });
        return [{ ...documents[0], eventId: 'evt-1' }];
      },
    },
  });

  const result = await relay.enqueueDeal({
    account: {
      _id: '64b000000000000000000001',
      tenantId: '64a000000000000000000001',
      externalRef: 'challenge-1',
      metadata: new Map([['fundedAccountId', 'FUNDED-1'], ['challengePhase', 'PHASE_1']]),
    },
    deal: {
      dealId: 'deal-1',
      positionId: 'position-1',
      symbol: 'EURUSD',
      side: 'BUY',
      type: 'OPEN',
      volume: '1',
      price: '1.1',
      realizedPnl: '0',
      commission: '0',
      executedAt: new Date('2026-09-18T12:00:00.000Z'),
    },
    session,
  });

  assert.equal(result.eventId, 'evt-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.session, session);
  assert.equal(calls[0].documents[0].eventType, 'DEAL_CREATED');
  assert.equal(calls[0].documents[0].aggregateId, 'FUNDED-1');
});

test('account control facts are inserted transactionally', async () => {
  const calls = [];
  const session = { id: 'tx-control' };
  const relay = new PlatformEventRelay({
    enabled: true,
    eventBus: { on() {}, off() {} },
    webhookUrl: 'https://funded.example.test/webhook',
    webhookSecret: 'test-secret-at-least-16-chars',
    outboxModel: {
      async create(documents, options) {
        calls.push({ documents, options });
        return documents;
      },
    },
  });

  await relay.enqueueControl({
    account: {
      _id: '64b000000000000000000001',
      tenantId: '64a000000000000000000001',
      externalRef: 'challenge-1',
      status: 'BREACHED',
      tradingEnabled: false,
      metadata: { fundedAccountId: 'FUNDED-1' },
    },
    sourceEvent: 'trading.account.breached',
    session,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.session, session);
  assert.equal(calls[0].documents[0].eventType, 'ACCOUNT_CONTROLLED');
  assert.equal(calls[0].documents[0].payload.status, 'BREACHED');
});
