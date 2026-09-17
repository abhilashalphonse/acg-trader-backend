'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AtomicReverseService } = require('../../src/modules/trading/atomic-reverse.service');

function sessionQuery(value) { return { session: async received => { value.lastSession = received; return value; } }; }

function fixture() {
  const account = {
    _id: '64a000000000000000000001', status: 'ACTIVE', tradingEnabled: true, currency: 'USD', leverage: 100,
    riskPolicy: { allowedSymbols: [] },
    state: { initialBalance: '100000', balance: '100000', equity: '100090', floatingPnl: '90', realizedPnlToday: '0', usedMargin: '1100.05', freeMargin: '98989.95', dailyStartEquity: '100000' },
    async save({ session }) { this.savedSession = session; },
  };
  const original = {
    _id: '64b000000000000000000001', positionId: 'position-original', accountId: account._id, sourceOrderId: '64c000000000000000000001',
    symbol: 'EURUSD', side: 'BUY', status: 'OPEN', initialVolume: '1', openVolume: '1', entryPrice: '1.10005',
    stopLoss: null, takeProfit: null, contractSize: '100000', volumeStep: '0.01', quoteCurrency: 'USD', margin: '1100.05',
    realizedPnl: '0', commissionPaid: '0', swapPaid: '0', openedAt: new Date('2026-09-17T10:00:00Z'), trailing: { enabled: false },
    async save({ session }) { this.savedSession = session; },
  };
  const instrument = {
    symbol: 'EURUSD', status: 'ACTIVE', executionEnabled: true, quoteCurrency: 'USD', pnlCurrency: 'USD', tickSize: '0.00001',
    minVolume: '0.01', maxVolume: '100', volumeStep: '0.01', contractSize: '100000', defaultLeverage: 100, commissionPerLot: '0', maxQuoteAgeMs: 5000,
  };
  const saved = { orders: [], deals: [], positions: [], ledgers: [] };
  let sequence = 0;
  class FakeOrder {
    constructor(data) { Object.assign(this, data); this._id = `order-doc-${++sequence}`; this.orderId = `order-${sequence}`; }
    async save({ session }) { this.savedSession = session; saved.orders.push(this); }
  }
  class FakeDeal {
    constructor(data) { Object.assign(this, data); this._id = `deal-doc-${++sequence}`; this.dealId = `deal-${sequence}`; }
    async save({ session }) { this.savedSession = session; saved.deals.push(this); }
  }
  class FakePosition {
    constructor(data) { Object.assign(this, data); this._id = `position-doc-${++sequence}`; this.positionId = `position-${sequence}`; this.trailing = { enabled: false }; }
    static findById() { return sessionQuery(original); }
    async save({ session }) { this.savedSession = session; saved.positions.push(this); }
  }
  class FakeLedger {
    constructor(data) { Object.assign(this, data); this._id = `ledger-${++sequence}`; }
    async save({ session }) { this.savedSession = session; saved.ledgers.push(this); }
  }
  const accountModel = { findById: () => sessionQuery(account) };
  const instrumentModel = { findOne: () => sessionQuery(instrument) };
  return { account, original, instrument, saved, FakeOrder, FakeDeal, FakePosition, FakeLedger, accountModel, instrumentModel };
}

test('atomic reverse persists close and opposite open inside one transaction and emits after commit', async () => {
  const f = fixture();
  const transactionSession = { id: 'tx-1' };
  let transactionCalls = 0;
  let committed = false;
  const events = [];
  const service = new AtomicReverseService({
    quoteStore: { get: () => ({ symbol: 'EURUSD', bid: 1.10095, ask: 1.10105, sequence: 7, receivedAtMs: Date.now(), isStale: false, source: 'test' }) },
    eventBus: { emit(name, payload) { assert.equal(committed, true, 'events must be emitted only after transaction completion'); events.push([name, payload]); } },
    valuationEngine: { overlayAccountDocument: () => ({ complete: true }), getAccountSnapshot: () => ({ accountId: f.account._id, valuationStatus: 'LIVE' }) },
    accountModel: f.accountModel,
    instrumentModel: f.instrumentModel,
    orderModel: f.FakeOrder,
    dealModel: f.FakeDeal,
    positionModel: f.FakePosition,
    ledgerModel: f.FakeLedger,
    commandQueue: { run: async (_accountId, task) => task() },
    idempotencyService: {
      reserve: async () => ({ created: true, record: { _id: 'idem-reverse' } }),
      complete: async (_id, _payload, { session }) => { assert.equal(session, transactionSession); return true; },
      fail: async () => true,
    },
    runTransaction: async work => {
      transactionCalls += 1;
      const result = await work(transactionSession);
      committed = true;
      return result;
    },
  });

  const result = await service.reversePosition({ accountId: f.account._id, positionId: f.original._id, clientRequestId: 'reverse-atomic-1', source: 'WEB' });
  assert.equal(transactionCalls, 1);
  assert.equal(result.atomic, true);
  assert.equal(f.original.status, 'CLOSED');
  assert.equal(f.original.closeReason, 'REVERSE');
  assert.equal(f.saved.orders.length, 2);
  assert.equal(f.saved.deals.length, 2);
  assert.equal(f.saved.positions.length, 1);
  assert.equal(f.saved.positions[0].side, 'SELL');
  assert.equal(f.saved.positions[0].openVolume, '1');
  assert.equal(f.saved.orders[0].savedSession, transactionSession);
  assert.equal(f.saved.orders[1].savedSession, transactionSession);
  assert.notEqual(f.saved.orders[0].clientOrderId, f.saved.orders[1].clientOrderId);
  assert.equal(events.some(([name]) => name === 'trading.position.closed'), true);
  assert.equal(events.some(([name]) => name === 'trading.position.opened'), true);
});
