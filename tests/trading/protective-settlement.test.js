'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyCloseAccountAndPositionMutation,
  normalizeCloseReason,
} = require('../../src/modules/trading/market-order.service');

class FakeLedger {
  constructor(value) { Object.assign(this, value); }
}

test('protective close realizes floating PnL without double-counting equity', () => {
  const account = {
    _id: '507f1f77bcf86cd799439011',
    currency: 'USD',
    state: {
      balance: '10000',
      floatingPnl: '100',
      equity: '10100',
      realizedPnlToday: '0',
      usedMargin: '1100',
      freeMargin: '9000',
    },
  };
  const position = {
    openVolume: '1',
    margin: '1100',
    realizedPnl: '0',
    commissionPaid: '0',
    status: 'OPEN',
    closedAt: null,
    closeReason: null,
  };
  const plan = {
    realizedPnl: '100',
    commission: '0',
    releasedMargin: '1100',
    remainingVolume: '0',
    fullClose: true,
  };

  const ledgers = applyCloseAccountAndPositionMutation({
    account,
    position,
    plan,
    deal: { dealId: 'deal-1' },
    clientOrderId: 'protect:sl:test',
    ledgerModel: FakeLedger,
    now: new Date('2026-09-16T05:00:00Z'),
    valuationComplete: true,
    closeReason: 'STOP_LOSS',
  });

  assert.equal(account.state.balance, '10100');
  assert.equal(account.state.floatingPnl, '0');
  assert.equal(account.state.equity, '10100');
  assert.equal(account.state.usedMargin, '0');
  assert.equal(account.state.freeMargin, '10100');
  assert.equal(position.status, 'CLOSED');
  assert.equal(position.closeReason, 'STOP_LOSS');
  assert.equal(ledgers.length, 1);
  assert.equal(ledgers[0].type, 'REALIZED_PNL');
});

test('only STOP_LOSS and TAKE_PROFIT are valid internal protective close reasons', () => {
  assert.equal(normalizeCloseReason('stop_loss'), 'STOP_LOSS');
  assert.equal(normalizeCloseReason('take_profit'), 'TAKE_PROFIT');
  assert.equal(normalizeCloseReason(null), null);
  assert.throws(() => normalizeCloseReason('manual'), error => error.code === 'INVALID_CLOSE_REASON');
});
