'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { Candle } = require('../../src/modules/market-data/candle.model');
const { CandleEngine } = require('../../src/modules/market-data/candle-engine');
const { MarketHistoryService } = require('../../src/modules/market-data/history.service');
const { ProviderHistoryCache } = require('../../src/modules/market-data/history-cache');
const { ACG_INSTRUMENT_CATALOG } = require('../../src/modules/instruments/instrument-catalog');

const instrument = ACG_INSTRUMENT_CATALOG.find(item => item.symbol === 'XAUUSD');
const registry = {
  get(symbol) { return symbol === 'XAUUSD' ? { ...instrument, configured: true } : null; },
  provider() { return 'twelve-data'; },
  providerSymbol() { return 'XAU/USD'; },
};
const utc = iso => Date.parse(iso);
const tick = (iso, price) => ({ symbol: 'XAUUSD', timeMs: utc(iso), price, source: 'test' });

test('live candle engine cannot generate rollover flats, accepts no off-session ticks, and resumes on real reopening tick', () => {
  const bus = new EventEmitter();
  const closed = [];
  const updates = [];
  bus.on('market.candle.closed', c => closed.push(c));
  bus.on('market.candle.update', c => updates.push(c));
  const engine = new CandleEngine({
    eventBus: bus,
    timeframes: ['1m'],
    persistTimeframes: [],
    flushIntervalMs: 60000,
    maxSyntheticGapBars: 12,
    instrumentRegistry: registry,
    logger: { warn() {}, error() {} },
    persistCandle: async () => {},
  });

  engine.processTick(tick('2026-11-25T21:59:10Z', 4180));
  engine.flushExpired(utc('2026-11-25T22:00:02Z'));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].synthetic, false);
  assert.equal(engine.getCurrent('XAUUSD', '1m'), null);

  const countBeforeClosure = updates.length;
  engine.processTick(tick('2026-11-25T22:15:00Z', 4180));
  engine.flushExpired(utc('2026-11-25T22:50:00Z'));
  assert.equal(engine.getCurrent('XAUUSD', '1m'), null);
  assert.equal(updates.length, countBeforeClosure);
  assert.equal(closed.length, 1);

  engine.processTick(tick('2026-11-25T23:00:05Z', 4181));
  const reopened = engine.getCurrent('XAUUSD', '1m');
  assert.equal(reopened.openTimeMs, utc('2026-11-25T23:00:00Z'));
  assert.equal(reopened.open, 4181);
  assert.equal(reopened.synthetic, false);
  assert.equal(closed.filter(c => c.synthetic).length, 0);
});

test('history excludes Twelve Data flat rows in the configured gold break without altering genuine market OHLC', async () => {
  const originalFind = Candle.find;
  Candle.find = () => ({
    sort() { return this; },
    limit() { return this; },
    async lean() { return []; },
  });
  const sourceBars = [
    { openTimeMs: utc('2026-11-25T21:55:00Z'), open: 4180, high: 4182, low: 4179, close: 4181 },
    { openTimeMs: utc('2026-11-25T22:05:00Z'), open: 4181, high: 4181, low: 4181, close: 4181 },
    { openTimeMs: utc('2026-11-25T22:10:00Z'), open: 4181, high: 4181, low: 4181, close: 4181 },
    { openTimeMs: utc('2026-11-25T23:00:00Z'), open: 4183, high: 4185, low: 4182, close: 4184 },
  ];
  const service = new MarketHistoryService({
    adapter: {
      supportsHistory() { return true; },
      async fetchHistorical() { return sourceBars; },
    },
    instrumentRegistry: registry,
    historyCache: new ProviderHistoryCache(),
    logger: { warn() {} },
  });
  try {
    const bars = await service.getCandles({ symbol: 'XAUUSD', timeframe: '5m', limit: 20 });
    assert.deepEqual(bars.map(c => c.openTimeMs), [
      utc('2026-11-25T21:55:00Z'),
      utc('2026-11-25T23:00:00Z'),
    ]);
    assert.deepEqual(bars.map(c => c.close), [4181, 4184]);
    assert.ok(bars.every(c => c.synthetic === false));
  } finally {
    Candle.find = originalFind;
  }
});
