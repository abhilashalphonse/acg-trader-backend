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

test('system close reasons include stop loss, take profit and margin stop-out', () => {
  assert.equal(normalizeCloseReason('stop_loss'), 'STOP_LOSS');
  assert.equal(normalizeCloseReason('take_profit'), 'TAKE_PROFIT');
  assert.equal(normalizeCloseReason('margin_stop_out'), 'MARGIN_STOP_OUT');
  assert.equal(normalizeCloseReason(null), null);
  assert.throws(() => normalizeCloseReason('manual'), error => error.code === 'INVALID_CLOSE_REASON');
});


test('full close removes marked PnL instead of realized PnL when execution differs from mark', () => {
  const account = {
    _id: '507f1f77bcf86cd799439011',
    currency: 'USD',
    financialRevision: 7,
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
    realizedPnl: '90',
    markedClosedPnl: '100',
    commission: '1',
    releasedMargin: '1100',
    remainingVolume: '0',
    fullClose: true,
  };

  applyCloseAccountAndPositionMutation({
    account,
    position,
    plan,
    deal: { dealId: 'deal-execution-adjustment' },
    clientOrderId: 'close:execution-adjustment',
    ledgerModel: FakeLedger,
    now: new Date('2026-10-07T00:00:00Z'),
    valuationComplete: true,
    closeReason: 'MANUAL',
  });

  assert.equal(account.state.balance, '10089');
  assert.equal(account.state.floatingPnl, '0');
  assert.equal(account.state.equity, '10089');
  assert.equal(account.state.usedMargin, '0');
  assert.equal(account.state.freeMargin, '10089');
  assert.equal(account.financialRevision, 8);
});

test('partial close removes only the marked contribution of the closed quantity', () => {
  const account = {
    _id: '507f1f77bcf86cd799439011',
    currency: 'USD',
    state: {
      balance: '10000',
      floatingPnl: '100',
      equity: '10100',
      realizedPnlToday: '0',
      usedMargin: '1000',
      freeMargin: '9100',
    },
  };
  const position = {
    openVolume: '2',
    margin: '1000',
    realizedPnl: '0',
    commissionPaid: '0',
    status: 'OPEN',
    closedAt: null,
    closeReason: null,
  };
  const plan = {
    realizedPnl: '45',
    markedClosedPnl: '50',
    commission: '1',
    releasedMargin: '500',
    remainingVolume: '1',
    fullClose: false,
  };

  applyCloseAccountAndPositionMutation({
    account,
    position,
    plan,
    deal: { dealId: 'deal-partial' },
    clientOrderId: 'close:partial',
    ledgerModel: FakeLedger,
    now: new Date('2026-10-07T00:00:00Z'),
    valuationComplete: true,
    closeReason: 'MANUAL',
  });

  assert.equal(account.state.balance, '10044');
  assert.equal(account.state.floatingPnl, '50');
  assert.equal(account.state.equity, '10094');
  assert.equal(account.state.usedMargin, '500');
  assert.equal(account.state.freeMargin, '9594');
  assert.equal(position.openVolume, '1');
  assert.equal(position.status, 'OPEN');
});
