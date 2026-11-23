'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAlert, emptyState, ticks } = require('../src/modules/alerts/alert-evaluator');
const { position, parsePosition, comparePositions, quotePayload, candlePayload, gapPayload } = require('../src/modules/alerts/alert-event-contract');

const streamId = 'twelve-data:XAUUSD';
const basic = { _id: 'shadow-1', streamId, version: 3, tickSize: '0.01',
  condition: { type: 'crosses_above', level: '3250.00' },
  priceSource: 'bid', frequency: 'once', cooldownMs: 0 };
function quote(n, bid, extras = {}) {
  return { eventId: position(streamId, 1, n), streamId, kind: 'quote',
    marketTimeMs: 1000 * n, acceptedAtMs: 1000 * n,
    prices: { bid, ask: '3250.10', last: '3250.02' }, ...extras };
}
function run(rule, events, start = emptyState()) {
  let state = start;
  const fired = [];
  for (const event of events) {
    const result = evaluateAlert(rule, state, event);
    state = result.state;
    if (result.trigger) fired.push(result.trigger);
  }
  return { state, fired };
}

test('durable positions are ordered across generations, not just IDs', () => {
  assert.deepEqual(parsePosition(position(streamId, 2, 15)),
    { streamId, generation: 2, sequence: 15 });
  assert.equal(comparePositions(position(streamId, 2, 1), position(streamId, 1, 9999)), 1);
  assert.equal(comparePositions(position(streamId, 2, 14), position(streamId, 2, 15)), -1);
  assert.throws(() => comparePositions('other:EURUSD#1:1', position(streamId, 1, 1)));
});

test('first tick sets baseline; a jump crossing the level triggers at the boundary', () => {
  const result = run(basic, [quote(1, '3249.90'), quote(2, '3250.00'), quote(3, '3250.20')]);
  assert.equal(result.fired.length, 1);
  assert.equal(result.fired[0].eventId, quote(2).eventId);
  assert.equal(result.state.monitoring, 'COMPLETED');
});

test('already-above first tick does not invent a crossing', () => {
  assert.equal(run(basic, [quote(1, '3250.20')]).fired.length, 0);
});

test('crosses below and crosses either direction use previous valid observation', () => {
  const below = { ...basic, condition: { type: 'crosses_below', level: '3250' } };
  const either = { ...basic, condition: { type: 'crosses', level: '3250' } };
  assert.equal(run(below, [quote(1, '3250.10'), quote(2, '3249.99')]).fired.length, 1);
  assert.equal(run(either, [quote(1, '3250.10'), quote(2, '3249.99')]).fired.length, 1);
});

test('repeat requires reset and cooldown never queues a suppressed hit', () => {
  const repeat = { ...basic, frequency: 'repeat', cooldownMs: 5000 };
  const q = (n, p) => quote(n, p);
  const r = run(repeat, [
    q(1,'3249.90'), q(2,'3250.01'), q(3,'3250.30'), // first trigger only
    q(4,'3249.80'), q(5,'3250.02'),                 // reset, but cooldown blocks
    q(6,'3249.95'), q(8,'3250.10'),                 // later reset and re-cross
  ]);
  assert.deepEqual(r.fired.map(t => t.marketTimeMs), [2000, 8000]);
});

test('zone enter includes edges, and exit is strictly outside', () => {
  const condition = { type: 'enters_range', lower: '3250.00', upper: '3252.00' };
  const enter = { ...basic, condition };
  const exit = { ...basic, condition: { ...condition, type: 'exits_range' } };
  assert.equal(run(enter, [quote(1,'3249.00'),quote(2,'3250.00')]).fired.length, 1);
  assert.equal(run(exit, [quote(1,'3252.00'),quote(2,'3252.01')]).fired.length, 1);
  // A single observed jump from one outside side to the other is NOT proof of entering.
  assert.equal(run(enter, [quote(1,'3249.00'),quote(2,'3253.00')]).fired.length, 0);
});

test('gap forces a new baseline, not a fabricated cross', () => {
  const gap = { ...gapPayload(streamId, 'FEED_DISCONNECTED', 3000), eventId: position(streamId, 1, 3) };
  const result = run(basic, [
    quote(1,'3249.90'), gap, quote(4,'3250.10'),
    quote(5,'3249.90'), quote(6,'3250.10'),
  ]);
  assert.equal(result.fired.length, 1);
  assert.equal(result.fired[0].eventId, quote(6).eventId);
});

test('no implicit bid/ask/last fallback', () => {
  const result = run(basic, [
    quote(1, null), quote(2,'3251.00'),quote(3,'3249.00'),quote(4,'3251.00'),
  ]);
  assert.equal(result.fired.length, 1);
  assert.equal(result.fired[0].eventId, quote(4).eventId);
});

test('ACG-finalised candle-only evaluation skips synthetic and correction events', () => {
  const rule = { ...basic, condition: { type: 'candle_close_above', level: '3250' },
    priceSource: 'last', timeframe: '15m', frequency: 'repeat' };
  const candle = (n, close, options = {}) => ({ eventId: position(streamId,1,n), streamId,
    kind: 'candle_closed', marketTimeMs: n * 900000, acceptedAtMs: n * 900000,
    timeframe: '15m', close, complete: true, synthetic: false, ...options });
  const r = run(rule, [
    candle(1,'3251.00',{synthetic:true}),
    candle(2,'3251.00'), // first actual closed candle can trigger
    candle(3,'3252.00'), // needs reset
    { ...candle(4,'3248.00'),kind:'candle_corrected' }, // correction is not live input
    candle(5,'3249.00'), // reset
    candle(6,'3251.00'),
  ]);
  assert.deepEqual(r.fired.map(t => t.eventId), [candle(2).eventId,candle(6).eventId]);
});

test('expiry and schedule are evaluated on event time, not browser clock', () => {
  const rule = { ...basic, expiresAt: new Date(3500).toISOString() };
  assert.equal(run(rule,[quote(1,'3249.90'),quote(4,'3250.10')]).fired.length,0);
  const hours = { ...basic, schedule: { timezone: 'UTC', days: [4], startMinute: 480, endMinute: 540 } };
  const event = (n,time,p) => ({ ...quote(n,p),marketTimeMs:Date.parse(time) });
  const scheduled = run(hours, [
    event(1,'2026-11-19T07:59:00Z','3249.00'),
    event(2,'2026-11-19T08:00:00Z','3251.00'),
  ]);
  assert.equal(scheduled.fired.length,1);
});

test('precise tick quantization is deterministic at small decimal sizes', () => {
  assert.equal(ticks('1.123456', '0.00001'),'112346');
  assert.equal(ticks('3250.005', '0.01'),'325001');
});

test('normalization retains absent sources and explicit quality', () => {
  const tick = quotePayload({ symbol: 'XAUUSD', timeMs: 100, receivedAtMs: 101,
    last: 3200, bid: null, ask: null, source: 'twelve-data', isSyntheticSpread: false },'twelve-data');
  assert.equal(tick.prices.bid,null);
  assert.equal(tick.prices.last,'3200');
  assert.equal(tick.schemaVersion,1);
  const candle = candlePayload({symbol:'XAUUSD',timeframe:'15m',closeTimeMs:900000,
    close:3200,open:3199,high:3201,low:3198,complete:true,synthetic:false},'twelve-data');
  assert.equal(candle.kind,'candle_closed');
  assert.equal(candle.quality,'ACG_FINALISED');
});

test('two-way repeat crosses on every alternating crossing without cooldown', () => {
  const rule = { ...basic, frequency: 'repeat', cooldownMs: 0,
    tickSize: '1', condition: { type: 'crosses', level: '100' } };
  const p = (n, price) => ({ ...quote(n, String(price)), prices: { bid: String(price) },
    receivedAtMs: n * 1000 });
  const result = run(rule, [p(1,99),p(2,101),p(3,99),p(4,101)]);
  assert.deepEqual(result.fired.map(item => item.eventId),
    [p(2,101).eventId,p(3,99).eventId,p(4,101).eventId]);
});

test('pre-expiry observed price survives a later durability commit and replay', () => {
  const rule = { ...basic, expiresAt: new Date(3500).toISOString() };
  const older = { ...quote(2,'3250.10'), receivedAtMs: 2000, acceptedAtMs: 9000 };
  const result = run(rule, [
    { ...quote(1,'3249.90'), receivedAtMs: 1000 }, older,
  ]);
  assert.equal(result.fired.length, 1);
  assert.equal(result.fired[0].eventId, older.eventId);
});

test('durably ordered expiry watermark ends monitoring only after prior trigger', () => {
  const rule = { ...basic, frequency: 'repeat', expiresAt: new Date(3500).toISOString() };
  const result = run(rule, [
    { ...quote(1,'3249.90'), receivedAtMs: 1000 },
    { ...quote(2,'3250.10'), receivedAtMs: 2000 },
    { ...quote(3,'3249.90'), receivedAtMs: 3000 },
    { ...gapPayload(streamId, 'NOT_A_GAP', 4000), kind: 'expiry_watermark',
      receivedAtMs: 4000, eventId: position(streamId,1,4) },
    { ...quote(5,'3250.10'), receivedAtMs: 5000 },
  ]);
  assert.equal(result.fired.length, 1);
  assert.equal(result.state.monitoring, 'EXPIRED');
});
