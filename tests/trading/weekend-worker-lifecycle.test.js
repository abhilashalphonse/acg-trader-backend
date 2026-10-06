'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WeekendActionService, confirmationIsLate } = require('../../src/modules/trading/weekend-action.service');

test('weekend shutdown finishes existing claims without draining additional jobs', async () => {
  let claims = 0;
  let completed = 0;
  let releaseWrites;
  const writes = new Promise(resolve => { releaseWrites = resolve; });
  let enteredBoth;
  const bothEntered = new Promise(resolve => { enteredBoth = resolve; });
  const worker = new WeekendActionService({
    policyService: { config: { weekendEnforcementEnabled: true } },
    concurrency: 2,
    jobsPerWorker: 32,
    now: () => 10000,
    actionModel: {
      findOneAndUpdate() {
        const id = ++claims;
        return { lean: async () => ({ _id: String(id), generation: 1, marketCloseAt: new Date(0) }) };
      },
      async updateOne(claim, update) {
        assert.equal(update.$set.state, 'MISSED');
        if (claims === 2) enteredBoth();
        await writes;
        completed++;
      },
    },
  });
  const running = worker.runDue();
  assert.equal(worker.runDue(), running, 'overlapping polls share the current batch');
  await bothEntered;
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, 'shutdown waits for outstanding claim writes');
  releaseWrites();
  await stopping;
  assert.equal(completed, 2);
  assert.equal(claims, 2, 'shutdown must not drain the rest of the batch');
  await worker.runDue();
  assert.equal(claims, 2, 'a late poll cannot claim work after shutdown');
});

test('weekend confirmation is late only after the actual market-close deadline', () => {
  const marketCloseAt = new Date('2026-10-09T22:00:00.000Z');
  assert.equal(confirmationIsLate(new Date('2026-10-09T21:55:02.000Z'), marketCloseAt), false);
  assert.equal(confirmationIsLate(new Date('2026-10-09T21:59:59.999Z'), marketCloseAt), false);
  assert.equal(confirmationIsLate(new Date('2026-10-09T22:00:00.001Z'), marketCloseAt), true);
});

test('weekend summary treats only past market close as overdue flat', async () => {
  let pipeline;
  const worker = new WeekendActionService({
    policyService: { config: { weekendEnforcementEnabled: true } },
    now: () => Date.parse('2026-10-09T21:55:30.000Z'),
    actionModel: {
      async aggregate(value) {
        pipeline = value;
        return [{ states: [], overdueFlat: [], lateConfirmed: [] }];
      },
    },
  });

  const result = await worker.summary('000000000000000000000001');
  assert.equal(result.overdueFlat, 0);

  const serialized = JSON.stringify(pipeline);
  assert.match(serialized, /marketCloseAt/);
  assert.doesNotMatch(serialized, /"requiredFlatAt":\{"\$lte"/);
});

test('weekend worker preflights executable quote before issuing protective closes', async () => {
  const nowMs = Date.parse('2026-10-09T21:55:00.000Z');
  const instrument = {
    symbol: 'EURUSD',
    scheduleVersion: 1,
    timezone: 'UTC',
    tradingSessions: [],
    tradingHolidays: [],
    sessionOverrides: [],
  };
  const { scheduleHash } = require('../../src/modules/instruments/schedule-identity');
  const hash = scheduleHash(instrument);
  const account = {
    _id: '000000000000000000000001',
    tenantId: '000000000000000000000002',
    tradingPermissionsVersion: 1,
    tradingPermissions: { weekendHolding: false },
    executionRestrictions: [],
    async save() {},
  };
  const job = {
    _id: 'weekend-preflight-test',
    tenantId: account.tenantId,
    accountId: account._id,
    symbol: 'EURUSD',
    permissionVersion: 1,
    scheduleVersion: 1,
    scheduleHash: hash,
    marketCloseAt: new Date(nowMs + 5 * 60_000),
    processingStartAt: new Date(nowMs),
    requiredFlatAt: new Date(nowMs),
    reopenAt: new Date(nowMs + 2 * 86400000),
    generation: 1,
  };

  let claimed = false;
  let closeCalls = 0;
  let retryWrite = null;
  const actionModel = {
    findOneAndUpdate(filter) {
      const isClaim = filter?.mode === 'ENFORCED';
      return {
        lean: async () => {
          if (!isClaim) return job;
          if (claimed) return null;
          claimed = true;
          return job;
        },
      };
    },
    async updateOne(filter, update) {
      if (update?.$set?.state === 'RETRYING') retryWrite = update.$set;
      return { matchedCount: 1 };
    },
  };
  const chain = value => ({
    session() { return this; },
    select() { return this; },
    lean: async () => value,
  });

  const worker = new WeekendActionService({
    policyService: {
      config: { weekendEnforcementEnabled: true },
      policyStatus: async () => ({ enforcement: { weekendEnabled: true } }),
    },
    marketOrderService: {
      async ensureExecutableQuote() {
        const error = new Error('No live quote is available for this symbol');
        error.code = 'QUOTE_UNAVAILABLE';
        throw error;
      },
      async closeMarketPosition() { closeCalls += 1; },
    },
    pendingOrderService: { async cancelPendingOrder() {} },
    now: () => nowMs,
    actionModel,
    accountModel: { findById: () => chain(account) },
    instrumentModel: { findOne: () => chain(instrument) },
    positionModel: {
      find: () => chain([{ _id: '000000000000000000000003' }]),
      countDocuments: () => chain(1),
    },
    orderModel: {
      find: () => chain([]),
      countDocuments: () => chain(0),
    },
    runTransaction: async work => work(null),
    concurrency: 1,
    jobsPerWorker: 1,
  });

  await worker.runDue();

  assert.equal(closeCalls, 0, 'protective close is not reserved/executed without a valid quote');
  assert.equal(retryWrite?.state, 'RETRYING');
  assert.equal(retryWrite?.lastError, 'QUOTE_UNAVAILABLE');
});

