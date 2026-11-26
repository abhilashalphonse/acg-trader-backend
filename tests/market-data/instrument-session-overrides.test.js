'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Instrument } = require('../../src/modules/instruments/instrument.model');
const { InstrumentRegistry } = require('../../src/modules/market-data/instrument-registry');
const { ACG_INSTRUMENT_CATALOG } = require('../../src/modules/instruments/instrument-catalog');
const { isInstrumentSessionOpen, activeSessionOpenTimeMs } = require('../../src/modules/instruments/session-calendar');

test('live market-data registry carries the full holiday/early-close overrides instead of inheriting prior overnight sessions', async () => {
  const originalFindOne = Instrument.findOne;
  const original = ACG_INSTRUMENT_CATALOG.find(item => item.symbol === 'XAUUSD');
  const doc = {
    ...original,
    sessionOverrides: [{
      date: '2026-11-27',
      // After a Thursday evening overnight session, Friday closes early at
      // 13:00 New York. The override must supersede Thursday's 17:00 close.
      sessions: [{ days: [], open: '00:00', close: '13:00' }],
    }],
  };
  Instrument.findOne = () => ({ lean: async () => doc });
  try {
    const registry = new InstrumentRegistry({
      symbols: ['XAUUSD'], defaultMaxQuoteAgeMs: 35000, logger: { warn() {} },
    });
    await registry.load();
    const gold = registry.get('XAUUSD');
    assert.equal(Object.isFrozen(gold.sessionOverrides), true);
    assert.equal(gold.sessionOverrides[0].date, '2026-11-27');
    assert.equal(isInstrumentSessionOpen(gold, Date.parse('2026-11-27T17:59:00Z')), true); // 12:59 NY
    assert.equal(isInstrumentSessionOpen(gold, Date.parse('2026-11-27T18:01:00Z')), false); // 13:01 NY
    assert.equal(activeSessionOpenTimeMs(gold, Date.parse('2026-11-27T18:01:00Z')), null);
    assert.equal(isInstrumentSessionOpen(gold, Date.parse('2026-11-28T12:00:00Z')), false);
    assert.equal(isInstrumentSessionOpen(gold, Date.parse('2026-11-29T23:05:00Z')), true);
  } finally {
    Instrument.findOne = originalFindOne;
  }
});
