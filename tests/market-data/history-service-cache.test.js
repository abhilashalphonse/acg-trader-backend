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
