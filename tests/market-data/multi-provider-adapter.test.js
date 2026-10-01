'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { MultiProviderAdapter } = require('../../src/modules/market-data/adapters/multi-provider.adapter');

class FakeProvider extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.started = [];
    this.stopped = false;
    this.latestCalls = [];
    this.historyCalls = [];
  }

  start(subscriptions) {
    this.started = subscriptions;
    this.emit('connection', { state: 'LIVE', timestamp: 1000 });
  }

  async stop() {
    this.stopped = true;
  }

  async fetchLatestPrice(args) {
    this.latestCalls.push(args);
    return {
      providerSymbol: args.providerSymbol,
      price: this.name === 'accelpix' ? 1175 : 1.1,
      bid: null,
      ask: null,
      providerTimestampMs: null,
      dayVolume: null,
      source: this.name + '-rest',
    };
  }

  supportsHistory(timeframe) {
    return this.name === 'accelpix'
      ? ['1m', '1d'].includes(timeframe)
      : ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'].includes(timeframe);
  }

  async fetchHistorical(args) {
    this.historyCalls.push(args);
    return [{
      openTimeMs: 1,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      providerVolume: null,
    }];
  }
}

test('groups subscriptions by provider and forwards normalized price events', async () => {
  const twelve = new FakeProvider('twelve-data');
  const accelpix = new FakeProvider('accelpix');
  const router = new MultiProviderAdapter({
    adapters: {
      'twelve-data': twelve,
      accelpix,
    },
  });

  const prices = [];
  router.on('price', event => prices.push(event));

  await router.start([
    { symbol: 'EURUSD', provider: 'twelve-data', providerSymbol: 'EUR/USD' },
    { symbol: 'RELIANCE', provider: 'accelpix', providerSymbol: 'RELIANCE' },
  ]);

  assert.deepEqual(twelve.started, [
    { symbol: 'EURUSD', provider: 'twelve-data', providerSymbol: 'EUR/USD' },
  ]);
  assert.deepEqual(accelpix.started, [
    { symbol: 'RELIANCE', provider: 'accelpix', providerSymbol: 'RELIANCE' },
  ]);

  accelpix.emit('price', {
    symbol: 'RELIANCE',
    providerSymbol: 'RELIANCE',
    price: 1175,
  });

  assert.equal(prices.length, 1);
  assert.equal(prices[0].provider, 'accelpix');
  assert.equal(prices[0].symbol, 'RELIANCE');
  assert.equal(prices[0].price, 1175);

  await router.stop();
});

test('routes latest quote and history calls to requested provider', async () => {
  const twelve = new FakeProvider('twelve-data');
  const accelpix = new FakeProvider('accelpix');
  const router = new MultiProviderAdapter({
    adapters: {
      'twelve-data': twelve,
      accelpix,
    },
  });

  const quote = await router.fetchLatestPrice({
    provider: 'accelpix',
    providerSymbol: 'RELIANCE',
  });
  assert.equal(quote.price, 1175);
  assert.equal(accelpix.latestCalls.length, 1);
  assert.equal(twelve.latestCalls.length, 0);

  assert.equal(router.supportsHistory('1m', 'accelpix'), true);
  assert.equal(router.supportsHistory('5m', 'accelpix'), false);
  assert.equal(router.supportsHistory('5m', 'twelve-data'), true);

  const bars = await router.fetchHistorical({
    provider: 'accelpix',
    providerSymbol: 'RELIANCE',
    timeframe: '1m',
    limit: 10,
  });
  assert.equal(bars.length, 1);
  assert.equal(accelpix.historyCalls.length, 1);
  assert.equal(twelve.historyCalls.length, 0);
});

test('publishes provider-specific connection state without dropping healthy providers', async () => {
  const twelve = new FakeProvider('twelve-data');
  const accelpix = new FakeProvider('accelpix');
  const router = new MultiProviderAdapter({
    adapters: {
      'twelve-data': twelve,
      accelpix,
    },
  });

  const aggregate = [];
  const providerEvents = [];
  router.on('connection', event => aggregate.push(event));
  router.on('provider-connection', event => providerEvents.push(event));

  await router.start([
    { symbol: 'EURUSD', provider: 'twelve-data', providerSymbol: 'EUR/USD' },
    { symbol: 'RELIANCE', provider: 'accelpix', providerSymbol: 'RELIANCE' },
  ]);

  accelpix.emit('connection', { state: 'DISCONNECTED', timestamp: 2000 });
  assert.equal(providerEvents.at(-1).provider, 'accelpix');
  assert.equal(providerEvents.at(-1).state, 'DISCONNECTED');

  const status = router.status();
  assert.equal(status.providers['twelve-data'], 'LIVE');
  assert.equal(status.providers.accelpix, 'DISCONNECTED');
  assert.equal(aggregate.at(-1).state, 'LIVE');

  await router.stop();
});
