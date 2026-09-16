'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { CandleEngine } = require('../../src/modules/market-data/candle-engine');

const logger = { error() {} };

function tick(timeMs, price) {
  return { symbol: 'EURUSD', timeMs, price, source: 'test' };
}

test('aggregates ticks into a 5s candle and closes on the next bucket', () => {
  const bus = new EventEmitter();
  const closed = [];
  bus.on('market.candle.closed', candle => closed.push(candle));

  const engine = new CandleEngine({
    eventBus: bus,
    timeframes: ['5s'],
    persistTimeframes: [],
    flushIntervalMs: 100000,
    maxSyntheticGapBars: 12,
    logger,
    persistCandle: async () => {},
  });

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

test('fills only short missing-candle gaps with synthetic bars', () => {
  const bus = new EventEmitter();
  const closed = [];
  bus.on('market.candle.closed', candle => closed.push(candle));

  const engine = new CandleEngine({
    eventBus: bus,
    timeframes: ['5s'],
    persistTimeframes: [],
    flushIntervalMs: 100000,
    maxSyntheticGapBars: 12,
    logger,
    persistCandle: async () => {},
  });

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
