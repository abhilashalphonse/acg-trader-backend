'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  projectAccountAfterClose,
} = require('../src/modules/trading/execution-planner');
const {
  applyCloseAccountAndPositionMutation,
} = require('../src/modules/trading/market-order.service');

class FakeLedger {
  constructor(value) {
    Object.assign(this, value);
  }
}

test('GM-001 full close removes marked P&L rather than realized P&L', () => {
  const projection = projectAccountAfterClose({
    account: {
      state: {
        balance: '10000',
        floatingPnl: '1.111111111111',
        equity: '10001.111111111111',
        usedMargin: '100',
      },
    },
    realizedPnl: '1',
    commission: '0',
    markedPnlRemoved: '1.111111111111',
    releasedMargin: '100',
  });

  assert.deepEqual(projection, {
    balance: '10001',
    floatingPnl: '0',
    equity: '10001',
    usedMargin: '0',
    freeMargin: '10001',
    marginLevel: null,
  });
});

test('GM-001 partial close preserves the remaining marked contribution', () => {
  const projection = projectAccountAfterClose({
    account: {
      state: {
        balance: '10000',
        floatingPnl: '20',
        equity: '10020',
        usedMargin: '200',
      },
    },
    realizedPnl: '9',
    commission: '1',
    markedPnlRemoved: '10',
    releasedMargin: '100',
  });

  assert.equal(projection.balance, '10008');
  assert.equal(projection.floatingPnl, '10');
  assert.equal(projection.equity, '10018');
  assert.equal(projection.usedMargin, '100');
  assert.equal(projection.freeMargin, '9918');
  assert.equal(projection.marginLevel, '10018');
});

test('GM-001 committed full close is flat: floating P&L zero and equity equals balance', () => {
  const account = {
    tenantId: 'tenant-1',
    _id: 'account-1',
    currency: 'USD',
    financialRevision: 7,
    state: {
      balance: '10000',
      floatingPnl: '1.111111111111',
      equity: '10001.111111111111',
      realizedPnlToday: '0',
      usedMargin: '100',
      freeMargin: '9901.111111111111',
      marginLevel: '10001.1111111111',
    },
  };
  const position = {
    openVolume: '10',
    margin: '100',
    realizedPnl: '0',
    commissionPaid: '0',
    status: 'OPEN',
    closedAt: null,
    closeReason: null,
  };
  const plan = {
    realizedPnl: '1',
    commission: '0',
    releasedMargin: '100',
    remainingVolume: '0',
    fullClose: true,
    projectedAccountState: {
      balance: '10001',
      floatingPnl: '0',
      equity: '10001',
      usedMargin: '0',
      freeMargin: '10001',
      marginLevel: null,
    },
  };

  const ledgers = applyCloseAccountAndPositionMutation({
    account,
    position,
    plan,
    deal: { dealId: 'deal-1' },
    clientOrderId: 'close-1',
    ledgerModel: FakeLedger,
    now: new Date('2026-10-07T00:00:00.000Z'),
    valuationComplete: true,
    closeReason: 'MANUAL',
  });

  assert.equal(account.financialRevision, 8);
  assert.equal(account.state.balance, '10001');
  assert.equal(account.state.floatingPnl, '0');
  assert.equal(account.state.equity, account.state.balance);
  assert.equal(account.state.usedMargin, '0');
  assert.equal(account.state.freeMargin, '10001');
  assert.equal(position.status, 'CLOSED');
  assert.equal(position.openVolume, '0');
  assert.equal(ledgers.length, 1);
  assert.equal(ledgers[0].type, 'REALIZED_PNL');
  assert.equal(ledgers[0].balanceAfter, '10001');
});
