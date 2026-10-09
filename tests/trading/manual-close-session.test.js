'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertManualCloseSessionOpen } = require('../../src/modules/trading/market-order.service');

const SATURDAY = Date.UTC(2026, 9, 3, 12, 0, 0);
const MONDAY = Date.UTC(2026, 9, 5, 12, 0, 0);

function fxInstrument(overrides = {}) {
  return {
    symbol: 'AUDCAD',
    status: 'ACTIVE',
    timezone: 'UTC',
    tradingSessions: [
      { days: [0], open: '22:00', close: '23:59' },
      { days: [1, 2, 3, 4], open: '00:00', close: '23:59' },
      { days: [5], open: '00:00', close: '22:00' },
    ],
    tradingHolidays: [],
    ...overrides,
  };
}

test('manual close is rejected while the instrument session is closed', () => {
  assert.throws(
    () => assertManualCloseSessionOpen({
      instrument: fxInstrument(),
      source: 'WEB',
      reason: null,
      nowMs: SATURDAY,
    }),
    error => error.code === 'MARKET_SESSION_CLOSED'
      && error.statusCode === 409
      && error.details.symbol === 'AUDCAD',
  );
});

test('manual close is allowed while the instrument session is open', () => {
  assert.doesNotThrow(() => assertManualCloseSessionOpen({
    instrument: fxInstrument(),
    source: 'MOBILE',
    reason: null,
    nowMs: MONDAY,
  }));
});

test('system liquidation is not reclassified as a manual close', () => {
  assert.doesNotThrow(() => assertManualCloseSessionOpen({
    instrument: fxInstrument(),
    source: 'SYSTEM',
    reason: null,
    nowMs: SATURDAY,
  }));
});

test('SL/TP retain their protective execution path while stop-out defers outside session', () => {
  for (const reason of ['STOP_LOSS', 'TAKE_PROFIT']) {
    assert.doesNotThrow(() => assertManualCloseSessionOpen({
      instrument: fxInstrument(),
      source: 'SYSTEM',
      reason,
      nowMs: SATURDAY,
    }));
  }

  assert.throws(
    () => assertManualCloseSessionOpen({
      instrument: fxInstrument(),
      source: 'SYSTEM',
      reason: 'MARGIN_STOP_OUT',
      nowMs: SATURDAY,
    }),
    error => error.code === 'MARKET_SESSION_CLOSED',
  );
});


test('manual session gate does not change missing or operationally inactive instrument close semantics', () => {
  assert.doesNotThrow(() => assertManualCloseSessionOpen({
    instrument: null,
    source: 'WEB',
    reason: null,
    nowMs: SATURDAY,
  }));

  assert.doesNotThrow(() => assertManualCloseSessionOpen({
    instrument: fxInstrument({
      status: 'HALTED',
      tradingSessions: [{ days: [6], open: '00:00', close: '23:59' }],
    }),
    source: 'WEB',
    reason: null,
    nowMs: SATURDAY,
  }));
});
