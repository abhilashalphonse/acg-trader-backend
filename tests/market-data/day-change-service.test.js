'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { QuoteStore } = require('../../src/modules/market-data/quote-store');
const {
  DayChangeService,
  selectPreviousClose,
} = require('../../src/modules/market-data/day-change.service');

function instrument(overrides = {}) {
  return {
    symbol: 'AAPL',
    provider: 'twelve-data',
    providerSymbol: 'AAPL',
    timezone: 'America/New_York',
    status: 'ACTIVE',
    tradingHolidays: [],
    tradingSessions: [{ days: [1, 2, 3, 4, 5], open: '09:30', close: '16:00' }],
    ...overrides,
  };
}

test('selectPreviousClose uses the preceding D1 bar when current session already has a daily bar', () => {
  const bars = [
    { openTimeMs: Date.parse('2026-09-30T00:00:00Z'), close: 250 },
    { openTimeMs: Date.parse('2026-10-01T00:00:00Z'), close: 255 },
  ];
  const previousClose = selectPreviousClose({
    bars,
    instrument: instrument(),
    nowMs: Date.parse('2026-10-01T15:00:00Z'),
  });
  assert.equal(previousClose, 250);
});

test('selectPreviousClose uses latest completed D1 when open-session history has not added today yet', () => {
  const bars = [
    { openTimeMs: Date.parse('2026-09-29T00:00:00Z'), close: 245 },
    { openTimeMs: Date.parse('2026-09-30T00:00:00Z'), close: 250 },
  ];
  const previousClose = selectPreviousClose({
    bars,
    instrument: instrument(),
    nowMs: Date.parse('2026-10-01T15:00:00Z'),
  });
  assert.equal(previousClose, 250);
});

test('selectPreviousClose compares the latest closed session with the one before it outside market hours', () => {
  const bars = [
    { openTimeMs: Date.parse('2026-09-30T00:00:00Z'), close: 250 },
    { openTimeMs: Date.parse('2026-10-01T00:00:00Z'), close: 255 },
  ];
  const previousClose = selectPreviousClose({
    bars,
    instrument: instrument(),
    nowMs: Date.parse('2026-10-01T22:00:00Z'),
  });
  assert.equal(previousClose, 250);
});

test('day-change service enriches an existing live quote and emits the same authoritative values', async () => {
  const quoteStore = new QuoteStore();
  quoteStore.set({
    symbol: 'AAPL',
    price: 255,
    last: 255,
    bid: 254.9,
    ask: 255.1,
    receivedAtMs: Date.now(),
    isStale: false,
  });

  const eventBus = new EventEmitter();
  const emitted = [];
  eventBus.on('market.quote', quote => emitted.push(quote));

  const adapter = {
    supportsHistory(timeframe, provider) {
      return timeframe === '1d' && provider === 'twelve-data';
    },
    async fetchHistorical() {
      return [
        { openTimeMs: Date.parse('2026-09-30T00:00:00Z'), close: 250 },
      ];
    },
  };

  const registry = {
    get(symbol) {
      assert.equal(symbol, 'AAPL');
      return instrument({
        timezone: 'UTC',
        tradingSessions: [],
      });
    },
  };

  const service = new DayChangeService({
    adapter,
    instrumentRegistry: registry,
    quoteStore,
    eventBus,
    logger: { debug() {} },
  });

  await service.ensure('AAPL');

  const quote = quoteStore.get('AAPL');
  assert.equal(quote.previousClose, 250);
  assert.equal(quote.change, 5);
  assert.equal(quote.changePercent, 2);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].changePercent, 2);
  assert.equal(emitted[0].referenceUpdate, true);
});
