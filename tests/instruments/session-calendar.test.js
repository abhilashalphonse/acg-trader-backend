'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isInstrumentSessionOpen, assertInstrumentSessionOpen, candleOverlapsInstrumentSession, sessionAlignedBucketOpenTimeMs } = require('../../src/modules/instruments/session-calendar');

function instrument(overrides = {}) {
  return {
    symbol: 'EURUSD',
    status: 'ACTIVE',
    timezone: 'UTC',
    tradingSessions: [
      { days: [1, 2, 3, 4], open: '00:00', close: '23:59' },
      { days: [5], open: '00:00', close: '22:00' },
    ],
    tradingHolidays: [],
    ...overrides,
  };
}

const ms = iso => new Date(iso).getTime();

test('session calendar opens inside configured weekday session', () => {
  assert.equal(isInstrumentSessionOpen(instrument(), ms('2026-09-17T12:00:00.000Z')), true);
});

test('23:59 close acts as end-of-day instead of creating a false one-minute closure', () => {
  assert.equal(isInstrumentSessionOpen(instrument(), ms('2026-09-17T23:59:30.000Z')), true);
});

test('session calendar closes after Friday cutoff and on weekend', () => {
  assert.equal(isInstrumentSessionOpen(instrument(), ms('2026-09-18T22:30:00.000Z')), false);
  assert.equal(isInstrumentSessionOpen(instrument(), ms('2026-09-19T12:00:00.000Z')), false);
});

test('holiday closure overrides weekly session', () => {
  const value = instrument({ tradingHolidays: ['2026-09-17'] });
  assert.equal(isInstrumentSessionOpen(value, ms('2026-09-17T12:00:00.000Z')), false);
  assert.throws(() => assertInstrumentSessionOpen(value, ms('2026-09-17T12:00:00.000Z')), error => error.code === 'MARKET_SESSION_CLOSED');
});

test('empty session list preserves always-open product behavior', () => {
  assert.equal(isInstrumentSessionOpen(instrument({ tradingSessions: [] }), ms('2026-09-19T12:00:00.000Z')), true);
});


test('NSE 30-minute buckets anchor at the 09:15 Asia/Kolkata session open', () => {
  const nse = instrument({
    symbol: 'RELIANCE',
    timezone: 'Asia/Kolkata',
    tradingSessions: [{ days: [1, 2, 3, 4, 5], open: '09:15', close: '15:30' }],
  });

  const tickMs = ms('2026-10-01T04:02:00.000Z'); // 09:32 IST
  assert.equal(
    sessionAlignedBucketOpenTimeMs(nse, tickMs, 30 * 60 * 1000),
    ms('2026-10-01T03:45:00.000Z'),
  );
});

test('NSE one-hour buckets stay aligned to 09:15 rather than UTC clock hours', () => {
  const nse = instrument({
    symbol: 'RELIANCE',
    timezone: 'Asia/Kolkata',
    tradingSessions: [{ days: [1, 2, 3, 4, 5], open: '09:15', close: '15:30' }],
  });

  const tickMs = ms('2026-10-01T05:10:00.000Z'); // 10:40 IST
  assert.equal(
    sessionAlignedBucketOpenTimeMs(nse, tickMs, 60 * 60 * 1000),
    ms('2026-10-01T04:45:00.000Z'), // 10:15 IST
  );
});


test('candle overlap rejects a fully closed Saturday bar but preserves Sunday reopen boundary', () => {
  const fxWeek = instrument({
    tradingSessions: [
      { days: [0], open: '22:00', close: '23:59' },
      { days: [1, 2, 3, 4], open: '00:00', close: '23:59' },
      { days: [5], open: '00:00', close: '22:00' },
    ],
  });
  assert.equal(
    candleOverlapsInstrumentSession(fxWeek, ms('2026-10-03T12:00:00.000Z'), ms('2026-10-03T12:30:00.000Z')),
    false,
  );
  assert.equal(
    candleOverlapsInstrumentSession(fxWeek, ms('2026-10-04T20:00:00.000Z'), ms('2026-10-05T00:00:00.000Z')),
    true,
  );
});
