'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CurrencyConversionEngine } = require('../../src/modules/trading/currency-conversion-engine');
const {
  buildGlobalMarketsReadiness,
  classifyQuote,
} = require('../../src/modules/operations/global-markets-readiness');

const NOW = Date.parse('2026-10-07T05:00:00.000Z'); // 10:30 Asia/Kolkata, Wednesday

function instrument(overrides = {}) {
  return {
    symbol: 'RELIANCE',
    assetClass: 'EQUITY',
    quoteCurrency: 'INR',
    marginCurrency: 'INR',
    pnlCurrency: 'INR',
    defaultLeverage: 10,
    leveragePolicyVersion: 2,
    corporateActionPolicy: 'UNSUPPORTED',
    executionEnabled: false,
    executionProvisionVersion: 0,
    timezone: 'Asia/Kolkata',
    tradingSessions: [{ days: [1, 2, 3, 4, 5], open: '09:15', close: '15:30' }],
    tradingHolidays: [],
    sessionOverrides: [],
    maxQuoteAgeMs: 12_000,
    ...overrides,
  };
}

function liveQuote(symbol, bid, ask, overrides = {}) {
  return {
    symbol,
    bid,
    ask,
    source: symbol === 'RELIANCE' ? 'ACCELPIX_TEST' : 'FX_TEST',
    sequence: symbol === 'RELIANCE' ? 11 : 12,
    receivedAtMs: NOW - 100,
    providerTimestampMs: NOW - 120,
    isStale: false,
    ...overrides,
  };
}

function quoteStore(overrides = {}) {
  const values = {
    RELIANCE: liveQuote('RELIANCE', 2500, 2500.05),
    USDINR: liveQuote('USDINR', 90, 91),
    ...overrides,
  };
  return { get: symbol => values[symbol] || null };
}

function converter(store) {
  return new CurrencyConversionEngine({
    quoteStore: store,
    symbols: ['USDINR'],
    maxQuoteAgeMs: 5000,
  });
}

test('GLOBAL-MARKETS readiness reaches READY_TO_ENABLE_PILOT before execution is toggled', () => {
  const store = quoteStore();
  const report = buildGlobalMarketsReadiness({
    instrument: instrument(),
    quoteStore: store,
    currencyConverter: converter(store),
    platformEventsHealth: {
      enabled: true,
      started: true,
      webhookConfigured: true,
      pendingSnapshots: 0,
      deliveryFailures: 0,
      deadEvents: 0,
    },
    config: {
      marketProvider: 'multi',
      indiaMarketEnabled: true,
      accelpixConfigured: true,
    },
    nowMs: NOW,
  });

  assert.equal(report.status, 'READY_TO_ENABLE_PILOT');
  assert.equal(report.activationReady, true);
  assert.equal(report.executionReady, false);
  assert.equal(report.customerReleaseReady, false);
  assert.ok(report.customerReleaseBlockers.some(item => item.check === 'corporateActionOpenPositionSafety'));
  assert.equal(report.instrument.sessionOpen, true);
  assert.equal(report.marketData.underlying.status, 'LIVE');
  assert.equal(report.marketData.fx.status, 'LIVE');
  assert.equal(report.marketData.fx.evidence.path[0].symbol, 'USDINR');
  assert.equal(report.marketData.fx.evidence.path[0].selectedSide, 'ASK');
  assert.deepEqual(report.blockers, []);
});

test('GLOBAL-MARKETS readiness becomes EXECUTION_READY only after explicit pilot activation', () => {
  const store = quoteStore();
  const report = buildGlobalMarketsReadiness({
    instrument: instrument({ executionEnabled: true, executionProvisionVersion: 1001 }),
    quoteStore: store,
    currencyConverter: converter(store),
    platformEventsHealth: { enabled: true, started: true, webhookConfigured: true, deadEvents: 0 },
    config: { marketProvider: 'multi', indiaMarketEnabled: true, accelpixConfigured: true },
    nowMs: NOW,
  });

  assert.equal(report.status, 'EXECUTION_READY');
  assert.equal(report.executionReady, true);
  assert.equal(report.instrument.executionProvisionVersion, 1001);
});

test('missing staging configuration is reported as blockers without exposing credentials', () => {
  const store = quoteStore();
  const report = buildGlobalMarketsReadiness({
    instrument: instrument(),
    quoteStore: store,
    currencyConverter: converter(store),
    platformEventsHealth: { enabled: true, started: true, webhookConfigured: true, deadEvents: 0 },
    config: { marketProvider: 'twelve-data', indiaMarketEnabled: false, accelpixConfigured: false },
    nowMs: NOW,
  });

  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.activationReady, false);
  assert.deepEqual(
    report.blockers.map(item => item.check),
    ['providerMulti', 'indiaMarketEnabled', 'accelpixConfigured'],
  );
  assert.equal(JSON.stringify(report).includes('apiKey'), false);
});

test('stale provider timestamps block underlying execution readiness even after a fresh local receipt', () => {
  const quote = liveQuote('RELIANCE', 2500, 2500.05, {
    receivedAtMs: NOW - 100,
    providerTimestampMs: NOW - 60_000,
  });
  const state = classifyQuote(quote, 12_000, NOW);

  assert.equal(state.status, 'STALE');
  assert.equal(state.ageMs, 100);
  assert.equal(state.sourceAgeMs, 60_000);
});

test('closed NSE session remains explicitly blocked for execution readiness', () => {
  const afterClose = Date.parse('2026-10-07T11:00:00.000Z'); // 16:30 Asia/Kolkata
  const store = quoteStore({
    RELIANCE: liveQuote('RELIANCE', 2500, 2500.05, {
      receivedAtMs: afterClose - 100,
      providerTimestampMs: afterClose - 120,
    }),
    USDINR: liveQuote('USDINR', 90, 91, {
      receivedAtMs: afterClose - 100,
      providerTimestampMs: afterClose - 120,
    }),
  });
  const report = buildGlobalMarketsReadiness({
    instrument: instrument(),
    quoteStore: store,
    currencyConverter: new CurrencyConversionEngine({
      quoteStore: store,
      symbols: ['USDINR'],
      maxQuoteAgeMs: 5000,
    }),
    platformEventsHealth: { enabled: true, started: true, webhookConfigured: true, deadEvents: 0 },
    config: { marketProvider: 'multi', indiaMarketEnabled: true, accelpixConfigured: true },
    nowMs: afterClose,
  });

  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.checks.sessionOpen.pass, false);
  assert.equal(report.blockers.some(item => item.check === 'sessionOpen'), true);
});
