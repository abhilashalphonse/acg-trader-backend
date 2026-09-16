'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { MarketGateway } = require('../../src/modules/market-data/market-gateway');
const { QuoteStore } = require('../../src/modules/market-data/quote-store');

class FakeAdapter extends EventEmitter {
  start(subscriptions) { this.subscriptions = subscriptions; }
  async stop() {}
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
    maxQuoteAgeMs: 10000,
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
  const logger = { info() {}, warn() {} };
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
  return { adapter, quoteStore, eventBus, feedStates, gateway };
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

test('provider disconnect immediately marks the last quote stale and pauses candle continuity', async () => {
  const { adapter, quoteStore, eventBus, feedStates, gateway } = createHarness();
  const quotes = [];
  eventBus.on('market.quote', quote => quotes.push(quote));
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
  assert.equal(quote.isStale, true);
  assert.ok(feedStates.some(item => item.symbol === 'EURUSD' && item.live === false));
  assert.equal(quotes.at(-1).isStale, true);

  await gateway.stop();
});
