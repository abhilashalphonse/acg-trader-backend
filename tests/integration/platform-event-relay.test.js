'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const EventEmitter = require('events');
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
      riskDayKey: '2026-09-23',
      state: {
        balance: '95000',
        equity: '94000',
        floatingPnl: '-1000',
        usedMargin: '0',
        freeMargin: '94000',
        dailyStartEquity: '99000',
      },
      metadata: { fundedAccountId: 'FUNDED-1' },
    },
    sourceEvent: 'trading.account.breached',
    session,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.session, session);
  assert.equal(calls[0].documents[0].eventType, 'ACCOUNT_CONTROLLED');
  assert.equal(calls[0].documents[0].payload.status, 'BREACHED');
  assert.equal(calls[0].documents[0].payload.balance, '95000');
  assert.equal(calls[0].documents[0].payload.equity, '94000');
  assert.equal(calls[0].documents[0].payload.dailyStartEquity, '99000');
  assert.equal(calls[0].documents[0].payload.riskDayKey, '2026-09-23');
});


test('successful realtime snapshots are delivered directly without Mongo outbox writes', async () => {
  const eventBus = new EventEmitter();
  const outboxCreates = [];
  const deliveries = [];
  const account = {
    _id: '64b000000000000000000001',
    tenantId: '64a000000000000000000001',
    accountCode: 'ACG-1',
    externalRef: 'challenge-1',
    riskDayKey: '2026-09-18',
    state: { dailyStartEquity: '100000' },
    metadata: { fundedAccountId: 'FUNDED-1' },
  };
  const outboxModel = {
    async countDocuments() { return 0; },
    find() {
      return {
        sort() {
          return {
            async limit() { return []; },
          };
        },
      };
    },
    async create(input) { outboxCreates.push(input); return input; },
  };
  const relay = new PlatformEventRelay({
    enabled: true,
    eventBus,
    webhookUrl: 'https://funded.example.test/webhook',
    webhookSecret: 'test-secret-at-least-16-chars',
    snapshotCoalesceMs: 1,
    accountModel: { findById: () => ({ lean: async () => account }) },
    outboxModel,
    fetchImpl: async (_url, request) => {
      deliveries.push(JSON.parse(request.body));
      return { ok: true, status: 200 };
    },
  });

  await relay.start();
  eventBus.emit('valuation.account.updated', {
    accountId: String(account._id),
    accountCode: account.accountCode,
    balance: '100000',
    equity: '100100',
    usedMargin: '1000',
    freeMargin: '99100',
    floatingPnl: '100',
    positionCount: 1,
    valuationStatus: 'LIVE',
    complete: true,
    sequence: 10,
    valuedAtMs: Date.parse('2026-09-18T12:00:00.000Z'),
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  await relay.stop();

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].eventType, 'ACG_TRADER_ACCOUNT_SNAPSHOT');
  assert.equal(deliveries[0].payload.equity, '100100');
  assert.equal(outboxCreates.length, 0);
});


test('failed realtime snapshots keep at most one pending durable retry per account', async () => {
  const eventBus = new EventEmitter();
  const outboxCreates = [];
  let pendingRetry = null;
  const account = {
    _id: '64b000000000000000000001',
    tenantId: '64a000000000000000000001',
    accountCode: 'ACG-1',
    externalRef: 'challenge-1',
    riskDayKey: '2026-09-18',
    state: { dailyStartEquity: '100000' },
    metadata: { fundedAccountId: 'FUNDED-1' },
  };
  const outboxModel = {
    async countDocuments() { return 0; },
    find() {
      return {
        sort() {
          return {
            async limit() { return []; },
          };
        },
      };
    },
    findOne() {
      return {
        select() {
          return {
            async lean() { return pendingRetry; },
          };
        },
      };
    },
    async create(input) {
      outboxCreates.push(input);
      pendingRetry = { _id: 'snapshot-retry-1' };
      return input;
    },
  };
  const relay = new PlatformEventRelay({
    enabled: true,
    eventBus,
    webhookUrl: 'https://funded.example.test/webhook',
    webhookSecret: 'test-secret-at-least-16-chars',
    snapshotCoalesceMs: 1,
    accountModel: { findById: () => ({ lean: async () => account }) },
    outboxModel,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });

  await relay.start();
  for (const [sequence, equity] of [[10, '100100'], [11, '100110']]) {
    eventBus.emit('valuation.account.updated', {
      accountId: String(account._id),
      accountCode: account.accountCode,
      balance: '100000',
      equity,
      usedMargin: '1000',
      freeMargin: '99100',
      floatingPnl: '100',
      positionCount: 1,
      valuationStatus: 'LIVE',
      complete: true,
      sequence,
      valuedAtMs: Date.parse('2026-09-18T12:00:00.000Z') + sequence,
    });
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.equal(outboxCreates.length, 1);
  assert.equal(relay.health().snapshotRetryPending, 1);
  assert.equal(relay.health().snapshotCoalesceMs, 1);
  await relay.stop();
});


test('dead outbox health is classified by event type', async () => {
  const outboxModel = {
    async countDocuments(query) {
      assert.deepEqual(query, { status: 'DEAD' });
      return 26;
    },
    async aggregate(pipeline) {
      assert.deepEqual(pipeline, [
        { $match: { status: 'DEAD' } },
        { $group: { _id: '$eventType', count: { $sum: 1 } } },
      ]);
      return [
        { _id: 'ACCOUNT_SNAPSHOT', count: 20 },
        { _id: 'DEAL_CREATED', count: 4 },
        { _id: 'ACCOUNT_CONTROLLED', count: 2 },
      ];
    },
    find(query) {
      if (query?.status === 'DEAD') {
        return {
          select() {
            return {
              sort() {
                return {
                  async lean() {
                    return [
                      {
                        eventId: 'deal-event-1',
                        aggregateId: 'FUNDED-1',
                        accountId: '64b000000000000000000001',
                        eventType: 'DEAL_CREATED',
                        occurredAt: new Date('2026-09-18T12:00:00.000Z'),
                        attempts: 12,
                        lastError: 'HTTP 503',
                        payload: { dealId: 'deal-1', platformAccountId: '64b000000000000000000001' },
                      },
                    ];
                  },
                };
              },
            };
          },
        };
      }
      return {
        sort() {
          return {
            async limit() { return []; },
          };
        },
      };
    },
  };
  const warnings = [];

  const relay = new PlatformEventRelay({
    enabled: true,
    eventBus: new EventEmitter(),
    webhookUrl: 'https://funded.example.test/webhook',
    webhookSecret: SECRET,
    outboxModel,
    logger: { warn(payload, message) { warnings.push({ payload, message }); } },
  });

  await relay.start();
  assert.equal(relay.health().deadEvents, 26);
  assert.deepEqual(relay.health().deadEventsByType, {
    ACCOUNT_SNAPSHOT: 20,
    DEAL_CREATED: 4,
    ACCOUNT_CONTROLLED: 2,
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, 'Dead immutable platform events require review before replay');
  assert.equal(warnings[0].payload.deadImmutableEvents[0].eventId, 'deal-event-1');
  assert.equal(warnings[0].payload.deadImmutableEvents[0].dealId, 'deal-1');
  await relay.stop();
});
