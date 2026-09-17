'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReconciliationService } = require('../../src/modules/operations/reconciliation.service');

function query(value) {
  return {
    sort() { return this; },
    limit() { return this; },
    lean: async () => value,
  };
}

function fixture(overrides = {}) {
  const account = {
    _id: '507f1f77bcf86cd799439011',
    tenantId: '507f191e810c19729de860ea',
    currency: 'USD',
    state: { balance: '1000', usedMargin: '100' },
  };
  const ledger = [{
    _id: '507f191e810c19729de860eb', entryId: 'entry-1', accountId: account._id, tenantId: account.tenantId,
    type: 'DEPOSIT', amount: '1000', balanceBefore: '0', balanceAfter: '1000', currency: 'USD', createdAt: new Date('2026-01-01T00:00:00Z'),
  }];
  const position = [{
    _id: '507f191e810c19729de860ec', accountId: account._id, tenantId: account.tenantId, status: 'OPEN', margin: '100',
    stopLoss: null, takeProfit: null, trailing: { enabled: false },
  }];
  const order = [{
    _id: '507f191e810c19729de860ed', orderId: 'order-1', accountId: account._id, tenantId: account.tenantId, status: 'FILLED',
  }];
  const deal = [{
    _id: '507f191e810c19729de860ee', dealId: 'deal-1', accountId: account._id, tenantId: account.tenantId,
    orderId: order[0]._id, positionId: position[0]._id,
  }];
  return { account, ledger, position, order, deal, ...overrides };
}

function serviceFor(data, options = {}) {
  const reports = [];
  const recoveryPositions = options.recoveryPositions || data.position;
  const accountModel = { find: () => query([data.account]) };
  const ledgerModel = { find: () => query(data.ledger) };
  const positionModel = { find: filter => query(filter?.status === 'OPEN' ? recoveryPositions.filter(item => item.status === 'OPEN') : data.position) };
  const orderModel = {
    find: () => query(data.order),
    countDocuments: async filter => {
      if (filter.status === 'PENDING') return options.databasePending ?? 0;
      if (filter.status === 'TRIGGERED') return options.databaseTriggered ?? 0;
      return 0;
    },
  };
  const dealModel = { find: () => query(data.deal) };
  const reportModel = {
    create: async payload => {
      const document = { _id: `report-${reports.length + 1}`, reportId: `r-${reports.length + 1}`, ...payload, createdAt: payload.completedAt };
      reports.push(document);
      return { ...document, toObject: () => ({ ...document }) };
    },
    find: () => query(reports),
  };
  const defaultProtected = recoveryPositions.filter(item => item.status === 'OPEN' && (item.stopLoss != null || item.takeProfit != null)).length;
  const defaultTrailing = recoveryPositions.filter(item => item.status === 'OPEN' && item.trailing?.enabled === true).length;
  return new ReconciliationService({
    commandQueue: { run: async (_accountId, work) => work() },
    valuationEngine: { health: () => ({ openPositions: options.recoveredOpenPositions ?? recoveryPositions.filter(item => item.status === 'OPEN').length }) },
    pendingOrderEngine: { health: () => ({ pendingOrders: options.recoveredPendingOrders ?? 0 }) },
    protectionTriggerEngine: { health: () => ({ protectedPositions: options.recoveredProtectedPositions ?? defaultProtected }) },
    trailingStopEngine: { health: () => ({ trailingPositions: options.recoveredTrailingPositions ?? defaultTrailing }) },
    accountModel, ledgerModel, positionModel, orderModel, dealModel, reportModel,
    now: (() => { let tick = 0; return () => new Date(1_700_000_000_000 + tick++ * 1000); })(),
  });
}

test('clean account reconciles ledger, margin and execution references with zero issues', async () => {
  const data = fixture();
  const service = serviceFor(data);
  const report = await service.run({ tenantId: data.account.tenantId, scope: 'MANUAL', requestedBy: 'test' });
  assert.equal(report.status, 'PASSED');
  assert.equal(report.issueCount, 0);
  assert.equal(report.checkedAccounts, 1);
});

test('reconciliation detects ledger chain, balance, margin and missing execution records without repairing state', async () => {
  const data = fixture();
  data.account.state.balance = '900';
  data.account.state.usedMargin = '50';
  data.ledger = [
    { ...data.ledger[0], amount: '500', balanceAfter: '500' },
    { ...data.ledger[0], _id: '507f191e810c19729de860ef', entryId: 'entry-2', amount: '400', balanceBefore: '600', balanceAfter: '1000' },
  ];
  data.deal = [];
  const before = JSON.stringify(data.account);
  const service = serviceFor(data);
  const report = await service.run({ tenantId: data.account.tenantId });
  const codes = new Set(report.issues.map(item => item.code));
  assert.equal(report.status, 'ISSUES');
  assert.ok(codes.has('LEDGER_CHAIN_BROKEN'));
  assert.ok(codes.has('LEDGER_BALANCE_MISMATCH'));
  assert.ok(codes.has('USED_MARGIN_MISMATCH'));
  assert.ok(codes.has('FILLED_ORDER_WITHOUT_DEAL'));
  assert.equal(JSON.stringify(data.account), before, 'reconciliation must never mutate financial state');
});

test('startup recovery verification detects incomplete in-memory recovery and persists an issue report', async () => {
  const data = fixture();
  const recoveryPositions = [
    { ...data.position[0], stopLoss: '1', trailing: { enabled: true } },
    { ...data.position[0], _id: '507f191e810c19729de860f0', stopLoss: null, takeProfit: '2', trailing: { enabled: false } },
  ];
  const service = serviceFor(data, {
    recoveryPositions,
    recoveredOpenPositions: 1,
    databasePending: 3,
    recoveredPendingOrders: 2,
    recoveredProtectedPositions: 1,
    recoveredTrailingPositions: 0,
  });
  const recovery = await service.verifyRecovery({ persist: true });
  assert.equal(recovery.consistent, false);
  const health = service.health();
  assert.equal(health.recovery.consistent, false);
  assert.equal(health.lastReport.issueCount, 4);
});

test('startup recovery verification is healthy when all recoverable engine indexes agree with MongoDB', async () => {
  const data = fixture();
  const recoveryPositions = [{ ...data.position[0], stopLoss: '0.9', trailing: { enabled: true } }];
  const service = serviceFor(data, {
    recoveryPositions,
    recoveredOpenPositions: 1,
    databasePending: 2,
    databaseTriggered: 1,
    recoveredPendingOrders: 3,
    recoveredProtectedPositions: 1,
    recoveredTrailingPositions: 1,
  });
  const recovery = await service.verifyRecovery({ persist: true });
  assert.equal(recovery.consistent, true);
  assert.equal(service.health().lastReport.issueCount, 0);
});

test('periodic reconciliation timer is observable and can be stopped cleanly', () => {
  const service = serviceFor(fixture());
  service.startPeriodic(60_000);
  assert.equal(service.health().periodic.enabled, true);
  assert.equal(service.health().periodic.intervalMs, 60_000);
  service.stopPeriodic();
  assert.equal(service.health().periodic.enabled, false);
});
