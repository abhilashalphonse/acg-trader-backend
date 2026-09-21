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
