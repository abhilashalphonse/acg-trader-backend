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
