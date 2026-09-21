'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { CandleEngine } = require('../../src/modules/market-data/candle-engine');

const logger = { error() {}, warn() {} };

function alwaysOpenRegistry(overrides = {}) {
  const instrument = {
    symbol: 'EURUSD',
    configured: true,
    status: 'ACTIVE',
    timezone: 'UTC',
    tradingSessions: [],
    tradingHolidays: [],
    ...overrides,
  };
  return {
    get(symbol) { return symbol === 'EURUSD' ? instrument : null; },
  };
}

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
    instrumentRegistry: alwaysOpenRegistry(),
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


test('keeps live chart candles on the provider price series when execution midpoint differs', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick({
    symbol: 'EURUSD',
    timeMs: 1000,
    price: 1.10010,
    referencePrice: 1.10030,
    mid: 1.10030,
    bid: 1.09925,
    ask: 1.10135,
    source: 'test',
  });

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.open, 1.1001);
  assert.equal(current.high, 1.1001);
  assert.equal(current.low, 1.1001);
  assert.equal(current.close, 1.1001);
});

test('falls back to reference price when a feed does not expose provider price', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick({
    symbol: 'EURUSD',
    timeMs: 1000,
    price: null,
    referencePrice: 1.10030,
    bid: 1.09925,
    ask: 1.10135,
    source: 'test',
  });

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.open, 1.1003);
  assert.equal(current.close, 1.1003);
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


test('anchors weekly candles to Monday 00:00 UTC instead of Unix-epoch Thursday', () => {
  const bus = new EventEmitter();
  const engine = new CandleEngine({
    eventBus: bus,
    timeframes: ['1w'],
    persistTimeframes: [],
    flushIntervalMs: 100000,
    maxSyntheticGapBars: 12,
    instrumentRegistry: alwaysOpenRegistry(),
    logger,
    persistCandle: async () => {},
  });

  const sunday = Date.UTC(2026, 8, 20, 18, 30, 0);
  const monday = Date.UTC(2026, 8, 14, 0, 0, 0);
  engine.processTick(tick(sunday, 1.2));

  const current = engine.getCurrent('EURUSD', '1w');
  assert.equal(current.openTimeMs, monday);
});


test('preserves the last valid provider day-volume anchor across missing samples', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick({ symbol: 'EURUSD', timeMs: 1000, price: 1.1, dayVolume: 1000, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 2000, price: 1.11, dayVolume: 1007, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 3000, price: 1.12, dayVolume: null, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 4000, price: 1.13, dayVolume: 1012, source: 'test' });

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.providerVolume, 12);
  assert.equal(current.tickCount, 4);
});

test('reconciles provider current-bar volume without changing OHLC', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick({ symbol: 'EURUSD', timeMs: 1000, price: 1.1, dayVolume: 1000, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 2000, price: 1.11, dayVolume: 1008, source: 'test' });
  const before = engine.getCurrent('EURUSD', '5s');

  engine.reconcileCurrentVolume('EURUSD', '5s', {
    openTimeMs: 0,
    providerVolume: 120,
    displayVolume: 120,
    volumeMode: 'provider',
  });
  const reconciled = engine.getCurrent('EURUSD', '5s');

  assert.equal(reconciled.open, before.open);
  assert.equal(reconciled.high, before.high);
  assert.equal(reconciled.low, before.low);
  assert.equal(reconciled.close, before.close);
  assert.equal(reconciled.displayVolume, 120);

  engine.processTick({ symbol: 'EURUSD', timeMs: 3000, price: 1.12, dayVolume: 1013, source: 'test' });
  const grown = engine.getCurrent('EURUSD', '5s');
  assert.equal(grown.displayVolume, 125);
});


test('applies a history-selected volume mode to a newer live candle state', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick(tick(6000, 1.2));
  const before = engine.getCurrent('EURUSD', '5s');
  assert.equal(before.volumeMode, null);

  engine.setVolumeMode('EURUSD', '5s', 'tick');
  const after = engine.getCurrent('EURUSD', '5s');

  assert.equal(after.open, before.open);
  assert.equal(after.high, before.high);
  assert.equal(after.low, before.low);
  assert.equal(after.close, before.close);
  assert.equal(after.volumeMode, 'tick');
  assert.equal(after.volumeSource, 'tick');
  assert.equal(after.displayVolume, after.tickCount);
});

test('recovers unavailable volume to tick mode over websocket after three contiguous real closed candles', () => {
  const bus = new EventEmitter();
  const closed = [];
  bus.on('market.candle.closed', candle => closed.push(candle));
  const engine = createEngine(bus);

  engine.processTick(tick(1000, 1.10));
  engine.setVolumeMode('EURUSD', '5s', 'unavailable');

  engine.processTick(tick(6000, 1.11));
  engine.processTick(tick(11000, 1.12));
  engine.processTick(tick(16000, 1.13));

  assert.equal(closed.length, 3);
  assert.equal(closed[0].volumeMode, 'unavailable');
  assert.equal(closed[0].displayVolume, null);
  assert.equal(closed[1].volumeMode, 'unavailable');
  assert.equal(closed[1].displayVolume, null);
  assert.equal(closed[2].volumeMode, 'tick');
  assert.equal(closed[2].volumeSource, 'tick');
  assert.equal(closed[2].displayVolume, 1);

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.volumeMode, 'tick');
  assert.equal(current.volumeSource, 'tick');
  assert.equal(current.displayVolume, 1);
});

test('synthetic gaps break unavailable-to-tick recovery continuity', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick(tick(1000, 1.10));
  engine.setVolumeMode('EURUSD', '5s', 'unavailable');
  engine.processTick(tick(6000, 1.11));
  engine.flushExpired(15000); // closes the real 5s bar, then creates/closes a synthetic 10s bar
  engine.processTick(tick(16000, 1.12));
  engine.processTick(tick(21000, 1.13));

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.volumeMode, 'unavailable');
});


test('does not manufacture synthetic H4 candles when a higher-timeframe boundary passes', () => {
  const bus = new EventEmitter();
  const closed = [];
  bus.on('market.candle.closed', candle => closed.push(candle));
  const engine = new CandleEngine({
    eventBus: bus,
    timeframes: ['4h'],
    persistTimeframes: [],
    flushIntervalMs: 100000,
    maxSyntheticGapBars: 12,
    instrumentRegistry: alwaysOpenRegistry(),
    logger,
    persistCandle: async () => {},
  });

  const firstTick = Date.UTC(2026, 8, 18, 0, 10, 0);
  engine.processTick(tick(firstTick, 4345));
  engine.flushExpired(Date.UTC(2026, 8, 18, 4, 0, 0));

  assert.equal(closed.length, 1);
  assert.equal(closed[0].synthetic, false);
  assert.equal(engine.getCurrent('EURUSD', '4h'), null);
});

test('does not create intraday synthetic candles after the configured market session closes', () => {
  const bus = new EventEmitter();
  const engine = new CandleEngine({
    eventBus: bus,
    timeframes: ['1m'],
    persistTimeframes: [],
    flushIntervalMs: 100000,
    maxSyntheticGapBars: 12,
    instrumentRegistry: alwaysOpenRegistry({
      tradingSessions: [{ days: [5], open: '00:00', close: '22:00' }],
    }),
    logger,
    persistCandle: async () => {},
  });

  engine.processTick(tick(Date.UTC(2026, 8, 18, 21, 59, 30), 4345));
  engine.flushExpired(Date.UTC(2026, 8, 18, 22, 0, 0));

  assert.equal(engine.getCurrent('EURUSD', '1m'), null);
});

test('keeps short intraday synthetic continuity while the configured session is open', () => {
  const bus = new EventEmitter();
  const engine = new CandleEngine({
    eventBus: bus,
    timeframes: ['1m'],
    persistTimeframes: [],
    flushIntervalMs: 100000,
    maxSyntheticGapBars: 12,
    instrumentRegistry: alwaysOpenRegistry({
      tradingSessions: [{ days: [5], open: '00:00', close: '22:00' }],
    }),
    logger,
    persistCandle: async () => {},
  });

  engine.processTick(tick(Date.UTC(2026, 8, 18, 12, 0, 30), 4345));
  engine.flushExpired(Date.UTC(2026, 8, 18, 12, 1, 0));

  const current = engine.getCurrent('EURUSD', '1m');
  assert.ok(current);
  assert.equal(current.openTimeMs, Date.UTC(2026, 8, 18, 12, 1, 0));
  assert.equal(current.synthetic, true);
  assert.equal(current.tickCount, 0);
});

test('never persists synthetic carry-forward candles', () => {
  const bus = new EventEmitter();
  const persisted = [];
  const engine = new CandleEngine({
    eventBus: bus,
    timeframes: ['5s'],
    persistTimeframes: ['5s'],
    flushIntervalMs: 100000,
    maxSyntheticGapBars: 12,
    instrumentRegistry: alwaysOpenRegistry(),
    logger,
    persistCandle: async candle => { persisted.push(candle); },
  });

  engine.processTick(tick(1000, 1.1));
  engine.flushExpired(10000);

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].synthetic, false);
  assert.equal(persisted[0].openTimeMs, 0);
});

test('refuses synthetic candles when session metadata is not configured', () => {
  const bus = new EventEmitter();
  const engine = new CandleEngine({
    eventBus: bus,
    timeframes: ['1m'],
    persistTimeframes: [],
    flushIntervalMs: 100000,
    maxSyntheticGapBars: 12,
    instrumentRegistry: alwaysOpenRegistry({ configured: false }),
    logger,
    persistCandle: async () => {},
  });

  engine.processTick(tick(Date.UTC(2026, 8, 18, 12, 0, 30), 4345));
  engine.flushExpired(Date.UTC(2026, 8, 18, 12, 1, 0));

  assert.equal(engine.getCurrent('EURUSD', '1m'), null);
});
