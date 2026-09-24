'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { ChallengeRiskEngine } = require('../../src/modules/trading/challenge-risk-engine');

test('live valuation crossing max loss triggers local account breach', async () => {
  const eventBus = new EventEmitter();
  const account = {
    _id: '64b000000000000000000001',
    status: 'ACTIVE',
    tradingEnabled: true,
    riskDayKey: '2026-09-18',
    riskTimezone: 'UTC',
    state: { initialBalance: '100000', dailyStartEquity: '100000' },
    riskPolicy: {
      dailyLoss: { limit: '3000' },
      maxLoss: { limit: '6000' },
    },
  };
  const breaches = [];
  const engine = new ChallengeRiskEngine({
    eventBus,
    accountModel: {
      findById: () => ({ lean: async () => account }),
    },
    accountControlService: {
      async breach(accountId, options) { breaches.push({ accountId, options }); },
    },
    now: () => new Date('2026-09-18T12:00:00.000Z'),
  });

  engine.start();
  eventBus.emit('valuation.account.updated', {
    accountId: String(account._id),
    complete: true,
    valuationStatus: 'LIVE',
    equity: '94000',
  });
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].accountId, String(account._id));
  assert.equal(breaches[0].options.reason, 'MAX_LOSS_LIMIT_REACHED');
  assert.equal(breaches[0].options.evidence.rule, 'MAX_DRAWDOWN');
  assert.deepEqual(breaches[0].options.evidence.triggeredRules, ['DAILY_DRAWDOWN', 'MAX_DRAWDOWN']);
  assert.equal(breaches[0].options.evidence.equity, '94000');
  assert.equal(breaches[0].options.evidence.thresholdEquity, '94000');
  assert.equal(breaches[0].options.evidence.actualLoss, '6000');
  assert.equal(breaches[0].options.evidence.breachAmount, '0');
});

test('daily-only breach captures the exact live trigger valuation', async () => {
  const eventBus = new EventEmitter();
  const account = {
    _id: '64b000000000000000000002',
    status: 'ACTIVE',
    tradingEnabled: true,
    riskDayKey: '2026-09-18',
    riskTimezone: 'UTC',
    state: { initialBalance: '50000', dailyStartEquity: '50798.12' },
    riskPolicy: {
      dailyLoss: { limit: '1500' },
      maxLoss: { limit: '3000' },
    },
  };
  const breaches = [];
  const engine = new ChallengeRiskEngine({
    eventBus,
    accountModel: { findById: () => ({ lean: async () => account }) },
    accountControlService: {
      async breach(accountId, options) { breaches.push({ accountId, options }); },
    },
    now: () => new Date('2026-09-18T12:00:00.000Z'),
  });

  engine.start();
  eventBus.emit('valuation.account.updated', {
    accountId: String(account._id),
    complete: true,
    valuationStatus: 'LIVE',
    balance: '51231.26',
    equity: '49298.00',
    floatingPnl: '-1933.26',
    usedMargin: '1250',
    freeMargin: '48048',
    sequence: 88,
    valuedAtMs: Date.parse('2026-09-18T12:00:00.123Z'),
  });
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.equal(breaches.length, 1);
  const evidence = breaches[0].options.evidence;
  assert.equal(breaches[0].options.reason, 'DAILY_LOSS_LIMIT_REACHED');
  assert.deepEqual(evidence.triggeredRules, ['DAILY_DRAWDOWN']);
  assert.equal(evidence.balance, '51231.26');
  assert.equal(evidence.equity, '49298');
  assert.equal(evidence.floatingPnl, '-1933.26');
  assert.equal(evidence.thresholdEquity, '49298.12');
  assert.equal(evidence.actualLoss, '1500.12');
  assert.equal(evidence.breachAmount, '0.12');
  assert.equal(evidence.valuationSequence, 88);
});

test('stale valuation never triggers a challenge breach', async () => {
  const eventBus = new EventEmitter();
  let breaches = 0;
  const engine = new ChallengeRiskEngine({
    eventBus,
    accountModel: { findById: () => ({ lean: async () => null }) },
    accountControlService: { async breach() { breaches += 1; } },
  });

  engine.start();
  eventBus.emit('valuation.account.updated', {
    accountId: '64b000000000000000000001',
    complete: true,
    valuationStatus: 'STALE',
    equity: '1',
  });
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.equal(breaches, 0);
});
