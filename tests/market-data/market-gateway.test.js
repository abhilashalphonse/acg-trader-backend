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

function createHarness({ onStreamRecovered = null } = {}) {
  const adapter = new FakeAdapter();
  const quoteStore = new QuoteStore();
  const eventBus = new EventEmitter();
  const feedStates = [];
  const processedTicks = [];
  const candleEngine = {
    start() {},
    async stop() {},
    processTick(tick) { processedTicks.push(tick); },
    setSymbolLive(symbol, live) { feedStates.push({ symbol, live }); },
  };
  const instrument = {
    symbol: 'EURUSD',
    configured: true,
    providerSymbol: 'EUR/USD',
    assetClass: 'FOREX',
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
    onStreamRecovered,
  });
  return { adapter, quoteStore, eventBus, feedStates, processedTicks, gateway, instrument };
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

test('REST quote recovery never reopens candle continuity or emits a market tick', async () => {
  const { adapter, quoteStore, feedStates, processedTicks, gateway } = createHarness();
  await gateway.start();

  adapter.emit('price', {
    symbol: 'EURUSD',
    providerSymbol: 'EUR/USD',
    price: 1.1,
    bid: null,
    ask: null,
    providerTimestampMs: Date.now(),
    dayVolume: null,
  });
  assert.deepEqual(processedTicks.map(tick => tick.price), [1.1]);

  adapter.emit('connection', { state: 'DISCONNECTED', code: 1006, reason: '' });
  assert.equal(feedStates.at(-1).live, false);

  adapter.latestPrice = 1.102;
  const recovered = await gateway.ensureFreshQuote('EURUSD', { reason: 'test-rest-recovery', force: true });

  assert.equal(recovered.source, 'twelve-data-rest');
  assert.equal(recovered.price, 1.102);
  assert.deepEqual(processedTicks.map(tick => tick.price), [1.1]);
  assert.equal(feedStates.at(-1).live, false);

  await gateway.stop();
});

test('provider reconnect invokes recovery hook once and marks recovered gateway status', async () => {
  const recoveries = [];
  const { adapter, eventBus, gateway } = createHarness({
    onStreamRecovered: event => recoveries.push(event),
  });
  const statuses = [];
  eventBus.on('market.status', status => {
    if (status.scope === 'gateway') statuses.push(status);
  });
  await gateway.start();

  adapter.emit('connection', { state: 'LIVE', timestamp: 1000 });
  assert.equal(recoveries.length, 0);

  adapter.emit('connection', { state: 'DISCONNECTED', timestamp: 2000, code: 1006, reason: '' });
  adapter.emit('connection', { state: 'CONNECTING', timestamp: 2500 });
  adapter.emit('connection', { state: 'LIVE', timestamp: 3000 });

  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].timestamp, 3000);
  assert.equal(statuses.at(-1).state, 'LIVE');
  assert.equal(statuses.at(-1).recovered, true);

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


test('ignores non-positive provider prices instead of publishing executable quotes', async () => {
  const { adapter, quoteStore, gateway } = createHarness();
  await gateway.start();

  adapter.emit('price', {
    symbol: 'EURUSD',
    providerSymbol: 'EUR/USD',
    price: 0,
    bid: 0,
    ask: 0,
    providerTimestampMs: null,
    dayVolume: null,
  });

  assert.equal(quoteStore.get('EURUSD'), null);
  await gateway.stop();
});

test('crossed provider bid/ask falls back to configured synthetic spread', async () => {
  const { adapter, quoteStore, gateway } = createHarness();
  await gateway.start();

  adapter.emit('price', {
    symbol: 'EURUSD',
    providerSymbol: 'EUR/USD',
    price: 1.1,
    bid: 1.1002,
    ask: 1.0998,
    providerTimestampMs: null,
    dayVolume: null,
  });

  const quote = quoteStore.get('EURUSD');
  assert.ok(quote);
  assert.equal(quote.isSyntheticSpread, true);
  assert.ok(quote.bid > 0);
  assert.ok(quote.ask >= quote.bid);

  await gateway.stop();
});


test('isolated provider spike never reaches quote state or candle engine', async () => {
  const { adapter, quoteStore, processedTicks, gateway } = createHarness();
  await gateway.start();

  adapter.emit('price', {
    symbol: 'EURUSD',
    providerSymbol: 'EUR/USD',
    price: 1.1,
    bid: null,
    ask: null,
    providerTimestampMs: 1_000,
    dayVolume: null,
  });

  adapter.emit('price', {
    symbol: 'EURUSD',
    providerSymbol: 'EUR/USD',
    price: 1.12,
    bid: null,
    ask: null,
    providerTimestampMs: 1_100,
    dayVolume: null,
  });

  assert.equal(quoteStore.get('EURUSD').price, 1.1);
  assert.deepEqual(processedTicks.map(tick => tick.price), [1.1]);

  adapter.emit('price', {
    symbol: 'EURUSD',
    providerSymbol: 'EUR/USD',
    price: 1.1001,
    bid: null,
    ask: null,
    providerTimestampMs: 1_200,
    dayVolume: null,
  });

  assert.equal(quoteStore.get('EURUSD').price, 1.1001);
  assert.deepEqual(processedTicks.map(tick => tick.price), [1.1, 1.1001]);

  await gateway.stop();
});

test('confirmed large provider move is released in original tick order', async () => {
  const { adapter, quoteStore, processedTicks, gateway } = createHarness();
  await gateway.start();

  adapter.emit('price', {
    symbol: 'EURUSD',
    providerSymbol: 'EUR/USD',
    price: 1.1,
    bid: null,
    ask: null,
    providerTimestampMs: 1_000,
    dayVolume: null,
  });

  adapter.emit('price', {
    symbol: 'EURUSD',
    providerSymbol: 'EUR/USD',
    price: 1.102,
    bid: null,
    ask: null,
    providerTimestampMs: 1_100,
    dayVolume: null,
  });
  assert.deepEqual(processedTicks.map(tick => tick.price), [1.1]);

  adapter.emit('price', {
    symbol: 'EURUSD',
    providerSymbol: 'EUR/USD',
    price: 1.1022,
    bid: null,
    ask: null,
    providerTimestampMs: 1_200,
    dayVolume: null,
  });

  assert.deepEqual(processedTicks.map(tick => tick.price), [1.1, 1.102, 1.1022]);
  assert.equal(quoteStore.get('EURUSD').price, 1.1022);

  await gateway.stop();
});
