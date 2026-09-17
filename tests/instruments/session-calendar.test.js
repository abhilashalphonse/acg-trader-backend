'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isInstrumentSessionOpen, assertInstrumentSessionOpen } = require('../../src/modules/instruments/session-calendar');

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
