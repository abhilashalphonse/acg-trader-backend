'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CurrencyConversionEngine } = require('../../src/modules/trading/currency-conversion-engine');

function store(quotes) {
  const map = new Map(Object.entries(quotes));
  return { get(symbol) { return map.get(symbol) || null; } };
}

const NOW = 1_000_000;

function quote(bid, ask, age = 100) {
  return { bid, ask, receivedAtMs: NOW - age, isStale: false };
}

test('currency conversion uses direct executable side for gains and losses', () => {
  const engine = new CurrencyConversionEngine({ quoteStore: store({ EURUSD: quote(1.1, 1.2) }), symbols: ['EURUSD'] });
  assert.equal(engine.convert('100', 'EUR', 'USD', { nowMs: NOW }), '110');
  assert.equal(engine.convert('-100', 'EUR', 'USD', { nowMs: NOW }), '-120');
});

test('currency conversion uses inverse ask for positive amounts and inverse bid for losses', () => {
  const engine = new CurrencyConversionEngine({ quoteStore: store({ EURUSD: quote(1.1, 1.2) }), symbols: ['EURUSD'] });
  assert.equal(engine.convert('120', 'USD', 'EUR', { nowMs: NOW }), '100');
  assert.equal(engine.convert('-110', 'USD', 'EUR', { nowMs: NOW }), '-100');
});

test('currency conversion can pivot through USD', () => {
  const engine = new CurrencyConversionEngine({
    quoteStore: store({ GBPUSD: quote(1.25, 1.26), EURUSD: quote(1.1, 1.2) }),
    symbols: ['GBPUSD', 'EURUSD'],
  });
  assert.equal(engine.convert('120', 'GBP', 'EUR', { nowMs: NOW }), '125');
});

test('currency conversion rejects stale or missing paths', () => {
  const engine = new CurrencyConversionEngine({ quoteStore: store({ EURUSD: quote(1.1, 1.2, 20_000) }), symbols: ['EURUSD'], maxQuoteAgeMs: 5000 });
  assert.throws(() => engine.convert('100', 'USD', 'EUR', { nowMs: NOW }), error => error.code === 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE');
});


test('loss-liability purpose uses the same executable side as an actual negative loss', () => {
  const engine = new CurrencyConversionEngine({
    quoteStore: store({ USDINR: quote(90, 91) }),
    symbols: ['USDINR'],
  });

  const estimate = engine.convert('900', 'INR', 'USD', {
    nowMs: NOW,
    purpose: 'LOSS_LIABILITY',
  });
  const realized = engine.convert('-900', 'INR', 'USD', { nowMs: NOW });

  assert.equal(estimate, '10');
  assert.equal(realized, '-10');
});

test('conversion evidence records purpose, path, side and timestamps', () => {
  const engine = new CurrencyConversionEngine({
    quoteStore: store({
      USDINR: {
        ...quote(90, 91),
        source: 'TEST',
        sourceTimestampMs: NOW - 120,
        sequence: 42,
      },
    }),
    symbols: ['USDINR'],
  });

  const result = engine.convertWithEvidence('900', 'INR', 'USD', {
    nowMs: NOW,
    purpose: 'LOSS_LIABILITY',
  });

  assert.equal(result.amount, '10');
  assert.equal(result.evidence.purpose, 'LOSS_LIABILITY');
  assert.equal(result.evidence.fromCurrency, 'INR');
  assert.equal(result.evidence.toCurrency, 'USD');
  assert.equal(result.evidence.path.length, 1);
  assert.equal(result.evidence.path[0].symbol, 'USDINR');
  assert.equal(result.evidence.path[0].direction, 'INVERSE');
  assert.equal(result.evidence.path[0].side, 'bid');
  assert.equal(result.evidence.path[0].rate, '90');
  assert.equal(result.evidence.path[0].source, 'TEST');
  assert.equal(result.evidence.path[0].sourceTimestampMs, NOW - 120);
  assert.equal(result.evidence.path[0].receivedAtMs, NOW - 100);
  assert.equal(result.evidence.path[0].sequence, 42);
});

test('conversion rejects crossed quotes and source timestamps older than the financial validity window', () => {
  const crossed = new CurrencyConversionEngine({
    quoteStore: store({ USDINR: quote(91, 90) }),
    symbols: ['USDINR'],
    maxQuoteAgeMs: 5000,
  });
  assert.throws(
    () => crossed.convert('900', 'INR', 'USD', { nowMs: NOW, purpose: 'LOSS_LIABILITY' }),
    error => error.code === 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
  );

  const oldSource = new CurrencyConversionEngine({
    quoteStore: store({
      USDINR: {
        ...quote(90, 91),
        sourceTimestampMs: NOW - 20_000,
      },
    }),
    symbols: ['USDINR'],
    maxQuoteAgeMs: 5000,
  });
  assert.throws(
    () => oldSource.convert('900', 'INR', 'USD', { nowMs: NOW, purpose: 'LOSS_LIABILITY' }),
    error => error.code === 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
  );
});
