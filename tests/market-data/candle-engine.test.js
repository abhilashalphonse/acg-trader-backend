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


test('daily candles never auto-switch to local tick-volume mode', () => {
  const bus = new EventEmitter();
  const engine = new CandleEngine({
    eventBus: bus,
    timeframes: ['1d'],
    persistTimeframes: [],
    flushIntervalMs: 100000,
    maxSyntheticGapBars: 12,
    logger,
    persistCandle: async () => {},
  });

  engine.processTick(tick(Date.UTC(2026, 8, 14, 12), 4300));
  engine.setVolumeMode('EURUSD', '1d', 'unavailable');
  engine.processTick(tick(Date.UTC(2026, 8, 15, 12), 4310));
  engine.processTick(tick(Date.UTC(2026, 8, 16, 12), 4320));
  engine.processTick(tick(Date.UTC(2026, 8, 17, 12), 4330));

  const current = engine.getCurrent('EURUSD', '1d');
  assert.equal(current.volumeMode, 'unavailable');
  assert.equal(current.displayVolume, null);
});


test('late ticks cannot recreate or overwrite an already completed candle', async () => {
  const bus = new EventEmitter();
  const persisted = [];
  const updates = [];
  bus.on('market.candle.update', candle => updates.push(candle));

  const engine = new CandleEngine({
    eventBus: bus,
    timeframes: ['5s'],
    persistTimeframes: ['5s'],
    flushIntervalMs: 100000,
    maxSyntheticGapBars: 0,
    instrumentRegistry: alwaysOpenRegistry(),
    logger,
    persistCandle: async candle => { persisted.push({ ...candle }); },
  });

  engine.processTick({ ...tick(1000, 1.10), sequence: 1 });
  engine.processTick({ ...tick(6000, 1.20), sequence: 2 });
  engine.flushExpired(10000);

  const updateCountBeforeLateTick = updates.length;
  engine.processTick({ ...tick(7000, 9.99), sequence: 3, dayVolume: 9999 });
  engine.flushExpired(15000);
  await engine.stop();

  assert.equal(engine.getCurrent('EURUSD', '5s'), null);
  assert.equal(updates.length, updateCountBeforeLateTick);
  assert.equal(persisted.filter(item => item.openTimeMs === 5000).length, 1);
  assert.equal(persisted.find(item => item.openTimeMs === 5000).close, 1.20);
});

test('older accepted ticks do not move the cumulative-volume baseline backward', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick({ ...tick(1000, 1.10), sequence: 1, dayVolume: 1000 });
  engine.processTick({ ...tick(3000, 1.12), sequence: 3, dayVolume: 1010 });
  engine.processTick({ ...tick(2000, 1.11), sequence: 2, dayVolume: 1005 });
  engine.processTick({ ...tick(4000, 1.13), sequence: 4, dayVolume: 1015 });

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.providerVolume, 15);
  assert.equal(current.tickCount, 4);
});

test('open and close follow event-time order while high and low include reordered ticks', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  // Arrives in the order 3s, 1s, 4s, 2s.
  engine.processTick({ ...tick(3000, 1.13), sequence: 1 });
  engine.processTick({ ...tick(1000, 1.10), sequence: 2 });
  engine.processTick({ ...tick(4000, 1.14), sequence: 3 });
  engine.processTick({ ...tick(2000, 1.08), sequence: 4 });

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.open, 1.10);
  assert.equal(current.high, 1.14);
  assert.equal(current.low, 1.08);
  assert.equal(current.close, 1.14);
  assert.equal(current.tickCount, 4);
});

test('same-timestamp ticks use sequence as the deterministic close tie-breaker', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick({ ...tick(2000, 1.10), sequence: 10 });
  engine.processTick({ ...tick(2000, 1.11), sequence: 11 });
  engine.processTick({ ...tick(2000, 1.09), sequence: 9 });

  const current = engine.getCurrent('EURUSD', '5s');
  assert.equal(current.open, 1.09);
  assert.equal(current.close, 1.11);
  assert.equal(current.high, 1.11);
  assert.equal(current.low, 1.09);
});


test('hydrates provider OHLC, buffers racing ticks, and keeps REST/WS state version aligned', () => {
  const bus = new EventEmitter();
  const updates = [];
  bus.on('market.candle.update', candle => updates.push(candle));
  const engine = createEngine(bus);
  const base = Math.floor((Date.now() + 10_000) / 5_000) * 5_000;

  engine.processTick({ symbol: 'EURUSD', timeMs: base + 1000, sequence: 1, price: 105, dayVolume: 1000, source: 'test' });
  const before = engine.getCurrent('EURUSD', '5s');
  assert.equal(before.open, 105);
  assert.equal(before.close, 105);

  const hydration = engine.beginHydration('EURUSD', '5s');
  assert.equal(hydration.owner, true);

  // This tick must be buffered while the provider snapshot is in flight.
  engine.processTick({ symbol: 'EURUSD', timeMs: base + 2500, sequence: 2, price: 115, dayVolume: 1010, source: 'test' });
  assert.equal(engine.getCurrent('EURUSD', '5s').close, 105);

  const hydrated = engine.completeHydration(hydration, {
    symbol: 'EURUSD',
    timeframe: '5s',
    openTimeMs: base,
    closeTimeMs: base + 5000,
    open: 100,
    high: 120,
    low: 90,
    close: 110,
    tickCount: 0,
    providerVolume: 120,
    displayVolume: 120,
    volumeMode: 'provider',
    complete: false,
    synthetic: false,
    source: 'BACKFILL',
    provider: 'test',
  });

  assert.equal(hydrated.open, 100);
  assert.equal(hydrated.high, 120);
  assert.equal(hydrated.low, 90);
  assert.equal(hydrated.close, 115);
  assert.equal(hydrated.displayVolume, 120);
  assert.equal(updates.at(-1).stateVersion, hydrated.stateVersion);
});

test('repeated history reads cannot roll provider volume backward after hydration', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);
  const base = Math.floor((Date.now() + 10_000) / 5_000) * 5_000;

  engine.processTick({ symbol: 'EURUSD', timeMs: base + 1000, sequence: 1, price: 1.10, dayVolume: 1000, source: 'test' });
  const hydration = engine.beginHydration('EURUSD', '5s');
  engine.completeHydration(hydration, {
    symbol: 'EURUSD',
    timeframe: '5s',
    openTimeMs: base,
    closeTimeMs: base + 5000,
    open: 1.09,
    high: 1.11,
    low: 1.08,
    close: 1.10,
    providerVolume: 120,
    displayVolume: 120,
    volumeMode: 'provider',
    complete: false,
  });

  engine.processTick({ symbol: 'EURUSD', timeMs: base + 2000, sequence: 2, price: 1.11, dayVolume: 1005, source: 'test' });
  assert.equal(engine.getCurrent('EURUSD', '5s').displayVolume, 125);

  const repeated = engine.beginHydration('EURUSD', '5s');
  assert.equal(repeated.skipped, true);
  engine.reconcileCurrentVolume('EURUSD', '5s', {
    openTimeMs: base,
    providerVolume: 120,
    displayVolume: 120,
    volumeMode: 'provider',
  });

  assert.equal(engine.getCurrent('EURUSD', '5s').displayVolume, 125);
});

test('hydrated provider extrema survive rollover and become the authoritative completed candle', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);
  const base = Math.floor((Date.now() + 10_000) / 5_000) * 5_000;

  engine.processTick({ symbol: 'EURUSD', timeMs: base + 1000, sequence: 1, price: 105, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: base + 2000, sequence: 2, price: 107, source: 'test' });

  const hydration = engine.beginHydration('EURUSD', '5s');
  engine.completeHydration(hydration, {
    symbol: 'EURUSD',
    timeframe: '5s',
    openTimeMs: base,
    closeTimeMs: base + 5000,
    open: 100,
    high: 120,
    low: 90,
    close: 106,
    providerVolume: null,
    volumeMode: 'unavailable',
    complete: false,
  });

  engine.processTick({ symbol: 'EURUSD', timeMs: base + 6000, sequence: 3, price: 108, source: 'test' });
  const closed = engine.getLastClosed('EURUSD', '5s');

  assert.equal(closed.open, 100);
  assert.equal(closed.high, 120);
  assert.equal(closed.low, 90);
  assert.equal(closed.close, 107);
  assert.equal(closed.complete, true);
});

test('hydration cannot reopen a bucket that has already been finalized', () => {
  const bus = new EventEmitter();
  const engine = createEngine(bus);

  engine.processTick({ symbol: 'EURUSD', timeMs: 1000, sequence: 1, price: 1.10, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 6000, sequence: 2, price: 1.20, source: 'test' });
  assert.equal(engine.getLastClosed('EURUSD', '5s').openTimeMs, 0);

  const hydration = engine.beginHydration('EURUSD', '5s');
  engine.completeHydration(hydration, {
    symbol: 'EURUSD',
    timeframe: '5s',
    openTimeMs: 0,
    closeTimeMs: Date.now() + 5000,
    open: 9,
    high: 10,
    low: 8,
    close: 9,
    complete: false,
  });

  assert.equal(engine.getLastClosed('EURUSD', '5s').open, 1.10);
  assert.equal(engine.getCurrent('EURUSD', '5s').openTimeMs, 5000);
});

test('completed bar corrections use an explicit path without reopening live state', async () => {
  const bus = new EventEmitter();
  const corrections = [];
  bus.on('market.candle.corrected', candle => corrections.push(candle));
  const engine = createEngine(bus);

  engine.processTick({ symbol: 'EURUSD', timeMs: 1000, sequence: 1, price: 1.10, source: 'test' });
  engine.processTick({ symbol: 'EURUSD', timeMs: 6000, sequence: 2, price: 1.20, source: 'test' });

  const corrected = await engine.reconcileCompletedCandle('EURUSD', '5s', {
    openTimeMs: 0,
    closeTimeMs: 5000,
    open: 1.09,
    high: 1.15,
    low: 1.08,
    close: 1.14,
    providerVolume: 50,
    volumeMode: 'provider',
    provider: 'test',
  }, { reason: 'test-correction' });

  assert.ok(corrected);
  assert.equal(corrected.complete, true);
  assert.equal(corrected.close, 1.14);
  assert.equal(engine.getCurrent('EURUSD', '5s').openTimeMs, 5000);
  assert.equal(corrections.at(-1).reason, 'test-correction');
});
