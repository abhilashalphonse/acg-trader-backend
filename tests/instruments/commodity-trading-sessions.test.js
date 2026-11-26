'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACG_INSTRUMENT_CATALOG, COMMODITIES } = require('../../src/modules/instruments/instrument-catalog');
const { COMMODITY_SESSIONS } = require('../../src/modules/instruments/commodity-trading-sessions');
const {
  isInstrumentSessionOpen,
  candleOverlapsInstrumentSession,
} = require('../../src/modules/instruments/session-calendar');

const bySymbol = new Map(ACG_INSTRUMENT_CATALOG.map(item => [item.symbol, item]));
const date = iso => Date.parse(iso);
const marketOpen = (symbol, iso) => isInstrumentSessionOpen(bySymbol.get(symbol), date(iso));

test('every commodity has an explicit, evidenced reference schedule; FOREX keeps its own calendar', () => {
  const symbols = COMMODITIES.map(({ symbol }) => symbol);
  assert.equal(symbols.length, 20);
  assert.deepEqual(Object.keys(COMMODITY_SESSIONS).sort(), [...symbols].sort());
  for (const symbol of symbols) {
    const catalog = bySymbol.get(symbol);
    const policy = COMMODITY_SESSIONS[symbol];
    assert.ok(policy.referenceUrl.startsWith('https://'), symbol);
    assert.equal(catalog.timezone, policy.timezone, symbol);
    assert.deepEqual(catalog.tradingSessions, policy.tradingSessions, symbol);
    assert.ok(catalog.tradingSessions.length > 0, symbol);
  }
  assert.equal(bySymbol.get('EURUSD').timezone, 'UTC');
});

test('gold, silver, platinum and palladium close during the NY daily rollover in winter and summer', () => {
  for (const symbol of ['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD']) {
    assert.equal(marketOpen(symbol, '2026-11-25T21:59:00Z'), true, symbol);
    assert.equal(marketOpen(symbol, '2026-11-25T22:15:00Z'), false, symbol);
    assert.equal(marketOpen(symbol, '2026-11-25T23:00:00Z'), true, symbol);
    assert.equal(marketOpen(symbol, '2026-07-01T20:59:00Z'), true, symbol);
    assert.equal(marketOpen(symbol, '2026-07-01T21:15:00Z'), false, symbol);
    assert.equal(marketOpen(symbol, '2026-07-01T22:00:00Z'), true, symbol);
    assert.equal(marketOpen(symbol, '2026-11-28T12:00:00Z'), false, symbol);
    assert.equal(marketOpen(symbol, '2026-11-29T23:05:00Z'), true, symbol);
  }
});

test('WTI, natural gas, refined products, copper and aluminum use their individual NY overnight windows', () => {
  for (const symbol of ['WTIUSD', 'NGASUSD', 'GASOLINE', 'HEATOIL', 'COPPER', 'ALUMINUM']) {
    assert.equal(marketOpen(symbol, '2026-11-18T22:15:00Z'), false, symbol);
    assert.equal(marketOpen(symbol, '2026-11-18T23:05:00Z'), true, symbol);
    assert.equal(marketOpen(symbol, '2026-07-01T21:15:00Z'), false, symbol);
  }
});

test('Brent uses ICE hours, including the separate Sunday open, rather than WTI rollover', () => {
  assert.equal(marketOpen('XBRUSD', '2026-11-18T22:30:00Z'), true);
  assert.equal(marketOpen('XBRUSD', '2026-11-18T23:05:00Z'), false);
  assert.equal(marketOpen('XBRUSD', '2026-11-19T00:45:00Z'), false);
  assert.equal(marketOpen('XBRUSD', '2026-11-19T01:05:00Z'), true);
  assert.equal(marketOpen('XBRUSD', '2026-11-29T22:55:00Z'), false);
  assert.equal(marketOpen('XBRUSD', '2026-11-29T23:05:00Z'), true);
});

test('CBOT corn, wheat and soybean enforce overnight, maintenance and day sessions', () => {
  for (const symbol of ['CORN', 'WHEAT', 'SOYBEAN']) {
    assert.equal(marketOpen(symbol, '2026-11-18T01:30:00Z'), true, symbol); // Tuesday 19:30 CST
    assert.equal(marketOpen(symbol, '2026-11-18T13:50:00Z'), false, symbol); // 07:50 CST
    assert.equal(marketOpen(symbol, '2026-11-18T14:35:00Z'), true, symbol); // 08:35 CST
    assert.equal(marketOpen(symbol, '2026-11-18T19:25:00Z'), false, symbol); // 13:25 CST
    assert.equal(marketOpen(symbol, '2026-11-22T12:00:00Z'), false, symbol); // Sunday midday
  }
});

test('ICE sugar, coffee, cocoa and cotton have distinct exchange trading windows', () => {
  assert.equal(marketOpen('SUGAR', '2026-11-18T08:25:00Z'), false);
  assert.equal(marketOpen('SUGAR', '2026-11-18T08:35:00Z'), true);
  assert.equal(marketOpen('COFFEE', '2026-11-18T09:10:00Z'), false);
  assert.equal(marketOpen('COFFEE', '2026-11-18T09:20:00Z'), true);
  assert.equal(marketOpen('COCOA', '2026-11-18T09:40:00Z'), false);
  assert.equal(marketOpen('COCOA', '2026-11-18T09:50:00Z'), true);
  assert.equal(marketOpen('COTTON', '2026-11-18T01:30:00Z'), true);
  assert.equal(marketOpen('COTTON', '2026-11-18T20:00:00Z'), false);
});

test('cattle and hogs close after the CME livestock day session', () => {
  for (const symbol of ['CATTLE', 'HOGS']) {
    assert.equal(marketOpen(symbol, '2026-11-18T14:25:00Z'), false, symbol);
    assert.equal(marketOpen(symbol, '2026-11-18T14:35:00Z'), true, symbol);
    assert.equal(marketOpen(symbol, '2026-11-18T19:10:00Z'), false, symbol);
  }
});

test('history filters entirely closed 5-minute bars but retains candles overlapping a session boundary', () => {
  const gold = bySymbol.get('XAUUSD');
  assert.equal(candleOverlapsInstrumentSession(gold,
    date('2026-11-25T22:10:00Z'), date('2026-11-25T22:15:00Z')), false);
  assert.equal(candleOverlapsInstrumentSession(gold,
    date('2026-11-25T21:55:00Z'), date('2026-11-25T22:05:00Z')), true);
  assert.equal(candleOverlapsInstrumentSession(gold,
    date('2026-11-25T22:55:00Z'), date('2026-11-25T23:05:00Z')), true);
});
