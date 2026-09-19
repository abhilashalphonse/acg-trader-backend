'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { MarketGateway } = require('../../src/modules/market-data/market-gateway');
const { QuoteStore } = require('../../src/modules/market-data/quote-store');

class FakeAdapter extends EventEmitter {
  constructor() {
    super();
    this.latestPrice = 1.101;
    this.latestCalls = 0;
  }
  start(subscriptions) { this.subscriptions = subscriptions; }
  async stop() {}
  async fetchLatestPrice({ providerSymbol }) {
    this.latestCalls += 1;
    return {
      providerSymbol,
      price: this.latestPrice,
      bid: null,
      ask: null,
      providerTimestampMs: null,
      dayVolume: null,
      source: 'twelve-data-rest',
    };
  }
}

function createHarness() {
  const adapter = new FakeAdapter();
  const quoteStore = new QuoteStore();
  const eventBus = new EventEmitter();
  const feedStates = [];
  const candleEngine = {
    start() {},
    async stop() {},
    processTick() {},
    setSymbolLive(symbol, live) { feedStates.push({ symbol, live }); },
  };
  const instrument = {
    symbol: 'EURUSD',
    configured: true,
    providerSymbol: 'EUR/USD',
    tickSize: 0.00001,
    softQuoteAgeMs: 5000,
    maxQuoteAgeMs: 30000,
    spread: { mode: 'SYNTHETIC', fixedPoints: 10, markupPoints: 0 },
    status: 'ACTIVE',
    chartEnabled: true,
    executionEnabled: false,
  };
  const registry = {
    async load() {},
    get(symbol) { return symbol === 'EURUSD' ? instrument : null; },
    providerSymbol() { return 'EUR/USD'; },
    providerSubscriptions() { return [{ symbol: 'EURUSD', providerSymbol: 'EUR/USD' }]; },
  };
  const logger = { info() {}, warn() {}, debug() {} };
  const gateway = new MarketGateway({
    adapter,
    instrumentRegistry: registry,
    quoteStore,
    candleEngine,
    eventBus,
    symbols: ['EURUSD'],
    staleCheckMs: 100000,
    logger,
  });
  return { adapter, quoteStore, eventBus, feedStates, gateway, instrument };
}

test('builds deterministic synthetic bid/ask from instrument policy', async () => {
  const { adapter, quoteStore, gateway } = createHarness();
  await gateway.start();

  adapter.emit('price', {
    symbol: 'EURUSD',
    providerSymbol: 'EUR/USD',
    price: 1.1,
    bid: null,
    ask: null,
    providerTimestampMs: null,
    dayVolume: null,
  });

  const quote = quoteStore.get('EURUSD');
  assert.ok(quote);
  assert.equal(quote.isSyntheticSpread, true);
  assert.ok(Math.abs(quote.bid - 1.09995) < 1e-12);
  assert.ok(Math.abs(quote.ask - 1.10005) < 1e-12);
  assert.ok(Math.abs(quote.spread - 0.0001) < 1e-12);
  assert.equal(quote.isStale, false);

  await gateway.stop();
});

test('recent executable quote survives stream disconnect instead of blocking trading immediately', async () => {
  const { adapter, quoteStore, gateway } = createHarness();
  await gateway.start();

  adapter.emit('price', {
    symbol: 'EURUSD',
    providerSymbol: 'EUR/USD',
    price: 1.1,
    bid: null,
    ask: null,
    providerTimestampMs: null,
    dayVolume: null,
  });
  adapter.emit('connection', { state: 'DISCONNECTED', code: 1006, reason: '' });

  const quote = quoteStore.get('EURUSD');
  assert.equal(quote.isStale, false);
  assert.ok(Number.isFinite(quote.bid));
  assert.ok(Number.isFinite(quote.ask));

  await gateway.stop();
});

test('soft-stale priority quote is recovered through latest-price REST without becoming hard stale', async () => {
  const { adapter, quoteStore, gateway } = createHarness();
  await gateway.start();

  quoteStore.set({
    symbol: 'EURUSD',
    sequence: 1,
    price: 1.1,
    last: 1.1,
    bid: 1.09995,
    ask: 1.10005,
    mid: 1.1,
    spread: 0.0001,
    receivedAtMs: Date.now() - 8000,
    timeMs: Date.now() - 8000,
    source: 'twelve-data',
    providerSymbol: 'EUR/USD',
    isSyntheticSpread: true,
    isStale: false,
  });

  adapter.latestPrice = 1.102;
  const recovered = await gateway.ensureFreshQuote('EURUSD', { reason: 'test-soft-stale' });

  assert.equal(adapter.latestCalls, 1);
  assert.equal(recovered.source, 'twelve-data-rest');
  assert.equal(recovered.isStale, false);
  assert.ok(Math.abs(recovered.bid - 1.10195) < 1e-12);
  assert.ok(Math.abs(recovered.ask - 1.10205) < 1e-12);
  assert.ok(Date.now() - recovered.receivedAtMs < 1000);

  await gateway.stop();
});

test('priority reference counting is balanced for subscriptions and risk-critical positions', async () => {
  const { gateway } = createHarness();
  await gateway.start();

  assert.equal(gateway.retainPriority('EURUSD'), 1);
  assert.equal(gateway.retainPriority('EURUSD'), 2);
  assert.equal(gateway.priorityCount('EURUSD'), 2);
  assert.equal(gateway.releasePriority('EURUSD'), 1);
  assert.equal(gateway.releasePriority('EURUSD'), 0);
  assert.equal(gateway.priorityCount('EURUSD'), 0);

  await gateway.stop();
});
