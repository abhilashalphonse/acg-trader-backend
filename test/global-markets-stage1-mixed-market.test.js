'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { QuoteStore } = require('../src/modules/market-data/quote-store');
const { CurrencyConversionEngine } = require('../src/modules/trading/currency-conversion-engine');
const {
  calculatePositionValuation,
  aggregateAccountValuation,
} = require('../src/modules/trading/valuation-calculator');
const {
  INSTRUMENT_QUALITIES,
  FX_QUALITIES,
  EXECUTION_AVAILABILITY,
  isRiskValuationAcceptable,
} = require('../src/modules/trading/valuation-quality');
const {
  shouldTriggerStopOut,
  classifyStopOutPositions,
} = require('../src/modules/trading/margin-stop-out-engine');
const {
  assertManualCloseSessionOpen,
  normalizeCloseReason,
} = require('../src/modules/trading/market-order.service');

const CLOSED_NOW = Date.parse('2026-10-07T10:30:00.000Z'); // 16:00 Asia/Kolkata
const NSE_CLOSE_MARK = Date.parse('2026-10-07T09:59:58.000Z'); // 15:29:58 Asia/Kolkata

function relianceInstrument() {
  return {
    symbol: 'RELIANCE',
    status: 'ACTIVE',
    timezone: 'Asia/Kolkata',
    maxQuoteAgeMs: 5000,
    tradingSessions: [
      { days: [1, 2, 3, 4, 5], open: '09:15', close: '15:30' },
    ],
    minVolume: '0.001',
    volumeStep: '0.001',
  };
}

function eurusdInstrument() {
  return {
    symbol: 'EURUSD',
    status: 'ACTIVE',
    timezone: 'UTC',
    maxQuoteAgeMs: 5000,
    tradingSessions: [],
    minVolume: '0.01',
    volumeStep: '0.01',
  };
}

function reliancePosition() {
  return {
    _id: 'reliance-position',
    positionId: 'RELIANCE-P1',
    accountId: 'account-1',
    symbol: 'RELIANCE',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '10',
    entryPrice: '100',
    contractSize: '1',
    volumeStep: '0.001',
    quoteCurrency: 'INR',
    margin: '20',
    openedAt: new Date('2026-10-07T04:00:00.000Z'),
  };
}

function eurusdPosition() {
  return {
    _id: 'eurusd-position',
    positionId: 'EURUSD-P1',
    accountId: 'account-1',
    symbol: 'EURUSD',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '1',
    entryPrice: '1.1000',
    contractSize: '100000',
    volumeStep: '0.01',
    quoteCurrency: 'USD',
    margin: '1100',
    openedAt: new Date('2026-10-07T04:10:00.000Z'),
  };
}

function quotes() {
  const store = new QuoteStore();
  store.set({
    symbol: 'RELIANCE',
    bid: 110,
    ask: 110.1,
    providerTimestampMs: NSE_CLOSE_MARK,
    timeMs: NSE_CLOSE_MARK,
    receivedAtMs: NSE_CLOSE_MARK,
    source: 'ACCELPIX_TEST',
    sequence: 11,
    isStale: true,
  });
  store.set({
    symbol: 'EURUSD',
    bid: 1.04,
    ask: 1.0402,
    providerTimestampMs: CLOSED_NOW,
    timeMs: CLOSED_NOW,
    receivedAtMs: CLOSED_NOW,
    source: 'FX_TEST',
    sequence: 12,
    isStale: false,
  });
  store.set({
    symbol: 'USDINR',
    bid: 90,
    ask: 90.1,
    providerTimestampMs: CLOSED_NOW,
    timeMs: CLOSED_NOW,
    receivedAtMs: CLOSED_NOW,
    source: 'FX_TEST',
    sequence: 13,
    isStale: false,
  });
  return store;
}

test('GM-007 closed NSE mark is valuation-only while EURUSD remains executable', () => {
  const store = quotes();
  const reliance = calculatePositionValuation({
    position: reliancePosition(),
    quote: store.get('RELIANCE'),
    instrument: relianceInstrument(),
    nowMs: CLOSED_NOW,
  });
  const eurusd = calculatePositionValuation({
    position: eurusdPosition(),
    quote: store.get('EURUSD'),
    instrument: eurusdInstrument(),
    nowMs: CLOSED_NOW,
  });

  assert.equal(reliance.instrumentValuationQuality, INSTRUMENT_QUALITIES.APPROVED_CLOSE);
  assert.equal(reliance.executionAvailability, EXECUTION_AVAILABILITY.CLOSED_SESSION);
  assert.equal(reliance.valuationStatus, 'APPROVED_CLOSE');

  assert.equal(eurusd.instrumentValuationQuality, INSTRUMENT_QUALITIES.LIVE);
  assert.equal(eurusd.executionAvailability, EXECUTION_AVAILABILITY.OPEN_ALLOWED);
  assert.equal(eurusd.valuationStatus, 'LIVE');
});

test('GM-008 mixed-market account remains complete and eligible for USD risk evaluation', () => {
  const store = quotes();
  const converter = new CurrencyConversionEngine({
    quoteStore: store,
    symbols: ['USDINR'],
    maxQuoteAgeMs: 5000,
  });

  const values = [
    calculatePositionValuation({
      position: reliancePosition(),
      quote: store.get('RELIANCE'),
      instrument: relianceInstrument(),
      nowMs: CLOSED_NOW,
    }),
    calculatePositionValuation({
      position: eurusdPosition(),
      quote: store.get('EURUSD'),
      instrument: eurusdInstrument(),
      nowMs: CLOSED_NOW,
    }),
  ];

  const valuation = aggregateAccountValuation({
    account: {
      _id: 'account-1',
      currency: 'USD',
      state: { balance: '10000' },
    },
    positionValuations: values,
    currencyConverter: converter,
    nowMs: CLOSED_NOW,
  });

  assert.equal(valuation.complete, true);
  assert.equal(valuation.accountValuationCompleteness, 'COMPLETE');
  assert.equal(valuation.instrumentValuationQuality, INSTRUMENT_QUALITIES.APPROVED_CLOSE);
  assert.equal(valuation.fxValuationQuality, FX_QUALITIES.LIVE);
  assert.equal(valuation.accountValuationQuality, INSTRUMENT_QUALITIES.APPROVED_CLOSE);
  assert.equal(valuation.valuationStatus, 'APPROVED_CLOSE');
  assert.equal(isRiskValuationAcceptable(valuation), true);

  const stopOutValuation = {
    ...valuation,
    usedMargin: '1120',
    marginLevel: '40',
  };
  assert.equal(shouldTriggerStopOut(stopOutValuation), true);
});

test('GM-009 stop-out ranks executable EURUSD and defers closed RELIANCE', () => {
  const store = quotes();
  const converter = new CurrencyConversionEngine({
    quoteStore: store,
    symbols: ['USDINR'],
    maxQuoteAgeMs: 5000,
  });
  const instruments = new Map([
    ['RELIANCE', relianceInstrument()],
    ['EURUSD', eurusdInstrument()],
  ]);

  const result = classifyStopOutPositions({
    positions: [reliancePosition(), eurusdPosition()],
    account: { currency: 'USD' },
    quoteStore: store,
    currencyConverter: converter,
    instrumentBySymbol: instruments,
    nowMs: CLOSED_NOW,
  });

  assert.equal(result.ranked.length, 1);
  assert.equal(result.ranked[0].symbol, 'EURUSD');
  assert.equal(result.deferred.length, 1);
  assert.equal(result.deferred[0].position.symbol, 'RELIANCE');
  assert.equal(result.deferred[0].reason, EXECUTION_AVAILABILITY.CLOSED_SESSION);
});

test('GM-009 system liquidation and stop-out cannot execute against an approved close mark', () => {
  assert.equal(normalizeCloseReason('ACCOUNT_LIQUIDATION'), 'ACCOUNT_LIQUIDATION');

  assert.throws(
    () => assertManualCloseSessionOpen({
      instrument: relianceInstrument(),
      source: 'SYSTEM',
      reason: 'ACCOUNT_LIQUIDATION',
      nowMs: CLOSED_NOW,
    }),
    error => error?.code === 'MARKET_SESSION_CLOSED',
  );

  assert.throws(
    () => assertManualCloseSessionOpen({
      instrument: relianceInstrument(),
      source: 'SYSTEM',
      reason: 'MARGIN_STOP_OUT',
      nowMs: CLOSED_NOW,
    }),
    error => error?.code === 'MARKET_SESSION_CLOSED',
  );
});
