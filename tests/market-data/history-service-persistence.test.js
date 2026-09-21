'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Candle } = require('../../src/modules/market-data/candle.model');
const { MarketHistoryService } = require('../../src/modules/market-data/history.service');

test('provider history is returned without persisting backfill rows to MongoDB', async () => {
  const originalFind = Candle.find;
  const originalBulkWrite = Candle.bulkWrite;
  let bulkWrites = 0;

  Candle.find = () => ({
    sort() { return this; },
    limit() { return this; },
    async lean() { return []; },
  });
  Candle.bulkWrite = async () => {
    bulkWrites += 1;
    throw new Error('provider history must not be persisted');
  };

  const adapter = {
    supportsHistory() { return true; },
    async fetchHistorical() {
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
    persistTimeframes: ['1m', '5m', '1d', '1w'],
    logger: { warn() {} },
  });

  try {
    const bars = await service.getCandles({ symbol: 'XAUUSD', timeframe: '5m', limit: 160 });
    assert.equal(bars.length, 1);
    assert.equal(bars[0].open, 4340);
    assert.equal(bars[0].close, 4348);
    assert.equal(bars[0].source, 'BACKFILL');
    assert.equal(bulkWrites, 0);
  } finally {
    Candle.find = originalFind;
    Candle.bulkWrite = originalBulkWrite;
  }
});

test('local live candle fallback remains available when provider history fails', async () => {
  const originalFind = Candle.find;
  const openTime = new Date(Date.UTC(2026, 8, 21, 20, 0, 0));

  Candle.find = () => ({
    sort() { return this; },
    limit() { return this; },
    async lean() {
      return [{
        symbol: 'XAUUSD',
        timeframe: '5m',
        openTime,
        closeTime: new Date(openTime.getTime() + 300000),
        open: '4340',
        high: '4350',
        low: '4335',
        close: '4348',
        tickCount: 25,
        providerVolume: null,
        complete: true,
        synthetic: false,
        source: 'LIVE',
        provider: 'twelve-data',
      }];
    },
  });

  const service = new MarketHistoryService({
    adapter: {
      supportsHistory() { return true; },
      async fetchHistorical() { throw new Error('provider unavailable'); },
    },
    instrumentRegistry: { providerSymbol() { return 'XAU/USD'; } },
    persistTimeframes: ['5m'],
    logger: { warn() {} },
  });

  try {
    const bars = await service.getCandles({ symbol: 'XAUUSD', timeframe: '5m', limit: 160 });
    assert.equal(bars.length, 1);
    assert.equal(bars[0].close, 4348);
    assert.equal(bars[0].source, 'LIVE');
  } finally {
    Candle.find = originalFind;
  }
});
