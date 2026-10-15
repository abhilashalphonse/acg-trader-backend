'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Candle } = require('../../src/modules/market-data/candle.model');
const { MarketHistoryService } = require('../../src/modules/market-data/history.service');
const { ProviderHistoryCache } = require('../../src/modules/market-data/history-cache');

function stubLocalRows(rows = []) {
  const originalFind = Candle.find;
  Candle.find = () => ({
    sort() { return this; },
    limit() { return this; },
    async lean() { return rows; },
  });
  return () => { Candle.find = originalFind; };
}

test('history service reuses cached provider bars without persisting them', async () => {
  const restore = stubLocalRows([]);
  let providerCalls = 0;
  const adapter = {
    supportsHistory() { return true; },
    async fetchHistorical() {
      providerCalls += 1;
      return [{
        openTimeMs: Date.UTC(2026, 8, 21, 20, 0, 0),
        open: 4340,
        high: 4350,
        low: 4335,
        close: 4348,
        providerVolume: 120,
      }];
    },
  };
  const service = new MarketHistoryService({
    adapter,
    instrumentRegistry: { providerSymbol() { return 'XAU/USD'; } },
    historyCache: new ProviderHistoryCache(),
    logger: { warn() {} },
  });

  try {
    const first = await service.getCandles({ symbol: 'XAUUSD', timeframe: '5m', limit: 160 });
    const second = await service.getCandles({ symbol: 'XAUUSD', timeframe: '5m', limit: 160 });

    assert.equal(first.length, 1);
    assert.deepEqual(second, first);
    assert.equal(providerCalls, 1);
    assert.equal(service.cacheStats().hits, 1);
  } finally {
    restore();
  }
});

test('history service deduplicates concurrent chart requests for the same provider series', async () => {
  const restore = stubLocalRows([]);
  let providerCalls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  const service = new MarketHistoryService({
    adapter: {
      supportsHistory() { return true; },
      async fetchHistorical() {
        providerCalls += 1;
        await gate;
        return [{
          openTimeMs: Date.UTC(2026, 8, 21, 20, 0, 0),
          open: 4340,
          high: 4350,
          low: 4335,
          close: 4348,
          providerVolume: null,
        }];
      },
    },
    instrumentRegistry: { providerSymbol() { return 'XAU/USD'; } },
    historyCache: new ProviderHistoryCache(),
    logger: { warn() {} },
  });

  try {
    const requests = [
      service.getCandles({ symbol: 'XAUUSD', timeframe: '5m', limit: 160 }),
      service.getCandles({ symbol: 'XAUUSD', timeframe: '5m', limit: 160 }),
      service.getCandles({ symbol: 'XAUUSD', timeframe: '5m', limit: 160 }),
    ];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(providerCalls, 1);
    release();

    const results = await Promise.all(requests);
    assert.deepEqual(results.map(result => result.length), [1, 1, 1]);
    assert.equal(providerCalls, 1);
    assert.equal(service.cacheStats().deduped, 2);
  } finally {
    restore();
  }
});


test('history pages are cursor-scoped, deduplicated, and expose an exclusive next cursor', async () => {
  const originalFind = Candle.find;
  const seenLocalFilters = [];
  Candle.find = filter => ({
    sort() { seenLocalFilters.push(filter); return this; },
    limit() { return this; },
    async lean() { return []; },
  });

  const calls = [];
  const base = Date.UTC(2026, 8, 21, 20, 0, 0);
  const makeBars = count => Array.from({ length: count }, (_, index) => ({
    openTimeMs: base + index * 300_000,
    open: 4300 + index,
    high: 4301 + index,
    low: 4299 + index,
    close: 4300.5 + index,
    providerVolume: 10 + index,
  }));

  const service = new MarketHistoryService({
    adapter: {
      supportsHistory() { return true; },
      async fetchHistorical(args) {
        calls.push(args);
        return makeBars(args.limit);
      },
    },
    instrumentRegistry: { providerSymbol() { return 'XAU/USD'; } },
    historyCache: new ProviderHistoryCache(),
    logger: { warn() {} },
  });

  try {
    const beforeMs = base + 10_000_000;
    const first = await service.getCandlePage({
      symbol: 'XAUUSD',
      timeframe: '5m',
      limit: 3,
      beforeMs,
    });
    const second = await service.getCandlePage({
      symbol: 'XAUUSD',
      timeframe: '5m',
      limit: 3,
      beforeMs,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].limit, 4);
    assert.equal(calls[0].beforeMs, beforeMs);
    assert.equal(first.candles.length, 3);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextBefore, first.candles[0].openTimeMs);
    assert.deepEqual(second, first);
    assert.equal(service.cacheStats().hits, 1);
    assert.ok(seenLocalFilters.some(filter => filter.openTime != null));
  } finally {
    Candle.find = originalFind;
  }
});


test('cached partial provider bar does not become complete without final data and reconciles completed local OHLC', async () => {
  const originalFind = Candle.find;
  let localRows = [];
  Candle.find = () => ({
    sort() { return this; },
    limit() { return this; },
    async lean() { return localRows; },
  });

  let providerCalls = 0;
  const stepMs = 300_000;
  const openTimeMs = Date.now() - 30_000;

  const service = new MarketHistoryService({
    adapter: {
      supportsHistory() { return true; },
      async fetchHistorical() {
        providerCalls += 1;
        return [{
          openTimeMs,
          open: 100,
          high: 110,
          low: 95,
          close: 105,
          providerVolume: 120,
        }];
      },
    },
    instrumentRegistry: {
      provider() { return 'twelve-data'; },
      providerSymbol() { return 'TEST'; },
    },
    historyCache: new ProviderHistoryCache({ ttlByTimeframe: { '5m': 60_000 } }),
    logger: { warn() {} },
  });

  try {
    const first = await service.getCandles({ symbol: 'TEST', timeframe: '5m', limit: 10 });
    assert.equal(first.length, 1);
    assert.equal(first[0].complete, false);

    localRows = [{
      symbol: 'TEST',
      timeframe: '5m',
      openTime: new Date(openTimeMs),
      closeTime: new Date(openTimeMs + stepMs),
      open: '100',
      high: '120',
      low: '90',
      close: '115',
      tickCount: 20,
      providerVolume: '150',
      complete: true,
      synthetic: false,
      source: 'LIVE',
      provider: 'twelve-data',
    }];

    const second = await service.getCandles({ symbol: 'TEST', timeframe: '5m', limit: 10 });
    assert.equal(providerCalls, 1);
    assert.equal(second.length, 1);
    assert.equal(second[0].complete, true);
    assert.equal(second[0].open, 100);
    assert.equal(second[0].high, 120);
    assert.equal(second[0].low, 90);
    assert.equal(second[0].close, 115);
    assert.equal(second[0].source, 'LIVE_RECONCILED');
  } finally {
    Candle.find = originalFind;
  }
});


test('history filters fully closed weekend bars and keeps the Friday-to-reopen series contiguous', async () => {
  const restore = stubLocalRows([]);
  const calls = [];
  const fxWeek = [
    { days: [0], open: '22:00', close: '23:59' },
    { days: [1, 2, 3, 4], open: '00:00', close: '23:59' },
    { days: [5], open: '00:00', close: '22:00' },
  ];
  const instrument = {
    symbol: 'AUDCAD',
    configured: true,
    provider: 'twelve-data',
    providerSymbol: 'AUD/CAD',
    status: 'ACTIVE',
    timezone: 'UTC',
    tradingSessions: fxWeek,
    tradingHolidays: [],
  };

  const service = new MarketHistoryService({
    adapter: {
      supportsHistory() { return true; },
      async fetchHistorical(args) {
        calls.push(args);
        return [
          { openTimeMs: Date.UTC(2026, 9, 2, 21, 30), open: 0.99, high: 0.991, low: 0.989, close: 0.9905, providerVolume: null },
          { openTimeMs: Date.UTC(2026, 9, 3, 12, 0), open: 0.9905, high: 0.9906, low: 0.9904, close: 0.9905, providerVolume: null },
          { openTimeMs: Date.UTC(2026, 9, 4, 22, 0), open: 0.991, high: 0.992, low: 0.9908, close: 0.9915, providerVolume: null },
        ];
      },
    },
    instrumentRegistry: {
      get() { return instrument; },
      provider() { return 'twelve-data'; },
      providerSymbol() { return 'AUD/CAD'; },
    },
    historyCache: new ProviderHistoryCache(),
    logger: { warn() {} },
  });

  try {
    const bars = await service.getCandles({ symbol: 'AUDCAD', timeframe: '30m', limit: 10 });
    assert.deepEqual(bars.map(bar => bar.openTimeMs), [
      Date.UTC(2026, 9, 2, 21, 30),
      Date.UTC(2026, 9, 4, 22, 0),
    ]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].limit > 11, 'session-aware provider fetch must bridge the closed weekend');
  } finally {
    restore();
  }
});

test('history preserves a higher-timeframe candle that spans the Sunday reopen', async () => {
  const restore = stubLocalRows([]);
  const fxWeek = [
    { days: [0], open: '22:00', close: '23:59' },
    { days: [1, 2, 3, 4], open: '00:00', close: '23:59' },
    { days: [5], open: '00:00', close: '22:00' },
  ];
  const instrument = {
    symbol: 'XAUUSD',
    configured: true,
    provider: 'twelve-data',
    providerSymbol: 'XAU/USD',
    status: 'ACTIVE',
    timezone: 'UTC',
    tradingSessions: fxWeek,
    tradingHolidays: [],
  };
  const service = new MarketHistoryService({
    adapter: {
      supportsHistory() { return true; },
      async fetchHistorical() {
        return [{
          openTimeMs: Date.UTC(2026, 9, 4, 20, 0),
          open: 4300, high: 4310, low: 4290, close: 4305, providerVolume: null,
        }];
      },
    },
    instrumentRegistry: {
      get() { return instrument; },
      provider() { return 'twelve-data'; },
      providerSymbol() { return 'XAU/USD'; },
    },
    historyCache: new ProviderHistoryCache(),
    logger: { warn() {} },
  });

  try {
    const bars = await service.getCandles({ symbol: 'XAUUSD', timeframe: '4h', limit: 10 });
    assert.equal(bars.length, 1);
    assert.equal(bars[0].openTimeMs, Date.UTC(2026, 9, 4, 20, 0));
  } finally {
    restore();
  }
});


test('NSE history keeps provider OHLC and fills only verified completed local gaps', async () => {
  const missing = Date.parse('2026-10-15T07:00:00.000Z');
  const overlap = Date.parse('2026-10-15T08:30:00.000Z');
  const prior = Date.parse('2026-10-14T08:30:00.000Z');
  const localRows = [
    {
      symbol: 'TCS', timeframe: '15m', openTime: new Date(missing),
      open: '100', high: '104', low: '99', close: '103',
      providerVolume: '100', tickCount: 5, complete: true,
      synthetic: false, source: 'LIVE', provider: 'accelpix',
    },
    {
      symbol: 'TCS', timeframe: '15m', openTime: new Date(overlap),
      open: '999', high: '1000', low: '998', close: '999',
      complete: true, synthetic: false, provider: 'accelpix',
    },
    {
      symbol: 'TCS', timeframe: '15m', openTime: new Date(missing + 15 * 60_000),
      open: '100', high: '101', low: '99', close: '100.5',
      complete: false, synthetic: false, provider: 'accelpix',
    },
  ];
  const restore = stubLocalRows(localRows);
  const history = new MarketHistoryService({
    adapter: {
      supportsHistory() { return true; },
      async fetchHistorical() {
        return [
          { openTimeMs: prior, open: 90, high: 95, low: 89, close: 92, providerVolume: 25 },
          { openTimeMs: overlap, open: 105, high: 108, low: 104, close: 107, providerVolume: 50 },
        ];
      },
    },
    instrumentRegistry: {
      provider() { return 'accelpix'; },
      providerSymbol() { return 'TCS'; },
    },
    historyCache: new ProviderHistoryCache(),
    logger: { warn() {} },
  });
  try {
    const bars = await history.getCandles({ symbol: 'TCS', timeframe: '15m', limit: 20 });
    assert.deepEqual(bars.map(bar => bar.openTimeMs), [prior, missing, overlap]);
    assert.equal(bars[1].close, 103);
    assert.equal(bars[1].complete, true);
    assert.equal(bars[2].close, 107); // Provider beats local for matching time.
  } finally {
    restore();
  }
});

test('NSE history does not import synthetic or foreign-provider local candles', async () => {
  const start = Date.parse('2026-10-15T07:00:00.000Z');
  const restore = stubLocalRows([
    { openTime: new Date(start), open: '100', high: '101', low: '99',
      close: '100', provider: 'twelve-data', complete: true, synthetic: false },
    { openTime: new Date(start + 900_000), open: '100', high: '101', low: '99',
      close: '100', provider: 'accelpix', complete: true, synthetic: true },
  ]);
  const service = new MarketHistoryService({
    adapter: {
      supportsHistory() { return true; },
      async fetchHistorical() {
        return [{ openTimeMs: start + 1800_000, open: 100, high: 101, low: 99, close: 100.5 }];
      },
    },
    instrumentRegistry: {
      provider() { return 'accelpix'; },
      providerSymbol() { return 'TCS'; },
    },
    logger: { warn() {} },
  });
  try {
    const bars = await service.getCandles({ symbol: 'TCS', timeframe: '15m', limit: 20 });
    assert.equal(bars.length, 1);
    assert.equal(bars[0].openTimeMs, start + 1800_000);
  } finally {
    restore();
  }
});
