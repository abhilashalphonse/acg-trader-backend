'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TraderStateService } = require('../../src/realtime/trader-state.service');

const TENANT_ID = '64b000000000000000000001';
const ACCOUNT_ID = '64b000000000000000000010';

function chain(value) {
  return {
    sort() { return this; },
    limit() { return this; },
    async lean() { return value; },
  };
}

function fixtures({ account = accountFixture() } = {}) {
  const calls = {};
  const accountModel = {
    findOne(query) { calls.accountQuery = query; return { async lean() { return account; } }; },
  };
  const orderModel = {
    find(query) { calls.orderQuery = query; return chain([orderFixture()]); },
  };
  const positionModel = {
    find(query) { calls.positionQuery = query; return chain([positionFixture()]); },
  };
  const dealModel = {
    find(query) { calls.dealQuery = query; return chain([dealFixture()]); },
  };
  const valuationEngine = {
    async getOrLoadAccountSnapshot(accountId) {
      calls.valuationAccountId = accountId;
      return { accountId, balance: '100000', equity: '100125', usedMargin: '250', freeMargin: '99875', floatingPnl: '125', marginLevel: '40050', positionCount: 1, valuationStatus: 'LIVE', complete: true, staleSymbols: [] };
    },
    getPositionSnapshot(positionId) {
      calls.positionValuationId = String(positionId);
      return { id: String(positionId), accountId: ACCOUNT_ID, symbol: 'EURUSD', closePrice: '1.10125', floatingPnl: '125', valuationStatus: 'LIVE' };
    },
  };
  return { accountModel, orderModel, positionModel, dealModel, valuationEngine, calls };
}

test('snapshotAccount enforces tenant scope and returns reconnect-complete state', async () => {
  const f = fixtures();
  const service = new TraderStateService(f);
  const snapshot = await service.snapshotAccount({ tenantId: TENANT_ID, accountId: ACCOUNT_ID });

  assert.deepEqual(f.calls.accountQuery, { _id: ACCOUNT_ID, tenantId: TENANT_ID });
  assert.deepEqual(f.calls.orderQuery, { accountId: ACCOUNT_ID });
  assert.deepEqual(f.calls.positionQuery, { accountId: ACCOUNT_ID, status: 'OPEN' });
  assert.deepEqual(f.calls.dealQuery, { accountId: ACCOUNT_ID });
  assert.equal(f.calls.valuationAccountId, ACCOUNT_ID);
  assert.equal(snapshot.account.id, ACCOUNT_ID);
  assert.equal(snapshot.valuation.equity, '100125');
  assert.equal(snapshot.positions.length, 1);
  assert.equal(snapshot.positionValuations.length, 1);
  assert.equal(snapshot.positionValuations[0].floatingPnl, '125');
  assert.equal(f.calls.positionValuationId, '64b000000000000000000030');
  assert.equal(snapshot.orders.length, 1);
  assert.equal(snapshot.fills.length, 1);
  assert.equal(snapshot.orders[0].accountId, ACCOUNT_ID);
  assert.equal(snapshot.positions[0].accountId, ACCOUNT_ID);
  assert.equal(snapshot.fills[0].accountId, ACCOUNT_ID);
});

test('snapshotAccount rejects a missing tenant-owned account', async () => {
  const f = fixtures({ account: null });
  const service = new TraderStateService(f);
  await assert.rejects(
    () => service.snapshotAccount({ tenantId: TENANT_ID, accountId: ACCOUNT_ID }),
    error => error.code === 'ACCOUNT_NOT_FOUND',
  );
});

test('snapshotAccounts de-duplicates grants before querying', async () => {
  const f = fixtures();
  let accountLookups = 0;
  const original = f.accountModel.findOne;
  f.accountModel.findOne = query => { accountLookups += 1; return original(query); };
  const service = new TraderStateService(f);
  const snapshots = await service.snapshotAccounts({ tenantId: TENANT_ID, accountIds: [ACCOUNT_ID, ACCOUNT_ID] });
  assert.equal(snapshots.length, 1);
  assert.equal(accountLookups, 1);
});

function accountFixture() {
  return {
    _id: ACCOUNT_ID,
    accountCode: 'ACG-REALTIME',
    accountType: 'CHALLENGE',
    currency: 'USD',
    leverage: 100,
    status: 'ACTIVE',
    tradingEnabled: true,
    state: {
      initialBalance: '100000', balance: '100000', equity: '100000', floatingPnl: '0',
      realizedPnlToday: '0', usedMargin: '0', freeMargin: '100000', dailyStartEquity: '100000',
    },
  };
}

function orderFixture() {
  return {
    _id: '64b000000000000000000020', orderId: 'ord-1', accountId: ACCOUNT_ID,
    clientOrderId: 'client-1', symbol: 'EURUSD', side: 'BUY', type: 'MARKET', status: 'FILLED',
    requestedVolume: '1', filledVolume: '1', source: 'WEB',
  };
}

function positionFixture() {
  return {
    _id: '64b000000000000000000030', positionId: 'pos-1', accountId: ACCOUNT_ID,
    sourceOrderId: '64b000000000000000000020', symbol: 'EURUSD', side: 'BUY', status: 'OPEN',
    initialVolume: '1', openVolume: '1', entryPrice: '1.1', contractSize: '100000', volumeStep: '0.01',
    quoteCurrency: 'USD', margin: '250', realizedPnl: '0', commissionPaid: '0', swapPaid: '0',
  };
}

function dealFixture() {
  return {
    _id: '64b000000000000000000040', dealId: 'deal-1', accountId: ACCOUNT_ID,
    orderId: '64b000000000000000000020', positionId: '64b000000000000000000030', symbol: 'EURUSD',
    side: 'BUY', type: 'OPEN', volume: '1', price: '1.1', slippage: '0', commission: '0', swap: '0', realizedPnl: '0',
  };
}
