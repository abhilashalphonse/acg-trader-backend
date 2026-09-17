'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PendingOrderAmendService } = require('../../src/modules/trading/pending-order-amend.service');

function query(value) { return { session: async () => value }; }
function idempotency() {
  return {
    reserve: async () => ({ created: true, inProgress: false, record: { _id: 'idem-1' } }),
    complete: async () => true,
    fail: async () => true,
  };
}

function account() {
  return {
    _id: '64a000000000000000000001',
    status: 'ACTIVE', tradingEnabled: true, currency: 'USD', leverage: 100, riskTimezone: 'UTC',
    riskPolicy: { allowedSymbols: [] },
  };
}
function instrument() {
  return {
    symbol: 'EURUSD', status: 'ACTIVE', executionEnabled: true, quoteCurrency: 'USD', tickSize: '0.00001',
    minVolume: '0.01', maxVolume: '100', volumeStep: '0.01', contractSize: '100000', defaultLeverage: 100,
    commissionPerLot: '0', maxQuoteAgeMs: 5000,
  };
}
function pendingOrder(status = 'PENDING') {
  return {
    _id: '64b000000000000000000001', orderId: 'order-1', accountId: '64a000000000000000000001', clientOrderId: 'client-1',
    symbol: 'EURUSD', side: 'BUY', type: 'LIMIT', status, requestedVolume: '1', filledVolume: '0',
    limitPrice: '1.09', stopPrice: null, stopLoss: '1.08', takeProfit: '1.12', timeInForce: 'GTC', expiresAt: null,
    source: 'WEB', receivedAt: new Date(), saveCalls: 0,
    async save() { this.saveCalls += 1; return this; },
  };
}

function serviceFor(order) {
  const events = [];
  const service = new PendingOrderAmendService({
    quoteStore: { get: () => ({ symbol: 'EURUSD', bid: 1.09995, ask: 1.10005, receivedAtMs: Date.now(), isStale: false }) },
    eventBus: { emit: (name, payload) => events.push([name, payload]) },
    accountModel: { findById: () => query(account()) },
    instrumentModel: { findOne: () => query(instrument()) },
    orderModel: { findById: () => query(order) },
    commandQueue: { run: async (_accountId, task) => task() },
    idempotencyService: idempotency(),
    runTransaction: async work => work({ id: 'session' }),
  });
  return { service, events };
}

test('native amend updates the existing pending order in place and emits an updated event', async () => {
  const order = pendingOrder();
  const { service, events } = serviceFor(order);
  const result = await service.amend({
    accountId: String(order.accountId), orderId: String(order._id), clientRequestId: 'amend-1',
    volume: '0.50', limitPrice: '1.095', stopLoss: '1.08', takeProfit: '1.12', timeInForce: 'GTC', expiresAt: null,
  });
  assert.equal(result.operation, 'PENDING_AMEND');
  assert.equal(result.order.id, String(order._id));
  assert.equal(result.order.requestedVolume, '0.5');
  assert.equal(result.order.limitPrice, '1.095');
  assert.equal(order.saveCalls, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'trading.order.updated');
});

test('triggered stop-limit orders cannot be amended after activation', async () => {
  const order = pendingOrder('TRIGGERED');
  order.type = 'STOP_LIMIT';
  order.stopPrice = '1.11';
  const { service } = serviceFor(order);
  await assert.rejects(
    () => service.amend({ accountId: String(order.accountId), orderId: String(order._id), clientRequestId: 'amend-triggered', limitPrice: '1.115' }),
    error => error.code === 'ORDER_NOT_AMENDABLE',
  );
  assert.equal(order.saveCalls, 0);
});
