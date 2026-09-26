'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { RiskDayEngine, dayKeyInTimezone } = require('../../src/modules/trading/risk-day-engine');

test('live valuations are handed to the durable risk stream', async () => {
  const eventBus = new EventEmitter();
  const accepted = [];
  const engine = new RiskDayEngine({
    eventBus,
    riskStreamService: {
      async ingestValuation(valuation) {
        accepted.push(valuation);
        return { accepted: true };
      },
    },
  });

  engine.start();
  eventBus.emit('valuation.account.updated', {
    eventId: 'valuation-1',
    accountId: 'account-1',
    financialRevision: 4,
    complete: true,
    valuationStatus: 'LIVE',
    equity: '98750',
  });
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].eventId, 'valuation-1');
  assert.equal(accepted[0].financialRevision, 4);
});

test('stale valuation is never accepted into the durable risk stream', async () => {
  const eventBus = new EventEmitter();
  let accepted = 0;
  const engine = new RiskDayEngine({
    eventBus,
    riskStreamService: {
      async ingestValuation() { accepted += 1; },
    },
  });

  engine.start();
  eventBus.emit('valuation.account.updated', {
    eventId: 'valuation-stale',
    accountId: 'account-1',
    complete: true,
    valuationStatus: 'STALE',
    equity: '1',
  });
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.equal(accepted, 0);
});

test('stale financial revision requests a fresh account valuation', async () => {
  const eventBus = new EventEmitter();
  const revalues = [];
  const engine = new RiskDayEngine({
    eventBus,
    riskStreamService: {
      async ingestValuation() {
        const error = new Error('stale');
        error.code = 'STALE_VALUATION_REVISION';
        error.details = {
          expectedFinancialRevision: 4,
          currentFinancialRevision: 5,
        };
        throw error;
      },
    },
    valuationEngine: {
      scheduleAccountRevalue(accountId, reason) {
        revalues.push({ accountId, reason });
      },
    },
    logger: { warn() {}, error() {} },
  });

  engine.start();
  eventBus.emit('valuation.account.updated', {
    eventId: 'valuation-old-revision',
    accountId: 'account-1',
    financialRevision: 4,
    complete: true,
    valuationStatus: 'LIVE',
    equity: '99000',
  });
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.deepEqual(revalues, [{
    accountId: 'account-1',
    reason: 'stale-risk-valuation',
  }]);
});

test('risk day key follows the configured account timezone', () => {
  assert.equal(
    dayKeyInTimezone(new Date('2026-09-18T23:30:00.000Z'), 'Europe/Lisbon'),
    '2026-09-19',
  );
});
