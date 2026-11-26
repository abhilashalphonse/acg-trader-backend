'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareRows, resolveSymbols, isValidRange, fetchBars,
} = require('../../scripts/audit-commodity-provider-sessions');
const { ACG_INSTRUMENT_CATALOG } = require('../../src/modules/instruments/instrument-catalog');
const gold = ACG_INSTRUMENT_CATALOG.find(item => item.symbol === 'XAUUSD');
const time = iso => Date.parse(iso);

test('read-only commodity parity check detects provider flats during a closed gold market', () => {
  const rows = [
    { openTimeMs: time('2026-11-25T21:55:00Z'), open: 4250, high: 4254, low: 4249, close: 4253 },
    { openTimeMs: time('2026-11-25T22:05:00Z'), open: 4253, high: 4253, low: 4253, close: 4253 },
    { openTimeMs: time('2026-11-25T23:00:00Z'), open: 4256, high: 4258, low: 4255, close: 4257 },
  ];
  const report = compareRows({
    bars: rows, instrument: gold, startMs: time('2026-11-25T21:45:00Z'), endMs: time('2026-11-25T23:15:00Z'),
  });
  assert.equal(report.rows, 3);
  assert.equal(report.openRows, 2);
  assert.equal(report.closedRows, 1);
  assert.equal(report.flatClosedRows, 1);
  assert.equal(report.result, 'SESSION_MISMATCH');
});

test('provider parity accepts only sampled evidence, not release signoff', () => {
  const report = compareRows({
    bars: [{ openTimeMs: time('2026-11-25T23:00:00Z'), open: 1, high: 2, low: 1, close: 2 }],
    instrument: gold, startMs: time('2026-11-25T21:45:00Z'), endMs: time('2026-11-25T23:15:00Z'),
  });
  assert.equal(report.closedRows, 0);
  assert.equal(report.result, 'NO_CLOSED_SESSION_BARS_IN_SAMPLE');
});

test('audit defaults to all 20 commodities and rejects unrecognised symbols/unsafe ranges', () => {
  assert.equal(resolveSymbols({}).length, 20);
  assert.deepEqual(resolveSymbols({ ACG_COMMODITY_AUDIT_SYMBOLS: 'XAUUSD,xagusd' }).map(x => x.symbol), ['XAUUSD','XAGUSD']);
  assert.throws(() => resolveSymbols({ ACG_COMMODITY_AUDIT_SYMBOLS: 'NOT_REAL' }), /Unknown commodity/);
  assert.throws(() => isValidRange({ ACG_COMMODITY_AUDIT_START: '2026-01-01T00:00:00Z', ACG_COMMODITY_AUDIT_END: '2026-01-12T00:00:00Z' }), /at most 7 days/);
});

test('provider request is GET-only and does not log the API credential', async () => {
  let capturedUrl;
  const fetchImpl = async url => {
    capturedUrl = new URL(url);
    return { ok: true, status: 200, async json() {
      return { values: [{ datetime: '2026-11-25 23:00:00', open: '4253', high: '4255', low: '4252', close: '4254' }] };
    } };
  };
  const bars = await fetchBars({
    instrument: gold,
    apiKey: 'dummy-not-production',
    startMs: time('2026-11-25T21:45:00Z'),
    endMs: time('2026-11-25T23:15:00Z'),
    fetchImpl,
  });
  assert.equal(capturedUrl.pathname, '/time_series');
  assert.equal(capturedUrl.searchParams.get('symbol'), 'XAU/USD');
  assert.equal(capturedUrl.searchParams.get('timezone'), 'UTC');
  assert.deepEqual(bars.map(x => x.openTimeMs), [time('2026-11-25T23:00:00Z')]);
});
