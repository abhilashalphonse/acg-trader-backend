'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPayoutSettlementCheckpoint } = require('../../src/modules/trading/payout-settlement-checkpoint');

const NOW = new Date('2026-10-08T09:00:00.000Z');
function account(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    currency: 'USD',
    status: 'PAUSED',
    tradingEnabled: false,
    riskProcessingState: 'RESOLVED',
    marginStopOutState: 'NONE',
    riskSequence: 11,
    lastEvaluatedRiskSequence: 11,
    financialRevision: 15,
    state: {
      initialBalance: '10000',
      balance: '10500.12',
      equity: '10500.12',
      floatingPnl: '0',
      usedMargin: '0',
    },
    ...overrides,
  };
}
const ledger = { entryId: 'ledger-15', balanceAfter: '10500.12' };
const check = overrides => buildPayoutSettlementCheckpoint({
  account: account(overrides?.account),
  openPositionCount: overrides?.positions ?? 0,
  activeOrderCount: overrides?.orders ?? 0,
  lastLedger: overrides?.ledger === undefined ? ledger : overrides.ledger,
  checkedAt: NOW,
});

test('settled paused USD account requires zero open positions, zero orders, matching ledger and risk revision', () => {
  const c = check();
  assert.equal(c.settled, true);
  assert.equal(c.financialRevision, 15);
  assert.equal(c.balance, '10500.12');
  assert.equal(c.accountCurrency, 'USD');
  assert.equal(c.ledgerEntryId, 'ledger-15');
  assert.equal(c.productionPayoutAuthorized, false);
  assert.match(c.evidenceHash, /^[a-f0-9]{64}$/);
});

test('a live trading account is not an approvable payout settlement', () => {
  const c = check({ account: { tradingEnabled: true, status: 'ACTIVE' } });
  assert.equal(c.settled, false);
  assert.ok(c.blockers.includes('TRADING_NOT_PAUSED'));
});

test('ledger mismatch, open position, active order and lagging risk each block approval', () => {
  const c = check({
    positions: 1,
    orders: 1,
    ledger: { entryId: 'old', balanceAfter: '10499' },
    account: { riskSequence: 12, lastEvaluatedRiskSequence: 11 },
  });
  assert.equal(c.settled, false);
  assert.ok(c.blockers.includes('OPEN_POSITIONS_REMAIN'));
  assert.ok(c.blockers.includes('ACTIVE_ORDERS_REMAIN'));
  assert.ok(c.blockers.includes('LEDGER_BALANCE_NOT_RECONCILED'));
  assert.ok(c.blockers.includes('RISK_SEQUENCE_NOT_ACKNOWLEDGED'));
});

test('flat-account balance/equity/floating invariant is mandatory', () => {
  const c = check({ account: {
    state: {
      initialBalance: '10000',
      balance: '10500.12',
      equity: '10500.13',
      floatingPnl: '0.01',
      usedMargin: '0',
    },
  } });
  assert.equal(c.settled, false);
  assert.ok(c.blockers.includes('FLAT_ACCOUNT_FINANCIAL_INVARIANT_FAILED'));
});

test('evidence hash is stable for same revision independent of observation time', () => {
  const a = check();
  const b = buildPayoutSettlementCheckpoint({
    account: account(), openPositionCount: 0, activeOrderCount: 0,
    lastLedger: ledger, checkedAt: new Date(NOW.getTime() + 300),
  });
  assert.equal(a.evidenceHash, b.evidenceHash);
});
