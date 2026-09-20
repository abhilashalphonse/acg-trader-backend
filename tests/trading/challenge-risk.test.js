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

test('profit target alone does not locally block exposure because Funded owns minimum-day progression', () => {
  assert.doesNotThrow(
    () => validateChallengeRiskForOpen(account({ state: { balance: '110000', equity: '110000' } })),
  );
});


test('order-time risk-day rollover follows account timezone rather than UTC', () => {
  const lisbon = account({
    state: { equity: '99000', dailyStartEquity: '100000', realizedPnlToday: '-1000' },
  });
  lisbon.riskDayKey = '2026-09-18';
  lisbon.riskTimezone = 'Europe/Lisbon';

  validateChallengeRiskForOpen(
    lisbon,
    null,
    new Date('2026-09-18T23:30:00.000Z').getTime(),
  );

  assert.equal(lisbon.riskDayKey, '2026-09-19');
  assert.equal(lisbon.state.dailyStartEquity, '99000');
  assert.equal(lisbon.state.realizedPnlToday, '0');

  const newYork = account({
    state: { equity: '99000', dailyStartEquity: '100000', realizedPnlToday: '-1000' },
  });
  newYork.riskDayKey = '2026-09-18';
  newYork.riskTimezone = 'America/New_York';

  validateChallengeRiskForOpen(
    newYork,
    null,
    new Date('2026-09-19T00:30:00.000Z').getTime(),
  );

  assert.equal(newYork.riskDayKey, '2026-09-18');
  assert.equal(newYork.state.dailyStartEquity, '100000');
  assert.equal(newYork.state.realizedPnlToday, '-1000');
});
