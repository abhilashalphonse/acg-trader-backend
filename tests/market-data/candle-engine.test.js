'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { CandleEngine } = require('../../src/modules/market-data/candle-engine');

const logger = { error() {} };

function tick(timeMs, price) {
  return { symbol: 'EURUSD', timeMs, price, source: 'test' };
}

function createEngine(bus) {
  return new CandleEngine({
    eventBus: bus,
    timeframes: ['5s'],
    persistTimeframes: [],
    flushIntervalMs: 100000,
    maxSyntheticGapBars: 12,
    logger,
    persistCandle: async () => {},
  });
}

test('aggregates ticks into a 5s candle and closes on the next bucket', () => {
  const bus = new EventEmitter();
  const closed = [];
  bus.on('market.candle.closed', candle => closed.push(candle));
  const engine = createEngine(bus);

  engine.processTick(tick(1000, 1.1));
  engine.processTick(tick(3000, 1.2));
  engine.processTick(tick(6000, 1.15));

  assert.equal(closed.length, 1);
  assert.equal(closed[0].timeframe, '5s');
  assert.equal(closed[0].open, 1.1);
  assert.equal(closed[0].high, 1.2);
  assert.equal(closed[0].low, 1.1);
  assert.equal(closed[0].close, 1.2);
  assert.equal(closed[0].tickCount, 2);
  assert.equal(closed[0].synthetic, false);

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.open, 1.15);
  assert.equal(current.openTimeMs, 5000);
});

test('creates a live carry-forward candle immediately at a quiet boundary', () => {
  const bus = new EventEmitter();
  const updates = [];
  const closed = [];
  bus.on('market.candle.update', candle => updates.push(candle));
  bus.on('market.candle.closed', candle => closed.push(candle));
  const engine = createEngine(bus);

  engine.processTick(tick(1000, 1.1));
  engine.flushExpired(5000);

  assert.equal(closed.length, 1);
  assert.equal(closed[0].openTimeMs, 0);
  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.openTimeMs, 5000);
  assert.equal(current.open, 1.1);
  assert.equal(current.close, 1.1);
  assert.equal(current.tickCount, 0);
  assert.equal(current.synthetic, true);
  assert.ok(updates.some(item => item.openTimeMs === 5000 && item.synthetic === true));
});

test('first real tick replaces a provisional synthetic candle with real OHLC', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick(tick(1000, 1.1));
  engine.flushExpired(5000);
  engine.processTick(tick(7000, 1.2));

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.openTimeMs, 5000);
  assert.equal(current.open, 1.2);
  assert.equal(current.high, 1.2);
  assert.equal(current.low, 1.2);
  assert.equal(current.close, 1.2);
  assert.equal(current.tickCount, 1);
  assert.equal(current.synthetic, false);
  assert.equal(current.source, 'LIVE');
});

test('does not fabricate carry-forward candles while the symbol feed is stale', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick(tick(1000, 1.1));
  engine.setSymbolLive('EURUSD', false);
  engine.flushExpired(5000);

  assert.equal(engine.getCurrent('EURUSD', '5s'), null);
});

test('does not backfill a known provider outage when ticks resume', () => {
  const bus = new EventEmitter();
  const closed = [];
  bus.on('market.candle.closed', candle => closed.push(candle));
  const engine = createEngine(bus);

  engine.processTick(tick(1000, 1.1));
  engine.setSymbolLive('EURUSD', false);
  engine.flushExpired(5000);
  engine.processTick(tick(16000, 1.2));

  assert.equal(closed.length, 1);
  assert.equal(closed[0].openTimeMs, 0);
  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.openTimeMs, 15000);
  assert.equal(current.synthetic, false);
});

test('fills only short missing-candle gaps with synthetic bars when feed continuity is intact', () => {
  const bus = new EventEmitter();
  const closed = [];
  bus.on('market.candle.closed', candle => closed.push(candle));
  const engine = createEngine(bus);

  engine.processTick(tick(1000, 1.1));
  engine.flushExpired(5000);
  engine.processTick(tick(16000, 1.2));

  assert.equal(closed.length, 3);
  assert.equal(closed[1].synthetic, true);
  assert.equal(closed[1].openTimeMs, 5000);
  assert.equal(closed[2].synthetic, true);
  assert.equal(closed[2].openTimeMs, 10000);

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.openTimeMs, 15000);
  assert.equal(current.synthetic, false);
});


test('uses bid as the live chart price when bid is available', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick({
    symbol: 'EURUSD',
    timeMs: 1000,
    price: 1.10010,
    bid: 1.10000,
    ask: 1.10020,
    source: 'test',
  });

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.open, 1.1);
  assert.equal(current.high, 1.1);
  assert.equal(current.low, 1.1);
  assert.equal(current.close, 1.1);
});


test('accumulates positive provider day-volume deltas into the live candle', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick({ symbol: 'EURUSD', timeMs: 1000, price: 1.1, dayVolume: 1000, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 2000, price: 1.11, dayVolume: 1007, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 3000, price: 1.12, dayVolume: 1012, source: 'test' });

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.providerVolume, 12);
  assert.equal(current.tickCount, 3);
});

test('starts a new candle with only the provider-volume delta belonging to that candle', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick({ symbol: 'EURUSD', timeMs: 1000, price: 1.1, dayVolume: 1000, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 4000, price: 1.11, dayVolume: 1006, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 6000, price: 1.12, dayVolume: 1010, source: 'test' });

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.openTimeMs, 5000);
  assert.equal(current.providerVolume, 4);
  assert.equal(current.tickCount, 1);
});

test('does not create a false volume spike when provider day volume resets', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick({ symbol: 'EURUSD', timeMs: 1000, price: 1.1, dayVolume: 5000, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 2000, price: 1.11, dayVolume: 5010, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 3000, price: 1.12, dayVolume: 3, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 4000, price: 1.13, dayVolume: 8, source: 'test' });

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.providerVolume, 15);
});

test('keeps provider volume unavailable when the feed does not supply day volume', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick({ symbol: 'EURUSD', timeMs: 1000, price: 1.1, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 2000, price: 1.11, source: 'test' });

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.providerVolume, null);
  assert.equal(current.tickCount, 2);
});
