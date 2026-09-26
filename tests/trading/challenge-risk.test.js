'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateChallengeRiskForOpen } = require('../../src/modules/trading/execution-planner');

const TEST_NOW = new Date('2026-09-18T12:00:00.000Z').getTime();

function account(overrides = {}) {
  return {
    status: 'ACTIVE',
    tradingEnabled: true,
    riskProcessingState: 'READY',
    riskDayKey: '2026-09-18',
    riskTimezone: 'UTC',
    state: {
      initialBalance: '100000',
      balance: '100000',
      equity: '100000',
      dailyStartEquity: '100000',
      ...(overrides.state || {}),
    },
    riskPolicy: {
      dailyLoss: { limit: '3000', reference: 'DAILY_START_EQUITY' },
      maxLoss: { limit: '6000', reference: 'INITIAL_BALANCE' },
      profitTarget: '10000',
      ...(overrides.riskPolicy || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['state', 'riskPolicy'].includes(key))),
  };
}

test('allows new exposure while challenge remains inside limits', () => {
  assert.doesNotThrow(() => validateChallengeRiskForOpen(account(), TEST_NOW));
});

test('rejects new exposure at daily loss limit', () => {
  assert.throws(
    () => validateChallengeRiskForOpen(account({ state: { equity: '97000' } }), TEST_NOW),
    error => error.code === 'DAILY_LOSS_LIMIT_REACHED',
  );
});

test('rejects new exposure at max loss limit', () => {
  assert.throws(
    () => validateChallengeRiskForOpen(account({
      state: { dailyStartEquity: '95000', equity: '94000' },
    }), TEST_NOW),
    error => error.code === 'MAX_LOSS_LIMIT_REACHED',
  );
});

test('profit target alone does not locally block exposure because Funded owns minimum-day progression', () => {
  assert.doesNotThrow(
    () => validateChallengeRiskForOpen(account({ state: { balance: '110000', equity: '110000' } }), TEST_NOW),
  );
});

test('order execution cannot opportunistically roll the risk day forward', () => {
  const lisbon = account({
    riskDayKey: '2026-09-18',
    riskTimezone: 'Europe/Lisbon',
    state: { equity: '99000', dailyStartEquity: '100000', realizedPnlToday: '-1000' },
  });

  assert.throws(
    () => validateChallengeRiskForOpen(
      lisbon,
      new Date('2026-09-18T23:30:00.000Z').getTime(),
    ),
    error => error.code === 'RISK_DAY_ROLLOVER_PENDING'
      && error.details.accountRiskDayKey === '2026-09-18'
      && error.details.currentRiskDayKey === '2026-09-19',
  );

  assert.equal(lisbon.riskDayKey, '2026-09-18');
  assert.equal(lisbon.state.dailyStartEquity, '100000');
  assert.equal(lisbon.state.realizedPnlToday, '-1000');
});

test('unresolved risk history blocks new exposure', () => {
  assert.throws(
    () => validateChallengeRiskForOpen(account({
      riskProcessingState: 'RISK_UNRESOLVED',
      riskExpectedSequence: 104,
      riskNextAvailableSequence: 105,
    }), TEST_NOW),
    error => error.code === 'RISK_STATE_UNRESOLVED',
  );
});
