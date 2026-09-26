'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostFillRiskService } = require('../../src/modules/trading/post-fill-risk.service');
const { validateAccountForOpen } = require('../../src/modules/trading/execution-planner');

function captureModel(target) {
  return class {
    constructor(input) { Object.assign(this, input); this._id = input._id || `id-${target.length + 1}`; }
    async save({ session } = {}) { this.savedSession = session || null; target.push(this); return this; }
  };
}

function breachedAccount() {
  return {
    _id: '64b000000000000000000001',
    tenantId: '64b000000000000000000099',
    status: 'ACTIVE',
    tradingEnabled: true,
    financialRevision: 8,
    riskSequence: 0,
    lastEvaluatedRiskSequence: 0,
    riskDayKey: '2026-09-26',
    riskTimezone: 'UTC',
    metadata: new Map([['riskPolicyVersion', 'ACG_FUNDED_V1']]),
    riskPolicy: {
      dailyLoss: { limit: '3000' },
      maxLoss: { limit: '6000' },
      breachAction: 'LIQUIDATE_AND_LOCK',
    },
    state: {
      initialBalance: '100000',
      balance: '99990',
      floatingPnl: '-3000.50',
      equity: '96989.50',
      usedMargin: '5000',
      freeMargin: '91989.50',
      marginLevel: '1939.79',
      dailyStartEquity: '100000',
    },
  };
}

test('affordable post-fill state can atomically become a terminal challenge breach with durable cleanup work', async () => {
  const riskEvents = [];
  const lifecycle = [];
  const cleanup = [];
  const platform = [];
  const session = { id: 'same-mongo-transaction' };
  const account = breachedAccount();

  const service = new PostFillRiskService({
    riskEventModel: captureModel(riskEvents),
    lifecycleModel: captureModel(lifecycle),
    cleanupJobModel: captureModel(cleanup),
    platformEventRelay: {
      async enqueueControl(input) { platform.push(input); return { id: 'outbox-1' }; },
    },
    now: () => new Date('2026-09-26T20:00:00.000Z'),
  });

  const order = { _id: '64b000000000000000000010', orderId: 'order-atomic-breach' };
  const deal = {
    _id: '64b000000000000000000011',
    quoteSequence: 901,
    quoteReceivedAt: new Date('2026-09-26T20:00:00.000Z'),
  };

  const result = await service.evaluateAndApply({ account, order, deal, session });

  assert.equal(result.breached, true);
  assert.equal(result.outcome.reason, 'DAILY_LOSS_LIMIT_REACHED');
  assert.equal(account.status, 'BREACHED');
  assert.equal(account.tradingEnabled, false);
  assert.equal(account.riskSequence, 1);
  assert.equal(account.lastEvaluatedRiskSequence, 1);
  assert.equal(riskEvents.length, 1);
  assert.equal(riskEvents[0].type, 'EXECUTION_RESULT');
  assert.equal(riskEvents[0].state, 'BREACHED');
  assert.equal(riskEvents[0].financialRevision, 8);
  assert.equal(riskEvents[0].savedSession, session);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].type, 'BREACHED');
  assert.equal(lifecycle[0].savedSession, session);
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0].state, 'PENDING');
  assert.equal(cleanup[0].breachAction, 'LIQUIDATE_AND_LOCK');
  assert.equal(cleanup[0].savedSession, session);
  assert.equal(platform.length, 1);
  assert.equal(platform[0].session, session);
  assert.equal(platform[0].evidence.equity, '96989.5');

  assert.throws(
    () => validateAccountForOpen(account, 'EURUSD', Date.parse('2026-09-26T20:00:00.000Z')),
    error => error.code === 'ACCOUNT_NOT_ACTIVE',
  );
});

test('non-breaching post-fill state is synchronously recorded as evaluated without cleanup work', async () => {
  const riskEvents = [];
  const lifecycle = [];
  const cleanup = [];
  const account = breachedAccount();
  account.state.floatingPnl = '-500';
  account.state.equity = '99490';
  account.state.freeMargin = '94490';

  const service = new PostFillRiskService({
    riskEventModel: captureModel(riskEvents),
    lifecycleModel: captureModel(lifecycle),
    cleanupJobModel: captureModel(cleanup),
  });

  const result = await service.evaluateAndApply({
    account,
    order: { _id: 'o1', orderId: 'safe-order' },
    deal: { _id: 'd1', quoteSequence: 2, quoteReceivedAt: new Date() },
    session: { id: 'tx' },
  });

  assert.equal(result.breached, false);
  assert.equal(account.status, 'ACTIVE');
  assert.equal(account.tradingEnabled, true);
  assert.equal(riskEvents[0].state, 'EVALUATED');
  assert.equal(cleanup.length, 0);
  assert.equal(lifecycle.length, 0);
});
