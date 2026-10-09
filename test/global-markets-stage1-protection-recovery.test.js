'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { ProtectionTriggerEngine } = require('../src/modules/trading/protection-trigger-engine');

function query(value) {
  return { lean: async () => value };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function applyUpdate(target, update) {
  for (const [path, value] of Object.entries(update?.$set || {})) {
    const [root, key] = path.split('.');
    if (root === 'metadata') {
      target.metadata = target.metadata || {};
      target.metadata[key] = value;
    }
  }
  for (const path of Object.keys(update?.$unset || {})) {
    const [root, key] = path.split('.');
    if (root === 'metadata' && target.metadata) delete target.metadata[key];
  }
}

function makePosition() {
  return {
    _id: '507f191e810c19729de860ea',
    positionId: 'pos-1',
    accountId: '507f1f77bcf86cd799439011',
    symbol: 'RELIANCE',
    side: 'BUY',
    status: 'OPEN',
    stopLoss: '99',
    takeProfit: '120',
    metadata: {},
  };
}

function makeModel(position) {
  return {
    find() { return query([position]); },
    async updateOne(_filter, update) {
      applyUpdate(position, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

function stopTick() {
  return {
    symbol: 'RELIANCE',
    bid: 98,
    ask: 98.1,
    sequence: 44,
    receivedAtMs: 1000,
    source: 'STOCK_TEST',
    isStale: false,
  };
}

test('GM-006 FX recovery retries a latched stop without another stock tick', async () => {
  const eventBus = new EventEmitter();
  const position = makePosition();
  const model = makeModel(position);
  const commands = [];
  let attempt = 0;

  const engine = new ProtectionTriggerEngine({
    eventBus,
    positionModel: model,
    retryCheckMs: 60000,
    logger: { info() {}, error() {} },
    marketOrderService: {
      async closeMarketPosition(command) {
        commands.push(command);
        attempt += 1;
        if (attempt === 1) {
          const error = new Error('FX unavailable');
          error.code = 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE';
          throw error;
        }
        position.status = 'CLOSED';
        return { order: { orderId: 'o2' }, deal: { dealId: 'd2', price: '97.8' } };
      },
    },
  });

  await engine.start();
  eventBus.emit('market.tick', stopTick());
  await nextTurn();
  await nextTurn();

  assert.equal(commands.length, 1);
  assert.equal(engine.health().latchedProtectionActions, 1);
  assert.equal(position.metadata.protectionLatchReason, 'STOP_LOSS');

  // No RELIANCE tick is published. A dependency quote alone must wake the latch.
  eventBus.emit('market.quote', {
    symbol: 'USDINR',
    bid: 90,
    ask: 90.1,
    receivedAtMs: 2000,
    isStale: false,
  });
  await nextTurn();
  await nextTurn();

  assert.equal(commands.length, 2);
  assert.equal(commands[1].reason, 'STOP_LOSS');
  assert.equal(commands[1].latchedProtection.reason, 'STOP_LOSS');
  assert.equal(commands[1].latchedProtection.protectionPrice, '99');
  assert.equal(engine.health().latchedProtectionActions, 0);
  assert.equal(position.metadata.protectionLatchReason, undefined);
  await engine.stop();
});

test('GM-006 persisted protection latch retries after process restart without a stock tick', async () => {
  const eventBus1 = new EventEmitter();
  const position = makePosition();
  const model = makeModel(position);

  const firstEngine = new ProtectionTriggerEngine({
    eventBus: eventBus1,
    positionModel: model,
    retryCheckMs: 60000,
    logger: { info() {}, error() {} },
    marketOrderService: {
      async closeMarketPosition() {
        const error = new Error('FX unavailable');
        error.code = 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE';
        throw error;
      },
    },
  });

  await firstEngine.start();
  eventBus1.emit('market.tick', stopTick());
  await nextTurn();
  await nextTurn();
  assert.equal(position.metadata.protectionLatchReason, 'STOP_LOSS');
  await firstEngine.stop();

  const eventBus2 = new EventEmitter();
  const commands = [];
  const secondEngine = new ProtectionTriggerEngine({
    eventBus: eventBus2,
    positionModel: model,
    retryCheckMs: 60000,
    logger: { info() {}, error() {} },
    marketOrderService: {
      async closeMarketPosition(command) {
        commands.push(command);
        position.status = 'CLOSED';
        return { order: { orderId: 'restart-order' }, deal: { dealId: 'restart-deal', price: '97.5' } };
      },
    },
  });

  await secondEngine.start();
  await nextTurn();
  await nextTurn();

  assert.equal(commands.length, 1);
  assert.equal(commands[0].reason, 'STOP_LOSS');
  assert.equal(commands[0].latchedProtection.protectionPrice, '99');
  assert.equal(secondEngine.health().latchedProtectionActions, 0);
  await secondEngine.stop();
});
