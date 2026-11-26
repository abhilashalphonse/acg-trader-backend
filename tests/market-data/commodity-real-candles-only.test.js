'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { CandleEngine } = require('../../src/modules/market-data/candle-engine');
const { Candle } = require('../../src/modules/market-data/candle.model');
const { MarketHistoryService } = require('../../src/modules/market-data/history.service');
const { ProviderHistoryCache } = require('../../src/modules/market-data/history-cache');
const { ACG_INSTRUMENT_CATALOG } = require('../../src/modules/instruments/instrument-catalog');

const instruments = new Map(ACG_INSTRUMENT_CATALOG.map(spec =>
  [spec.symbol, { ...spec, configured: true, provider: 'twelve-data' }]));
const ms = iso => Date.parse(iso);
const logger = { warn() {}, error() {} };
const registry = {
  get(symbol) { return instruments.get(symbol) || null; },
  provider() { return 'twelve-data'; },
  providerSymbol(symbol) { return instruments.get(symbol)?.providerMappings?.twelveData; },
};
function tick(symbol, when, price) {
  return { symbol, timeMs: ms(when), price, source: 'twelve-data' };
}
function engineFor(symbol) {
  const bus = new EventEmitter();
  const updates = [];
  const closed = [];
  bus.on('market.candle.update', bar => updates.push(bar));
  bus.on('market.candle.closed', bar => closed.push(bar));
  const engine = new CandleEngine({
    eventBus: bus,
    timeframes: ['1m'],
    persistTimeframes: [],
    flushIntervalMs: 60000,
    maxSyntheticGapBars: 12,
    instrumentRegistry: registry,
    logger,
    persistCandle: async () => {},
  });
  return { engine, updates, closed };
}

test('gold accepts REAL Twelve Data prices during 22:00-23:00 UTC, never fabricates flat bars through a quiet 5-minute gap', () => {
  const { engine, updates, closed } = engineFor('XAUUSD');
  engine.processTick(tick('XAUUSD', '2026-11-25T21:59:10Z', 4180));
  engine.flushExpired(ms('2026-11-25T22:00:01Z'));
  assert.equal(engine.getCurrent('XAUUSD', '1m'), null);
  const updateCount = updates.length;
  const closeCount = closed.length;
  engine.flushExpired(ms('2026-11-25T22:03:00Z'));
  assert.equal(updates.length, updateCount, 'no zero-tick carry-forward updates');
  assert.equal(closed.length, closeCount, 'no synthetic closed bars');

  engine.processTick(tick('XAUUSD', '2026-11-25T22:05:20Z', 4182));
  const reopened = engine.getCurrent('XAUUSD', '1m');
  assert.equal(reopened.openTimeMs, ms('2026-11-25T22:05:00Z'));
  assert.equal(reopened.open, 4182);
  assert.equal(reopened.tickCount, 1);
  assert.equal(reopened.synthetic, false);
  assert.equal(closed.filter(bar => bar.synthetic).length, 0);
  assert.equal(updates.filter(bar => bar.synthetic).length, 0);
});

test('silver, energy and agricultural instruments never generate copied OHLC across short feed gaps', () => {
  for (const symbol of ['XAGUSD','XPTUSD','XPDUSD','WTIUSD','XBRUSD','NGASUSD','COPPER','CORN','WHEAT','SOYBEAN']) {
    const { engine, closed, updates } = engineFor(symbol);
    const first = '2026-11-25T20:55:10Z';
    engine.processTick(tick(symbol, first, 100));
    engine.flushExpired(ms('2026-11-25T20:56:01Z'));
    engine.flushExpired(ms('2026-11-25T20:59:01Z'));
    assert.equal(closed.filter(bar => bar.synthetic).length, 0, symbol);
    assert.equal(updates.filter(bar => bar.synthetic).length, 0, symbol);
  }
});

test('gold historical provider OHLC at 22:00 UTC remains authoritative and is never discarded as a futures exchange closure', async () => {
  const oldFind = Candle.find;
  Candle.find = () => ({
    sort() { return this; },
    limit() { return this; },
    async lean() { return []; },
  });
  const bars = [
    { openTimeMs: ms('2026-11-25T21:55:00Z'), open: 4190, high: 4192, low: 4189, close: 4191 },
    { openTimeMs: ms('2026-11-25T22:00:00Z'), open: 4191, high: 4193, low: 4190, close: 4192 },
    { openTimeMs: ms('2026-11-25T22:05:00Z'), open: 4192, high: 4194, low: 4190, close: 4193 },
    { openTimeMs: ms('2026-11-25T22:10:00Z'), open: 4193, high: 4196, low: 4191, close: 4195 },
  ];
  const history = new MarketHistoryService({
    adapter: { supportsHistory() { return true; }, async fetchHistorical() { return bars; } },
    instrumentRegistry: registry,
    historyCache: new ProviderHistoryCache(),
    logger,
  });
  try {
    const actual = await history.getCandles({ symbol: 'XAUUSD', timeframe: '5m', limit: 25 });
    assert.deepEqual(actual.map(bar => bar.openTimeMs), bars.map(bar => bar.openTimeMs));
    assert.deepEqual(actual.map(bar => bar.close), bars.map(bar => bar.close));
    assert.equal(actual.every(bar => !bar.synthetic), true);
  } finally {
    Candle.find = oldFind;
  }
});
