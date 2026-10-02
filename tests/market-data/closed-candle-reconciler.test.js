'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { ClosedCandleReconciler } = require('../../src/modules/market-data/closed-candle-reconciler');
const { CandleEngine } = require('../../src/modules/market-data/candle-engine');
const { ProviderHistoryCache } = require('../../src/modules/market-data/history-cache');

const openTimeMs = Date.UTC(2026, 9, 2, 14, 0);
const closeTimeMs = openTimeMs + 300_000;
const providerBar = { openTimeMs, open: 1.3249, high: 1.3256, low: 1.3248, close: 1.3255, providerVolume: null };

function fixture(fetchHistorical = async () => [providerBar]) {
  let clock = openTimeMs;
  const eventBus = new EventEmitter();
  const corrected = [], persisted = [], requests = [], invalidated = [], warnings = [];
  const registry = {
    get: symbol => ({ symbol, provider: 'twelve-data', assetClass: 'FOREX', configured: true,
      status: 'ACTIVE', timezone: 'UTC', tradingSessions: [], tradingHolidays: [] }),
    providerSymbol: symbol => symbol === 'GBPUSD' ? 'GBP/USD' : 'EUR/USD',
  };
  const logger = { error() {}, warn: (...args) => warnings.push(args) };
  const engine = new CandleEngine({ eventBus, timeframes: ['5m'], persistTimeframes: ['5m'],
    flushIntervalMs: 100000, maxSyntheticGapBars: 0, instrumentRegistry: registry, logger,
    persistCandle: async candle => persisted.push({ ...candle }) });
  const worker = new ClosedCandleReconciler({ eventBus, instrumentRegistry: registry, candleEngine: engine,
    adapter: { fetchHistorical: async args => { requests.push(args); return fetchHistorical(args); } },
    invalidateHistory: (...args) => invalidated.push(args), logger, now: () => clock,
    setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl() {} });
  eventBus.on('market.candle.corrected', candle => corrected.push(candle));
  worker.start();
  function rollover(symbol = 'GBPUSD') {
    engine.processTick({ symbol, timeMs: openTimeMs, price: 1.325, source: 'twelve-data' });
    clock = closeTimeMs;
    engine.processTick({ symbol, timeMs: closeTimeMs, price: 1.3254, source: 'twelve-data' });
  }
  return { worker, engine, eventBus, corrected, persisted, requests, invalidated, warnings, rollover,
    at: time => { clock = time; }, close: async () => { await worker.stop(); await engine.stop(); } };
}

test('an open chart receives exact provider M5 OHLC without a history request; live bar stays intact', async () => {
  const f = fixture();
  try {
    f.rollover();
    const active = f.engine.getCurrent('GBPUSD', '5m');
    await f.worker.runDue();
    assert.equal(f.requests.length, 0);
    f.at(closeTimeMs + 15_000);
    await f.worker.runDue();
    assert.equal(f.corrected.length, 1);
    for (const field of ['open', 'high', 'low', 'close']) {
      assert.equal(f.corrected[0][field], providerBar[field]);
      assert.equal(f.persisted.at(-1)[field], providerBar[field]);
    }
    assert.deepEqual(f.engine.getCurrent('GBPUSD', '5m'), active);
    assert.equal(f.requests[0].providerSymbol, 'GBP/USD');
    assert.equal(f.requests[0].beforeMs, closeTimeMs);
    assert.deepEqual(f.invalidated, [['GBPUSD', '5m']]);
    f.at(closeTimeMs + 75_000);
    await f.worker.runDue();
    assert.equal(f.corrected.length, 1, 'unchanged verification does not rebroadcast');
    assert.equal(f.worker.status().pending, 0);
  } finally { await f.close(); }
});

test('rechecks a delayed provider revision and deduplicates close events', async () => {
  let calls = 0;
  const f = fixture(async () => [{ ...providerBar, high: ++calls === 1 ? 1.3256 : 1.3258 }]);
  try {
    f.rollover();
    f.eventBus.emit('market.candle.closed', f.engine.getLastClosed('GBPUSD', '5m'));
    assert.equal(f.worker.status().pending, 1);
    f.at(closeTimeMs + 15_000); await f.worker.runDue();
    f.at(closeTimeMs + 75_000); await f.worker.runDue();
    assert.equal(f.corrected.at(-1).high, 1.3258);
    assert.equal(f.corrected.length, 2);
    f.eventBus.emit('market.candle.closed', f.engine.getLastClosed('GBPUSD', '5m'));
    assert.equal(f.worker.status().pending, 0);
  } finally { await f.close(); }
});

test('missing, partial and invalid provider bars retry without replacing live OHLC', async () => {
  let response = [];
  const f = fixture(async () => response);
  try {
    f.rollover();
    f.at(closeTimeMs + 15_000); await f.worker.runDue();
    response = [{ ...providerBar, complete: false }];
    f.at(closeTimeMs + 75_000); await f.worker.runDue();
    response = [{ ...providerBar, high: null }];
    f.at(closeTimeMs + 180_000); await f.worker.runDue();
    assert.equal(f.corrected.length, 0);
    response = [providerBar];
    f.at(closeTimeMs + 600_000); await f.worker.runDue();
    assert.equal(f.corrected.length, 1);
    assert.equal(f.worker.status().failed, 3);
  } finally { await f.close(); }
});

test('requests are paced across symbols and exhausted failures are visible', async () => {
  const f = fixture(async () => { throw new Error('rate limited'); });
  try {
    f.rollover(); f.rollover('EURUSD');
    f.at(closeTimeMs + 15_000);
    await Promise.all([f.worker.runDue(), f.worker.runDue()]);
    assert.equal(f.requests.length, 1);
    await f.worker.runDue(); assert.equal(f.requests.length, 1);
    f.at(closeTimeMs + 16_000); await f.worker.runDue();
    assert.equal(f.requests.length, 2);
    for (const delay of [75_000, 180_000, 600_000]) {
      f.at(closeTimeMs + delay); await f.worker.runDue();
      f.at(closeTimeMs + delay + 1000); await f.worker.runDue();
    }
    assert.equal(f.worker.status().pending, 0);
    assert.equal(f.worker.status().failed, 8);
    assert.equal(f.worker.status().exhausted, 2);
    assert.equal(f.corrected.length, 0);
  } finally { await f.close(); }
});

test('shutdown detaches the listener and discards an in-flight provider response', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  f.rollover(); f.at(closeTimeMs + 15_000);
  const pending = f.worker.runDue();
  const stopping = f.worker.stop();
  resolve([providerBar]);
  await Promise.all([pending, stopping]);
  assert.equal(f.corrected.length, 0);
  assert.equal(f.eventBus.listenerCount('market.candle.closed'), 0);
  await f.close();
});

test('scope is limited to completed Twelve Data forex M5 and the queue is bounded', async () => {
  const f = fixture();
  try {
    f.at(closeTimeMs);
    const candle = { ...providerBar, symbol: 'GBPUSD', timeframe: '5m', complete: true };
    f.worker.enqueue({ ...candle, complete: false });
    f.worker.enqueue({ ...candle, timeframe: '1m' });
    f.worker.enqueue({ ...candle, openTimeMs: closeTimeMs });
    const get = f.worker.instrumentRegistry.get;
    f.worker.instrumentRegistry.get = () => ({ provider: 'accelpix', assetClass: 'FOREX' });
    f.worker.enqueue(candle);
    f.worker.instrumentRegistry.get = () => ({ provider: 'twelve-data', assetClass: 'METAL' });
    f.worker.enqueue(candle);
    assert.equal(f.worker.status().pending, 0);
    f.worker.instrumentRegistry.get = get;
    f.worker.maxPending = 1;
    f.worker.enqueue(candle);
    f.worker.enqueue({ ...candle, symbol: 'EURUSD' });
    assert.equal(f.worker.status().pending, 1);
    assert.equal(f.worker.status().dropped, 1);
  } finally { await f.close(); }
});

test('a late retry can correct an older bar without rolling back the newer closed bar', async () => {
  let available = false;
  const f = fixture(async () => available ? [providerBar] : []);
  try {
    f.rollover();
    f.at(closeTimeMs + 15_000); await f.worker.runDue();
    f.at(closeTimeMs + 75_000); await f.worker.runDue();
    f.at(closeTimeMs + 180_000); await f.worker.runDue();
    f.at(closeTimeMs + 300_000);
    f.engine.processTick({ symbol: 'GBPUSD', timeMs: closeTimeMs + 300_000, price: 1.326, source: 'twelve-data' });
    const newer = f.engine.getLastClosed('GBPUSD', '5m');
    f.at(closeTimeMs + 600_000); available = true;
    // Newer queued bar is due first, then the older retry.
    await f.worker.runDue();
    f.at(closeTimeMs + 601_000); await f.worker.runDue();
    assert.equal(f.corrected.at(-1).openTimeMs, openTimeMs);
    assert.equal(f.corrected.at(-1).high, providerBar.high);
    assert.deepEqual(f.engine.getLastClosed('GBPUSD', '5m'), newer);
  } finally { await f.close(); }
});

test('series invalidation blocks stale in-flight cache writes without evicting other symbols', async () => {
  const cache = new ProviderHistoryCache();
  const args = key => ({ key, timeframe: '5m', limit: 2 });
  await cache.getOrLoad({ ...args('twelve-data:EUR/USD:5m:latest'), load: async () => [providerBar] });
  let resolve;
  const pending = cache.getOrLoad({ ...args('twelve-data:GBP/USD:5m:latest'), load: () => new Promise(done => { resolve = done; }) });
  await Promise.resolve();
  cache.invalidatePrefix('twelve-data:GBP/USD:5m:');
  resolve([providerBar]); await pending;
  assert.equal(cache.stats().entries, 1);
  let freshLoads = 0;
  await cache.getOrLoad({ ...args('twelve-data:GBP/USD:5m:latest'), load: async () => { freshLoads++; return [providerBar]; } });
  assert.equal(freshLoads, 1);
});
