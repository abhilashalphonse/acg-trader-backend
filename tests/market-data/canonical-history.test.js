'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateCanonicalUtcBars,
  canonicalSourceBarsPerTarget,
} = require('../../src/modules/market-data/canonical-history');

function bar(iso, open, high, low, close, providerVolume = null) {
  return { openTimeMs: Date.parse(iso), open, high, low, close, providerVolume };
}

test('builds UTC D1 bars from intraday UTC data and preserves a real Sunday session', () => {
  const source = [
    bar('2026-08-21T20:00:00Z', 4300, 4310, 4290, 4305, 10),
    bar('2026-08-23T20:00:00Z', 4320, 4340, 4315, 4335, 12),
    bar('2026-08-24T00:00:00Z', 4335, 4350, 4330, 4345, 15),
    bar('2026-08-24T04:00:00Z', 4345, 4360, 4340, 4355, 18),
  ];

  const daily = aggregateCanonicalUtcBars(source, '1d');
  assert.deepEqual(daily.map(item => new Date(item.openTimeMs).toISOString()), [
    '2026-08-21T00:00:00.000Z',
    '2026-08-23T00:00:00.000Z',
    '2026-08-24T00:00:00.000Z',
  ]);
  assert.equal(daily.some(item => new Date(item.openTimeMs).getUTCDay() === 6), false);

  const sunday = daily[1];
  assert.equal(sunday.open, 4320);
  assert.equal(sunday.high, 4340);
  assert.equal(sunday.low, 4315);
  assert.equal(sunday.close, 4335);
  assert.equal(sunday.providerVolume, 12);

  const monday = daily[2];
  assert.equal(monday.open, 4335);
  assert.equal(monday.high, 4360);
  assert.equal(monday.low, 4330);
  assert.equal(monday.close, 4355);
  assert.equal(monday.providerVolume, 33);
});

test('anchors canonical weekly candles to Monday 00:00 UTC', () => {
  const source = [
    bar('2026-08-23T20:00:00Z', 4300, 4310, 4295, 4305, 10),
    bar('2026-08-24T00:00:00Z', 4310, 4320, 4305, 4315, 11),
  ];

  const weekly = aggregateCanonicalUtcBars(source, '1w');
  assert.equal(weekly.length, 2);
  assert.equal(new Date(weekly[0].openTimeMs).toISOString(), '2026-08-17T00:00:00.000Z');
  assert.equal(new Date(weekly[1].openTimeMs).toISOString(), '2026-08-24T00:00:00.000Z');
});

test('does not report partial provider volume when one source bar is missing volume', () => {
  const daily = aggregateCanonicalUtcBars([
    bar('2026-08-24T00:00:00Z', 4300, 4310, 4290, 4305, 10),
    bar('2026-08-24T04:00:00Z', 4305, 4320, 4300, 4315, null),
  ], '1d');

  assert.equal(daily.length, 1);
  assert.equal(daily[0].providerVolume, null);
});

test('uses 4h UTC source bars for canonical D1 and W1 aggregation', () => {
  assert.equal(canonicalSourceBarsPerTarget('1d'), 6);
  assert.equal(canonicalSourceBarsPerTarget('1w'), 42);
  assert.equal(canonicalSourceBarsPerTarget('4h'), null);
});
