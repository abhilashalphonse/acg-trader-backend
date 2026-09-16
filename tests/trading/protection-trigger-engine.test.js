'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const {
  ProtectionTriggerEngine,
  buildProtectionClientOrderId,
} = require('../../src/modules/trading/protection-trigger-engine');

function query(value) {
  return { lean: async () => value };
}

function protectedPosition(overrides = {}) {
  return {
    _id: '507f191e810c19729de860ea',
    positionId: 'pos-1',
    accountId: '507f1f77bcf86cd799439011',
    symbol: 'EURUSD',
    side: 'BUY',
    status: 'OPEN',
    stopLoss: '1.09',
    takeProfit: '1.12',
    ...overrides,
  };
}

function marketTick(overrides = {}) {
  return {
    symbol: 'EURUSD',
    bid: 1.0899,
    ask: 1.0901,
    sequence: 44,
    receivedAtMs: 123456,
    source: 'test',
    isStale: false,
    ...overrides,
  };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test('recovers protected positions and executes SL through the shared close service', async () => {
  const eventBus = new EventEmitter();
  const commands = [];
  const engine = new ProtectionTriggerEngine({
    eventBus,
    logger: { info() {}, error() {} },
    positionModel: { find: () => query([protectedPosition()]) },
    marketOrderService: {
      async closeMarketPosition(command) {
        commands.push(command);
        return {
          order: { orderId: 'o1' },
          deal: { dealId: 'd1', price: '1.0898' },
          position: { id: command.positionId, status: 'CLOSED' },
        };
      },
    },
  });

  let executed = null;
  eventBus.on('protection.executed', payload => { executed = payload; });
  await engine.start();
  assert.equal(engine.health().protectedPositions, 1);

  eventBus.emit('market.tick', marketTick());
  await nextTurn();

  assert.equal(commands.length, 1);
  assert.equal(commands[0].reason, 'STOP_LOSS');
  assert.equal(commands[0].requestedPrice, '1.09');
  assert.equal(commands[0].source, 'SYSTEM');
  assert.match(commands[0].clientOrderId, /^protect:sl:/);
  assert.equal(executed.fillPrice, '1.0898');
  await engine.stop();
});

test('does not enqueue duplicate protective closes while one close is already in flight', async () => {
  const eventBus = new EventEmitter();
  let resolveClose;
  const closePromise = new Promise(resolve => { resolveClose = resolve; });
  let calls = 0;
  const engine = new ProtectionTriggerEngine({
    eventBus,
    logger: { info() {}, error() {} },
    positionModel: { find: () => query([protectedPosition()]) },
    marketOrderService: {
      closeMarketPosition() {
        calls += 1;
        return closePromise;
      },
    },
  });

  await engine.start();
  eventBus.emit('market.tick', marketTick());
  eventBus.emit('market.tick', marketTick({ sequence: 45, receivedAtMs: 123457 }));
  await nextTurn();
  assert.equal(calls, 1);
  assert.equal(engine.health().inFlight, 1);

  resolveClose({ order: {}, deal: {}, position: {} });
  await nextTurn();
  assert.equal(engine.health().inFlight, 0);
  await engine.stop();
});

test('closed position events remove protection from the symbol index', async () => {
  const eventBus = new EventEmitter();
  let calls = 0;
  const engine = new ProtectionTriggerEngine({
    eventBus,
    logger: { info() {}, error() {} },
    positionModel: { find: () => query([protectedPosition()]) },
    marketOrderService: { async closeMarketPosition() { calls += 1; return {}; } },
  });

  await engine.start();
  eventBus.emit('trading.position.closed', { id: '507f191e810c19729de860ea', accountId: '507f1f77bcf86cd799439011', symbol: 'EURUSD', status: 'CLOSED' });
  assert.equal(engine.health().protectedPositions, 0);
  eventBus.emit('market.tick', marketTick());
  await nextTurn();
  assert.equal(calls, 0);
  await engine.stop();
});

test('protection idempotency identity changes across market ticks', () => {
  const first = buildProtectionClientOrderId('507f191e810c19729de860ea', 'STOP_LOSS', marketTick());
  const second = buildProtectionClientOrderId('507f191e810c19729de860ea', 'STOP_LOSS', marketTick({ sequence: 45, receivedAtMs: 123457 }));
  assert.notEqual(first, second);
  assert.ok(first.length <= 128);
});
