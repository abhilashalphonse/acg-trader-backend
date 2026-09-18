'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateChallengeRiskForOpen } = require('../../src/modules/trading/execution-planner');

function account(overrides = {}) {
  return {
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
  };
}

test('allows new exposure while challenge remains inside limits', () => {
  assert.doesNotThrow(() => validateChallengeRiskForOpen(account()));
});

test('rejects new exposure at daily loss limit', () => {
  assert.throws(
    () => validateChallengeRiskForOpen(account({ state: { equity: '97000' } })),
    error => error.code === 'DAILY_LOSS_LIMIT_REACHED',
  );
});

test('rejects new exposure at max loss limit', () => {
  assert.throws(
    () => validateChallengeRiskForOpen(account({
      state: { dailyStartEquity: '95000', equity: '94000' },
    })),
    error => error.code === 'MAX_LOSS_LIMIT_REACHED',
  );
});

test('rejects new exposure after profit target is reached', () => {
  assert.throws(
    () => validateChallengeRiskForOpen(account({ state: { balance: '110000', equity: '110000' } })),
    error => error.code === 'PROFIT_TARGET_REACHED',
  );
});
