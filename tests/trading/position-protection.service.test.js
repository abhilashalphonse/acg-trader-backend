'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { PositionProtectionService } = require('../../src/modules/trading/position-protection.service');

function fixture(overrides = {}) {
  const doc = {
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
    stopLoss: '1.09',
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
    ...overrides.position,
  };
  const account = {
    _id: doc.accountId,
    currency: 'USD',
    riskPolicy: { allowedSymbols: [], ...(overrides.riskPolicy || {}) },
    state: { balance: '100000', equity: '100000', freeMargin: '98900', usedMargin: '1100' },
  };

  const eventBus = new EventEmitter();
  const events = [];
  eventBus.on('trading.position.updated', value => events.push(['updated', value]));
  eventBus.on('trading.position.protection.updated', value => events.push(['protection', value]));

  const positionModel = {
    findById() {
      return {
        lean: async () => doc.toObject(),
        session: async () => doc,
      };
    },
  };
  const instrumentModel = {
    findOne() {
      return {
        session: async () => ({ symbol: 'EURUSD', tickSize: '0.00001', maxQuoteAgeMs: 5000, contractSize: '100000', quoteCurrency: 'USD', pnlCurrency: 'USD' }),
      };
    },
  };
  const idempotencyService = {
    async reserve() { return { created: true, record: { _id: 'idem-1' } }; },
    async complete() { return { state: 'COMPLETED' }; },
    async fail() { return { state: 'FAILED' }; },
  };
  const commandQueue = { async run(_accountId, work) { return work(); } };
  const service = new PositionProtectionService({
    quoteStore: { get: () => ({ symbol: 'EURUSD', bid: 1.105, ask: 1.1052, sequence: 10, receivedAtMs: Date.now(), source: 'test', isStale: false }) },
    eventBus,
    logger: { error() {} },
    positionModel,
    instrumentModel,
    accountModel: { findById: () => ({ session: async () => account }) },
    idempotencyService,
    commandQueue,
    runTransaction: async work => work({}),
  });
  return { service, doc, account, events, idempotencyService };
}

test('updates SL transactionally and emits the shared position update event', async () => {
  const { service, doc, events } = fixture();
  const result = await service.updateProtection({
    accountId: String(doc.accountId),
    positionId: String(doc._id),
    clientRequestId: 'protect-1',
    stopLoss: '1.101',
    source: 'WEB',
  });
  assert.equal(result.changed, true);
  assert.equal(result.position.stopLoss, '1.101');
  assert.equal(result.position.takeProfit, '1.12');
  assert.equal(events.filter(([name]) => name === 'updated').length, 1);
  assert.equal(events.filter(([name]) => name === 'protection').length, 1);
});

test('explicit null removes protection without changing unspecified fields', async () => {
  const { service, doc } = fixture();
  const result = await service.updateProtection({
    accountId: String(doc.accountId),
    positionId: String(doc._id),
    clientRequestId: 'protect-2',
    takeProfit: null,
  });
  assert.equal(result.position.stopLoss, '1.09');
  assert.equal(result.position.takeProfit, null);
});

test('break-even moves SL to entry and preserves TP', async () => {
  const { service, doc } = fixture();
  const result = await service.moveStopToBreakEven({
    accountId: String(doc.accountId),
    positionId: String(doc._id),
    clientRequestId: 'be-1',
  });
  assert.equal(result.operation, 'BREAK_EVEN');
  assert.equal(result.position.stopLoss, '1.1');
  assert.equal(result.position.takeProfit, '1.12');
});

test('manual SL mutation disables an active trailing configuration', async () => {
  const { service, doc } = fixture({
    position: {
      trailing: { enabled: true, distancePoints: '20', bestPrice: '1.104', activatedAt: new Date('2026-09-16T01:00:00Z') },
    },
  });
  const result = await service.updateProtection({
    accountId: String(doc.accountId),
    positionId: String(doc._id),
    clientRequestId: 'protect-3',
    stopLoss: '1.102',
    source: 'WEB',
  });
  assert.equal(result.position.trailing.enabled, false);
  assert.equal(result.position.trailing.distancePoints, null);
  assert.equal(result.position.trailing.bestPrice, null);
});


test('firm mandatory-stop policy prevents removing SL from an open position', async () => {
  const { service, doc } = fixture({ riskPolicy: { requireStopLoss: true } });
  await assert.rejects(
    () => service.updateProtection({
      accountId: String(doc.accountId),
      positionId: String(doc._id),
      clientRequestId: 'protect-hard-stop',
      stopLoss: null,
      source: 'WEB',
    }),
    error => error.code === 'STOP_LOSS_REQUIRED_BY_POLICY',
  );
  assert.equal(doc.stopLoss, '1.09');
});

test('firm per-trade risk cap prevents widening an existing stop beyond the limit', async () => {
  const { service, doc } = fixture({ riskPolicy: { maxRiskPerTradePercent: '1' } });
  await assert.rejects(
    () => service.updateProtection({
      accountId: String(doc.accountId),
      positionId: String(doc._id),
      clientRequestId: 'protect-risk-cap',
      stopLoss: '1.08',
      source: 'WEB',
    }),
    error => error.code === 'MAX_RISK_PER_TRADE_REACHED',
  );
  assert.equal(doc.stopLoss, '1.09');
});
