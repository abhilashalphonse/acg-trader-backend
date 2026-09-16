'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { PendingOrderEngine } = require('../../src/modules/trading/pending-order-engine');

function query(value) {
  return { lean: async () => value };
}

function pendingOrder(overrides = {}) {
  return {
    _id: '507f191e810c19729de860ea',
    orderId: 'ord-1',
    accountId: '507f1f77bcf86cd799439011',
    symbol: 'EURUSD',
    side: 'BUY',
    type: 'LIMIT',
    status: 'PENDING',
    limitPrice: '1.099',
    stopPrice: null,
    expiresAt: null,
    ...overrides,
  };
}

function tick(overrides = {}) {
  return {
    symbol: 'EURUSD',
    bid: 1.0988,
    ask: 1.0989,
    sequence: 10,
    receivedAtMs: Date.now(),
    source: 'test',
    isStale: false,
    ...overrides,
  };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test('recovers pending orders and fills a triggered LIMIT through the service', async () => {
  const eventBus = new EventEmitter();
  const calls = [];
  const engine = new PendingOrderEngine({
    eventBus,
    expiryCheckMs: 1000,
    logger: { info() {}, error() {} },
    orderModel: { find: () => query([pendingOrder()]) },
    pendingOrderService: {
      async executePendingOrder(command) { calls.push(command); return { operation: 'PENDING_FILL' }; },
      async expirePendingOrder() { throw new Error('unexpected expiry'); },
      async activateStopLimit() { throw new Error('unexpected activation'); },
    },
  });

  await engine.start();
  assert.equal(engine.health().pendingOrders, 1);
  eventBus.emit('market.tick', tick());
  await nextTurn();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].orderId, '507f191e810c19729de860ea');
  await engine.stop();
});

test('STOP_LIMIT can activate and fill on the same market tick', async () => {
  const eventBus = new EventEmitter();
  let activated = 0;
  let filled = 0;
  const sourceOrder = pendingOrder({ type: 'STOP_LIMIT', stopPrice: '1.101', limitPrice: '1.102' });
  const engine = new PendingOrderEngine({
    eventBus,
    expiryCheckMs: 1000,
    logger: { info() {}, error() {} },
    orderModel: { find: () => query([sourceOrder]) },
    pendingOrderService: {
      async activateStopLimit() {
        activated += 1;
        return { skipped: false, operation: 'STOP_LIMIT_TRIGGERED', order: { ...sourceOrder, id: sourceOrder._id, status: 'TRIGGERED' } };
      },
      async executePendingOrder() { filled += 1; return { operation: 'PENDING_FILL' }; },
      async expirePendingOrder() { throw new Error('unexpected expiry'); },
    },
  });

  await engine.start();
  eventBus.emit('market.tick', tick({ ask: 1.1015, bid: 1.1013 }));
  await nextTurn();
  await nextTurn();
  assert.equal(activated, 1);
  assert.equal(filled, 1);
  await engine.stop();
});

test('expiry timer expires orders even when no market ticks arrive', async () => {
  const eventBus = new EventEmitter();
  let expiries = 0;
  const engine = new PendingOrderEngine({
    eventBus,
    expiryCheckMs: 5,
    logger: { info() {}, error() {} },
    orderModel: { find: () => query([pendingOrder({ expiresAt: new Date(Date.now() - 1000).toISOString() })]) },
    pendingOrderService: {
      async expirePendingOrder() { expiries += 1; return { operation: 'PENDING_EXPIRE' }; },
      async executePendingOrder() { throw new Error('unexpected fill'); },
      async activateStopLimit() { throw new Error('unexpected activation'); },
    },
  });

  await engine.start();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(expiries >= 1);
  await engine.stop();
});

test('terminal order events remove orders from the symbol index', async () => {
  const eventBus = new EventEmitter();
  let fills = 0;
  const sourceOrder = pendingOrder();
  const engine = new PendingOrderEngine({
    eventBus,
    expiryCheckMs: 1000,
    logger: { info() {}, error() {} },
    orderModel: { find: () => query([sourceOrder]) },
    pendingOrderService: {
      async executePendingOrder() { fills += 1; return {}; },
      async expirePendingOrder() { return {}; },
      async activateStopLimit() { return {}; },
    },
  });

  await engine.start();
  eventBus.emit('trading.order.cancelled', { id: sourceOrder._id, symbol: 'EURUSD', status: 'CANCELLED' });
  assert.equal(engine.health().pendingOrders, 0);
  eventBus.emit('market.tick', tick());
  await nextTurn();
  assert.equal(fills, 0);
  await engine.stop();
});

test('does not launch duplicate fills while the same order is in flight', async () => {
  const eventBus = new EventEmitter();
  let resolveFill;
  const fillPromise = new Promise(resolve => { resolveFill = resolve; });
  let calls = 0;
  const engine = new PendingOrderEngine({
    eventBus,
    expiryCheckMs: 1000,
    logger: { info() {}, error() {} },
    orderModel: { find: () => query([pendingOrder()]) },
    pendingOrderService: {
      executePendingOrder() { calls += 1; return fillPromise; },
      async expirePendingOrder() { return {}; },
      async activateStopLimit() { return {}; },
    },
  });

  await engine.start();
  eventBus.emit('market.tick', tick({ sequence: 1 }));
  eventBus.emit('market.tick', tick({ sequence: 2 }));
  await nextTurn();
  assert.equal(calls, 1);
  assert.equal(engine.health().inFlight, 1);
  resolveFill({ operation: 'PENDING_FILL' });
  await nextTurn();
  assert.equal(engine.health().inFlight, 0);
  await engine.stop();
});
