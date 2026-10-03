'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { candleOverlapsOpenSession } = require('../../scripts/cleanup-out-of-session-candles');

const fxWeekInstrument = {
  symbol: 'XAUUSD',
  status: 'ACTIVE',
  timezone: 'UTC',
  tradingSessions: [
    { days: [0], open: '22:00', close: '23:59' },
    { days: [1, 2, 3, 4], open: '00:00', close: '23:59' },
    { days: [5], open: '00:00', close: '22:00' },
  ],
  tradingHolidays: [],
};

const ms = iso => new Date(iso).getTime();

test('fully closed Saturday candle is eligible for cleanup', () => {
  assert.equal(
    candleOverlapsOpenSession(
      fxWeekInstrument,
      ms('2026-10-03T12:00:00.000Z'),
      ms('2026-10-03T13:00:00.000Z'),
    ),
    false,
  );
});

test('Sunday four-hour candle spanning the 22:00 reopen is preserved', () => {
  assert.equal(
    candleOverlapsOpenSession(
      fxWeekInstrument,
      ms('2026-10-04T20:00:00.000Z'),
      ms('2026-10-05T00:00:00.000Z'),
    ),
    true,
  );
});

test('Sunday daily candle containing the 22:00 reopen is preserved', () => {
  assert.equal(
    candleOverlapsOpenSession(
      fxWeekInstrument,
      ms('2026-10-04T00:00:00.000Z'),
      ms('2026-10-05T00:00:00.000Z'),
    ),
    true,
  );
});

test('Friday candle beginning at the configured close remains fully closed', () => {
  assert.equal(
    candleOverlapsOpenSession(
      fxWeekInstrument,
      ms('2026-10-02T22:00:00.000Z'),
      ms('2026-10-02T23:00:00.000Z'),
    ),
    false,
  );
});

test('weekday 23:59 candle is preserved for end-of-day session sentinel', () => {
  assert.equal(
    candleOverlapsOpenSession(
      fxWeekInstrument,
      ms('2026-10-01T23:59:00.000Z'),
      ms('2026-10-02T00:00:00.000Z'),
    ),
    true,
  );
});
