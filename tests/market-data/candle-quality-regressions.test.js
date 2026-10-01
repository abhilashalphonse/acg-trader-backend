'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CandleEngine } = require('../../src/modules/market-data/candle-engine');
const { Candle, candleSchema } = require('../../src/modules/market-data/candle.model');
const { MarketHistoryService } = require('../../src/modules/market-data/history.service');
const { TwelveDataAdapter } = require('../../src/modules/market-data/adapters/twelve-data.adapter');
function setup(persist, timeframe = '1m') {
  const writes = [], bus = new EventEmitter();
  const engine = new CandleEngine({ eventBus: bus, timeframes: [timeframe], persistTimeframes: [timeframe],
    flushIntervalMs: 1000, maxSyntheticGapBars: 0, logger: { error() {} },
    persistCandle: persist || (async c => writes.push({ ...c })), stateEpoch: 123 });
  return { engine, writes, bus };
}
const tick = (engine, timeMs, price, sequence = timeMs) => engine.processTick({ symbol: 'EURUSD', timeMs, price, sequence });
const bar = (openTimeMs, extra = {}) => ({ openTimeMs, closeTimeMs: openTimeMs + 60000,
  open: 100, high: 120, low: 90, close: 110, complete: false, volumeMode: 'unavailable', ...extra });
async function clock(now, run) {
  const original = Date.now;
  Date.now = () => now.value;
  try { await run(); } finally { Date.now = original; }
}
test('real rollover preserves the target snapshot before seeding the next bucket', async () => {
  const now = { value: 59000 };
  await clock(now, async () => {
    const { engine, writes } = setup();
    tick(engine, 58000, 105);
    const token = engine.beginHydration('EURUSD', '1m');
    tick(engine, 59500, 108); tick(engine, 60100, 109);
    now.value = 61000;
    engine.completeHydration(token, bar(60000), [bar(0, { complete: true }), bar(60000)]);
    await Promise.all([...engine.pendingWrites]);
    assert.equal(writes.length, 1);
    assert.deepEqual([writes[0].open, writes[0].high, writes[0].low, writes[0].close], [100, 120, 90, 108]);
    assert.equal(engine.getCurrent('EURUSD', '1m').openTimeMs, 60000);
    assert.equal(engine.getCurrent('EURUSD', '1m').close, 109);
  });
});
test('a next-bucket snapshot alone cannot silently discard the preceding bar', async () => {
  await clock({ value: 61000 }, async () => {
    const { engine, writes } = setup(); tick(engine, 58000, 105);
    const token = engine.beginHydration('EURUSD', '1m'); tick(engine, 59500, 108);
    engine.completeHydration(token, bar(60000));
    await Promise.all([...engine.pendingWrites]);
    assert.equal(writes.length, 1); assert.equal(writes[0].close, 108);
  });
});
test('expired snapshot retains provider extrema when response arrives after rollover', async () => {
  await clock({ value: 61000 }, async () => {
    const { engine, writes } = setup(); tick(engine, 58000, 105);
    const token = engine.beginHydration('EURUSD', '1m'); tick(engine, 60100, 109);
    engine.completeHydration(token, bar(0));
    await Promise.all([...engine.pendingWrites]);
    assert.equal(writes[0].high, 120); assert.equal(writes[0].open, 100);
    assert.equal(engine.getCurrent('EURUSD', '1m').openTimeMs, 60000);
  });
});
test('buffered boundary tick cannot replace a provider-owned open', async () => {
  await clock({ value: 10000 }, async () => {
    const { engine } = setup(); const token = engine.beginHydration('EURUSD', '1m');
    tick(engine, 0, 105, 1); engine.completeHydration(token, bar(0));
    assert.equal(engine.getCurrent('EURUSD', '1m').open, 100);
    assert.equal(engine.getCurrent('EURUSD', '1m').stateEpoch, 123);
  });
});
test('failed correction stays retryable and is not announced before durable success', async () => {
  let attempts = 0;
  const { engine, bus } = setup(async () => { attempts++; if (attempts === 2) throw Error('temporary'); });
  const events = []; bus.on('market.candle.corrected', c => events.push(c));
  tick(engine, 1000, 100); tick(engine, 61000, 101);
  await Promise.all([...engine.pendingWrites]);
  await assert.rejects(engine.reconcileCompletedCandle('EURUSD', '1m', bar(0)));
  assert.equal(events.length, 0); assert.equal(engine.getLastClosed('EURUSD', '1m').high, 100);
  await engine.reconcileCompletedCandle('EURUSD', '1m', bar(0));
  assert.equal(attempts, 3); assert.equal(events.length, 1);
  assert.equal(engine.getLastClosed('EURUSD', '1m').high, 120);
});
test('correction persistence waits for the original close and earlier corrections', async () => {
  const releases = [], started = [];
  const { engine } = setup(c => { started.push(c.high); return new Promise(resolve => releases.push(resolve)); });
  tick(engine, 1000, 100); tick(engine, 61000, 101);
  const a = engine.reconcileCompletedCandle('EURUSD', '1m', bar(0));
  const b = engine.reconcileCompletedCandle('EURUSD', '1m', bar(0, { high: 130 }));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, [100]);
  releases.shift()(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, [100, 120]);
  releases.shift()(); await a; await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, [100, 120, 130]);
  releases.shift()(); await b; assert.equal(engine.getLastClosed('EURUSD', '1m').high, 130);
});
test('reconnect releases old hydration immediately and rejects its delayed snapshot', async () => {
  await clock({ value: 10000 }, async () => {
    const { engine } = setup(); const token = engine.beginHydration('EURUSD', '1m'); tick(engine, 1000, 105);
    engine.invalidateHydration(); await engine.waitForHydration(token);
    assert.equal(engine.getCurrent('EURUSD', '1m').close, 105);
    const fresh = engine.beginHydration('EURUSD', '1m'); assert.equal(fresh.owner, true);
    engine.completeHydration(token, bar(0)); assert.equal(engine.getCurrent('EURUSD', '1m').open, 105);
    engine.completeHydration(fresh, bar(0)); assert.equal(engine.getCurrent('EURUSD', '1m').open, 100);
  });
});
test('D1 and W1 local fallback admits hydrated/corrected provenance and schema validates it', async () => {
  const original = Candle.find;
  try {
    for (const timeframe of ['1d', '1w']) for (const source of ['HYDRATED', 'CORRECTION']) {
      assert.ok(candleSchema.path('source').enumValues.includes(source));
      const row = { symbol: 'EURUSD', timeframe, openTime: new Date(0), closeTime: new Date(86400000),
        open: 100, high: 120, low: 90, close: 110, complete: true, source };
      Candle.find = filter => ({ sort() { return this; }, limit() { return this; }, async lean() {
        return filter.source.$in.includes(source) ? [row] : [];
      } });
      const service = new MarketHistoryService({ adapter: { supportsHistory: () => false }, instrumentRegistry: {}, logger: console });
      assert.equal((await service.getCandles({ symbol: 'EURUSD', timeframe })).length, 1);
    }
  } finally { Candle.find = original; }
});
test('provider history rejects missing, blank, nonpositive and inconsistent OHLC', async () => {
  const original = global.fetch;
  const good = { datetime: '2026-10-01 12:00:00', open: '1.10', high: '1.12', low: '1.09', close: '1.11' };
  global.fetch = async () => ({ ok: true, json: async () => ({ values: [good, ...[null, '', ' ', '0'].map(open => ({ ...good, open })), { ...good, high: '1.08' }] }) });
  try {
    const adapter = new TwelveDataAdapter({ apiKey: 'test', apiBase: 'https://example.test', httpTimeoutMs: 1000 });
    const bars = await adapter.fetchHistorical({ providerSymbol: 'EUR/USD', timeframe: '5m', limit: 20 });
    assert.equal(bars.length, 1); assert.equal(bars[0].open, 1.10);
  } finally { global.fetch = original; }
});
