'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { TrailingStopService } = require('../../src/modules/trading/trailing-stop.service');
const { TrailingStopEngine } = require('../../src/modules/trading/trailing-stop-engine');

function createDoc(overrides = {}) {
  return {
    _id: '507f191e810c19729de860ea',
    positionId: 'pos-1',
    accountId: '507f1f77bcf86cd799439011',
    sourceOrderId: '507f1f77bcf86cd799439012',
    symbol: 'EURUSD',
    side: 'BUY',
    status: 'OPEN',
    initialVolume: '1',
    openVolume: '1',
    entryPrice: '1.1',
    stopLoss: null,
    takeProfit: '1.12',
    contractSize: '100000',
    volumeStep: '0.01',
    quoteCurrency: 'USD',
    margin: '1100',
    realizedPnl: '0',
    commissionPaid: '0',
    swapPaid: '0',
    trailing: { enabled: false, distancePoints: null, bestPrice: null, activatedAt: null },
    openedAt: new Date('2026-09-16T00:00:00Z'),
    closedAt: null,
    closeReason: null,
    async save() { return this; },
    toObject() {
      const plain = { ...this, trailing: { ...this.trailing } };
      delete plain.save;
      delete plain.toObject;
      return plain;
    },
    ...overrides,
  };
}

function serviceFixture(overrides = {}) {
  const doc = createDoc(overrides);
  const eventBus = new EventEmitter();
  const events = [];
  eventBus.on('trading.position.updated', payload => events.push(payload));
  const positionModel = {
    findById() {
      return {
        lean: async () => doc.toObject(),
        session: async () => doc,
      };
    },
  };
  const instrumentModel = { findOne() { return { session: async () => ({ symbol: 'EURUSD', tickSize: '0.00001', maxQuoteAgeMs: 5000 }) }; } };
  const idempotencyService = {
    async reserve() { return { created: true, record: { _id: 'idem-1' } }; },
    async complete() { return { state: 'COMPLETED' }; },
    async fail() {},
  };
  const service = new TrailingStopService({
    quoteStore: { get: () => ({ symbol: 'EURUSD', bid: 1.105, ask: 1.1052, receivedAtMs: Date.now(), sequence: 1, source: 'test', isStale: false }) },
    eventBus,
    logger: { error() {} },
    positionModel,
    instrumentModel,
    commandQueue: { async run(_account, work) { return work(); } },
    idempotencyService,
    runTransaction: async work => work({}),
  });
  return { service, doc, events };
}

test('enables trailing and persists an initial protective stop', async () => {
  const { service, doc, events } = serviceFixture();
  const result = await service.configure({ accountId: String(doc.accountId), positionId: String(doc._id), clientRequestId: 'trail-1', enabled: true, distancePoints: '20' });
  assert.equal(result.position.trailing.enabled, true);
  assert.equal(result.position.trailing.distancePoints, '20');
  assert.equal(result.position.stopLoss, '1.1048');
  assert.equal(events.length, 1);
});

test('disabling trailing leaves the last stop loss in place', async () => {
  const { service, doc } = serviceFixture({ stopLoss: '1.1048', trailing: { enabled: true, distancePoints: '20', bestPrice: '1.105', activatedAt: new Date() } });
  const result = await service.configure({ accountId: String(doc.accountId), positionId: String(doc._id), clientRequestId: 'trail-2', enabled: false });
  assert.equal(result.position.trailing.enabled, false);
  assert.equal(result.position.stopLoss, '1.1048');
});

test('advance persists best price and tighter stop then emits post-transaction', async () => {
  const { service, doc, events } = serviceFixture({ stopLoss: '1.1048', trailing: { enabled: true, distancePoints: '20', bestPrice: '1.105', activatedAt: new Date() } });
  const result = await service.advance({ accountId: String(doc.accountId), positionId: String(doc._id), tick: { symbol: 'EURUSD', bid: 1.106, ask: 1.1062, receivedAtMs: Date.now(), sequence: 2, source: 'test', isStale: false } });
  assert.equal(result.stopChanged, true);
  assert.equal(result.position.stopLoss, '1.1058');
  assert.equal(result.position.trailing.bestPrice, '1.106');
  assert.equal(events.length, 1);
});

test('engine recovers open trailing positions and advances only matching symbols', async () => {
  const eventBus = new EventEmitter();
  const calls = [];
  const positionModel = { find() { return { lean: async () => [{ _id: 'p1', accountId: 'a1', symbol: 'EURUSD', status: 'OPEN', trailing: { enabled: true } }] }; } };
  const engine = new TrailingStopEngine({ eventBus, positionModel, trailingStopService: { async advance(payload) { calls.push(payload); } }, logger: { info() {}, error() {} } });
  await engine.start();
  eventBus.emit('market.tick', { symbol: 'XAUUSD', bid: 1, ask: 2, isStale: false });
  eventBus.emit('market.tick', { symbol: 'EURUSD', bid: 1, ask: 2, isStale: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(engine.health().trailingPositions, 1);
  await engine.stop();
});

test('engine ignores stale ticks', async () => {
  const eventBus = new EventEmitter();
  let calls = 0;
  const positionModel = { find() { return { lean: async () => [{ _id: 'p1', accountId: 'a1', symbol: 'EURUSD', status: 'OPEN', trailing: { enabled: true } }] }; } };
  const engine = new TrailingStopEngine({ eventBus, positionModel, trailingStopService: { async advance() { calls += 1; } }, logger: { info() {}, error() {} } });
  await engine.start();
  eventBus.emit('market.tick', { symbol: 'EURUSD', isStale: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  await engine.stop();
});

test('engine removes position when trailing is disabled by a position update', async () => {
  const eventBus = new EventEmitter();
  const positionModel = { find() { return { lean: async () => [{ _id: 'p1', accountId: 'a1', symbol: 'EURUSD', status: 'OPEN', trailing: { enabled: true } }] }; } };
  const engine = new TrailingStopEngine({ eventBus, positionModel, trailingStopService: { async advance() {} }, logger: { info() {}, error() {} } });
  await engine.start();
  eventBus.emit('trading.position.updated', { id: 'p1', accountId: 'a1', symbol: 'EURUSD', status: 'OPEN', trailing: { enabled: false } });
  assert.equal(engine.health().trailingPositions, 0);
  await engine.stop();
});

test('engine suppresses duplicate advancement while one tick is in flight', async () => {
  const eventBus = new EventEmitter();
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const positionModel = { find() { return { lean: async () => [{ _id: 'p1', accountId: 'a1', symbol: 'EURUSD', status: 'OPEN', trailing: { enabled: true } }] }; } };
  const engine = new TrailingStopEngine({ eventBus, positionModel, trailingStopService: { async advance() { calls += 1; await gate; } }, logger: { info() {}, error() {} } });
  await engine.start();
  eventBus.emit('market.tick', { symbol: 'EURUSD', isStale: false });
  eventBus.emit('market.tick', { symbol: 'EURUSD', isStale: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await engine.stop();
});
